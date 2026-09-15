import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import * as vscode from 'vscode';
import { GoalLease } from '../src/agent/goals/goalLease';
import { hashGoalContract } from '../src/agent/goals/goalContract';
import { classifyGoalRecovery, type GoalRecoveryContext } from '../src/agent/goals/goalRecovery';
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
      initialPrompt: { visibleContent: '/goal test', expandedContent: '/goal test', providerContent: '/goal test\nTAIL' },
      now: '2026-01-01T00:00:00.000Z'
    });
    record = await store.append(record, 'first', { n: 1 }, '2026-01-01T00:00:01.000Z');
    record = await store.append(record, 'second', { n: 2 }, '2026-01-01T00:00:02.000Z');
    assert.deepEqual((await store.readJournal(record)).map((event) => [event.sequence, event.type]), [[1, 'first'], [2, 'second']]);
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
});

describe('Goal lease and recovery', () => {
  test('fences two coordinators, heartbeats, and permits explicit stale takeover only', async () => {
    const root = await tempRoot();
    let now = 1_000;
    const first = new GoalLease(vscode.Uri.file(root), 'workspace', 'owner-a', 300, () => now);
    const second = new GoalLease(vscode.Uri.file(root), 'workspace', 'owner-b', 300, () => now);
    const acquired = await first.acquire();
    assert.equal(acquired.acquired, true);
    assert.equal((await second.acquire()).reason, 'held');
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
