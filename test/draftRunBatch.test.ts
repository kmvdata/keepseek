import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
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
import { analyzeDraftRunEffects } from '../src/runs/commandRisk';
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
    const executing = f.batch.execute(id, { authorizedUris: new Set(mode === 'authorized' ? [vscode.Uri.file(external).toString()] : []), assertContext: () => {}, onCurrent: () => {} });
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
  maybeAutoContinueDraftRun(): Promise<void>; maybeAutoContinueBudget(): Promise<boolean>;
  handleMessage(message: unknown): Promise<void>; abortPrompt(): void;
  sendPrompt(prompt: string, source: string, model: string): Promise<AgentResponse | undefined>;
  isBusy: boolean; isStartingRun: boolean; selectedModelId: string;
  activeDraftRunId?: string; repairLoopsBySession: Map<string, unknown>;
  clearSessionTransientState(): void;
};
function hostFixture(f: Awaited<ReturnType<typeof createFixture>>) {
  const session = { id: 's', approvalMode: 'ask', messages: [] as ChatMessage[] };
  const states = { pendingEdits: false, background: false, sends: 0 };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    draftRuns: f.store, draftRunBatches: f.batch, delegatedApprovals: new DelegatedApprovalQueue(),
    isBusy: false, isStartingRun: false, delegatedApprovalInFlight: false, draftRunAutoContinueInFlight: false,
    selectedSourceId: 'source', selectedModelId: 'model', language: 'en', agentSettings: {},
    repairLoopsBySession: new Map(), authorizedExternalReferenceUris: new Set(),
    fileContext: { clear: () => {} },
    changeSets: { hasPendingForSession: () => states.pendingEdits },
    hasActiveBackgroundRun: () => states.background,
    sessionStore: { activeSessionId: 's', getActiveSession: () => session },
    t: (key: string) => key,
    postState: () => {}, postToWebview: () => {}, setAgentActivity: () => {},
    queueBudgetAutoContinuation: () => {},
    sendPromptImpl: async () => { states.sends++; return {} as AgentResponse; }
  }) as Host;
  return { host, states, session };
}

test('Provider holds the batch lock across all commands and blocks duplicate messages, single approval, models and budget continuation', async () => fixture(async (f) => {
  f.add(['A', 'B', 'C']); const { host, states } = hostFixture(f);
  const snapshot = f.batch.snapshots('s')[0];
  const executing = host.approveDraftRunBatch(snapshot); await f.executor.started(1);
  await host.handleMessage({ type: 'approveDraftRunBatch', snapshot });
  await host.handleMessage({ type: 'approveDraftRun', id: 'B', specHash: f.store.get('B')!.specHash, autoContinue: true });
  await host.sendPrompt('new prompt', 'source', 'model');
  assert.equal(await host.maybeAutoContinueBudget(), false);
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
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  className = ''; textContent = ''; disabled = false; type = ''; title = '';
  classList = { toggle: (_name: string, _value: boolean) => {} };
  get childElementCount() { return this.children.length; }
  set innerHTML(_value: string) { this.children = []; }
  append(...children: UiElement[]) { this.children.push(...children); }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
}
function renderHarness(f: Awaited<ReturnType<typeof createFixture>>, language: 'en' | 'zh-CN') {
  const source = getScript();
  const names = ['createDraftRunCard', 'appendDraftRunBatchControls', 'appendDraftRunActions', 'createDraftRunActionButton',
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
    draftRunBatch: f.batch.state, approvalMode: 'ask', isBusy: false, activeDraftRunId: '',
    authorizedExternalReferenceUris: [] as string[], messages: [{ id: 'assistant', role: 'assistant' }] };
  const unlinked = new UiElement();
  const context = { state, document: { createElement: () => new UiElement() },
    pendingDraftRunBatchSnapshot: '', pendingDraftRunActions: new Set(), pendingDraftRunApprovals: new Set(), pendingChangeActions: new Set(),
    formatDuration: String, createDraftEditActionIcon: () => new UiElement(),
    createApprovalSourceSummary: () => new UiElement(), getEditApprovalSourceLabel: String,
    unlinkedChangeSetList: unlinked, unlinkedChangeSetRegion: new UiElement(),
    t: (key: string, values: Record<string, unknown> = {}) => {
      const translations = WEBVIEW_TRANSLATIONS[language] as Record<string, string>;
      return (translations[key] ?? key).replace(/\{(\w+)\}/gu, (_, name) => String(values[name] ?? ''));
    }
  };
  const api = new Script(functions + '\n({ createDraftRunCard, createChangeSetCard, renderUnlinkedChangeSets, buildDraftRunTimelineProjection });').runInNewContext(context) as {
    createDraftRunCard(run: unknown): UiElement; createChangeSetCard(set: unknown): UiElement;
    renderUnlinkedChangeSets(sets: unknown[], runs: unknown[]): void;
    buildDraftRunTimelineProjection(): { byMessageId: Record<string, unknown[]>; unlinked: unknown[] };
  };
  const render = (edits: string[][] = []) => {
    state.draftRuns = f.store.toWebviewState('s'); state.draftRunBatchSnapshots = f.batch.snapshots('s'); state.draftRunBatch = f.batch.state;
    const cards = state.draftRuns.map((run) => api.createDraftRunCard(run));
    const sets = edits.map((statuses, index) => ({ id: 'set-' + index, files: statuses.map((status, i) => ({ id: 'e-' + index + '-' + i, status, label: 'file' + i })) }));
    cards.push(...sets.map((set) => api.createChangeSetCard(set)));
    api.renderUnlinkedChangeSets(sets, state.draftRuns);
    return { cards, sets };
  };
  return { api, state, unlinked, render };
}
function elements(cards: UiElement[]): UiElement[] { return cards.flatMap((card) => [card, ...elements(card.children)]); }
function bulk(cards: UiElement[]) { return elements(cards).filter((item) => item.dataset.draftRunAction === 'approveDraftRunBatch' || item.dataset.changeSetAction === 'applyChangeSet'); }

test('both languages and all card entrances hide bulk actions at 0/1, show counts at 2+, and retain single actions after 2→1', async () => {
  for (const language of ['en', 'zh-CN'] as const) await fixture(async (f) => {
    const ui = renderHarness(f, language);
    assert.equal(bulk(ui.render([[]]).cards).length, 0);
    f.add(['A']);
    assert.equal(bulk(ui.render([['pending']]).cards).length, 0, 'one command plus one edit are not a batch');
    f.add(['B']);
    const initial = ui.render([['pending', 'pending', 'applied', 'discarded']]);
    assert.equal(bulk(initial.cards).length, 2);
    assert.ok(bulk(initial.cards).every((button) => /2/u.test(button.textContent)));
    assert.equal(bulk(ui.unlinked.children).length, 2);
    assert.equal(ui.api.buildDraftRunTimelineProjection().byMessageId.assistant.length, 2);
    const snapshot = JSON.parse(bulk(initial.cards)[0].dataset.batchSnapshot);
    assert.deepEqual(snapshot.entries.map((entry: { draftRunId: string }) => entry.draftRunId), ['A', 'B']);
    assert.equal(snapshot.spec, undefined);
    assert.equal(bulk(initial.cards)[1].dataset.changeSetId, 'set-0');
    f.store.reject('A');
    const reduced = ui.render([['applied', 'pending', 'discarded']]);
    assert.equal(bulk(reduced.cards).length, 0); assert.equal(bulk(ui.unlinked.children).length, 0);
    assert.ok(elements(reduced.cards).some((item) => item.dataset.draftRunAction === 'approveDraftRun' && item.dataset.draftRunId === 'B' && !item.disabled));
    assert.ok(elements(reduced.cards).some((item) => item.dataset.editAction === 'applyDraftEdit' && !item.disabled));
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
    args: ['-i', '', '-e', 's/kmvpy\\.common\\.kore/kmvpy.common.kmv/g', 'path with spaces/file.py', "it's.py"]
  };
  f.store.addProposals({
    proposals: [{ id: 'display-command', spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) }],
    sessionId: 's',
    agentRunId: 'r',
    messageId: 'assistant'
  });

  const ui = renderHarness(f, 'zh-CN');
  const card = ui.render().cards[0];
  const fields = elements([card]).filter((item) => item.className === 'draft-run-field');
  assert.equal(fields[0]?.children[0]?.textContent, '完整命令');
  assert.equal(
    fields[0]?.children[1]?.textContent,
    "/usr/bin/sed -i '' -e 's/kmvpy\\.common\\.kore/kmvpy.common.kmv/g' 'path with spaces/file.py' 'it'\"'\"'s.py'"
  );
  assert.equal(fields.some((field) => field.children[0]?.textContent === '可执行文件' || field.children[0]?.textContent === '完整参数'), false);
  assert.deepEqual(f.store.get('display-command')?.spec, spec);
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
  for (const mode of ['delegate', 'model_review']) { ui.state.approvalMode = mode; assert.equal(bulk(ui.render().cards).length, 0); }
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
    const authorizedUris = new Set([uri]);
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
    ui.state.authorizedExternalReferenceUris.push(uri);
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
