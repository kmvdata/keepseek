import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import { createGoalUiState } from '../src/agent/goals/goalViewModel';
import type { GoalRecordV1 } from '../src/agent/goals/goalTypes';

interface GoalViewProjectionHost {
  goalAttemptStream?: { goalId: string; sessionId: string; message: ChatMessage };
  goalCoordinator?: { current?: { id: string } };
  getVisibleMessagesForWebview(session: ChatSession, limit: number): ChatMessage[];
}

interface GoalReferenceProjectionHost {
  skillStore: { getManifests(): [] };
  sanitizeGoalReferencePaths(text: string, references: Array<{ path: string }>): string;
  restoreGoalReferencePaths(text: string, references: Array<{ path: string }>): string;
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

test('Goal UI projection separates composer mode, proposals, current Goal, terminal Goal, and other sessions', () => {
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: false }).mode, 'chat');
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: true }).mode, 'goal_armed');
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: true, proposalStatus: 'generating' }).mode, 'proposal_generating');
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: true, proposalStatus: 'ready' }).mode, 'proposal_review');
  const goal = { sessionId: 's1', status: 'running' } as GoalRecordV1;
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: true, goal }).mode, 'goal_active');
  goal.status = 'stopped';
  assert.equal(createGoalUiState({ activeSessionId: 's1', composerMode: true, goal }).mode, 'goal_terminal');
  assert.deepEqual(createGoalUiState({ activeSessionId: 's2', composerMode: false, goal }), {
    version: 1, mode: 'workspace_goal_elsewhere', composerMode: false, activeSessionId: 's2', goalSessionId: 's1'
  });
});

test('Goal objective layers rehydrate authorized external reference syntax without rewriting plain canonical text', () => {
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    skillStore: { getManifests: () => [] }
  }) as GoalReferenceProjectionHost;
  const externalPath = '/outside/reference.ts';
  const references = [{ path: externalPath }];
  const visible = `reference.ts (lines 1-2)\n<${externalPath}#L1-L2>`;
  const canonical = host.sanitizeGoalReferencePaths(visible, references);
  assert.equal(canonical, 'reference.ts (lines 1-2)\n<authorized-external-reference-1#L1-L2>');
  assert.equal(host.restoreGoalReferencePaths(canonical, references), visible);
  assert.equal(
    host.restoreGoalReferencePaths('Keep authorized-external-reference-1 as plain text.', references),
    'Keep authorized-external-reference-1 as plain text.'
  );
});
