import * as assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import * as vscode from './stubs/vscode';
import { DraftRunBatchCoordinator } from '../src/runs/draftRunBatchCoordinator';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { getConfiguredDraftRunMaxTranscriptBytes } from '../src/shared/config';
import { analyzeDraftRunEffects } from '../src/approvals/authorization';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { getScript } from '../src/webview/script';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import type { DraftRunExecutorAdapter, DraftRunExecutionOutcome } from '../src/runs/draftRunExecutor';
import type { DraftRunBatchSnapshot, DraftRunProposal, DraftRunSpec, AgentResponse, ChatMessage } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const success: DraftRunExecutionOutcome = { exitCode: 0, timedOut: false, cancelled: false };
class ControlledExecutor implements DraftRunExecutorAdapter {
  calls: Parameters<DraftRunExecutorAdapter['execute']>[0][] = [];
  active = 0;
  maximum = 0;
  private gates = new Map<string, ReturnType<typeof deferred<DraftRunExecutionOutcome>>>();
  private starts = new Map<number, ReturnType<typeof deferred<void>>>();
  async execute(input: Parameters<DraftRunExecutorAdapter['execute']>[0]) {
    assert.ok(input.permit.expiresAt > Date.now(), 'a fresh permit must reach the executor');
    assert.equal(input.permit.source, 'user_click');
    assert.equal(input.permit.draftRunId, input.draftRun.id);
    assert.equal(input.permit.specHash, input.draftRun.specHash);
    this.calls.push(input); this.active++; this.maximum = Math.max(this.maximum, this.active);
    const gate = deferred<DraftRunExecutionOutcome>();
    this.gates.set(input.draftRun.id, gate);
    const abort = () => gate.resolve({ cancelled: true, timedOut: false });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.starts.get(this.calls.length)?.resolve();
    try { return await gate.promise; }
    finally { this.active--; input.signal?.removeEventListener('abort', abort); }
  }
  async started(count: number) {
    if (this.calls.length >= count) return;
    const gate = deferred<void>(); this.starts.set(count, gate); await gate.promise;
  }
  finish(id: string, outcome = success) { this.gates.get(id)!.resolve(outcome); }
  cancel(id: string) { this.gates.get(id)?.resolve({ timedOut: false, cancelled: true }); return this.gates.has(id); }
  showTerminal() { return true; }
  dispose() { for (const gate of this.gates.values()) gate.resolve({ timedOut: false, cancelled: true }); }
}

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  Object.assign(vscode.window, { showInformationMessage: async () => undefined });
  try { await run(f); }
  finally { f.batch.cancel(); f.store.dispose(); await new Promise<void>((resolve) => setImmediate(resolve)); await f.store.flush(); vscode.workspace.workspaceFolders = []; vscode.workspace.isTrusted = true; await rm(f.root, { recursive: true, force: true }); }
}
async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-batch-'));
  const workspaceRoot = path.join(root, 'workspace'); await mkdir(workspaceRoot);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'workspace' }];
  vscode.workspace.isTrusted = true;
  const executor = new ControlledExecutor();
  const storage = vscode.Uri.file(path.join(root, 'storage'));
  const store = new DraftRunStore(storage as unknown as import('vscode').Uri, executor, new DraftRunAuthorizationService());
  const changed = { fn: () => {} };
  const batch = new DraftRunBatchCoordinator(store, () => changed.fn());
  const proposal = (id: string, overrides: Partial<DraftRunSpec> = {}): DraftRunProposal => {
    const spec: DraftRunSpec = { executable: 'node', args: [id, '; literal', 'C:\\a b\\x'],
      reason: 'test ' + id, cwdUri: vscode.Uri.file(workspaceRoot).toString(), cwdLabel: '.',
      externalCwd: false, env: [{ name: 'BATCH_TEST', value: '$literal' }], timeoutMs: 120000, ...overrides };
    return { id, spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) };
  };
  const add = (ids: string[], sessionId = 's', agentRunId = 'r') => store.addProposals({
    proposals: ids.map((id) => proposal(id)), sessionId, agentRunId, messageId: 'assistant'
  });
  const accept = () => batch.accept(batch.snapshots('s').find((s) => s.agentRunId === 'r')!, { sessionId: 's', sourceId: 'source', modelId: 'model' });
  const execute = (id: string) => batch.execute(id, { authorizedUris: new Set(), assertContext: () => {}, onCurrent: () => {} });
  return { root, workspaceRoot, storage, executor, store, batch, changed, proposal, add, accept, execute };
}

test('batch executes A → B → C with one active process, fresh permits after 30s and one model continuation', async () => fixture(async (f) => {
  f.add(['z-A', 'a-B', 'm-C']);
  const id = f.accept();
  const executing = f.execute(id);
  let models = 0;
  const continuation = { assertContext: () => {}, blocker: () => undefined, send: async () => { models++; return true; } };
  await f.executor.started(1);
  await f.batch.continueOnce(continuation);
  assert.equal(models, 0);
  const firstExpiry = f.executor.calls[0].permit.expiresAt;
  const realNow = Date.now;
  Date.now = () => firstExpiry + 60000;
  try {
    f.executor.finish('z-A'); await f.executor.started(2);
    assert.equal(f.store.get('z-A')?.status, 'done');
    const persisted = JSON.parse(await readFile(path.join(f.storage.fsPath, 'draft-runs.json'), 'utf8'));
    assert.equal(persisted.draftRuns.find((r: { id: string }) => r.id === 'z-A').status, 'done');
    assert.ok(f.executor.calls[1].permit.expiresAt > firstExpiry + 60000);
    f.executor.finish('a-B'); await f.executor.started(3);
    await f.batch.continueOnce(continuation); assert.equal(models, 0);
    f.executor.calls[2].onOutput({ stream: 'stdout', text: 'x'.repeat(getConfiguredDraftRunMaxTranscriptBytes() + 1000) });
    f.executor.finish('m-C'); await executing;
  } finally { Date.now = realNow; }
  assert.equal(f.executor.maximum, 1);
  assert.deepEqual(f.executor.calls.map((call) => call.draftRun.id), ['z-A', 'a-B', 'm-C']);
  assert.equal(new Set(f.executor.calls.map((call) => call.permit.nonce)).size, 3);
  assert.deepEqual(f.executor.calls[1].draftRun.spec, f.proposal('a-B').spec);
  assert.equal(f.store.get('m-C')?.outputTruncated, true);
  await Promise.all([f.batch.continueOnce(continuation), f.batch.continueOnce(continuation)]);
  await f.batch.continueOnce(continuation);
  assert.equal(models, 1);
  const tail = f.store.getPendingProviderTail('s', 'en')!;
  f.store.bindResultsToMessage(tail.draftRunIds, 'new-user');
  f.store.bindResultsToMessage(tail.draftRunIds, 'duplicate-user');
  assert.equal(f.store.get('z-A')?.resultBoundMessageId, 'new-user');
  assert.equal(f.store.getPendingProviderTail('s', 'en'), undefined);
}));

test('batch rejects wrong sessions, runs, hashes, duplicates, reordered/stale snapshots and unseen additions', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  const snapshot = f.batch.snapshots('s')[0];
  for (const changed of [
    { ...snapshot, sessionId: 'other' }, { ...snapshot, agentRunId: 'other' },
    { ...snapshot, snapshotId: 'stale' }, { ...snapshot, entries: [...snapshot.entries].reverse() },
    { ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] },
    { ...snapshot, entries: snapshot.entries.map((item) => ({ ...item, specHash: 'changed' })) }
  ]) assert.throws(() => f.batch.accept(changed, { sessionId: 's', sourceId: 'source', modelId: 'model' }));
  f.add(['new']);
  assert.throws(() => f.batch.accept(snapshot, { sessionId: 's', sourceId: 'source', modelId: 'model' }));
  assert.equal(f.executor.calls.length, 0);
  const id = f.accept();
  assert.throws(() => f.accept());
  f.batch.cancel(id);
  const newId = f.accept(); assert.notEqual(newId, id);
  assert.equal(f.executor.calls.length, 0);
}));

test('failures and timeout in B leave C pending, without model continuation or retries', async () => {
  for (const outcome of [{ ...success, exitCode: 2 }, { ...success, timedOut: true }, { ...success, error: 'spawn error' }]) {
    await fixture(async (f) => {
      f.add(['A', 'B', 'C']); const executing = f.execute(f.accept());
      await f.executor.started(1); f.executor.finish('A');
      await f.executor.started(2); f.executor.finish('B', outcome); await executing;
      assert.equal(f.store.get('C')?.status, 'pending');
      assert.equal(f.batch.state?.phase, 'failed'); assert.equal(f.batch.state?.remaining, 1);
      await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => { assert.fail('must not continue'); } });
      assert.equal(f.executor.calls.length, 2);
    });
  }
});

test('per-command cwd validation allows a directory created by A; missing cwd stops B and leaves C pending', async () => {
  for (const create of [true, false]) await fixture(async (f) => {
    const cwd = path.join(f.workspaceRoot, 'generated');
    f.store.addProposals({ proposals: [f.proposal('A'), f.proposal('B', { cwdUri: vscode.Uri.file(cwd).toString() }), f.proposal('C')], sessionId: 's', agentRunId: 'r' });
    const executing = f.execute(f.accept()); await f.executor.started(1);
    if (create) await mkdir(cwd);
    f.executor.finish('A');
    if (create) { await f.executor.started(2); f.executor.finish('B'); await f.executor.started(3); f.executor.finish('C'); }
    await executing;
    assert.equal(f.executor.calls.length, create ? 3 : 1);
    assert.equal(f.store.get('C')?.status, create ? 'done' : 'pending');
  });
});

test('stop during execution, between commands and in final continuation persistence revokes remaining authority', async () => {
  for (const stage of ['running', 'gap', 'handoff']) await fixture(async (f) => {
    f.add(['A', 'B']); const id = f.accept();
    if (stage === 'gap') f.changed.fn = () => { if (f.batch.state?.completed === 1) f.batch.cancel(); };
    const executing = f.execute(id); await f.executor.started(1);
    if (stage === 'running') f.batch.cancel(id); else f.executor.finish('A');
    if (stage === 'handoff') { await f.executor.started(2); f.executor.finish('B'); }
    await executing;
    if (stage === 'handoff') {
      const originalFlush = f.store.flush.bind(f.store); const gate = deferred<void>();
      f.store.flush = async () => { await gate.promise; await originalFlush(); };
      const continuation = f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => { assert.fail('stop must beat dispatch'); } });
      f.batch.cancel(); gate.resolve(); await continuation;
    }
    assert.equal(f.batch.state?.phase, 'cancelled');
    if (stage !== 'handoff') { assert.equal(f.store.get('B')?.status, 'pending'); assert.equal(f.executor.calls.length, 1); }
  });
});

test('initial async persistence revalidates stop and changed snapshot; no command starts', async () => {
  for (const change of ['stop', 'add', 'clear', 'trust']) await fixture(async (f) => {
    f.add(['A', 'B']); const id = f.accept(); const gate = deferred<void>();
    const flush = f.store.flush.bind(f.store); f.store.flush = async () => { await gate.promise; await flush(); };
    const executing = f.execute(id);
    if (change === 'stop') f.batch.cancel();
    if (change === 'add') f.add(['C']);
    if (change === 'clear') f.store.clearSession('s');
    if (change === 'trust') vscode.workspace.isTrusted = false;
    gate.resolve(); await executing;
    assert.equal(f.executor.calls.length, 0);
  });
});

test('whole snapshot requires trust and exact external cwd authorization, without implicit authorization', async () => {
  for (const mode of ['trust', 'external', 'authorized']) await fixture(async (f) => {
    const external = path.join(f.root, 'external'); await mkdir(external);
    f.store.addProposals({ proposals: [f.proposal('A'), f.proposal('B', { cwdUri: vscode.Uri.file(external).toString(), cwdLabel: external, externalCwd: true })], sessionId: 's', agentRunId: 'r' });
    const id = f.accept(); if (mode === 'trust') vscode.workspace.isTrusted = false;
    const externalScript = vscode.Uri.file(path.join(await realpath(external), 'B')).toString();
    const executing = f.batch.execute(id, { authorizedUris: new Set(mode === 'authorized' ? [vscode.Uri.file(external).toString(), externalScript] : []), assertContext: () => {}, onCurrent: () => {} });
    if (mode === 'authorized') { await f.executor.started(1); f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); }
    await executing;
    assert.equal(f.executor.calls.length, mode === 'authorized' ? 2 : 0);
    if (mode !== 'authorized') assert.equal(f.store.get('A')?.status, 'pending');
  });
});

test('old cancellation and continuation flags do not block a fresh batch; clones stay outside its authorization', async () => fixture(async (f) => {
  f.add(['old', 'A', 'B']);
  const old = f.store.approveAndRun('old', new Set(), { autoContinue: true });
  await f.executor.started(1); f.executor.finish('old', { timedOut: false, cancelled: true }); await old;
  const snapshot = f.batch.snapshots('s')[0]; const id = f.accept();
  const executing = f.execute(id); await f.executor.started(2);
  const clone = f.store.cloneAsPending('old')!;
  assert.throws(() => f.batch.accept(snapshot, { sessionId: 's', sourceId: 'source', modelId: 'model' }));
  f.executor.finish('A'); await f.executor.started(3); f.executor.finish('B'); await executing;
  assert.equal(f.store.get(clone.id)?.status, 'pending');
  assert.equal(f.store.claimReadyAutoContinuation('s'), undefined);
  let sends = 0;
  const continuation = { assertContext: () => {}, blocker: () => f.store.get(clone.id)?.status === 'pending' ? 'other commands' : undefined, send: async () => { sends++; return true; } };
  await f.batch.continueOnce(continuation); assert.equal(sends, 0);
  f.store.reject(clone.id); await f.batch.continueOnce(continuation); await f.batch.continueOnce(continuation);
  assert.equal(sends, 1);
}));

test('restart keeps remaining commands pending and restores no batch/continuation; equal timestamps retain displayed order', async () => fixture(async (f) => {
  f.add(['z', 'a', 'm']);
  const executing = f.execute(f.accept()); await f.executor.started(1);
  await f.store.flush();
  const restored = new DraftRunStore(f.storage as unknown as import('vscode').Uri, new ControlledExecutor());
  try {
    await restored.initialize();
    assert.equal(restored.get('z')?.status, 'failed');
    assert.equal(restored.get('a')?.status, 'pending');
    assert.deepEqual(restored.toWebviewState('s').map((run) => run.id), ['z', 'a', 'm']);
    const queue = new DraftRunBatchCoordinator(restored);
    assert.equal(queue.pending, false); assert.equal(queue.state, undefined);
    assert.equal(restored.claimReadyAutoContinuation('s'), undefined);
  } finally { restored.dispose(); f.batch.cancel(); await executing; }
}));

type Host = {
  approveDraftRunBatch(snapshot: DraftRunBatchSnapshot): Promise<void>;
  maybeAutoContinueDraftRun(): Promise<void>;
  handleMessage(message: unknown): Promise<void>; abortPrompt(): void;
  sendPrompt(prompt: string, source: string, model: string): Promise<AgentResponse | undefined>;
  isBusy: boolean; isStartingRun: boolean; selectedModelId: string;
  activeDraftRunId?: string; repairLoopsBySession: Map<string, unknown>;
  clearSessionTransientState(): void;
};
function hostFixture(f: Awaited<ReturnType<typeof createFixture>>) {
  const session = { id: 's', approvalMode: 'ask', messages: [
    { id: 'u', role: 'user', content: 'task', createdAt: '' },
    { id: 'a', role: 'assistant', content: '', createdAt: '', runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: { taskId: 'r', status: 'completed', usedMs: 0, maxExecutionMs: 0, limitSource: '', attempt: 1, modelRequests: 1, retries: 0, steps: 0, canResume: false } } }
  ] as ChatMessage[] };
  const states = { pendingEdits: false, background: false, sends: 0 };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    draftRuns: f.store, draftRunBatches: f.batch, delegatedApprovals: new DelegatedApprovalQueue(),
    approvalDataReady: true,
    isBusy: false, isStartingRun: false, delegatedApprovalInFlight: false, draftRunAutoContinueInFlight: false,
    selectedSourceId: 'source', selectedModelId: 'model', language: 'en', agentSettings: {},
    repairLoopsBySession: new Map(), authorizedExternalReferenceUris: new Set(), authorizedExternalExecutionUris: new Set(),
    fileContext: { clear: () => {} },
    changeSets: { hasPendingForSession: () => states.pendingEdits },
    hasActiveBackgroundRun: () => states.background,
    sessionStore: { activeSessionId: 's', getActiveSession: () => session, persist: async () => {} },
    t: (key: string) => key,
    postState: () => {}, postToWebview: () => {}, setAgentActivity: () => {},
    sendPromptImpl: async () => { states.sends++; return {} as AgentResponse; }
  }) as Host;
  return { host, states, session };
}

test('Provider holds the batch lock across all commands and blocks duplicate messages, single approval and models', async () => fixture(async (f) => {
  f.add(['A', 'B', 'C']); const { host, states } = hostFixture(f);
  const immediateMembership: string[][] = [];
  Object.assign(host, { postState: (options: { immediate?: boolean } = {}) => {
    if (options.immediate) immediateMembership.push(f.batch.state!.entries.map((entry) => entry.draftRunId));
  } });
  const snapshot = f.batch.snapshots('s')[0];
  const executing = host.approveDraftRunBatch(snapshot); await f.executor.started(1);
  assert.deepEqual(immediateMembership, [['A', 'B', 'C']], 'accepted membership is published before the first command starts');
  await host.handleMessage({ type: 'approveDraftRunBatch', snapshot });
  await host.handleMessage({ type: 'approveDraftRun', id: 'B', specHash: f.store.get('B')!.specHash, autoContinue: true });
  await host.sendPrompt('new prompt', 'source', 'model');
  f.executor.finish('A'); await f.executor.started(2); assert.equal(host.isBusy, true);
  await host.maybeAutoContinueDraftRun(); assert.equal(states.sends, 0);
  f.executor.finish('B'); await f.executor.started(3); assert.equal(host.isBusy, true);
  f.executor.finish('C'); await executing;
  await Promise.all([host.maybeAutoContinueDraftRun(), host.maybeAutoContinueDraftRun()]);
  await host.maybeAutoContinueDraftRun();
  assert.equal(states.sends, 1); assert.equal(f.executor.calls.length, 3);
}));

test('Provider waits for edits, repair and background blockers, then continues only once', async () => fixture(async (f) => {
  f.add(['A', 'B']); const { host, states } = hostFixture(f);
  const executing = host.approveDraftRunBatch(f.batch.snapshots('s')[0]);
  await f.executor.started(1); f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); await executing;
  states.pendingEdits = true; await host.maybeAutoContinueDraftRun();
  assert.equal(f.batch.state?.reason, 'draftRunBatchWaitEdits'); assert.equal(states.sends, 0);
  states.pendingEdits = false; states.background = true; await host.maybeAutoContinueDraftRun();
  assert.equal(f.batch.state?.reason, 'draftRunBatchWaitBackground');
  states.background = false; host.repairLoopsBySession.set('s', { status: 'waiting_for_apply' });
  await host.maybeAutoContinueDraftRun(); assert.equal(f.batch.state?.reason, 'draftRunBatchWaitRepair');
  host.repairLoopsBySession.clear(); await host.maybeAutoContinueDraftRun(); await host.maybeAutoContinueDraftRun();
  assert.equal(states.sends, 1);
}));

test('Provider global/card stop, cleanup, real input and model changes cancel old continuation without executing commands again', async () => {
  for (const action of ['global', 'card', 'cleanup', 'input', 'model']) await fixture(async (f) => {
    f.add(['A', 'B']); const { host, states } = hostFixture(f);
    const executing = host.approveDraftRunBatch(f.batch.snapshots('s')[0]); await f.executor.started(1);
    if (action === 'global') host.abortPrompt();
    else if (action === 'card') await host.handleMessage({ type: 'cancelDraftRun', id: 'A' });
    else { f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); }
    await executing;
    if (action === 'cleanup') host.clearSessionTransientState();
    if (action === 'input') await host.sendPrompt('new user input', 'source', 'model');
    if (action === 'model') host.selectedModelId = 'different';
    await host.maybeAutoContinueDraftRun();
    assert.equal(states.sends, action === 'input' ? 1 : 0);
    assert.equal(f.executor.calls.length, ['global', 'card'].includes(action) ? 1 : 2);
  });
});

class UiElement {
  children: UiElement[] = [];
  parentElement?: UiElement;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = ''; textContent = ''; disabled = false; type = ''; title = '';
  style = { cssText: '' };
  scrollTop = 0; clientHeight = 500; scrollHeight = 500;
  classList = {
    add: (name: string) => { this.className += ' ' + name; },
    contains: (name: string) => this.className.split(' ').includes(name),
    toggle: (_name: string, _value: boolean) => {}
  };
  get childElementCount() { return this.children.length; }
  set innerHTML(_value: string) { this.children.forEach((child) => { child.parentElement = undefined; }); this.children = []; }
  append(...children: UiElement[]) {
    for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); }
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = undefined;
  }
  contains(child: UiElement): boolean { return this === child || this.children.some((item) => item.contains(child)); }
  listeners = new Map<string, () => void>();
  addEventListener(type: string, listener: () => void) { this.listeners.set(type, listener); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
  querySelectorAll(selector: string): UiElement[] { return elements(this.children).filter(node => selector === 'button' && node.type === 'button'); }
  closest(selector: string): UiElement | null {
    if (selector === 'button[data-draft-run-id]' && this.type === 'button' && this.dataset.draftRunId) return this;
    if (selector === 'button[data-edit-id], button[data-change-set-id]' && this.type === 'button'
      && (this.dataset.editId || this.dataset.changeSetId)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
}
function renderHarness(f: Awaited<ReturnType<typeof createFixture>>, language: 'en' | 'zh-CN') {
  const source = getScript();
  const names = ['appendAutomaticApprovalState', 'getApprovalTarget', 'isHeldDraftRunApproval', 'formatApprovalDependency',
    'appendApprovalStateNote', 'appendApprovalResumeAction', 'createDraftRunCard', 'appendDraftRunBatchControls', 'appendDraftRunActions', 'createDraftRunActionButton',
    'isDraftRunBatchActive', 'getDraftRunBatchMembers', 'createDraftRunTimelineItem', 'renderDraftRunItems',
    'captureDraftRunActionFocus', 'findDraftRunActionFocus', 'renderTranscript', 'handleDraftRunActionClick', 'handleChangeSetActionClick',
    'createApprovalReviewSummary', 'getApprovalSourceLabel', 'getApprovalDecisionLabel', 'getApprovalRiskLabel',
    'getDraftRunTitle', 'appendDraftRunField', 'formatShellCommand', 'formatShellWord', 'getDraftRunStatusLabel', 'getDraftRunEffectLabel',
    'createChangeSetCard', 'createChangeSetFileRow', 'createEditActionButton', 'createEditOpenFileButton',
    'createChangeSetActionButton', 'getChangeSetStatusLabel', 'getChangeFileStatusLabel', 'isChangeSetActionable',
    'renderUnlinkedChangeSets', 'buildDraftRunTimelineProjection'];
  const functions = names.map((name) => {
    const start = source.indexOf('    function ' + name + '(');
    assert.ok(start >= 0);
    const end = source.indexOf('\n    function ', start + 1);
    return source.slice(start, end);
  }).join('\n');
  const state = { draftRuns: f.store.toWebviewState('s'), draftRunBatchSnapshots: f.batch.snapshots('s'),
    draftRunBatch: f.batch.state, draftRunBatchHistory: f.store.toBatchDisplayHistory('s'), approvalMode: 'ask', isBusy: false, activeDraftRunId: '',
    startup: { sideEffectsReady: true },
    approvalProcessing: undefined as import('../src/approvals/approvalProcessing').ApprovalProcessingState | undefined,
    authorizedExternalReferenceUris: [] as string[], authorizedExternalExecutionUris: [] as string[], messages: [{ id: 'assistant', role: 'assistant' }] as Array<{
      id: string; role: string; isStreaming?: boolean; content?: string;
    }> };
  const unlinked = new UiElement();
  const transcript = new UiElement();
  const unlinkedRegion = new UiElement(); unlinkedRegion.append(unlinked);
  const messages: unknown[] = [];
  const context = { state, document: { createElement: () => new UiElement() }, Element: UiElement, HTMLElement: UiElement,
    pendingDraftRunBatchSnapshot: '', pendingDraftRunActions: new Set(), pendingDraftRunApprovals: new Set(), pendingChangeActions: new Map(),
    changeActionRequestSequence: 0,
    formatDuration: String, createDraftEditActionIcon: () => new UiElement(),
    createApprovalSourceSummary: () => new UiElement(), getEditApprovalSourceLabel: String,
    unlinkedChangeSetList: unlinked, unlinkedChangeSetRegion: unlinkedRegion,
    transcript, planRegion: new UiElement(), editingMessageId: '', keepseekLogoUri: '',
    renderMarkdownContent: () => {}, createAssistantMessageActions: () => new UiElement(),
    createUserMessageActions: () => new UiElement(), getLanguage: () => language,
    render: () => {}, setTransientStatus: () => {}, vscode: { postMessage: (message: unknown) => messages.push(message) },
    t: (key: string, values: Record<string, unknown> = {}) => {
      const translations = WEBVIEW_TRANSLATIONS[language] as Record<string, string>;
      return (translations[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''));
    }
  };
  const api = new Script(functions + '\n({ appendAutomaticApprovalState, createDraftRunCard, createChangeSetCard, renderUnlinkedChangeSets, buildDraftRunTimelineProjection, renderTranscript, captureDraftRunActionFocus, findDraftRunActionFocus, handleDraftRunActionClick, handleChangeSetActionClick });').runInNewContext(context) as {
    appendAutomaticApprovalState(notices: UiElement, actions: UiElement, id: string, review?: unknown): void;
    createDraftRunCard(run: unknown): UiElement; createChangeSetCard(set: unknown): UiElement;
    renderUnlinkedChangeSets(sets: unknown[], runs: unknown[]): void;
    buildDraftRunTimelineProjection(): { byMessageId: Record<string, unknown[]>; unlinked: unknown[] };
    renderTranscript(sets: unknown, runs: unknown): void;
    captureDraftRunActionFocus(element: UiElement): Record<string, string>;
    findDraftRunActionFocus(buttons: UiElement[], descriptor: Record<string, string>): UiElement | undefined;
    handleDraftRunActionClick(event: { target: UiElement }): void;
    handleChangeSetActionClick(event: { target: UiElement }): void;
  };
  const renderCurrentState = (edits: string[][] = []) => {
    const sets = edits.map((statuses, index) => ({ id: 'set-' + index, files: statuses.map((status, i) => ({ id: 'e-' + index + '-' + i, status, label: 'file' + i })) }));
    const projection = api.buildDraftRunTimelineProjection();
    api.renderTranscript({ byMessageId: {}, unlinked: sets }, projection);
    // Return the actual tree produced by both real timeline entrances.
    return { cards: transcript.children, sets, projection };
  };
  const render = (edits: string[][] = []) => {
    state.draftRuns = f.store.toWebviewState('s'); state.draftRunBatchSnapshots = f.batch.snapshots('s'); state.draftRunBatch = f.batch.state;
    state.draftRunBatchHistory = f.store.toBatchDisplayHistory('s');
    return renderCurrentState(edits);
  };
  context.render = () => { renderCurrentState(); };
  return { api, state, unlinked, transcript, context, messages, render, renderCurrentState };
}
function elements(cards: UiElement[]): UiElement[] { return cards.flatMap((card) => [card, ...elements(card.children)]); }

test('automatic cards distinguish processing, scope authorization, hard failure and reviewer denial in both languages', async () => fixture(async f => {
  for (const language of ['en', 'zh-CN'] as const) for (const mode of ['delegate']) {
    const ui = renderHarness(f, language); ui.state.approvalMode = mode;
    const labels = WEBVIEW_TRANSLATIONS[language];
    const renderState = (review?: unknown) => {
      const notes = new UiElement(), actions = new UiElement();
      ui.api.appendAutomaticApprovalState(notes, actions, 'A', review);
      assert.equal(notes.childElementCount, 1);
      assert.equal(notes.children[0].className, 'approval-state-note');
      assert.ok(actions.children.every(n => n.type === 'button'));
      return { note: notes.children[0], buttons: actions.children };
    };
    const waiting = renderState();
    assert.equal(waiting.note.textContent, labels[mode === 'delegate' ? 'approvalAutoInactive' : 'approvalModelWaiting']);
    assert.equal(waiting.buttons.length, 0);
    ui.state.approvalProcessing = { version: 1, runId: 'r', rootTaskId: 'task', mode: mode as 'delegate',
      status: 'processing', updatedAt: '', targets: [{ id: 'A', kind: 'command', status: 'pending' }] };
    const processing = renderState();
    assert.equal(processing.note.textContent, labels.approvalProcessingNow);
    assert.equal(processing.buttons.length, 0);
    ui.state.approvalProcessing.status = 'blocked';
    ui.state.approvalProcessing.targets[0] = { id: 'A', kind: 'command', status: 'needs_authorization', reason: 'file:///external/result.txt' };
    const external = renderState();
    assert.equal(external.note.textContent, 'file:///external/result.txt');
    assert.deepEqual(external.buttons.map(button => button.textContent), mode === ('legacy_removed' as string) ? [labels.approvalAuthorizeExact] : []);
    ui.state.approvalProcessing.targets[0] = { id: 'A', kind: 'command', status: 'failed', reason: 'Dirty editor' };
    const failure = renderState();
    assert.equal(failure.note.textContent, 'Dirty editor');
    assert.equal(failure.buttons.length, 0);
    ui.state.approvalProcessing.targets[0] = { id: 'A', kind: 'command', status: 'denied', reason: 'Denied by reviewer' };
    const denied = renderState({ decision: 'deny', rationale: 'Denied by reviewer' });
    assert.equal(denied.note.textContent, 'Denied by reviewer');
    assert.equal(denied.buttons.length, mode === ('legacy_removed' as string) ? 1 : 0);
    if (mode === ('legacy_removed' as string)) {
      assert.equal(denied.buttons[0].textContent, labels.approvalConfirmOnce);
      denied.buttons[0].click();
      assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { type: 'resumeApprovalProcessing', confirmTargetId: 'A' });
    }
    ui.state.approvalProcessing.targets[0].status = 'hard_blocked';
    assert.equal(renderState({ decision: 'deny', approvalSource: 'local_policy' }).buttons.length, 0);
  }
}));

test('Git draft cards show preflight diagnostics and never offer delegate restart recovery', async () => fixture(async f => {
  f.add(['A', 'B']);
  for (const language of ['en', 'zh-CN'] as const) {
    const ui = renderHarness(f, language);
    const labels = WEBVIEW_TRANSLATIONS[language];
    const [status, commit] = ui.state.draftRuns;
    const processing: NonNullable<typeof ui.state.approvalProcessing> = {
      version: 1, runId: status.agentRunId, rootTaskId: 'task', mode: 'delegate', status: 'replanning', updatedAt: '',
      reason: 'Batch status must not appear as another command’s diagnostic',
      targets: [{ id: status.id, kind: 'command', status: 'needs_replan' }, { id: commit.id, kind: 'command', status: 'dependency_blocked' }]
    };
    const statusReason = 'Use a controlled read for the pager override.';
    const commitReason = 'Arguments 7 and 8 conflict with -a. <script>Literal text</script>';
    const diagnostic = (draft: typeof status, code: string, reason: string) => ({
      code, reason, draftRunId: draft.id, specHash: draft.specHash, rootTaskId: 'task', executionSegmentId: draft.agentRunId,
      phase: 'preflight', executed: false
    });
    const first = { ...status, status: 'needs_replan', replan: diagnostic(status, 'git_status_pager', statusReason) };
    const second = { ...commit, status: 'cancelled', replan: diagnostic(commit, 'git_commit_invalid_argv', commitReason),
      dependency: { targetId: status.id, label: 'git status', reason: statusReason } };
    const render = (draft: unknown) => elements([ui.api.createDraftRunCard(draft)]);
    const texts = (nodes: UiElement[]) => nodes.filter(node => node.className === 'approval-state-note').map(node => node.textContent);
    ui.state.approvalProcessing = processing;
    for (const mode of ['delegate', 'ask']) {
      ui.state.approvalMode = mode;
      const statusCard = render(first);
      const commitCard = render(second);
      assert.ok(statusCard.some(node => node.textContent === labels.draftRunTitleNeedsReplan));
      assert.ok(commitCard.some(node => node.textContent === labels.draftRunTitleBlocked));
      assert.deepEqual(texts(statusCard), [labels.approvalCommandReplanReason.replace('{reason}', statusReason)]);
      assert.deepEqual(texts(commitCard), [labels.approvalCommandDependency.replace('{target}', `git status (${status.id})`) + ' · ' + statusReason,
        labels.approvalCommandReplanReason.replace('{reason}', commitReason)]);
      assert.ok(![...statusCard, ...commitCard].some(node => node.type === 'button'));
    }
    ui.state.approvalMode = 'delegate';
    processing.status = 'blocked';
    processing.canResume = true;
    assert.equal(render(second).filter(node => node.type === 'button').length, 0);
    const resume = render(first).filter(node => node.type === 'button');
    assert.equal(resume.length, 0);
    assert.equal(ui.messages.length, 0);
    processing.canResume = false;
    processing.targets[0].reason = labels.approvalReplanRepeated;
    const stopped = render(first);
    assert.ok(!stopped.some(node => node.type === 'button'));
    assert.deepEqual(texts(stopped), [labels.approvalCommandReplanReason.replace('{reason}', statusReason), labels.approvalReplanRepeated]);
    ui.state.approvalProcessing = undefined;
    const waiting = render(status);
    assert.ok(waiting.some(node => node.textContent === labels.draftRunTitleBlocked));
    assert.ok(!waiting.some(node => node.type === 'button'));
    ui.state.approvalMode = 'ask';
    assert.equal(render(status).filter(node => node.dataset.draftRunAction === 'approveDraftRun').length, 2);
    const noChanges = render({ ...commit, status: 'no_changes' });
    assert.ok(noChanges.some(node => node.textContent === labels.draftRunTitleNoChanges));
    assert.ok(!noChanges.some(node => node.type === 'button'));
    const head = '0123456789012345678901234567890123456789';
    const verified = render({ ...commit, status: 'done', gitCommitEvidence: { outcome: 'verified', head } });
    assert.ok(verified.some(node => node.textContent === labels.draftRunVerifiedGitHead.replace('{head}', head.slice(0, 12)) && node.title === head));
  }
}));

function bulk(cards: UiElement[]) {
  return elements(cards).filter((item) => item.dataset.draftRunAction === 'approveDraftRunBatch'
    || ['applyChangeSet', 'discardChangeSet', 'revertChangeSet'].includes(item.dataset.changeSetAction));
}

const longAuthorizationReason = '等待你授权精确操作范围：Command scope cannot be established statically; authorize this exact operation. / 无法静态确定命令范围，请确认这条精确操作。';

test('command and file cards keep complete automatic notes outside button groups and preserve action payloads', async () => fixture(async f => {
  f.add(['A']);
  for (const language of ['en', 'zh-CN'] as const) for (const mode of ['delegate'] as const) {
    const ui = renderHarness(f, language); ui.state.approvalMode = mode;
    const labels = WEBVIEW_TRANSLATIONS[language];
    const fileReason = 'file:///external/' + 'long-unbroken-path'.repeat(30) + '/<script>literal</script>.txt';
    const set = { id: 'set', files: [{ id: 'edit-A', status: 'pending', label: 'file.ts', uri: 'file:///external/file.ts' }] };
    ui.state.approvalProcessing = { version: 1, runId: 'r', rootTaskId: 'task', mode, status: 'blocked', updatedAt: '', targets: [
      { id: 'A', kind: 'command', status: 'needs_authorization', reason: longAuthorizationReason },
      { id: 'edit-A', kind: 'edit', status: 'needs_authorization', reason: fileReason }
    ] };
    const command = ui.api.createDraftRunCard(ui.state.draftRuns[0]);
    const file = ui.api.createChangeSetCard(set);
    for (const [card, reason, id, actionClass] of [
      [command, longAuthorizationReason, 'A', 'draft-run-actions'],
      [file, fileReason, 'edit-A', 'draft-chip-actions']
    ] as const) {
      const nodes = elements([card]);
      const notes = nodes.filter(n => n.className === 'approval-state-note');
      const actions = nodes.find(n => n.className === actionClass)!;
      assert.equal(notes.length, 1);
      assert.equal(notes[0].textContent, reason);
      assert.equal(notes[0].childElementCount, 0, 'untrusted reasons stay literal text');
      assert.equal(nodes.filter(n => n.textContent === reason).length, 1);
      if (mode === 'delegate' && id === 'A') {
        assert.equal(actions, undefined);
        continue;
      }
      assert.equal(notes[0].parentElement, actions.parentElement, 'note occupies a sibling row');
      assert.ok(!actions.contains(notes[0]));
      assert.ok(actions.children.every(n => n.type === 'button'));
      const siblings = actions.parentElement!.children;
      assert.equal(siblings[siblings.indexOf(actions) - 1], notes[0], 'scope note is adjacent to its buttons');
      const authorize = actions.children.find(n => n.textContent === labels.approvalAuthorizeExact)!;
      if (mode === ('legacy_removed' as string)) {
        authorize.click();
        assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.pop())), { type: 'resumeApprovalProcessing', authorizeTargetId: id });
      } else assert.equal(authorize, undefined);
    }
    const reject = elements([command]).find(n => n.dataset.draftRunAction === 'rejectDraftRun')!;
    if (mode === ('legacy_removed' as string)) {
      ui.api.handleDraftRunActionClick({ target: reject });
      assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.pop())), { type: 'rejectDraftRun', id: 'A' });
    } else assert.equal(reject, undefined);
    const preview = elements([file]).find(n => n.dataset.editAction === 'openDraftDiff')!;
    ui.api.handleChangeSetActionClick({ target: preview });
    assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.pop())), { type: 'openDraftDiff', id: 'edit-A' });
    const discard = elements([file]).find(n => n.dataset.editAction === 'discardDraftEdit')!;
    ui.api.handleChangeSetActionClick({ target: discard });
    assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.pop())), { type: 'discardDraftEdit', id: 'edit-A', requestId: 'change-action-1' });
  }
}));

test('automatic notes and buttons rerender without stale scope or duplicate actions, respecting busy/startup/denial', async () => fixture(async f => {
  f.add(['A']);
  for (const language of ['en', 'zh-CN'] as const) for (const mode of ['delegate'] as const) {
    const ui = renderHarness(f, language); ui.state.approvalMode = mode;
    const labels = WEBVIEW_TRANSLATIONS[language];
    const set = { id: 'set', files: [{ id: 'edit-A', status: 'pending', label: 'file.ts' }] };
    const render = () => {
      ui.api.renderUnlinkedChangeSets([set], [{ draftRun: ui.state.draftRuns[0] }]);
      return elements(ui.unlinked.children);
    };
    for (const status of ['needs_authorization', 'failed', 'pending', 'denied'] as const) {
      const reason = status === 'needs_authorization' ? longAuthorizationReason : status + ' reason';
      ui.state.approvalProcessing = { version: 1, runId: 'r', rootTaskId: 'task', mode,
        status: status === 'pending' ? 'processing' : 'blocked', canResume: false, updatedAt: '', targets: [
          { id: 'A', kind: 'command', status, reason }, { id: 'edit-A', kind: 'edit', status, reason }
        ] };
      const nodes = render();
      assert.equal(nodes.filter(n => n.className === 'approval-state-note').length, 2);
      assert.equal(nodes.filter(n => n.textContent === reason).length, 2);
      if (status !== 'needs_authorization') assert.ok(!nodes.some(n => n.textContent === longAuthorizationReason));
      const resume = nodes.filter(n => [labels.approvalAuthorizeExact, labels.approvalResumeProcessing].includes(n.textContent));
      assert.equal(resume.length, 0, 'legacy snapshots provide explanation only');
      if (mode === ('legacy_removed' as string) && status === 'failed') {
        resume.forEach(button => button.click());
        assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.splice(0))), [
          { type: 'resumeApprovalProcessing' }, { type: 'resumeApprovalProcessing' }
        ], 'ordinary retry does not grant scope');
      }
    }
    ui.state.approvalProcessing = undefined;
    ui.state.startup.sideEffectsReady = false;
    let nodes = render();
    assert.ok(nodes.filter(n => n.type === 'button' && n.dataset.editAction !== 'openDraftDiff').every(n => n.disabled));
    ui.state.startup.sideEffectsReady = true; ui.state.isBusy = true;
    nodes = render();
    assert.ok(!nodes.some(n => n.textContent === labels.approvalResumeProcessing));
    assert.ok(nodes.filter(n => n.dataset.editAction === 'discardDraftEdit' || n.dataset.draftRunAction === 'rejectDraftRun').every(n => n.disabled));
    ui.state.isBusy = false;
    const review = { decision: 'deny', rationale: 'Reviewer denied this operation' };
    const deniedCards = [ui.api.createDraftRunCard({ ...ui.state.draftRuns[0], approvalReview: review }),
      ui.api.createChangeSetCard({ ...set, files: [{ ...set.files[0], approvalReview: review }] })];
    assert.equal(elements(deniedCards).filter(n => n.className === 'approval-state-note' && n.textContent === review.rationale).length, 2);
    assert.ok(!elements(deniedCards).some(n => n.textContent === labels.approvalResumeProcessing), 'review denial alone cannot expose a bypass');
    ui.state.approvalMode = 'ask'; nodes = render();
    assert.ok(!nodes.some(n => n.className === 'approval-state-note'));
    assert.equal(nodes.filter(n => n.dataset.draftRunAction === 'approveDraftRun').length, 2);
    assert.equal(nodes.filter(n => n.dataset.editAction === 'applyDraftEdit').length, 1);
    ui.state.approvalMode = mode;
    for (const status of ['running', 'approved', 'done', 'failed', 'cancelled', 'rejected']) {
      const card = ui.api.createDraftRunCard({ ...ui.state.draftRuns[0], status, startedAt: 'now', output: 'preserved output', error: 'preserved error' });
      assert.ok(!elements([card]).some(n => n.className === 'approval-state-note'));
      assert.ok(elements([card]).some(n => n.className === 'draft-run-output' && n.textContent.includes('preserved output') && n.textContent.includes('preserved error')));
    }
    for (const status of ['applied', 'discarded', 'superseded', 'reverted']) {
      assert.ok(!elements([ui.api.createChangeSetCard({ ...set, files: [{ ...set.files[0], status }] })]).some(n => n.className === 'approval-state-note'));
    }
  }
}));
function runCards(nodes: UiElement[]) {
  return elements(nodes).filter((item) => item.classList.contains('draft-run-card'));
}
function batchGroups(nodes: UiElement[]) {
  return elements(nodes).filter((item) => item.classList.contains('draft-run-batch-group'));
}
function assertRunOrder(nodes: UiElement[], ids: string[]) {
  assert.deepEqual(runCards(nodes).map((card) => card.dataset.draftRunId), ids);
  assert.equal(new Set(runCards(nodes).map((card) => card.dataset.draftRunId)).size, ids.length);
}
function assertSharedGroup(nodes: UiElement[], ids: string[]) {
  const groups = batchGroups(nodes);
  assert.equal(groups.length, 1);
  assertRunOrder([groups[0]], ids);
  assertRunOrder(nodes, ids);
  const headers = elements([groups[0]]).filter((item) => item.className === 'draft-run-batch');
  assert.equal(headers.length, 1);
  assert.equal(headers[0].parentElement, groups[0]);
  assert.ok(runCards([groups[0]]).every((card) => !card.contains(headers[0])), 'batch header is outside every command card');
  return groups[0];
}

test('real transcript keeps A/B/C in one ordered container throughout snapshot, queued, running, waiting, continuing and completed', async () => fixture(async (f) => {
  f.add(['z-A', 'a-B', 'm-C']);
  const ui = renderHarness(f, 'zh-CN');
  const ids = ['z-A', 'a-B', 'm-C'];
  assertSharedGroup(ui.render().cards, ids);
  const snapshotButton = bulk(ui.transcript.children)[0];
  const snapshotFocus = ui.api.captureDraftRunActionFocus(snapshotButton);
  const operationId = f.accept();
  let group = assertSharedGroup(ui.render().cards, ids);
  assert.equal(group.dataset.operationId, operationId);
  let stop = elements([group]).find((item) => item.dataset.draftRunAction === 'cancelDraftRunBatch')!;
  assert.equal(ui.api.findDraftRunActionFocus(elements([group]).filter((node) => node.type === 'button'), snapshotFocus), stop, 'approval focus follows its exact snapshot into its operation');
  const executing = f.execute(operationId);
  await f.executor.started(1);
  ui.state.isBusy = true;
  group = assertSharedGroup(ui.render().cards, ids);
  assert.equal(bulk([group]).length, 0);
  assert.equal(elements([group]).filter((item) => item.attributes.role === 'status').length, 1);
  f.executor.finish('z-A'); await f.executor.started(2);
  assert.equal(f.store.toWebviewState('s').filter((run) => run.status === 'pending').length, 1);
  assertSharedGroup(ui.render().cards, ids);
  f.executor.finish('a-B'); await f.executor.started(3);
  assertSharedGroup(ui.render().cards, ids);
  f.executor.finish('m-C'); await executing;
  assert.equal(f.batch.state?.phase, 'waiting');
  assertSharedGroup(ui.render().cards, ids);
  const sent = deferred<boolean>();
  const continuing = f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: () => sent.promise });
  assert.equal(f.batch.state?.phase, 'continuing');
  assertSharedGroup(ui.render().cards, ids);
  sent.resolve(true); await continuing;
  assert.equal(f.batch.state?.phase, 'completed');
  group = assertSharedGroup(ui.render().cards, ids);
  assert.ok(elements([group]).some((node) => node.textContent.includes('已自动继续一次')));
  stop = elements([group]).find((item) => item.dataset.draftRunAction === 'cancelDraftRunBatch')!;
  assert.equal(stop, undefined, 'terminal history has no stop authority');
}));

test('failed/cancelled batches retain their record while remaining pending members move once into a new candidate and approval', async () => {
  for (const ending of ['failed', 'cancelled']) await fixture(async (f) => {
    f.add(['A', 'B', 'C']); const ui = renderHarness(f, 'en');
    const oldOperation = f.accept(); const executing = f.execute(oldOperation);
    await f.executor.started(1);
    if (ending === 'failed') f.executor.finish('A', { exitCode: 2, cancelled: false, timedOut: false });
    else f.batch.cancel(oldOperation);
    await executing;
    assert.equal(f.batch.state?.phase, ending);
    assert.equal(f.store.get('A')?.status, ending);
    assert.equal(f.store.get('B')?.status, 'pending');
    assert.equal(f.store.get('C')?.status, 'pending');
    let tree = ui.render().cards;
    assert.equal(batchGroups(tree).length, 2, 'previous approval and new candidate have distinct headers');
    assertRunOrder(tree, ['A', 'B', 'C']);
    const old = batchGroups(tree).find((group) => group.dataset.operationId === oldOperation)!;
    assertRunOrder([old], ['A']);
    assert.ok(elements([old]).some((node) => node.className === 'draft-run-batch-hint'
      && node.textContent === WEBVIEW_TRANSLATIONS.en.draftRunBatchMovedMembers.replace('{count}', '2')));
    assert.equal(bulk(tree).length, 1);
    const newSnapshot = JSON.parse(bulk(tree)[0].dataset.batchSnapshot) as DraftRunBatchSnapshot;
    assert.deepEqual(newSnapshot.entries.map((entry) => entry.draftRunId), ['B', 'C']);
    const newOperation = f.batch.accept(newSnapshot, { sessionId: 's', sourceId: 'source', modelId: 'model' });
    assert.notEqual(newOperation, oldOperation);
    tree = ui.render().cards;
    assert.equal(batchGroups(tree).length, 2);
    assertRunOrder(tree, ['A', 'B', 'C']);
    assert.equal(bulk(tree).length, 0);
    const retry = f.execute(newOperation);
    await f.executor.started(2); f.executor.finish('B');
    await f.executor.started(3); f.executor.finish('C'); await retry;
    await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => true });
    tree = ui.render().cards;
    assertRunOrder(tree, ['A', 'B', 'C']);
    assert.equal(batchGroups(tree).length, 2);
    assert.equal(f.executor.calls.filter((call) => call.draftRun.id === 'A').length, 1);
  });
});

test('completed groups survive new same-run clones, later approval, session switches and a new Webview projection', async () => fixture(async (f) => {
  f.add(['A', 'B']); const first = f.accept(); const executing = f.execute(first);
  await f.executor.started(1); f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); await executing;
  await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => true });
  const clone = f.store.cloneAsPending('A')!; f.add(['C']);
  const ui = renderHarness(f, 'en'); let tree = ui.render().cards;
  assert.equal(batchGroups(tree).length, 2);
  assertRunOrder([batchGroups(tree).find((group) => group.dataset.operationId === first)!], ['A', 'B']);
  assertRunOrder(tree, ['A', 'B', clone.id, 'C']);
  const second = f.accept();
  assert.notEqual(first, second);
  tree = ui.render().cards;
  assert.equal(batchGroups(tree).length, 2);
  assertRunOrder([batchGroups(tree).find((group) => group.dataset.operationId === first)!], ['A', 'B']);
  f.add(['other-A', 'other-B'], 'other-session', 'r');
  ui.state.draftRuns = f.store.toWebviewState('other-session');
  ui.state.draftRunBatchSnapshots = f.batch.snapshots('other-session');
  ui.state.draftRunBatchHistory = f.store.toBatchDisplayHistory('other-session');
  ui.state.draftRunBatch = undefined;
  assertSharedGroup(ui.renderCurrentState().cards, ['other-A', 'other-B']);
  tree = ui.render().cards;
  assert.equal(batchGroups(tree).length, 2);
  assertRunOrder(tree, ['A', 'B', clone.id, 'C']);
  const rebuilt = renderHarness(f, 'en');
  assert.equal(batchGroups(rebuilt.render().cards).length, 2);
  assertRunOrder(rebuilt.transcript.children, ['A', 'B', clone.id, 'C']);
}));

test('global projection groups cross-message, mixed linked/unlinked, streaming and unloaded-message members without duplicate cards', async () => fixture(async (f) => {
  for (const [id, messageId] of [['A', 'm1'], ['B', 'm2'], ['C', 'missing']]) f.store.addProposals({
    proposals: [f.proposal(id)], sessionId: 's', agentRunId: 'r', messageId
  });
  const ui = renderHarness(f, 'en'); ui.state.messages = [{ id: 'm1', role: 'assistant' }, { id: 'm2', role: 'assistant' }];
  let tree = ui.render().cards;
  assertSharedGroup(tree, ['A', 'B', 'C']); assertSharedGroup(ui.unlinked.children, ['A', 'B', 'C']);
  ui.state.messages.push({ id: 'missing', role: 'assistant' });
  assertSharedGroup(ui.render().cards, ['A', 'B', 'C']); assert.equal(batchGroups(ui.unlinked.children).length, 1, 'cross-message anchor stays unlinked');
  ui.state.draftRuns = ui.state.draftRuns.map((run) => ({ ...run, messageId: 'm1' }));
  ui.state.messages = [{ id: 'm1', role: 'assistant', isStreaming: true }];
  assertSharedGroup(ui.renderCurrentState().cards, ['A', 'B', 'C']); assert.equal(batchGroups(ui.unlinked.children).length, 1);
  ui.state.messages[0].isStreaming = false;
  tree = ui.renderCurrentState().cards;
  assertSharedGroup(tree, ['A', 'B', 'C']); assert.equal(batchGroups(ui.unlinked.children).length, 0);
  ui.state.messages = [];
  assertSharedGroup(ui.renderCurrentState().cards, ['A', 'B', 'C']); assert.equal(batchGroups(ui.unlinked.children).length, 1);
  ui.state.messages = [{ id: 'm1', role: 'assistant' }];
  assertSharedGroup(ui.renderCurrentState().cards, ['A', 'B', 'C']); assert.equal(batchGroups(ui.unlinked.children).length, 0);
}));

test('incomplete operation data keeps a header without its first card; inconsistent membership leaves commands conservatively ungrouped', async () => fixture(async (f) => {
  f.add(['A', 'B', 'C']); f.accept();
  const ui = renderHarness(f, 'en'); ui.render();
  ui.state.draftRuns = ui.state.draftRuns.filter((run) => run.id !== 'A');
  let tree = ui.renderCurrentState().cards;
  assertSharedGroup(tree, ['B', 'C']);
  assert.equal(elements(tree).filter((node) => node.attributes.role === 'status').length, 1);
  assert.equal(bulk(tree).length, 0);
  for (const changed of ['specHash', 'sessionId', 'agentRunId'] as const) {
    ui.render();
    ui.state.draftRuns = ui.state.draftRuns.map((run) => run.id === 'A' ? { ...run, [changed]: 'different' } : run);
    tree = ui.renderCurrentState().cards;
    assertRunOrder(tree, ['A', 'B', 'C']);
    assert.equal(batchGroups(tree).length, 0, 'invalid operation membership cannot imply shared approval');
  }
}));

test('shared header delegates exact approval/stop payloads, blocks repeated clicks, and keeps focus within its identity', async () => fixture(async (f) => {
  f.add(['A', 'B']); const ui = renderHarness(f, 'en');
  let tree = ui.render().cards;
  const approve = bulk(tree)[0];
  const focus = ui.api.captureDraftRunActionFocus(approve);
  ui.api.handleDraftRunActionClick({ target: approve });
  ui.api.handleDraftRunActionClick({ target: approve });
  assert.equal(ui.messages.length, 1, 'repeat click against a detached old button is ignored');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages[0])), { type: 'approveDraftRunBatch', snapshot: f.batch.snapshots('s')[0] });
  assert.equal(bulk(ui.transcript.children)[0].disabled, true);
  ui.context.pendingDraftRunBatchSnapshot = '';
  ui.state.startup.sideEffectsReady = false;
  assert.equal(bulk(ui.render().cards)[0].disabled, true);
  ui.state.startup.sideEffectsReady = true; ui.state.isBusy = true;
  assert.equal(bulk(ui.render().cards)[0].disabled, true);
  ui.state.isBusy = false;
  f.add(['C']); tree = ui.render().cards;
  const buttons = elements(tree).filter((node) => node.type === 'button');
  assert.equal(ui.api.findDraftRunActionFocus(buttons, focus), null, 'a new candidate never inherits another snapshot focus');
  const newFocus = ui.api.captureDraftRunActionFocus(bulk(tree)[0]);
  const operationId = f.accept(); tree = ui.render().cards;
  const stop = elements(tree).find((node) => node.dataset.draftRunAction === 'cancelDraftRunBatch')!;
  const allButtons = elements(tree).filter((node) => node.type === 'button');
  assert.equal(ui.api.findDraftRunActionFocus(allButtons, newFocus), stop);
  const cardFocus = { draftRunId: 'A', draftRunAction: 'cancelDraftRun' };
  assert.notEqual(ui.api.findDraftRunActionFocus(allButtons, cardFocus), stop, 'single-card fallback never selects batch controls');
  ui.api.handleDraftRunActionClick({ target: stop });
  assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { type: 'cancelDraftRunBatch', operationId });
  f.batch.cancel(operationId); tree = ui.render().cards;
  assert.equal(ui.api.findDraftRunActionFocus(elements(tree).filter((node) => node.type === 'button'), ui.api.captureDraftRunActionFocus(stop)), null);
}));

test('both languages and all card entrances hide bulk actions at 0/1, show counts at 2+, and retain single actions after 2→1', async () => {
  for (const language of ['en', 'zh-CN'] as const) await fixture(async (f) => {
    const ui = renderHarness(f, language);
    assert.equal(bulk(ui.render([[]]).cards).length, 0);
    f.add(['A']);
    assert.equal(bulk(ui.render([['pending']]).cards).length, 0, 'one command plus one edit are not a batch');
    f.add(['B']);
    const initial = ui.render([['pending', 'pending', 'applied', 'applied', 'discarded']]);
    assert.equal(bulk(initial.cards).length, 4);
    assert.equal(bulk(initial.cards).filter((button) => /2/u.test(button.textContent)).length, 2);
    assert.deepEqual(bulk(initial.cards).map((button) => button.dataset.draftRunAction || button.dataset.changeSetAction), [
      'approveDraftRunBatch', 'applyChangeSet', 'discardChangeSet', 'revertChangeSet'
    ]);
    assert.equal(bulk(ui.unlinked.children).length, 3, 'linked command group stays in its message');
    assert.equal(ui.api.buildDraftRunTimelineProjection().byMessageId.assistant.length, 1);
    const snapshot = JSON.parse(bulk(initial.cards)[0].dataset.batchSnapshot);
    assert.deepEqual(snapshot.entries.map((entry: { draftRunId: string }) => entry.draftRunId), ['A', 'B']);
    assert.equal(snapshot.spec, undefined);
    assert.equal(bulk(initial.cards)[1].dataset.changeSetId, 'set-0');
    f.store.reject('A');
    const reduced = ui.render([['applied', 'pending', 'discarded']]);
    assert.equal(bulk(reduced.cards).length, 0); assert.equal(bulk(ui.unlinked.children).length, 0);
    assert.ok(elements(reduced.cards).some((item) => item.dataset.draftRunAction === 'approveDraftRun' && item.dataset.draftRunId === 'B' && !item.disabled));
    assert.ok(elements(reduced.cards).some((item) => item.dataset.editAction === 'applyDraftEdit' && !item.disabled));
    assert.ok(elements(reduced.cards).some((item) => item.dataset.editAction === 'discardDraftEdit' && !item.disabled));
    assert.equal(bulk(ui.render([['applied']]).cards).length, 0, 'one revertible edit uses only its row action');
    assert.ok(elements(ui.render([['applied']]).cards).some((item) => item.dataset.editAction === 'revertDraftEdit' && !item.disabled));
    const superseded = [ui.api.createChangeSetCard(ui.render([['superseded']]).sets[0])];
    assert.equal(elements(superseded).some((item) => Boolean(item.dataset.editAction)), false,
      'a superseded edit has no stale Apply, discard, diff, or revert action');
    assert.ok(elements(superseded).some((item) => item.textContent.includes(
      language === 'en' ? 'Superseded by another draft' : '已被其他草案取代'
    )));
    assert.equal(bulk(ui.render([['pending'], ['pending']]).cards).length, 0, 'separate ChangeSets never combine');
    f.add(['C'], 's', 'another-run');
    assert.equal(bulk(ui.render().cards).length, 0, 'separate command batches never combine');
    f.add(['D', 'E'], 'other-session', 'r');
    assert.equal(bulk(ui.render().cards).length, 0, 'other sessions never combine');
    ui.state.messages = [];
    assert.equal(ui.api.buildDraftRunTimelineProjection().unlinked.length, 3, 'unlinked projection uses the same cards');
  });
});

test('DraftRun card renders executable and argv as one shell-readable command without changing the stored spec', async () => fixture(async (f) => {
  const spec: DraftRunSpec = {
    ...f.proposal('display-command').spec,
    executable: '/usr/bin/sed',
    args: ['-i', '', '-e', 's/kmvpy\\.common\\.kore/kmvpy.common.kmv/g', 'path with spaces/file.py', "it's.py"],
    env: []
  };
  f.store.addProposals({
    proposals: [{ id: 'display-command', spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) }],
    sessionId: 's',
    agentRunId: 'r',
    messageId: 'assistant'
  });

  const ui = renderHarness(f, 'zh-CN');
  const card = elements(ui.render().cards).find((item) => item.classList.contains('draft-run-card'))!;
  const fields = elements([card]).filter((item) => item.className === 'draft-run-field');
  assert.equal(fields[0]?.children[0]?.textContent, '完整命令');
  assert.equal(
    fields[0]?.children[1]?.textContent,
    "/usr/bin/sed -i '' -e 's/kmvpy\\.common\\.kore/kmvpy.common.kmv/g' 'path with spaces/file.py' 'it'\"'\"'s.py'"
  );
  assert.equal(fields.some((field) => field.children[0]?.textContent === '可执行文件' || field.children[0]?.textContent === '完整参数'), false);
  assert.equal(fields.some((field) => field.children[0]?.textContent === '环境覆盖'), false);
  assert.deepEqual(f.store.get('display-command')?.spec, spec);
}));

test('DraftRun card folds scoped environment overrides into the displayed command with shell-safe values', async () => fixture(async (f) => {
  const spec: DraftRunSpec = {
    ...f.proposal('display-environment').spec,
    executable: 'node',
    args: ['script.js'],
    env: [
      { name: 'NODE_ENV', value: 'test' },
      { name: 'EMPTY', value: '' },
      { name: 'GREETING', value: 'hello world' },
      { name: 'PRICE', value: '$5' },
      { name: 'QUOTE', value: "it's" }
    ]
  };
  f.store.addProposals({
    proposals: [{ id: 'display-environment', spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) }],
    sessionId: 's',
    agentRunId: 'r',
    messageId: 'assistant'
  });

  const card = runCards(renderHarness(f, 'zh-CN').render().cards)[0];
  const fields = elements([card]).filter((item) => item.className === 'draft-run-field');
  assert.equal(
    fields[0]?.children[1]?.textContent,
    "NODE_ENV=test EMPTY='' GREETING='hello world' PRICE='$5' QUOTE='it'\"'\"'s' node script.js"
  );
  assert.equal(fields.some((field) => field.children[0]?.textContent === '环境覆盖'), false);
  assert.deepEqual(f.store.get('display-environment')?.spec, spec);
}));

test('running batch with one remaining command keeps accessible progress and stop; external cwd and automated modes disable/hide approval', async () => fixture(async (f) => {
  f.add(['A', 'B']); const ui = renderHarness(f, 'en'); const executing = f.execute(f.accept());
  await f.executor.started(1);
  ui.state.isBusy = true;
  let cards = ui.render().cards;
  assert.equal(bulk(cards).length, 0);
  const stop = elements(cards).find((item) => item.dataset.draftRunAction === 'cancelDraftRunBatch')!;
  assert.equal(stop.disabled, false); assert.equal(stop.type, 'button');
  assert.ok(elements(cards).some((item) => item.attributes.role === 'status'));
  f.executor.finish('A'); await f.executor.started(2);
  cards = ui.render().cards;
  assert.equal(bulk(cards).length, 0);
  assert.ok(elements(cards).some((item) => item.dataset.draftRunAction === 'cancelDraftRunBatch' && !item.disabled));
  f.batch.cancel(); await executing;
  f.add(['C', 'D'], 's', 'new-batch');
  for (const mode of ['delegate']) { ui.state.approvalMode = mode; assert.equal(bulk(ui.render().cards).length, 0); }
}));

test('batch stop during approval persistence returns the never-started command to pending', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  const originalWrite = vscode.workspace.fs.writeFile;
  const entered = deferred<void>(); const release = deferred<void>();
  let pause = true;
  vscode.workspace.fs.writeFile = async (uri, data) => {
    if (pause && f.store.get('A')?.status === 'approved') { pause = false; entered.resolve(); await release.promise; }
    return originalWrite(uri, data);
  };
  try {
    const executing = f.execute(f.accept()); await entered.promise;
    f.batch.cancel(); release.resolve(); await executing;
    assert.equal(f.executor.calls.length, 0);
    assert.equal(f.store.get('A')?.status, 'pending'); assert.equal(f.store.get('B')?.status, 'pending');
    assert.equal(f.store.get('A')?.authorizationSource, undefined);
    assert.equal(f.batch.state?.remaining, 2);
  } finally { release.resolve(); vscode.workspace.fs.writeFile = originalWrite; }
}));

test('a changed hash or revoked external authorization before B leaves B and C unapproved', async () => {
  for (const change of ['hash', 'authorization']) await fixture(async (f) => {
    const external = path.join(f.root, 'external'); await mkdir(external);
    const uri = vscode.Uri.file(external).toString();
    f.store.addProposals({ proposals: [f.proposal('A'), f.proposal('B', { externalCwd: true, cwdUri: uri }), f.proposal('C')], sessionId: 's', agentRunId: 'r' });
    const authorizedUris = new Set([uri, vscode.Uri.file(path.join(await realpath(external), 'B')).toString()]);
    const executing = f.batch.execute(f.accept(), { authorizedUris, assertContext: () => {}, onCurrent: () => {} });
    await f.executor.started(1);
    if (change === 'authorization') authorizedUris.clear();
    else {
      const internal = f.store as unknown as { draftRuns: Map<string, { spec: DraftRunSpec }> };
      internal.draftRuns.get('B')!.spec.args.push('tampered');
    }
    f.executor.finish('A'); await executing;
    assert.equal(f.executor.calls.length, 1);
    assert.equal(f.store.get('B')?.status, 'pending'); assert.equal(f.store.get('C')?.status, 'pending');
    assert.equal(f.batch.state?.currentIndex, 2);
    assert.equal(f.batch.state?.remaining, 2);
  });
});

test('a continuation send failure is reported once and never reruns successful commands', async () => fixture(async (f) => {
  f.add(['A', 'B']); const executing = f.execute(f.accept());
  await f.executor.started(1); f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); await executing;
  let sends = 0;
  const continuation = { assertContext: () => {}, blocker: () => undefined, send: async () => { sends++; throw new Error('model unavailable'); } };
  await f.batch.continueOnce(continuation); await f.batch.continueOnce(continuation);
  assert.equal(sends, 1); assert.equal(f.batch.state?.phase, 'failed');
  assert.equal(f.batch.state?.failureStage, 'continuation');
  assert.match(f.batch.state?.reason ?? '', /model unavailable/u);
  assert.equal(f.executor.calls.length, 2);
  assert.equal(f.store.getPendingProviderTail('s', 'en')?.draftRunIds.length, 2);
}));

test('bulk click emits only the shown IDs and hashes; refreshed batch approval and stop remain keyboard buttons', async () => fixture(async (f) => {
  f.add(['A', 'B']); const ui = renderHarness(f, 'en');
  const button = bulk(ui.render().cards)[0];
  const source = getScript(); new Script(source);
  const start = source.indexOf('    function handleDraftRunActionClick(event)');
  const end = source.indexOf("    transcript.addEventListener('click', handleDraftRunActionClick)", start);
  class ClickTarget { closest() { return button; } }
  const messages: Array<{ type: string; snapshot: DraftRunBatchSnapshot }> = [];
  new Script(source.slice(start, end) + '\nhandleDraftRunActionClick({ target: new Element() });').runInNewContext({
    Element: ClickTarget, pendingDraftRunBatchSnapshot: '', render: () => {}, vscode: { postMessage: (message: typeof messages[number]) => messages.push(message) }
  });
  assert.equal(button.type, 'button'); assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'approveDraftRunBatch');
  assert.deepEqual(JSON.parse(JSON.stringify(messages[0].snapshot)), f.batch.snapshots('s')[0]);
  assert.equal(JSON.stringify(messages[0]).includes('executable'), false);
}));

test('unauthorized cwd is identified beside the disabled batch button and authorization restores it', async () => fixture(async (f) => {
  const external = path.join(f.root, 'external'); await mkdir(external);
  const uri = vscode.Uri.file(external).toString();
  f.store.addProposals({ proposals: [f.proposal('A'), f.proposal('B', { externalCwd: true, cwdUri: uri, cwdLabel: external })], sessionId: 's', agentRunId: 'r' });
  for (const language of ['en', 'zh-CN'] as const) {
    const ui = renderHarness(f, language);
    const cards = ui.render().cards;
    assert.equal(bulk(cards)[0].disabled, true);
    assert.ok(elements(cards).some((item) => item.textContent.includes(external) && item.className === 'draft-run-batch-hint'));
    assert.ok(elements(cards).some((item) => item.dataset.draftRunAction === 'authorizeDraftRunCwd' && !item.disabled));
    ui.state.authorizedExternalExecutionUris.push(uri);
    assert.equal(bulk(ui.render().cards)[0].disabled, false);
  }
}));

test('a current-card stop message arriving between commands cancels the whole Provider batch', async () => fixture(async (f) => {
  f.add(['A', 'B']); const { host, states } = hostFixture(f);
  f.changed.fn = () => {
    if (f.batch.state?.completed === 1 && f.batch.pending) {
      assert.equal(host.activeDraftRunId, undefined);
      void host.handleMessage({ type: 'cancelDraftRun', id: 'A' });
    }
  };
  const executing = host.approveDraftRunBatch(f.batch.snapshots('s')[0]);
  await f.executor.started(1); f.executor.finish('A'); await executing;
  await host.maybeAutoContinueDraftRun();
  assert.equal(f.store.get('B')?.status, 'pending');
  assert.equal(f.executor.calls.length, 1); assert.equal(states.sends, 0);
  assert.equal(f.batch.state?.phase, 'cancelled');
}));

test('model refresh changing selection during batch handoff fails before restoring the old model or creating a message', async () => fixture(async (f) => {
  f.add(['A', 'B']); const executing = f.execute(f.accept());
  await f.executor.started(1); f.executor.finish('A'); await f.executor.started(2); f.executor.finish('B'); await executing;
  const batch = f.batch.state!;
  const session = { id: 's', approvalMode: 'ask', messages: [] };
  const controller = new AbortController();
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    draftRunBatches: f.batch, currentRunAbortController: controller, language: 'en',
    selectedSourceId: 'source', selectedModelId: 'model',
    backgroundRunCoordinator: { getActiveRun: () => undefined },
    sessionStore: { getActiveSession: () => session }, t: (key: string) => key,
    refreshModelSourceState: async () => { host.selectedModelId = 'different'; }
  }) as { selectedModelId: string; sendPromptImpl(prompt: string, sourceId: string, modelId: string, settings: unknown, options: unknown): Promise<unknown> };
  await assert.rejects(host.sendPromptImpl('Continue', 'source', 'model', {}, {
    draftRunBatch: { operationId: batch.operationId, signal: controller.signal }, strictModelSelection: true
  }), /draftRunBatchModelChanged/u);
  assert.equal(host.selectedModelId, 'different'); assert.equal(session.messages.length, 0);
}));

test('Approve for me exposes one host request without a modal or per-draft bypass buttons', async () => fixture(async f => {
  f.add(['A']);
  for (const language of ['en', 'zh-CN'] as const) {
    const ui = renderHarness(f, language);
    Object.assign(ui.state, { approvalMode: 'delegate', activeSessionId: 's',
      manualToolApproval: { id: 'host-runtime-token', sessionId: 's', label: 'file:///external/' + '长中文目标'.repeat(60),
        reason: '<script>untrusted evidence stays literal</script>' } });
    const rendered = ui.render();
    const labels = WEBVIEW_TRANSLATIONS[language];
    const nodes = elements(rendered.cards);
    const approve = nodes.filter(node => node.type === 'button' && node.textContent === labels.approvalConfirmOnce);
    const reject = nodes.filter(node => node.type === 'button' && node.textContent === labels.approvalCancelAction);
    assert.equal(approve.length, 1); assert.equal(reject.length, 1);
    assert.ok(nodes.some(node => node.className === 'approval-state-note' && node.textContent.includes('<script>')));
    assert.ok(!nodes.some(node => node.dataset.draftRunAction === 'approveDraftRun'));
    approve[0].click();
    assert.deepEqual(JSON.parse(JSON.stringify(ui.messages.at(-1))), { type: 'resolveValidationApproval', id: 'host-runtime-token', approve: true });
  }
}));
