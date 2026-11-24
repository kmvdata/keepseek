import { createFreeLease, isLeaseHolder, type WriteLeaseRecord, type WritePurpose } from './writeLease';

/**
 * In-memory mirror of the durable write lease.
 *
 * `writeGate.authorize()` is contractually synchronous — a side effect must
 * never slip between the check and the operation it guards — while the lease
 * itself lives in a cross-process file. This mirror closes that gap:
 *
 *   - every decision reads only this snapshot (synchronous, never awaits);
 *   - the async `acquire`/`release` path updates the snapshot *before* the
 *     guarded operation is allowed to start.
 *
 * A stale snapshot can therefore only cause a *refusal* (the operation fails
 * and is retried), never an unauthorized concurrent write: real correctness is
 * still the base-hash CAS in `SafeFileEditor`.
 */
export class WriteLeaseMirror {
  private current: WriteLeaseRecord;
  private readonly listeners = new Set<(lease: WriteLeaseRecord) => void>();

  public constructor(
    private readonly workspaceKey: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.current = createFreeLease(workspaceKey);
  }

  public get workspace(): string {
    return this.workspaceKey;
  }

  /** The current snapshot. Callers must not mutate it. */
  public peek(): WriteLeaseRecord {
    return this.current;
  }

  /**
   * Synchronous admission check.
   *
   * An expired-but-live holder still owns the lease: it may be paused mid-write,
   * and a concurrent writer would corrupt the batch. Only an explicit release,
   * or reclaim of a dead holder, frees the project.
   */
  public allows(sessionId: string, _purpose: WritePurpose): boolean {
    if (!sessionId) return false;
    return isLeaseHolder(this.current, sessionId);
  }

  public holder(): string | undefined {
    return this.current.state === 'held' ? this.current.holderSessionId : undefined;
  }

  public epoch(): number {
    return this.current.epoch;
  }

  /** Apply a snapshot read from disk (or written by this window). */
  public apply(lease: WriteLeaseRecord): void {
    if (lease.workspaceKey !== this.workspaceKey) return;
    if (lease.epoch < this.current.epoch) return;
    const changed = lease.epoch !== this.current.epoch
      || lease.holderSessionId !== this.current.holderSessionId
      || lease.state !== this.current.state;
    this.current = lease;
    if (changed) this.notify();
  }

  /**
   * Adopt a lease this window just acquired. The epoch always advances on an
   * acquire, so this cannot be rejected as stale.
   */
  public adopt(lease: WriteLeaseRecord): void {
    this.current = lease;
    this.notify();
  }

  /** Drop to free after a release this window performed. */
  public markReleased(epoch: number): void {
    this.current = { version: 1, workspaceKey: this.workspaceKey, state: 'free', epoch };
    this.notify();
  }

  public subscribe(listener: (lease: WriteLeaseRecord) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Epoch the mirrored claim would expire at; used by the poller backoff. */
  public staleSince(ttlMs: number): boolean {
    if (this.current.state !== 'held' || !this.current.expiresAt) return this.current.state === 'held';
    const expires = Date.parse(this.current.expiresAt);
    return Number.isFinite(expires) && expires <= this.now() + ttlMs / 6;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try { listener(this.current); } catch { /* a broken listener must not break the gate */ }
    }
  }
}