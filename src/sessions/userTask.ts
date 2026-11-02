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
/** Only explicit host continuation markers join legacy turns. Ordinary input
 * (including edited resends) starts a new task. No inference from prompt text. */
export function migrateUserTasks(messages: ChatMessage[]): void {
  let current: UserTaskLink | undefined;
  const originallyLinked = new Set(messages.filter(message => normalizeUserTask(message.userTask)).map(message => message.id));
  const segmentOwners = new Map<string, UserTaskLink>();
  for (const [index, message] of messages.entries()) {
    const saved = normalizeUserTask(message.userTask);
    if (saved) current = saved;
    else if (message.role === 'user') {
      const kind = message.contextMeta?.displayKind;
      const reason = kind === 'delegated_auto_continue' ? 'approval'
        : kind === 'draft_run_auto_continue' ? 'command'
          : kind === 'plan_execution_continuation' ? 'plan' : undefined;
      if (reason && current) message.userTask = { ...current, reason };
      else if (!reason) message.userTask = { version: 1, id: message.id, originMessageId: message.id, reason: 'user' };
      current = message.userTask;
    } else if (message.role === 'assistant') {
      const segment = executionSegmentId(message);
      const owner = segment && segmentOwners.get(segment);
      if (owner) {
        // A repeated authoritative execution ID is an explicit recovery link,
        // including legacy no-progress supplementary user turns.
        current = { ...owner, reason: 'recovery' };
        const preceding = messages[index - 1];
        if (preceding?.role === 'user' && !originallyLinked.has(preceding.id)) preceding.userTask = { ...current };
      }
      if (current) message.userTask = { ...current };
    }
    const segment = executionSegmentId(message);
    if (segment && message.userTask && !segmentOwners.has(segment)) segmentOwners.set(segment, message.userTask);
  }
}
export function taskForSegment(session: ChatSession, segmentId: string): UserTaskLink | undefined {
  migrateUserTasks(session.messages);
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
