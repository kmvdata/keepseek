import type { DraftRun } from '../shared/types';

/** One pending, never-dispatched replacement of an original proposal.
 * Persisted beside the original as a single object so the link and its
 * authorization payload can only change together. */
export interface DraftRunPendingReplacement {
  replacementDraftRunId: string;
  /** Hash of the original spec the replacement was bound to. */
  originalSpecHash: string;
  /** Hash of the replacement spec that is the only runnable argv after the swap. */
  replacementSpecHash: string;
  /** Launch/boundary fields of the replacement at swap time. */
  dispatch?: DraftRun['dispatch'];
  /** Approval hold carried with the replacement; diagnostics live in `error`. */
  approvalHold?: DraftRun['approvalHold'];
  reason?: string;
  createdAt: string;
}

/**
 * Current-protocol validation. An unstarted pending proposal stays executable,
 * so only a complete payload (replacement identity plus its hash) is accepted;
 * anything else is treated as absent and the original remains itself.
 */
const LINKED_STATUSES = new Set<DraftRun['status']>(['pending', 'approved', 'running']);

/**
 * True while a pending original points at a replacement that has not started.
 * The original was already swapped out, so it must not be dispatched as itself.
 */
export function hasPendingReplacement(run: DraftRun): boolean {
  const pendingReplacement = run.pendingReplacement;
  return Boolean(pendingReplacement && run.replacementDraftRunId === pendingReplacement.replacementDraftRunId
    && run.specHash === pendingReplacement.originalSpecHash && LINKED_STATUSES.has(run.status)
    && run.executionStarted !== true && run.executionPhase === 'not_dispatched' && !run.startedAt);
}

