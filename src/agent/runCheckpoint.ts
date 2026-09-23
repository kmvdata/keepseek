import { createHash, randomUUID } from 'node:crypto';
import type { AgentRequest, AgentToolRound, DraftEdit, DraftRunProposal, RepairLoopState } from '../shared/types';
import type { DeepSeekAssistantMessage, DeepSeekMessage, DeepSeekUsage } from './deepseek/types';
import type { ProviderNativeRunState } from './runner';
import type { ContextEpochState } from './contextEpoch';
import { getEffectiveContextWindowTokens } from '../shared/modelProfiles';
import { DEEPSEEK_MODEL_IDENTITY_VERSION, getCanonicalModelIdentity } from '../shared/deepSeekModels';
import { migrateContextWindowCalibrationState } from './toolResultAdmission';
import { normalizeExecutionMode } from './executionMode';
import { createLogicalRunBudgetState, type LogicalRunBudgetState } from './executionPolicy';

export type StopReason = 'user_stop' | 'time_budget' | 'tool_timeout' | 'connection_interrupted'
  | 'provider_error' | 'extension_restart' | 'waiting_for_user' | 'budget_exhausted' | 'completed' | 'storage_failure' | 'resource_limit'
  | 'cost_limit' | 'no_progress_loop' | 'uncertain_tool_result';

/** Deserialization-only values produced by v1 checkpoints. V2 never emits them. */
export type LegacyCapacityFinishReason = 'tool_iterations_exhausted' | 'tool_call_limit_exhausted'
  | 'tool_result_budget_exhausted' | 'context_window_exhausted' | 'run_time_limit_exhausted';

export interface RunCheckpoint {
  version: 1 | 2;
  taskId: string;
  attempt: number;
  attemptIds: string[];
  status: 'running' | 'interrupted' | 'completed' | 'blocked';
  stopReason?: StopReason;
  error?: string;
  usedMs: number;
  maxExecutionMs: number;
  /** Accounted Provider cost is preserved across epochs and restart. */
  usedCostByCurrency?: Record<string, number>;
  maxCost?: number;
  limitSource: string;
  modelRequests: number;
  /** Whole logical-task counters. They never reset at Context Epoch boundaries. */
  runBudget?: LogicalRunBudgetState;
  retries: number;
  lastNetworkAt?: string;
  lastEventAt?: string;
  lastContentAt?: string;
  lastStepAt?: string;
  updatedAt: string;
  /** Exact original projection input; credentials and runtime handles excluded. */
  request: Omit<AgentRequest, 'sourceConfig' | 'signal' | 'checkpoint' | 'taskClock' | 'taskCostBudget'>;
  source: { sourceId: string; modelId: string; provider: string; endpointHash: string };
  workspaceFolders: string[];
  requestStartedAt?: string;
  finalResponse?: import('../shared/types').AgentResponse;
  toolSchemaHash?: string;
  modelStepRetries?: number;
  taskPlan?: import('../shared/types').TaskPlan;
  delegationBudget?: import('./subagents/types').SubagentTreeBudget;
  state?: {
    continuation?: { content: string; finishReason?: string | null; requests: number; inFlight: boolean };
    completedReplay?: import('../shared/types').ProviderReplayState;
    messages: DeepSeekMessage[];
    provider?: ProviderNativeRunState;
    toolRounds: AgentToolRound[];
    draftEdits: DraftEdit[];
    draftRuns: DraftRunProposal[];
    reasoningParts: string[];
    turn: number;
    toolCallCount: number;
    validationRunCount: number;
    toolResultTokens: number;
    validationState?: import('./repairLoop').RunValidationState;
    repairLoop: RepairLoopState;
    /** V2 internal Provider context segmentation. Legacy checkpoints omit it. */
    epoch?: ContextEpochState;
    budgetStopReason?: LegacyCapacityFinishReason;
    budgetStopInstructionQueued?: boolean;
    /** Complete response plus individual completed tool results. Never a delta. */
    pending?: {
      response: { message: DeepSeekAssistantMessage; finishReason?: string | null; usage?: DeepSeekUsage | null };
      results: Record<string, string>;
      executing?: { id: string; name: string; evidenceRef?: string };
    };
  };
}

export class AgentInterruptedError extends Error {
  public constructor(public readonly reason: StopReason, message: string) { super(message); }
}

export const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
export function endpointHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function createRunCheckpoint(
  request: AgentRequest,
  maxExecutionMs: number,
  source: string,
  workspaceFolders: string[],
  maxCost = 0
): RunCheckpoint {
  const sourceConfig = request.sourceConfig;
  const input = { ...request };
  delete input.sourceConfig;
  delete input.signal;
  delete input.checkpoint;
  delete input.taskClock;
  delete input.taskCostBudget;
  delete input.taskRunBudget;
  input.history = input.history.map(({ runCheckpoint: _cp, ...message }) => message);
  return {
    version: 2, taskId: randomUUID(), attempt: 0, attemptIds: [], status: 'running', usedMs: 0,
    maxExecutionMs, usedCostByCurrency: {}, maxCost, limitSource: source, modelRequests: 0, retries: 0, updatedAt: new Date().toISOString(),
    request: structuredClone(input),
    source: { sourceId: sourceConfig?.sourceId ?? request.model.sourceId ?? '', modelId: request.model.id,
      provider: sourceConfig?.provider ?? request.model.provider ?? '', endpointHash: endpointHash(sourceConfig?.baseUrl ?? '') },
    workspaceFolders
  };
}

export function checkpointCopy(checkpoint: RunCheckpoint): RunCheckpoint {
  const serialized = JSON.stringify(checkpoint);
  if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint resource limit (32 MiB) / 检查点资源上限（32 MiB）');
  return JSON.parse(serialized) as RunCheckpoint;
}

/** Fail closed on unknown versions or incomplete execution records. Keep errors
 * visible through the message; no malformed object may authorize a tool. */
export function normalizeRunCheckpoint(value: unknown): RunCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const cp = value as RunCheckpoint;
  try {
    if ((cp.version !== 1 && cp.version !== 2) || !cp.taskId || !cp.request?.model?.id || !Array.isArray(cp.request.history)
      || !cp.source?.endpointHash || !Array.isArray(cp.workspaceFolders)
      || !Array.isArray(cp.attemptIds) || !Number.isFinite(cp.usedMs) || cp.usedMs < 0
      || !Number.isFinite(cp.maxExecutionMs) || cp.maxExecutionMs < 0) return undefined;
    if (cp.maxCost !== undefined && (!Number.isFinite(cp.maxCost) || cp.maxCost < 0)) return undefined;
    if (cp.usedCostByCurrency !== undefined && (!cp.usedCostByCurrency || typeof cp.usedCostByCurrency !== 'object'
      || Array.isArray(cp.usedCostByCurrency) || Object.entries(cp.usedCostByCurrency).some(([currency, cost]) =>
        !currency || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0))) return undefined;
    if (![cp.attempt, cp.modelRequests, cp.retries].every((value) => Number.isSafeInteger(value) && value >= 0)
      || cp.request.model.id !== cp.source.modelId) return undefined;
    if (cp.state && (![cp.state.toolCallCount, cp.state.validationRunCount, cp.state.toolResultTokens].every((value) => Number.isFinite(value) && value >= 0)
      || !Array.isArray(cp.state.messages) || !Array.isArray(cp.state.toolRounds)
      || !Array.isArray(cp.state.draftEdits) || !Array.isArray(cp.state.draftRuns)
      || !Number.isInteger(cp.state.turn) || cp.state.turn < 0)) return undefined;
    if (cp.state?.pending) {
      const pending = cp.state.pending;
      if (!pending.response?.message || !pending.results || typeof pending.results !== 'object'
        || Array.isArray(pending.results) || !Object.values(pending.results).every((result) => typeof result === 'string')) return undefined;
      for (const call of pending.response.message.tool_calls ?? []) {
        if (!call.id || !call.function?.name || typeof call.function.arguments !== 'string') return undefined;
        const args: unknown = JSON.parse(call.function.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
      }
    }
    const copy = checkpointCopy(cp);
    copy.version = 2;
    copy.request.executionMode = normalizeExecutionMode(copy.request.executionMode);
    copy.maxCost ??= 0;
    copy.usedCostByCurrency ??= {};
    const hasSerializedRunBudget = Object.prototype.hasOwnProperty.call(copy, 'runBudget');
    if (hasSerializedRunBudget && (!copy.runBudget || typeof copy.runBudget !== 'object'
      || Array.isArray(copy.runBudget))) return undefined;
    const legacyCapacityStop = !hasSerializedRunBudget && (copy.stopReason === 'budget_exhausted'
      || copy.state?.budgetStopReason || copy.finalResponse?.runDetails.budgetStopReason);
    if (hasSerializedRunBudget) {
      copy.runBudget = createLogicalRunBudgetState(copy.runBudget);
      copy.modelRequests = copy.runBudget.modelRequests;
    } else if (!legacyCapacityStop) {
      copy.runBudget = createLogicalRunBudgetState({
        modelRequests: copy.modelRequests,
        toolRounds: copy.state?.turn ?? 0,
        toolCalls: copy.state?.toolCallCount ?? 0,
        continuations: copy.state?.continuation?.requests ?? 0,
        contextEpochRollovers: copy.state?.epoch?.totalRollovers ?? 0,
        usedMs: copy.usedMs,
        treeUpstreamTokens: 0
      });
      copy.modelRequests = copy.runBudget.modelRequests;
    }
    if (copy.state?.epoch?.calibration) {
      const declaredWindowTokens = getEffectiveContextWindowTokens(copy.request.model);
      copy.state.epoch.calibration = migrateContextWindowCalibrationState(
        copy.state.epoch.calibration,
        declaredWindowTokens,
        {
          identity: getCanonicalModelIdentity(copy.request.model.id),
          version: `${DEEPSEEK_MODEL_IDENTITY_VERSION}:${declaredWindowTokens}`
        }
      ).state;
    }
    if (copy.status === 'running') {
      copy.status = 'interrupted'; copy.stopReason = 'extension_restart';
      if (copy.taskPlan) copy.taskPlan.status = 'stopped';
    }
    return copy;
  } catch { return undefined; }
}

export function recoveryBlocker(cp: RunCheckpoint): string | undefined {
  if (cp.stopReason === 'storage_failure' || cp.stopReason === 'resource_limit') return cp.error ?? cp.stopReason;
  if (cp.status === 'completed') return 'Task already completed / 任务已完成';
  if (cp.maxExecutionMs > 0 && cp.usedMs >= cp.maxExecutionMs) return 'Time budget exhausted / 时间预算已用尽';
  if (isCostLimitExhausted(cp)) {
    return 'Configured Provider cost limit reached / 已达到用户配置的 Provider 费用上限';
  }
  if (cp.stopReason === 'budget_exhausted' && cp.runBudget) {
    return cp.error ?? 'Logical run budget exhausted / 逻辑任务预算已用尽';
  }
  // Legacy capacity stops are migrated to a Context Epoch by the runner. They
  // are not user-action blockers and must never require a synthetic new turn.
  if (cp.stopReason === 'budget_exhausted' || cp.state?.budgetStopReason || cp.finalResponse?.runDetails.budgetStopReason) return undefined;
  return undefined;
}

export function isCostLimitExhausted(cp: Pick<RunCheckpoint, 'maxCost' | 'usedCostByCurrency'>): boolean {
  const limit = cp.maxCost ?? 0;
  return limit > 0 && Object.values(cp.usedCostByCurrency ?? {}).some((cost) => cost >= limit);
}

export function migrateLegacyCapacityCheckpoint(cp: RunCheckpoint): RunCheckpoint {
  const copy = checkpointCopy(cp);
  if (copy.runBudget) return copy;
  if (!copy.state?.budgetStopReason && !copy.finalResponse?.runDetails.budgetStopReason && copy.stopReason !== 'budget_exhausted') return copy;
  copy.version = 2;
  copy.status = 'interrupted';
  copy.stopReason = 'extension_restart';
  copy.error = undefined;
  copy.finalResponse = undefined;
  if (copy.state) {
    copy.state.budgetStopReason = undefined;
    copy.state.budgetStopInstructionQueued = false;
  }
  return copy;
}
