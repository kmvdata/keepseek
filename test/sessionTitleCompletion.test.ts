import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import { captureSessionTitleSubmission, checkSessionTitleSubmission } from '../src/provider/sessionTitleCompletion';
import { createHistoryTruncationPlan } from '../src/sessions/historyTruncation';
import type { ChatMessage } from '../src/shared/types';

function fixture() {
  const session = createEmptySession();
  const user: ChatMessage = { id: 'user-1', role: 'user', content: '定位 KeepSeek 输入框无法发送的原因', createdAt: '',
    userTask: { version: 1, id: 'root-1', originMessageId: 'user-1', reason: 'user' } };
  session.messages.push(user);
  const submission = captureSessionTitleSubmission(session.id, user)!;
  return { session, user, submission };
}

test('a real user input is nameable before any assistant answer exists', () => {
  const { session, submission } = fixture();
  assert.deepEqual(checkSessionTitleSubmission(session, submission), { ready: true, taskId: 'root-1', messageId: 'user-1' });
});

test('assistant streaming, failure, cancellation and approval work do not gate an accepted user purpose', () => {
  const { session, user, submission } = fixture();
  for (const status of ['running', 'failed', 'cancelled', 'waiting', 'blocked'] as const) {
    session.messages.splice(1, session.messages.length, { id: 'assistant-1', role: 'assistant', content: 'partial answer', createdAt: '',
      userTask: user.userTask, isStreaming: true, incompleteForTitle: true,
      runDetails: { status } as ChatMessage['runDetails'] });
    assert.equal(checkSessionTitleSubmission(session, submission).ready, true);
  }
  session.repairLoop = { status: 'running_validation', iteration: 1, maxIterations: 3, pendingDraftEditIds: [] };
  session.approvalProcessing = { version: 1, rootTaskId: 'root-1', runId: 'segment-1', mode: 'delegate', status: 'processing', targets: [], updatedAt: '' };
  assert.equal(checkSessionTitleSubmission(session, submission).ready, true);
});

test('ordinary newer user input and same-root internal continuation preserve an older submission snapshot', () => {
  const { session, user, submission } = fixture();
  session.messages.push({ ...user, id: 'continuation', content: 'tool result', userTask: { ...user.userTask!, reason: 'command' },
    contextMeta: { displayKind: 'draft_run_auto_continue', protectedReason: 'draft_run_result' } });
  session.messages.push({ ...user, id: 'user-2', content: '第二个真实目的',
    userTask: { version: 1, id: 'root-2', originMessageId: 'user-2', reason: 'user' } });
  assert.equal(checkSessionTitleSubmission(session, submission).ready, true);
  assert.equal(captureSessionTitleSubmission(session.id, session.messages[1]), undefined);
  assert.equal(captureSessionTitleSubmission(session.id, session.messages[2])?.taskId, 'root-2');
});

test('capture rejects assistant output, empty inputs and protected host-only user notifications', () => {
  const { session, user } = fixture();
  assert.equal(captureSessionTitleSubmission(session.id, { ...user, role: 'assistant' }), undefined);
  assert.equal(captureSessionTitleSubmission(session.id, { ...user, content: '  ' }), undefined);
  assert.equal(captureSessionTitleSubmission(session.id, { ...user, isStreaming: true }), undefined);
  assert.equal(captureSessionTitleSubmission(session.id, { ...user, contextMeta: { displayKind: 'delegated_auto_continue' } }), undefined);
  assert.equal(captureSessionTitleSubmission(session.id, { ...user, contextMeta: { protectedReason: 'background_run_result' } }), undefined);
});

test('a real user with a first-input protection tag still supplies its own input only', () => {
  const { session, user } = fixture();
  user.contextMeta = { protectedReason: 'first_user_request' };
  assert.ok(captureSessionTitleSubmission(session.id, user));
  user.contextMeta = { protectedReason: 'draft_run_result' };
  assert.ok(captureSessionTitleSubmission(session.id, user));
});

test('selected user edits, deletion and workspace/session mismatch invalidate the queued input', () => {
  const { session, user, submission } = fixture();
  user.content += ' changed';
  assert.equal(checkSessionTitleSubmission(session, submission).ready, false);
  user.content = '定位 KeepSeek 输入框无法发送的原因';
  assert.equal(checkSessionTitleSubmission({ ...session, id: 'different-session' }, submission).ready, false);
  user.userTask = { ...user.userTask!, id: 'different-root' };
  assert.equal(checkSessionTitleSubmission(session, submission).ready, false);
  session.messages = [];
  assert.equal(checkSessionTitleSubmission(session, submission).ready, false);
});

test('legacy genuine user inputs are identified without manufacturing task links', () => {
  const { session, user } = fixture();
  user.userTask = undefined;
  const before = JSON.stringify(user);
  const submission = captureSessionTitleSubmission(session.id, user)!;
  assert.equal(submission.taskId, user.id);
  assert.equal(checkSessionTitleSubmission(session, submission).ready, true);
  assert.equal(JSON.stringify(user), before);
});

test('unrelated history truncation preserves a retained selected input; removing it retires the candidate', () => {
  const { session, user, submission } = fixture();
  const next: ChatMessage = { ...user, id: 'user-2', userTask: { version: 1, id: 'root-2', originMessageId: 'user-2', reason: 'user' } };
  session.messages.push(next);
  session.pendingHistoryTruncation = createHistoryTruncationPlan(session, next.id, { ...next, id: 'replacement' })!;
  assert.equal(checkSessionTitleSubmission(session, submission).ready, true);
  session.pendingHistoryTruncation = undefined;
  session.pendingHistoryTruncation = createHistoryTruncationPlan(session, user.id, { ...user, id: 'replacement' })!;
  assert.equal(checkSessionTitleSubmission(session, submission).ready, false);
});

test('a genuine recovery supplement has a fresh naming identity while sharing its original execution root', () => {
  const { session, user, submission: original } = fixture();
  const recovery: ChatMessage = { ...user, id: 'recovery-user', content: '先处理网络断连，再恢复原来的验证',
    userTask: { ...user.userTask!, reason: 'recovery' } };
  session.messages.push(recovery);
  const next = captureSessionTitleSubmission(session.id, recovery)!;
  assert.ok(next);
  assert.equal(next.taskId, recovery.id);
  assert.equal(next.rootTaskId, user.userTask!.id);
  assert.notEqual(next.taskId, original.taskId);
  assert.equal(recovery.userTask!.id, user.userTask!.id, 'naming does not grant another root execution budget');
  assert.equal(checkSessionTitleSubmission(session, original).ready, true);
  assert.equal(checkSessionTitleSubmission(session, next).ready, true);
  recovery.content += ' 用户随后修改了补充指令';
  assert.equal(checkSessionTitleSubmission(session, next).ready, false);
  assert.equal(checkSessionTitleSubmission(session, original).ready, true);
  recovery.content = '先处理网络断连，再恢复原来的验证';
  recovery.userTask = { ...recovery.userTask!, id: 'different-budget-root' };
  assert.equal(checkSessionTitleSubmission(session, next).ready, false, 'an unchanged input cannot retarget another root budget');
});

test('internal command, repair, plan and approval user records do not become fresh input submissions', () => {
  const { session, user } = fixture();
  for (const reason of ['command', 'repair', 'plan', 'approval'] as const) {
    const internal: ChatMessage = { ...user, id: `internal-${reason}`, content: '自动运行下一段',
      userTask: { ...user.userTask!, reason } };
    assert.equal(captureSessionTitleSubmission(session.id, internal), undefined, reason);
  }
  const protectedRecovery: ChatMessage = { ...user, id: 'protected-recovery',
    userTask: { ...user.userTask!, reason: 'recovery' }, contextMeta: { displayKind: 'draft_run_auto_continue' } };
  assert.equal(captureSessionTitleSubmission(session.id, protectedRecovery), undefined);
});
