import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { ChatMessage, ChatSession } from '../src/shared/types';

interface GoalViewProjectionHost {
  goalAttemptStream?: { goalId: string; sessionId: string; message: ChatMessage };
  goalCoordinator?: { current?: { id: string } };
  getVisibleMessagesForWebview(session: ChatSession, limit: number): ChatMessage[];
}

test('Goal streaming assistant output is projected without mutating ChatSession history', () => {
  const historical: ChatMessage = {
    id: 'user-1', role: 'user', content: 'Goal: test', createdAt: '2026-01-01T00:00:00.000Z'
  };
  const streaming: ChatMessage = {
    id: 'goal-stream-1', role: 'assistant', content: 'partial', reasoningContent: 'thinking',
    createdAt: '2026-01-01T00:00:01.000Z', isStreaming: true
  };
  const session = { id: 'session-1', messages: [historical] } as ChatSession;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    goalCoordinator: { current: { id: 'goal-1' } },
    goalAttemptStream: { goalId: 'goal-1', sessionId: 'session-1', message: streaming }
  }) as GoalViewProjectionHost;

  const visible = host.getVisibleMessagesForWebview(session, 30);
  assert.deepEqual(visible.map((message) => message.id), ['user-1', 'goal-stream-1']);
  assert.equal(visible[1]?.content, 'partial');
  assert.equal(visible[1]?.reasoningContent, 'thinking');
  assert.equal(visible[1]?.isStreaming, true);
  assert.deepEqual(session.messages.map((message) => message.id), ['user-1']);

  host.goalCoordinator = { current: { id: 'another-goal' } };
  assert.deepEqual(host.getVisibleMessagesForWebview(session, 30).map((message) => message.id), ['user-1']);
});
