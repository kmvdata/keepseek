import type { RunCheckpoint } from '../agent/runCheckpoint';
import { createLogicalRunBudgetState, normalizeLogicalRunBudgetLimits } from '../agent/executionPolicy';
import { isCommandRecoveryKeyList, normalizeCommandRecoveryObservations } from '../runs/commandRecovery';

/** Safety ledger carried between execution segments; distinct from display time. */
export type UserTaskBudget = Pick<RunCheckpoint, 'usedMs' | 'maxExecutionMs' | 'maxCost' | 'usedCostByCurrency' | 'runBudget'
  | 'budgetLimits' | 'delegationBudget' | 'commandRecoveryKeys' | 'commandRecoveryExhausted'
  | 'commandRecoveryObservations' | 'commandRecoveryObservationsInvalid'> & { version: 1 };
export function taskBudgetFromCheckpoint(cp: RunCheckpoint): UserTaskBudget {
  return structuredClone({ version: 1, usedMs: cp.usedMs, maxExecutionMs: cp.maxExecutionMs,
    commandRecoveryObservations: cp.commandRecoveryObservations, commandRecoveryObservationsInvalid: cp.commandRecoveryObservationsInvalid,
    commandRecoveryKeys: cp.commandRecoveryKeys, commandRecoveryExhausted: cp.commandRecoveryExhausted, maxCost: cp.maxCost, usedCostByCurrency: cp.usedCostByCurrency, runBudget: cp.runBudget, budgetLimits: cp.budgetLimits, delegationBudget: cp.delegationBudget });
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
    if (v.delegationBudget && (!Number.isSafeInteger(v.delegationBudget.count) || v.delegationBudget.count < 0
      || !Array.isArray(v.delegationBudget.parents) || !Array.isArray(v.delegationBudget.paths)
      || v.delegationBudget.parents.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !Number.isSafeInteger(p[1]) || p[1] < 0)
      || v.delegationBudget.paths.some(p => !Array.isArray(p) || p.length !== 2 || p.some(s => typeof s !== 'string')))) continue;
    const validLegacyKeys = isCommandRecoveryKeyList(v.commandRecoveryKeys);
    const observations = normalizeCommandRecoveryObservations(v.commandRecoveryObservations, id);
    const invalidRecovery = v.commandRecoveryObservationsInvalid !== undefined
      || v.commandRecoveryObservations !== undefined && !observations
      || v.commandRecoveryKeys !== undefined && !validLegacyKeys;
    result[id] = {
      commandRecoveryKeys: validLegacyKeys ? v.commandRecoveryKeys?.slice() : undefined,
      commandRecoveryExhausted: v.commandRecoveryExhausted === true || undefined,
      commandRecoveryObservations: observations, commandRecoveryObservationsInvalid: invalidRecovery || undefined,
      version: 1, usedMs: v.usedMs, maxExecutionMs: v.maxExecutionMs, maxCost: v.maxCost,
      usedCostByCurrency: v.usedCostByCurrency ? { ...v.usedCostByCurrency } : {},
      runBudget: v.runBudget ? createLogicalRunBudgetState(v.runBudget) : undefined,
      budgetLimits: normalizeLogicalRunBudgetLimits(v.budgetLimits),
      delegationBudget: v.delegationBudget ? structuredClone(v.delegationBudget) : undefined };
  }
  return result;
}
