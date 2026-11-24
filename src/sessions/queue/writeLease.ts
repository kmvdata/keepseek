/**
 * Project write lease — one project, one writer.
 *
 * Every file side effect (DraftEdit apply, DraftRun dispatch, fixed validation)
 * must hold the project's single write lease for the whole batch. Drafts are
 * prepared without the lease: a draft is a proposal, not a workspace change.
 *
 * The lease is deliberately NOT the queue position. The queue survives only as
 * the fairness order and as presentation; whether a session may write is
 * decided here, so two sessions may both be `normal` while only the holder
 * touches the workspace.
 *
 * Crash safety: the holder renews `expiresAt` with a heartbeat while it works,
 * which is what lets a long `npm test` or `git push` keep the lease. A lease is
 * only reclaimed when its TTL lapsed AND the recorded pid is gone, so a paused
 * window keeps its lease instead of being silently preempted mid-write.
 *
 * `epoch` guards late operations: an operation captures the epoch when it
 * acquires and must re-check it before acting again.
 */

/** What the holder is doing. Recorded for diagnostics and UI only. */
export type WritePurpose = 'edit' | 'command' | 'validation' | 'git_mutation';

export type LeaseState = 'free' | 'held';

export interface WriteLeaseRecord {
  version: 1;
  workspaceKey: string;
  state: LeaseState;
  holderSessionId?: string;
  /** pid of the window that acquired the lease; used for crash detection. */
  holderPid?: number;
  purpose?: WritePurpose;
  /** Batch identity so the UI can name what is being processed. */
  batchId?: string;
  epoch: number;
  acquiredAt?: string;
  heartbeatAt?: string;
  /** After this instant the lease may be reclaimed if the holder is gone. */
  expiresAt?: string;
}

export type LeaseDenyReason =
  | 'held_by_other'
  | 'not_holder'
  | 'stale_epoch'
  | 'invalid_purpose';

export interface LeaseOutcome {
  lease: WriteLeaseRecord;
  /** Whether the requested transition actually happened. */
  applied: boolean;
  reason?: LeaseDenyReason;
}

/** How long a holder may stay silent before the lease becomes reclaimable. */
export const LEASE_TTL_MS = 30_000;
/** Renewal cadence; comfortably below the TTL so one slow tick cannot expire. */
export const LEASE_HEARTBEAT_MS = 5_000;

export function createFreeLease(workspaceKey: string): WriteLeaseRecord {
  return { version: 1, workspaceKey, state: 'free', epoch: 0 };
}

export function isLeaseHolder(lease: WriteLeaseRecord, sessionId: string): boolean {
  return lease.state === 'held' && lease.holderSessionId === sessionId;
}

/** True while the record still claims a holder. Never authoritative alone. */
export function isHeld(lease: WriteLeaseRecord): boolean {
  return lease.state === 'held' && Boolean(lease.holderSessionId);
}

function expiryOf(record: WriteLeaseRecord): number {
  if (!record.expiresAt) return 0;
  const parsed = Date.parse(record.expiresAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** True when the holder stopped renewing. Says nothing about the process. */
export function isExpired(lease: WriteLeaseRecord, now: number = Date.now()): boolean {
  if (!isHeld(lease)) return false;
  return expiryOf(lease) <= now;
}

/**
 * Whether this lease may be taken away from its holder.
 *
 * `alive` answers "is the recorded pid still running". A live process keeps the
 * lease even past its TTL: it may be paused in a debugger or blocked on a slow
 * share, and preempting it would corrupt an in-flight write. Only a lapsed TTL
 * on a dead process proves the holder is gone.
 */
export function isReclaimable(
  lease: WriteLeaseRecord,
  now: number = Date.now(),
  alive: (pid: number) => boolean = () => true
): boolean {
  if (!isHeld(lease)) return false;
  if (!isExpired(lease, now)) return false;
  if (lease.holderPid === undefined) return true;
  return !alive(lease.holderPid);
}

export interface AcquireRequest {
  sessionId: string;
  purpose: WritePurpose;
  batchId?: string;
  pid?: number;
}

/**
 * Acquire the project write lease.
 *
 * - free            → granted.
 * - mine            → no-op, already held (the caller keeps its epoch).
 * - other, alive    → refused; the caller must wait for the holder to release.
 * - other, expired  → reclaimed: the holder is dead, so the lease moves.
 */
export function tryAcquire(
  lease: WriteLeaseRecord,
  request: AcquireRequest,
  now: Date = new Date(),
  alive: (pid: number) => boolean = () => true
): LeaseOutcome {
  if (!request.sessionId || !request.purpose) {
    return { lease, applied: false, reason: 'invalid_purpose' };
  }
  const nowMs = now.getTime();
  if (isLeaseHolder(lease, request.sessionId)) {
    return { lease, applied: false, reason: 'not_holder' };
  }
  if (isHeld(lease) && !isReclaimable(lease, nowMs, alive)) {
    return { lease, applied: false, reason: 'held_by_other' };
  }
  const stamp = now.toISOString();
  return {
    lease: {
      version: 1,
      workspaceKey: lease.workspaceKey,
      state: 'held',
      holderSessionId: request.sessionId,
      ...(request.pid !== undefined ? { holderPid: request.pid } : {}),
      purpose: request.purpose,
      ...(request.batchId ? { batchId: request.batchId } : {}),
      epoch: lease.epoch + 1,
      acquiredAt: stamp,
      heartbeatAt: stamp,
      expiresAt: new Date(nowMs + LEASE_TTL_MS).toISOString()
    },
    applied: true
  };
}

/**
 * Extend the lease. Only the holder, and only at the epoch it acquired, may
 * renew: a late timer from a previous holder must not resurrect its claim.
 */
export function heartbeat(
  lease: WriteLeaseRecord,
  sessionId: string,
  epoch: number,
  now: Date = new Date()
): LeaseOutcome {
  if (!isLeaseHolder(lease, sessionId)) return { lease, applied: false, reason: 'not_holder' };
  if (lease.epoch !== epoch) return { lease, applied: false, reason: 'stale_epoch' };
  const stamp = now.toISOString();
  return {
    lease: {
      ...lease,
      heartbeatAt: stamp,
      expiresAt: new Date(now.getTime() + LEASE_TTL_MS).toISOString()
    },
    applied: true
  };
}

/** Release at the same epoch that acquired it. */
export function release(
  lease: WriteLeaseRecord,
  sessionId: string,
  epoch: number
): LeaseOutcome {
  if (!isLeaseHolder(lease, sessionId)) return { lease, applied: false, reason: 'not_holder' };
  if (lease.epoch !== epoch) return { lease, applied: false, reason: 'stale_epoch' };
  return {
    lease: { version: 1, workspaceKey: lease.workspaceKey, state: 'free', epoch: lease.epoch + 1 },
    applied: true
  };
}

/**
 * Emergency release by the host: the user explicitly aborted the holder. This
 * is the only path that drops a lease whose process may still be alive, so the
 * caller must audit it.
 */
export function forceRelease(lease: WriteLeaseRecord): LeaseOutcome {
  if (!isHeld(lease)) return { lease, applied: false, reason: 'not_holder' };
  return {
    lease: { version: 1, workspaceKey: lease.workspaceKey, state: 'free', epoch: lease.epoch + 1 },
    applied: true
  };
}

/** An operation started at `epoch` may still act only as that same holder. */
export function isEpochCurrent(lease: WriteLeaseRecord, sessionId: string, epoch: number): boolean {
  return lease.epoch === epoch && isLeaseHolder(lease, sessionId);
}

const PURPOSES = new Set<WritePurpose>(['edit', 'command', 'validation', 'git_mutation']);

/**
 * Strict current-protocol validation. Anything unrecognised degrades to a free
 * lease rather than throwing: a damaged lock file must never block the project
 * forever.
 */
export function normalizeWriteLease(value: unknown, workspaceKey: string): WriteLeaseRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createFreeLease(workspaceKey);
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return createFreeLease(workspaceKey);
  if (record.workspaceKey !== workspaceKey) return createFreeLease(workspaceKey);
  const epoch = typeof record.epoch === 'number' && Number.isSafeInteger(record.epoch) && record.epoch >= 0
    ? record.epoch
    : 0;
  const holder = typeof record.holderSessionId === 'string' && record.holderSessionId ? record.holderSessionId : undefined;
  // A record without a holder cannot be held.
  if (record.state !== 'held' || !holder) {
    return { version: 1, workspaceKey, state: 'free', epoch };
  }
  const pid = typeof record.holderPid === 'number' && Number.isSafeInteger(record.holderPid) && record.holderPid > 0
    ? record.holderPid
    : undefined;
  const purpose = typeof record.purpose === 'string' && PURPOSES.has(record.purpose as WritePurpose)
    ? record.purpose as WritePurpose
    : undefined;
  const batchId = typeof record.batchId === 'string' && record.batchId ? record.batchId : undefined;
  const acquiredAt = typeof record.acquiredAt === 'string' && Number.isFinite(Date.parse(record.acquiredAt))
    ? record.acquiredAt
    : undefined;
  const heartbeatAt = typeof record.heartbeatAt === 'string' && Number.isFinite(Date.parse(record.heartbeatAt))
    ? record.heartbeatAt
    : undefined;
  const expiresAt = typeof record.expiresAt === 'string' && Number.isFinite(Date.parse(record.expiresAt))
    ? record.expiresAt
    : undefined;
  // An unreadable expiry would make the lease permanently unreclaimable, so a
  // missing expiry is treated as already lapsed.
  return {
    version: 1,
    workspaceKey,
    state: 'held',
    holderSessionId: holder,
    ...(pid !== undefined ? { holderPid: pid } : {}),
    ...(purpose ? { purpose } : {}),
    ...(batchId ? { batchId } : {}),
    epoch,
    ...(acquiredAt ? { acquiredAt } : {}),
    ...(heartbeatAt ? { heartbeatAt } : {}),
    expiresAt: expiresAt ?? new Date(0).toISOString()
  };
}

/** Whether the local process with `pid` is still running. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as { code?: unknown })?.code === 'EPERM';
  }
}