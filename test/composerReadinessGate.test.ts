import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { getScript } from '../src/webview/script';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///w/composer-gate';

/** Every field the readiness chain can freeze on, exposed for assertions. */
interface GateHost {
  initializeAfterWebviewReady(): Promise<void>;
  getStartupState(): { phase: string; interactiveReady: boolean; sideEffectsReady: boolean };
  interactionSnapshot(revision: number): {
    sessionId?: string; canSubmit?: boolean; canEdit?: boolean; phase?: string;
    waitingReason?: string; failure?: string; blockingReason?: string;
  };
  sessionStore: ChatSessionStore;
  commandSettingsReadiness: Record<string, string>;
  approvalDataReady: boolean;
  requestContextReady: boolean;
  runContextReadiness: string;
  sessionReady: boolean;
  dispose(): void;
}

function withWindow<T>(work: () => Promise<T>): Promise<T> {
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  return work().finally(() => {
    Object.assign(vscode.window, previousWindow);
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  });
}

async function startHost(root: string): Promise<GateHost> {
  const uri = vscode.Uri.file(root);
  const scope = { key: SCOPE_KEY, name: 'gate', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize({ fresh: true });
  await initialization.catch(() => undefined);
  const provider = new KeepseekChatViewProvider(
    uri as never, sessionStore, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  (provider as unknown as { views?: Set<unknown> }).views?.add({ webview: { postMessage: async () => true } });
  return provider as unknown as GateHost;
}

/** The baseline contract: a clean window on a blank conversation must end with
 * an addressable composer. If this fails, the fault is in startup convergence,
 * not in whatever the user typed. */
test('a clean startup converges on a submittable composer', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-gate-clean-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await withWindow(async () => {
    const host = await startHost(root);
    t.after(() => host.dispose());
    await host.initializeAfterWebviewReady().catch(() => undefined);

    const startup = host.getStartupState();
    const snapshot = host.interactionSnapshot(1);
    assert.equal(host.sessionReady, true, 'the session store must have loaded');
    assert.equal(host.approvalDataReady, true, 'recovery stores must verify');
    assert.equal(host.requestContextReady, true, 'request context must converge');
    assert.equal(startup.phase, 'ready', 'startup must not end in startup-error');
    assert.equal(snapshot.canSubmit, true, 'a ready window must be able to send');
    assert.equal(snapshot.sessionId, host.sessionStore.activeSessionId, 'the composer owns the active session');
  });
});

/** The known fatal race: user clicks a sidebar conversation while startup is
 * still resolving project context. The click bumps `sessionContextGeneration`,
 * which makes startup's in-flight `refreshSessionSkills()` fail its ownership
 * assertion. If that is recorded as a project-context failure, the window stays
 * in `startup-error` forever and the composer never accepts a send.
 *
 * The race is produced deterministically by holding the project-source read
 * open and bumping the generation while it is genuinely in flight; bumping
 * before startup captures the generation would prove nothing. */
test('a session switch during startup does not pin the window in startup-error', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-gate-race-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await withWindow(async () => {
    const host = await startHost(root);
    t.after(() => host.dispose());
    // A conversation with history makes startup scan project context, which is
    // the stage the race corrupts. Without messages startup defers the scan and
    // there is nothing to supersede.
    host.sessionStore.getActiveSession().messages.push(
      { id: 'm-race', role: 'user', content: 'existing work', createdAt: new Date().toISOString() } as never);

    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const inFlight = new Promise<void>(resolve => { entered = resolve; });
    const controller = host as unknown as {
      sharedProjectSources: { refresh(sessionId: string, cwd?: string): Promise<unknown> };
      sessionContextGeneration: number;
    };
    const original = controller.sharedProjectSources.refresh.bind(controller.sharedProjectSources);
    controller.sharedProjectSources.refresh = async (sessionId, cwd) => {
      const value = await original(sessionId, cwd);
      entered();
      // Hold the scan open exactly where a navigation would supersede it.
      await held;
      return value;
    };

    const startup = host.initializeAfterWebviewReady();
    await inFlight;
    // The user's click: a real navigation bumps this through
    // clearSessionTransientState() before re-reading context.
    controller.sessionContextGeneration += 1;
    release();
    await startup.catch(() => undefined);

    assert.notEqual(host.getStartupState().phase, 'startup-error',
      'a superseded startup context scan is not a broken window');
    assert.equal(host.requestContextReady, true,
      'request context must still converge after the superseded scan');
    const snapshot = host.interactionSnapshot(1);
    assert.equal(snapshot.canSubmit, true, 'the composer must recover once the newer owner settles');
  });
});

/** Index just past the brace matching the one at `open`. */
function matchingBrace(source: string, open: number): number {
  assert.equal(source[open], '{');
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Slice the webview script so the real state reducer and gate functions run
 * outside a browser. The slice covers `currentInteraction` through the state
 * branch of `handleKeepseekHostMessage`, which is where a snapshot is applied. */
function loadComposerGate(initial: { sessionId: string; canSubmit: boolean }) {
  const script = getScript();
  const gateStart = script.indexOf('function currentInteraction()');
  const gateEnd = script.indexOf('function changeVisibleSession(', gateStart);
  const handlerStart = script.indexOf('function handleKeepseekHostMessage(');
  assert.ok(gateStart > 0 && gateEnd > gateStart, 'the gate functions must be locatable');
  assert.ok(handlerStart > 0, 'the state reducer must be locatable');
  // Slice the whole function by brace matching: a fixed text boundary cuts the
  // final branch in half and the snippet stops parsing.
  const handlerEnd = matchingBrace(script, script.indexOf('{', handlerStart)) + 1;
  assert.ok(handlerEnd > handlerStart, 'the reducer must be brace-balanced');

  const context: Record<string, unknown> = {
    state: { activeSessionId: initial.sessionId,
      interaction: { sessionId: initial.sessionId, canSubmit: initial.canSubmit, canNavigate: true },
      startup: { interactiveReady: true }, isBusy: false },
    pendingSubmission: null,
    submissionSequence: 0,
    editingMessageId: '',
    editingDraftText: '',
    t: (key: string) => key,
    setTransientStatus() {},
    render() {},
    renderStatus() {},
    syncSendButtonAvailability() {},
    lastStateRevision: 0,
    pendingManualApprovalIds: new Set(),
    pendingDraftRunApprovals: new Map(),
    pendingDraftRunActions: new Map(),
    pendingDraftRunBatchSnapshot: '',
    historyCleanupDeletedSessionIds: new Set(),
    historyCleanupDeletedSessionKeys: new Set(),
    window: {},
    changeVisibleSession() {},
    rememberTerminalAgentActivity() {},
    document: { querySelectorAll() { return []; } }
  };
  const source = script.slice(gateStart, gateEnd) + '\n' + script.slice(handlerStart, handlerEnd)
    + '\n;({ canSubmitPrompt, beginPromptSubmission, applySubmissionResult,'
    + ' applyState: function (state, revision) { return handleKeepseekHostMessage({ data: {'
    + ' type: "state", revision: revision, state: state } }); },'
    + ' snapshot: function () { return { pending: pendingSubmission }; } })';
  const gate = runInNewContext(source, context) as {
    canSubmitPrompt(): boolean;
    beginPromptSubmission(kind: string, prompt: string): string | null;
    applySubmissionResult(message: unknown): void;
    applyState(state: unknown, revision: number): void;
    snapshot(): { pending: unknown };
  };
  return { gate, context };
}

/** `pendingSubmission` locks the composer until a matching result arrives. A
 * lost reply — an ignored request, a superseded snapshot — would otherwise lock
 * the input box for the rest of the window's life, which is the reported
 * "not ready, draft kept" symptom that never clears. A newer snapshot proving
 * the same session is submittable is enough to release the stale latch. */
test('a pending submission is released when the window becomes submittable again', () => {
  const { gate, context } = loadComposerGate({ sessionId: 's1', canSubmit: true });
  assert.equal(gate.canSubmitPrompt(), true, 'the gate starts open');

  const requestId = gate.beginPromptSubmission('composer', 'hello');
  assert.ok(requestId, 'a submittable composer must produce a submission');
  assert.equal(gate.canSubmitPrompt(), false, 'a submission in flight blocks a second one');

  // The host answered nothing; only a newer ready snapshot arrives.
  gate.applyState({ activeSessionId: 's1', interaction: { sessionId: 's1', canSubmit: true } }, 2);
  assert.equal(gate.snapshot().pending, null,
    'a ready state for the same session must release the stuck submission');
  assert.equal(gate.canSubmitPrompt(), true, 'input must be usable again without a manual reload');
  assert.equal((context.state as { activeSessionId: string }).activeSessionId, 's1');
});

/** A snapshot that still says "busy" must not release the latch: the send is
 * genuinely in flight and the host has not answered yet. */
test('a still-busy snapshot keeps the pending latch', () => {
  const { gate } = loadComposerGate({ sessionId: 's1', canSubmit: true });
  assert.ok(gate.beginPromptSubmission('composer', 'hello'));
  gate.applyState({ activeSessionId: 's1', interaction: { sessionId: 's1', canSubmit: false } }, 2);
  assert.notEqual(gate.snapshot().pending, null, 'a busy snapshot is not proof the send settled');
});

/** A rejected result still clears the latch: the draft stays and the reason is
 * shown, which is the contract the host's rejected branch relies on. */
test('a rejected submission result releases the pending latch', () => {
  const { gate } = loadComposerGate({ sessionId: 's1', canSubmit: true });
  const requestId = gate.beginPromptSubmission('composer', 'hello');
  assert.ok(requestId);
  gate.applySubmissionResult({ requestId, sessionId: 's1', status: 'rejected', reason: 'not ready' });
  assert.equal(gate.snapshot().pending, null);
  assert.equal(gate.canSubmitPrompt(), true);
});

/** A result for another session must not clear this session's latch. */
test('a submission result for another session never clears the latch', () => {
  const { gate } = loadComposerGate({ sessionId: 's1', canSubmit: true });
  const requestId = gate.beginPromptSubmission('composer', 'hello');
  assert.ok(requestId);
  gate.applySubmissionResult({ requestId, sessionId: 's2', status: 'accepted' });
  assert.notEqual(gate.snapshot().pending, null, 'another session cannot settle this submission');
});

/** Each gate that can hold the composer closed must be individually visible, so
 * a blocked window can be diagnosed instead of guessed at. The diagnostic is
 * read-only display state: it never enters the prompt or persistence. */
test('a blocked composer names the exact gate holding it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-gate-diag-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await withWindow(async () => {
    const host = await startHost(root);
    t.after(() => host.dispose());
    await host.initializeAfterWebviewReady().catch(() => undefined);
    const provider = host as unknown as { getComposerReadinessDiagnostics(): {
      canSubmit: boolean; gates: Record<string, boolean>; runContextReadiness: string; startupPhase: string;
    } };
    const ready = provider.getComposerReadinessDiagnostics();
    assert.equal(ready.canSubmit, true);
    // `composerProjected` is the pre-load placeholder projection (false once the
    // real session is loaded) and `interactionFailed`/`runContextRefreshFailed`
    // are negative gates. Only the positive gates decide availability.
    const positive = ['sessionReady', 'approvalDataReady', 'modelReady', 'contextReady',
      'requestContextReady', 'sessionRecoveryReady'];
    for (const gate of positive) assert.equal(ready.gates[gate], true, `${gate} must be open`);
    assert.equal(ready.gates.interactionFailed, false, 'no recorded interaction failure');
    assert.equal(ready.gates.runContextRefreshFailed, false, 'no recorded context refresh failure');
    assert.equal(ready.startupPhase, 'ready');

    // Break one gate at a time and assert the diagnostic localizes it.
    host.commandSettingsReadiness.mainModel = 'error';
    const modelBroken = provider.getComposerReadinessDiagnostics();
    assert.equal(modelBroken.canSubmit, false);
    assert.equal(modelBroken.gates.modelReady, false, 'the model gate is the named failure');
    assert.equal(modelBroken.gates.approvalDataReady, true, 'unrelated gates stay green');
    assert.equal(modelBroken.gates.sessionReady, true);

    host.commandSettingsReadiness.mainModel = 'ready';
    host.approvalDataReady = false;
    const recoveryBroken = provider.getComposerReadinessDiagnostics();
    assert.equal(recoveryBroken.gates.approvalDataReady, false);
    assert.equal(recoveryBroken.gates.modelReady, true);
    assert.equal(recoveryBroken.canSubmit, false);
  });
});