/** Zero is the only serialized unlimited value. Never pass it to a timer. */
export function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value))) : 0;
}

export function mergeDurations(...values: unknown[]): number {
  const finite = values.map(normalizeDuration).filter((value) => value > 0);
  return finite.length ? Math.min(...finite) : 0;
}

export class ExecutionBudgetError extends Error {
  public constructor() { super('Effective execution time budget exhausted / 有效执行时间预算已用尽'); }
}

/** Counts the union of active scopes, not the sum of parallel child durations.
 * Long host suspension/event-loop gaps are conservatively excluded. Wall clock
 * timestamps are for display only; restart resumes the persisted usedMs. */
export class ExecutionClock {
  private active = 0;
  private last: number;
  private used: number;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  public constructor(public readonly limitMs: number, usedMs = 0,
    private readonly now: () => number = () => performance.now()) {
    this.used = normalizeDuration(usedMs);
    this.last = now();
  }
  public get signal(): AbortSignal { return this.controller.signal; }
  public get usedMs(): number { this.sample(); return Math.floor(this.used); }
  public get remainingMs(): number { return this.limitMs > 0 ? Math.max(0, this.limitMs - this.usedMs) : Infinity; }
  public sample(): void {
    const next = this.now();
    const delta = next - this.last;
    this.last = next;
    if (this.active && delta >= 0 && delta <= 5_000) this.used += delta;
    if (this.limitMs > 0 && this.used >= this.limitMs) this.controller.abort(new ExecutionBudgetError());
  }
  public enter(): () => void {
    this.sample();
    this.active++;
    if (!this.timer) {
      this.timer = setInterval(() => this.sample(), 250);
      this.timer.unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sample();
      this.active--;
      if (!this.active && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    };
  }
  public dispose(): void { this.sample(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

/** Cancellation of a modal/uncancellable read must release the execution chain;
 * its late result cannot authorize or start a tool. */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error('Stopped');
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Stopped')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
