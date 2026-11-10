import type { ChatMessage, ChatSession } from '../shared/types';
import { isSessionTitleUserInput, sessionTitleInputId, sessionTitleMessageHash } from '../sessions/sessionTitle';

/** Captured only when the Host accepts a genuine user submission. Readiness,
 * history loading and assistant output cannot manufacture this input event. */
export interface SessionTitleSubmission {
  sessionId: string;
  /** Naming identity can be a new recovery input within an existing root. */
  taskId: string;
  /** Frozen execution-budget owner, independent from the naming input ID. */
  rootTaskId: string;
  userMessageId: string;
  userMessageHash: string;
}

export function captureSessionTitleSubmission(
  sessionId: string,
  message: ChatMessage
): SessionTitleSubmission | undefined {
  if (!isSessionTitleUserInput(message) || message.isStreaming || !message.content.trim()) return undefined;
  return {
    sessionId,
    taskId: sessionTitleInputId(message),
    rootTaskId: message.userTask?.id ?? message.id,
    userMessageId: message.id,
    userMessageHash: sessionTitleMessageHash(message)
  };
}

export type SessionTitleSubmissionCheck =
  | { ready: true; taskId: string; messageId: string }
  | { ready: false; reason: 'scope' | 'incomplete'; terminal: true };

/** The user body is the complete naming material. Main-task streaming,
 * approvals, failures, cancellation and later turns never delay a durable input.
 * A cut or changed selected input retires only that submission's candidate. */
export function checkSessionTitleSubmission(
  session: ChatSession,
  submission: SessionTitleSubmission
): SessionTitleSubmissionCheck {
  if (session.id !== submission.sessionId) return { ready: false, reason: 'scope', terminal: true };
  const message = session.messages.find(item => item.id === submission.userMessageId);
  if (!message || !isSessionTitleUserInput(message)
    || sessionTitleInputId(message) !== submission.taskId
    || (message.userTask?.id ?? message.id) !== submission.rootTaskId
    || sessionTitleMessageHash(message) !== submission.userMessageHash
    || session.pendingHistoryTruncation && !session.pendingHistoryTruncation.retainedMessageIds.includes(message.id)) {
    return { ready: false, reason: 'scope', terminal: true };
  }
  if (message.isStreaming || !message.content.trim()) return { ready: false, reason: 'incomplete', terminal: true };
  return { ready: true, taskId: submission.taskId, messageId: message.id };
}
