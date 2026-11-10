import type { ChatMessage, ChatSession } from '../shared/types';

/** Host metadata only. Task membership and traces never confer approval. */
export interface UserTaskLink {
  version: 1;
  id: string;
  originMessageId: string;
  reason: 'user' | 'approval' | 'command' | 'repair' | 'plan' | 'recovery';
}
export function normalizeUserTask(value: unknown): UserTaskLink | undefined {
  const v = value as UserTaskLink | undefined;
  return v?.version === 1 && typeof v.id === 'string' && !!v.id
    && typeof v.originMessageId === 'string' && !!v.originMessageId
    && ['user', 'approval', 'command', 'repair', 'plan', 'recovery'].includes(v.reason)
    ? { version: 1, id: v.id, originMessageId: v.originMessageId, reason: v.reason } : undefined;
}
/** Never substitute response.runId / trace IDs for the execution ID. */
export function executionSegmentId(message: ChatMessage | undefined): string | undefined {
  return message?.runCheckpoint?.taskId ?? message?.runCheckpointArchive?.summary.taskId;
}
export function taskForSegment(session: ChatSession, segmentId: string): UserTaskLink | undefined {
  return session.messages.find(message => executionSegmentId(message) === segmentId)?.userTask;
}
export function taskGoal(history: readonly ChatMessage[], taskId: string): string {
  const origin = history.find(message => message.userTask?.id === taskId)?.userTask?.originMessageId;
  const original = history.find(message => message.id === origin && message.role === 'user');
  if (original) return [original.content, ...history.filter(message => message.role === 'user' && message.id !== origin
    && message.userTask?.id === taskId && message.userTask.reason === 'recovery'
    && !message.contextMeta?.displayKind).map(message => message.content)].join('\n\n');
  return [...history].reverse().find(message => message.role === 'user'
    && !['delegated_auto_continue', 'draft_run_auto_continue', 'plan_execution_continuation']
      .includes(message.contextMeta?.displayKind ?? ''))?.content ?? '';
}
