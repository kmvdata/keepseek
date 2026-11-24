import {
  LEASE_HEARTBEAT_MS,
  isProcessAlive,
  type WriteLeaseRecord,
  type WritePurpose
} from './writeLease';
import type { WriteLeaseMirror } from './writeLeaseMirror';
import type { ProjectWriteLeaseStore } from './writeLeaseStore';

/**
 * Project write lease coordination.
 *
 * `writeGate` gives every side effect a synchronous admit/deny answer; this
 * module owns the asynchronous half — where a lease is actually acquired,
 * renewed and released. It is a registry for the same reason `writeGate` is
 * one: the edit and run stores live below the provider and must not import it.
 *
 * A held lease is a *batch* claim, not a per-write claim:
 *
 *   edit        one session's whole pending ChangeSet batch
 *   command     one DraftRun batch (first dispatch → terminal phase)
 *   validation  one fixed npm script process
 *   git_mutation one DraftRun
 *
 * Drafts are never guarded: preparing a DraftEdit or DraftRun is a proposal,
 * so `addDraftEdits`/`addProposals` stay lock-free by design.
 */

export interface LeaseGrant {
  sessionId: string;
  epoch: number;
  /** Releases this claim exactly once; safe to call from a `finally` block. */
  release(): Promise<void>;
}

export type AcquireFailReason = 'held_by_other' | 'invalid_request' | 'no_authority';

export type AcquireOutcome =
  | { acquired: true; grant: LeaseGrant }
  | { acquired: false; reason: AcquireFailReason; holderSessionId?: string; holderPurpose?: WritePurpose };

export interface LeaseAcquisitionRequest {
  sessionId: string;
  purpose: WritePurpose;
  /** Names the batch for UI and audit, e.g. `edits:<changeSetId>`. */
  batchId?: string;
  /** How long to wait for the current holder before giving up. 0 = no wait. */
  waitMs?: number;
  signal?: AbortSignal;
}

export interface WriteLeaseAuthority {
  acquire(request: LeaseAcquisitionRequest): Promise<AcquireOutcome>;
  /** Current holder for diagnostics; never used to decide a write. */
  describe(): { holderSessionId?: string; purpose?: WritePurpose; batchId?: string; epoch: number };
  /** Explicit user action: drop the lease even if the holder still runs. */
  forceRelease(): Promise<void>;
}

let authority: WriteLeaseAuthority | undefined;

/** Installed by the host at activation; `undefined` restores the permissive state. */
export function installWriteLeaseAuthority(next: WriteLeaseAuthority | undefined): void {
  authority = next;
}

export function getWriteLeaseAuthority(): WriteLeaseAuthority | undefined {
  return authority;
}

/**
 * Ask the installed authority for the project write lease.
 *
 * With no authority installed the call is permissive and returns a no-op grant,
 * which preserves behaviour for tests and headless tooling that never wires a
 * project lock.
 */
export async function acquireWriteLease(request: LeaseAcquisitionRequest): Promise<AcquireOutcome> {
  if (!authority) {
    return { acquired: true, grant: { sessionId: request.sessionId, epoch: 0, release: async () => undefined } };
  }
  if (!request.sessionId || !request.purpose) return { acquired: false, reason: 'invalid_request' };
  return authority.acquire(request);
}

/**
 * Run `work` while holding the project lease.
 *
 * The lease is acquired *before* the first await of `work` and released even if
 * `work` throws, so a failed batch cannot strand the project. A refusal runs no
 * work at all: the caller sees `{ ran: false }` and reports the holder.
 */
export async function withWriteLease<T>(
  request: LeaseAcquisitionRequest,
  work: (grant: LeaseGrant) => Promise<T>
): Promise<{ ran: true; value: T } | { ran: false; outcome: Extract<AcquireOutcome, { acquired: false }> }> {
  const outcome = await acquireWriteLease(request);
  if (!outcome.acquired) return { ran: false, outcome };
  try {
    return { ran: true, value: await work(outcome.grant) };
  } finally {
    await outcome.grant.release().catch(() => undefined);
  }
}

/**
 * Wait for a lease to become available, bounded and abortable.
 *
 * Used by the project-level approve-all drain: it must not spin, and it must
 * give way as soon as the user cancels or the batch loses its context.
 */
export async function waitForWriteLease(
  request: LeaseAcquisitionRequest,
  options: { pollMs?: number; deadline?: number } = {}
): Promise<AcquireOutcome> {
  const pollMs = Math.max(50, options.pollMs ?? 250);
  const deadline = options.deadline ?? Date.now() + (request.waitMs ?? 0);
  for (;;) {
    const outcome = await acquireWriteLease({ ...request, waitMs: 0 });
    if (outcome.acquired) return outcome;
    if (outcome.reason === 'invalid_request' || outcome.reason === 'no_authority') return outcome;
    if (Date.now() >= deadline) return outcome;
    if (request.signal?.aborted) return outcome;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref?.();
      request.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

/**
 * The host-side implementation: durable store + synchronous mirror.
 *
 * Exactly one of these exists per window. It keeps the mirror fresh by polling
 * the lease file, so a foreign window's release becomes visible here without
 * the UI having to ask.
 */
export class ProjectWriteLeaseCoordinator implements WriteLeaseAuthority {
  /**
   * Per-session claim, reference counted.
   *
   * A batch owner (the approve-all drain) acquires once and then calls into the
   * apply/execute paths, which acquire again for their own sub-batch. The depth
   * keeps the outer claim alive: only the last release actually frees the
   * project, so a nested apply can never hand the lock to another session while
   * its caller is still mid-batch.
   */
  private readonly grants = new Map<string, { epoch: number; depth: number; timer?: ReturnType<typeof setInterval> }>();
  private pollTimer?: ReturnType<typeof setInterval>;
  /** Storage could not be read; polling stays off until a retry succeeds. */
  private failed = false;
  private readonly listeners = new Set<(lease: WriteLeaseRecord) => void>();

  public constructor(
    private readonly workspaceKey: string,
    private readonly store: ProjectWriteLeaseStore,
    private readonly mirror: WriteLeaseMirror,
    private readonly options: {
      pid?: number;
      heartbeatMs?: number;
      pollMs?: number;
      /** Set false by hosts (and tests) that drive the lease explicitly. */
      background?: boolean;
      alive?: (pid: number) => boolean;
      onError?: (error: unknown) => void;
    } = {}
  ) {}

  public get workspace(): string {
    return this.workspaceKey;
  }

  public get snapshot(): WriteLeaseMirror {
    return this.mirror;
  }

  /**
   * Load the lease once at activation so the gate can answer immediately.
   *
   * A host whose storage is not ready yet must still leave the gate permissive:
   * the mirror keeps its free lease snapshot and polling starts only once a real
   * read succeeded, so a broken store cannot spin a timer against itself.
   */
  public async initialize(): Promise<WriteLeaseRecord> {
    let lease: WriteLeaseRecord;
    try {
      lease = await this.store.load(this.workspaceKey);
    } catch (error) {
      this.options.onError?.(error);
      this.failed = true;
      return this.mirror.peek();
    }
    this.failed = false;
    this.mirror.apply(lease);
    if (lease.state === 'held' && lease.holderSessionId === undefined) this.mirror.markReleased(lease.epoch);
    this.startPolling();
    return lease;
  }

  public async acquire(request: LeaseAcquisitionRequest): Promise<AcquireOutcome> {
    const sessionId = request.sessionId;
    // A nested acquire inside the same session joins the existing claim.
    const existing = this.grants.get(sessionId);
    if (existing && this.mirror.peek().epoch === existing.epoch) {
      existing.depth += 1;
      return { acquired: true, grant: this.grantFor(sessionId, existing.epoch) };
    }
    const pid = this.options.pid ?? process.pid;
    const alive = this.options.alive ?? isProcessAlive;
    try {
      const result = await this.store.acquire(this.workspaceKey, {
        sessionId,
        purpose: request.purpose,
        ...(request.batchId ? { batchId: request.batchId } : {}),
        pid
      }, alive).catch((error: unknown) => {
        this.options.onError?.(error);
        // Storage failed: refuse rather than grant. A write without a verifiable
        // lock is exactly the concurrent write this lock exists to prevent.
        this.failed = true;
        return { acquired: false as const, lease: this.mirror.peek() };
      });
      if (!result.acquired) {
        const holder = result.lease.state === 'held' ? result.lease : undefined;
        return {
          acquired: false,
          reason: 'held_by_other',
          ...(holder?.holderSessionId ? { holderSessionId: holder.holderSessionId } : {}),
          ...(holder?.purpose ? { holderPurpose: holder.purpose } : {})
        };
      }
      this.mirror.adopt(result.lease);
      this.startHeartbeat(sessionId, result.lease.epoch);
      return { acquired: true, grant: this.grantFor(sessionId, result.lease.epoch) };
    } catch (error) {
      this.options.onError?.(error);
      throw error;
    }
  }

  public describe(): { holderSessionId?: string; purpose?: WritePurpose; batchId?: string; epoch: number } {
    const lease = this.mirror.peek();
    return {
      ...(lease.state === 'held' && lease.holderSessionId ? { holderSessionId: lease.holderSessionId } : {}),
      ...(lease.purpose ? { purpose: lease.purpose } : {}),
      ...(lease.batchId ? { batchId: lease.batchId } : {}),
      epoch: lease.epoch
    };
  }

  public async forceRelease(): Promise<void> {
    for (const [sessionId] of this.grants) this.stopHeartbeat(sessionId);
    this.grants.clear();
    const lease = await this.store.forceRelease(this.workspaceKey);
    this.mirror.apply(lease);
  }

  /** Re-read the lease from disk. Called by the poller and at batch boundaries. */
  public async refresh(): Promise<WriteLeaseRecord> {
    try {
      const lease = await this.store.load(this.workspaceKey);
      this.failed = false;
      this.mirror.apply(lease);
      return lease;
    } catch (error) {
      // Keep serving the last known snapshot; a failed poll must never turn into
      // an ever-growing queue of retries.
      this.failed = true;
      if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
      this.options.onError?.(error);
      return this.mirror.peek();
    }
  }

  public subscribe(listener: (lease: WriteLeaseRecord) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  public dispose(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
    for (const [sessionId] of this.grants) this.stopHeartbeat(sessionId);
    this.grants.clear();
    this.listeners.clear();
  }

  private grantFor(sessionId: string, epoch: number): LeaseGrant {
    let released = false;
    return {
      sessionId,
      epoch,
      release: async () => {
        if (released) return;
        released = true;
        const entry = this.grants.get(sessionId);
        // Still held by an outer batch: drop one level, keep the heartbeat.
        if (entry && entry.epoch === epoch && entry.depth > 1) {
          entry.depth -= 1;
          return;
        }
        this.stopHeartbeat(sessionId);
        try {
          const result = await this.store.release(this.workspaceKey, sessionId, epoch);
          this.mirror.apply(result.lease);
          this.notify(result.lease);
        } catch (error) {
          // A failed release leaves a heartbeat-less record that the TTL+pid
          // reclaim path will free; it must not fail the caller's operation.
          this.options.onError?.(error);
        }
      }
    };
  }

  private startHeartbeat(sessionId: string, epoch: number): void {
    this.stopHeartbeat(sessionId);
    if (this.options.background === false) { this.grants.set(sessionId, { epoch, depth: 1 }); return; }
    const every = Math.max(1_000, this.options.heartbeatMs ?? LEASE_HEARTBEAT_MS);
    const timer = setInterval(() => {
      void this.store.renew(this.workspaceKey, sessionId, epoch)
        .then((result) => {
          // Lost the claim: stop renewing so the lease can be reclaimed.
          if (!result.renewed) this.stopHeartbeat(sessionId);
        })
        .catch((error) => this.options.onError?.(error));
    }, every);
    timer.unref?.();
    this.grants.set(sessionId, { epoch, depth: 1, timer });
  }

  private stopHeartbeat(sessionId: string): void {
    const entry = this.grants.get(sessionId);
    if (entry?.timer) clearInterval(entry.timer);
    this.grants.delete(sessionId);
  }

  private startPolling(): void {
    if (this.options.background === false || this.pollTimer || this.failed) return;
    const every = Math.max(500, this.options.pollMs ?? 2_000);
    this.pollTimer = setInterval(() => {
      void this.refresh().then((lease) => this.notify(lease)).catch((error) => this.options.onError?.(error));
    }, every);
    this.pollTimer.unref?.();
  }

  private notify(lease: WriteLeaseRecord): void {
    for (const listener of this.listeners) {
      try { listener(lease); } catch { /* one broken listener must not break the coordinator */ }
    }
  }
}