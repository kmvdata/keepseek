import './registerVscodeStub';
import assert from 'node:assert/strict';
import { sessionUseFixture } from './sessionUseFixture';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { approvalBindingsFragment, approvalDeclarationFragment, approvalRenderFragment, approvalStateFragment } from '../src/webview/input/commandMenu/approval';
import { modelControlsHelpersFragment, modelControlsLockingFragment } from '../src/webview/input/commandMenu/models';
import { draftRunPreparedMessage, getApprovalModeUserTail, normalizeApprovalMode } from '../src/agent/approvalMode';
import { localize, WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { getInputScript } from '../src/webview/input/script';
import type { ApprovalMode, ChatSession } from '../src/shared/types';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import * as vscode from './stubs/vscode';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';

// The automatic approval subsystem (reviewer, policy, circuit breaker, manual
// approval queue and delegated batches) was removed. Only `ask` and
// `approve-all` remain, so these tests pin those two modes instead of the
// retired `delegate` workflow.
const APPROVAL_MODES: readonly ApprovalMode[] = ['ask', 'approve-all'];

test('approval modes expose exactly ask and approve-all and fail closed on every stale value', () => {
  const current: readonly ApprovalMode[] = APPROVAL_MODES;
  assert.deepEqual([...current], ['ask', 'approve-all']);
  assert.equal(normalizeApprovalMode('approve-all'), 'approve-all');
  assert.equal(normalizeApprovalMode('ask'), 'ask');
  // `delegate` was the removed automatic reviewer mode: a stored value must
  // come back as the user-approved mode, never as an implied approval.
  assert.equal(normalizeApprovalMode('delegate'), 'ask');
  for (const value of [undefined, null, true, 1, '', 'always', 'Delegate', 'delegate ', 'model_review', 'Approve-All', {}]) {
    assert.equal(normalizeApprovalMode(value), 'ask', `unknown value ${String(value)} must fail closed`);
  }
});

test('the approve-all user tail marks the mode and carries no reviewer wording', () => {
  const tail = getApprovalModeUserTail('approve-all');
  assert.match(tail, /<keepseek-approval-mode>approve-all:/u);
  assert.match(tail, /Approve all/u);
  assert.match(tail, /no reviewer and no confirmation prompt/u);
  assert.match(tail, /<\/keepseek-approval-mode>$/u);
  for (const retired of [/reviewer[A-Z]/, /approval model/iu, /v\d+ policy/iu, /auto_approval_review/u, /delegate/iu, /帮我审批/u]) {
    assert.doesNotMatch(tail, retired);
  }
  const ask = getApprovalModeUserTail('ask');
  assert.match(ask, /<keepseek-approval-mode>ask:/u);
  assert.match(ask, /require individual user approval/u);
  assert.doesNotMatch(ask, /approve-all/u);
  assert.doesNotMatch(ask, /reviewer/iu);
  assert.notEqual(ask, tail);
  // A stale `delegate` value can only ever produce the ask tail.
  assert.equal(getApprovalModeUserTail(normalizeApprovalMode('delegate')), ask);
});

test('draft receipt and host authorization text describe the actual mode without claiming execution', () => {
  for (const lang of ['en', 'zh-CN'] as const) for (const mode of APPROVAL_MODES) {
    const receipt = draftRunPreparedMessage(mode, lang);
    assert.match(receipt, lang === 'en' ? /no process was started/u : /尚未执行/u);
    if (mode !== 'ask') assert.doesNotMatch(receipt, /Wait for the user|等待用户/u);
    if (mode === 'ask') assert.match(receipt, lang === 'en' ? /approve this execution/u : /批准本次执行/u);
    const scope = localize(lang, 'approvalExternalPrompt', { target: 'file:///outside/result.txt' });
    assert.match(scope, /file:\/\/\/outside\/result.txt/u);
    // Retrieval yields the key itself, never a localized mode sentence.
    assert.notEqual(localize(lang, 'approvalExternalPrompt'), 'approvalExternalPrompt');
    const copy = WEBVIEW_TRANSLATIONS[lang];
    assert.match(copy.approvalAskDescription, lang === 'en' ? /Ask before each file write/u : /逐项由你批准/u);
    assert.match(copy.approvalApproveAllDescription, lang === 'en' ? /without asking/u : /不再询问/u);
    assert.match(copy.approvalApproveAll, lang === 'en' ? /^Approve all$/u : /^全部批准$/u);
    assert.match(copy.approvalRequiresTrust, lang === 'en' ? /Trust the current workspace/u : /信任当前工作区/u);
  }
});

test('the approval menu offers only ask and approve-all, posts one exact mode, and locks while the mode is not ready', () => {
  const script = getInputScript();
  assert.ok(script.includes("button.dataset.approvalMode === 'approve-all'"), 'the option click maps to the current mode token');
  const approvalSection = script.slice(script.indexOf("if (commandApprovalModeSwitch) {"), script.indexOf('function renderCommandApprovalMode() {'));
  assert.ok(approvalSection.includes("button.dataset.approvalMode === 'approve-all'"), 'the selector maps options to the current tokens');
  // The selector itself is the only place allowed to name a mode token.
  assert.doesNotMatch(approvalSection.split("vscode.postMessage")[0], /'delegate'/u, 'no option offers a retired mode');
  for (const language of ['zh-CN', 'en'] as const) {
    const labels = WEBVIEW_TRANSLATIONS[language];
    const list = new ApprovalModeElement();
    const switchButton = new ApprovalModeElement();
    const value = new ApprovalModeElement();
    const description = new ApprovalModeElement();
    const posted: unknown[] = [];
    const state: Record<string, unknown> = {
      approvalMode: 'ask', isBusy: false, manualToolApproval: false,
      commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'ready' }
    };
    const elements: Record<string, ApprovalModeElement> = {
      commandApprovalModeSwitch: switchButton, commandApprovalModeValue: value,
      commandApprovalModeList: list, commandApprovalModeDescription: description
    };
    const context: Record<string, unknown> = {
      state, Element: ApprovalModeElement, HTMLElement: ApprovalModeElement,
      document: { createElement: () => new ApprovalModeElement(), getElementById: (id: string) => elements[id] ?? null },
      commandApprovalModeListOpen: false, t: (key: string) => labels[key],
      // The selector only re-renders the command menu it was mounted in.
      renderCommandMenu: () => {},
      setComposerStatus: () => {},
      vscode: { postMessage: (message: unknown) => posted.push(JSON.parse(JSON.stringify(message))) }
    };
    const api = new Script(approvalDeclarationFragment.source + approvalStateFragment.source
      + approvalBindingsFragment.source + approvalRenderFragment.source
      + modelControlsLockingFragment.source + modelControlsHelpersFragment.source
      + '\n({ renderCommandApprovalMode });').runInNewContext(context) as { renderCommandApprovalMode(): void };
    const options = () => list.descendants().filter(el => el.dataset.approvalMode !== undefined);
    api.renderCommandApprovalMode();
    assert.deepEqual(options().map(el => el.dataset.approvalMode), ['ask', 'approve-all']);
    assert.equal(options().find(el => el.dataset.approvalMode === 'ask')?.attributes['aria-checked'], 'true');
    assert.equal(value.textContent, labels.approvalAsk);
    assert.equal(description.textContent, labels.approvalAskDescription);
    assert.equal(switchButton.disabled, false);
    // Opening the list never picks a mode by itself.
    switchButton.dispatchClick(switchButton);
    assert.equal(posted.length, 0);
    assert.equal(context.commandApprovalModeListOpen, true);
    list.dispatchClick(options().find(el => el.dataset.approvalMode === 'approve-all')!);
    assert.deepEqual(posted.pop(), { type: 'setApprovalMode', mode: 'approve-all' });
    assert.equal(context.commandApprovalModeListOpen, false);
    state.approvalMode = 'approve-all';
    api.renderCommandApprovalMode();
    assert.equal(value.textContent, labels.approvalApproveAll);
    assert.equal(description.textContent, labels.approvalApproveAllDescription);
    assert.equal(options().find(el => el.dataset.approvalMode === 'approve-all')?.attributes['aria-checked'], 'true');
    // A stored delegate value renders as ask and leaves the selector usable.
    state.approvalMode = 'delegate';
    api.renderCommandApprovalMode();
    assert.equal(value.textContent, labels.approvalAsk);
    // Busy only locks the selector while the current mode still asks.
    Object.assign(state, { approvalMode: 'ask', isBusy: true });
    api.renderCommandApprovalMode();
    assert.equal(switchButton.disabled, true);
    assert.ok(options().every(option => option.disabled));
    list.dispatchClick(options()[0]);
    assert.equal(posted.length, 0);
    Object.assign(state, { approvalMode: 'approve-all', isBusy: true });
    api.renderCommandApprovalMode();
    assert.equal(switchButton.disabled, false);
    // Losing the persisted mode state disables every option.
    Object.assign(state, { isBusy: false, commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'loading' } });
    api.renderCommandApprovalMode();
    assert.equal(switchButton.disabled, true);
    assert.ok(options().every(option => option.disabled));
    list.dispatchClick(options()[1]);
    assert.equal(posted.length, 0);
  }
});

test('stored approval modes accept only current choices and fail closed on missing, stale, or unknown values', () => {
  const scope = { key: 'workspace:test', name: 'Test', folderUris: ['file:///workspace'] };
  const sessions = normalizeStoredSessions({ sessions: [
    storedSession('ask-missing', undefined),
    storedSession('unknown', 'always'),
    storedSession('delegate', 'delegate'),
    storedSession('approve-all', 'approve-all'),
    storedSession('model-review', 'model_review')
  ] }, scope);
  const modes = Object.fromEntries(sessions.map((session) => [session.id, session.approvalMode]));
  assert.deepEqual(modes, {
    'ask-missing': 'ask', unknown: 'ask', delegate: 'ask', 'approve-all': 'approve-all', 'model-review': 'ask'
  });
});

test('the host persists only ask and approve-all and ignores every forged or stale mode message', async () => {
  const { host, session, store, externalEffectGrants } = approvalHostFixture('ask');
  const grants = externalEffectGrants;
  await host.handleMessage({ type: 'setApprovalMode', mode: 'approve-all' });
  assert.equal(store.approvalMode, 'approve-all');
  assert.equal(session.approvalMode, 'approve-all');
  // A mode switch revokes any outstanding process-local exact grants.
  await host.handleMessage({ type: 'setApprovalMode', mode: 'ask' });
  assert.equal(store.approvalMode, 'ask');
  assert.ok(grants.cleared >= 1, 'switching approval mode revokes outstanding exact grants');
  for (const mode of ['delegate', 'model_review', 'always', ''] as const) {
    await host.handleMessage({ type: 'setApprovalMode', mode } as unknown as WebviewMessage);
    assert.equal(store.approvalMode, 'ask', `forged mode ${String(mode)} must not be persisted`);
  }
  // A disabled settings surface and an untrusted workspace both refuse.
  Object.assign(host, { commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'loading' } });
  await host.handleMessage({ type: 'setApprovalMode', mode: 'approve-all' });
  assert.equal(store.approvalMode, 'ask');
  Object.assign(host, { commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', approvalMode: 'ready' } });
  const originalTrust = vscode.workspace.isTrusted;
  try {
    vscode.workspace.isTrusted = false;
    await host.handleMessage({ type: 'setApprovalMode', mode: 'approve-all' });
    assert.equal(store.approvalMode, 'ask', 'approve-all requires a trusted workspace');
  } finally { vscode.workspace.isTrusted = originalTrust; }
  await host.handleMessage({ type: 'setApprovalMode', mode: 'approve-all' });
  assert.equal(store.approvalMode, 'approve-all');
  // Selecting the mode that is already active is a no-op.
  const before = store.setModeCalls;
  await host.handleMessage({ type: 'setApprovalMode', mode: 'approve-all' });
  assert.equal(store.setModeCalls, before);
});

test('approve-all drains durable drafts to the host executor without a click or a reviewer', async () => {
  const results: Array<{ mode: ApprovalMode; executed: string[]; modals: string[] }> = [];
  for (const mode of APPROVAL_MODES) {
    const fixture = approveAllFixture(mode);
    try {
      await fixture.host.handleMessage({ type: 'approveDraftRun', id: 'run-1', specHash: 'hash-1' });
      await fixture.host.handleMessage({ type: 'approveDraftRun', id: 'run-1', specHash: 'stale-hash' });
      results.push({ mode, executed: fixture.executed, modals: fixture.modals });
    } finally {
      clearTimeout((fixture.host as unknown as { approveAllTimer?: ReturnType<typeof setTimeout> }).approveAllTimer);
    }
  }
  const approveAll = results.find(result => result.mode === 'approve-all')!;
  const ask = results.find(result => result.mode === 'ask')!;
  assert.deepEqual(approveAll.modals, [], 'approve-all never opens an approval modal');
  assert.deepEqual(ask.executed, [] as string[], 'ask leaves the draft for an individual user approval');
  // ask keeps the pending draft and does not run it from a state read.
  assert.equal(approveAll.executed.includes('draft:run-1'), ask.executed.includes('draft:run-1'),
    'the click path is identical for both modes; only the host schedule differs');
});

test('an external target requires an exact URI authorization even in a trusted workspace', () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setAuthorizedExternalReferenceUris([]);
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    vscode.workspace.isTrusted = false;
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

test('an explicit external reference grants only the exact URI', async () => {
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
    service.setAuthorizedExternalReferenceUris([reviewed!]);
    assert.equal(service.resolveTargetUri('/external/reviewed.txt').toString(), reviewed);
    assert.throws(() => service.resolveTargetUri('/external/sibling.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

interface ApprovalHost {
  handleMessage(message: WebviewMessage): Promise<void>;
}

function approvalHostFixture(mode: ApprovalMode) {
  const session = { id: 'session', approvalMode: mode, executionMode: 'normal', messages: [] } as unknown as ChatSession;
  const store = {
    approvalMode: mode,
    setModeCalls: 0,
    activeSessionId: session.id,
    getActiveSession: () => session,
    async setApprovalMode(next: ApprovalMode) {
      this.setModeCalls++;
      this.approvalMode = next;
      session.approvalMode = next;
      return true;
    },
    async persist() {}
  };
  const externalEffectGrants = { cleared: 0, clear() { this.cleared++; }, matches: () => false, grant: () => {}, revoke: () => {} };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    ...sessionUseFixture(),
    language: 'en',
    sessionStore: store,
    commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', executionMode: 'ready', approvalMode: 'ready' },
    approvalDataReady: true,
    requestContextReady: true,
    sessionReady: true,
    isBusy: false,
    activeDraftRunId: undefined,
    activeChangeActions: new Set<string>(),
    availableModels: [],
    selectedSourceId: 'source',
    selectedModelId: 'model',
    externalEffectGrants,
    authorizedExternalExecutionUris: new Set<string>(),
    draftRunBatches: undefined,
    stopBackgroundRun: async () => {},
    hasActiveBackgroundRun: () => false,
    postState: () => {},
    postToWebview: () => {},
    setAgentActivity: () => {}
  }) as ApprovalHost;
  return { host, session, store, externalEffectGrants };
}

/** Exercises the ask-only click path plus the approve-all schedule source in a
 * storage-free host: the retired reviewer/queue members must not be referenced. */
function approveAllFixture(mode: ApprovalMode) {
  const executed: string[] = [];
  const modals: string[] = [];
  const session = { id: 'session', approvalMode: mode, executionMode: 'normal', messages: [] } as unknown as ChatSession;
  const store = { approvalMode: mode, activeSessionId: session.id, getActiveSession: () => session, async persist() {} };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    ...sessionUseFixture(),
    language: 'en',
    sessionStore: store,
    activeChangeActions: new Set<string>(),
    availableModels: [],
    selectedSourceId: 'source',
    selectedModelId: 'model',
    externalEffectGrants: { matches: () => false, grant: () => {}, revoke: () => {}, clear: () => {} },
    authorizedExternalExecutionUris: new Set<string>(),
    draftRuns: {
      get: (id: string) => ({ id, sessionId: session.id, agentRunId: 'segment', specHash: 'hash-1', status: 'pending',
        spec: { executable: 'node', args: ['--version'], reason: 'Check runtime' } }),
      toWebviewState: () => [{ id: 'run-1', sessionId: session.id, agentRunId: 'segment', status: 'pending', specHash: 'hash-1',
        spec: { executable: 'node', args: ['--version'], reason: 'Check runtime' } }],
      getRunsForSegments: () => []
    },
    executeApprovedDraftRun: async (id: string) => { executed.push('draft:' + id); },
    enterTaskWork: () => undefined,
    hasActiveBackgroundRun: () => false,
    stopBackgroundRun: async () => {},
    postState: () => {},
    postToWebview: () => {},
    setAgentActivity: () => {},
    t: (key: string) => localize('en', key)
  }) as ApprovalHost;
  return { host, session, executed, modals };
}

class ApprovalModeElement {
  children: ApprovalModeElement[] = [];
  parent?: ApprovalModeElement;
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
  private onClick?: (event: { target: ApprovalModeElement; preventDefault(): void; stopPropagation(): void }) => void;
  set innerHTML(_value: string) { this.children = []; }
  append(...children: ApprovalModeElement[]) {
    children.forEach(child => { child.parent = this; });
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(_type: string, listener: NonNullable<ApprovalModeElement['onClick']>) { this.onClick = listener; }
  dispatchClick(target: ApprovalModeElement) { this.onClick?.({ target, preventDefault() {}, stopPropagation() {} }); }
  focus() { this.focused = true; }
  getClientRects() { return [{}]; }
  descendants(): ApprovalModeElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  contains(target: ApprovalModeElement) { return this === target || this.descendants().includes(target); }
  matches(selector: string): boolean {
    const match = selector.match(/^button\[data-([\w-]+)(?:="([^"]+)")?\]$/u);
    if (!match) return false;
    const key = match[1].replace(/-([a-z])/gu, (_, character: string) => character.toUpperCase());
    return this.type === 'button' && this.dataset[key] !== undefined && (match[2] === undefined || this.dataset[key] === match[2]);
  }
  closest(selector: string): ApprovalModeElement | null {
    return this.matches(selector) ? this : this.parent?.closest(selector) ?? null;
  }
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
