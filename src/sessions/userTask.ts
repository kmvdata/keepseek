import { normalizeTaskGitPushDestination, type TaskGitPushDestination } from '../runs/gitTaskIntent';
import type { ChatMessage, ChatSession } from '../shared/types';

/** Host metadata only. Task membership and traces never confer approval. */
export interface UserTaskLink {
  version: 1;
  id: string;
  originMessageId: string;
  reason: 'user' | 'approval' | 'command' | 'repair' | 'plan' | 'recovery';
  gitPushDestination?: TaskGitPushDestination;
}
export function normalizeUserTask(value: unknown): UserTaskLink | undefined {
  const v = value as UserTaskLink | undefined;
  const gitPushDestination = v?.reason === 'user' || v?.reason === 'recovery'
    ? normalizeTaskGitPushDestination(v.gitPushDestination) : undefined;
  return v?.version === 1 && typeof v.id === 'string' && !!v.id
    && typeof v.originMessageId === 'string' && !!v.originMessageId
    && ['user', 'approval', 'command', 'repair', 'plan', 'recovery'].includes(v.reason)
    ? { version: 1, id: v.id, originMessageId: v.originMessageId, reason: v.reason,
      ...(gitPushDestination && { gitPushDestination }) } : undefined;
}
/** Never substitute response.runId / trace IDs for the execution ID. */
export function executionSegmentId(message: ChatMessage | undefined): string | undefined {
  return message?.runCheckpoint?.taskId ?? message?.runCheckpointArchive?.summary.taskId;
}
export function taskForSegment(session: ChatSession, segmentId: string): UserTaskLink | undefined {
  return session.messages.find(message => executionSegmentId(message) === segmentId)?.userTask;
}
export function taskUserMessages(history: readonly ChatMessage[], taskId: string): ChatMessage[] {
  const origin = history.find(message => message.userTask?.id === taskId)?.userTask?.originMessageId;
  const original = history.find(message => message.id === origin && message.role === 'user');
  return original ? [original, ...history.filter(message => message.role === 'user' && message.id !== origin
    && message.userTask?.id === taskId && message.userTask.reason === 'recovery' && !message.contextMeta?.displayKind)] : [];
}
export function taskGoal(history: readonly ChatMessage[], taskId: string): string {
  const turns = taskUserMessages(history, taskId);
  if (turns.length) return turns.map(message => message.content).join('\n\n');
  return [...history].reverse().find(message => message.role === 'user'
    && !['delegated_auto_continue', 'draft_run_auto_continue', 'plan_execution_continuation']
      .includes(message.contextMeta?.displayKind ?? ''))?.content ?? '';
}
