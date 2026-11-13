import type { ApprovalMode } from '../shared/types';
import type { ApprovalReviewDisplay, BoundedReviewText } from '../approvals/approvalReviewTypes';
import type { HistoryTruncationScope } from '../sessions/historyTruncation';

export const DELEGATED_APPROVAL_PROTOCOL_VERSION = 13;

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' ? value : 'ask';
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
    ? `<keepseek-approval-mode>delegate: The user selected Approve for me. Propose exact immutable DraftEdits and DraftRuns. ${validation} ${git} An independent reviewer decides each proposed command and side effect. Task-related operations in a trusted project default to approval once the host has verified the execution scope. Unfamiliar tools, flags and project logic are review evidence. Use the actual executable and literal arguments. For an entry created, moved or edited this turn, apply and verify the on-disk version before review and execution. Project processes run with the selected isolation profile. Use controlled authorized destinations for pushes and other external effects. Only the host can request a precise user decision about missing authority. A scope grant returns to independent review. Review outages and unresolved dependencies keep affected operations unstarted. Continue independent work, reuse verified results and never retry an uncertain effect or pursue a denied effect indirectly.</keepseek-approval-mode>`
    : `<keepseek-approval-mode>ask: The user selected project-wide Ask for approval. File writes and arbitrary commands require individual user approval. ${validation} Prepare pending drafts and wait for their results.</keepseek-approval-mode>`;
}

export interface DelegatedApprovalBatch {
  sessionId: string;
  runId: string;
  rootTaskId?: string;
  backgroundRunId?: string;
  editIds: string[];
  draftRunIds: string[];
  resume?: boolean;
  resumeTargetId?: string;
  manualAction?: { targetId: string; priorReviewId: string; retry?: boolean };
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
  /** The response has no other unfinished plan steps or pending child results. */
  allowVerifiedGitCompletion?: boolean;
}

/** Volatile queue: reloading the extension must never execute restored drafts. */
export class DelegatedApprovalQueue {
  private pending: DelegatedApprovalBatch[] = [];
  private active?: AbortController;
  private activeBatch?: DelegatedApprovalBatch;

  public enqueue(batch: DelegatedApprovalBatch): void {
    if (batch.editIds.length || batch.draftRunIds.length || batch.continueAfterApprovalReview) {
      const copy = structuredClone(batch);
      const index = this.pending.findIndex(item => item.sessionId === batch.sessionId && (batch.resume
        ? item.runId === batch.runId && item.resume && item.resumeTargetId === batch.resumeTargetId : !item.resume));
      if (index === -1) this.pending.push(copy);
      else this.pending[index] = copy;
    }
  }

  public take(sessionId: string): { batch: DelegatedApprovalBatch; controller: AbortController } | undefined {
    if (this.active) return undefined;
    const index = this.pending.findIndex(batch => batch.sessionId === sessionId);
    if (index === -1) return undefined;
    const [batch] = this.pending.splice(index, 1);
    this.active = new AbortController();
    this.activeBatch = batch;
    return { batch, controller: this.active };
  }

  public finish(controller: AbortController): void {
    if (this.active === controller) { this.active = undefined; this.activeBatch = undefined; }
  }

  /** Read-only lifecycle observation; never claims or starts an approval. */
  public hasPending(sessionId: string, rootTaskId?: string): boolean {
    const matches = (batch: DelegatedApprovalBatch | undefined) => Boolean(batch && batch.sessionId === sessionId
      && (!rootTaskId || batch.rootTaskId === rootTaskId));
    return this.pending.some(matches) || matches(this.activeBatch);
  }

  /** Revoke only work whose execution segment left the full host history. */
  public invalidateHistory(scope: HistoryTruncationScope, removedTargetIds: readonly string[] = []): void {
    const affected = (batch: DelegatedApprovalBatch | undefined) => batch?.sessionId === scope.sessionId
      && (scope.removedSegmentIds.includes(batch.runId)
        || [...batch.editIds, ...batch.draftRunIds].some(id => removedTargetIds.includes(id)));
    this.pending = this.pending.filter(batch => !affected(batch));
    if (affected(this.activeBatch)) this.active?.abort(new Error('Approval source was superseded by edit and resend.'));
  }

  public cancel(reason?: unknown): void {
    this.pending = [];
    this.active?.abort(reason);
  }
}

export function draftRunPreparedMessage(mode: ApprovalMode | undefined, language: 'zh-CN' | 'en'): string {
  const approval = normalizeApprovalMode(mode);
  if (language === 'en') return 'DraftRun prepared only; no process was started. ' + (approval === 'ask'
    ? 'Wait for the user to approve this execution in KeepSeek.'
    : 'The host will process this operation after hard preflight checks, requesting a precise user decision only when needed.');
  return '仅准备了 DraftRun 草稿，尚未执行。' + (approval === 'ask' ? '等待用户在 KeepSeek 中批准本次执行。'
    : '宿主将在硬性预检通过后处理此操作，仅在必要时请求用户作精确决定。');
}
