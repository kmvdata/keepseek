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
    ? '<keepseek-approval-mode>delegate: The user selected project-wide Approve for me. Propose the exact DraftEdits and DraftRuns needed for the task. Use keepseek_run_validation for fixed compile, lint, and test. The host will apply eligible drafts after policy or model approval and report actual results. External scope and unsafe or uncertain effects may require review or explicit user action. Never retry or route around a paused or denied operation. Continue until the task is complete; only claim effects after their results arrive.</keepseek-approval-mode>'
    : mode === 'model_review'
      ? '<keepseek-approval-mode>model_review: The user selected project-wide Model review. Propose exact immutable DraftEdits and DraftRuns. Use keepseek_run_validation for fixed compile, lint, and test. An isolated reviewer will approve or deny each effect after this turn. A denial is a safety decision, not an execution error: do not retry variants or indirect equivalents. Only propose a materially safer new action with a new hash, or stop and explain when none exists. Claim effects only after real results arrive.</keepseek-approval-mode>'
    : '<keepseek-approval-mode>ask: The user selected project-wide Ask for approval. File writes and arbitrary commands require individual user approval. Prepare pending drafts and wait for their results.</keepseek-approval-mode>';
}

export interface DelegatedApprovalBatch {
  sessionId: string;
  runId: string;
  rootTaskId?: string;
  editIds: string[];
  draftRunIds: string[];
  confirmTargetId?: string;
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

export function draftRunPreparedMessage(mode: ApprovalMode | undefined, language: 'zh-CN' | 'en'): string {
  const approval = normalizeApprovalMode(mode);
  if (language === 'en') return 'DraftRun prepared only; no process was started. ' + (approval === 'ask'
    ? 'Wait for the user to approve this execution in KeepSeek.' : approval === 'model_review'
      ? 'The configured model will review this exact operation before the host executes it.'
      : 'The host will automatically process this operation after hard preflight checks.');
  return '仅准备了 DraftRun 草稿，尚未执行。' + (approval === 'ask' ? '等待用户在 KeepSeek 中批准本次执行。'
    : approval === 'model_review' ? '由配置的模型审核精确操作，批准后宿主执行。' : '宿主将在硬性预检通过后自动处理此操作。');
}
