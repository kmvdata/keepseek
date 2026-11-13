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

const MAX_DIAGNOSTIC_LENGTH = 2_000;

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/**
 * Current-protocol validation. An unstarted pending proposal stays executable,
 * so only a complete payload (replacement identity plus its hash) is accepted;
 * anything else is treated as absent and the original remains itself.
 */
export function normalizePendingReplacement(value: unknown): DraftRunPendingReplacement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isIdentity(record.replacementDraftRunId) || !isHash(record.originalSpecHash) || !isHash(record.replacementSpecHash)) {
    return undefined;
  }
  const dispatch = record.dispatch;
  if (dispatch !== undefined
    && (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch))) return undefined;
  return {
    replacementDraftRunId: record.replacementDraftRunId,
    originalSpecHash: record.originalSpecHash,
    replacementSpecHash: record.replacementSpecHash,
    ...(dispatch ? { dispatch: structuredClone(dispatch) as DraftRun['dispatch'] } : {}),
    ...(record.approvalHold && typeof record.approvalHold === 'object' ? { approvalHold: structuredClone(record.approvalHold) as DraftRun['approvalHold'] } : {}),
    reason: typeof record.reason === 'string' && record.reason.trim() ? record.reason.slice(0, MAX_DIAGNOSTIC_LENGTH) : undefined,
    createdAt: typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
      ? record.createdAt : new Date(0).toISOString()
  };
}

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

/** Detection is an identity check only; it grants nothing. */
export function isPendingReplacementOriginal(run: DraftRun): boolean {
  return hasPendingReplacement(run);
}