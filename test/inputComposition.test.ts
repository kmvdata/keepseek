import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  composeWebviewFragments,
  INPUT_SCRIPT_FRAGMENTS,
  INPUT_STYLE_FRAGMENTS,
  INPUT_TEMPLATE_FRAGMENTS,
  type WebviewFragment
} from '../src/webview/input/composition';
import { getInputScript } from '../src/webview/input/script';
import { getInputStyles } from '../src/webview/input/styles';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { deriveInteractionState } from '../src/provider/interactionState';
import { createWebviewDomHarness } from './webviewDomHarness';

test('operation status disappears in the same idle update, without a notification timeout', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: {
    activeSessionId: 'A', startup: { interactiveReady: true }, isBusy: true,
    agentActivity: { base: 'idle', phase: 'idle' }
  } });
  assert.ok(view.element('statusText').textContent);
  view.receive({ type: 'state', revision: 2, state: { isBusy: false } });
  assert.equal(view.element('statusText').textContent, '');
});

function interaction(sessionId: string, revision: number, phase = 'idle') {
  return { sessionId, revision, operationId: phase === 'idle' ? undefined : 'operation-' + revision,
    phase, canEdit: true, canSubmit: phase === 'idle', canChangeContext: phase === 'idle', canNavigate: phase === 'idle',
    canCancel: phase === 'running', cancelOperationId: phase === 'running' ? 'operation-' + revision : undefined };
}

function readyView(language = 'en') {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'A', language,
    startup: { interactiveReady: true, sideEffectsReady: true }, interaction: interaction('A', 1) } });
  return view;
}

test('explicit history metadata loading has its own terminal state and ignores a previous menu request', () => {
  const view = readyView();
  view.element('historyTab').click();
  const first = view.posted.filter(message => message.type === 'loadSessionHistory').at(-1)!;
  assert.ok(first.requestId);
  assert.match(view.element('sessionMenu').textContent, /Loading/u);
  view.receive({ type: 'sessionHistoryResult', requestId: first.requestId, status: 'failed', reason: 'Fixture history unavailable' });
  assert.match(view.element('sessionMenu').textContent, /Fixture history unavailable/u);
  assert.equal(view.element('sendButton').disabled, true, 'empty composer has no submission while metadata fails');
  view.element('historyTab').click(); view.element('historyTab').click();
  const next = view.posted.filter(message => message.type === 'loadSessionHistory').at(-1)!;
  assert.notEqual(next.requestId, first.requestId);
  view.receive({ type: 'sessionHistoryResult', requestId: first.requestId, status: 'failed', reason: 'Old failure' });
  assert.doesNotMatch(view.element('sessionMenu').textContent, /Old failure/u);
  view.receive({ type: 'sessionHistoryResult', requestId: next.requestId, status: 'ready' });
  assert.doesNotMatch(view.element('sessionMenu').textContent, /Loading/u);
  view.element('promptInput').textContent = 'New draft independent of history';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  assert.equal(view.element('sendButton').disabled, false);
});

test('new session remains reachable while history loads and immediately accepts input when committed', () => {
  const view = createWebviewDomHarness();
  const loadingFacts = { sessionId: '', revision: 1, sessionReady: false,
    requestContextReady: false, approvalDataReady: false, modelReady: false,
    contextReady: false, sessionRecoveryReady: false };
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: '',
    startup: { interactiveReady: false, sideEffectsReady: false },
    interaction: deriveInteractionState(loadingFacts) } });
  assert.equal(view.element('newChatTab').disabled, false);
  assert.equal(view.element('historyTab').disabled, true);
  assert.equal(view.element('sendButton').disabled, true);
  view.element('newChatTab').click();
  assert.equal(view.posted.filter(message => message.type === 'newSession').length, 1);
  assert.equal(view.posted.some(message => message.type === 'selectSession' || message.type === 'sendPrompt'), false);

  view.receive({ type: 'state', revision: 2, state: { activeSessionId: 'fresh',
    interaction: deriveInteractionState({ ...loadingFacts, sessionId: 'fresh', revision: 2, freshSession: true }) } });
  assert.equal(view.element('statusText').textContent, '');
  assert.equal(view.element('referenceMenuButton').disabled, false);
  assert.equal(view.element('historyTab').disabled, true);
  assert.equal(view.state.startup?.sideEffectsReady, false);
  view.element('promptInput').textContent = 'first fresh request';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  assert.equal(view.element('sendButton').disabled, false);
  view.element('composer').dispatchEvent({ type: 'submit' });
  const submitted = view.posted.filter(message => message.type === 'sendPrompt');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].sessionId, 'fresh');
  assert.equal(view.element('newChatTab').disabled, true, 'pending durable acceptance still owns the input target');
  view.element('newChatTab').click();
  assert.equal(view.posted.filter(message => message.type === 'newSession').length, 1);
});

test('new session stays disabled during execution but observer can create a local blank target', () => {
  const view = readyView();
  view.receive({ type: 'state', revision: 2, state: { isBusy: true,
    interaction: deriveInteractionState({ sessionId: 'A', revision: 2, sessionReady: true,
      requestContextReady: true, approvalDataReady: true, mainRunning: true }) } });
  assert.equal(view.element('newChatTab').disabled, true);
  view.element('newChatTab').click();
  assert.equal(view.posted.some(message => message.type === 'newSession'), false);
  view.receive({ type: 'state', revision: 3, state: { isBusy: false,
    interaction: deriveInteractionState({ sessionId: 'A', revision: 3, sessionReady: true,
      requestContextReady: true, approvalDataReady: true, readOnly: true }) } });
  assert.equal(view.element('newChatTab').disabled, false);
  assert.equal(view.element('historyTab').disabled, false);
});

test('a draft typed during startup survives the first authoritative session identity', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: '', interaction: interaction('', 1, 'loading_session') } });
  view.element('promptInput').textContent = 'Draft typed before sessions finish loading';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  view.receive({ type: 'state', revision: 2, state: { activeSessionId: 'A', startup: { interactiveReady: true }, interaction: interaction('A', 2) } });
  assert.equal(view.element('promptInput').textContent, 'Draft typed before sessions finish loading');
  view.receive({ type: 'state', revision: 3, state: { activeSessionId: 'B', interaction: interaction('B', 3) } });
  assert.equal(view.element('promptInput').textContent, '');
  view.receive({ type: 'state', revision: 4, state: { activeSessionId: 'A', interaction: interaction('A', 4) } });
  assert.equal(view.element('promptInput').textContent, 'Draft typed before sessions finish loading');
});

test('ordinary Webview reconstruction restores only the matching activation and session draft, including reference markup and IME text', () => {
  const preferences = { projectTaskSidebar: { P: { open: true } }, projectTaskDrafts: [['task', { text: 'Task draft' }]] };
  const view = createWebviewDomHarness(preferences, { serializeMarkup: true });
  view.receive({ type: 'state', revision: 1, state: { activationId: 'host-one', activeSessionId: 'A', interaction: interaction('A', 1) } });
  view.element('promptInput').innerHTML = '<a class="rich-file-link" contenteditable="false" href="keepseek-file:/tmp/keepseek-draft.ts#L3-L5" data-path="/tmp/keepseek-draft.ts" data-kind="file" data-start-line="3" data-end-line="5">draft.ts</a> 中文候选🙂e\u0301';
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' });
  view.element('promptInput').dispatchEvent({ type: 'input', isComposing: true });
  const markup = view.element('promptInput').innerHTML;
  view.element('promptInput').dispatchEvent({ type: 'compositionend' });
  const saved = view.savedWebviewState() as Record<string, unknown>;
  assert.deepEqual(saved.projectTaskSidebar, preferences.projectTaskSidebar);
  assert.deepEqual(saved.projectTaskDrafts, preferences.projectTaskDrafts);
  const rebuilt = createWebviewDomHarness(saved, { serializeMarkup: true });
  assert.equal(rebuilt.element('promptInput').textContent, '', 'no draft hydrates before the Host supplies its activation');
  rebuilt.receive({ type: 'state', revision: 2, state: { activationId: 'host-one', activeSessionId: 'A', interaction: interaction('A', 2) } });
  assert.equal(rebuilt.element('promptInput').innerHTML, markup);
  assert.equal(rebuilt.element('promptInput').querySelector('a.rich-file-link')?.dataset.path, '/tmp/keepseek-draft.ts');
  assert.match(rebuilt.element('promptInput').textContent, /中文候选🙂e\u0301/u);
  rebuilt.receive({ type: 'state', revision: 3, state: { activationId: 'host-one', activeSessionId: 'A', interaction: interaction('A', 3) } });
  assert.equal(rebuilt.element('promptInput').innerHTML, markup, 'repeated ready cannot clear the current editor');
  assert.equal(rebuilt.posted.some(message => message.type === 'sendPrompt'), false);

  const restarted = createWebviewDomHarness(rebuilt.savedWebviewState(), { serializeMarkup: true });
  restarted.receive({ type: 'state', revision: 1, state: { activationId: 'host-two', activeSessionId: 'B', interaction: interaction('B', 1) } });
  assert.equal(restarted.element('promptInput').textContent, '');
  restarted.receive({ type: 'state', revision: 2, state: { activationId: 'host-two', activeSessionId: 'A', interaction: interaction('A', 2),
    historyPreview: { sessionId: 'A', generation: 1, loading: false, canContinue: true } } });
  assert.equal(restarted.element('promptInput').innerHTML, markup, 'only explicitly choosing that history target may restore an older activation draft');
});

test('ordinary reconstruction preserves a newer pre-Host draft, clears accepted text durably, and does not hydrate a task composer', () => {
  const saved = { ordinarySessionDrafts: { version: 1, entries: [{ activationId: 'host', sessionId: 'A', markup: 'Older local draft' }] } };
  const view = createWebviewDomHarness(saved);
  view.element('promptInput').textContent = 'Newer pre-Host 中文草稿';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  view.receive({ type: 'state', revision: 1, state: { activationId: 'host', activeSessionId: 'A', interaction: interaction('A', 1) } });
  assert.equal(view.element('promptInput').textContent, 'Newer pre-Host 中文草稿');
  view.element('composer').dispatchEvent({ type: 'submit' });
  const sent = view.posted.find(message => message.type === 'sendPrompt')!;
  view.receive({ type: 'submissionResult', requestId: sent.requestId, sessionId: 'A', status: 'accepted' });
  const rebuilt = createWebviewDomHarness(view.savedWebviewState());
  rebuilt.receive({ type: 'state', revision: 2, state: { activationId: 'host', activeSessionId: 'A', interaction: interaction('A', 2) } });
  assert.equal(rebuilt.element('promptInput').textContent, '', 'an accepted input must not reappear as an unsent draft');
  const task = createWebviewDomHarness(saved);
  task.receive({ type: 'projectTasksState', projectId: 'P', hostId: 'root', revision: 1, viewGeneration: 1, viewMode: 'task', viewTaskId: 'T',
    cards: [{ id: 'T', sessionId: 'A', rootTaskId: 'R', title: 'Task', status: 'idle' }], readOnly: true });
  task.receive({ type: 'state', revision: 2, state: { activationId: 'host', activeSessionId: 'A', interaction: interaction('A', 2) } });
  assert.equal(task.element('promptInput').textContent, '');
  assert.deepEqual(JSON.parse(JSON.stringify((task.savedWebviewState() as typeof saved).ordinarySessionDrafts)), saved.ordinarySessionDrafts, 'task rendering never consumes or rewrites ordinary drafts');
});

test('unrecognized ordinary draft state and failed UI-state writes leave the composer editable and retain its text', () => {
  for (const saved of [[], { ordinarySessionDrafts: { version: 9, futureDraft: 'Keep future bytes' } },
    { ordinarySessionDrafts: { version: 1, entries: { damaged: 'Retain recovery evidence' } } }]) {
    const view = createWebviewDomHarness(saved);
    view.receive({ type: 'state', revision: 1, state: { activationId: 'host', activeSessionId: 'A', interaction: interaction('A', 1) } });
    view.element('promptInput').textContent = 'Editable 中文 draft';
    view.element('promptInput').dispatchEvent({ type: 'input' });
    assert.equal(view.element('promptInput').textContent, 'Editable 中文 draft');
    assert.equal(view.element('sendButton').disabled, false);
    assert.equal(JSON.stringify(view.savedWebviewState()), JSON.stringify(saved));
  }
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activationId: 'host', activeSessionId: 'A', interaction: interaction('A', 1) } });
  view.window.keepseekVscode.setState = () => { throw new Error('Controlled UI-state write failure'); };
  view.element('promptInput').textContent = 'Keep on failed save';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  view.element('composer').dispatchEvent({ type: 'submit' });
  const sent = view.posted.find(message => message.type === 'sendPrompt')!;
  view.receive({ type: 'submissionResult', requestId: sent.requestId, sessionId: 'A', status: 'failed', reason: 'Controlled body durability failure' });
  assert.equal(view.element('promptInput').textContent, 'Keep on failed save');
  assert.equal(view.element('sendButton').disabled, false);
});

test('a new activation retires a pending ordinary submission and its late ACK cannot clear the new draft', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 10, state: { activationId: 'old-host', activeSessionId: 'A', interaction: interaction('A', 10) } });
  view.element('promptInput').textContent = 'Old awaiting durable acceptance';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  view.element('composer').dispatchEvent({ type: 'submit' });
  const oldSend = view.posted.find(message => message.type === 'sendPrompt')!;
  assert.equal(view.element('sendButton').disabled, true);
  view.receive({ type: 'state', revision: 1, state: { activationId: 'new-host', activeSessionId: 'B', interaction: interaction('B', 1) } });
  assert.equal(view.element('promptInput').textContent, '');
  assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
  view.element('promptInput').textContent = 'New host draft 中文';
  view.element('promptInput').dispatchEvent({ type: 'input' });
  assert.equal(view.element('sendButton').disabled, false);
  view.receive({ type: 'submissionResult', requestId: oldSend.requestId, sessionId: oldSend.sessionId, status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'New host draft 中文');
  view.receive({ type: 'state', revision: 11, state: { activationId: 'old-host', activeSessionId: 'A', interaction: interaction('A', 11) } });
  assert.equal(view.state.activeSessionId, 'B');
  assert.equal(view.element('promptInput').textContent, 'New host draft 中文');
  view.element('composer').dispatchEvent({ type: 'submit' });
  const next = view.posted.filter(message => message.type === 'sendPrompt').at(-1)!;
  assert.equal(next.sessionId, 'B'); assert.notEqual(next.requestId, oldSend.requestId);
});

function recoverableDraftView(entries = [{ activationId: 'old-host', sessionId: 'orphan-not-in-history', markup: 'Orphan 草稿🙂' }]) {
  const saved = { ordinarySessionDrafts: { version: 1, entries } };
  const view = createWebviewDomHarness(saved, { serializeMarkup: true });
  view.receive({ type: 'state', revision: 1, state: { activationId: 'current-host', activeSessionId: 'fresh-target', language: 'en',
    messages: [], sessionSummaries: [], approvalMode: 'ask', skills: { activeSkillIds: [] },
    interaction: { ...interaction('fresh-target', 1), canRecoverDraft: true } } });
  view.posted.length = 0;
  return { view, saved };
}

function chooseLocalDraft(view: ReturnType<typeof createWebviewDomHarness>, index = 0) {
  const list = view.element('ordinaryDraftRecoveryEntries');
  const button = list.querySelector('[data-ordinary-draft-index="' + index + '"]');
  assert.ok(button);
  list.dispatchEvent({ type: 'click', target: button });
}

test('explicit local recovery finds orphan blank drafts without loading history or reviving their target or approval state', () => {
  const { view, saved } = recoverableDraftView();
  assert.equal(view.element('promptInput').textContent, '', 'a new activation starts blank');
  assert.equal(view.element('ordinaryDraftRecoveryEntries').children.length, 0, 'draft choices are built only after an explicit click');
  view.element('settingsTab').click(); view.element('settingsRecoverDraftMenuItem').click();
  assert.match(view.element('ordinaryDraftRecoveryStatus').textContent, /Choose a draft/u);
  chooseLocalDraft(view);
  assert.equal(view.element('promptInput').textContent, 'Orphan 草稿🙂');
  assert.equal(view.state.activeSessionId, 'fresh-target');
  assert.equal(view.state.activationId, 'current-host');
  assert.equal(view.state.approvalMode, 'ask');
  assert.equal(view.state.skills.activeSkillIds.length, 0);
  assert.equal(view.state.sessionSummaries.length, 0);
  assert.equal(view.element('ordinaryDraftRecoveryMenu').classList.contains('hidden'), true);
  assert.deepEqual(view.posted, [], 'local draft recovery emits no Host, history, Worker or model-request message');
  const stored = (view.savedWebviewState() as typeof saved).ordinarySessionDrafts.entries;
  assert.ok(stored.some(entry => entry.sessionId === 'orphan-not-in-history' && entry.markup === 'Orphan 草稿🙂'), 'recovery copies rather than consumes the original draft');
  const restarted = createWebviewDomHarness(view.savedWebviewState());
  restarted.receive({ type: 'state', revision: 1, state: { activationId: 'another-host', activeSessionId: 'another-fresh',
    interaction: { ...interaction('another-fresh', 1), canRecoverDraft: true } } });
  assert.equal(restarted.element('promptInput').textContent, '');
});

test('local recovery refuses nonempty, historic, busy and old-Host targets and respects IME and target changes at selection', () => {
  for (const kind of ['nonempty', 'history', 'busy', 'missing-capability', 'task', 'router'] as const) {
    const { view } = recoverableDraftView();
    if (kind === 'nonempty') { view.element('promptInput').textContent = 'Keep current draft'; view.element('promptInput').dispatchEvent({ type: 'input' }); }
    else if (kind === 'task' || kind === 'router') view.receive({ type: 'projectTasksState', projectId: 'P', hostId: 'H', revision: 1, viewGeneration: 1,
      viewMode: kind === 'task' ? 'task' : 'project', viewTaskId: 'T', cards: [{ id: 'T', sessionId: 'fresh-target', rootTaskId: 'R', status: 'idle', title: 'Task' }] });
    else view.receive({ type: 'state', revision: 2, state: kind === 'history' ? { historyPreview: { sessionId: 'fresh-target' } }
      : { interaction: { ...interaction('fresh-target', 2), canRecoverDraft: kind === 'busy' ? false : undefined } } });
    view.posted.length = 0;
    view.element('settingsRecoverDraftMenuItem').click();
    assert.equal(view.element('ordinaryDraftRecoveryEntries').children.length, 0);
    assert.match(view.element('ordinaryDraftRecoveryStatus').textContent, /blank ordinary session/u);
    if (kind === 'nonempty') assert.equal(view.element('promptInput').textContent, 'Keep current draft');
    assert.deepEqual(view.posted, []);
  }
  const { view } = recoverableDraftView();
  view.element('settingsRecoverDraftMenuItem').click();
  const oldChoice = view.element('ordinaryDraftRecoveryEntries').querySelector('[data-ordinary-draft-index="0"]')!;
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' });
  view.element('promptInput').textContent = '中文候选'; view.element('promptInput').dispatchEvent({ type: 'input', isComposing: true });
  chooseLocalDraft(view);
  assert.equal(view.element('promptInput').textContent, '中文候选');
  assert.match(view.element('ordinaryDraftRecoveryStatus').textContent, /IME composition/u);
  view.element('promptInput').dispatchEvent({ type: 'compositionend' }); view.advance(0);
  view.receive({ type: 'state', revision: 3, state: { activeSessionId: 'next-fresh', interaction: { ...interaction('next-fresh', 3), canRecoverDraft: true } } });
  view.element('ordinaryDraftRecoveryEntries').dispatchEvent({ type: 'click', target: oldChoice });
  assert.equal(view.element('promptInput').textContent, '', 'a stale choice cannot paste into a different target');
  assert.equal(view.element('ordinaryDraftRecoveryMenu').classList.contains('hidden'), true);
  assert.deepEqual(view.posted, []);
});

test('local draft recovery renders bounded pages, preserves saved entries, and gives Escape to a higher account dialog', () => {
  const entries = Array.from({ length: 23 }, (_, index) => ({ activationId: 'old', sessionId: 'orphan-' + index, markup: 'Saved draft ' + index }));
  const { view } = recoverableDraftView(entries);
  view.element('settingsRecoverDraftMenuItem').click();
  assert.equal(view.element('ordinaryDraftRecoveryEntries').children.length, 20);
  view.element('ordinaryDraftRecoveryNext').click();
  assert.equal(view.element('ordinaryDraftRecoveryEntries').children.length, 3);
  view.element('ordinaryDraftRecoveryPrevious').click();
  assert.equal(view.element('ordinaryDraftRecoveryEntries').children.length, 20);
  view.receive({ type: 'showSettingsDialog', sources: [] });
  const higherEscape = { type: 'keydown', key: 'Escape', target: view.element('settingsDialogOverlay'), immediatePropagationStopped: false };
  view.document.dispatchEvent(higherEscape);
  assert.equal(higherEscape.immediatePropagationStopped, false, 'recovery does not consume the higher overlay Escape');
  view.element('settingsDialogOverlay').dispatchEvent(higherEscape);
  assert.equal(view.element('settingsDialogOverlay').classList.contains('hidden'), true);
  assert.equal(view.element('ordinaryDraftRecoveryMenu').classList.contains('hidden'), false);
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('ordinaryDraftRecoveryMenu').classList.contains('hidden'), true);
  assert.equal(view.document.activeElement, view.element('settingsTab'), 'closing returns focus to a visible control');
  assert.equal((view.savedWebviewState() as { ordinarySessionDrafts: { entries: unknown[] } }).ordinarySessionDrafts.entries.length, 23);
  assert.deepEqual(view.posted, []);
});

test('navigation and saving show precise phases, keep drafts editable and never offer Stop', () => {
  for (const language of ['en', 'zh-CN']) {
    const view = readyView(language);
    for (const [index, phase] of ['loading_session', 'preparing_context', 'saving'].entries()) {
      view.receive({ type: 'state', revision: index + 2,
        state: { interaction: interaction('A', index + 2, phase), isBusy: false } });
      assert.equal(view.element('sendButton').dataset.mode, 'send');
      assert.equal(view.element('sendButton').disabled, true);
      assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
      assert.equal(view.element('referenceMenuButton').disabled, true);
      assert.ok(view.element('statusText').textContent);
      assert.doesNotMatch(view.element('statusText').textContent, /Processing|处理中/u);
    }
    view.receive({ type: 'state', revision: 6, state: { interaction: interaction('A', 6) } });
    assert.equal(view.element('statusText').textContent, '');
    assert.equal(view.element('referenceMenuButton').disabled, false);
  }
});

test('operation completion clears startup and reconnect status while preserving a new notification', () => {
  const view = readyView();
  view.receive({ type: 'state', revision: 2, state: { isBusy: true, interaction: interaction('A', 2, 'running'),
    agentActivity: { base: 'running', phase: 'reconnecting', reconnectAttempt: 1 } } });
  assert.ok(view.element('statusText').textContent);
  view.window.keepseekInputControls.showStatus('Save failed');
  view.receive({ type: 'state', revision: 3, state: { isBusy: false, interaction: interaction('A', 3) } });
  assert.equal(view.element('statusText').textContent, 'Save failed');
  view.advance(8000);
  view.window.keepseekInputControls.showStatus('A newer notice');
  view.advance(120);
  assert.equal(view.element('statusText').textContent, 'A newer notice', 'an expired notice cannot erase a newer one');
  view.advance(8000);
  assert.equal(view.element('statusText').textContent, '');
});

test('switching sessions clears operation status and rotation immediately; stale state cannot restore it', () => {
  const view = readyView();
  view.element('promptInput').textContent = 'draft A';
  view.receive({ type: 'state', revision: 2, state: { isBusy: true, interaction: interaction('A', 2, 'running'),
    agentActivity: { base: 'idle', phase: 'idle' } } });
  view.receive({ type: 'state', revision: 3, state: { activeSessionId: 'B', isBusy: false,
    interaction: interaction('B', 3), agentActivity: { base: 'idle', phase: 'idle' } } });
  view.receive({ type: 'statePatch', revision: 2, state: { activeSessionId: 'A', isBusy: true } });
  view.receive({ type: 'sessionChanged', sessionId: 'A', revision: 2 });
  view.advance(16000);
  assert.equal(view.state.activeSessionId, 'B');
  assert.equal(view.element('statusText').textContent, '');
  assert.equal(view.element('sendButton').dataset.mode, 'send');
  view.receive({ type: 'state', revision: 4, state: { activeSessionId: 'A', interaction: interaction('A', 4) } });
  assert.equal(view.element('promptInput').textContent, 'draft A');
});

test('submission remains pending without inventing taskRunning, and rejection keeps the exact draft', () => {
  const view = readyView();
  view.element('promptInput').textContent = 'my request';
  view.element('composer').dispatchEvent({ type: 'submit' });
  view.element('composer').dispatchEvent({ type: 'submit' });
  const sends = view.posted.filter(message => message.type === 'sendPrompt');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sessionId, 'A');
  assert.ok(sends[0].requestId);
  assert.equal(view.state.isBusy, false);
  assert.equal(view.element('sendButton').dataset.mode, 'send');
  assert.equal(view.element('promptInput').textContent, 'my request');
  view.receive({ type: 'submissionResult', requestId: sends[0].requestId, sessionId: 'A', status: 'rejected' });
  assert.equal(view.element('promptInput').textContent, 'my request');
  assert.equal(view.element('sendButton').disabled, false);
});

test('only a matching accepted submission clears an unchanged draft; late feedback cannot release a newer pending request', () => {
  const view = readyView();
  view.element('promptInput').textContent = 'first';
  view.element('composer').dispatchEvent({ type: 'submit' });
  const first = view.posted.find(message => message.type === 'sendPrompt')!;
  view.receive({ type: 'submissionResult', requestId: first.requestId, sessionId: 'B', status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'first');
  view.receive({ type: 'submissionResult', requestId: first.requestId, sessionId: 'A', status: 'failed' });
  view.element('composer').dispatchEvent({ type: 'submit' });
  const second = view.posted.filter(message => message.type === 'sendPrompt').at(-1)!;
  view.receive({ type: 'submissionResult', requestId: first.requestId, sessionId: 'A', status: 'rejected' });
  assert.equal(view.element('sendButton').disabled, true);
  view.element('promptInput').textContent = 'new draft typed while awaiting acceptance';
  view.receive({ type: 'submissionResult', requestId: second.requestId, sessionId: 'A', status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'new draft typed while awaiting acceptance');
  view.element('composer').dispatchEvent({ type: 'submit' });
  const third = view.posted.filter(message => message.type === 'sendPrompt').at(-1)!;
  view.receive({ type: 'submissionResult', requestId: third.requestId, sessionId: 'A', status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, '');
});

test('cancellation targets a current host operation; preparation failure offers retry without resending', () => {
  const view = readyView();
  view.receive({ type: 'state', revision: 2, state: { isBusy: true, interaction: interaction('A', 2, 'running') } });
  view.element('sendButton').click();
  assert.equal(view.posted.at(-1)?.type, 'abortPrompt');
  assert.equal(view.posted.at(-1)?.operationId, 'operation-2');
  view.receive({ type: 'state', revision: 3, state: { isBusy: false,
    interaction: { ...interaction('A', 3, 'failed'), blockingReason: 'Disk full' } } });
  assert.equal(view.element('statusText').textContent, 'Disk full');
  assert.equal(view.element('interactionRetry').classList.contains('hidden'), false);
  view.element('interactionRetry').click();
  assert.equal(view.posted.at(-1)?.type, 'retryInteraction');
  assert.equal(view.posted.some(message => message.type === 'sendPrompt'), false);
});

test('edit and resend keeps its draft through rejection and clears it only on matching acceptance', () => {
  const view = readyView();
  view.receive({ type: 'state', revision: 2, state: { messages: [
    { id: 'user-a', role: 'user', content: 'original', createdAt: '2026-11-06T00:00:00.000Z' }
  ] } });
  const transcript = view.element('transcript');
  const edit = transcript.querySelector('button[data-message-action="edit"]');
  assert.ok(edit);
  transcript.dispatchEvent({ type: 'click', target: edit });
  let editor = transcript.querySelector('.message-edit-input');
  assert.ok(editor);
  editor.textContent = 'edited request';
  transcript.dispatchEvent({ type: 'submit', target: transcript.querySelector('.message-edit-form') });
  const first = view.posted.find(message => message.type === 'editUserPrompt');
  assert.ok(first);
  assert.equal(first.sessionId, 'A');
  view.receive({ type: 'submissionResult', requestId: first.requestId, sessionId: 'A', status: 'rejected' });
  editor = transcript.querySelector('.message-edit-input');
  assert.equal(editor?.textContent, 'edited request');
  transcript.dispatchEvent({ type: 'submit', target: transcript.querySelector('.message-edit-form') });
  const second = view.posted.filter(message => message.type === 'editUserPrompt').at(-1)!;
  view.receive({ type: 'submissionResult', requestId: second.requestId, sessionId: 'A', status: 'accepted' });
  assert.equal(transcript.querySelector('.message-edit-input'), null);
});

test('background usage remains explicitly loading or incomplete without showing fake totals', () => {
  const view = readyView();
  for (const [index, displayReadiness] of ['loading', 'incomplete'].entries()) {
    view.receive({ type: 'state', revision: index + 2, state: { usageMetrics: { displayReadiness } } });
    assert.match(view.element('contextProgressPercent').textContent, /Loading usage|Usage is incomplete/u);
    assert.equal(view.element('contextProgressTokens').textContent, '');
    view.element('contextProgress').click();
    assert.doesNotMatch(view.element('usageDetailsBody').textContent, /0[.,]00|Total.*0/u);
    assert.equal(view.element('newChatTab').disabled, false);
  }
});

test('input feature fragments compose deterministically and exactly once', () => {
  for (const fragments of [INPUT_SCRIPT_FRAGMENTS, INPUT_STYLE_FRAGMENTS, INPUT_TEMPLATE_FRAGMENTS]) {
    assert.equal(new Set(fragments).size, fragments.length);
    assert.equal(new Set(fragments.map((fragment) => fragment.id)).size, fragments.length);
    assert.ok(fragments.every((fragment) => fragment.id.length > 0 && fragment.source.length > 0));
    assert.equal(composeWebviewFragments(fragments), fragments.map((fragment) => fragment.source).join(''));
    assert.equal(composeWebviewFragments(fragments), composeWebviewFragments(fragments));
  }

  const duplicate: WebviewFragment = { id: 'duplicate', source: 'a' };
  assert.throws(
    () => composeWebviewFragments([duplicate, { id: 'duplicate', source: 'b' }]),
    /Duplicate or empty Webview fragment id/u
  );
});

test('modular input assembly preserves reviewed task-aware input bytes', () => {
  assert.equal(hash(getInputScript()), 'd21fcfe260347b7b4ea466ab52ec5c476c4e10fae011044a14b524e651e902e2');
  assert.equal(hash(getInputStyles()), '4c25e741f3940ad01a7a9190450169fcdd0b9ece2b33b637b82d39501c6e74e9');
  // Account cancellation remains usable independently of project execution.
  assert.equal(hash(getInputTemplate()), '10fb2f0bb0209ac8bcdd4e4ec72a7c89f56d008a44a94eb3f2f56f132d3a9cfd');
});

test('assembled input keeps unique DOM ids, public controls, payload fields, and feature CSS', () => {
  const template = getInputTemplate();
  const ids = [...template.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);

  const script = getInputScript();
  const publicApiStart = script.indexOf('window.keepseekInputControls = {');
  const publicApiEnd = script.indexOf('};', publicApiStart);
  assert.ok(publicApiStart >= 0 && publicApiEnd > publicApiStart);
  const publicApi = script.slice(publicApiStart, publicApiEnd);
  for (const method of [
    'render',
    'renderUsage',
    'showSettingsDialog',
    'showHistorySettingsDialog',
    'showAboutDialog',
    'onSkillDraftCreated',
    'showStatus',
    'isPromptSubmittableEmpty',
    'clearPrompt'
  ]) {
    assert.match(publicApi, new RegExp(`\\b${method}:`, 'u'));
  }

  const submitStart = script.indexOf("composer.addEventListener('submit'");
  const submitEnd = script.indexOf("sendButton.addEventListener('click'", submitStart);
  const submit = script.slice(submitStart, submitEnd);
  for (const field of ['prompt', 'sourceId', 'modelId', 'settings', 'references', 'skillIds']) {
    assert.match(submit, new RegExp(`\\b${field}:`, 'u'));
  }
  assert.match(submit, /type: 'sendPrompt'/u);

  const styles = getInputStyles();
  for (const selector of [
    '.composer-input-inner',
    '.rich-file-link',
    '.reference-menu',
    '.skills-bar',
    '.command-menu',
    '.command-model-option',
    '.context-progress',
    '.usage-details-dialog',
    '.settings-overlay',
    '.settings-account-workspace',
    '.about-details',
    '.new-account-provider-menu'
  ]) {
    assert.ok(styles.includes(selector), `missing ${selector}`);
  }

  assert.doesNotThrow(() => new Function(script));
  assert.doesNotThrow(() => new Function(getScript()));
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
