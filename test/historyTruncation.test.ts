import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptySession, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import {
  createHistoryTruncationPlan,
  executeHistoryTruncation,
  isHistoryOriginRemoved,
  normalizePendingHistoryTruncation,
  recoverPendingHistoryTruncation,
  type HistoryTruncationHooks,
  type PendingHistoryTruncation
} from '../src/sessions/historyTruncation';

function message(id: string, role: ChatMessage['role'], segment?: string): ChatMessage {
  return { id, role, content: `${id} original bytes\n`, createdAt: '2026-11-06T00:00:00.000Z',
    ...(segment ? { runCheckpointArchive: { version: 1 as const, objectHash: 'a'.repeat(64), summary: {
      taskId: segment, usedMs: 900, status: 'completed', maxExecutionMs: 0, limitSource: 'test', attempt: 1,
      modelRequests: 1, retries: 0, steps: 0, canResume: false
    } } } : {}) };
}
function fixture() {
  const session = createEmptySession();
  session.messages = [message('u1', 'user'), message('a1', 'assistant', 'segment1'),
    message('u2', 'user'), message('a2', 'assistant', 'segment2')];
  return session;
}
const replacement = () => message('new-user', 'user');

test('truncation scope uses full host history and authoritative segment IDs, never trace run IDs', () => {
  const session = fixture();
  session.messages[3].runDetails = { runId: 'trace-is-not-authority' } as ChatMessage['runDetails'];
  const plan = createHistoryTruncationPlan(session, 'u2', replacement(), 'edit')!;
  assert.deepEqual(plan.retainedMessageIds, ['u1', 'a1']);
  assert.deepEqual(plan.removedMessageIds, ['u2', 'a2']);
  assert.deepEqual(plan.removedSegmentIds, ['segment2']);
  assert.equal(isHistoryOriginRemoved(plan, { messageId: 'a2' }), true);
  assert.equal(isHistoryOriginRemoved(plan, { messageId: 'a1', agentRunId: 'segment2' }), false);
  assert.equal(isHistoryOriginRemoved(plan, { agentRunId: 'segment2' }), true);
  assert.equal(isHistoryOriginRemoved(plan, { runId: 'trace-is-not-authority' }), false);
  assert.equal(isHistoryOriginRemoved(plan, { messageId: 'skill-dialog' }), false);
  assert.equal(session.messages.length, 4);
});

test('a segment shared with retained history cannot invalidate originless retained operations', () => {
  const session = fixture();
  session.messages[3].runCheckpointArchive!.summary.taskId = 'segment1';
  const plan = createHistoryTruncationPlan(session, 'u2', replacement())!;
  assert.deepEqual(plan.removedSegmentIds, []);
  assert.equal(isHistoryOriginRemoved(plan, { messageId: 'a2', agentRunId: 'segment1' }), true);
  assert.equal(isHistoryOriginRemoved(plan, { agentRunId: 'segment1' }), false);
});

test('invalid target, empty input and reused replacement identity never prepare a truncation', () => {
  const session = fixture();
  assert.equal(createHistoryTruncationPlan(session, 'missing', replacement()), undefined);
  assert.equal(createHistoryTruncationPlan(session, 'a1', replacement()), undefined);
  assert.equal(createHistoryTruncationPlan(session, 'u2', { ...replacement(), content: ' \n ' }), undefined);
  assert.throws(() => createHistoryTruncationPlan(session, 'u2', { ...replacement(), id: 'u2' }), /identity/);
  assert.equal(session.pendingHistoryTruncation, undefined);
});

for (const mode of ['ask', 'delegate'] as const) {
  for (const target of ['u1', 'u2', 'u3']) {
    test(`${mode}: ${target} edits have identical truncation semantics for changed and unchanged text`, async () => {
      for (const unchanged of [true, false]) {
        const session = fixture();
        session.approvalMode = mode;
        session.messages.push(message('u3', 'user'), message('a3', 'assistant', 'segment3'));
        const index = session.messages.findIndex(m => m.id === target);
        const prefix = structuredClone(session.messages.slice(0, index));
        const next = { ...replacement(), content: unchanged ? session.messages[index].content : 'updated instruction' };
        const plan = createHistoryTruncationPlan(session, target, next)!;
        await executeHistoryTruncation(session, plan, { persistSession: async () => {}, invalidateOperations: async () => {} });
        assert.deepEqual(session.messages.slice(0, index), prefix);
        assert.equal(session.messages.length, index + 1);
        assert.equal(session.messages[index].content, next.content);
        assert.equal(session.approvalMode, mode);
      }
    });
  }
}

test('durable intent and operation commits precede splice; retained bytes and actual accounting survive', async () => {
  const session = fixture();
  session.messages[0].providerContent = 'retained provider content\n\n';
  const preserved = structuredClone(session.messages.slice(0, 2));
  const time = session.executionTime = { version: 1, byTask: { segment1: 900, segment2: 1900 }, incomplete: false };
  const usage = session.usageStats = { requestCount: 7 } as ChatSession['usageStats'];
  const events: string[] = [];
  const plan = createHistoryTruncationPlan(session, 'u2', replacement())!;
  plan.resultRunIds = ['preserved-origin-result'];
  await executeHistoryTruncation(session, plan, {
    persistSession: async () => { events.push(session.pendingHistoryTruncation ? 'intent' : 'history'); },
    invalidateOperations: async scope => { events.push('operations'); assert.equal(session.messages.length, 4); assert.equal(scope.id, plan.id); },
    commitOperations: async journal => { events.push('bindings'); assert.deepEqual(journal.resultRunIds, ['preserved-origin-result']); },
    commitContext: (_session, scope) => { events.push('context'); assert.equal(scope.id, plan.id); }
  });
  assert.deepEqual(events, ['intent', 'operations', 'bindings', 'context', 'history']);
  assert.deepEqual(session.messages.slice(0, 2), preserved);
  assert.deepEqual(session.messages.map(m => m.id), ['u1', 'a1', 'new-user']);
  assert.equal(session.executionTime, time);
  assert.equal(session.usageStats, usage);
  assert.equal(session.pendingHistoryTruncation, undefined);
});

for (const point of ['intent', 'operations', 'bindings', 'history'] as const) {
  test(`truncation ${point} failure stays recoverable and never starts a Provider or a side effect`, async () => {
    let session = fixture();
    const plan = createHistoryTruncationPlan(session, 'u2', replacement())!;
    let durable: ChatSession | undefined;
    let failure = true;
    let invalidations = 0;
    let bindings = 0;
    const tombstones = new Set<string>();
    const hooks: HistoryTruncationHooks = {
      persistSession: async () => {
        const stage = session.pendingHistoryTruncation ? 'intent' : 'history';
        if (failure && stage === point) throw new Error(`${point} fault`);
        durable = structuredClone(session);
      },
      invalidateOperations: async scope => {
        if (failure && point === 'operations') throw new Error('operations fault');
        invalidations++;
        tombstones.add(scope.id);
      },
      commitOperations: async () => {
        if (failure && point === 'bindings') throw new Error('bindings fault');
        bindings++;
      }
    };
    await assert.rejects(executeHistoryTruncation(session, plan, hooks), /fault/);
    assert.equal(session.pendingHistoryTruncation?.id, plan.id);
    if (point !== 'history') assert.deepEqual(session.messages.map(m => m.id), ['u1', 'a1', 'u2', 'a2']);
    // Restart from the last durable intent when one exists; otherwise retry
    // this process's retained intent. Both must establish durability first.
    session = durable ?? session;
    failure = false;
    assert.equal(await recoverPendingHistoryTruncation(session, hooks), true);
    assert.deepEqual(session.messages.map(m => m.id), ['u1', 'a1', 'new-user']);
    assert.equal(session.pendingHistoryTruncation, undefined);
    assert.equal(tombstones.size, 1);
    assert.ok(invalidations >= 1);
    assert.ok(bindings >= 1);
    assert.equal(await recoverPendingHistoryTruncation(session, hooks), false);
  });
}

test('a final commit failure can recover in the same process without duplicating the replacement', async () => {
  const session = fixture();
  const plan = createHistoryTruncationPlan(session, 'u2', replacement())!;
  let writes = 0;
  const hooks: HistoryTruncationHooks = {
    persistSession: async () => { if (++writes === 2) throw new Error('final write'); },
    invalidateOperations: async () => {}
  };
  await assert.rejects(executeHistoryTruncation(session, plan, hooks), /final write/);
  assert.equal(session.messages.filter(m => m.id === 'new-user').length, 1);
  await recoverPendingHistoryTruncation(session, hooks);
  assert.equal(session.messages.filter(m => m.id === 'new-user').length, 1);
});

test('changed history and concurrent edits fail closed before any operation mutation', async () => {
  const session = fixture();
  const plan = createHistoryTruncationPlan(session, 'u2', replacement())!;
  session.messages.push(message('unrelated', 'assistant'));
  await assert.rejects(executeHistoryTruncation(session, plan, {
    persistSession: async () => {}, invalidateOperations: async () => { assert.fail('must not invalidate'); }
  }), /History changed/);
  session.messages.pop();
  let release!: () => void;
  let firstWrite = true;
  const pending = executeHistoryTruncation(session, plan, {
    persistSession: async () => { if (firstWrite) { firstWrite = false; await new Promise<void>(resolve => { release = resolve; }); } },
    invalidateOperations: async () => {}
  });
  await assert.rejects(executeHistoryTruncation(session, plan, {
    persistSession: async () => {}, invalidateOperations: async () => {}
  }), /already running/);
  release();
  await pending;
});

test('journal normalization preserves prepared replacement bytes and rejects malformed scope', () => {
  const session = fixture();
  const plan = createHistoryTruncationPlan(session, 'u2', { ...replacement(),
    providerContent: 'new task\n\n<host-tail>bytes</host-tail>' })!;
  plan.resultRunIds = ['lawful-result'];
  const normalize = (raw: unknown) => raw as ChatMessage;
  const reloaded = normalizePendingHistoryTruncation(JSON.parse(JSON.stringify(plan)), session.id, normalize)!;
  assert.deepEqual(reloaded, plan);
  assert.throws(() => normalizePendingHistoryTruncation(plan, 'other-session', normalize), /scope/);
  assert.throws(() => normalizePendingHistoryTruncation({ ...plan, retainedMessageIds: ['u2'] }, session.id, normalize), /scope/);
  assert.throws(() => normalizePendingHistoryTruncation({ ...plan, resultRunIds: ['x', 'x'] }, session.id, normalize), /scope/);
  assert.equal(normalizePendingHistoryTruncation(undefined, session.id, normalize), undefined);
});

test('session load retains a pending truncation for recovery and never treats it as already committed', () => {
  const session = fixture();
  session.pendingHistoryTruncation = createHistoryTruncationPlan(session, 'u2', replacement());
  const loaded = normalizeStoredSessions({ sessions: [JSON.parse(JSON.stringify(session))] },
    { key: session.workspaceKey, name: session.workspaceName, folderUris: session.workspaceFolders })[0];
  assert.equal(loaded.pendingHistoryTruncation?.id, session.pendingHistoryTruncation?.id);
  assert.equal(loaded.messages.length, 4);
});
