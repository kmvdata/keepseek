import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { createWebviewDomHarness } from './webviewDomHarness';

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

function titleView(language = 'en') {
  const view = createWebviewDomHarness();
  let revision = 0;
  const summaries = [{ id: 'a', title: 'A', customTitle: 'A' }, { id: 'b', title: 'B' }];
  const publish = (sessionId = 'a', patch: Record<string, unknown> = {}) => view.receive({
    type: 'state', revision: ++revision, state: {
      activeSessionId: sessionId, sessionSummaries: summaries,
      messages: [{ id: sessionId + '-answer', role: 'assistant', content: 'Visible answer', createdAt: '' }],
      language, isBusy: false, startup: { interactiveReady: true, sideEffectsReady: true }, ...patch
    }
  });
  publish();
  const requests = () => view.posted.filter(message => message.type === 'regenerateSessionTitle');
  const doubleClick = () => view.element('currentSessionTitle').dispatchEvent({ type: 'dblclick' });
  return { ...view, publish, requests, doubleClick };
}

test('double-clicking the current title requests one background regeneration without locking navigation or disturbing the composer', () => {
  const view = titleView();
  const prompt = view.element('promptInput');
  prompt.textContent = 'Unsent draft';
  prompt.focus();
  const title = view.element('currentSessionTitle');
  assert.equal(title.getAttribute('role'), 'button');
  assert.match(title.title, /Double-click to regenerate/u);
  title.click();
  assert.equal(view.requests().length, 0, 'a single click does not spend model usage');
  view.doubleClick();
  view.doubleClick();
  assert.equal(view.requests().length, 1);
  assert.equal(view.requests()[0].sessionId, 'a');
  assert.equal(typeof view.requests()[0].requestId, 'string');
  assert.equal(title.textContent, 'A', 'keep the original title while the request runs');
  assert.equal(title.getAttribute('aria-busy'), 'true');
  assert.equal(title.getAttribute('aria-disabled'), 'true');
  assert.equal(view.state.isBusy, false);
  assert.equal(view.element('newChatTab').disabled, false);
  assert.equal(view.element('historyTab').disabled, false);
  assert.equal(prompt.textContent, 'Unsent draft');
  assert.equal(view.document.activeElement, prompt);

  const requestId = view.requests()[0].requestId;
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'obsolete', running: false });
  view.doubleClick();
  assert.equal(view.requests().length, 1, 'a stale completion cannot unlock a newer request');
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId, regenerated: true, title: 'Approval diagnostics' });
  assert.equal(title.textContent, 'Approval diagnostics', 'an explicit regeneration can replace the previous manual name');
  assert.equal(view.state.sessionSummaries[0].customTitle, undefined);
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false });
  assert.equal(title.getAttribute('aria-busy'), 'false');
  assert.equal(title.getAttribute('aria-disabled'), 'false');
  view.doubleClick();
  assert.equal(view.requests().length, 2, 'ending or rejecting one request permits a later explicit retry');
});

test('title regeneration is disabled during startup, a main answer, or an active background run and supports the keyboard', () => {
  const view = titleView('zh-CN');
  assert.match(view.element('currentSessionTitle').title, /双击根据会话内容重建标题/u);
  for (const patch of [
    { startup: { interactiveReady: false } }, { isBusy: true },
    ...['running', 'waiting_for_apply', 'waiting_for_authorization'].map(status => ({ backgroundRun: { status } }))
  ]) {
    view.publish('a', { backgroundRun: undefined, ...patch });
    view.doubleClick();
    assert.equal(view.requests().length, 0);
    assert.equal(view.element('currentSessionTitle').getAttribute('aria-disabled'), 'true');
  }
  view.publish('a', { backgroundRun: undefined });
  view.element('currentSessionTitle').dispatchEvent({ type: 'keydown', key: 'Enter', repeat: true });
  assert.equal(view.requests().length, 0, 'holding Enter does not repeat model requests');
  view.element('currentSessionTitle').dispatchEvent({ type: 'keydown', key: ' ' });
  assert.equal(view.requests().length, 1);
});

test('late title regeneration events remain scoped to their session and cannot override a later locally submitted manual name', () => {
  const view = titleView();
  view.doubleClick();
  const requestId = view.requests()[0].requestId;
  view.publish('b');
  assert.equal(view.element('currentSessionTitle').getAttribute('aria-busy'), 'false');
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId, regenerated: true, title: 'Regenerated A' });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false });
  assert.equal(view.state.activeSessionId, 'b');
  assert.equal(view.element('currentSessionTitle').textContent, 'B');
  assert.equal(view.state.sessionSummaries[0].title, 'Regenerated A');

  view.publish('a');
  view.doubleClick();
  const staleId = view.requests()[1].requestId;
  // Use the actual production commit handler, sharing the complete script's
  // state, to reproduce an optimistic manual rename before Host delivery.
  const commit = new Function('state', 'vscode', 'renderSessionMenu', 'renderCurrentSessionTitle', 't', `
    var editingSessionTitleId = 'a';
    ${between('commitSessionTitle(input)', 'getSessionTimestamp(session)')}
    return commitSessionTitle;
  `)(view.state, { postMessage: () => {} }, () => {}, () => {}, () => 'New session');
  commit({ value: 'My manual name', dataset: { sessionId: 'a', originalTitle: 'Regenerated A' } });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: staleId, running: true });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: staleId, running: true, restored: true });
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId: staleId, regenerated: true, title: 'Old result' });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: staleId, running: false });
  assert.equal(view.state.sessionSummaries[0].title, 'My manual name');
  assert.equal(view.state.sessionSummaries[0].customTitle, 'My manual name');
  assert.equal(view.state.sessionTitleRegenerations.a, undefined);
});

test('a newly mounted webview restores the Host in-flight title request before session state and applies its result without disturbing input', () => {
  const view = createWebviewDomHarness();
  assert.equal(view.state.activeSessionId, '');
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'host-pending', running: true, restored: true });
  view.receive({ type: 'state', revision: 1, state: {
    activeSessionId: 'a', sessionSummaries: [{ id: 'a', title: 'Manual before reload', customTitle: 'Manual before reload' }],
    messages: [], language: 'en', isBusy: false, startup: { interactiveReady: true, sideEffectsReady: true }
  } });
  const title = view.element('currentSessionTitle');
  assert.equal(title.getAttribute('aria-busy'), 'true');
  assert.equal(title.textContent, 'Manual before reload');
  const prompt = view.element('promptInput');
  prompt.textContent = 'Draft after reload';
  prompt.focus();
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId: 'host-pending', regenerated: true, title: 'Restored title result' });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'host-pending', running: false });
  assert.equal(title.textContent, 'Restored title result');
  assert.equal(view.state.sessionSummaries[0].customTitle, undefined);
  assert.equal(title.getAttribute('aria-busy'), 'false');
  assert.equal(prompt.textContent, 'Draft after reload');
  assert.equal(view.document.activeElement, prompt);
});
