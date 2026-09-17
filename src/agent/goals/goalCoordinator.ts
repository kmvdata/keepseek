import { createHash, randomUUID } from 'node:crypto';
import type { AgentResponse } from '../../shared/types';
import type { UsageEvent } from '../../shared/types';
import type { RunCheckpoint } from '../runCheckpoint';
import { AgentInterruptedError, checkpointCopy } from '../runCheckpoint';
import { ExecutionClock } from '../executionPolicy';
import { amendGoalContract, serializeGoalProviderContract } from './goalContract';
import type {
  GoalCompletionReviewerRequestContext,
  GoalCompletionSafetySnapshot,
  GoalCompletionReviewResult
} from './goalCompletionReview';
import { GoalCompletionReviewService } from './goalCompletionReview';
import type { GoalLease } from './goalLease';
import { appendGoalContinuation, appendGoalHostControl, createGoalCheckpointReplayCursor, createGoalControlItem, createTerminalGoalReplay, toGoalReplayCursor } from './goalReplay';
import { stableStringify } from '../evidence/shaping';
import { transitionGoal } from './goalStateMachine';
import { classifyGoalRecovery, type GoalRecoveryContext } from './goalRecovery';
import { GoalStoreConcurrencyError, type GoalStore } from './goalStore';
import {
  isGoalTerminalStatus,
  type GoalContract,
  type GoalProposalDecisionV1,
  type GoalRecordV1,
  type GoalRuntimeInterruptionV1,
  type GoalStatus,
  type GoalValidationRecordV1
} from './goalTypes';

export interface GoalAttemptResult {
  response: AgentResponse;
  checkpoint: RunCheckpoint;
}

export interface GoalCoordinatorHooks {
  dispatchAttempt(record: GoalRecordV1, checkpoint: RunCheckpoint | undefined): Promise<GoalAttemptResult | undefined>;
  completionSafety(record: GoalRecordV1): Promise<GoalCompletionSafetySnapshot>;
  completionReviewerContext(record: GoalRecordV1): Promise<GoalCompletionReviewerRequestContext>;
  onStateChanged?(record: GoalRecordV1 | undefined): void;
  onCompleted?(record: GoalRecordV1): Promise<void> | void;
  onCancelRuntime?(): void;
  onReleaseTask?(taskId: string): void;
  onLeaseWait?(retryAfterMs: number): void;
  onTraceEvent?(kind: 'completion_review', record: GoalRecordV1, event: Record<string, unknown>): Promise<void> | void;
}

/** Durable event-driven Goal state machine. Every dispatch, review, and control
 * continuation is preceded by a snapshot/journal commit and lease fence check. */
export class GoalCoordinator {
  private record?: GoalRecordV1;
  private dispatching = false;
  private continuePending = false;
  private disposed = false;
  /** Invalidates lease acquisition/start continuations after Stop, interrupt,
   * amendment, or disposal. This prevents a stale preparing snapshot from
   * reviving a Goal after the user has cancelled it. */
  private lifecycleGeneration = 0;
  private hostClock?: ExecutionClock;
  private hostActiveScopes = 0;
  private cancelLeaseWait?: () => void;
  private resumeInFlight?: Promise<void>;
  /** Timer and tool-boundary checkpoints can arrive concurrently. Preserve
   * their invocation order so they never race the GoalStore CAS revision. */
  private checkpointWriteQueue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly store: GoalStore,
    private readonly lease: GoalLease,
    private readonly completionReview: GoalCompletionReviewService,
    private readonly hooks: GoalCoordinatorHooks
  ) {}

  public async initialize(): Promise<GoalRecordV1 | undefined> {
    await this.store.initialize();
    this.record = await this.store.loadWorkspace(this.lease.workspaceKey);
    if (this.record && (this.record.status === 'running' || this.record.status === 'pausing')) {
      const previousStatus = this.record.status;
      this.record = transitionGoal(this.record, 'interrupted', { reason: 'KeepSeek Extension Host restarted.' });
      this.record.lastInterruption = {
        runtimeId: randomUUID(), previousStatus, reason: 'extension_restart',
        uncertainSideEffect: false, recordedAt: this.record.updatedAt
      };
      this.record.lease = undefined;
      this.record = await this.store.append(this.record, 'activation_interrupted', { previousStatus });
    }
    this.emit();
    return this.current;
  }

  public async recoverAfterActivation(context: GoalRecoveryContext): Promise<GoalRecordV1 | undefined> {
    const current = this.requireRecord();
    const recovery = classifyGoalRecovery(current, context);
    this.record = await this.store.append(recovery.record, 'activation_recovery_classified', {
      status: recovery.record.status, autoResume: recovery.autoResume, reason: recovery.reason
    });
    this.emit();
    if (recovery.autoResume) {
      if (recovery.record.status === 'preparing') await this.start();
      else await this.resume();
    }
    return this.current;
  }

  public async create(
    contract: GoalContract,
    sessionId: string,
    initialPrompt: GoalRecordV1['initialPrompt'],
    requiredExternalAuthorizationUris: string[] = [],
    proposalDecision?: GoalProposalDecisionV1
  ): Promise<GoalRecordV1> {
    this.ensureUsable();
    this.record = await this.store.create({
      workspaceKey: this.lease.workspaceKey, sessionId, contract, initialPrompt, requiredExternalAuthorizationUris,
      proposalDecision
    });
    this.record = await this.store.append(this.record, 'goal_created', {
      contractHash: contract.canonicalHash, revision: 1, resumePolicy: contract.resumePolicy
    });
    this.emit();
    return this.current!;
  }

  public async start(): Promise<void> {
    const record = this.requireRecord();
    if (record.status !== 'preparing' && record.status !== 'paused' && record.status !== 'interrupted') {
      if (record.status === 'running') return;
      throw new Error(`Goal cannot start from ${record.status}.`);
    }
    const generation = this.lifecycleGeneration;
    const acquired = await this.lease.acquire({
      allowStaleTakeover: record.status === 'interrupted',
      confirmState: async () => (await this.store.load(record.id))?.currentContractHash === record.currentContractHash
    });
    const current = this.record;
    if (generation !== this.lifecycleGeneration || !current
      || current.id !== record.id || current.currentContractHash !== record.currentContractHash
      || current.currentRevision !== record.currentRevision || isGoalTerminalStatus(current.status)) {
      if (acquired.acquired) await this.lease.release();
      return;
    }
    if (!acquired.acquired || !acquired.lease) {
      await this.moveToAttention(`Goal lease unavailable: ${acquired.reason ?? 'unknown'}`);
      return;
    }
    this.record = structuredClone(current);
    this.record.lease = { ownerId: acquired.lease.ownerId, fencingToken: acquired.lease.fencingToken };
    this.record = transitionGoal(this.record, 'running');
    this.record = await this.store.append(this.record, 'goal_started', {
      contractHash: this.record.currentContractHash, revision: this.record.currentRevision,
      fencingToken: acquired.lease.fencingToken
    });
    this.lease.startHeartbeat(() => { void this.moveToAttention('Goal lease was lost.'); });
    this.emit();
    await this.dispatch('initial');
  }

  public async pause(): Promise<void> {
    const record = this.requireRecord();
    if (record.status === 'paused' || record.status === 'pausing') return;
    if (record.status !== 'running') throw new Error(`Goal cannot pause from ${record.status}.`);
    await this.assertLease();
    this.record = transitionGoal(record, 'pausing', { reason: 'Pause requested; waiting for a safe boundary.' });
    this.record = await this.store.append(this.record, 'pause_requested', {});
    this.hooks.onCancelRuntime?.();
    if (!this.dispatching) await this.finishPause();
    this.emit();
  }

  public async resume(): Promise<void> {
    if (this.resumeInFlight) return await this.resumeInFlight;
    const operation = this.resumeOnce();
    this.resumeInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.resumeInFlight === operation) this.resumeInFlight = undefined;
    }
  }

  private async resumeOnce(): Promise<void> {
    const record = this.requireRecord();
    if (record.status === 'running') return;
    if (!['paused', 'interrupted', 'waiting_for_user', 'needs_attention', 'waiting_for_apply', 'waiting_for_authorization', 'waiting_for_command'].includes(record.status)) {
      throw new Error(`Goal cannot resume from ${record.status}.`);
    }
    const generation = this.lifecycleGeneration;
    let valid = await this.lease.confirm();
    let acquireFailure: Awaited<ReturnType<GoalLease['acquire']>> | undefined;
    if (!valid) {
      acquireFailure = await this.lease.acquire({ allowStaleTakeover: true,
        confirmState: async () => (await this.store.load(record.id))?.currentContractHash === record.currentContractHash });
      valid = acquireFailure.acquired;
      if (!valid && (acquireFailure.reason === 'held' || acquireFailure.reason === 'lock_busy')
        && acquireFailure.retryAfterMs && acquireFailure.retryAfterMs <= 30_000) {
        this.hooks.onLeaseWait?.(acquireFailure.retryAfterMs);
        if (!(await this.waitForLeaseExpiry(acquireFailure.retryAfterMs, generation))) return;
        acquireFailure = await this.lease.acquire({
          allowStaleTakeover: true,
          confirmState: async () => (await this.store.load(record.id))?.currentContractHash === record.currentContractHash
        });
        valid = acquireFailure.acquired;
      }
    }
    const current = this.record;
    if (generation !== this.lifecycleGeneration || !current
      || current.id !== record.id || current.currentContractHash !== record.currentContractHash
      || current.currentRevision !== record.currentRevision || isGoalTerminalStatus(current.status)) {
      if (valid) await this.lease.release();
      return;
    }
    // Never rewrite durable Goal state without owning its lease. A live second
    // window may still be advancing this same record; the local UI can report
    // the conflict while leaving the persisted recovery point untouched.
    if (!valid) throw new Error(goalLeaseFailureMessage(acquireFailure?.reason));
    this.record = transitionGoal(current, 'running');
    this.record.lease = this.lease.binding;
    this.record = await this.store.append(this.record, 'goal_resumed', { revision: this.record.currentRevision });
    this.lease.startHeartbeat(() => { void this.moveToAttention('Goal lease was lost.'); });
    this.emit();
    await this.dispatch('resume');
  }

  public async stop(reason = 'Stopped by the user.'): Promise<void> {
    let record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    this.lifecycleGeneration += 1;
    this.cancelPendingLeaseWait();
    this.hooks.onCancelRuntime?.();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = transitionGoal(record, 'stopped', { reason });
      next.lease = undefined;
      try {
        this.record = await this.store.append(next, 'goal_stopped', { reason: reason.slice(0, 1_000) });
        break;
      } catch (error) {
        if (!(error instanceof GoalStoreConcurrencyError) || attempt === 3) throw error;
        const latest = await this.store.load(record.id);
        if (!latest) throw new Error('Goal disappeared while stopping.');
        this.record = record = latest;
        if (isGoalTerminalStatus(record.status)) return;
      }
    }
    this.emit();
    await this.lease.release();
    const stopped = this.requireRecord();
    if (stopped.logicalTaskId) this.hooks.onReleaseTask?.(stopped.logicalTaskId);
  }

  public async clear(): Promise<void> {
    const record = this.requireRecord();
    if (!isGoalTerminalStatus(record.status)) throw new Error('Active or uncertain Goals cannot be cleared.');
    await this.store.clear(record.id);
    this.record = undefined;
    this.emit();
  }

  public async amend(instruction: string): Promise<void> {
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) throw new Error('A terminal Goal cannot be amended.');
    this.lifecycleGeneration += 1;
    this.cancelPendingLeaseWait();
    if (record.lease) await this.assertLease();
    const contract = currentContract(record);
    const amended = amendGoalContract(contract, instruction);
    const next = structuredClone(record);
    next.currentRevision += 1;
    next.currentContractHash = amended.canonicalHash;
    next.revisions.push({ revision: next.currentRevision, contract: amended, amendment: instruction.trim(), createdAt: new Date().toISOString() });
    next.completionDecision = undefined;
    next.validations = [];
    next.criteria = amended.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, status: 'pending', evidenceRefs: [] }));
    if (amended.version === 2) next.workItems = amended.workItems.map((item) => ({
      version: 1, workItemId: item.id, status: 'pending', acceptanceCriterionIds: [...item.acceptanceCriterionIds]
    }));
    if (next.runCheckpoint?.goal) {
      next.runCheckpoint.goal.contractHash = amended.canonicalHash;
      next.runCheckpoint.goal.revision = next.currentRevision;
      next.runCheckpoint.goal.criteria = [];
      next.runCheckpoint.goal.validationMutationRevision = next.workspaceMutationRevision;
      next.runCheckpoint.goal.completionDecisionRef = undefined;
    }
    if (next.runCheckpoint?.state) {
      const amendmentControl = stableStringify({
        kind: 'keepseek_goal_amendment',
        version: 1,
        contractHash: amended.canonicalHash,
        revision: next.currentRevision,
        contract: JSON.parse(serializeGoalProviderContract(amended))
      });
      next.runCheckpoint = appendGoalHostControl(next.runCheckpoint, amendmentControl);
    }
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'goal_amended', { revision: next.currentRevision, contractHash: amended.canonicalHash });
    this.emit();
    if (this.record.status === 'running') {
      if (this.dispatching) {
        this.continuePending = true;
        this.hooks.onCancelRuntime?.();
      } else {
        await this.dispatch('continue');
      }
    }
  }

  public async recordWorkspaceMutation(reason: string): Promise<void> {
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    await this.assertLease();
    const next = structuredClone(record);
    next.workspaceMutationRevision += 1;
    next.validations = [];
    next.completionDecision = undefined;
    next.criteria = next.criteria.map((criterion) => ({ ...criterion, status: 'pending', evidenceManifestHash: undefined,
      detail: `Invalidated by workspace mutation: ${reason.slice(0, 300)}` }));
    syncGoalWorkItemProgress(next);
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'workspace_mutated', {
      mutationRevision: next.workspaceMutationRevision, reason: reason.slice(0, 500)
    });
    this.emit();
  }

  public async recordValidation(validation: GoalValidationRecordV1): Promise<void> {
    const record = this.requireRecord();
    await this.assertLease();
    const next = structuredClone(record);
    next.validations.push(structuredClone(validation));
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'validation_recorded', {
      script: validation.script, status: validation.status, mutationRevision: validation.mutationRevision,
      contentHash: validation.contentHash
    });
    this.emit();
  }

  public async recordCriterionEvidence(criterionId: string, evidenceRef: string, evidenceManifestHash: string): Promise<void> {
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) throw new Error('A terminal Goal cannot accept new evidence.');
    await this.assertLease();
    const next = structuredClone(record);
    const criterion = next.criteria.find((item) => item.criterionId === criterionId);
    if (!criterion) throw new Error('Unknown Goal criterion.');
    if (!criterion.evidenceRefs.includes(evidenceRef)) criterion.evidenceRefs.push(evidenceRef);
    criterion.evidenceManifestHash = evidenceManifestHash;
    criterion.status = 'satisfied';
    syncGoalWorkItemProgress(next);
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'criterion_evidence_recorded', { criterionId, evidenceManifestHash });
    this.emit();
  }

  /** Manual criteria can only be closed by an explicit Webview action. The
   * confirmation is durable before the existing candidate is reviewed again. */
  public async confirmManualCriterion(criterionId: string): Promise<void> {
    const record = this.requireRecord();
    const criterion = currentContract(record).acceptanceCriteria.find((item) => item.id === criterionId);
    if (!criterion || criterion.type !== 'manual') throw new Error('Only a manual Goal criterion can be confirmed.');
    const evidenceRef = `manual:${record.currentRevision}:${record.workspaceMutationRevision}:${criterionId}`;
    const evidenceHash = sha256(JSON.stringify({
      contractHash: record.currentContractHash,
      revision: record.currentRevision,
      workspaceMutationRevision: record.workspaceMutationRevision,
      criterionId,
      evidenceRef
    }));
    await this.recordCriterionEvidence(criterionId, evidenceRef, evidenceHash);
    if (!this.record?.candidateFinal) return;
    if (this.record.status !== 'running') {
      this.record = transitionGoal(this.record, 'running');
      this.record = await this.store.append(this.record, 'manual_criterion_recheck', { criterionId });
      this.emit();
    }
    await this.reviewCandidate();
  }

  public async recordApprovalReferences(reviewIds: readonly string[]): Promise<void> {
    const additions = reviewIds.filter(Boolean);
    if (!additions.length) return;
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    await this.assertLease();
    const next = structuredClone(record);
    next.sideEffects.approvalIds = [...new Set([...next.sideEffects.approvalIds, ...additions])];
    this.record = await this.store.append(next, 'approval_references_recorded', {
      count: additions.length,
      reviewHashes: additions.map((id) => sha256(id)).sort()
    });
    this.emit();
  }

  public async notifySideEffectsSettled(): Promise<void> {
    const record = this.requireRecord();
    if (!['waiting_for_apply', 'waiting_for_authorization', 'waiting_for_command'].includes(record.status)) return;
    await this.resume();
  }

  public async continueAfterHostResult(
    resultKey: string,
    result: Record<string, unknown>,
    dispatch = true
  ): Promise<void> {
    const record = this.requireRecord();
    if (record.consumedResultKeys.includes(resultKey)) return;
    if (!record.runCheckpoint?.state) throw new Error('Goal host result has no resumable checkpoint.');
    await this.assertLease();
    const control = stableStringify({
      kind: 'keepseek_goal_host_result', version: 1,
      contractHash: record.currentContractHash, revision: record.currentRevision,
      workspaceMutationRevision: record.workspaceMutationRevision,
      result
    });
    const next = structuredClone(record);
    next.runCheckpoint = appendGoalHostControl(next.runCheckpoint!, control);
    next.consumedResultKeys.push(resultKey);
    if (next.runCheckpoint.goal) {
      next.runCheckpoint.goal.consumedResultKeys = [...next.consumedResultKeys];
    }
    next.candidateFinal = undefined;
    next.completionDecision = undefined;
    next.sideEffects.pendingToolCallIds = [];
    next.status = 'running';
    next.waitingReason = undefined;
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'goal_host_result_persisted', {
      resultKeyHash: sha256(resultKey), contentHash: sha256(control)
    });
    this.emit();
    if (dispatch) await this.dispatch('continue');
  }

  public async dispatchContinuation(): Promise<void> { await this.dispatch('continue'); }

  public async invalidateEvidence(reason: string): Promise<void> {
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    await this.assertLease();
    const next = structuredClone(record);
    next.validations = [];
    next.completionDecision = undefined;
    next.candidateFinal = undefined;
    next.criteria = next.criteria.map((criterion) => ({
      ...criterion, status: 'pending', evidenceManifestHash: undefined,
      detail: `Invalidated: ${reason.slice(0, 300)}`
    }));
    syncGoalWorkItemProgress(next);
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'goal_evidence_invalidated', { reason: reason.slice(0, 500) });
    this.emit();
  }

  /** Checkpoints are persisted by the Provider callback before the current
   * model/tool request is allowed to make further progress. */
  public persistCheckpoint(checkpoint: RunCheckpoint): Promise<void> {
    const operation = this.checkpointWriteQueue.then(async () => await this.persistCheckpointNow(checkpoint));
    this.checkpointWriteQueue = operation.catch(() => undefined);
    return operation;
  }

  private async persistCheckpointNow(checkpoint: RunCheckpoint): Promise<void> {
    const record = this.requireRecord();
    await this.assertLease();
    if (checkpoint.version !== 3 || checkpoint.goal?.contractHash !== record.currentContractHash
      || checkpoint.goal.revision !== record.currentRevision) {
      throw new Error('Stale or non-Goal checkpoint cannot replace the current Goal revision.');
    }
    const next = structuredClone(record);
    next.runCheckpoint = checkpointCopy(checkpoint);
    next.logicalTaskId = checkpoint.taskId;
    next.usage.activeExecutionMs = checkpoint.usedMs;
    next.usage.costByCurrency = mergeLedger(next.usage.costByCurrency, checkpoint.usedCostByCurrency ?? {});
    next.runCheckpoint.usedCostByCurrency = { ...next.usage.costByCurrency };
    next.usage.modelRequests = Math.max(next.usage.modelRequests, checkpoint.modelRequests);
    next.usage.mainModelRequests = Math.max(next.usage.mainModelRequests,
      next.usage.modelRequests - next.usage.auxiliaryModelRequests);
    const executingToolId = checkpoint.state?.pending?.executing?.id;
    next.sideEffects.pendingToolCallIds = executingToolId ? [executingToolId] : [];
    syncGoalCheckpoint(next);
    this.record = await this.store.save(next);
  }

  public async reserveAuxiliaryModelRequest(kind: string): Promise<void> {
    const record = this.requireRecord();
    await this.assertLease();
    const budget = currentContract(record).budgets.maxModelRequests;
    if (budget > 0 && record.usage.modelRequests >= budget) throw new Error('Goal model request budget exhausted.');
    const next = structuredClone(record);
    next.usage.auxiliaryModelRequests += 1;
    next.usage.modelRequests = next.usage.mainModelRequests + next.usage.auxiliaryModelRequests;
    if (next.runCheckpoint) next.runCheckpoint.modelRequests = next.usage.modelRequests;
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'auxiliary_model_request_reserved', { kind: kind.slice(0, 80) });
  }

  public async recordAuxiliaryUsage(event: UsageEvent): Promise<void> {
    const record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    await this.assertLease();
    if (currentContract(record).budgets.maxCost > 0 && event.pricingStatus !== 'priced') {
      throw new Error('Goal cost limit cannot be enforced for an unpriced auxiliary model request.');
    }
    const next = structuredClone(record);
    if (event.pricingStatus === 'priced' && event.currency) {
      next.usage.costByCurrency[event.currency] = (next.usage.costByCurrency[event.currency] ?? 0) + event.cost;
      syncGoalCheckpoint(next);
    }
    this.record = await this.store.save(next);
  }

  public ensureWithinBudgets(): void { this.assertBudgets(this.requireRecord()); }

  /** Counts the union of host-side/reviewer activity through the same clock
   * semantics used by AgentRunner. The start intent is durable before callers
   * begin a command, apply, or reviewer request. */
  public async beginActivePhase(kind: string): Promise<{ signal: AbortSignal; finish(): Promise<void> }> {
    const record = this.requireRecord();
    await this.assertLease();
    if (!this.hostClock) this.hostClock = new ExecutionClock(currentContract(record).budgets.maxActiveExecutionMs, record.usage.activeExecutionMs);
    const release = this.hostClock.enter();
    this.hostActiveScopes += 1;
    try {
      this.record = await this.store.append(record, 'active_phase_started', { kind: kind.slice(0, 80) });
    } catch (error) {
      release();
      this.hostActiveScopes = Math.max(0, this.hostActiveScopes - 1);
      if (!this.hostActiveScopes) { this.hostClock.dispose(); this.hostClock = undefined; }
      throw error;
    }
    let finished = false;
    return {
      signal: this.hostClock.signal,
      finish: async () => {
        if (finished) return;
        finished = true;
        release();
        this.hostActiveScopes = Math.max(0, this.hostActiveScopes - 1);
        if (this.hostActiveScopes > 0 || !this.hostClock || !this.record) return;
        const usedMs = this.hostClock.usedMs;
        this.hostClock.dispose();
        this.hostClock = undefined;
        const next = structuredClone(this.record);
        next.usage.activeExecutionMs = Math.max(next.usage.activeExecutionMs, usedMs);
        syncGoalCheckpoint(next);
        this.record = await this.store.append(next, 'active_phase_settled', {
          kind: kind.slice(0, 80), activeExecutionMs: next.usage.activeExecutionMs
        });
        this.emit();
      }
    };
  }

  public async interrupt(
    reason: string,
    classification?: GoalRuntimeInterruptionV1['reason'],
    uncertainSideEffect = false
  ): Promise<void> {
    let record = this.requireRecord();
    if (isGoalTerminalStatus(record.status)) return;
    this.lifecycleGeneration += 1;
    this.cancelPendingLeaseWait();
    this.hooks.onCancelRuntime?.();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const next = transitionGoal(record, 'interrupted', { reason });
      next.lease = undefined;
      if (classification) {
        next.lastInterruption = {
          runtimeId: randomUUID(),
          previousStatus: record.status,
          reason: classification,
          uncertainSideEffect,
          recordedAt: next.updatedAt
        };
      }
      try {
        this.record = await this.store.append(next, 'goal_interrupted', {
          reason: reason.slice(0, 1_000),
          classification,
          uncertainSideEffect
        });
        break;
      } catch (error) {
        if (!(error instanceof GoalStoreConcurrencyError) || attempt === 3) throw error;
        const latest = await this.store.load(record.id);
        if (!latest) throw new Error('Goal disappeared while interrupting.');
        this.record = record = latest;
        if (isGoalTerminalStatus(record.status)) return;
      }
    }
    await this.lease.release();
    this.emit();
  }

  public get current(): GoalRecordV1 | undefined { return this.record ? structuredClone(this.record) : undefined; }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.lifecycleGeneration += 1;
    this.cancelPendingLeaseWait();
    this.hooks.onCancelRuntime?.();
    this.hostClock?.dispose();
    this.hostClock = undefined;
    this.hostActiveScopes = 0;
    await this.lease.release();
  }

  private async dispatch(kind: 'initial' | 'continue' | 'resume'): Promise<void> {
    if (this.dispatching || this.disposed) return;
    const record = this.requireRecord();
    if (record.status !== 'running') return;
    await this.assertLease();
    this.assertBudgets(record);
    const checkpointHash = record.runCheckpoint ? hashCheckpoint(record.runCheckpoint) : 'initial';
    const intent = {
      sequence: record.requestIntents.length + 1,
      kind,
      status: 'prepared' as const,
      checkpointHash,
      idempotencyKey: sha256(`${record.currentContractHash}:${kind}:${record.requestIntents.length + 1}:${checkpointHash}`),
      createdAt: new Date().toISOString()
    };
    const prepared = structuredClone(record);
    prepared.requestIntents.push(intent);
    this.record = await this.store.append(prepared, 'request_intent_prepared', {
      sequence: intent.sequence, kind, checkpointHash, idempotencyKey: intent.idempotencyKey
    });
    this.dispatching = true;
    this.emit();
    try {
      await this.assertLease();
      const dispatched = structuredClone(this.requireRecord());
      const dispatchedIntent = dispatched.requestIntents.at(-1);
      if (!dispatchedIntent || dispatchedIntent.sequence !== intent.sequence) throw new Error('Goal request intent changed before dispatch.');
      dispatchedIntent.status = 'dispatched';
      this.record = await this.store.append(dispatched, 'request_dispatched', {
        sequence: intent.sequence, kind, checkpointHash, idempotencyKey: intent.idempotencyKey
      });
      const result = await this.hooks.dispatchAttempt(this.record, this.record.runCheckpoint);
      if (!result) {
        if (this.record.status === 'pausing') await this.finishPause();
        else if (this.continuePending && this.record.status === 'running') return;
        else await this.moveToAttention('Goal attempt ended without a durable result.');
        return;
      }
      if (this.record.currentContractHash !== prepared.currentContractHash
        || this.record.currentRevision !== prepared.currentRevision) {
        this.continuePending = true;
        return;
      }
      await this.consumeAttempt(result);
    } catch (error) {
      if (this.record?.status === 'pausing') await this.finishPause();
      else if (error instanceof AgentInterruptedError && error.reason === 'uncertain_tool_result') {
        await this.moveExecutingToolToUncertain(error.message);
      }
      else await this.moveToAttention(error instanceof Error ? error.message : String(error));
    } finally {
      this.dispatching = false;
      if (this.record?.status === 'pausing') await this.finishPause();
      this.emit();
      if (this.continuePending && this.record?.status === 'running') {
        this.continuePending = false;
        queueMicrotask(() => { void this.dispatch('continue'); });
      }
    }
  }

  private async consumeAttempt(result: GoalAttemptResult): Promise<void> {
    const record = this.requireRecord();
    await this.assertLease();
    const next = structuredClone(record);
    next.runCheckpoint = checkpointCopy(result.checkpoint);
    next.logicalTaskId = result.checkpoint.taskId;
    next.usage.activeExecutionMs = result.checkpoint.usedMs;
    next.usage.costByCurrency = mergeLedger(next.usage.costByCurrency, result.checkpoint.usedCostByCurrency ?? {});
    next.runCheckpoint.usedCostByCurrency = { ...next.usage.costByCurrency };
    next.usage.modelRequests = Math.max(next.usage.modelRequests, result.checkpoint.modelRequests);
    next.usage.mainModelRequests = Math.max(next.usage.mainModelRequests,
      next.usage.modelRequests - next.usage.auxiliaryModelRequests);
    if (result.response.changeSet && !next.sideEffects.changeSetIds.includes(result.response.changeSet.id)) {
      next.sideEffects.changeSetIds.push(result.response.changeSet.id);
    }
    for (const draftRun of result.response.draftRuns ?? []) {
      if (!next.sideEffects.draftRunIds.includes(draftRun.id)) next.sideEffects.draftRunIds.push(draftRun.id);
    }
    for (const validation of result.response.runDetails.validations) {
      if (!validation.script) continue;
      next.validations.push({
        script: validation.script,
        status: validation.ok === true ? 'passed' : 'failed',
        mutationRevision: next.workspaceMutationRevision,
        contentHash: sha256(JSON.stringify(validation)),
        completedAt: result.response.runDetails.endedAt ?? new Date().toISOString()
      });
    }
    const intent = next.requestIntents.at(-1);
    if (intent) intent.status = 'settled';
    if (result.response.goalOutcome !== 'candidate_final') {
      syncGoalWorkItemProgress(next);
      syncGoalCheckpoint(next);
      const waitingStatus: GoalStatus = result.response.draftEdits.length ? 'waiting_for_apply'
        : (result.response.draftRuns?.length ?? 0) > 0 ? 'waiting_for_command'
          : result.response.approvalContinuationRequired ? 'waiting_for_authorization' : 'waiting_for_user';
      this.record = transitionGoal(next, waitingStatus, { reason: result.response.message });
      this.record = await this.store.append(this.record, 'attempt_waiting', { outcome: result.response.goalOutcome ?? 'waiting', status: waitingStatus });
      return;
    }
    const manifestHash = evidenceManifestHash(result.checkpoint);
    const contract = currentContract(next);
    const evidenceRefs = result.checkpoint.state?.epoch?.evidenceRefs.map((item) => item.evidenceRef) ?? [];
    for (const progress of next.criteria) {
      const criterion = contract.acceptanceCriteria.find((item) => item.id === progress.criterionId);
      if (!criterion || criterion.type === 'manual') continue;
      const validationSatisfied = criterion.type === 'validation' && next.validations.some((validation) =>
        validation.status === 'passed' && validation.mutationRevision === next.workspaceMutationRevision);
      const evidenceSatisfied = criterion.type !== 'validation' && evidenceRefs.length > 0
        && result.response.taskPlan.status === 'completed' && result.response.taskPlan.blockers.length === 0;
      if (validationSatisfied || evidenceSatisfied) {
        progress.status = 'satisfied';
        progress.evidenceRefs = validationSatisfied
          ? next.validations.filter((validation) => validation.status === 'passed').map((validation) =>
              validation.evidenceRef ?? `validation:${validation.script}:${validation.contentHash ?? ''}`)
          : evidenceRefs.slice(0, 64);
        progress.evidenceManifestHash = manifestHash;
      }
    }
    syncGoalWorkItemProgress(next);
    next.candidateFinal = {
      content: result.response.message,
      contentHash: sha256(result.response.message),
      reasoningContent: result.response.reasoningContent,
      taskPlan: result.response.taskPlan,
      providerReplay: result.response.providerReplay
    };
    next.runCheckpoint = checkpointCopy(result.checkpoint);
    syncGoalCheckpoint(next);
    this.record = await this.store.append(next, 'candidate_final_persisted', {
      candidateHash: next.candidateFinal.contentHash, evidenceManifestHash: manifestHash,
      mutationRevision: next.workspaceMutationRevision
    });
    await this.reviewCandidate();
  }

  private async reviewCandidate(): Promise<void> {
    const record = this.requireRecord();
    const budgets = currentContract(record).budgets;
    if (budgets.maxCompletionReviews > 0 && record.usage.completionReviews >= budgets.maxCompletionReviews) {
      await this.moveToAttention('Goal completion review budget exhausted.');
      return;
    }
    if (budgets.maxModelRequests > 0 && record.usage.modelRequests >= budgets.maxModelRequests) {
      await this.moveToAttention('Goal model request budget exhausted before completion review.');
      return;
    }
    const phase = await this.beginActivePhase('completion_review');
    const safety = await this.hooks.completionSafety(this.requireRecord());
    const context = await this.hooks.completionReviewerContext(this.requireRecord());
    let result: GoalCompletionReviewResult;
    try {
      result = await this.completionReview.review({
        record: this.requireRecord(),
        candidate: this.requireRecord().candidateFinal!.content,
        snapshot: safety,
        context: { ...context, signal: phase.signal },
        persistReviewIntent: async () => {
          await this.assertLease();
          const next = structuredClone(this.requireRecord());
          next.usage.completionReviews += 1;
          next.usage.auxiliaryModelRequests += 1;
          next.usage.modelRequests = next.usage.mainModelRequests + next.usage.auxiliaryModelRequests;
          if (next.runCheckpoint?.goal) {
            next.runCheckpoint.goal.completionReviews = next.usage.completionReviews;
            next.runCheckpoint.goal.modelRequests = next.usage.modelRequests;
          }
          syncGoalCheckpoint(next);
          this.record = await this.store.append(next, 'completion_review_intent', {
            candidateHash: next.candidateFinal?.contentHash,
            evidenceManifestHash: safety.evidenceManifestHash,
            mutationRevision: next.workspaceMutationRevision
          });
        }
      });
    } catch (error) {
      await Promise.resolve(this.hooks.onTraceEvent?.('completion_review', this.requireRecord(), {
        status: 'failed', reason: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000)
      })).catch(() => undefined);
      throw error;
    } finally {
      await phase.finish();
    }
    if (phase.signal.aborted) {
      await this.moveToAttention('Goal active execution budget exhausted during completion review.');
      return;
    }
    if (result.usageEvents?.length) {
      const next = structuredClone(this.requireRecord());
      for (const event of result.usageEvents) {
        if (event.pricingStatus === 'priced' && event.currency) {
          next.usage.costByCurrency[event.currency] = (next.usage.costByCurrency[event.currency] ?? 0) + event.cost;
        }
      }
      if (next.runCheckpoint) next.runCheckpoint.usedCostByCurrency = { ...next.usage.costByCurrency };
      if (next.runCheckpoint?.goal) {
        next.runCheckpoint.goal.modelRequests = next.usage.modelRequests;
        next.runCheckpoint.goal.costByCurrency = { ...next.usage.costByCurrency };
      }
      syncGoalCheckpoint(next);
      this.record = await this.store.save(next);
    }
    const reviewWasDispatched = this.requireRecord().usage.completionReviews > record.usage.completionReviews;
    if (budgets.maxCost > 0 && reviewWasDispatched
      && (!result.usageEvents?.length || result.usageEvents.some((event) => event.pricingStatus !== 'priced'))) {
      await this.moveToAttention('Goal completion reviewer usage could not be priced; the positive cost limit is fail-closed.');
      return;
    }
    await Promise.resolve(this.hooks.onTraceEvent?.('completion_review', this.requireRecord(), {
      status: result.status,
      decision: result.decision?.decision,
      unmetCriterionCount: result.decision?.unmetCriterionIds.length ?? result.hardCheck.unmetCriterionIds.length,
      incompleteValidationCount: result.hardCheck.incompleteValidations.length,
      blockerCount: result.hardCheck.blockers.length
    })).catch(() => undefined);
    await this.commitReviewResult(result, safety.evidenceManifestHash);
  }

  private async commitReviewResult(result: GoalCompletionReviewResult, manifestHash: string): Promise<void> {
    let record = this.requireRecord();
    if (result.decision) {
      const next = structuredClone(record); next.completionDecision = result.decision;
      syncGoalCheckpoint(next);
      record = this.record = await this.store.append(next, 'completion_review_settled', {
        decision: result.decision.decision, candidateHash: result.decision.candidateHash,
        evidenceManifestHash: result.decision.evidenceManifestHash, mutationRevision: result.decision.mutationRevision
      });
    }
    if (result.status === 'complete') {
      await this.assertLease();
      const freshSafety = await this.hooks.completionSafety(record);
      const freshHard = this.completionReview.hardCheck(record, freshSafety);
      const decision = record.completionDecision;
      if (!freshHard.passed || !decision || decision.goalHash !== record.currentContractHash
        || decision.revision !== record.currentRevision || decision.candidateHash !== record.candidateFinal?.contentHash
        || decision.evidenceManifestHash !== freshSafety.evidenceManifestHash
        || decision.mutationRevision !== record.workspaceMutationRevision) {
        await this.moveToAttention('Completion bindings became stale before commit.');
        return;
      }
      const terminalReplay = createTerminalGoalReplay({
        checkpoint: record.runCheckpoint!, contract: currentContract(record), candidateContent: record.candidateFinal!.content
      });
      const completed = transitionGoal(record, 'completed');
      completed.finalMessageId ??= randomUUID();
      completed.replayCursor = toGoalReplayCursor(terminalReplay, `goal:${completed.id}:terminal`);
      completed.providerReplay = record.candidateFinal?.providerReplay;
      completed.terminalReplay = terminalReplay;
      completed.lease = undefined;
      this.record = await this.store.append(completed, 'goal_completed', {
        contractHash: completed.currentContractHash, revision: completed.currentRevision,
        candidateHash: completed.candidateFinal?.contentHash, replayHash: terminalReplay.bytesHash
      });
      // UI/final ChatMessage is emitted only after the durable completed record exists.
      await this.hooks.onCompleted?.(this.record);
      await this.lease.release();
      if (this.record.logicalTaskId) this.hooks.onReleaseTask?.(this.record.logicalTaskId);
      return;
    }
    if (result.status === 'continue') {
      const unmetCriterionIds = result.decision?.unmetCriterionIds.length
        ? result.decision.unmetCriterionIds : result.hardCheck.unmetCriterionIds;
      const nextStep = result.hardCheck.incompleteValidations[0]
        ? `run_required_validation:${result.hardCheck.incompleteValidations[0]}`
        : unmetCriterionIds[0] ? `satisfy_criterion:${unmetCriterionIds[0]}`
          : `resolve_host_blocker:${[...result.hardCheck.blockers].sort()[0] ?? 'reviewer_requested_more_evidence'}`;
      const control = createGoalControlItem({
        contractHash: record.currentContractHash,
        revision: record.currentRevision,
        evidenceManifestHash: manifestHash,
        workspaceMutationRevision: record.workspaceMutationRevision,
        unmetCriterionIds,
        incompleteValidations: result.hardCheck.incompleteValidations,
        taskPlan: record.candidateFinal?.taskPlan,
        nextStep
      });
      const next = structuredClone(record);
      next.runCheckpoint = appendGoalContinuation({
        checkpoint: next.runCheckpoint!, candidateContent: next.candidateFinal!.content,
        candidateReasoning: next.candidateFinal?.reasoningContent, controlContent: control.content
      });
      next.candidateFinal = undefined;
      next.completionDecision = undefined;
      next.status = 'running';
      this.record = await this.store.append(next, 'goal_control_persisted', {
        contentHash: control.contentHash, contractHash: next.currentContractHash,
        revision: next.currentRevision, evidenceManifestHash: manifestHash
      });
      this.continuePending = true;
      return;
    }
    const reason = result.reason ?? (result.status === 'blocked' ? 'Completion requires user input.' : 'Completion reviewer is unavailable or malformed.');
    const status: GoalStatus = result.status === 'blocked'
      ? result.hardCheck.blockers.some((blocker) => blocker.startsWith('unsettled_changeset')) ? 'waiting_for_apply'
        : result.hardCheck.blockers.some((blocker) => blocker.startsWith('unsettled_draftrun')) ? 'waiting_for_command'
          : result.hardCheck.blockers.includes('pending_approval') ? 'waiting_for_authorization'
            : 'waiting_for_user'
      : 'needs_attention';
    this.record = transitionGoal(record, status, { reason });
    this.record = await this.store.append(this.record, 'completion_review_blocked', { status: result.status, reason: reason.slice(0, 1_000) });
  }

  private async finishPause(): Promise<void> {
    const record = this.requireRecord();
    if (record.status !== 'pausing') return;
    this.record = transitionGoal(record, 'paused', { reason: 'Paused at a safe boundary.' });
    this.record = await this.store.append(this.record, 'goal_paused', {});
  }

  private async moveToAttention(reason: string): Promise<void> {
    if (!this.record || isGoalTerminalStatus(this.record.status)) return;
    let next: GoalRecordV1;
    try {
      next = this.record.status === 'needs_attention'
        ? { ...structuredClone(this.record), stopReason: reason, updatedAt: new Date().toISOString() }
        : transitionGoal(this.record, 'needs_attention', { reason });
    }
    catch { next = { ...structuredClone(this.record), status: 'needs_attention', stopReason: reason, updatedAt: new Date().toISOString() }; }
    next.lease = undefined;
    this.record = await this.store.append(next, 'goal_needs_attention', { reason: reason.slice(0, 1_000) });
    await this.lease.release();
    this.emit();
  }

  /** Converts a still-executing checkpoint intent into an explicit uncertain
   * result only after AgentRunner has reconciled its ToolEvidence and proved
   * that it was neither safely replayable nor durably completed. */
  private async moveExecutingToolToUncertain(reason: string): Promise<void> {
    if (!this.record || isGoalTerminalStatus(this.record.status)) return;
    await this.assertLease();
    const toolCallId = this.record.runCheckpoint?.state?.pending?.executing?.id;
    if (!toolCallId) {
      await this.moveToAttention(reason);
      return;
    }
    const next = structuredClone(this.record);
    next.sideEffects.pendingToolCallIds = next.sideEffects.pendingToolCallIds.filter((id) => id !== toolCallId);
    if (!next.sideEffects.uncertainToolCallIds.includes(toolCallId)) {
      next.sideEffects.uncertainToolCallIds.push(toolCallId);
    }
    const requestIntent = next.requestIntents.at(-1);
    if (requestIntent?.status === 'dispatched') requestIntent.status = 'uncertain';
    let attention: GoalRecordV1;
    try { attention = transitionGoal(next, 'needs_attention', { reason }); }
    catch { attention = { ...next, status: 'needs_attention', stopReason: reason, updatedAt: new Date().toISOString() }; }
    attention.lease = undefined;
    this.record = await this.store.append(attention, 'goal_tool_result_uncertain', {
      toolCallId,
      reason: reason.slice(0, 1_000)
    });
    await this.lease.release();
    this.emit();
  }

  private async assertLease(): Promise<void> {
    const binding = this.requireRecord().lease;
    if (!binding || binding.ownerId !== this.lease.binding?.ownerId || binding.fencingToken !== this.lease.binding?.fencingToken
      || !(await this.lease.confirm())) throw new Error('Goal lease/fencing check failed.');
  }

  private async waitForLeaseExpiry(delayMs: number, generation: number): Promise<boolean> {
    this.cancelPendingLeaseWait();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.cancelLeaseWait === finish) this.cancelLeaseWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(1, delayMs + 25));
      this.cancelLeaseWait = finish;
    });
    return generation === this.lifecycleGeneration && !this.disposed;
  }

  private cancelPendingLeaseWait(): void {
    const cancel = this.cancelLeaseWait;
    this.cancelLeaseWait = undefined;
    cancel?.();
  }

  private assertBudgets(record: GoalRecordV1): void {
    const budget = currentContract(record).budgets;
    if (budget.maxActiveExecutionMs > 0 && record.usage.activeExecutionMs >= budget.maxActiveExecutionMs) throw new Error('Goal active execution budget exhausted.');
    if (budget.maxModelRequests > 0 && record.usage.modelRequests >= budget.maxModelRequests) throw new Error('Goal model request budget exhausted.');
    if (budget.maxCompletionReviews > 0 && record.usage.completionReviews >= budget.maxCompletionReviews) throw new Error('Goal completion review budget exhausted.');
    if (budget.maxCost > 0 && Object.values(record.usage.costByCurrency).some((cost) => cost >= budget.maxCost)) throw new Error('Goal cost budget exhausted.');
  }

  private requireRecord(): GoalRecordV1 { if (!this.record) throw new Error('No Goal is available.'); return this.record; }
  private ensureUsable(): void { if (this.disposed) throw new Error('Goal coordinator is disposed.'); }
  private emit(): void { this.hooks.onStateChanged?.(this.current); }
}

function currentContract(record: GoalRecordV1): GoalContract {
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract) throw new Error('Current Goal contract is missing.');
  return contract;
}

function goalLeaseFailureMessage(reason: Awaited<ReturnType<GoalLease['acquire']>>['reason']): string {
  switch (reason) {
    case 'held': return 'Another VS Code window is actively running this workspace Goal.';
    case 'lock_busy': return 'The Goal lease update is still busy; retry Resume.';
    case 'unsupported_storage': return 'This storage provider cannot guarantee exclusive Goal execution.';
    case 'state_changed': return 'The Goal changed while the lease takeover was being checked.';
    default: return 'The Goal lease could not be safely acquired.';
  }
}

function evidenceManifestHash(checkpoint: RunCheckpoint): string {
  return sha256(JSON.stringify((checkpoint.state?.epoch?.evidenceRefs ?? []).map(({ evidenceRef, contentHash, toolName }) => ({
    evidenceRef, contentHash, toolName
  }))));
}

function hashCheckpoint(checkpoint: RunCheckpoint): string { return sha256(JSON.stringify(checkpoint)); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function mergeLedger(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const merged = { ...left };
  for (const [currency, cost] of Object.entries(right)) merged[currency] = Math.max(merged[currency] ?? 0, cost);
  return merged;
}

function syncGoalCheckpoint(record: GoalRecordV1): void {
  const checkpoint = record.runCheckpoint;
  const goal = checkpoint?.goal;
  if (!checkpoint || !goal) return;
  goal.contractHash = record.currentContractHash;
  goal.revision = record.currentRevision;
  goal.activeExecutionMs = record.usage.activeExecutionMs;
  goal.costByCurrency = { ...record.usage.costByCurrency };
  goal.modelRequests = record.usage.modelRequests;
  goal.completionReviews = record.usage.completionReviews;
  goal.criteria = record.criteria.map(({ criterionId, status, evidenceManifestHash }) => ({
    id: criterionId, status, evidenceManifestHash
  }));
  goal.workItems = record.workItems?.map((item) => structuredClone(item));
  goal.validationMutationRevision = record.workspaceMutationRevision;
  record.replayCursor = createGoalCheckpointReplayCursor(checkpoint) ?? record.replayCursor;
  goal.replayCursor = record.replayCursor ? structuredClone(record.replayCursor) : undefined;
  goal.consumedResultKeys = [...record.consumedResultKeys];
  goal.completionDecisionRef = record.completionDecision
    ? sha256(stableStringify(record.completionDecision)) : undefined;
  checkpoint.usedMs = Math.max(checkpoint.usedMs, record.usage.activeExecutionMs);
  checkpoint.usedCostByCurrency = { ...record.usage.costByCurrency };
  checkpoint.modelRequests = record.usage.modelRequests;
}

/** Work-item status is derived only from persisted criterion evidence. The
 * dynamic TaskPlan remains independent and never selects a business item by
 * textual similarity or model assertion. */
function syncGoalWorkItemProgress(record: GoalRecordV1): void {
  if (!record.workItems) return;
  for (const item of record.workItems) {
    const criteria = item.acceptanceCriterionIds.map((id) => record.criteria.find((criterion) => criterion.criterionId === id));
    if (criteria.some((criterion) => criterion?.status === 'blocked')) {
      item.status = 'blocked';
      item.detail = 'One or more acceptance criteria are blocked.';
    } else if (criteria.length > 0 && criteria.every((criterion) => criterion?.status === 'satisfied')) {
      item.status = 'completed';
      item.detail = undefined;
    } else if (criteria.some((criterion) => criterion?.status === 'satisfied')) {
      item.status = 'in_progress';
      item.detail = 'Some acceptance evidence is satisfied.';
    } else {
      item.status = 'pending';
      item.detail = undefined;
    }
    item.pauseReason = undefined;
  }
}
