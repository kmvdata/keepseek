import type { ApprovalMode } from '../shared/types';

export const DELEGATED_APPROVAL_PROTOCOL_VERSION = 6;

export function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' ? 'delegate' : 'ask';
}

/** Append only to a new user message. Never regenerate a historical prefix. */
export function getApprovalModeUserTail(mode: ApprovalMode): string {
  return mode === 'delegate'
    ? '<keepseek-approval-mode>delegate: The user selected Approve for me for this session. Propose the exact DraftEdits and DraftRuns needed for the task. The host will approve and apply/execute them after this turn, then send the real results in a new turn automatically. Do not ask for manual approval. Continue until the task is complete; only claim effects after their results arrive.</keepseek-approval-mode>'
    : '<keepseek-approval-mode>ask: The user selected Ask for approval. File writes and arbitrary commands require individual user approval. Prepare pending drafts and wait for their results.</keepseek-approval-mode>';
}

export interface DelegatedApprovalBatch {
  sessionId: string;
  runId: string;
  editIds: string[];
  draftRunIds: string[];
  continueAfterBudget?: boolean;
}

/** Volatile queue: reloading the extension must never execute restored drafts. */
export class DelegatedApprovalQueue {
  private pending?: DelegatedApprovalBatch;
  private active?: AbortController;

  public enqueue(batch: DelegatedApprovalBatch): void {
    if (batch.editIds.length || batch.draftRunIds.length || batch.continueAfterBudget) this.pending = structuredClone(batch);
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
