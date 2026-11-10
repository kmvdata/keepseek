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

test('modular input assembly preserves the reviewed generated bytes', () => {
  assert.equal(hash(getInputScript()), '29a97def6c5729f335cd04663260c5c9f36b2d2092d16420548ddbeca9159192');
  // Intentional feature change: history cleanup controls, request-scoped progress/results,
  // and accessible dialog styles. Provider request/prompt/schema fixtures are unchanged.
  assert.equal(hash(getInputStyles()), 'c5a2b88bbe0da4171a69770e7f77ff3725efdb103efa02fca71545dda954a39b');
  assert.equal(hash(getInputTemplate()), '534524f8a0702b03f23ee02f88a750f11ee98aebb310a6ff9b833d9f06b00337');
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
