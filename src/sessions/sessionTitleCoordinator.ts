import type { ChatSessionStore } from './chatSessionStore';
import { buildSessionTitleMaterial, parseSessionTitleResult, sessionTitleTaskBasisMatches, SESSION_TITLE_SYSTEM_PROMPT, type SessionTitleBasis } from './sessionTitle';

export interface SessionTitleRequest {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  token: string;
}

/** Safe, presentation-independent terminal result. Provider text/errors never
 * cross this boundary; the host associates it with its own request identity. */
export type SessionTitleRegenerationOutcome = 'updated' | 'unchanged' | 'no_material' | 'unavailable'
  | 'busy' | 'cancelled' | 'stale' | 'invalid' | 'timeout' | 'failed' | 'save_failed';
export interface SessionTitleRegenerationResult {
  outcome: SessionTitleRegenerationOutcome;
}

/** Background-only coordinator. The host supplies a confirmed final logical
 * turn; this module never starts a main task or owns UI busy/clock state. */
export class SessionTitleCoordinator {
  private readonly running = new Map<string, AbortController>();
  private readonly pending = new Set<Promise<SessionTitleRegenerationResult>>();
  private disposed = false;

  public constructor(private readonly store: ChatSessionStore, private readonly options: {
    onCommitted?: (sessionId: string, mode: 'automatic' | 'manual') => void | Promise<void>;
    canCommit?: () => boolean;
    onDiagnostic?: (sessionId: string, taskId: string, outcome: string, elapsedMs: number) => void;
  } = {}) {}

  public cancel(sessionId: string): void {
    this.running.get(sessionId)?.abort();
    this.running.delete(sessionId);
    this.store.invalidateSessionTitle(sessionId);
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelAll();
  }

  public cancelAll(): void {
    for (const sessionId of [...this.running.keys()]) this.cancel(sessionId);
  }

  /** Cancellation is a request, not evidence that already incurred usage has
   * finished committing. Project shutdown crosses this durability barrier. */
  public async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  public async complete(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>): Promise<boolean> {
    const result = await this.track(this.run(sessionId, taskId, request, 'automatic'));
    return result.outcome === 'updated' || result.outcome === 'unchanged';
  }

  /** Explicit user intent may replace an automatic or custom title. A failed
   * request keeps that title and its previous automatic-stop/manual-lock state. */
  public async regenerate(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>,
    material: { userPrompt: string; basis: SessionTitleBasis }): Promise<boolean> {
    const result = await this.regenerateResult(sessionId, taskId, request, material);
    return result.outcome === 'updated' || result.outcome === 'unchanged';
  }

  public regenerateResult(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>,
    material: { userPrompt: string; basis: SessionTitleBasis }): Promise<SessionTitleRegenerationResult> {
    return this.track(this.run(sessionId, taskId, request, 'manual', material));
  }

  private track(promise: Promise<SessionTitleRegenerationResult>): Promise<SessionTitleRegenerationResult> {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  private async run(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>, mode: 'automatic' | 'manual',
    suppliedMaterial?: { userPrompt: string; basis: SessionTitleBasis }): Promise<SessionTitleRegenerationResult> {
    if (this.disposed) return { outcome: 'cancelled' };
    if (this.running.has(sessionId)) return { outcome: 'busy' };
    if (this.options.canCommit?.() === false) return { outcome: 'unavailable' };
    const session = this.store.getSessionById(sessionId);
    if (!session || (mode === 'automatic' && (session.customTitle || session.autoTitle?.status === 'completed'))) return { outcome: 'stale' };
    // Late/duplicate completion events cannot name an earlier logical turn.
    const tail = [...session.messages].reverse().find(message => message.userTask);
    if (mode === 'automatic' && (tail?.role !== 'assistant' || tail.userTask?.id !== taskId || tail.isStreaming)) return { outcome: 'stale' };
    const material = suppliedMaterial ?? buildSessionTitleMaterial(session.messages, taskId);
    if (!material) return { outcome: 'no_material' };
    if (mode === 'manual' && !sessionTitleTaskBasisMatches(session.messages, taskId, material.basis)) return { outcome: 'stale' };
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const startedAt = performance.now();
    const diagnose = (outcome: string) => this.options.onDiagnostic?.(sessionId, taskId, outcome,
      Math.max(0, Math.round(performance.now() - startedAt)));
    let token: string | undefined;
    let stage: 'claim' | 'request' | 'save' = 'claim';
    try {
      const claim = await this.store.claimSessionTitle(sessionId, taskId, material.basis, mode);
      if (!claim) { diagnose('stale'); return { outcome: 'stale' }; }
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        if (this.running.get(sessionId) === controller) this.cancel(sessionId);
        diagnose('cancelled'); return { outcome: 'cancelled' };
      }
      token = claim.token;
      stage = 'request';
      const previousTitle = session.title;
      const text = await request({ systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, userPrompt: material.userPrompt,
        signal: controller.signal, token });
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        if (this.running.get(sessionId) === controller) this.cancel(sessionId);
        diagnose('cancelled'); return { outcome: 'cancelled' };
      }
      const result = parseSessionTitleResult(text);
      stage = 'save';
      const saved = await this.store.finishSessionTitleResult(sessionId, token,
        { title: result?.decision === 'set' ? result.title : undefined, outcome: result?.decision ?? 'invalid' });
      // Saving is asynchronous too. A newer intent may retire this request
      // after the store has settled but before this continuation is delivered.
      if (controller.signal.aborted || this.disposed || this.running.get(sessionId) !== controller
        || this.options.canCommit?.() === false) return { outcome: 'cancelled' };
      const outcome: SessionTitleRegenerationOutcome = saved === 'committed'
        ? result?.decision === 'set' && result.title === previousTitle ? 'unchanged' : 'updated'
        : saved === 'recorded' ? result?.decision === 'defer' ? 'no_material' : 'invalid' : saved;
      diagnose(outcome);
      if (saved === 'committed') {
        // A failed repaint cannot undo a durable title or turn success into a
        // model retry. A remounted view reads the committed session state.
        try { await this.options.onCommitted?.(sessionId, mode); } catch { diagnose('notification_failed'); }
      }
      return { outcome };
    } catch (error) {
      // The caller accounts for physical usage even when this result is stale.
      // Logs deliberately omit raw provider errors and conversation text.
      const reason = error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
        && ['timeout', 'unavailable', 'invalid', 'cancelled', 'save_failed'].includes(error.reason)
        ? error.reason as SessionTitleRegenerationOutcome : 'failed';
      const outcome = controller.signal.aborted ? 'cancelled' : stage === 'claim' || stage === 'save' ? 'save_failed' : reason;
      diagnose(outcome);
      if (token && !controller.signal.aborted) {
        try { await this.store.finishSessionTitle(sessionId, token, { outcome: 'failed' }); } catch { /* future turn only */ }
      }
      return { outcome };
    } finally {
      if (this.running.get(sessionId) === controller) this.running.delete(sessionId);
    }
  }
}
