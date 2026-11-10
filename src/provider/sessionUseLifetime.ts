export interface SessionUseLease { release(): Promise<void> }
interface HeldUse { sessionId: string; use: SessionUseLease; checking: boolean; reported: Set<'inspect' | 'release'> }

/** Bridges local queue/continuation gaps without a project owner. Each record
 * remains the exact lease admitted by storage; no new authorization is created.
 * Host decides whether a session still has queued, waiting or settling work. */
export class SessionUseLifetime {
  private readonly held = new Map<SessionUseLease, HeldUse>();
  private readonly released = new WeakSet<SessionUseLease>();
  private timer?: ReturnType<typeof setTimeout>;
  public constructor(private readonly inUse: (sessionId: string) => boolean,
    private readonly options: { pollMs?: number; onError?: (phase: 'inspect' | 'release') => void } = {}) {}

  /** Resolves after registration or immediate release, never after a user wait. */
  public async releaseWhenIdle(sessionId: string, use: SessionUseLease): Promise<void> {
    if (this.released.has(use) || this.held.has(use)) return;
    const item: HeldUse = { sessionId, use, checking: false, reported: new Set() };
    this.held.set(use, item);
    await this.check(item);
    this.schedule();
  }

  /** Call at local task terminal/queue transitions for prompt release. The
   * bounded timer covers transitions whose existing handlers do not notify. */
  public async notify(): Promise<void> {
    for (const item of this.held.values()) await this.check(item);
    if (!this.held.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    this.schedule();
  }

  /** Disposal does not falsely declare an in-flight command idle. Its final
   * state releases the record; process death is handled by the storage authority. */
  public dispose(): void {
    void this.notify();
  }

  public get heldCount(): number { return this.held.size; }

  private async check(item: HeldUse): Promise<void> {
    if (item.checking || this.held.get(item.use) !== item) return;
    let busy: boolean;
    try { busy = this.inUse(item.sessionId); }
    catch { this.report(item, 'inspect'); return; }
    if (busy) return;
    item.checking = true;
    try {
      await item.use.release();
      this.held.delete(item.use);
      this.released.add(item.use);
    } catch { this.report(item, 'release'); }
    finally { item.checking = false; }
  }

  private schedule(): void {
    if (this.timer || !this.held.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.notify(); }, Math.max(10, this.options.pollMs ?? 250));
    this.timer.unref?.();
  }

  private report(item: HeldUse, phase: 'inspect' | 'release'): void {
    if (item.reported.has(phase)) return;
    item.reported.add(phase);
    try { this.options.onError?.(phase); } catch { /* Diagnostics cannot release a protected session. */ }
  }
}
