import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { getStyles } from '../src/webview/styles';
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
    const env = { state, currentSessionTitle: title, sessionMenu: menu, t: () => 'New session',
      historyCleanupDeletedSessionIds: new Set<string>(),
      getActiveVisibleSessions: () => state.sessionSummaries, getSessionMenuRenderKey: () => 'patched' };
    const api = new Function(...Object.keys(env), `
      var sessionMenuOpen = true;
      var sessionMenuRenderKey = '';
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
  const summaries = [{ id: 'a', title: 'A', customTitle: 'A' }, { id: 'b', title: 'B' }]
    .map(session => ({ ...session, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const publish = (sessionId = 'a', patch: Record<string, unknown> = {}) => view.receive({
    type: 'state', revision: ++revision, state: {
      activeSessionId: sessionId, sessionSummaries: summaries,
      messages: [{ id: sessionId + '-answer', role: 'assistant', content: 'Visible answer', createdAt: '' }],
      language, isBusy: false, startup: { interactiveReady: true, sideEffectsReady: true },
      titleRegenerationCapability: { available: true }, ...patch
    }
  });
  publish();
  const requests = () => view.posted.filter(message => message.type === 'regenerateSessionTitle');
  const openHistory = () => {
    if (view.element('sessionMenu').classList.contains('hidden')) view.element('historyTab').click();
  };
  const refreshButton = (sessionId = 'a') => {
    openHistory();
    const row = view.element('sessionMenu').querySelector(`[data-session-id="${sessionId}"]`);
    const button = row?.querySelector('button[data-session-action="regenerateTitle"]');
    assert.ok(button);
    return button;
  };
  const refresh = (sessionId = 'a') => {
    const button = refreshButton(sessionId);
    view.element('sessionMenu').dispatchEvent({ type: 'click', target: button });
  };
  return { ...view, publish, requests, openHistory, refreshButton, refresh };
}

test('history refresh is before edit and spins once without selecting a session or disturbing the composer', () => {
  const view = titleView();
  const prompt = view.element('promptInput');
  prompt.textContent = 'Unsent draft';
  prompt.focus();
  const title = view.element('currentSessionTitle');
  assert.equal(title.getAttribute('role'), null);
  assert.equal(title.getAttribute('tabindex'), null);
  assert.equal(title.title, 'A');
  title.dispatchEvent({ type: 'dblclick' });
  title.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(view.requests().length, 0, 'the former title shortcuts no longer spend model usage');
  const button = view.refreshButton();
  const row = button.closest('.session-menu-item')!;
  const rename = row.querySelector('button[data-session-action="startRename"]');
  assert.ok(rename);
  assert.ok(row.children.indexOf(button) < row.children.indexOf(rename), 'refresh is immediately left of edit');
  assert.equal(button.tagName, 'BUTTON');
  assert.match(button.title, /Regenerate session title/u);
  assert.equal(button.disabled, false);
  view.refresh();
  view.refresh();
  assert.equal(view.requests().length, 1);
  assert.equal(view.requests()[0].sessionId, 'a');
  assert.equal(typeof view.requests()[0].requestId, 'string');
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('is-regenerating'), true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  const styles = getStyles();
  assert.match(styles, /\.session-menu-item:hover \.session-menu-refresh/u);
  assert.match(styles, /\.session-menu-refresh\.is-regenerating\s*\{\s*opacity:\s*1/u,
    'the in-flight control stays visible after hover ends');
  assert.match(styles, /\.session-menu-refresh\.is-regenerating svg\s*\{\s*animation:\s*session-title-refresh-spin [^;]*infinite/u);
  assert.match(styles, /@keyframes session-title-refresh-spin\s*\{ to \{ transform: rotate\(360deg\)/u);
  assert.equal(view.element('sessionMenu').classList.contains('hidden'), false);
  assert.equal(view.posted.some(message => message.type === 'selectSession'), false);
  assert.equal(view.state.isBusy, false);
  assert.equal(view.element('newChatTab').disabled, false);
  assert.equal(view.element('historyTab').disabled, false);
  assert.equal(prompt.textContent, 'Unsent draft');
  assert.equal(view.document.activeElement, prompt);

  const requestId = view.requests()[0].requestId;
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'obsolete', running: false });
  assert.equal(view.refreshButton(), button, 'status patches update the original control in place');
  view.refresh();
  assert.equal(view.requests().length, 1, 'a stale completion cannot unlock a newer request');
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId, regenerated: true, title: 'Approval diagnostics' });
  assert.equal(title.textContent, 'Approval diagnostics');
  assert.equal(view.state.sessionSummaries[0].customTitle, undefined);
  assert.equal(button.classList.contains('is-regenerating'), true, 'keep spinning through the title commit notification');
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false });
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-regenerating'), false);
  assert.equal(button.getAttribute('aria-busy'), 'false');
  view.refresh();
  assert.equal(view.requests().length, 2, 'a later explicit refresh can run again');
});

test('history refresh consumes Host conflict capability and preserves its pending spinner across menu and state refreshes', () => {
  const view = titleView('zh-CN');
  assert.match(view.refreshButton().title, /重新生成会话标题/u);
  for (const patch of [
    { startup: { interactiveReady: false }, titleRegenerationCapability: { available: false, reason: 'loading_sessions' } },
    { isBusy: true, titleRegenerationCapability: { available: false, reason: 'busy' } },
    ...['running', 'waiting_for_apply', 'waiting_for_authorization'].map(status => ({
      backgroundRun: { status }, titleRegenerationCapability: { available: false, reason: 'busy' }
    }))
  ]) {
    view.publish('a', { backgroundRun: undefined, ...patch });
    assert.equal(view.refreshButton().disabled, true);
    view.refresh();
    assert.equal(view.requests().length, 0);
  }
  view.publish('a', { backgroundRun: undefined });
  view.refresh('b');
  const requestId = view.requests()[0].requestId;
  assert.equal(view.requests()[0].sessionId, 'b', 'an inactive row refreshes its own conversation');
  assert.equal(view.state.activeSessionId, 'a');
  view.element('historyTab').click();
  assert.equal(view.element('sessionMenu').classList.contains('hidden'), true);
  view.openHistory();
  assert.equal(view.refreshButton('b').classList.contains('is-regenerating'), true);
  assert.equal(view.refreshButton('b').disabled, true);
  view.publish('a');
  assert.equal(view.refreshButton('b').classList.contains('is-regenerating'), true);
  view.refresh('b');
  assert.equal(view.requests().length, 1);
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'b', requestId, running: false });
  assert.equal(view.refreshButton('b').classList.contains('is-regenerating'), false);
  assert.equal(view.refreshButton('b').disabled, false);
  assert.equal(view.state.sessionSummaries[1].title, 'B', 'failure or defer leaves the title intact');
  view.refresh('b');
  assert.equal(view.requests().length, 2);
});

test('late title regeneration events remain scoped to their session and cannot override a later locally submitted manual name', () => {
  const view = titleView();
  view.refresh();
  const requestId = view.requests()[0].requestId;
  view.publish('b');
  assert.equal(view.refreshButton('a').getAttribute('aria-busy'), 'true');
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId, regenerated: true, title: 'Regenerated A' });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false });
  assert.equal(view.state.activeSessionId, 'b');
  assert.equal(view.element('currentSessionTitle').textContent, 'B');
  assert.equal(view.state.sessionSummaries[0].title, 'Regenerated A');

  view.publish('a');
  view.refresh();
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

test('other-workspace history does not expose a title refresh control', () => {
  const view = titleView();
  view.openHistory();
  view.receive({ type: 'otherWorkspaces', workspaces: [{ workspaceKey: 'other', workspaceName: 'Other project' }] });
  const menu = view.element('sessionMenu');
  const select = menu.querySelector('select[data-session-workspace="true"]')!;
  select.value = 'other';
  menu.dispatchEvent({ type: 'change', target: select });
  view.receive({ type: 'otherWorkspaceSessions', workspaceKey: 'other', sessions: [
    { id: 'a', title: 'Other project session', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  ] });
  assert.ok(menu.querySelector('.session-menu-item.is-other-workspace'));
  assert.equal(menu.querySelector('button[data-session-action="regenerateTitle"]'), null);
  assert.equal(view.requests().length, 0);
  assert.equal(view.state.activeSessionId, 'a');
});

test('a newly mounted webview restores the Host in-flight title request before session state and applies its result without disturbing input', () => {
  const view = createWebviewDomHarness();
  assert.equal(view.state.activeSessionId, '');
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'host-pending', running: true, restored: true });
  view.receive({ type: 'state', revision: 1, state: {
    activeSessionId: 'a', sessionSummaries: [{ id: 'a', title: 'Manual before reload', customTitle: 'Manual before reload',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }],
    messages: [], language: 'en', isBusy: false, startup: { interactiveReady: true, sideEffectsReady: true },
    titleRegenerationCapability: { available: true }
  } });
  const title = view.element('currentSessionTitle');
  assert.equal(title.textContent, 'Manual before reload');
  view.element('historyTab').click();
  const button = view.element('sessionMenu').querySelector('button[data-session-action="regenerateTitle"]')!;
  assert.equal(button.disabled, true);
  assert.equal(button.classList.contains('is-regenerating'), true);
  const prompt = view.element('promptInput');
  prompt.textContent = 'Draft after reload';
  prompt.focus();
  view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId: 'host-pending', regenerated: true, title: 'Restored title result' });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'host-pending', running: false });
  assert.equal(title.textContent, 'Restored title result');
  assert.equal(view.state.sessionSummaries[0].customTitle, undefined);
  assert.equal(button.disabled, false);
  assert.equal(button.classList.contains('is-regenerating'), false);
  assert.equal(prompt.textContent, 'Draft after reload');
  assert.equal(view.document.activeElement, prompt);
});

test('startupSettings alone updates history title capability in place without losing a draft or scroll', () => {
  const view = titleView();
  view.publish('a', {
    startup: { interactiveReady: false },
    titleRegenerationCapability: { available: false, reason: 'loading_sessions' }
  });
  const button = view.refreshButton();
  assert.equal(button.disabled, true);
  const prompt = view.element('promptInput');
  prompt.textContent = 'Keep this draft';
  prompt.focus();
  const menu = view.element('sessionMenu');
  menu.scrollTop = 87;
  view.receive({ type: 'statePatch', scope: 'startupSettings', revision: 100, state: {
    startup: { interactiveReady: true },
    interaction: { sessionId: 'a', phase: 'idle', canSubmit: true },
    titleRegenerationCapability: { available: true }
  } });
  assert.equal(button.disabled, false, 'ready patch must update an already open history control');
  assert.equal(view.refreshButton(), button, 'capability-only updates must not rebuild history rows');
  assert.equal(menu.scrollTop, 87);
  assert.equal(prompt.textContent, 'Keep this draft');
  assert.equal(view.document.activeElement, prompt);
  view.refresh();
  assert.equal(view.requests().length, 1);
});

test('title refresh capability is independent of the current composer context and explains Host restrictions', () => {
  const view = titleView();
  view.publish('a', {
    startup: { interactiveReady: false },
    interaction: { sessionId: 'a', phase: 'preparing_context', waitingReason: 'context',
      canEditDraft: true, canSubmit: false, canNavigate: true },
    titleRegenerationCapability: { available: true }
  });
  const button = view.refreshButton('b');
  assert.equal(button.disabled, false, 'current Skills readiness is not the historical title capability');
  const svg = button.querySelector('svg')!;
  view.element('sessionMenu').dispatchEvent({ type: 'click', target: svg });
  assert.equal(view.requests().length, 1, 'clicking the SVG resolves the native refresh button');
  const requestId = view.requests()[0].requestId;
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'b', requestId, running: false,
    outcome: 'unavailable', reason: 'Select an available title model.' });
  const feedback = button.closest('.session-menu-item')!.querySelector('.session-menu-title-result')!;
  assert.equal(feedback.textContent, 'Select an available title model.');
  assert.equal(feedback.getAttribute('role'), 'status');
  assert.equal(feedback.getAttribute('aria-live'), 'polite');
  view.receive({ type: 'statePatch', scope: 'startupSettings', revision: 100, state: {
    titleRegenerationCapability: { available: false, reason: 'model_unavailable' }
  } });
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.match(button.title, /model/i);
  assert.match(button.getAttribute('aria-label')!, /model/i);
  assert.equal(feedback.textContent, 'Select an available title model.', 'capability changes retain the explicit request result');
  assert.equal(view.state.activeSessionId, 'a');
});

test('explicit title outcomes are visible, request scoped and retryable without accepting late results', () => {
  for (const outcome of ['updated', 'unchanged', 'no_material', 'unavailable', 'busy', 'rejected',
    'cancelled', 'stale', 'invalid', 'timeout', 'failed', 'save_failed']) {
    const view = titleView();
    const button = view.refreshButton();
    // Native buttons produce this click for Enter/Space activation; the DOM
    // harness intentionally does not emulate the browser's default key action.
    view.element('sessionMenu').dispatchEvent({ type: 'click', target: button, detail: 0 });
    const requestId = view.requests()[0].requestId;
    const feedback = button.closest('.session-menu-item')!.querySelector('.session-menu-title-result')!;
    assert.match(feedback.textContent, /Regenerating/u);
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: true, accepted: true });
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId: 'other', running: false,
      outcome: 'failed', reason: 'wrong result' });
    assert.equal(button.classList.contains('is-regenerating'), true);
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false,
      outcome, reason: outcome + ' <safe text>' });
    assert.equal(button.classList.contains('is-regenerating'), false);
    assert.equal(button.disabled, false);
    assert.equal(feedback.textContent, outcome + ' <safe text>');
    assert.equal(feedback.classList.contains('hidden'), false);
    assert.equal(view.state.sessionSummaries[0].title, 'A', 'a result never substitutes for the durable title event');
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: true, restored: true });
    assert.equal(button.classList.contains('is-regenerating'), false, 'completed requests cannot be resurrected');
    view.refresh();
    assert.equal(view.requests().length, 2);
    assert.match(feedback.textContent, /Regenerating/u);
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId, running: false,
      outcome: 'failed', reason: 'late result' });
    assert.equal(button.classList.contains('is-regenerating'), true, 'old completion cannot finish a new request');
    assert.notEqual(feedback.textContent, 'late result');
  }
});

test('capability updates preserve an open manual title editor through patches and unchanged full state', () => {
  const view = titleView();
  view.openHistory();
  const menu = view.element('sessionMenu');
  const rename = menu.querySelector('[data-session-id="b"] button[data-session-action="startRename"]')!;
  menu.dispatchEvent({ type: 'click', target: rename });
  const editor = menu.querySelector('input[data-session-title="true"]')!;
  assert.ok(editor);
  editor.value = 'My unfinished title';
  editor.selectionStart = 4;
  editor.selectionEnd = 7;
  editor.focus();
  const button = view.refreshButton('a');
  menu.scrollTop = 61;
  view.publish('a', { titleRegenerationCapability: { available: false, reason: 'saving' } });
  assert.equal(menu.querySelector('input[data-session-title="true"]'), editor);
  assert.equal(view.refreshButton('a'), button);
  assert.equal(editor.value, 'My unfinished title');
  assert.equal(editor.selectionStart, 4);
  assert.equal(editor.selectionEnd, 7);
  assert.equal(view.document.activeElement, editor);
  assert.equal(menu.scrollTop, 61);
  assert.equal(button.disabled, true);
  view.receive({ type: 'statePatch', scope: 'startupSettings', revision: 100, state: {
    titleRegenerationCapability: { available: true }
  } });
  assert.equal(button.disabled, false);
  assert.equal(menu.querySelector('input[data-session-title="true"]'), editor);
  assert.equal(view.document.activeElement, editor);
});

test('a title commit followed by the same Host snapshot preserves open title editors in any row', () => {
  for (const editingId of ['a', 'b']) {
    const view = titleView();
    view.refresh('a');
    const requestId = view.requests()[0].requestId;
    const menu = view.element('sessionMenu');
    const rename = menu.querySelector('[data-session-id="' + editingId + '"] button[data-session-action="startRename"]')!;
    menu.dispatchEvent({ type: 'click', target: rename });
    const editor = menu.querySelector('input[data-session-title="true"]')!;
    editor.value = 'Keep my unfinished title';
    editor.selectionStart = 3;
    editor.selectionEnd = 9;
    editor.focus();
    menu.scrollTop = 73;
    view.receive({ type: 'sessionTitleUpdated', sessionId: 'a', requestId,
      regenerated: true, title: 'A refreshed title' });
    view.receive({ type: 'sessionTitleRegeneration', sessionId: 'a', requestId,
      running: false, outcome: 'updated', reason: 'Title updated.' });
    view.publish('a');
    assert.equal(view.state.sessionSummaries[0].title, 'A refreshed title');
    assert.equal(menu.querySelector('input[data-session-title="true"]'), editor,
      'the matching full snapshot must not rebuild an editor after a local title patch');
    assert.equal(editor.value, 'Keep my unfinished title');
    assert.equal(editor.selectionStart, 3);
    assert.equal(editor.selectionEnd, 9);
    assert.equal(view.document.activeElement, editor);
    assert.equal(menu.scrollTop, 73);
    assert.equal(view.posted.some(message => message.type === 'renameSession'), false,
      'a background title commit cannot submit the unfinished manual name');
  }
});

test('the displayed wait follows the Host reason rather than calling model or recovery waits Skills loading', () => {
  const view = titleView();
  for (const [waitingReason, expected] of [
    ['model', /model/i], ['session', /conversation/i], ['recovery', /restor/i], ['context', /Skills/u], ['saving', /sav/i]
  ] as const) {
    view.publish('a', { interaction: { sessionId: 'a', phase: 'preparing_context', waitingReason,
      canEditDraft: true, canSubmit: false, canNavigate: true } });
    const text = view.element('statusText').textContent;
    assert.match(text, expected);
    if (waitingReason !== 'context') assert.doesNotMatch(text, /Skills/u);
  }
});
