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
  | 'busy' | 'cancelled' | 'stale' | 'invalid' | 'timeout' | 'failed' | 'save_failed'
  | 'output_truncated' | 'budget_missing' | 'budget_exhausted' | 'unpriced_cost'
  | 'source_identity_missing' | 'model_unavailable';
export interface SessionTitleRegenerationResult {
  outcome: SessionTitleRegenerationOutcome;
}

/** Background-only coordinator. The host supplies an accepted, durable user
 * input; this module never starts a main task or owns UI busy/clock state. */
export class SessionTitleCoordinator {
  private readonly running = new Map<string, { controller: AbortController; mode: 'automatic' | 'manual' }>();
  private disposed = false;

  public constructor(private readonly store: ChatSessionStore, private readonly options: {
    onCommitted?: (sessionId: string, mode: 'automatic' | 'manual') => void | Promise<void>;
    canCommit?: () => boolean;
    onDiagnostic?: (sessionId: string, taskId: string, outcome: string, elapsedMs: number,
      facts: { mode: 'automatic' | 'manual'; materialRounds: number; materialChars: number }) => void;
    onSettled?: (sessionId: string) => void;
  } = {}) {}

  public cancel(sessionId: string): void {
    this.running.get(sessionId)?.controller.abort();
    this.running.delete(sessionId);
    this.store.invalidateSessionTitle(sessionId);
  }

  public isRunning(sessionId: string): boolean { return this.running.has(sessionId); }

  public get runningCount(): number { return this.running.size; }

  public dispose(): void {
    this.disposed = true;
    this.cancelAll();
  }

  public cancelAll(): void {
    for (const sessionId of [...this.running.keys()]) this.cancel(sessionId);
  }

  public async complete(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>): Promise<boolean> {
    const result = await this.completeResult(sessionId, taskId, request);
    return result.outcome === 'updated' || result.outcome === 'unchanged';
  }

  /** Busy is not consumption: the Host retains that compact candidate and
   * drains it once this session's in-flight request has settled. */
  public completeResult(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>,
    options: { orderedObservedPrefix?: boolean } = {}): Promise<SessionTitleRegenerationResult> {
    return this.run(sessionId, taskId, request, 'automatic', undefined, options.orderedObservedPrefix === true);
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
    return this.run(sessionId, taskId, request, 'manual', material);
  }

  private async run(sessionId: string, taskId: string,
    request: (input: SessionTitleRequest) => Promise<string>, mode: 'automatic' | 'manual',
    suppliedMaterial?: { userPrompt: string; basis: SessionTitleBasis }, orderedObservedPrefix = false): Promise<SessionTitleRegenerationResult> {
    const startedAt = performance.now();
    let materialRounds = 0;
    let materialChars = 0;
    const diagnose = (outcome: string) => this.options.onDiagnostic?.(sessionId, taskId, outcome,
      Math.max(0, Math.round(performance.now() - startedAt)), { mode, materialRounds, materialChars });
    if (this.disposed) return { outcome: 'cancelled' };
    const previous = this.running.get(sessionId);
    if (previous) {
      if (mode === 'automatic' || previous.mode === 'manual') {
        diagnose('in_flight'); return { outcome: 'busy' };
      }
      // An explicit refresh retires an older automatic attempt. Its transport
      // may still settle usage, but its response/finally no longer owns this slot.
      this.cancel(sessionId);
    }
    if (this.options.canCommit?.() === false) return { outcome: 'unavailable' };
    const session = this.store.getSessionById(sessionId);
    if (!session) return { outcome: 'stale' };
    if (mode === 'automatic' && (session.customTitle || session.autoTitle?.stopped || session.autoTitle?.status === 'completed')) {
      diagnose(session.customTitle || session.autoTitle?.stopped === 'manual' ? 'manual_lock' : 'already_named');
      return { outcome: 'stale' };
    }
    const material = suppliedMaterial ?? buildSessionTitleMaterial(session.messages, taskId);
    if (!material) { diagnose('no_material'); return { outcome: 'no_material' }; }
    materialRounds = material.basis.messages.length;
    materialChars = material.userPrompt.length;
    if (!sessionTitleTaskBasisMatches(session.messages, taskId, material.basis)) {
      diagnose('invalid_basis'); return { outcome: 'stale' };
    }
    const controller = new AbortController();
    const owner = { controller, mode };
    this.running.set(sessionId, owner);
    let token: string | undefined;
    let stage: 'claim' | 'request' | 'save' = 'claim';
    try {
      const beforeClaim = session.autoTitle?.manualAttempt?.token ?? session.autoTitle?.attempt?.token;
      const claiming = this.store.claimSessionTitle(sessionId, taskId, material.basis, mode, orderedObservedPrefix);
      // The store reserves before its first persistence await. Capture only
      // that new token, including a claim made stale while its save is pending.
      const reservedToken = session.autoTitle?.manualAttempt?.token ?? session.autoTitle?.attempt?.token;
      if (reservedToken !== beforeClaim) token = reservedToken;
      const claim = await claiming;
      if (!claim) { diagnose('stale'); return { outcome: 'stale' }; }
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        if (this.running.get(sessionId) === owner) this.cancel(sessionId);
        diagnose('cancelled'); return { outcome: 'cancelled' };
      }
      token = claim.token;
      stage = 'request';
      const previousTitle = session.title;
      const text = await request({ systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, userPrompt: material.userPrompt,
        signal: controller.signal, token });
      if (controller.signal.aborted || this.disposed || this.options.canCommit?.() === false) {
        if (this.running.get(sessionId) === owner) this.cancel(sessionId);
        diagnose('cancelled'); return { outcome: 'cancelled' };
      }
      const result = parseSessionTitleResult(text);
      stage = 'save';
      const saved = await this.store.finishSessionTitleResult(sessionId, token,
        { title: result?.decision === 'set' ? result.title : undefined, outcome: result?.decision ?? 'invalid' });
      // Saving is asynchronous too. A newer intent may retire this request
      // after the store has settled but before this continuation is delivered.
      if (controller.signal.aborted || this.disposed || this.running.get(sessionId) !== owner
        || this.options.canCommit?.() === false) return { outcome: 'cancelled' };
      const outcome: SessionTitleRegenerationOutcome = saved === 'committed'
        ? result?.decision === 'set' && result.title === previousTitle ? 'unchanged' : 'updated'
        : saved === 'recorded' ? result?.decision === 'defer' ? 'no_material' : 'invalid' : saved;
      diagnose(saved === 'committed' ? 'committed' : outcome === 'invalid' ? 'invalid_output' : outcome);
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
        && ['timeout', 'unavailable', 'invalid', 'cancelled', 'save_failed', 'output_truncated', 'budget_missing',
          'budget_exhausted', 'unpriced_cost', 'source_identity_missing', 'model_unavailable'].includes(error.reason)
        ? error.reason as SessionTitleRegenerationOutcome : 'failed';
      const outcome = controller.signal.aborted ? 'cancelled' : stage === 'claim' || stage === 'save' ? 'save_failed' : reason;
      diagnose(outcome);
      if (token && !controller.signal.aborted) {
        try { await this.store.finishSessionTitle(sessionId, token, { outcome: 'failed' }); } catch { /* future turn only */ }
      }
      return { outcome };
    } finally {
      if (this.running.get(sessionId) === owner) {
        // If a selected message changed during claim/save, the store rejected
        // the result. Retire our exact token so a later real turn can claim.
        const state = this.store.getSessionById(sessionId)?.autoTitle;
        if (token && (state?.attempt?.token === token || state?.manualAttempt?.token === token)) this.store.invalidateSessionTitle(sessionId);
        this.running.delete(sessionId);
        try { this.options.onSettled?.(sessionId); } catch { /* diagnostics/drain cannot undo settlement */ }
      }
    }
  }
}
