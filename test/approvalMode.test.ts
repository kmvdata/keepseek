import './registerVscodeStub';
import assert from 'node:assert/strict';
import { sessionUseFixture } from './sessionUseFixture';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { DelegatedApprovalQueue, draftRunPreparedMessage, getApprovalModeUserTail, normalizeApprovalMode } from '../src/agent/approvalMode';
import { localize, WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { createDraftRunProposal, hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { createFullTextDraftEdit, createDeleteDraftEdit } from '../src/edits/draftEdit';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { ExactOperationGrants } from '../src/approvals/authorization';
import { buildInitialAgentMessages, getAgentSystemPrompt, getAgentTools, RUN_VALIDATION_TOOL_NAME } from '../src/agent/protocol';
import { ToolAuthorizationService } from '../src/agent/tools/toolAuthorization';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { approvalRenderFragment } from '../src/webview/input/commandMenu/approval';
import { modelControlsLockingFragment, modelControlsRenderFragment, modelControlsHelpersFragment } from '../src/webview/input/commandMenu/models';
import { commandMenuImplementationFragment } from '../src/webview/input/commandMenu/script';
import { getScript } from '../src/webview/script';
import type { ApprovalMode, ChatMessage, ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { invalidateApprovalStateForHistory, normalizeApprovalProcessing } from '../src/approvals/approvalProcessing';
import type { HistoryTruncationScope } from '../src/sessions/historyTruncation';

test('draft receipt and host authorization text describe the actual mode without claiming execution', () => {
  for (const lang of ['en', 'zh-CN'] as const) for (const mode of ['ask', 'delegate'] as const) {
    const receipt = draftRunPreparedMessage(mode, lang);
    assert.match(receipt, lang === 'en' ? /no process was started/u : /尚未执行/u);
    if (mode !== 'ask') assert.doesNotMatch(receipt, /Wait for the user|等待用户/u);
    const scope = localize(lang, 'approvalExternalPrompt', { target: 'file:///outside/result.txt' });
    assert.match(scope, /file:\/\/\/outside\/result.txt/u);
    assert.notEqual(localize(lang, 'approvalReviewerUnavailable'), 'approvalReviewerUnavailable');
    const delegate = WEBVIEW_TRANSLATIONS[lang].approvalDelegateDescription;
    assert.match(delegate, lang === 'en' ? /ask you when needed/u : /必要时请你确认/u);
    assert.ok(delegate.length <= WEBVIEW_TRANSLATIONS[lang].approvalAskDescription.length * 1.2);
  }
});

test('approval defaults fail closed and queue cannot replay, cross sessions, or survive cancellation', () => {
  assert.equal(normalizeApprovalMode('delegate'), 'delegate');
  assert.equal(normalizeApprovalMode('model_review'), 'ask');
  for (const value of [undefined, true, 'always', 'Delegate', 'ask']) assert.equal(normalizeApprovalMode(value), 'ask');
  const queue = new DelegatedApprovalQueue();
  const batch = { sessionId: 's', runId: 'r', editIds: ['e'], draftRunIds: ['d'] };
  queue.enqueue(batch);
  batch.editIds.push('mutated');
  assert.equal(queue.take('other'), undefined);
  const first = queue.take('s')!;
  assert.deepEqual(first.batch.editIds, ['e']);
  assert.equal(queue.take('s'), undefined);
  queue.enqueue({ ...batch, runId: 'next' });
  queue.cancel();
  assert.equal(first.controller.signal.aborted, true);
  queue.finish(first.controller);
  assert.equal(queue.take('s'), undefined);
  assert.equal(new DelegatedApprovalQueue().take('s'), undefined);
});

test('history truncation cancels only the matching queued or active approval segment', () => {
  const scope: HistoryTruncationScope = { id: 'edit-resend', sessionId: 's', removedMessageIds: ['removed'],
    removedSegmentIds: ['removed-segment'], retainedMessageIds: ['retained'] };
  const queue = new DelegatedApprovalQueue();
  queue.enqueue({ sessionId: 's', runId: 'retained-segment', rootTaskId: 'same-root', editIds: ['retained-edit'], draftRunIds: [] });
  const retained = queue.take('s')!;
  queue.enqueue({ sessionId: 's', runId: 'removed-segment', rootTaskId: 'same-root', editIds: ['removed-edit'], draftRunIds: [] });
  queue.invalidateHistory(scope);
  assert.equal(retained.controller.signal.aborted, false);
  queue.finish(retained.controller);
  assert.equal(queue.take('s'), undefined);

  queue.enqueue({ sessionId: 's', runId: 'removed-segment', editIds: [], draftRunIds: ['run'] });
  const removed = queue.take('s')!;
  queue.invalidateHistory({ ...scope, sessionId: 'another' });
  assert.equal(removed.controller.signal.aborted, false);
  queue.invalidateHistory(scope);
  assert.equal(removed.controller.signal.aborted, true);
  queue.finish(removed.controller);
  queue.enqueue({ sessionId: 's', runId: 'retained-segment', editIds: ['removed-target'], draftRunIds: [] });
  queue.invalidateHistory(scope, ['removed-target']);
  assert.equal(queue.take('s'), undefined, 'a removed message may share a retained segment; exact targets still revoke queued work');
});

test('history truncation removes only affected live approval projections without changing original decisions', () => {
  const state = { id: 's', approvalProcessing: { version: 2 as const, runId: 'retained-segment', rootTaskId: 'same-root',
    mode: 'delegate' as const, status: 'blocked' as const, updatedAt: '',
    targets: [{ id: 'edit', kind: 'edit' as const, status: 'denied' as const, reason: 'Original decision.' }] },
  pendingApproval: { version: 1 as const, id: 'manual', sessionId: 's', rootTaskId: 'same-root', agentRunId: 'removed-segment',
    targetId: 'run', actionHash: 'hash', label: 'run', reason: 'Exact decision needed.', status: 'waiting' as const } };
  const original = state.approvalProcessing;
  const scope: HistoryTruncationScope = { id: 'truncation', sessionId: 's', removedMessageIds: [],
    removedSegmentIds: ['removed-segment'], retainedMessageIds: [] };
  assert.equal(invalidateApprovalStateForHistory(state, { ...scope, sessionId: 'other' }), false);
  assert.equal(invalidateApprovalStateForHistory(state, scope), true);
  assert.equal(state.pendingApproval, undefined);
  assert.equal(state.approvalProcessing, original);
  assert.equal(invalidateApprovalStateForHistory(state, { ...scope, removedSegmentIds: ['retained-segment'] }), true);
  assert.equal(state.approvalProcessing, undefined);
  assert.equal(original.targets[0].status, 'denied');
  assert.equal(invalidateApprovalStateForHistory(state, scope), false);
});

test('exact removed targets leave approval state for other targets in the same retained segment intact', () => {
  const state = { id: 's', approvalProcessing: { version: 2 as const, runId: 'shared-segment', rootTaskId: 'task',
    mode: 'delegate' as const, status: 'blocked' as const, updatedAt: '',
    targets: [{ id: 'retained', kind: 'command' as const, status: 'pending' as const },
      { id: 'removed', kind: 'command' as const, status: 'pending' as const }] },
  pendingApproval: { version: 1 as const, id: 'manual', sessionId: 's', rootTaskId: 'task', agentRunId: 'shared-segment',
    targetId: 'removed', actionHash: 'hash', label: 'run', reason: 'Exact decision needed.', status: 'waiting' as const } };
  const scope: HistoryTruncationScope = { id: 'truncation', sessionId: 's', removedMessageIds: ['removed-message'],
    removedSegmentIds: [], retainedMessageIds: ['retained-message'] };
  assert.equal(invalidateApprovalStateForHistory(state, scope, ['removed']), true);
  assert.equal(state.pendingApproval, undefined);
  assert.deepEqual(state.approvalProcessing?.targets.map(target => target.id), ['retained']);
});

test('an interrupted correction retains diagnostics and requires an explicit resume without restoring the approval queue', () => {
  const state = normalizeApprovalProcessing({ version: 2, runId: 'segment', rootTaskId: 'task', mode: 'delegate',
    status: 'replanning', replanKeys: ['a'.repeat(64)], targets: [{ id: 'run', kind: 'command', status: 'needs_replan',
      replan: { draftRunId: 'run', specHash: 'hash', rootTaskId: 'task', executionSegmentId: 'segment',
        phase: 'preflight', code: 'git_status_pager_override', reason: 'Use controlled status.', executed: false }
    }, { id: 'dependent', kind: 'command', status: 'dependency_blocked', reason: 'Malformed -m.',
      dependency: { targetId: 'run', label: 'git status', reason: 'Use controlled status.' }
    }] });
  assert.equal(state?.status, 'blocked');
  assert.equal(state?.canResume, true);
  assert.deepEqual(state?.replanKeys, ['a'.repeat(64)]);
  assert.equal(state?.targets[0].replan?.executed, false);
  assert.equal(state?.targets[1].reason, 'Malformed -m.');
  assert.equal(state?.targets[1].dependency?.targetId, 'run');
  assert.equal(new DelegatedApprovalQueue().take('session'), undefined);
});

test('stored approval modes accept only current choices and fail closed on missing or unknown values', () => {
  const scope = { key: 'workspace:test', name: 'Test', folderUris: ['file:///workspace'] };
  const sessions = normalizeStoredSessions({ sessions: [
    storedSession('ask-missing', undefined),
    storedSession('unknown', 'always'),
    storedSession('delegate', 'delegate')
  ] }, scope);
  const modes = Object.fromEntries(sessions.map((session) => [session.id, session.approvalMode]));
  assert.deepEqual(modes, {
    'ask-missing': 'ask', unknown: 'ask', delegate: 'delegate'
  });
});

test('approval mode uses the model selector interaction directly below the subagent model', () => {
  const template = getInputTemplate();
  const modelSection = template.indexOf('<section class="command-section" aria-label="Model">');
  const subagentList = template.indexOf('id="commandSubagentModelList"', modelSection);
  const approvalSwitch = template.indexOf('id="commandApprovalModeSwitch"', subagentList);
  const approvalList = template.indexOf('id="commandApprovalModeList"', approvalSwitch);
  const compressionThreshold = template.indexOf('data-i18n="compressionThreshold"', approvalList);

  assert.ok(modelSection >= 0);
  assert.ok(subagentList < approvalSwitch);
  assert.ok(approvalSwitch < approvalList);
  assert.ok(approvalList < compressionThreshold);
  assert.doesNotMatch(template, /id="commandApprovalModelButton"/u, 'reviewer is rendered inside the subagent list');
  const inputScript = getInputScript();
  const optionList = inputScript.indexOf("{ mode: 'ask'");
  assert.ok(optionList >= 0);
  assert.doesNotMatch(inputScript, /mode: 'model_review'/u);
  assert.ok(optionList < inputScript.indexOf("{ mode: 'delegate'", optionList));
  assert.equal((template.match(/id="commandApprovalModeSwitch"/gu) ?? []).length, 1);
  assert.match(inputScript, /commandApprovalModeListOpen/u);
  assert.match(inputScript, /openCommandApprovalModeListAndFocus/u);
  assert.match(inputScript, /postMessage\(\{ type: 'setApprovalMode'/u);
  assert.doesNotMatch(inputScript, /setComposerStatus\(t\('approvalMode'\)/u);
  assert.match(getScript(), /approvalMode: 'ask'/u);
  assert.doesNotMatch(JSON.stringify(getAgentTools({ requestProtocolVersion: 7 })), /setApprovalMode/u);
});

test('approval submenu renders exactly two modes and keeps reviewer configuration separate', () => {
  const script = getInputScript();
  const bindings = script.slice(script.indexOf('if (commandApprovalModeSwitch) {'), script.indexOf('if (commandSubagentModelList) {'));
  for (const language of ['zh-CN', 'en'] as const) {
    const labels = WEBVIEW_TRANSLATIONS[language];
    const modeList = new ApprovalMenuElement();
    const posted: unknown[] = [];
    const state = {
      approvalMode: 'ask', isBusy: false, manualToolApproval: false,
      commandSettingsReadiness: { approvalMode: 'ready' },
      approvalReviewerSetting: { mode: 'follow-main', label: '', error: '', sourceId: '', modelId: '' }
    };
    const context = {
      state, Element: ApprovalMenuElement, document: { createElement: () => new ApprovalMenuElement() },
      commandApprovalModeSwitch: new ApprovalMenuElement(), commandApprovalModeValue: new ApprovalMenuElement(),
      commandApprovalModeDescription: new ApprovalMenuElement(), commandApprovalModeList: modeList,
      commandApprovalModeListOpen: true,
      renderCommandMenu: () => {}, t: (key: string) => labels[key],
      vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) }
    };
    const render = new Script(approvalRenderFragment.source + modelControlsLockingFragment.source + bindings
      + '\nrenderCommandApprovalMode;').runInNewContext(context) as () => void;
    for (const mode of ['ask', 'delegate']) {
      state.approvalMode = mode;
      render();
      assert.equal(modeList.children.length, 2);
      assert.deepEqual(modeList.children.map(item => item.dataset.approvalMode), ['ask', 'delegate']);
      assert.deepEqual(modeList.children.map(item => item.attributes.role), ['menuitemradio', 'menuitemradio']);
      assert.equal(modeList.children.find(item => item.attributes['aria-checked'] === 'true')?.dataset.approvalMode, mode);
      const option = modeList.children[mode === 'ask' ? 1 : 0];
      modeList.dispatchClick(option.children[1].children[0]);
      assert.deepEqual(posted.pop(), { type: 'setApprovalMode', mode: option.dataset.approvalMode });
      assert.equal(context.commandApprovalModeListOpen, false);
    }
    for (const patch of [{ commandSettingsReadiness: { approvalMode: 'loading' } }, { commandSettingsReadiness: { approvalMode: 'error' } }]) {
      Object.assign(state, { isBusy: false, manualToolApproval: false, commandSettingsReadiness: { approvalMode: 'ready' } }, patch);
      render();
      assert.ok(modeList.children.every(option => option.disabled));
      modeList.dispatchClick(modeList.children[0]);
      assert.equal(posted.length, 0);
      assert.equal(modeList.children.length, 2, 'rerendering must not add a third entry');
    }
  }
});

test('approval model shares inline subagent selection, keyboard navigation and focus without sharing configuration', () => {
  const script = getInputScript();
  const bindings = script.slice(script.indexOf('if (commandSubagentModelList) {'), script.indexOf('if (commandModelCancelPending) {'));
  for (const language of ['zh-CN', 'en'] as const) {
    const labels = WEBVIEW_TRANSLATIONS[language];
    const list = new ApprovalMenuElement();
    const posted: unknown[] = [];
    const models = ['source-A', 'source-B', 'image-only'].map(sourceId => ({ sourceId, id: 'same-model', label: 'Same name',
      sourceName: sourceId, agentCompatible: sourceId !== 'image-only' }));
    const state = {
      models, isBusy: false, manualToolApproval: false, selectedSourceId: 'source-A', selectedModelId: 'same-model',
      commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'ready' },
      subagentModelSettings: { default: { mode: 'fixed', sourceId: 'source-B', modelId: 'same-model' }, profiles: {} },
      approvalReviewerSetting: { mode: 'follow-main', sourceId: '', modelId: '', error: '' }
    };
    const before = JSON.stringify(state.subagentModelSettings);
    const context = {
      state, Element: ApprovalMenuElement, HTMLElement: ApprovalMenuElement,
      document: { createElement: () => new ApprovalMenuElement(), getElementById: (id: string) => list.descendants().find(el => el.id === id) },
      commandSubagentModelList: list, commandSubagentModelListOpen: true, commandSubagentModelProfile: '',
      commandSubagentModelValue: null, commandSubagentModelSwitch: null, commandSubagentModelDescription: null,
      commandMenuOpen: true, commandMenu: list, commandModelSwitch: null, commandModelListOpen: false,
      renderCommandMenu: () => {}, setComposerStatus: () => {}, t: (key: string) => labels[key],
      normalizeSettingsProvider: (provider: string) => provider, getModelProtocolLogoUri: () => '',
      vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) }
    };
    const api = new Script(modelControlsRenderFragment.source + modelControlsLockingFragment.source + modelControlsHelpersFragment.source
      + commandMenuImplementationFragment.source + bindings + '\n({ renderCommandSubagentModel, handleCommandMenuKeydown });').runInNewContext(context) as {
        renderCommandSubagentModel(): void;
        handleCommandMenuKeydown(event: { target: ApprovalMenuElement; key: string; preventDefault(): void }): void;
      };
    context.renderCommandMenu = api.renderCommandSubagentModel;
    const render = api.renderCommandSubagentModel;
    const profileButton = (profile: string) => list.querySelector('button[data-subagent-profile="' + profile + '"]')!;
    const options = () => list.descendants().filter(el => el.dataset.subagentModelProfile === 'approval');
    render();
    assert.deepEqual(list.children.map(row => row.children[1].dataset.subagentProfile), ['default', 'research', 'review', 'proposal', 'approval']);
    assert.equal(profileButton('approval').parent?.children[0].textContent, labels.approvalModelTitle);
    assert.equal(profileButton('approval').className, profileButton('research').className);
    assert.match(profileButton('approval').attributes['aria-label'], /source-A/u, 'approval follows main, never the subagent default');
    list.dispatchClick(profileButton('approval'));
    assert.equal(posted.length, 0, 'expanding a row never opens a native picker or saves settings');
    assert.equal(profileButton('approval').focused, true);
    assert.equal(options().length, 3, 'follow-main plus two compatible account/model choices');
    assert.equal(options()[0].attributes['aria-checked'], 'true');
    list.dispatchClick(options().find(el => el.dataset.sourceId === 'source-B')!);
    assert.deepEqual(posted.pop(), { type: 'setApprovalModel', mode: 'fixed', sourceId: 'source-B', modelId: 'same-model' });
    assert.equal(context.commandSubagentModelProfile, '');
    assert.equal(profileButton('approval').focused, true);
    state.approvalReviewerSetting = { mode: 'fixed', sourceId: 'source-B', modelId: 'same-model', error: '' };
    render();
    api.handleCommandMenuKeydown({ target: profileButton('approval'), key: 'ArrowRight', preventDefault() {} });
    assert.equal(options()[0].focused, true);
    assert.deepEqual(options().filter(el => el.attributes['aria-checked'] === 'true').map(el => el.dataset.sourceId), ['source-B']);
    api.handleCommandMenuKeydown({ target: options()[0], key: 'ArrowLeft', preventDefault() {} });
    assert.equal(context.commandSubagentModelProfile, '');
    assert.equal(profileButton('approval').focused, true);
    list.dispatchClick(profileButton('approval'));
    list.dispatchClick(options()[0]);
    assert.deepEqual(posted.pop(), { type: 'setApprovalModel', mode: 'follow-main' });
    list.dispatchClick(profileButton('review'));
    list.dispatchClick(list.descendants().find(el => el.dataset.subagentModelProfile === 'review' && el.dataset.subagentModelMode === 'follow-main')!);
    assert.deepEqual(posted.pop(), { type: 'setSubagentModel', mode: 'follow-main', profile: 'review' });
    assert.equal(JSON.stringify(state.subagentModelSettings), before);
    state.approvalReviewerSetting = { mode: 'invalid', sourceId: '', modelId: '', error: labels.approvalModelUnavailable };
    context.commandSubagentModelProfile = 'approval'; render();
    assert.equal(options().filter(el => el.attributes['aria-checked'] === 'true').length, 0);
    assert.equal(list.descendants().find(el => el.id === 'commandApprovalModelValue')?.textContent, labels.approvalModelUnavailable);
    for (const patch of [{ isBusy: true }, { manualToolApproval: true },
      { commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'loading' } }]) {
      Object.assign(state, { isBusy: false, manualToolApproval: false, commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'ready' } }, patch);
      render();
      assert.equal(profileButton('approval').disabled, true);
      assert.ok(options().every(option => option.disabled));
      list.dispatchClick(options()[0]);
      assert.equal(posted.length, 0);
    }
  }
});

class ApprovalMenuElement {
  children: ApprovalMenuElement[] = [];
  parent?: ApprovalMenuElement;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  disabled = false;
  id = '';
  type = '';
  className = '';
  focused = false;
  tabIndex = 0;
  textContent = '';
  title = '';
  classList = { toggle: () => {} };
  private onClick?: (event: { target: ApprovalMenuElement; preventDefault(): void; stopPropagation(): void }) => void;
  set innerHTML(_value: string) { this.children = []; }
  append(...children: ApprovalMenuElement[]) {
    children.forEach(child => { child.parent = this; });
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(_type: string, listener: NonNullable<ApprovalMenuElement['onClick']>) { this.onClick = listener; }
  dispatchClick(target: ApprovalMenuElement) { this.onClick?.({ target, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.focused = true; }
  getClientRects() { return [{}]; }
  descendants(): ApprovalMenuElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(target: ApprovalMenuElement) { return this === target || this.descendants().includes(target); }
  matches(selector: string): boolean {
    const match = selector.match(/^button\[data-([\w-]+)(?:="([^"]+)")?\]$/u);
    if (!match) return false;
    const key = match[1].replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    return this.type === 'button' && this.dataset[key] !== undefined && (match[2] === undefined || this.dataset[key] === match[2]);
  }
  querySelector(selector: string) { return this.descendants().find(el => el.matches(selector)); }
  querySelectorAll(_selector: string) { return this.descendants().filter(el => el.type === 'button' && !el.disabled); }
  closest(selector: string): ApprovalMenuElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
}

test('delegated validation is authorized without a dialog; unknown tools remain denied', async () => {
  vscode.workspace.isTrusted = true;
  const service = new ToolAuthorizationService();
  const policy = { ...service.createRunPolicy('r'), approvalMode: 'delegate' as const, mediumRiskPolicy: 'ask' as const };
  const approved = await service.authorize({ policy, toolName: RUN_VALIDATION_TOOL_NAME, args: { script: 'test' }, language: 'en' });
  assert.equal(approved.allowed, true);
  assert.equal(approved.source, 'delegated_approver');
  const unknown = await service.authorize({ policy, toolName: 'unknown', args: {}, language: 'en' });
  assert.equal(unknown.allowed, false);
});

test('ask mode requests approval for each validation even with prior grants and always configuration', async () => {
  const window = vscode.window as unknown as { showInformationMessage?: (...args: unknown[]) => Promise<string> };
  const original = window.showInformationMessage;
  let prompts = 0;
  window.showInformationMessage = async () => { prompts++; return 'Allow once'; };
  try {
    const service = new ToolAuthorizationService();
    const policy = { ...service.createRunPolicy('r'), approvalMode: 'ask' as const, mediumRiskPolicy: 'always' as const };
    for (let i = 0; i < 2; i++) {
      const decision = await service.authorize({ policy, toolName: RUN_VALIDATION_TOOL_NAME, args: { script: 'compile' }, language: 'en' });
      assert.equal(decision.source, 'explicit_confirmation');
    }
    assert.equal(prompts, 2);
  } finally {
    if (original) window.showInformationMessage = original;
    else delete window.showInformationMessage;
  }
});

test('delegation does not grant external file access, even in trusted runs', () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setDelegatedFileAuthorization(true);
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setAuthorizedExternalReferenceUris([]);
    service.setDelegatedFileAuthorization(false);
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setDelegatedFileAuthorization(true);
    vscode.workspace.isTrusted = false;
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

test('reviewer cannot grant external access; explicit reference grants only the exact URI', async () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    const external = await service.inspectExternalRead('/external/reviewed.txt');
    assert.equal(external?.authorized, false);
    const reviewed = external?.uri;
    assert.equal(reviewed, vscode.Uri.file('/external/reviewed.txt').toString());
    assert.throws(() => service.authorizeReviewedExternalUri(reviewed!), /explicit user/u);
    service.setAuthorizedExternalReferenceUris([reviewed!]);
    assert.equal(service.resolveTargetUri('/external/reviewed.txt').toString(), reviewed);
    assert.throws(() => service.resolveTargetUri('/external/sibling.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

test('delegated workflow applies edits, executes commands, and continues exactly once with real results', async () => {
  const fixture = workflowFixture();
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'command:d1', 'command:d2', 'continue']);
  assert.match(fixture.prompts[0], /"applied":true/u);
  assert.equal(fixture.queue.take('s'), undefined);
});

test('revocation during an edit prevents all subsequent edits, commands and continuation', async () => {
  const fixture = workflowFixture();
  fixture.onEdit = () => { fixture.session.approvalMode = 'ask'; fixture.queue.cancel(); };
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1']);
});

test('failed apply stops dependent commands and retains failure evidence without a model call', async () => {
  const fixture = workflowFixture();
  fixture.failEdit = true;
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'stopped']);
  assert.match(fixture.prompts[0], /file changed/u);
  assert.match(fixture.prompts[0], /"applied":false/u);
});

test('failed command prevents later commands; Stop prevents continuation', async () => {
  const fixture = workflowFixture();
  fixture.onCommand = () => { fixture.queue.cancel(); };
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'command:d1']);
});

test('ask mode does not consume delegated effects even if a stale batch exists', async () => {
  const fixture = workflowFixture();
  fixture.session.approvalMode = 'ask';
  await fixture.run();
  assert.deepEqual(fixture.effects, []);
});

test('ask mode retires malformed argv without treating independent later checks as dependencies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-ask-correction-'));
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  const store = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never);
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'fixture' }];
    vscode.workspace.isTrusted = true;
    const drafts = await Promise.all([
      createDraftRunProposal({ executable: 'git', args: ['add', '--all', '.'], reason: 'Stage' }),
      createDraftRunProposal({ executable: 'git', args: ['commit', '-a', '-m', 'Title', 'stray'], reason: 'Commit' }),
      createDraftRunProposal({ executable: 'git', args: ['status', '--porcelain=v1'], reason: 'Verify' })
    ]);
    store.addProposals({ proposals: drafts, agentRunId: 'r', sessionId: 's' });
    const f = workflowFixture({ mode: 'ask', runStore: store });
    await f.provider.markAskDraftRunCorrections(f.session, 'r', 'r', drafts.map(draft => draft.id));
    assert.equal(store.get(drafts[0].id)?.status, 'pending');
    assert.equal(store.get(drafts[1].id)?.status, 'needs_replan');
    assert.equal(store.get(drafts[1].id)?.replan?.executed, false);
    assert.equal(store.get(drafts[2].id)?.dependency, undefined);
    assert.equal(store.get(drafts[2].id)?.status, 'pending');
    assert.deepEqual(f.effects, []);
  } finally {
    await store.flush(); store.dispose();
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
});

test('model denial leaves a DraftEdit pending and records guidance without another model call', async () => {
  const fixture = workflowFixture({ mode: 'delegate', denyTarget: 'e1' });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.match(fixture.prompts[0] ?? '', /denied by the configured reviewer/iu);
  assert.match(fixture.prompts[0] ?? '', /materially safer (?:new )?action/u);
});

test('model denial never spawns a DraftRun', async () => {
  const fixture = workflowFixture({ mode: 'delegate', denyTarget: 'd1', editIds: [], draftRunIds: ['d1'] });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.match(fixture.prompts[0] ?? '', /"decision":"deny"/u);
});

test('reviewer unavailability freezes every remaining effect in the batch', async () => {
  const fixture = workflowFixture({ mode: 'delegate', unavailableBeforeEffects: true });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0], /reviewer unavailable/u);
});

test('an interrupted Git correction stays stopped without replaying a restored draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-correction-recovery-'));
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  const workspace = vscode.Uri.file(path.join(root, 'repo'));
  const storage = vscode.Uri.file(path.join(root, 'storage')) as never;
  let launches = 0;
  const executor = { execute: async () => {
    launches++;
    return { exitCode: 0, timedOut: false, cancelled: false };
  }, cancel: () => false, showTerminal: () => false, dispose: () => {} };
  const store = new DraftRunStore(storage, executor);
  const reloaded = new DraftRunStore(storage, executor);
  try {
    execFileSync('git', ['init', '--template=', workspace.fsPath], { stdio: 'pipe' });
    for (const [key, value] of [['commit.gpgsign', 'false'], ['core.fsmonitor', 'false'], ['core.hooksPath', '.git/hooks']]) {
      execFileSync('git', ['config', '--local', key, value], { cwd: workspace.fsPath, stdio: 'pipe' });
    }
    vscode.workspace.workspaceFolders = [{ uri: workspace, name: 'fixture' }];
    vscode.workspace.isTrusted = true;
    const draft = () => createDraftRunProposal({ executable: 'git', args: ['commit', '-a', '-m', 'Title', 'stray'], reason: 'Commit' });
    const first = await draft();
    store.addProposals({ proposals: [first], agentRunId: 'r', sessionId: 's' });
    const original = workflowFixture({ editIds: [], draftRunIds: [first.id], workspacePath: workspace.fsPath, runStore: store });
    original.session.messages[0].content = 'Create a local git commit.';
    let interruptedState: ChatSession['approvalProcessing'];
    original.provider.sendPrompt = async () => {
      interruptedState = structuredClone(original.session.approvalProcessing);
      original.queue.cancel();
    };
    await original.run();
    assert.equal(interruptedState?.status, 'replanning');
    assert.equal(store.get(first.id)?.status, 'needs_replan');
    await store.flush();

    await reloaded.initialize();
    const restarted = workflowFixture({ editIds: [], workspacePath: workspace.fsPath, runStore: reloaded });
    restarted.session.messages[0].content = 'Create a local git commit.';
    restarted.session.approvalProcessing = normalizeApprovalProcessing(interruptedState);
    assert.equal(restarted.queue.take('s'), undefined);
    await restarted.provider.resumeApprovalProcessing();
    assert.ok(restarted.queue.take('s'), 'explicit recovery only queues fresh preflight; it cannot execute by itself');
    assert.equal(restarted.effects.filter(effect => effect === 'continue').length, 0);
    assert.equal(restarted.session.approvalProcessing?.status, 'blocked');
    assert.equal(restarted.session.approvalProcessing?.replanKeys?.length, 1);
    assert.equal(reloaded.get(first.id)?.replan?.executed, false);
    assert.equal(launches, 0);
  } finally {
    await store.flush(); await reloaded.flush();
    store.dispose(); reloaded.dispose();
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
});

test('model denial of a deletion leaves the exact file unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-model-delete-denial-'));
  const target = path.join(root, 'keep.ts');
  const folders = vscode.workspace.workspaceFolders;
  try {
    await writeFile(target, 'preserve these bytes\n', 'utf8');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'workspace' }];
    const fixture = workflowFixture({
      mode: 'delegate',
      denyTarget: 'e1',
      editIds: ['e1'],
      draftRunIds: [],
      deleteOnApplyPath: target
    });
    await fixture.run();
    assert.deepEqual(fixture.effects, ['stopped']);
    assert.equal(await readFile(target, 'utf8'), 'preserve these bytes\n');
  } finally {
    vscode.workspace.workspaceFolders = folders;
    await rm(root, { recursive: true, force: true });
  }
});

function workflowFixture(options: {
  mode?: ApprovalMode;
  denyTarget?: string;
  editIds?: string[];
  draftRunIds?: string[];
  deleteOnApplyPath?: string;
  unavailableBeforeEffects?: boolean;
  workspacePath?: string;
  runStore?: DraftRunStore;
} = {}) {
  const queue = new DelegatedApprovalQueue();
  const userTask = { version: 1, id: 'r', originMessageId: 'u', reason: 'user' };
  const session = { id: 's', approvalMode: options.mode ?? 'delegate', approvalProcessing: undefined as ChatSession['approvalProcessing'], messages: [{
    id: 'u', role: 'user', content: 'Prepare the requested workspace changes and run their commands.', createdAt: '', userTask
  }, {
    id: 'assistant', role: 'assistant', content: '', createdAt: '',
    userTask,
    runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: { taskId: 'r' } }
  }] };
  const fixture = {
    queue, session, effects: [] as string[], prompts: [] as string[], failEdit: false,
    onEdit: () => {}, onCommand: () => {}, run: async () => {}
  };
  const reviews = new Map<string, Record<string, unknown>>();
  let reviewSequence = 0;
  const makeReview = (request: Record<string, unknown>) => {
    const reviewId = `review-${++reviewSequence}`;
    const record = {
      reviewId,
      runtimeId: 'runtime',
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: 1,
      approvalSource: Boolean(options.denyTarget) ? 'auto_approval_review' : 'host_policy',
      reviewerSourceId: Boolean(options.denyTarget) ? 'review-source' : '',
      reviewerModelId: Boolean(options.denyTarget) ? 'review-model' : '',
      reviewerProvider: Boolean(options.denyTarget) ? 'openai-responses' : 'host_policy',
      decision: request.targetId === options.denyTarget ? 'deny' : 'approve',
      risk: request.targetId === options.denyTarget ? 'high' : 'low',
      rationale: request.targetId === options.denyTarget
        ? 'Denied by the configured reviewer.'
        : 'Approved for this exact operation.',
      policyRules: [request.targetId === options.denyTarget ? 'least_privilege' : 'direct_user_goal'],
      createdAt: new Date().toISOString()
    };
    reviews.set(reviewId, record);
    return record;
  };
  const edit = (id: string) => options.deleteOnApplyPath
    ? createDeleteDraftEdit({
        id, uri: vscode.Uri.file(options.deleteOnApplyPath).toString(), label: path.basename(options.deleteOnApplyPath),
        baseBytes: Buffer.from('preserve these bytes\n'), reason: `delete ${id}`
      })
    : createFullTextDraftEdit({
        id, uri: vscode.Uri.file(path.join(os.tmpdir(), id)).toString(), label: id, action: 'create',
        content: `content:${id}\n`, reason: `create ${id}`
      });
  const draftRun = (id: string) => {
    const spec = {
      executable: 'node', args: ['--version'], reason: `run ${id}`, externalCwd: false,
      cwdUri: vscode.Uri.file(os.tmpdir()).toString(), cwdLabel: os.tmpdir(), env: [], timeoutMs: 20_000
    };
    return {
    id, sessionId: 's', agentRunId: 'r', messageId: 'a', status: 'pending', executionStarted: false, executionPhase: 'not_dispatched', specHash: hashDraftRunSpec(spec), spec,
    effectAssessment: { version: 1, verdict: 'likely_readonly', effects: ['workspace_read'], evidence: [] },
    outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  };
  const provider = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    language: 'en', delegatedApprovals: queue, repairLoopsBySession: new Map(), externalEffectGrants: new ExactOperationGrants(),
    approvalCircuitBreaker: { record: () => ({ tripped: false }) },
    approvalReviews: {
      flush: async () => {},
      get: (id: string) => reviews.get(id),
      getLatestForTarget: () => undefined,
      findDenialForAction: () => undefined,
      findHardRunDenial: () => undefined
    },
    approvalReviewer: {
      createHostPolicyApproval: async (request: Record<string, unknown>) => ({ status: 'reviewed', record: makeReview(request) }),
      review: async (request: Record<string, unknown>) => ({ status: 'reviewed', record: makeReview(request) }),
      consumeApproval: async (record: Record<string, unknown>) => {
        const consumed = { ...record, consumedAt: new Date().toISOString() };
        reviews.set(String(record.reviewId), consumed);
      }
    },
    getApprovalReviewerModelContext: async () => ({ model: { id: 'model' } }),
    enterTaskWork: () => undefined,
    loadTaskBudget: async () => undefined,
    authorizedExternalReferenceUris: new Set(), authorizedExternalExecutionUris: new Set(), selectedSourceId: 'source', selectedModelId: 'model',
    sessionStore: { ...sessionUseFixture(), activeSessionId: 's', getActiveSession: () => session, persist: async () => {} },
    changeSets: {
      flush: async () => {},
      toWebviewState: () => [{ runId: 'r', files: ['e1', 'e2'].map((id) => ({ id, uri: 'file:///workspace/' + id, label: id, status: 'pending' })) }],
      getPendingEdit: (id: string) => ({ edit: edit(id), runId: 'r', sessionId: 's' }),
      preflightEdit: async () => ({ originalText: '' }),
      attachApprovalReview: () => true,
      discardEdit: () => true,
      applyEdit: async (id: string, approval: { isAuthorized: () => boolean }) => {
        assert.equal(approval.isAuthorized(), true);
        fixture.effects.push('edit:' + id); fixture.onEdit();
        if (options.deleteOnApplyPath) await rm(options.deleteOnApplyPath);
        return { appliedEditIds: fixture.failEdit ? [] : [id], failed: fixture.failEdit ? [{ error: 'file changed' }] : [] };
      }
    },
    draftRuns: options.runStore ?? {
      flush: async () => {},
      get: (id: string) => draftRun(id),
      preflightApproval: async (id: string) => draftRun(id),
      setPendingDependency: () => true,
      markNotExecuted: () => true,
      getRunsForSegments: () => (options.draftRunIds ?? ['d1', 'd2']).map(draftRun),
      attachApprovalReview: () => true,
      approveAndRun: async (id: string, uris: Set<string>, options: { delegatedApproval: () => boolean }) => {
        assert.equal(options.delegatedApproval(), true);
        assert.equal(uris.size, 0);
        fixture.effects.push('command:' + id); fixture.onCommand();
        return { status: 'done' };
      }
    },
    postState: () => {}, setAgentActivity: () => {}, refreshSkills: async () => {}, awaitRunContextRefresh: async () => true, scheduleRunContextRefresh: () => {}, handleAppliedRepairEdits: async () => {},
    sendPrompt: async (prompt: string) => { fixture.effects.push('continue'); fixture.prompts.push(prompt); return {}; },
    appendStoppedApprovalOutcome: async (prompt: string) => { fixture.effects.push('stopped'); fixture.prompts.push(prompt); }
  }) as { executeDelegatedApprovals(next: NonNullable<ReturnType<DelegatedApprovalQueue['take']>>): Promise<void>;
    resumeApprovalProcessing(): Promise<void>; sendPrompt(prompt: string): Promise<unknown>;
    markAskDraftRunCorrections(chat: typeof session, segmentId: string, rootTaskId: string, ids: string[]): Promise<void> };
  fixture.run = async () => {
    vscode.workspace.isTrusted = true;
    const priorFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(options.workspacePath ?? os.tmpdir()), name: 'test' }];
    queue.enqueue({
      sessionId: 's',
      runId: 'r',
      editIds: options.editIds ?? ['e1', 'e2'],
      draftRunIds: options.draftRunIds ?? ['d1', 'd2'],
      continueAfterApprovalReview: options.unavailableBeforeEffects || undefined,
      approvalStopReason: options.unavailableBeforeEffects ? 'reviewer unavailable' : undefined,
      approvalReviews: options.unavailableBeforeEffects ? [{
        reviewId: 'review-unavailable', sessionId: 's', rootTaskId: 'r', agentRunId: 'r', targetId: 'validation',
        actionKind: 'validation_run', policyVersion: 1, approvalSource: 'auto_approval_review', reviewerSourceId: '',
        reviewerModelId: '', reviewerProvider: '', decision: 'unavailable', risk: 'high', rationale: 'reviewer unavailable',
        createdAt: new Date().toISOString()
      }] : undefined
    });
    try { await provider.executeDelegatedApprovals(queue.take('s')!); }
    finally { vscode.workspace.workspaceFolders = priorFolders; }
  };
  return Object.assign(fixture, { provider });
}

function storedSession(id: string, approvalMode: unknown) {
  return {
    id,
    title: id,
    messages: [],
    approvalMode,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function hashBytes(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
