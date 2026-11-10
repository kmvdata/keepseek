import { createHash, randomUUID } from 'node:crypto';

export type InteractionPhase = 'idle' | 'loading_session' | 'preparing_context' | 'preparing_task'
  | 'running' | 'saving' | 'action' | 'failed';
export type InteractionOperationKind = 'navigation' | 'task' | 'continuation' | 'recovery';

/** Local history work has no model, Skills or account dependency. Target gates
 * supply the execution authority; preview never owns the composer. */
export function deriveHistoryCleanupCapability(facts: { sessionReady: boolean; disposed?: boolean; operationPending?: boolean }):
  { available: boolean; reason?: 'loading_sessions' | 'busy' | 'unavailable' } {
  if (facts.disposed) return { available: false, reason: 'unavailable' };
  if (!facts.sessionReady) return { available: false, reason: 'loading_sessions' };
  if (facts.operationPending) return { available: false, reason: 'busy' };
  return { available: true };
}
export type InteractionWaitingReason = 'model' | 'session' | 'recovery' | 'context' | 'saving';

export type SessionTitleCapabilityReason = 'loading_sessions' | 'recovering' | 'model_unavailable'
  | 'untrusted' | 'busy' | 'saving' | 'unavailable';

export interface SessionTitleCapability {
  available: boolean;
  reason?: SessionTitleCapabilityReason;
}

/** Naming has its own dependencies; current project instructions are not one of them. */
export interface SessionTitleCapabilityFacts {
  sessionReady: boolean;
  approvalDataReady: boolean;
  modelReady: boolean;
  subagentModelReady?: boolean;
  trusted: boolean;
  disposed?: boolean;
  mainRunning?: boolean;
  actionRunning?: boolean;
  backgroundRunning?: boolean;
  foregroundKind?: InteractionOperationKind;
  foregroundPhase?: InteractionPhase;
  saving?: boolean;
}

/** Host advertises this capability and still rechecks target/model identity before work. */
export function deriveSessionTitleCapability(facts: SessionTitleCapabilityFacts): SessionTitleCapability {
  let reason: SessionTitleCapabilityReason | undefined;
  if (facts.disposed) reason = 'unavailable';
  else if (!facts.trusted) reason = 'untrusted';
  else if (!facts.sessionReady) reason = 'loading_sessions';
  else if (!facts.approvalDataReady) reason = 'recovering';
  else if (facts.saving || facts.foregroundPhase === 'saving') reason = 'saving';
  else if (facts.mainRunning || facts.actionRunning || facts.backgroundRunning
    || (facts.foregroundKind && facts.foregroundKind !== 'navigation'
      && !(facts.foregroundKind === 'recovery' && facts.foregroundPhase === 'preparing_context'))) reason = 'busy';
  else if (facts.foregroundPhase === 'loading_session') reason = 'recovering';
  else if (!facts.modelReady || facts.subagentModelReady === false) reason = 'model_unavailable';
  return reason ? { available: false, reason } : { available: true };
}

/** A process-local ownership token. It is never persisted or sent to a model. */
export interface InteractionOperation {
  readonly operationId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly kind: InteractionOperationKind;
  /** Initial phase only; the coordinator owns subsequent phase transitions. */
  readonly phase: InteractionPhase;
}

export interface InteractionFacts {
  sessionId: string;
  /** The same revision as the containing Host state/statePatch. */
  revision: number;
  sessionReady: boolean;
  requestContextReady: boolean;
  approvalDataReady: boolean;
  /** Optional detailed readiness; old callers retain the aggregate readiness contract. */
  modelReady?: boolean;
  contextReady?: boolean;
  sessionRecoveryReady?: boolean;
  /** Compatibility runtime facts, never a combined UI busy flag. */
  mainRunning?: boolean;
  starting?: boolean;
  contextRefreshing?: boolean;
  actionRunning?: boolean;
  /** Only the existing exclusive background task policy belongs here. */
  backgroundRunning?: boolean;
  cancellable?: boolean;
  /** Actual cancellation owner, for an action not using a foreground token. */
  cancelOperationId?: string;
  failure?: string;
}

export interface InteractionSnapshot {
  sessionId: string;
  revision: number;
  operationId?: string;
  phase: InteractionPhase;
  canEdit: boolean;
  canSubmit: boolean;
  /** Source, Skill and context changes use the same readiness boundary. */
  canChangeContext: boolean;
  canNavigate: boolean;
  canCancel: boolean;
  cancelOperationId?: string;
  blockingReason?: string;
  waitingReason?: InteractionWaitingReason;
}

export interface InteractionDiagnostic {
  event: 'begin' | 'phase' | 'finish' | 'stale';
  kind: InteractionOperationKind;
  operationId: string;
  generation: number;
  /** Non-reversible short identifier, never a path or user content. */
  session: string;
  phase: InteractionPhase;
  elapsedMs: number;
}

interface OwnedOperation {
  token: InteractionOperation;
  sessionId: string;
  phase: InteractionPhase;
  startedAt: number;
  settled: Promise<void>;
  resolveSettled: () => void;
}

/**
 * One foreground reservation, synchronously acquired before an asynchronous
 * barrier. Runtime/actions retain their own permission and side-effect checks.
 * Independent titles, balances and display-only work never acquire this owner.
 */
export class InteractionCoordinator {
  private generation = 0;
  private active?: OwnedOperation;
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly onDiagnostic?: (event: InteractionDiagnostic) => void;

  public constructor(options: {
    now?: () => number;
    id?: () => string;
    onDiagnostic?: (event: InteractionDiagnostic) => void;
  } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.id = options.id ?? randomUUID;
    this.onDiagnostic = options.onDiagnostic;
  }

  public get current(): InteractionOperation | undefined { return this.active?.token; }

  /** Wait for the owner observed now, never an unrelated later generation. */
  public whenSettled(): Promise<void> { return this.active?.settled ?? Promise.resolve(); }

  public begin(kind: InteractionOperationKind, sessionId: string, phase: InteractionPhase): InteractionOperation | undefined {
    if (this.active) return undefined;
    const token: InteractionOperation = Object.freeze({ operationId: this.id(), sessionId,
      generation: ++this.generation, kind, phase });
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    this.active = { token, sessionId, phase, startedAt: this.now(), settled, resolveSettled };
    this.diagnose('begin', this.active);
    return token;
  }

  public owns(token: InteractionOperation | undefined): boolean {
    return token !== undefined && this.active?.token === token;
  }

  /** Only the current owner can advance a phase or commit a navigation target. */
  public update(token: InteractionOperation, phase: InteractionPhase, sessionId?: string): boolean {
    if (!this.owns(token)) { this.stale(token); return false; }
    const active = this.active!;
    if (active.phase === phase && (sessionId === undefined || sessionId === active.sessionId)) return true;
    active.phase = phase;
    if (sessionId !== undefined) active.sessionId = sessionId;
    this.diagnose('phase', active);
    return true;
  }

  public finish(token: InteractionOperation): boolean {
    if (!this.owns(token)) { this.stale(token); return false; }
    const active = this.active!;
    this.active = undefined;
    active.resolveSettled();
    this.diagnose('finish', active);
    return true;
  }

  public snapshot(facts: InteractionFacts): InteractionSnapshot {
    return deriveInteractionState(facts, this.active ? {
      operationId: this.active.token.operationId,
      sessionId: this.active.sessionId,
      phase: this.active.phase
    } : undefined);
  }

  private stale(token: InteractionOperation): void {
    this.diagnose('stale', { token, sessionId: token.sessionId, phase: token.phase, startedAt: this.now() });
  }

  private diagnose(event: InteractionDiagnostic['event'], operation: Pick<OwnedOperation, 'token' | 'sessionId' | 'phase' | 'startedAt'>): void {
    if (!this.onDiagnostic) return;
    // Diagnostics must not be able to interrupt ownership release or execution.
    try {
      this.onDiagnostic({ event, kind: operation.token.kind, operationId: operation.token.operationId,
        generation: operation.token.generation,
        session: createHash('sha256').update(operation.sessionId).digest('hex').slice(0, 12),
        phase: operation.phase, elapsedMs: Math.max(0, this.now() - operation.startedAt) });
    } catch { /* observability is not a durability or execution boundary */ }
  }
}

/** The only UI capability derivation; it does not grant execution authority. */
export function deriveInteractionState(facts: InteractionFacts, operation?: {
  operationId: string;
  sessionId: string;
  phase: InteractionPhase;
}): InteractionSnapshot {
  const owned = operation?.sessionId === facts.sessionId ? operation : undefined;
  const pending = Boolean(operation || facts.mainRunning || facts.starting || facts.contextRefreshing
    || facts.actionRunning || facts.backgroundRunning);
  const ready = facts.sessionReady && facts.requestContextReady && facts.approvalDataReady
    && facts.modelReady !== false && facts.contextReady !== false && facts.sessionRecoveryReady !== false;
  let phase: InteractionPhase = owned?.phase ?? 'idle';
  if (!owned) {
    if (facts.mainRunning) phase = 'running';
    else if (facts.actionRunning || facts.backgroundRunning) phase = 'action';
    else if (facts.starting) phase = 'preparing_task';
    else if (facts.failure) phase = 'failed';
    else if (!facts.sessionReady || operation) phase = 'loading_session';
    else if (facts.contextRefreshing || !ready) phase = 'preparing_context';
  } else if (facts.mainRunning && phase === 'preparing_task') phase = 'running';
  const cancelOperationId = owned?.operationId ?? facts.cancelOperationId;
  const canCancel = Boolean(facts.cancellable && cancelOperationId
    && (phase === 'running' || phase === 'preparing_task' || phase === 'action'));
  const blockingReason = facts.failure ?? (phase === 'idle' ? undefined : phase);
  let waitingReason: InteractionWaitingReason | undefined;
  if (phase === 'saving') waitingReason = 'saving';
  else if (phase === 'loading_session') waitingReason = 'session';
  else if (phase === 'preparing_context') {
    if (!facts.approvalDataReady || facts.sessionRecoveryReady === false) waitingReason = 'recovery';
    else if (facts.modelReady === false) waitingReason = 'model';
    else waitingReason = 'context';
  }
  return {
    sessionId: facts.sessionId,
    revision: facts.revision,
    ...(owned ? { operationId: owned.operationId } : {}),
    phase,
    // Editing a draft never executes it and remains available during preparation.
    canEdit: true,
    canSubmit: ready && !pending && !facts.failure,
    canChangeContext: ready && !pending && !facts.failure,
    canNavigate: facts.sessionReady && !pending,
    canCancel,
    ...(canCancel ? { cancelOperationId } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(blockingReason ? { blockingReason } : {})
  };
}
