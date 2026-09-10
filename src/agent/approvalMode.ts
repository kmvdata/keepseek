import type { ApprovalMode } from '../shared/types';
import type { ApprovalReviewDisplay, BoundedReviewText } from '../approvals/approvalReviewTypes';

export const DELEGATED_APPROVAL_PROTOCOL_VERSION = 6;
export const MODEL_REVIEW_APPROVAL_PROTOCOL_VERSION = 7;

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' || value === 'model_review' ? value : 'ask';
}

/** Append only to a new user message. Never regenerate a historical prefix. */
export function getApprovalModeUserTail(mode: ApprovalMode): string {
  return mode === 'delegate'
    ? '<keepseek-approval-mode>delegate: The user selected project-wide Approve for me. Propose the exact DraftEdits and DraftRuns needed for the task. The host will approve and apply/execute them after this turn, then send the real results in a new turn automatically. Do not ask for manual approval. Continue until the task is complete; only claim effects after their results arrive.</keepseek-approval-mode>'
    : mode === 'model_review'
      ? '<keepseek-approval-mode>model_review: The user selected project-wide Model review. Propose exact immutable DraftEdits and DraftRuns. An isolated reviewer will approve or deny each effect after this turn. A denial is a safety decision, not an execution error: do not retry variants or indirect equivalents. Only propose a materially safer new action with a new hash, or stop and explain when none exists. Claim effects only after real results arrive.</keepseek-approval-mode>'
    : '<keepseek-approval-mode>ask: The user selected project-wide Ask for approval. File writes and arbitrary commands require individual user approval. Prepare pending drafts and wait for their results.</keepseek-approval-mode>';
}

export interface DelegatedApprovalBatch {
  sessionId: string;
  runId: string;
  rootTaskId?: string;
  editIds: string[];
  draftRunIds: string[];
  continueAfterApprovalReview?: boolean;
  approvalReviews?: ApprovalReviewDisplay[];
  approvalToolResults?: Array<{
    toolCallId: string;
    toolName: string;
    status: 'succeeded' | 'denied' | 'failed';
    result: BoundedReviewText;
  }>;
  approvalStopReason?: string;
}

/** Volatile queue: reloading the extension must never execute restored drafts. */
export class DelegatedApprovalQueue {
  private pending?: DelegatedApprovalBatch;
  private active?: AbortController;

  public enqueue(batch: DelegatedApprovalBatch): void {
    if (batch.editIds.length || batch.draftRunIds.length || batch.continueAfterApprovalReview) {
      this.pending = structuredClone(batch);
    }
  }

  public take(sessionId: string): { batch: DelegatedApprovalBatch; controller: AbortController } | undefined {
    if (this.active || !this.pending || this.pending.sessionId !== sessionId) return undefined;
    const batch = this.pending;
    this.pending = undefined;
    this.active = new AbortController();
    return { batch, controller: this.active };
  }

  public finish(controller: AbortController): void {
    if (this.active === controller) this.active = undefined;
  }

  public cancel(): void {
    this.pending = undefined;
    this.active?.abort();
  }
}
