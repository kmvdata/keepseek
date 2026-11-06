import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';

const script = getScript();
const between = (start: string, end: string) => {
  const from = script.indexOf(`    function ${start}`);
  const to = script.indexOf(`    function ${end}`, from);
  assert.ok(from >= 0 && to > from);
  return script.slice(from, to);
};

test('background title events patch known session labels without rerendering editors or switching sessions', () => {
  for (const editingId of ['', 'a']) {
    const state = {
      activeSessionId: 'b', isBusy: false, messages: [{ id: 'message', content: 'unchanged' }],
      sessionSummaries: [{ id: 'a', title: 'temporary' }, { id: 'b', title: 'B' }]
    };
    const label = { textContent: 'temporary', title: 'temporary' };
    const input = { value: 'my unsaved name', selectionStart: 3 };
    const title = { textContent: 'B', title: 'B' };
    const rows = [{ dataset: { sessionId: 'a', sessionOrigin: 'current' }, querySelector: () => label }];
    const menu = { querySelectorAll: () => rows };
    const originalMessages = state.messages;
    const env = { state, currentSessionTitle: title, sessionMenu: menu, t: () => 'New session' };
    const api = new Function(...Object.keys(env), `
      var sessionMenuOpen = true;
      var editingSessionTitleId = ${JSON.stringify(editingId)};
      ${between('renderCurrentSessionTitle()', 'applyStaticTranslations()')}
      ${between('handleKeepseekHostMessage(event)', 'applyAgentRunStreamPatch(message)')}
      return handleKeepseekHostMessage;
    `)(...Object.values(env)) as (event: { data: unknown }) => void;
    api({ data: { type: 'sessionTitleUpdated', sessionId: 'a', title: '<b>Title</b>' } });
    assert.equal(state.sessionSummaries[0].title, '<b>Title</b>');
    assert.equal(state.activeSessionId, 'b');
    assert.equal(title.textContent, 'B');
    assert.equal(state.messages, originalMessages);
    assert.equal(state.isBusy, false);
    assert.deepEqual(input, { value: 'my unsaved name', selectionStart: 3 });
    assert.equal(label.textContent, editingId ? 'temporary' : '<b>Title</b>', 'labels are text, and an active editor is left intact');
    api({ data: { type: 'sessionTitleUpdated', sessionId: 'missing', title: 'never recreated' } });
    assert.equal(state.sessionSummaries.length, 2);
    api({ data: { type: 'sessionTitleUpdated', sessionId: 'b', title: 'Active title' } });
    assert.equal(title.textContent, 'Active title');
  }
});

test('background title events preserve locally committed manual titles', () => {
  const state = { activeSessionId: 'a', sessionSummaries: [{ id: 'a', title: 'Manual', customTitle: 'Manual' }] };
  const currentSessionTitle = { textContent: 'Manual', title: 'Manual' };
  const apply = new Function('state', 'currentSessionTitle', 't', `
    var sessionMenu = null, sessionMenuOpen = false, editingSessionTitleId = '';
    ${between('renderCurrentSessionTitle()', 'applyStaticTranslations()')}
    return applySessionTitleUpdate;
  `)(state, currentSessionTitle, () => 'New session');
  apply({ sessionId: 'a', title: 'Old automatic result' });
  assert.equal(state.sessionSummaries[0].title, 'Manual');
  assert.equal(currentSessionTitle.textContent, 'Manual');
});

test('submitting the same manual title still locks it, while Escape cancels editing', () => {
  for (const cancelled of [false, true]) {
    const messages: unknown[] = [];
    const state = { sessionSummaries: [{ id: 'a', title: 'same name', customTitle: undefined }] };
    const commit = new Function('state', 'vscode', 'renderSessionMenu', 'renderCurrentSessionTitle', 't', `
      var editingSessionTitleId = 'a';
      ${between('commitSessionTitle(input)', 'getSessionTimestamp(session)')}
      return commitSessionTitle;
    `)(state, { postMessage: (message: unknown) => messages.push(message) }, () => undefined, () => undefined, () => 'New session');
    commit({ value: 'same name', dataset: { sessionId: 'a', originalTitle: 'same name', ...(cancelled ? { cancelTitleEdit: 'true' } : {}) } });
    assert.equal(messages.length, cancelled ? 0 : 1);
    assert.equal(state.sessionSummaries[0].customTitle, cancelled ? undefined : 'same name');
  }
});

test('title usage events refresh active-session totals without changing reply metrics, timing or focus', () => {
  const lastTurnUsage = { totalTokens: 37, cost: 0.2 };
  const lastTurn = { total: lastTurnUsage };
  const executionTime = { currentMs: 9000, totalMs: 20000 };
  const promptCacheDiagnostics = { requestId: 'main', rate: 0.8 };
  const metrics = {
    sessionUsageStats: { totalTokens: 100 },
    usageDetails: { session: { totalTokens: 100 }, lastTurn, sessionTitle: undefined, subagents: undefined },
    lastTurnUsage, executionTime, promptCacheDiagnostics,
    contextPercent: 12, referenceCostSourceIds: []
  };
  const state = { activeSessionId: 'a', isBusy: false, messages: [{ id: 'answer' }], usageMetrics: metrics };
  const input = { value: 'unsent message', selectionStart: 4 };
  const document = { activeElement: input };
  let usageRenders = 0;
  const window = { keepseekInputControls: { renderUsage: () => { usageRenders++; } } };
  const handle = new Function('state', 'window', 'document', `
    ${between('applySessionTitleUsageUpdate(message)', 'applyStaticTranslations()')}
    ${between('handleKeepseekHostMessage(event)', 'applyAgentRunStreamPatch(message)')}
    return handleKeepseekHostMessage;
  `)(state, window, document) as (event: { data: unknown }) => void;
  const nextTotals = { totalTokens: 120 };
  const nextSession = { total: nextTotals };
  const titleUsage = { totalTokens: 20 };
  const nextSubagents = { totalCount: 0 };
  const data = {
    type: 'sessionTitleUsageUpdated', sessionId: 'a', sessionUsageStats: nextTotals,
    usageDetails: { session: nextSession, sessionTitle: titleUsage, subagents: nextSubagents,
      lastTurn: { totalTokens: 999 }, executionTime: { currentMs: 999 }, promptCacheDiagnostics: { requestId: 'title' } },
    referenceCostSourceIds: ['title-account']
  };
  handle({ data: { ...data, sessionId: 'b' } });
  assert.equal(metrics.sessionUsageStats.totalTokens, 100);
  assert.equal(usageRenders, 0, 'late accounting for another session cannot change this view');
  handle({ data });
  assert.equal(metrics.sessionUsageStats, nextTotals);
  assert.equal(metrics.usageDetails.session, nextSession);
  assert.equal(metrics.usageDetails.sessionTitle, titleUsage);
  assert.equal(metrics.usageDetails.subagents, nextSubagents);
  assert.equal(metrics.usageDetails.lastTurn, lastTurn);
  assert.equal(metrics.lastTurnUsage, lastTurnUsage);
  assert.equal(metrics.executionTime, executionTime);
  assert.equal(metrics.promptCacheDiagnostics, promptCacheDiagnostics);
  assert.equal(metrics.contextPercent, 12);
  assert.deepEqual(metrics.referenceCostSourceIds, ['title-account']);
  assert.equal(state.activeSessionId, 'a');
  assert.equal(state.isBusy, false);
  assert.deepEqual(state.messages, [{ id: 'answer' }]);
  assert.equal(document.activeElement, input);
  assert.deepEqual(input, { value: 'unsent message', selectionStart: 4 });
  assert.equal(usageRenders, 1);
});
