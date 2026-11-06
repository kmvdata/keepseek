import type { AgentResponse, ChatMessage, ChatSession } from '../shared/types';

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
  | { ready: false; reason: 'scope' | 'superseded' | 'incomplete' | 'continuation' | 'stopped' };

/** Read current host state after the answer is durable and all continuation
 * coordinators have had their opportunity to run. Task IDs are host links,
 * never Provider trace/run IDs. Drafts alone do not keep an ask turn open. */
export function checkSessionTitleCompletion(
  session: ChatSession,
  completion: SessionTitleCompletion,
  blockers: SessionTitleCompletionBlockers = {}
): SessionTitleCompletionCheck {
  if (session.id !== completion.sessionId || session.pendingHistoryTruncation) return { ready: false, reason: 'scope' };
  const message = session.messages.find(item => item.id === completion.assistantMessageId);
  const task = message?.userTask;
  const origin = task && session.messages.find(item => item.id === task.originMessageId);
  if (!message || message.role !== 'assistant' || task?.id !== completion.taskId || !origin
    || origin.role !== 'user' || origin.contextMeta?.displayKind || origin.userTask?.id !== task.id) {
    return { ready: false, reason: 'scope' };
  }
  const latestTaskMessage = [...session.messages].reverse().find(item => item.userTask?.id);
  if (latestTaskMessage?.id !== message.id) return { ready: false, reason: 'superseded' };
  if (blockers.aborted) return { ready: false, reason: 'stopped' };
  if (Object.entries(blockers).some(([key, value]) => key !== 'aborted' && value)
    || completion.approvalContinuationRequired || completion.approvalContinuationStopReason) {
    return { ready: false, reason: 'continuation' };
  }
  if (message.isStreaming || !message.content.trim()) return { ready: false, reason: 'incomplete' };
  const details = message.runDetails;
  const checkpoint = message.runCheckpoint ?? message.runCheckpointArchive?.summary;
  if (!details || details.status !== 'succeeded' || details.budgetStopReason || details.budgetPause
    || details.failureReason || details.outputTruncation
    || checkpoint && (checkpoint.status !== 'completed' || checkpoint.stopReason && checkpoint.stopReason !== 'completed')) {
    return { ready: false, reason: 'stopped' };
  }
  const processing = session.approvalProcessing;
  if (processing?.rootTaskId === completion.taskId
    && ['processing', 'replanning', 'waiting_user', 'blocked', 'stopped'].includes(processing.status)) {
    return { ready: false, reason: 'continuation' };
  }
  if (session.repairLoop && !['idle', 'completed', 'blocked'].includes(session.repairLoop.status)) {
    return { ready: false, reason: 'continuation' };
  }
  return { ready: true, taskId: completion.taskId, messageId: message.id };
}
