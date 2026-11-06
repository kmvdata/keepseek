import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import type { AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';
import {
  captureSessionTitleCompletion,
  checkSessionTitleCompletion,
  type SessionTitleCompletionBlockers
} from '../src/provider/sessionTitleCompletion';

function fixture() {
  const session = createEmptySession();
  const link = { version: 1 as const, id: 'logical-task', originMessageId: 'real-user', reason: 'user' as const };
  const user: ChatMessage = { id: 'real-user', role: 'user', content: '排查审批失败', createdAt: '2026-11-06T00:00:00Z', userTask: link };
  const assistant: ChatMessage = { id: 'final-answer', role: 'assistant', content: '需要你补充错误日志。',
    createdAt: '2026-11-06T00:01:00Z', userTask: link,
    runDetails: { status: 'succeeded' } as ChatMessage['runDetails'],
    runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: {
      taskId: 'execution-segment', status: 'completed', stopReason: 'completed', usedMs: 1000,
      maxExecutionMs: 0, limitSource: 'test', attempt: 1, modelRequests: 1, retries: 0, steps: 0, canResume: false
    } } };
  session.messages = [user, assistant];
  const response = { approvalContinuationRequired: false } as AgentResponse;
  const completion = captureSessionTitleCompletion(session.id, assistant, response)!;
  return { session, assistant, response, completion };
}

test('a durable final clarification is eligible and uses the logical task, never the execution or trace ID', () => {
  const { session, completion } = fixture();
  assert.deepEqual(checkSessionTitleCompletion(session, completion), {
    ready: true, taskId: 'logical-task', messageId: 'final-answer'
  });
  assert.equal(captureSessionTitleCompletion(session.id,
    { ...session.messages[1], userTask: undefined }, {} as AgentResponse), undefined);
});

test('ask plan and ordinary prepared draft replies do not depend on pending draft counts', () => {
  const { session, completion } = fixture();
  session.approvalMode = 'ask';
  session.executionMode = 'plan';
  assert.equal(checkSessionTitleCompletion(session, completion).ready, true);
});

for (const blocker of ['running', 'queuedApproval', 'commandContinuation', 'planContinuation', 'background', 'manualApproval'] as const) {
  test(`${blocker} prevents early completion between internal execution segments`, () => {
    const { session, completion } = fixture();
    const blockers: SessionTitleCompletionBlockers = { [blocker]: true };
    assert.deepEqual(checkSessionTitleCompletion(session, completion, blockers), { ready: false, reason: 'continuation' });
    assert.equal(checkSessionTitleCompletion(session, completion, { [blocker]: false }).ready, true);
  });
}

test('a returned response requesting approval continuation is not a final completion', () => {
  const { session, assistant, response } = fixture();
  for (const extra of [{ approvalContinuationRequired: true }, { approvalContinuationStopReason: 'reviewer_unavailable' }]) {
    const completion = captureSessionTitleCompletion(session.id, assistant, { ...response, ...extra })!;
    assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
  }
});

test('failed, stopped, budget paused, truncated, interrupted and streaming answers never qualify', () => {
  const cases: Array<(session: ChatSession, message: ChatMessage) => void> = [
    (_s, m) => { m.runDetails!.status = 'failed'; },
    (_s, m) => { m.runDetails!.status = 'blocked'; },
    (_s, m) => { m.runDetails!.status = 'stopped'; },
    (_s, m) => { m.runDetails!.failureReason = 'provider_error'; },
    (_s, m) => { m.runDetails!.budgetStopReason = 'cost_limit'; },
    (_s, m) => { m.runDetails!.budgetPause = { kind: 'explicit_tool_budget', resumable: true, segment: 1 }; },
    (_s, m) => { m.runDetails!.outputTruncation = { finishReason: 'length', requestId: 'request', toolsExecuted: 0 }; },
    (_s, m) => { m.runCheckpointArchive!.summary.status = 'interrupted'; },
    (_s, m) => { m.runCheckpointArchive!.summary.stopReason = 'no_progress_loop'; },
    (_s, m) => { m.isStreaming = true; },
    (_s, m) => { m.content = ' \n '; }
  ];
  for (const change of cases) {
    const { session, assistant, completion } = fixture();
    change(session, assistant);
    assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
  }
  const { session, completion } = fixture();
  assert.equal(checkSessionTitleCompletion(session, completion, { aborted: true }).ready, false);
});

test('new turns and internal continuations supersede an earlier segment; only the new final response qualifies', () => {
  for (const reason of ['user', 'approval', 'command', 'repair', 'plan', 'recovery'] as const) {
    const { session, assistant, response, completion } = fixture();
    const link = { ...assistant.userTask!, reason,
      ...(reason === 'user' ? { id: 'new-task', originMessageId: 'next-user' } : {}) };
    session.messages.push({ id: 'next-user', role: 'user', content: '下一段', createdAt: '', userTask: link });
    assert.deepEqual(checkSessionTitleCompletion(session, completion), { ready: false, reason: 'superseded' });
    const next = { ...assistant, id: 'next-answer', userTask: link };
    session.messages.push(next);
    const latest = captureSessionTitleCompletion(session.id, next, response)!;
    assert.equal(checkSessionTitleCompletion(session, latest).ready, true);
    assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
  }
});

test('scope checks reject deleted or unlinked origin messages without modifying retained request bytes', () => {
  const { session, completion } = fixture();
  session.messages[0].providerContent = 'retained provider bytes\n';
  session.contextInstructions = 'stable instructions\n';
  const before = JSON.stringify(session);
  assert.equal(checkSessionTitleCompletion(session, completion).ready, true);
  assert.equal(JSON.stringify(session), before);
  assert.equal(checkSessionTitleCompletion({ ...session, id: 'other' }, completion).ready, false);
  session.messages.shift();
  assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
});

test('repair and root-scoped approval processing block only their active lifecycle', () => {
  const { session, completion } = fixture();
  session.repairLoop = { status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds: ['draft'] };
  assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
  session.repairLoop.status = 'completed';
  assert.equal(checkSessionTitleCompletion(session, completion).ready, true);
  session.approvalProcessing = { version: 1, rootTaskId: completion.taskId, runId: 'segment', mode: 'delegate',
    status: 'processing', targets: [], updatedAt: '' };
  assert.equal(checkSessionTitleCompletion(session, completion).ready, false);
  session.approvalProcessing.status = 'completed';
  assert.equal(checkSessionTitleCompletion(session, completion).ready, true);
});

test('approval lifecycle observation neither claims nor starts queued work and isolates session/root task', () => {
  const queue = new DelegatedApprovalQueue();
  queue.enqueue({ sessionId: 'session', runId: 'segment', rootTaskId: 'root', editIds: ['edit'], draftRunIds: [] });
  assert.equal(queue.hasPending('session'), true);
  assert.equal(queue.hasPending('session', 'root'), true);
  assert.equal(queue.hasPending('other'), false);
  assert.equal(queue.hasPending('session', 'other'), false);
  const claimed = queue.take('session')!;
  assert.ok(claimed);
  assert.equal(queue.hasPending('session', 'root'), true);
  queue.finish(claimed.controller);
  assert.equal(queue.hasPending('session'), false);
});
