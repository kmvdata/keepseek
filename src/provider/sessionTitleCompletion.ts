import type { AgentResponse, ChatMessage, ChatSession } from '../shared/types';
import { isSessionTitleFinalAnswer, isSessionTitleOrigin } from '../sessions/sessionTitle';

/** Captured only from a real, returned AgentResponse. A state refresh, idle
 * transition or historical message cannot manufacture a completion event. */
export interface SessionTitleCompletion {
  sessionId: string;
  taskId: string;
  assistantMessageId: string;
  approvalContinuationRequired: boolean;
  approvalContinuationStopReason?: string;
}

export interface SessionTitleCompletionBlockers {
  /** Blockers refer to this candidate's root task, not an unrelated new turn. */
  running?: boolean;
  queuedApproval?: boolean;
  commandContinuation?: boolean;
  planContinuation?: boolean;
  background?: boolean;
  manualApproval?: boolean;
  aborted?: boolean;
}

export function captureSessionTitleCompletion(
  sessionId: string,
  message: ChatMessage,
  response: AgentResponse
): SessionTitleCompletion | undefined {
  if (message.role !== 'assistant' || !message.userTask?.id) return undefined;
  return {
    sessionId,
    taskId: message.userTask.id,
    assistantMessageId: message.id,
    approvalContinuationRequired: response.approvalContinuationRequired === true,
    approvalContinuationStopReason: response.approvalContinuationStopReason
  };
}

export type SessionTitleCompletionCheck =
  | { ready: true; taskId: string; messageId: string }
  | { ready: false; reason: 'scope' | 'superseded' | 'incomplete' | 'continuation' | 'stopped'; terminal?: true };

/** Inspect only this observed round. Later real user inputs do not invalidate
 * a completed answer; another segment of the same task does replace it. A
 * complete proposal waiting for Apply is already a useful visible answer. */
export function checkSessionTitleCompletion(
  session: ChatSession,
  completion: SessionTitleCompletion,
  blockers: SessionTitleCompletionBlockers = {}
): SessionTitleCompletionCheck {
  if (session.id !== completion.sessionId || session.pendingHistoryTruncation) {
    return { ready: false, reason: 'scope', terminal: true };
  }
  const messageIndex = session.messages.findIndex(item => item.id === completion.assistantMessageId);
  const message = session.messages[messageIndex];
  const task = message?.userTask;
  const origin = task && session.messages.find(item => item.id === task.originMessageId);
  if (!message || message.role !== 'assistant' || task?.id !== completion.taskId || !origin
    || !isSessionTitleOrigin(origin)
    || origin.userTask?.id !== task.id) {
    return { ready: false, reason: 'scope', terminal: true };
  }
  if (session.messages.slice(messageIndex + 1).some(item => item.userTask?.id === task.id)) {
    return { ready: false, reason: 'superseded', terminal: true };
  }
  if (blockers.aborted || completion.approvalContinuationStopReason) {
    return { ready: false, reason: 'stopped', terminal: true };
  }
  // A continuation boundary cannot become a final answer. A later segment
  // registers its own returned answer under the same user task.
  if (completion.approvalContinuationRequired) return { ready: false, reason: 'continuation', terminal: true };
  if (Object.entries(blockers).some(([key, value]) => key !== 'aborted' && value)) return { ready: false, reason: 'continuation' };
  if (message.isStreaming) return { ready: false, reason: 'incomplete' };
  if (!message.content.trim()) return { ready: false, reason: 'incomplete', terminal: true };
  if (!message.runDetails || !isSessionTitleFinalAnswer(message)) {
    return { ready: false, reason: 'stopped', terminal: true };
  }
  const processing = session.approvalProcessing;
  if (processing?.rootTaskId === completion.taskId
    && ['processing', 'replanning'].includes(processing.status)) return { ready: false, reason: 'continuation' };
  // waiting_for_apply is a complete draft, not an active automatic segment.
  // Session repair state belongs to the current tail task; never let a later
  // task's repairs hold an older durable completion.
  const latestTask = [...session.messages].reverse().find(item => item.userTask)?.userTask?.id;
  if (latestTask === task.id && session.repairLoop
    && ['validation_failed', 'reading_problems', 'generating_repair', 'ready_for_validation', 'running_validation'].includes(session.repairLoop.status)) {
    return { ready: false, reason: 'continuation' };
  }
  return { ready: true, taskId: completion.taskId, messageId: message.id };
}
