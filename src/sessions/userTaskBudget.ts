import type { RunCheckpoint } from '../agent/runCheckpoint';
import { createLogicalRunBudgetState, normalizeLogicalRunBudgetLimits } from '../agent/executionPolicy';
import { validEpochProgressState, type ContextEpochState } from '../agent/contextEpoch';

/** Safety ledger carried between execution segments; distinct from display time. */
export type UserTaskBudget = Pick<RunCheckpoint, 'usedMs' | 'maxExecutionMs' | 'maxCost' | 'usedCostByCurrency' | 'runBudget' | 'budgetLimits' | 'delegationBudget' | 'commandRecoveryKeys' | 'commandRecoveryExhausted'> & {
  version: 1; epoch?: ContextEpochState; continuationState?: RunCheckpoint['continuationState'];
};
export function taskBudgetFromCheckpoint(cp: RunCheckpoint): UserTaskBudget {
  return structuredClone({ version: 1, usedMs: cp.usedMs, maxExecutionMs: cp.maxExecutionMs,
    commandRecoveryKeys: cp.commandRecoveryKeys, commandRecoveryExhausted: cp.commandRecoveryExhausted, maxCost: cp.maxCost, usedCostByCurrency: cp.usedCostByCurrency, runBudget: cp.runBudget, budgetLimits: cp.budgetLimits, delegationBudget: cp.delegationBudget,
    ...(cp.request.projectTaskIdentity ? { epoch: cp.state?.epoch ?? cp.inheritedEpoch,
      continuationState: cp.state ? { validationState: cp.state.validationState,
        validationRunCount: cp.state.validationRunCount, repairLoop: cp.state.repairLoop } : cp.continuationState } : {}) });
}
export function normalizeUserTaskBudgets(value: unknown): Record<string, UserTaskBudget> {
  const result: Record<string, UserTaskBudget> = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [id, raw] of Object.entries(value)) {
    const v = raw as UserTaskBudget;
    if (!v || v.version !== 1 || ![v.usedMs, v.maxExecutionMs, v.maxCost ?? 0].every(n => Number.isFinite(n) && n >= 0)
      || (v.usedCostByCurrency !== undefined && (!v.usedCostByCurrency || typeof v.usedCostByCurrency !== 'object'
        || Array.isArray(v.usedCostByCurrency) || Object.entries(v.usedCostByCurrency).some(([currency, n]) => !currency || !Number.isFinite(n) || n < 0)))) continue;
    if (v.runBudget !== undefined && (!v.runBudget || typeof v.runBudget !== 'object' || Array.isArray(v.runBudget)
      || v.runBudget.version !== 1 || Object.entries(createLogicalRunBudgetState()).some(([key, initial]) => {
        const count = v.runBudget![key as keyof NonNullable<UserTaskBudget['runBudget']>];
        return typeof initial === 'number' && (!Number.isSafeInteger(count) || (count as number) < 0);
      }))) continue;
    if (v.budgetLimits !== undefined && !normalizeLogicalRunBudgetLimits(v.budgetLimits)) continue;
    if (v.epoch !== undefined && !validTaskEpoch(v.epoch)) continue;
    if (v.continuationState !== undefined && !validTaskContinuationState(v.continuationState)) continue;
    if (v.delegationBudget && (!Number.isSafeInteger(v.delegationBudget.count) || v.delegationBudget.count < 0
      || !Array.isArray(v.delegationBudget.parents) || !Array.isArray(v.delegationBudget.paths)
      || v.delegationBudget.parents.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !Number.isSafeInteger(p[1]) || p[1] < 0)
      || v.delegationBudget.paths.some(p => !Array.isArray(p) || p.length !== 2 || p.some(s => typeof s !== 'string')))) continue;
    if (v.commandRecoveryKeys !== undefined && (!Array.isArray(v.commandRecoveryKeys) || v.commandRecoveryKeys.length > 2
      || v.commandRecoveryKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)))) continue;
    result[id] = {
      commandRecoveryKeys: v.commandRecoveryKeys?.slice(), commandRecoveryExhausted: v.commandRecoveryExhausted === true || undefined, version: 1, usedMs: v.usedMs, maxExecutionMs: v.maxExecutionMs, maxCost: v.maxCost,
      usedCostByCurrency: v.usedCostByCurrency ? { ...v.usedCostByCurrency } : {},
      runBudget: v.runBudget ? createLogicalRunBudgetState(v.runBudget) : undefined,
      budgetLimits: normalizeLogicalRunBudgetLimits(v.budgetLimits),
      epoch: v.epoch ? structuredClone(v.epoch) : undefined,
      continuationState: v.continuationState ? structuredClone(v.continuationState) : undefined,
      delegationBudget: v.delegationBudget ? structuredClone(v.delegationBudget) : undefined };
  }
  return result;
}

export function validTaskEpoch(epoch: ContextEpochState): boolean {
  return !!epoch && epoch.version === 1 && ['active', 'summarizing', 'persisted'].includes(epoch.status)
    && [epoch.index, epoch.totalRollovers, epoch.turnInEpoch, epoch.toolCallsInEpoch].every(n => Number.isSafeInteger(n) && n >= 0)
    && [epoch.rollovers, epoch.evidenceRefs, epoch.failures, epoch.idempotency].every(Array.isArray)
    && epoch.evidenceRefs.every(ref => ref && typeof ref.evidenceRef === 'string' && typeof ref.contentHash === 'string'
      && typeof ref.toolName === 'string' && typeof ref.toolCallId === 'string')
    && validEpochProgressState(epoch);
}

export function validTaskContinuationState(value: NonNullable<RunCheckpoint['continuationState']>): boolean {
  const repair = value?.repairLoop, validation = value?.validationState;
  return !!repair && Number.isSafeInteger(value.validationRunCount) && value.validationRunCount >= 0
    && Number.isSafeInteger(repair.iteration) && repair.iteration >= 0
    && Number.isSafeInteger(repair.maxIterations) && repair.maxIterations >= 0
    && ['idle', 'validation_failed', 'reading_problems', 'generating_repair', 'waiting_for_apply',
      'ready_for_validation', 'running_validation', 'completed', 'blocked'].includes(repair.status)
    && Array.isArray(repair.pendingDraftEditIds) && repair.pendingDraftEditIds.every(id => typeof id === 'string')
    && (!validation || (Array.isArray(validation.pendingDraftEditIds)
      && validation.pendingDraftEditIds.every(id => typeof id === 'string') && Array.isArray(validation.validations)
      && validation.validations.every(result => result && ['workspace_baseline', 'post_apply'].includes(result.scope)
        && ['passed', 'failed'].includes(result.outcome))));
}
