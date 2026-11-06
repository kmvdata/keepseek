import type { ChatSessionStore } from './chatSessionStore';
import { buildSessionTitleMaterial, parseSessionTitleResult, SESSION_TITLE_SYSTEM_PROMPT } from './sessionTitle';

export interface SessionTitleRequest {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  token: string;
}

/** Background-only coordinator. The host supplies a confirmed final logical
 * turn; this module never starts a main task or owns UI busy/clock state. */
export class SessionTitleCoordinator {
  private readonly running = new Map<string, AbortController>();
  private disposed = false;

  public constructor(private readonly store: ChatSessionStore, private readonly options: {
    onCommitted?: (sessionId: string) => void | Promise<void>;
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

  public async complete(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>): Promise<boolean> {
    if (this.disposed || this.running.has(sessionId) || this.options.canCommit?.() === false) return false;
    const session = this.store.getSessionById(sessionId);
    if (!session || session.customTitle || session.autoTitle?.status === 'completed') return false;
    // Late/duplicate completion events cannot name an earlier logical turn.
    const tail = [...session.messages].reverse().find(message => message.userTask);
    if (tail?.role !== 'assistant' || tail.userTask?.id !== taskId || tail.isStreaming) return false;
    const material = buildSessionTitleMaterial(session.messages, taskId);
    if (!material) return false;
    const controller = new AbortController();
    this.running.set(sessionId, controller);
    const startedAt = performance.now();
    const diagnose = (outcome: string) => this.options.onDiagnostic?.(sessionId, taskId, outcome,
      Math.max(0, Math.round(performance.now() - startedAt)));
    let token: string | undefined;
    try {
      const claim = await this.store.claimSessionTitle(sessionId, taskId, material.basis);
      if (!claim) return false;
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        this.cancel(sessionId); diagnose('stale'); return false;
      }
      token = claim.token;
      const text = await request({ systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, userPrompt: material.userPrompt,
        signal: controller.signal, token });
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        this.cancel(sessionId); diagnose('stale'); return false;
      }
      const result = parseSessionTitleResult(text);
      const outcome = result?.decision ?? 'invalid';
      const committed = await this.store.finishSessionTitle(sessionId, token,
        { title: result?.decision === 'set' ? result.title : undefined, outcome });
      const state = this.store.getSessionById(sessionId)?.autoTitle;
      diagnose(committed ? 'set' : result?.decision === 'set'
        ? state?.lastOutcome === 'save_failed' ? 'save_failed' : 'stale'
        : state?.lastOutcome === outcome ? outcome : 'stale');
      if (committed) await this.options.onCommitted?.(sessionId);
      return committed;
    } catch (error) {
      // The caller accounts for physical usage even when this result is stale.
      // Logs deliberately omit raw provider errors and conversation text.
      const reason = error && typeof error === 'object' && 'reason' in error && typeof error.reason === 'string'
        && ['timeout', 'unavailable', 'invalid', 'cancelled'].includes(error.reason) ? error.reason : 'failed';
      diagnose(controller.signal.aborted ? 'cancelled' : reason);
      if (token && !controller.signal.aborted) {
        try { await this.store.finishSessionTitle(sessionId, token, { outcome: 'failed' }); } catch { /* future turn only */ }
      }
      return false;
    } finally {
      if (this.running.get(sessionId) === controller) this.running.delete(sessionId);
    }
  }
}
