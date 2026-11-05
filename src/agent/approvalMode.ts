import type { ApprovalMode } from '../shared/types';
import type { ApprovalReviewDisplay, BoundedReviewText } from '../approvals/approvalReviewTypes';

export const DELEGATED_APPROVAL_PROTOCOL_VERSION = 6;
export const MODEL_REVIEW_APPROVAL_PROTOCOL_VERSION = 7;

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' || value === 'model_review' ? value : 'ask';
}

/** Append only to a new user message. Never regenerate a historical prefix. */
export function getApprovalModeUserTail(mode: ApprovalMode): string {
  const validation = 'Use keepseek_run_validation only when validation is required for the task and the target package.json defines the matching compile, lint, or test script. A local Git-only task does not require extra validation unless the user or project explicitly requires it.';
  const git = [
    'For local Git, prefer keepseek_git_status and keepseek_git_diff when workspaceFolder identifies the requested repository.',
    'Use a controlled DraftRun when exact cwd or pathspec is required.',
    'Stage and commit through separate DraftRuns using direct Git argv.',
    'Wait for the actual staging result, inspect the index, and write the commit message in the requested language from that evidence.',
    'Pass -a and -m separately when needed and give every -m exactly one complete message argument.'
  ].join(' ');
  return mode === 'delegate'
    ? `<keepseek-approval-mode>delegate: The user selected unattended Auto approval for this task. Propose the exact DraftEdits and DraftRuns needed for the task. ${validation} ${git} The host approves eligible drafts and sends other verifiable operations to the dedicated Auto approval reviewer. Normal project scripts, shell, dependency operations and inline code may run with extension-host privileges. Exact external scope must be granted in advance. Use verified workspace alternatives when required evidence or authority is unavailable. The host reports actual results and distinguishes commands that never started from known and unknown effects. Do not ask the user to click, grant access, retry review, or resume. Reuse completed work. Never repeat an uncertain effect or pursue an operation denied on safety grounds. Continue while authorized work remains. Report completion only after actual results verify the requested outcome, or explain the concrete blocker and unfinished work.</keepseek-approval-mode>`
    : mode === 'model_review'
      ? `<keepseek-approval-mode>model_review: The user selected project-wide Model review. Propose exact immutable DraftEdits and DraftRuns. ${validation} An isolated reviewer will approve or deny each effect after this turn. A denial is a safety decision, not an execution error: do not retry variants or indirect equivalents. Only propose a materially safer new action with a new hash, or stop and explain when none exists. Claim effects only after real results arrive.</keepseek-approval-mode>`
    : `<keepseek-approval-mode>ask: The user selected project-wide Ask for approval. File writes and arbitrary commands require individual user approval. ${validation} Prepare pending drafts and wait for their results.</keepseek-approval-mode>`;
}

export interface DelegatedApprovalBatch {
  sessionId: string;
  runId: string;
  rootTaskId?: string;
  backgroundRunId?: string;
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
  localGitCompletionCheck?: boolean;
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
