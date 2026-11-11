import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
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

test('exact approval presents combined scope, preserves focus, and posts one response across rerenders', () => {
  const view = readyView('en');
  const manual = { id: 'exact-approval', sessionId: 'A', label: 'Read reference.txt', reason: 'External scope required',
    authorizationTargets: ['file:///outside/reference.txt'],
    request: { exactAction: { kind: 'external_file_access', uri: 'file:///outside/reference.txt', access: 'read' } } };
  view.receive({ type: 'state', revision: 2, state: { approvalMode: 'delegate', manualToolApproval: manual } });
  const transcript = view.element('transcript');
  const approveButton = () => transcript.querySelector('button[data-manual-approval-action="approve"]');
  assert.equal(view.state.startup.interactiveReady, true);
  assert.equal(approveButton()?.textContent, 'Authorize and run once');
  assert.equal(transcript.querySelector('.approval-exact-scope li')?.textContent, manual.authorizationTargets[0]);
  assert.match(transcript.querySelector('.approval-exact-payload')?.textContent ?? '', /"access": "read"/u);
  approveButton()?.focus();
  view.receive({ type: 'statePatch', sessionId: 'A', revision: 3, state: { language: 'zh-CN' } });
  assert.equal(approveButton()?.textContent, '授权并仅执行一次');
  assert.equal(view.document.activeElement, approveButton());
  const originalButton = approveButton()!;
  originalButton.click();
  view.receive({ type: 'statePatch', sessionId: 'A', revision: 4, state: { isBusy: true } });
  assert.equal(approveButton()?.disabled, true);
  originalButton.dispatchEvent({ type: 'click' });
  approveButton()?.click();
  const responses = view.posted.filter(message => message.type === 'resolveValidationApproval');
  assert.equal(responses.length, 1);
  assert.equal(responses[0].id, manual.id);
  assert.equal(responses[0].approve, true);

  const restarted = readyView();
  restarted.receive({ type: 'state', revision: 2, state: { pendingApproval: { status: 'interrupted', label: manual.label, reason: manual.reason } } });
  assert.match(restarted.element('transcript').textContent, /Approval processing was interrupted/u);
  assert.equal(restarted.element('transcript').querySelector('button[data-manual-approval-action]'), null);
  assert.doesNotMatch(restarted.element('transcript').textContent, /file:\/\/\/outside/u);
});

test('approval mode help describes automatic project work and host process permissions in both languages', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const view = readyView(language);
    view.receive({ type: 'state', revision: 2, state: { approvalMode: 'delegate', commandSettingsReadiness: { approvalMode: 'ready' } } });
    const labels = WEBVIEW_TRANSLATIONS[language];
    assert.equal(view.element('commandApprovalModeDescription').textContent, labels.approvalDelegateDescription);
    const switchButton = view.element('commandApprovalModeSwitch');
    assert.match(switchButton.title, language === 'en' ? /no OS sandbox/u : /无操作系统沙箱/u);
    assert.equal(switchButton.getAttribute('aria-description'), switchButton.title);
  }
});

for (const platform of ['Win32', 'Linux x86_64', 'MacIntel']) {
  test(`${platform} uses the same Emacs clipboard commands in both editors before host dispatch`, () => {
    const view = createWebviewDomHarness(platform);
    view.receive({ type: 'state', revision: 1, state: {
      activeSessionId: 'A', isMac: platform !== 'MacIntel',
      startup: { interactiveReady: true, sideEffectsReady: true }, interaction: interaction('A', 1),
      messages: [{ id: 'user-a', role: 'user', content: 'original', createdAt: '2026-11-11T00:00:00.000Z' }]
    } });
    const prompt = view.element('promptInput');
    prompt.textContent = 'main draft';
    const transcript = view.element('transcript');
    transcript.dispatchEvent({ type: 'click', target: transcript.querySelector('button[data-message-action="edit"]') });
    const inline = transcript.querySelector('.message-edit-input');
    assert.ok(inline);
    inline.textContent = 'inline draft';

    for (const editor of [prompt, inline]) {
      editor.focus();
      editor.scrollTop = 0;
      editor.scrollHeight = 400;
      const dispatch = (event: Record<string, unknown>) => (editor === prompt ? prompt : transcript).dispatchEvent({ target: editor, ...event });
      for (const [key, ctrlKey, altKey] of [['w', true, false], ['w', false, true], ['y', true, false], ['y', false, true]] as const) {
        let prevented = false;
        let stopped = false;
        dispatch({ type: 'keydown', key, code: 'Key' + key.toUpperCase(), ctrlKey, altKey, metaKey: false, shiftKey: false,
          preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
        assert.equal(prevented, true, `Emacs ${key} must be handled locally`);
        assert.equal(stopped, true, `Emacs ${key} must not reach a host shortcut`);
      }
      // Restore Emacs C-v page-down on every platform; no Windows clipboard exception.
      let pagePrevented = false;
      dispatch({ type: 'keydown', key: 'v', code: 'KeyV', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
        preventDefault: () => { pagePrevented = true; } });
      assert.equal(pagePrevented, true);
      assert.equal(editor.scrollTop, 120);
      let composingPrevented = false;
      dispatch({ type: 'keydown', key: 'y', code: 'KeyY', ctrlKey: true, isComposing: true,
        preventDefault: () => { composingPrevented = true; } });
      assert.equal(composingPrevented, false);
    }
    assert.equal(view.posted.some(message => ['sendPrompt', 'editUserPrompt'].includes(message.type)), false);
  });

  test(`${platform} context menus advertise and dispatch Emacs commands in both editors`, () => {
    const view = createWebviewDomHarness(platform);
    view.receive({ type: 'state', revision: 1, state: {
      activeSessionId: 'A', language: 'en', startup: { interactiveReady: true, sideEffectsReady: true }, interaction: interaction('A', 1),
      messages: [{ id: 'user-a', role: 'user', content: 'original', createdAt: '2026-11-11T00:00:00.000Z' }]
    } });
    const prompt = view.element('promptInput');
    const transcript = view.element('transcript');
    transcript.dispatchEvent({ type: 'click', target: transcript.querySelector('button[data-message-action="edit"]') });
    const inline = transcript.querySelector('.message-edit-input');
    assert.ok(inline);
    for (const editor of [prompt, inline]) {
      editor.focus();
      let prevented = false;
      let stopped = false;
      (editor === prompt ? prompt : transcript).dispatchEvent({ type: 'contextmenu', target: editor, clientX: 80, clientY: 90,
        preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
      assert.equal(prevented, true);
      assert.equal(stopped, true);
      const menu = view.element('keepseek-editor-context-menu');
      assert.ok(menu);
      assert.equal(menu.getAttribute('role'), 'menu');
      assert.deepEqual(menu.querySelectorAll('kbd').map(item => item.textContent), ['C-w', 'M-w', 'C-y', 'M-y']);
      const buttons = menu.querySelectorAll('button');
      assert.deepEqual(buttons.map(item => item.title), ['kill-region', 'kill-ring-save', 'yank', 'yank-pop']);
      assert.deepEqual(buttons.map(item => item.firstChild?.textContent), ['Cut', 'Copy', 'Paste', 'Cycle kill ring']);
      assert.equal(buttons[0]?.disabled, true, 'Cut needs a selected region');
      assert.equal(buttons[1]?.disabled, true, 'Copy needs a selected region');
      assert.equal(buttons[3]?.disabled, true, 'Yank-pop needs an immediately preceding yank');
      assert.doesNotMatch(menu.textContent, /Ctrl\+[XCV]|Cmd\+[XCV]/u);
      const before = view.posted.filter(message => message.type === 'requestClipboardText').length;
      buttons[2]!.click();
      assert.equal(view.element('keepseek-editor-context-menu'), null);
      assert.equal(view.document.activeElement, editor);
      assert.equal(view.posted.filter(message => message.type === 'requestClipboardText').length, before + 1);
    }
  });
}

test('Emacs context menu localizes labels and supports keyboard and outside dismissal', () => {
  const view = readyView('zh-CN');
  const prompt = view.element('promptInput');
  prompt.focus();
  prompt.dispatchEvent({ type: 'contextmenu', target: prompt });
  let menu = view.element('keepseek-editor-context-menu');
  assert.ok(menu);
  assert.deepEqual(menu.querySelectorAll('button').map(item => item.firstChild?.textContent), ['剪切', '复制', '粘贴', '轮换杀环历史']);
  const yank = menu.querySelector('[data-emacs-command="yank"]');
  assert.equal(view.document.activeElement, yank);
  menu.dispatchEvent({ type: 'keydown', key: 'ArrowUp' });
  assert.equal(view.document.activeElement, yank, 'navigation skips unavailable commands');
  menu.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('keepseek-editor-context-menu'), null);
  assert.equal(view.document.activeElement, prompt);
  prompt.dispatchEvent({ type: 'contextmenu', target: prompt });
  menu = view.element('keepseek-editor-context-menu');
  assert.ok(menu);
  const requests = view.posted.filter(message => message.type === 'requestClipboardText').length;
  menu.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(view.element('keepseek-editor-context-menu'), null);
  assert.equal(view.posted.filter(message => message.type === 'requestClipboardText').length, requests + 1);
  prompt.dispatchEvent({ type: 'contextmenu', target: prompt });
  assert.ok(view.element('keepseek-editor-context-menu'));
  view.document.dispatchEvent({ type: 'mousedown', target: view.document.body });
  assert.equal(view.element('keepseek-editor-context-menu'), null);
  let unrelatedPrevented = false;
  view.element('statusText').dispatchEvent({ type: 'contextmenu', preventDefault: () => { unrelatedPrevented = true; } });
  assert.equal(unrelatedPrevented, false, 'unrelated UI keeps its normal context menu');
});

test('a context menu opened in a previous session cannot paste into the reused prompt', () => {
  const view = readyView();
  const prompt = view.element('promptInput');
  prompt.dispatchEvent({ type: 'contextmenu', target: prompt });
  const menu = view.element('keepseek-editor-context-menu');
  assert.ok(menu);
  const paste = menu.querySelector('[data-emacs-command="yank"]');
  assert.ok(paste);
  const requests = view.posted.filter(message => message.type === 'requestClipboardText').length;
  view.receive({ type: 'state', revision: 2, state: { activeSessionId: 'B', interaction: interaction('B', 2) } });
  paste.click();
  assert.equal(view.posted.filter(message => message.type === 'requestClipboardText').length, requests);
  assert.equal(view.element('keepseek-editor-context-menu'), null);
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
  // The approval mode menu adds accessible process-permissions help.
  assert.equal(hash(getInputScript()), '95a409d1c9efb5b972d4f75c878a2441debcc19f92647bf8694250064bb17859');
  // Initial storage baseline: remove obsolete cleanup-source and legacy usage UI.
  // Current DOM behavior is verified below and by the history/usage harnesses.
  assert.equal(hash(getInputStyles()), 'c5a2b88bbe0da4171a69770e7f77ff3725efdb103efa02fca71545dda954a39b');
  assert.equal(hash(getInputTemplate()), 'a65e971fc21d386d4d98cd6b3265f7636258dd2d916d095cf9567148c56e798c');
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
