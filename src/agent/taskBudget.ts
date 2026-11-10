import type { AgentExecutionLimits, AgentRequest, AgentTaskBudgetAuthority } from '../shared/types';
import type { UserTaskBudget } from '../sessions/userTaskBudget';
import { normalizeUserTaskBudgets } from '../sessions/userTaskBudget';
import { ExecutionCostBudget, LogicalRunBudget, SharedUpstreamTokenBudget, mergeCostLimits, mergeDurations,
  type LogicalRunBudgetLimits } from './executionPolicy';
import { DEFAULT_SUBAGENT_MAX_CONTEXT_EPOCH_ROLLOVERS, getConfiguredAgentMaxContextEpochRollovers,
  getConfiguredAgentMaxContinuations, getConfiguredAgentMaxCost, getConfiguredAgentMaxExecutionMs,
  getConfiguredAgentMaxModelRequests, getConfiguredAgentMaxToolCalls, getConfiguredAgentMaxToolIterations,
  getConfiguredAgentMaxTreeUpstreamTokens, getConfiguredSubagentMaxUpstreamTokens } from '../shared/config';

/** A process-local root allowance, prepared after a real input is durable.
 * It must never be serialized or copied into a replay/child request. */
export interface PreparedAgentTaskBudget extends AgentTaskBudgetAuthority {
  sessionId: string;
  rootTaskId: string;
  maxExecutionMs: number;
}

function positiveMinimum(...values: Array<number | undefined>): number {
  const positive = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0)
    .map(value => Math.floor(value));
  return positive.length ? Math.min(...positive) : 0;
}

/** One authority for configured root/child limits, shared by early admission
 * and the runtime source resolver. Zero remains unlimited except continuations. */
export function resolveAgentLogicalBudgetLimits(input: Pick<AgentRequest, 'executionLimits' | 'subagentContext'>): LogicalRunBudgetLimits {
  const { executionLimits: requested, subagentContext: child } = input;
  const continuation = requested?.maxContinuations;
  const configuredContinuations = getConfiguredAgentMaxContinuations();
  return {
    maxModelRequests: positiveMinimum(getConfiguredAgentMaxModelRequests(Boolean(child)), requested?.maxModelRequests),
    maxToolRounds: positiveMinimum(child ? 0 : getConfiguredAgentMaxToolIterations(), requested?.maxToolIterations),
    maxToolCalls: positiveMinimum(child ? 0 : getConfiguredAgentMaxToolCalls(), requested?.maxToolCalls),
    maxContinuations: typeof continuation === 'number' && Number.isFinite(continuation) && continuation >= 0
      ? Math.min(configuredContinuations, Math.floor(continuation)) : configuredContinuations,
    maxContextEpochRollovers: positiveMinimum(child ? DEFAULT_SUBAGENT_MAX_CONTEXT_EPOCH_ROLLOVERS : getConfiguredAgentMaxContextEpochRollovers(), requested?.maxContextEpochRollovers),
    maxUpstreamTokens: positiveMinimum(child ? getConfiguredSubagentMaxUpstreamTokens() : getConfiguredAgentMaxTreeUpstreamTokens(), requested?.maxUpstreamTokens),
    maxTreeUpstreamTokens: positiveMinimum(getConfiguredAgentMaxTreeUpstreamTokens(), requested?.maxTreeUpstreamTokens),
    maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0
  };
}

/** Prepare the original task's allowance before potentially slow compression.
 * Restored roots retain their spent limits; a missing old ledger cannot turn
 * into a new automatic-title budget. This function itself performs no I/O. */
export function prepareAgentTaskBudget(input: {
  sessionId: string;
  rootTaskId: string;
  executionLimits?: AgentExecutionLimits;
  priorBudget?: UserTaskBudget;
  persist?: () => Promise<void>;
}): PreparedAgentTaskBudget {
  if (!input.sessionId || !input.rootTaskId) throw new Error('Prepared task budget identity is missing');
  const previous = input.priorBudget && normalizeUserTaskBudgets({ prior: input.priorBudget }).prior;
  if (input.priorBudget && (!previous?.runBudget || !previous.budgetLimits)) throw new Error('Original task budget is unavailable');
  const limits = resolveAgentLogicalBudgetLimits({ executionLimits: input.executionLimits });
  if (previous?.budgetLimits) for (const key of Object.keys(limits) as Array<keyof LogicalRunBudgetLimits>) {
    // Continuation zero is a real disabled grant, not an unlimited value.
    limits[key] = key === 'maxContinuations' ? Math.min(limits[key], previous.budgetLimits[key])
      : positiveMinimum(limits[key], previous.budgetLimits[key]);
  }
  const maxExecutionMs = mergeDurations(getConfiguredAgentMaxExecutionMs(), input.executionLimits?.maxRunMs,
    previous?.maxExecutionMs);
  const maxCost = mergeCostLimits(getConfiguredAgentMaxCost(), input.executionLimits?.maxCost, previous?.maxCost);
  const restored = previous?.runBudget && { ...previous.runBudget, usedMs: Math.max(previous.usedMs, previous.runBudget.usedMs) };
  const run = new LogicalRunBudget(restored, limits,
    new SharedUpstreamTokenBudget(limits.maxTreeUpstreamTokens, previous?.runBudget?.treeUpstreamTokens ?? 0), maxExecutionMs);
  const cost = new ExecutionCostBudget(maxCost, previous?.usedCostByCurrency);
  const base: UserTaskBudget = { version: 1, usedMs: previous?.usedMs ?? 0, maxExecutionMs, maxCost,
    usedCostByCurrency: previous?.usedCostByCurrency ?? {},
    commandRecoveryKeys: previous?.commandRecoveryKeys, commandRecoveryExhausted: previous?.commandRecoveryExhausted,
    delegationBudget: previous?.delegationBudget };
  return {
    sessionId: input.sessionId, rootTaskId: input.rootTaskId, maxExecutionMs, run, cost,
    snapshot: () => structuredClone({ ...base, usedMs: run.state.usedMs, maxCost: cost.limit, usedCostByCurrency: cost.snapshot(),
      runBudget: run.state, budgetLimits: run.limits }),
    persist: input.persist ?? (() => Promise.reject(new Error('Prepared task budget has no persistence owner')))
  };
}

/** With no finite token/cost ceiling, one early title cannot take the last
 * main-request slot. Scarce explicit ceilings retain main-first admission. */
export function canStartInputTitleBeforeMain(budget: PreparedAgentTaskBudget): boolean {
  const { limits, state } = budget.run;
  return budget.cost.limit === 0 && limits.maxUpstreamTokens === 0 && limits.maxTreeUpstreamTokens === 0
    && (limits.maxModelRequests === 0 || limits.maxModelRequests - state.modelRequests >= 2);
}
