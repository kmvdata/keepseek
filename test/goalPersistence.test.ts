import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import * as vscode from 'vscode';
import { GoalLease } from '../src/agent/goals/goalLease';
import { GoalCoordinator } from '../src/agent/goals/goalCoordinator';
import { GoalCompletionReviewService } from '../src/agent/goals/goalCompletionReview';
import { hashGoalContract } from '../src/agent/goals/goalContract';
import { classifyGoalRecovery, goalResumeBlocker, type GoalRecoveryContext } from '../src/agent/goals/goalRecovery';
import { GoalStore, GoalStoreCorruptionError } from '../src/agent/goals/goalStore';
import { transitionGoal } from '../src/agent/goals/goalStateMachine';
import { contract } from './goalDomain.test';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GoalStore', () => {
  test('atomically persists one active Goal and ordered journal shards', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    let record = await store.create({
      id: 'goal-one', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'Goal: test', expandedContent: 'Goal: test', providerContent: 'Goal: test\nTAIL' },
      now: '2026-01-01T00:00:00.000Z'
    });
    record = await store.append(record, 'first', { n: 1 }, '2026-01-01T00:00:01.000Z');
    const stale = structuredClone(record);
    record = await store.append(record, 'second', { n: 2 }, '2026-01-01T00:00:02.000Z');
    assert.deepEqual((await store.readJournal(record)).map((event) => [event.sequence, event.type]), [[1, 'first'], [2, 'second']]);
    await assert.rejects(() => store.append(stale, 'stale', {}), /Stale Goal/u);
    await assert.rejects(() => store.create({
      id: 'goal-two', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    }), /Only one active Goal/u);
  });

  test('recovers the latest immutable verified snapshot when the index is missing', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    let record = await store.create({
      id: 'recoverable', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    record = await store.append(record, 'persisted', { ok: true });
    await writeFile(join(root, 'goals/v1/records/recoverable/snapshots', `${'f'.repeat(64)}.json`), '{broken', 'utf8');
    await unlink(join(root, 'goals/v1/index.json'));
    const recovered = await new GoalStore(vscode.Uri.file(root)).loadWorkspace('workspace');
    assert.equal(recovered?.nextJournalSequence, record.nextJournalSequence);
    assert.equal(recovered?.journalShards.length, 1);
  });

  test('falls back to the last verified snapshot when a valid index points at a damaged generation', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    let record = await store.create({
      id: 'generation-fallback', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    record = await store.append(record, 'latest', { value: 2 });
    const index = JSON.parse(await readFile(join(root, 'goals/v1/index.json'), 'utf8')) as {
      entries: Array<{ snapshotFile: string }>;
    };
    await writeFile(join(root, 'goals/v1/records/generation-fallback', index.entries[0]!.snapshotFile), '{damaged', 'utf8');
    const recovered = await new GoalStore(vscode.Uri.file(root)).loadWorkspace('workspace');
    assert.equal(recovered?.nextJournalSequence, 1);
    assert.deepEqual(recovered?.journalShards, []);
  });

  test('fails closed when an index and all persisted snapshots are damaged', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    await store.create({
      id: 'damaged', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    await writeFile(join(root, 'goals/v1/index.json'), '{bad', 'utf8');
    const snapshots = join(root, 'goals/v1/records/damaged/snapshots');
    await rm(snapshots, { recursive: true, force: true });
    await assert.rejects(() => new GoalStore(vscode.Uri.file(root)).initialize(), GoalStoreCorruptionError);
  });

  test('clear rejects non-terminal records and removes terminal records only', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    let record = await store.create({
      id: 'clearable', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    await assert.rejects(() => store.clear(record.id), /Only completed, failed, or stopped/u);
    record = transitionGoal(record, 'stopped');
    await store.save(record);
    await store.clear(record.id);
    assert.equal(await store.loadWorkspace('workspace'), undefined);
  });

  test('reads early V1 snapshots without storageRevision and upgrades on the next write', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const created = await store.create({
      id: 'legacy-revision', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    const indexPath = join(root, 'goals/v1/index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Array<{ snapshotHash: string; snapshotFile: string }>;
    };
    const currentPath = join(root, 'goals/v1/records/legacy-revision', index.entries[0]!.snapshotFile);
    const snapshot = JSON.parse(await readFile(currentPath, 'utf8')) as { version: 1; recordHash: string; record: typeof created };
    delete snapshot.record.storageRevision;
    snapshot.recordHash = createHash('sha256').update(JSON.stringify(snapshot.record), 'utf8').digest('hex');
    const snapshotFile = `snapshots/${snapshot.recordHash}.json`;
    await writeFile(join(root, 'goals/v1/records/legacy-revision', snapshotFile), JSON.stringify(snapshot), 'utf8');
    index.entries[0]!.snapshotHash = snapshot.recordHash;
    index.entries[0]!.snapshotFile = snapshotFile;
    await writeFile(indexPath, JSON.stringify(index), 'utf8');

    const restarted = new GoalStore(vscode.Uri.file(root));
    const legacy = await restarted.loadWorkspace('workspace');
    assert.equal(legacy?.storageRevision, undefined);
    const stopped = await restarted.save(transitionGoal(legacy!, 'stopped'));
    assert.equal(stopped.storageRevision, 1);
  });

  test('non-file storage uses the Extension Host path to serialize stores across windows', async () => {
    const root = await tempRoot();
    const storageUri = vscode.Uri.file(root).with({ scheme: 'vscode-userdata' });
    const first = new GoalStore(storageUri, root);
    const second = new GoalStore(storageUri, root);
    await Promise.all([first.initialize(), second.initialize()]);
    await first.create({
      id: 'first-window', workspaceKey: 'workspace', sessionId: 'session-one', contract: contract(),
      initialPrompt: { visibleContent: 'first', expandedContent: 'first', providerContent: 'first' }
    });
    await assert.rejects(() => second.create({
      id: 'second-window', workspaceKey: 'workspace', sessionId: 'session-two', contract: contract(),
      initialPrompt: { visibleContent: 'second', expandedContent: 'second', providerContent: 'second' }
    }), /Only one active Goal/u);
    assert.equal((await second.loadWorkspace('workspace'))?.id, 'first-window');
  });
});

describe('Goal lease and recovery', () => {
  test('stop and clear release the workspace slot so a new session can create a fresh Goal', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const states: Array<string | undefined> = [];
    const lease = {
      workspaceKey: 'workspace', release: async () => undefined
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => undefined,
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); },
      onStateChanged: (record) => states.push(record?.id)
    });
    await coordinator.create(contract({ objective: 'First Goal' }), 'session-one', {
      visibleContent: 'Goal: first', expandedContent: 'Goal: first', providerContent: 'Goal: first\nTAIL'
    });
    await coordinator.stop('finished with the first Goal');
    await coordinator.clear();
    assert.equal(coordinator.current, undefined);
    assert.equal(states.at(-1), undefined);
    const second = await coordinator.create(contract({ objective: 'Second Goal' }), 'session-two', {
      visibleContent: 'Goal: second', expandedContent: 'Goal: second', providerContent: 'Goal: second\nTAIL'
    });
    assert.equal(second.sessionId, 'session-two');
    assert.equal(second.id === 'goal-one', false);
    assert.equal((await store.loadWorkspace('workspace'))?.id, second.id);
  });

  test('stop during lease acquisition cannot revive or dispatch a preparing Goal', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    let finishAcquire!: (value: Awaited<ReturnType<GoalLease['acquire']>>) => void;
    const acquire = new Promise<Awaited<ReturnType<GoalLease['acquire']>>>((resolve) => { finishAcquire = resolve; });
    let dispatches = 0;
    let releases = 0;
    const lease = {
      workspaceKey: 'workspace',
      acquire: async () => await acquire,
      release: async () => { releases++; },
      startHeartbeat: () => undefined,
      confirm: async () => true,
      get binding() { return { ownerId: 'owner', fencingToken: 1 }; }
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => { dispatches++; return undefined; },
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); }
    });
    await store.initialize();
    await coordinator.create(contract(), 'session', {
      visibleContent: 'Goal: test', expandedContent: 'Goal: test', providerContent: 'Goal: test\nTAIL'
    });
    const starting = coordinator.start();
    await Promise.resolve();
    await coordinator.stop('cancelled while preparing');
    finishAcquire({
      acquired: true,
      lease: { version: 1, workspaceKey: 'workspace', ownerId: 'owner', fencingToken: 1, heartbeatAt: 1, expiresAt: 2 }
    });
    await starting;
    assert.equal(coordinator.current?.status, 'stopped');
    assert.equal(dispatches, 0);
    assert.ok(releases >= 2);
  });

  test('stop retries a concurrent snapshot revision and remains user-cancelable', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const lease = {
      workspaceKey: 'workspace', release: async () => undefined
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => undefined,
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); }
    });
    await coordinator.create(contract(), 'session', {
      visibleContent: 'Goal: test', expandedContent: 'Goal: test', providerContent: 'Goal: test\nTAIL'
    });
    const concurrent = coordinator.current!;
    concurrent.usage.activeExecutionMs = 1;
    await store.save(concurrent);
    await coordinator.stop('cancel after concurrent save');
    assert.equal(coordinator.current?.status, 'stopped');
  });

  test('manual resume reacquires the lease, restarts heartbeat, and dispatches exactly once', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const created = await store.create({
      id: 'resumable', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    await store.save(transitionGoal(created, 'interrupted', { reason: 'host restarted' }));
    let held = false;
    let dispatches = 0;
    let heartbeats = 0;
    let acquireCalls = 0;
    const leaseWaits: number[] = [];
    const lease = {
      workspaceKey: 'workspace',
      confirm: async () => held,
      acquire: async () => {
        acquireCalls++;
        if (acquireCalls === 1) return { acquired: false, reason: 'held' as const, retryAfterMs: 1 };
        held = true;
        return { acquired: true, lease: { ownerId: 'owner', fencingToken: 3 } };
      },
      release: async () => { held = false; },
      startHeartbeat: () => { heartbeats++; },
      get binding() { return held ? { ownerId: 'owner', fencingToken: 3 } : undefined; }
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => { dispatches++; return undefined; },
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); },
      onLeaseWait: (retryAfterMs) => leaseWaits.push(retryAfterMs)
    });
    await coordinator.initialize();
    const firstResume = coordinator.resume();
    const duplicateResume = coordinator.resume();
    await Promise.all([firstResume, duplicateResume]);
    assert.equal(dispatches, 1);
    assert.equal(heartbeats, 1);
    assert.equal(acquireCalls, 2);
    assert.deepEqual(leaseWaits, [1]);
    assert.equal(coordinator.current?.status, 'needs_attention');
  });

  test('resume reports a live competing window without rewriting the recovery record', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const created = await store.create({
      id: 'live-owner', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    const interrupted = await store.save(transitionGoal(created, 'interrupted', { reason: 'host restarted' }));
    let acquireCalls = 0;
    const lease = {
      workspaceKey: 'workspace',
      confirm: async () => false,
      acquire: async () => {
        acquireCalls++;
        return { acquired: false, reason: 'held' as const, retryAfterMs: 1 };
      },
      release: async () => undefined
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => { throw new Error('not reached'); },
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); }
    });
    await coordinator.initialize();
    await assert.rejects(() => coordinator.resume(), /Another VS Code window is actively running/u);
    assert.equal(acquireCalls, 2);
    assert.equal(coordinator.current?.status, 'interrupted');
    const persisted = await store.load(interrupted.id);
    assert.equal(persisted?.status, interrupted.status);
    assert.equal(persisted?.storageRevision, interrupted.storageRevision);
    assert.equal(persisted?.nextJournalSequence, interrupted.nextJournalSequence);
    assert.equal(persisted?.stopReason, interrupted.stopReason);
  });

  test('stop cancels an orphan-lease wait before takeover or dispatch', async () => {
    const root = await tempRoot();
    const store = new GoalStore(vscode.Uri.file(root));
    const created = await store.create({
      id: 'cancel-wait', workspaceKey: 'workspace', sessionId: 'session', contract: contract(),
      initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }
    });
    await store.save(transitionGoal(created, 'interrupted', { reason: 'host restarted' }));
    let acquireCalls = 0;
    let dispatches = 0;
    let notifyWait!: () => void;
    const waiting = new Promise<void>((resolve) => { notifyWait = resolve; });
    const lease = {
      workspaceKey: 'workspace',
      confirm: async () => false,
      acquire: async () => {
        acquireCalls++;
        return { acquired: false, reason: 'held' as const, retryAfterMs: 30_000 };
      },
      release: async () => undefined
    } as unknown as GoalLease;
    const coordinator = new GoalCoordinator(store, lease, new GoalCompletionReviewService(), {
      dispatchAttempt: async () => { dispatches++; return undefined; },
      completionSafety: async () => { throw new Error('not reached'); },
      completionReviewerContext: async () => { throw new Error('not reached'); },
      onLeaseWait: () => notifyWait()
    });
    await coordinator.initialize();
    const resuming = coordinator.resume();
    await waiting;
    await coordinator.stop('cancelled while waiting for the old lease');
    await resuming;
    assert.equal(acquireCalls, 1);
    assert.equal(dispatches, 0);
    assert.equal(coordinator.current?.status, 'stopped');
  });

  test('fences two coordinators, heartbeats, and permits explicit stale takeover only', async () => {
    const root = await tempRoot();
    let now = 1_000;
    const first = new GoalLease(vscode.Uri.file(root), 'workspace', { ownerId: 'owner-a', ttlMs: 300, now: () => now });
    const second = new GoalLease(vscode.Uri.file(root), 'workspace', { ownerId: 'owner-b', ttlMs: 300, now: () => now });
    const acquired = await first.acquire();
    assert.equal(acquired.acquired, true);
    const initiallyHeld = await second.acquire();
    assert.equal(initiallyHeld.reason, 'held');
    assert.equal(initiallyHeld.retryAfterMs, 300);
    now += 100;
    assert.equal(await first.heartbeat(), true);
    now += 301;
    assert.equal((await second.acquire()).reason, 'held');
    const takeover = await second.acquire({ allowStaleTakeover: true, confirmState: async () => true });
    assert.equal(takeover.acquired, true);
    assert.ok((takeover.lease?.fencingToken ?? 0) > (acquired.lease?.fencingToken ?? 0));
    assert.equal(await first.confirm(), false);
    assert.equal(await second.confirm(), true);
  });

  test('refuses non-file storage rather than pretending to have exclusivity', async () => {
    const lease = new GoalLease(vscode.Uri.parse('memory:/storage'), 'workspace');
    assert.deepEqual(await lease.acquire(), { acquired: false, reason: 'unsupported_storage' });
  });

  test('uses the Extension Host absolute storage path for a non-file storage URI', async () => {
    const root = await tempRoot();
    let now = 1_000;
    const storageUri = vscode.Uri.parse('vscode-userdata:/globalStorage/keepseek');
    const first = new GoalLease(storageUri, 'workspace', {
      ownerId: 'owner-a', ttlMs: 300, now: () => now, nativeStoragePath: root
    });
    const second = new GoalLease(storageUri, 'workspace', {
      ownerId: 'owner-b', ttlMs: 300, now: () => now, nativeStoragePath: root
    });
    assert.equal(first.supported, true);
    assert.equal((await first.acquire()).acquired, true);
    assert.equal((await second.acquire()).reason, 'held');
    now += 301;
    const takeover = await second.acquire({ allowStaleTakeover: true, confirmState: async () => true });
    assert.equal(takeover.acquired, true);
    assert.equal(await first.confirm(), false);
    assert.equal(await second.confirm(), true);
  });

  test('restart invalidates validation proof and requires manual recovery', () => {
    const value = contract();
    const record = transitionGoal({
      ...createMinimalRecord(value),
      validations: [{ script: 'compile', status: 'passed', mutationRevision: 0, completedAt: '2026-01-01T00:00:00.000Z' }],
      criteria: [{ criterionId: 'criterion-1', status: 'satisfied', evidenceRefs: ['evidence'], evidenceManifestHash: 'manifest' }]
    }, 'running');
    const result = classifyGoalRecovery(record, recoveryContext(value));
    assert.equal(result.record.status, 'interrupted');
    assert.equal(result.autoResume, false);
    assert.deepEqual(result.record.validations, []);
    assert.equal(result.record.criteria[0]?.status, 'pending');
  });

  test('auto resume is activation-only and refuses uncertainty or pending approval', () => {
    const value = contract();
    value.resumePolicy = 'auto_on_activation';
    value.canonicalHash = createHashForMutatedContract(value);
    const record = transitionGoal(createMinimalRecord(value), 'running');
    const allowed = classifyGoalRecovery(record, recoveryContext(value, { autoResumeEnabled: true }));
    assert.equal(allowed.autoResume, true);
    const uncertain = classifyGoalRecovery(record, recoveryContext(value, { autoResumeEnabled: true, hasUncertainDraftRun: true }));
    assert.equal(uncertain.autoResume, false);
    assert.equal(uncertain.record.status, 'needs_attention');
  });

  test('fails closed when the v10 session/checkpoint binding or exact initial message cannot be verified', () => {
    const value = contract();
    const record = transitionGoal(createMinimalRecord(value), 'running');
    for (const overrides of [
      { checkpointValid: false },
      { checkpointValid: true, sourceId: 'changed-source' },
      { checkpointValid: true, workspaceTrusted: false }
    ]) {
      const result = classifyGoalRecovery(record, recoveryContext(value, overrides));
      assert.equal(result.autoResume, false);
      assert.equal(result.record.status, 'needs_attention');
    }
  });

  test('explicit resume rechecks safety without replaying activation invalidation', () => {
    const value = contract();
    const record = transitionGoal({
      ...createMinimalRecord(value),
      validations: [{ script: 'compile', status: 'passed', mutationRevision: 0, completedAt: '2026-01-01T00:00:00.000Z' }],
      criteria: [{ criterionId: 'criterion-1', status: 'satisfied', evidenceRefs: ['evidence'], evidenceManifestHash: 'manifest' }]
    }, 'paused');
    const original = structuredClone(record);
    assert.equal(goalResumeBlocker(record, recoveryContext(value)), undefined);
    assert.deepEqual(record, original);
    assert.match(goalResumeBlocker(record, recoveryContext(value, { hasUncertainToolResult: true })) ?? '', /unknown terminal state/u);
    assert.match(goalResumeBlocker(record, recoveryContext(value, { hasExternalAuthorizationRequirement: true })) ?? '', /authorization/u);
    assert.match(goalResumeBlocker(record, recoveryContext(value, { canAcquireLease: false })) ?? '', /cannot guarantee exclusive/u);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-goal-test-'));
  roots.push(root);
  return root;
}

function createMinimalRecord(value: ReturnType<typeof contract>) {
  return {
    version: 1 as const, id: 'goal', workspaceKey: 'workspace', sessionId: 'session',
    initialPrompt: { visibleContent: 'x', expandedContent: 'x', providerContent: 'x' }, requiredExternalAuthorizationUris: [],
    status: 'preparing' as const, revisions: [{ revision: 1, contract: value, createdAt: '2026-01-01T00:00:00.000Z' }],
    currentRevision: 1, currentContractHash: value.canonicalHash,
    usage: { activeExecutionMs: 0, costByCurrency: {}, modelRequests: 0, mainModelRequests: 0, auxiliaryModelRequests: 0, completionReviews: 0 },
    workspaceMutationRevision: 0, validations: [], criteria: [{ criterionId: 'criterion-1', status: 'pending' as const, evidenceRefs: [] }],
    consumedResultKeys: [], requestIntents: [], journalShards: [], nextJournalSequence: 1,
    sideEffects: { changeSetIds: [], draftRunIds: [], approvalIds: [], pendingToolCallIds: [], uncertainToolCallIds: [], subagentIds: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function recoveryContext(value: ReturnType<typeof contract>, overrides: Partial<GoalRecoveryContext> = {}): GoalRecoveryContext {
  return {
    runtimeId: 'runtime', workspaceKey: 'workspace', sessionId: 'session', sourceId: value.main.sourceId,
    modelId: value.main.modelId, provider: value.main.provider, endpointHash: value.main.endpointHash,
    workspaceTrusted: true, hasExternalAuthorizationRequirement: false, checkpointValid: true,
    hasUncertainChangeSet: false, hasUncertainDraftRun: false, hasUncertainToolResult: false,
    hasPendingApproval: false, canAcquireLease: true, autoResumeEnabled: false, ...overrides
  };
}

function createHashForMutatedContract(value: ReturnType<typeof contract>): string {
  return hashGoalContract(value);
}
