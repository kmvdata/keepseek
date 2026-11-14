/**
 * Project write lease — explicit handoff (decision D1).
 *
 * Exactly one session may hold a project's write lease at a time. The lease is
 * NEVER preempted: when the queue order changes and a different session should
 * become the writer, the seat only moves once the current holder reaches an
 * end boundary and hands off, or the user explicitly cancels the holder.
 *
 * `epoch` guards against late operations from a previous holder: an operation
 * captures the epoch when it starts and must re-check it before acting again.
 */

export type LeaseState = 'free' | 'held' | 'handoff_requested' | 'handing_off';

/**
 * Boundaries at which a holder may hand off. A handoff is only legal at one of
 * these points, which is what keeps an in-progress atomic write from being
 * interrupted.
 */
export type HandoffBoundary =
  | 'tool_completed'
  | 'apply_completed'
  | 'draft_run_terminal'
  | 'model_turn_ended'
  | 'task_ended';

export const HANDOFF_BOUNDARIES: readonly HandoffBoundary[] = [
  'tool_completed',
  'apply_completed',
  'draft_run_terminal',
  'model_turn_ended',
  'task_ended'
];

export interface LeaseSnapshot {
  workspaceKey: string;
  state: LeaseState;
  holderSessionId?: string;
  /** Session waiting for the current holder to hand off. */
  pendingHandoffToSessionId?: string;
  acquiredAt?: string;
  /** Incremented on every transfer and release. */
  epoch: number;
}

export interface LeaseOutcome {
  lease: LeaseSnapshot;
  /** Whether the requested transition actually happened. */
  applied: boolean;
  reason?: 'held_by_other' | 'not_holder' | 'invalid_boundary' | 'already_held' | 'not_handing_off' | 'no_pending_handoff';
}

export function createFreeLease(workspaceKey: string): LeaseSnapshot {
  return { workspaceKey, state: 'free', epoch: 0 };
}

export function isLeaseHolder(lease: LeaseSnapshot, sessionId: string): boolean {
  return lease.holderSessionId === sessionId;
}

/**
 * Acquire the lease.
 *
 * - free  → granted immediately.
 * - mine  → no-op, already held.
 * - other → NOT granted. Under explicit handoff the caller must wait; the
 *   holder is asked to hand off when it reaches a boundary.
 */
export function tryAcquire(
  lease: LeaseSnapshot,
  sessionId: string,
  now: string = new Date().toISOString()
): LeaseOutcome {
  if (lease.holderSessionId === sessionId) {
    return { lease, applied: false, reason: 'already_held' };
  }
  if (lease.state !== 'free' && lease.holderSessionId) {
    return { lease, applied: false, reason: 'held_by_other' };
  }
  return {
    lease: {
      workspaceKey: lease.workspaceKey,
      state: 'held',
      holderSessionId: sessionId,
      acquiredAt: now,
      epoch: lease.epoch + 1
    },
    applied: true
  };
}

/**
 * Ask the current holder to hand off to `targetSessionId`. This only records a
 * request; the holder still owns the lease until it reaches a boundary and
 * calls `handOff`. Requesting a handoff for a session that already holds it is
 * a no-op.
 */
export function requestHandoff(
  lease: LeaseSnapshot,
  targetSessionId: string,
  _now: string = new Date().toISOString()
): LeaseOutcome {
  if (!lease.holderSessionId) return { lease, applied: false, reason: 'no_pending_handoff' };
  if (lease.holderSessionId === targetSessionId) return { lease, applied: false, reason: 'already_held' };
  if (lease.pendingHandoffToSessionId === targetSessionId && lease.state === 'handoff_requested') {
    return { lease, applied: false };
  }
  return {
    lease: {
      ...lease,
      state: 'handoff_requested',
      pendingHandoffToSessionId: targetSessionId,
      epoch: lease.epoch
    },
    applied: true,
    reason: undefined
  };
}

/**
 * The holder hands off at a real boundary. Only the holder may call this, and
 * only at a boundary; otherwise the write in progress could be split.
 */
export function handOff(
  lease: LeaseSnapshot,
  sessionId: string,
  boundary: HandoffBoundary,
  now: string = new Date().toISOString()
): LeaseOutcome {
  if (lease.holderSessionId !== sessionId) return { lease, applied: false, reason: 'not_holder' };
  if (!HANDOFF_BOUNDARIES.includes(boundary)) return { lease, applied: false, reason: 'invalid_boundary' };
  const target = lease.pendingHandoffToSessionId;
  if (!target) return { lease, applied: false, reason: 'no_pending_handoff' };
  return {
    lease: {
      workspaceKey: lease.workspaceKey,
      state: 'held',
      holderSessionId: target,
      acquiredAt: now,
      epoch: lease.epoch + 1
    },
    applied: true
  };
}

/** The holder releases the lease; the project becomes idle. */
export function release(
  lease: LeaseSnapshot,
  sessionId: string
): LeaseOutcome {
  if (lease.holderSessionId !== sessionId) return { lease, applied: false, reason: 'not_holder' };
  return {
    lease: { workspaceKey: lease.workspaceKey, state: 'free', epoch: lease.epoch + 1 },
    applied: true
  };
}

/** A queued session is no longer desired (deleted or cancelled). */
export function cancelHandoffRequest(lease: LeaseSnapshot, sessionId?: string): LeaseOutcome {
  if (lease.state !== 'handoff_requested') return { lease, applied: false, reason: 'not_handing_off' };
  if (sessionId && lease.pendingHandoffToSessionId !== sessionId) {
    return { lease, applied: false, reason: 'no_pending_handoff' };
  }
  const rest: LeaseSnapshot = { ...lease, state: 'held' };
  delete rest.pendingHandoffToSessionId;
  return { lease: { ...rest, state: 'held' }, applied: true };
}

/**
 * Emergency recovery only: the holder stopped responding. This is the single
 * non-explicit path that transfers the lease, so it must be audited.
 */
export function reclaim(lease: LeaseSnapshot): LeaseOutcome {
  if (lease.state === 'free') return { lease, applied: false, reason: 'not_holder' };
  return {
    lease: { workspaceKey: lease.workspaceKey, state: 'free', epoch: lease.epoch + 1 },
    applied: true
  };
}

/**
 * An operation started at `epoch` may still act only while it is the current
 * epoch and the same session still holds the lease.
 */
export function isEpochCurrent(
  lease: LeaseSnapshot,
  sessionId: string,
  epoch: number
): boolean {
  return lease.epoch === epoch && lease.holderSessionId === sessionId;
}

export interface SerializedLease {
  version: 1;
  workspaceKey: string;
  state: LeaseState;
  holderSessionId?: string;
  pendingHandoffToSessionId?: string;
  acquiredAt?: string;
  epoch: number;
}

export function toSerializableLease(lease: LeaseSnapshot): SerializedLease {
  return { version: 1, ...lease };
}

export function normalizeLease(value: unknown, workspaceKey: string): LeaseSnapshot {
  if (!value || typeof value !== 'object') return createFreeLease(workspaceKey);
  const record = value as Record<string, unknown>;
  const state = record.state;
  const holder = typeof record.holderSessionId === 'string' && record.holderSessionId ? record.holderSessionId : undefined;
  const pending = typeof record.pendingHandoffToSessionId === 'string' && record.pendingHandoffToSessionId
    ? record.pendingHandoffToSessionId
    : undefined;
  const epoch = typeof record.epoch === 'number' && Number.isSafeInteger(record.epoch) && record.epoch >= 0
    ? record.epoch
    : 0;
  const acquiredAt = typeof record.acquiredAt === 'string' && Number.isFinite(Date.parse(record.acquiredAt))
    ? record.acquiredAt
    : undefined;
  // A lease without a holder cannot be in any non-free state.
  if (!holder || state !== 'held' && state !== 'handoff_requested' && state !== 'handing_off') {
    return createFreeLease(workspaceKey);
  }
  return {
    workspaceKey,
    state: state as LeaseState,
    holderSessionId: holder,
    ...(pending ? { pendingHandoffToSessionId: pending } : {}),
    ...(acquiredAt ? { acquiredAt } : {}),
    epoch
  };
}
