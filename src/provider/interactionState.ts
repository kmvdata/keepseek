import { createHash, randomUUID } from 'node:crypto';

export type InteractionPhase = 'idle' | 'loading_session' | 'preparing_context' | 'preparing_task'
  | 'running' | 'saving' | 'action' | 'failed';
export type InteractionOperationKind = 'navigation' | 'task' | 'continuation' | 'recovery' | 'handoff';

/** Local history work has no model, Skills or account dependency. Target gates
 * supply the execution authority; preview never owns the composer. */
export function deriveHistoryCleanupCapability(facts: { sessionReady: boolean; disposed?: boolean; operationPending?: boolean }):
  { available: boolean; reason?: 'loading_sessions' | 'busy' | 'unavailable' } {
  if (facts.disposed) return { available: false, reason: 'unavailable' };
  if (!facts.sessionReady) return { available: false, reason: 'loading_sessions' };
  if (facts.operationPending) return { available: false, reason: 'busy' };
  return { available: true };
}
export function planHandoffBlockedReason(facts: {
  ready: boolean; trusted: boolean; scoped: boolean; busy: boolean;
  queued: boolean; modelReady: boolean;
}, language: 'zh-CN' | 'en'): string | undefined {
  const en = language === 'en';
  if (!facts.ready) return en ? 'Wait for history and project context to finish loading.' : '请等待历史记录和项目上下文就绪。';
  if (!facts.trusted) return en ? 'Trust the workspace to execute the plan.' : '请先信任工作区，再执行计划。';
  if (!facts.scoped) return en ? 'Select the project directory again.' : '请重新选择项目目录。';
  if (!facts.modelReady) return en ? 'Select an available model and source.' : '请选择可用的模型和来源。';
  if (facts.busy) return en ? 'Wait for the current operation to finish, then retry.' : '请等待当前操作结束后重试。';
  if (!facts.queued) return en ? 'Reload this project’s session queue and retry.' : '请重新加载本项目的会话队列后重试。';
  return undefined;
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
  /** The project view already opened its brand-new conversation for the
   * composer; session bodies and recovery stores may still be loading. */
  composerReady?: boolean;
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
  /** A host confirmation is open: the composer is busy because it waits for the user. */
  awaitingManualApproval?: boolean;
  /** Action kinds that mutate the viewed session (not a running command). */
  navigationBlockingAction?: boolean;
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
  /** Present only while the host waits for an explicit decision from the user. */
  awaitingManualApproval?: boolean;
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

/** Emitted after the slot is really free, so deferred host work can start. */
export interface InteractionReleaseEvent {
  kind: InteractionOperationKind;
  operationId: string;
  sessionId: string;
  phase: InteractionPhase;
  /** True when no task owner remains for that session after this release. */
  taskSlotFree: boolean;
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
  /** One task owner per session; parallel sessions each keep their own. */
  private readonly actives = new Map<string, OwnedOperation>();
  /** One navigation per session, coexisting with that session's task owner. */
  private readonly navigations = new Map<string, OwnedOperation>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly onDiagnostic?: (event: InteractionDiagnostic) => void;
  private readonly onRelease?: (event: InteractionReleaseEvent) => void;

  public constructor(options: {
    now?: () => number;
    id?: () => string;
    onDiagnostic?: (event: InteractionDiagnostic) => void;
    /** Synchronous notification that a task/navigation slot became free. The
     * callback must only schedule work: release must never await or throw. */
    onRelease?: (event: InteractionReleaseEvent) => void;
  } = {}) {
    this.now = options.now ?? (() => performance.now());
    this.id = options.id ?? randomUUID;
    this.onDiagnostic = options.onDiagnostic;
    this.onRelease = options.onRelease;
  }

  /** Task owners currently held, by session. */
  public get current(): InteractionOperation | undefined {
    const first = this.actives.values().next();
    return first.done ? undefined : first.value.token;
  }

  /** Task owner token for one session. */
  public currentFor(sessionId: string): InteractionOperation | undefined {
    return this.actives.get(sessionId)?.token;
  }

  /** Wait for the owner observed now, never an unrelated later generation. */
  public whenSettled(sessionId?: string): Promise<void> {
    const pick = sessionId
      ? this.actives.get(sessionId) ?? this.navigations.get(sessionId)
      : this.actives.values().next().value ?? this.navigations.values().next().value;
    return pick?.settled ?? Promise.resolve();
  }

  public begin(kind: InteractionOperationKind, sessionId: string, phase: InteractionPhase): InteractionOperation | undefined {
    // Ownership is per session: a task running in session A must not prevent session B
    // from reserving its own operation. Within one session the slot stays exclusive,
    // and only a navigation may coexist with that session already running a task.
    if (kind === 'handoff' && this.navigations.size) return undefined;
    if (kind === 'navigation' && this.actives.get(sessionId)?.token.kind === 'handoff') return undefined;
    if (this.actives.has(sessionId)
      && !(kind === 'navigation' && this.actives.get(sessionId)!.token.kind !== 'navigation')) return undefined;
    const token: InteractionOperation = Object.freeze({ operationId: this.id(), sessionId,
      generation: ++this.generation, kind, phase });
    let resolveSettled!: () => void;
    const settled = new Promise<void>(resolve => { resolveSettled = resolve; });
    const next: OwnedOperation = { token, sessionId, phase, startedAt: this.now(), settled, resolveSettled };
    // Navigation always occupies its own slot, so it can coexist with a task owner
    // in the same session while still projecting onto the session it re-targets.
    if (kind === 'navigation') {
      this.navigations.set(sessionId, next);
      this.diagnose('begin', next);
      return token;
    }
    this.actives.set(sessionId, next);
    this.diagnose('begin', next);
    return token;
  }

  /** Move the reservation with the first message without exposing an idle slot
   * or scheduling deferred effects for the source. The new token also binds
   * sendPrompt's usual identity check to the destination. */
  public transferHandoff(token: InteractionOperation, targetId: string): InteractionOperation | undefined {
    const owner = this.actives.get(token.sessionId);
    if (token.kind !== 'handoff' || owner?.token !== token || this.actives.has(targetId)) return undefined;
    const target = Object.freeze({ ...token, sessionId: targetId });
    this.actives.delete(token.sessionId);
    owner.token = target;
    owner.sessionId = targetId;
    this.actives.set(targetId, owner);
    return target;
  }

  /** The operation this token refers to, whether it owns the task slot or navigation. */
  private owned(token: InteractionOperation | undefined): OwnedOperation | undefined {
    if (!token) return undefined;
    // Scan by identity: navigation re-targets its session id while the slot key
    // stays at the session that reserved it.
    for (const map of [this.actives, this.navigations]) {
      for (const owner of map.values()) {
        if (owner.token === token) return owner;
      }
    }
    return undefined;
  }

  public owns(token: InteractionOperation | undefined): boolean {
    return this.owned(token) !== undefined;
  }

  /** Only the current owner can advance a phase or commit a navigation target. */
  public update(token: InteractionOperation, phase: InteractionPhase, sessionId?: string): boolean {
    const active = this.owned(token);
    if (!active) { this.stale(token); return false; }
    if (active.phase === phase && (sessionId === undefined || sessionId === active.sessionId)) return true;
    active.phase = phase;
    if (sessionId !== undefined) active.sessionId = sessionId;
    this.diagnose('phase', active);
    return true;
  }

  public finish(token: InteractionOperation): boolean {
    const active = this.owned(token);
    if (!active) { this.stale(token); return false; }
    // Match by token, not by the (possibly re-targeted) session id: navigation
    // updates the target while the slot key remains where it was reserved.
    for (const map of [this.actives, this.navigations]) {
      for (const [key, owner] of map) {
        if (owner === active) { map.delete(key); break; }
      }
    }
    active.resolveSettled();
    this.diagnose('finish', active);
    // Owner-agnostic release boundary. Approve-all defers file applies until the
    // interaction slot is free; observing that here covers every inherited
    // operation (plan execution, batch continuation) instead of relying on the
    // run-finalization ordering of one call path.
    this.notifyRelease(active);
    return true;
  }

  private notifyRelease(active: OwnedOperation): void {
    if (!this.onRelease) return;
    // Observability must never be able to interrupt ownership release: a throwing
    // callback would leave the caller's finally block without its own cleanup.
    try {
      this.onRelease({ kind: active.token.kind, operationId: active.token.operationId,
        sessionId: active.sessionId, phase: active.phase,
        taskSlotFree: !this.actives.has(active.sessionId) });
    } catch { /* the release itself already happened */ }
  }

  public snapshot(facts: InteractionFacts): InteractionSnapshot {
    // Prefer the viewed session's own slots; fall back to any single in-flight
        // operation so a navigation started for another target still projects.
    // Only this session's own operations project onto this session. A navigation
    // re-targeted to another session is found via the single-slot fallback used
    // when NO session owns a task, so parallel sessions never shadow each other.
    // A task owner projects only onto its own session: parallel sessions must not
    // inherit each other's running state. A navigation projects onto any session,
    // because it legitimately re-targets the session it is loading.
    // Navigation defines the visible phase while it is loading a session. A task
    // owner projects only onto its own session so parallel sessions never inherit
    // each other's running state.
    const shown = this.navigations.get(facts.sessionId)
      ?? (this.navigations.size === 1 ? this.navigations.values().next().value : undefined)
      ?? this.actives.get(facts.sessionId);
    return deriveInteractionState(facts, shown ? {
      kind: shown.token.kind,
      operationId: shown.token.operationId,
      sessionId: shown.sessionId,
      phase: shown.phase
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
  kind?: InteractionOperationKind;
  operationId: string;
  sessionId: string;
  phase: InteractionPhase;
}): InteractionSnapshot {
  const owned = operation?.sessionId === facts.sessionId ? operation : undefined;
  const pending = Boolean(operation || facts.mainRunning || facts.starting || facts.contextRefreshing
    || facts.actionRunning || facts.backgroundRunning);
  // A plain command/DraftRun keeps running in its own session and must not freeze
  // navigation; only actions that mutate the viewed session block it.
  // in-flight task reservation are deliberately excluded.
  // Blocks that also stop navigation. A main model run, a running command and an
  const navBlocking = Boolean(facts.backgroundRunning || facts.navigationBlockingAction
    || (operation?.kind === 'navigation' || operation?.kind === 'handoff') || (!facts.sessionReady && operation));
  // A project always opens a blank session with lazily deferred context, so the
  // composer may accept input before the session bodies load. Recovery stores are
  // still a hard gate: such an action is withheld until they are verified.
  const sessionReady = facts.sessionReady || facts.composerReady === true;
  const ready = sessionReady && facts.requestContextReady && facts.approvalDataReady
    && facts.modelReady !== false && facts.contextReady !== false && facts.sessionRecoveryReady !== false;
  let phase: InteractionPhase = owned?.phase ?? 'idle';
  if (!owned) {
    if (facts.mainRunning) phase = 'running';
    else if (facts.actionRunning || facts.backgroundRunning) phase = 'action';
    else if (facts.starting) phase = 'preparing_task';
    else if (facts.failure) phase = 'failed';
    else if (!sessionReady || operation) phase = 'loading_session';
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
    // Navigation must stay available while a task is running: the user needs to open
    // another session and come back. The run itself is pinned to the session captured
    // at admission, so switching sessions cannot redirect its results or cancel it.
    // Background work and a still-loading session remain hard barriers.
    canNavigate: sessionReady && !navBlocking,
    canCancel,
    ...(canCancel ? { cancelOperationId } : {}),
    ...(waitingReason ? { waitingReason } : {}),
    ...(facts.awaitingManualApproval ? { awaitingManualApproval: true } : {}),
    ...(blockingReason ? { blockingReason } : {})
  };
}
