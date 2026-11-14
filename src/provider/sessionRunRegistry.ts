/**
 * Per-session run registry for the extension host.
 *
 * The Provider historically kept a single global `isBusy` flag, which made any
 * run block every session. Parallel execution needs to know *which* sessions
 * are running so that:
 *
 *   - a foreign session's run never blocks this session's admission;
 *   - a session's own run still blocks a second run of the same session;
 *   - the UI can project run state only onto the session that owns it.
 *
 * This module only tracks bookkeeping. It deliberately does not decide
 * authority over file side effects — that stays with the project write lease.
 */

export interface SessionRunSnapshot {
  sessionId: string;
  /** Monotonic token so a late completion cannot release a newer run. */
  token: number;
  startedAt: number;
}

export interface SessionRunHandle {
  readonly sessionId: string;
  readonly token: number;
  /** Releases this run exactly once; safe to call from a finally block. */
  release(): void;
}

export class SessionRunRegistry {
  private readonly runs = new Map<string, SessionRunSnapshot>();
  private nextToken = 0;

  public constructor(private readonly now: () => number = () => Date.now()) {}

  /** Sessions with an active run, in start order. */
  public activeSessionIds(): string[] {
    return [...this.runs.keys()];
  }

  public isRunning(sessionId: string): boolean {
    return this.runs.has(sessionId);
  }

  public snapshot(sessionId: string): SessionRunSnapshot | undefined {
    return this.runs.get(sessionId);
  }

  /** True when any session is running (used only by genuinely global barriers). */
  public anyRunning(): boolean {
    return this.runs.size > 0;
  }

  public countRunning(): number {
    return this.runs.size;
  }

  /**
   * Claims a run for `sessionId`.
   *
   * Returns `undefined` when that session already runs: one session may only
   * have one run in flight, while different sessions run concurrently.
   */
  public tryStart(sessionId: string): SessionRunHandle | undefined {
    if (!sessionId || this.runs.has(sessionId)) return undefined;
    const token = ++this.nextToken;
    this.runs.set(sessionId, { sessionId, token, startedAt: this.now() });
    let released = false;
    return {
      sessionId,
      token,
      release: () => {
        if (released) return;
        released = true;
        // Only clear the run this handle created.
        const current = this.runs.get(sessionId);
        if (current?.token === token) this.runs.delete(sessionId);
      }
    };
  }

  /** Releases whatever run this session currently has (cancel/teardown paths). */
  public forceRelease(sessionId: string): boolean {
    return this.runs.delete(sessionId);
  }

  public clear(): void {
    this.runs.clear();
  }
}