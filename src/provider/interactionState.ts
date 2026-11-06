import { createHash, randomUUID } from 'node:crypto';

export type InteractionPhase = 'idle' | 'loading_session' | 'preparing_context' | 'preparing_task'
  | 'running' | 'saving' | 'action' | 'failed';
export type InteractionOperationKind = 'navigation' | 'task' | 'continuation' | 'recovery';

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
}

export interface InteractionDiagnostic {
  event: 'begin' | 'phase' | 'finish' | 'stale';
  kind: InteractionOperationKind;
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
      this.onDiagnostic({ event, kind: operation.token.kind,
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
  const ready = facts.sessionReady && facts.requestContextReady && facts.approvalDataReady;
  let phase: InteractionPhase = owned?.phase ?? 'idle';
  if (!owned) {
    if (facts.mainRunning) phase = 'running';
    else if (facts.actionRunning || facts.backgroundRunning) phase = 'action';
    else if (facts.starting) phase = 'preparing_task';
    else if (facts.failure) phase = 'failed';
    else if (!facts.sessionReady || operation) phase = 'loading_session';
    else if (facts.contextRefreshing || !facts.requestContextReady || !facts.approvalDataReady) phase = 'preparing_context';
  } else if (facts.mainRunning && phase === 'preparing_task') phase = 'running';
  const cancelOperationId = owned?.operationId ?? facts.cancelOperationId;
  const canCancel = Boolean(facts.cancellable && cancelOperationId
    && (phase === 'running' || phase === 'preparing_task' || phase === 'action'));
  const blockingReason = facts.failure ?? (phase === 'idle' ? undefined : phase);
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
    ...(blockingReason ? { blockingReason } : {})
  };
}
