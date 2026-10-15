import './registerVscodeStub';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { DraftRunBatchCoordinator } from '../src/runs/draftRunBatchCoordinator';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { analyzeDraftRunEffects } from '../src/runs/commandRisk';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import type { DraftRunExecutorAdapter, DraftRunExecutionOutcome } from '../src/runs/draftRunExecutor';
import type { DraftRunProposal, DraftRunSpec } from '../src/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const success: DraftRunExecutionOutcome = { exitCode: 0, timedOut: false, cancelled: false };

class DisplayTestExecutor implements DraftRunExecutorAdapter {
  calls: string[] = [];
  private gates = new Map<string, ReturnType<typeof deferred<DraftRunExecutionOutcome>>>();
  private starts = new Map<number, ReturnType<typeof deferred<void>>>();

  async execute(input: Parameters<DraftRunExecutorAdapter['execute']>[0]) {
    this.calls.push(input.draftRun.id);
    const gate = deferred<DraftRunExecutionOutcome>();
    this.gates.set(input.draftRun.id, gate);
    const abort = () => gate.resolve({ timedOut: false, cancelled: true });
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    this.starts.get(this.calls.length)?.resolve();
    try { return await gate.promise; }
    finally { input.signal?.removeEventListener('abort', abort); }
  }

  async started(count: number) {
    if (this.calls.length >= count) return;
    const gate = deferred<void>();
    this.starts.set(count, gate);
    await gate.promise;
  }

  finish(id: string, outcome = success) { this.gates.get(id)!.resolve(outcome); }
  cancel(id: string) { this.gates.get(id)?.resolve({ timedOut: false, cancelled: true }); return this.gates.has(id); }
  showTerminal() { return true; }
  dispose() { for (const gate of this.gates.values()) gate.resolve({ timedOut: false, cancelled: true }); }
}

async function fixture(run: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const f = await createFixture();
  try { await run(f); }
  finally {
    f.batch.cancel();
    f.store.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.store.flush();
    vscode.workspace.workspaceFolders = [];
    vscode.workspace.isTrusted = true;
    await rm(f.root, { recursive: true, force: true });
  }
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-batch-display-'));
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'workspace' }];
  vscode.workspace.isTrusted = true;
  const storage = vscode.Uri.file(path.join(root, 'storage'));
  const executor = new DisplayTestExecutor();
  const store = new DraftRunStore(storage as unknown as import('vscode').Uri, executor);
  const batch = new DraftRunBatchCoordinator(store);
  const proposal = (id: string): DraftRunProposal => {
    const spec: DraftRunSpec = {
      executable: 'node', args: [id], reason: id,
      cwdUri: vscode.Uri.file(workspaceRoot).toString(), cwdLabel: '.',
      externalCwd: false, env: [], timeoutMs: 120000
    };
    return { id, spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) };
  };
  const add = (ids: string[], sessionId = 's', agentRunId = 'r', messageId = 'assistant') => store.addProposals({
    proposals: ids.map(proposal), sessionId, agentRunId, messageId
  });
  const accept = (sessionId = 's', agentRunId = 'r') => batch.accept(
    batch.snapshots(sessionId).find((snapshot) => snapshot.agentRunId === agentRunId)!,
    { sessionId, sourceId: 'source', modelId: 'model' }
  );
  const execute = (operationId: string) => batch.execute(operationId, {
    authorizedUris: new Set(), assertContext: () => {}, onCurrent: () => {}
  });
  const readStored = async () => JSON.parse(await readFile(path.join(storage.fsPath, 'draft-runs.json'), 'utf8'));
  const restore = async (serialized?: unknown) => {
    const destination = vscode.Uri.file(path.join(root, 'restore-' + Math.random().toString(16).slice(2)));
    await mkdir(destination.fsPath);
    await writeFile(path.join(destination.fsPath, 'draft-runs.json'), JSON.stringify(serialized ?? await readStored()));
    const restoredExecutor = new DisplayTestExecutor();
    const restored = new DraftRunStore(destination as unknown as import('vscode').Uri, restoredExecutor);
    await restored.initialize();
    return { restored, restoredExecutor, destination };
  };
  return { root, storage, executor, store, batch, proposal, add, accept, execute, readStored, restore };
}

test('batch display follows real queued/running/waiting/continuing/completed transitions and keeps ordered original members', async () => fixture(async (f) => {
  f.add(['z-A'], 's', 'r', 'message-one');
  f.add(['a-B'], 's', 'r', 'message-two');
  f.add(['m-C'], 's', 'r', '');
  const offered = f.batch.snapshots('s')[0];
  assert.deepEqual(f.store.toBatchDisplayHistory('s'), [], 'an offer is not a past approval');
  const operationId = f.accept();
  const expectedEntries = offered.entries;
  assert.equal(f.store.toBatchDisplayHistory('s')[0].phase, 'queued');
  assert.equal(f.store.toBatchDisplayHistory('s')[0].snapshotId, offered.snapshotId);
  assert.equal(f.store.toBatchDisplayHistory('s')[0].operationId, operationId);
  const executing = f.execute(operationId);
  for (const [index, id] of ['z-A', 'a-B', 'm-C'].entries()) {
    await f.executor.started(index + 1);
    const display = f.store.toBatchDisplayHistory('s')[0];
    assert.equal(display.phase, 'running');
    assert.equal(display.currentIndex, index + 1);
    assert.deepEqual(display.entries, expectedEntries, 'completed members stay in the display');
    assert.equal(display.completed, index);
    f.executor.finish(id);
  }
  await executing;
  assert.equal(f.store.toBatchDisplayHistory('s')[0].phase, 'waiting');
  f.batch.wait('pending edit');
  assert.equal(f.store.toBatchDisplayHistory('s')[0].reason, 'pending edit');
  let sends = 0;
  const sendStarted = deferred<void>();
  const sendFinished = deferred<boolean>();
  const continuing = f.batch.continueOnce({
    assertContext: () => {}, blocker: () => undefined,
    send: async () => { sends++; sendStarted.resolve(); return sendFinished.promise; }
  });
  await sendStarted.promise;
  assert.equal(f.store.toBatchDisplayHistory('s')[0].phase, 'continuing');
  sendFinished.resolve(true);
  await continuing;
  await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => { sends++; return true; } });
  assert.equal(sends, 1);
  const display = f.store.toBatchDisplayHistory('s')[0];
  assert.equal(display.phase, 'completed');
  assert.equal(display.completed, 3);
  assert.equal(display.remaining, 0);
  assert.deepEqual(display.entries, expectedEntries);
  assert.equal('sourceId' in display, false);
  assert.equal('modelId' in display, false);
  display.entries.reverse();
  assert.deepEqual(f.store.toBatchDisplayHistory('s')[0].entries, expectedEntries, 'projection is an immutable copy');
}));

test('failed and cancelled batches retain unfinished members when remaining commands receive a new approval', async () => {
  for (const stop of ['failed', 'cancelled']) await fixture(async (f) => {
    f.add(['old', 'A', 'B', 'C', 'D']);
    const old = f.store.approveAndRun('old', new Set());
    await f.executor.started(1); f.executor.finish('old'); await old;
    const firstId = f.accept();
    const executing = f.execute(firstId);
    await f.executor.started(2); f.executor.finish('A');
    await f.executor.started(3);
    if (stop === 'failed') f.executor.finish('B', { ...success, exitCode: 2 });
    else f.batch.cancel(firstId);
    await executing;
    const firstDisplay = f.store.toBatchDisplayHistory('s')[0];
    assert.equal(firstDisplay.phase, stop);
    assert.equal(firstDisplay.completed, 1);
    assert.equal(firstDisplay.remaining, 2);
    assert.deepEqual(firstDisplay.entries.map((entry) => entry.draftRunId), ['A', 'B', 'C', 'D']);
    assert.equal(f.store.get('C')?.status, 'pending');
    assert.equal(f.store.get('D')?.status, 'pending');
    const secondId = f.accept();
    assert.notEqual(firstId, secondId);
    const clone = f.store.cloneAsPending('old')!;
    const secondExecution = f.execute(secondId);
    // A new pending clone invalidates the finite snapshot before the retry can start.
    await secondExecution;
    assert.equal(f.executor.calls.length, 3);
    f.store.reject(clone.id);
    const retryId = f.accept();
    const retrying = f.execute(retryId);
    await f.executor.started(4); f.executor.finish('C');
    await f.executor.started(5); f.executor.finish('D'); await retrying;
    await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => true });
    const history = f.store.toBatchDisplayHistory('s');
    assert.deepEqual(history.map((display) => display.operationId), [firstId, secondId, retryId]);
    assert.deepEqual(history[0], firstDisplay, 'later results never rewrite an earlier batch summary');
    assert.equal(history[1].phase, 'failed');
    assert.deepEqual(history[2].entries.map((entry) => entry.draftRunId), ['C', 'D']);
    assert.equal(history[2].phase, 'completed');
    assert.equal(history.some((display) => display.entries.some((entry) => ['old', clone.id].includes(entry.draftRunId))), false);
    assert.deepEqual(f.store.toBatchDisplayHistory('other-session'), []);
  });
});

test('restarting an active batch preserves display membership but restores no execution or continuation authority', async () => fixture(async (f) => {
  f.add(['A', 'B', 'C']);
  const operationId = f.accept();
  const executing = f.execute(operationId);
  await f.executor.started(1);
  await f.store.flush();
  const { restored, restoredExecutor } = await f.restore();
  try {
    const [display] = restored.toBatchDisplayHistory('s');
    assert.equal(display.phase, 'interrupted');
    assert.deepEqual(display.entries.map((entry) => entry.draftRunId), ['A', 'B', 'C']);
    assert.equal(display.currentCommand, undefined);
    assert.equal(display.reason, undefined);
    assert.equal(restored.get('A')?.status, 'failed');
    assert.equal(restored.get('B')?.status, 'pending');
    const coordinator = new DraftRunBatchCoordinator(restored);
    assert.equal(coordinator.state, undefined);
    assert.equal(coordinator.pending, false);
    assert.equal(coordinator.isValid(operationId), false);
    assert.equal(restored.claimReadyAutoContinuation('s'), undefined);
    await coordinator.execute(operationId, { authorizedUris: new Set(), assertContext: () => {}, onCurrent: () => {} });
    await coordinator.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => { assert.fail('history cannot resume'); } });
    assert.deepEqual(restoredExecutor.calls, []);
    assert.deepEqual(coordinator.snapshots('s')[0].entries.map((entry) => entry.draftRunId), ['B', 'C']);
  } finally { restored.dispose(); f.batch.cancel(); await executing; }
}));

test('completed display survives new batches, session changes and restart without restoring automatic continuation', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  const firstId = f.accept();
  const executing = f.execute(firstId);
  await f.executor.started(1); f.executor.finish('A');
  await f.executor.started(2); f.executor.finish('B'); await executing;
  await f.batch.continueOnce({ assertContext: () => {}, blocker: () => undefined, send: async () => true });
  f.add(['C', 'D'], 'other-session', 'other-run');
  const secondId = f.accept('other-session', 'other-run');
  assert.equal(f.store.toBatchDisplayHistory('s')[0].operationId, firstId);
  assert.equal(f.store.toBatchDisplayHistory('s')[0].phase, 'completed');
  assert.equal(f.store.toBatchDisplayHistory('other-session')[0].operationId, secondId);
  await f.store.flush();
  const serialized = await f.readStored();
  for (const display of serialized.batchDisplays) {
    assert.equal('sourceId' in display, false);
    assert.equal('modelId' in display, false);
    assert.equal('controller' in display, false);
    assert.equal('permit' in display, false);
  }
  const { restored, restoredExecutor, destination } = await f.restore(serialized);
  try {
    assert.equal(restored.toBatchDisplayHistory('s')[0].phase, 'completed');
    assert.equal(restored.toBatchDisplayHistory('other-session')[0].phase, 'interrupted');
    assert.equal(restored.claimReadyAutoContinuation('s'), undefined);
    assert.equal(new DraftRunBatchCoordinator(restored).state, undefined);
    assert.deepEqual(restoredExecutor.calls, []);
    restored.clearSession('s');
    await restored.flush();
    assert.deepEqual(restored.toBatchDisplayHistory('s'), []);
    assert.equal(restored.toBatchDisplayHistory('other-session').length, 1);
    const cleared = JSON.parse(await readFile(path.join(destination.fsPath, 'draft-runs.json'), 'utf8'));
    assert.equal(cleared.batchDisplays.some((display: { sessionId: string }) => display.sessionId === 's'), false);
  } finally { restored.dispose(); }
}));

test('legacy and malformed display records are conservative and do not infer membership from the run id', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  f.accept();
  f.batch.cancel();
  await f.store.flush();
  const serialized = await f.readStored();
  const valid = serialized.batchDisplays[0];
  const legacy = { version: 1, draftRuns: serialized.draftRuns };
  const cases: unknown[] = [
    undefined, null, {}, 'invalid', [null],
    [{ ...valid, operationId: '' }], [{ ...valid, snapshotId: '' }],
    [{ ...valid, sessionId: 'wrong-session' }], [{ ...valid, agentRunId: 'wrong-run' }],
    [{ ...valid, phase: 'approved' }], [{ ...valid, entries: [] }],
    [{ ...valid, entries: [valid.entries[0], valid.entries[0]] }],
    [{ ...valid, entries: valid.entries.map((entry: object) => ({ ...entry, specHash: 'wrong-hash' })) }],
    [{ ...valid, entries: valid.entries.map((entry: object, index: number) => ({ ...entry, draftRunId: 'missing-' + index })) }],
    [valid, { ...valid }],
    [valid, { ...valid, operationId: 'another-operation' }]
  ];
  for (const batchDisplays of cases) {
    const { restored, restoredExecutor } = await f.restore({ ...legacy, batchDisplays });
    try {
      assert.deepEqual(restored.toBatchDisplayHistory('s'), [], JSON.stringify(batchDisplays));
      assert.deepEqual(restored.toWebviewState('s').map((run) => run.id), ['A', 'B'], 'invalid display metadata cannot hide commands');
      assert.deepEqual(restoredExecutor.calls, []);
    } finally { restored.dispose(); }
  }
  const { restored } = await f.restore(legacy);
  try { assert.deepEqual(restored.toBatchDisplayHistory('s'), []); }
  finally { restored.dispose(); }
}));

test('restart downgrades uncertain display phases and contradictory completion while stripping unknown permission fields', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  f.accept(); f.batch.cancel(); await f.store.flush();
  const serialized = await f.readStored();
  const base = serialized.batchDisplays[0];
  for (const phase of ['queued', 'running', 'waiting', 'continuing', 'completed']) {
    const { restored } = await f.restore({ ...serialized, batchDisplays: [{
      ...base, phase, currentCommand: 'node', reason: 'unconfirmed',
      sourceId: 'must-not-survive', modelId: 'must-not-survive', permit: { nonce: 'forged' },
      completed: 2, remaining: 0
    }] });
    try {
      const [display] = restored.toBatchDisplayHistory('s');
      assert.equal(display.phase, 'interrupted', phase);
      assert.equal(display.currentCommand, undefined);
      assert.equal(display.reason, undefined);
      assert.equal('sourceId' in display, false);
      assert.equal('permit' in display, false);
    } finally { restored.dispose(); }
  }
}));

test('display retention is bounded and preserves original membership when a stored command has expired', async () => fixture(async (f) => {
  f.add(['A', 'B']);
  f.accept(); f.batch.cancel(); await f.store.flush();
  const serialized = await f.readStored();
  const base = serialized.batchDisplays[0];
  const records = Array.from({ length: 502 }, (_, index) => ({
    ...base, operationId: 'operation-' + index, snapshotId: 'snapshot-' + index
  }));
  const { restored, destination } = await f.restore({ ...serialized, batchDisplays: records });
  try {
    assert.equal(restored.toBatchDisplayHistory('s').length, 500);
    await restored.flush();
    const bounded = JSON.parse(await readFile(path.join(destination.fsPath, 'draft-runs.json'), 'utf8'));
    assert.equal(bounded.batchDisplays.length, 500);
  } finally { restored.dispose(); }
  const { restored: partial, destination: partialDestination } = await f.restore({
    ...serialized, draftRuns: serialized.draftRuns.filter((run: { id: string }) => run.id === 'B')
  });
  try {
    assert.deepEqual(partial.toBatchDisplayHistory('s')[0].entries.map((entry) => entry.draftRunId), ['A', 'B']);
    await partial.flush();
    const persisted = JSON.parse(await readFile(path.join(partialDestination.fsPath, 'draft-runs.json'), 'utf8'));
    assert.deepEqual(persisted.batchDisplays[0].entries, base.entries, 'retention must not turn a multi-member approval into a new single-member record');
    partial.clearSession('s');
    await partial.flush();
    const cleared = JSON.parse(await readFile(path.join(partialDestination.fsPath, 'draft-runs.json'), 'utf8'));
    assert.deepEqual(cleared.batchDisplays, []);
  } finally { partial.dispose(); }
}));
