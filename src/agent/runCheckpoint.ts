import { OUTPUT_BUDGET_POLICY_VERSION } from '../shared/outputBudget';
import { normalizeRequestBudget, type RequestBudgetSnapshot } from './requestBudget';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentRequest, AgentToolRound, DraftEdit, DraftRunProposal, RepairLoopState } from '../shared/types';
import type { DeepSeekAssistantMessage, DeepSeekMessage, DeepSeekUsage } from './deepseek/types';
import type { ProviderNativeRunState } from './runner';
import type { ContextEpochState } from './contextEpoch';
import { getEffectiveContextWindowTokens } from '../shared/modelProfiles';
import { DEEPSEEK_MODEL_IDENTITY_VERSION, getCanonicalModelIdentity } from '../shared/deepSeekModels';
import { migrateContextWindowCalibrationState } from './toolResultAdmission';
import { normalizeExecutionMode } from './executionMode';
import { createLogicalRunBudgetState, grantNextToolBudgetSegment, type LogicalRunBudgetState } from './executionPolicy';

export type StopReason = 'user_stop' | 'time_budget' | 'tool_timeout' | 'connection_interrupted'
  | 'provider_error' | 'extension_restart' | 'waiting_for_user' | 'budget_pause' | 'budget_exhausted' | 'completed' | 'storage_failure' | 'resource_limit'
  | 'output_truncated' | 'cost_limit' | 'no_progress_loop' | 'uncertain_tool_result';

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
  /** Physical dispatches for the uncommitted model round; survives Continue/restart. */
  modelStepAttempts?: number;
  /** Small integrity metadata only; the live transport owns frozen request bytes. */
  modelStepRequestHash?: string;
  outputBudgetPolicyVersion?: number;
  exactRecoveryBlocked?: boolean;
  lastRequestBudget?: RequestBudgetSnapshot;
  modelStepGenerationStrategy?: 'small_tools';
  outputFailure?: {
    kind: 'tool_output_truncated'; finishReason: 'length' | 'max_output_tokens' | 'max_tokens';
    toolIntegrity: 'incomplete'; toolsExecuted: 0; requestHash: string; requestId: string;
    budget: RequestBudgetSnapshot;
  };
  outputBudgetMigrations?: Array<{
    reason: 'larger_budget' | 'smaller_tool_calls'; oldPolicy: number; newPolicy: number;
    oldRequestHash: string; newRequestHash: string; oldOutputTokens: number; newOutputTokens: number;
  }>;
  taskPlan?: import('../shared/types').TaskPlan;
  delegationBudget?: import('./subagents/types').SubagentTreeBudget;
  state?: {
    continuation?: { content: string; lastSegment?: string; finishReason?: string | null; requests: number; inFlight: boolean };
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
    outputBudgetPolicyVersion: OUTPUT_BUDGET_POLICY_VERSION,
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
    if (cp.modelStepRetries !== undefined && (!Number.isSafeInteger(cp.modelStepRetries) || cp.modelStepRetries < 0 || cp.modelStepRetries > 5)) return undefined;
    if (cp.modelStepAttempts !== undefined && (!Number.isSafeInteger(cp.modelStepAttempts) || cp.modelStepAttempts < 0 || cp.modelStepAttempts > 6)) return undefined;
    if (cp.modelStepAttempts !== undefined && cp.modelStepRetries !== undefined
      && cp.modelStepRetries > Math.max(0, cp.modelStepAttempts - 1)) return undefined;
    if (cp.modelStepRequestHash !== undefined && !/^[a-f0-9]{64}$/u.test(cp.modelStepRequestHash)) return undefined;
    if (cp.state && (![cp.state.toolCallCount, cp.state.validationRunCount, cp.state.toolResultTokens].every((value) => Number.isFinite(value) && value >= 0)
      || !Array.isArray(cp.state.messages) || !Array.isArray(cp.state.toolRounds)
      || !Array.isArray(cp.state.draftEdits) || !Array.isArray(cp.state.draftRuns)
      || !Number.isInteger(cp.state.turn) || cp.state.turn < 0)) return undefined;
    if (cp.state?.continuation && (typeof cp.state.continuation.content !== 'string'
      || (cp.state.continuation.lastSegment !== undefined && typeof cp.state.continuation.lastSegment !== 'string')
      || typeof cp.state.continuation.inFlight !== 'boolean'
      || !Number.isSafeInteger(cp.state.continuation.requests) || cp.state.continuation.requests < 0)) return undefined;
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
    if (cp.exactRecoveryBlocked !== undefined && typeof cp.exactRecoveryBlocked !== 'boolean') return undefined;
    if (cp.outputBudgetPolicyVersion !== undefined && ![1, OUTPUT_BUDGET_POLICY_VERSION].includes(cp.outputBudgetPolicyVersion)) return undefined;
    if (cp.lastRequestBudget && !normalizeRequestBudget(cp.lastRequestBudget)) return undefined;
    if (cp.modelStepGenerationStrategy !== undefined && cp.modelStepGenerationStrategy !== 'small_tools') return undefined;
    if (cp.outputFailure) {
      const failure = cp.outputFailure;
      if (failure.kind !== 'tool_output_truncated' || failure.toolIntegrity !== 'incomplete' || failure.toolsExecuted !== 0
        || !['length', 'max_output_tokens', 'max_tokens'].includes(failure.finishReason)
        || !/^[a-f0-9]{64}$/u.test(failure.requestHash) || typeof failure.requestId !== 'string'
        || failure.requestId.length > 256 || !normalizeRequestBudget(failure.budget)
        || failure.budget.sourceId !== cp.source.sourceId || failure.budget.modelId !== cp.source.modelId
        || failure.budget.endpointHash !== cp.source.endpointHash || !cp.state || cp.state.pending
        || failure.requestHash !== cp.modelStepRequestHash) return undefined;
    }
    if (cp.outputBudgetMigrations && (!Array.isArray(cp.outputBudgetMigrations) || cp.outputBudgetMigrations.length > 32
      || cp.outputBudgetMigrations.some((m) => !['larger_budget', 'smaller_tool_calls'].includes(m.reason)
        || ![1, 2].includes(m.oldPolicy) || m.newPolicy !== OUTPUT_BUDGET_POLICY_VERSION
        || !/^[a-f0-9]{64}$/u.test(m.oldRequestHash) || !/^[a-f0-9]{64}$/u.test(m.newRequestHash)
        || ![m.oldOutputTokens, m.newOutputTokens].every((n) => Number.isSafeInteger(n) && n > 0)))) return undefined;
    const copy = checkpointCopy(cp);
    // Older retries counted scheduled waits. Conservatively retain the spent
    // allowance rather than granting a fresh six requests after recovery.
    copy.modelStepAttempts ??= copy.modelStepRetries ? copy.modelStepRetries + 1 : 0;
    copy.modelStepRetries = Math.max(0, copy.modelStepAttempts - 1);
    copy.version = 2;
    copy.outputBudgetPolicyVersion ??= 1;
    if (copy.lastRequestBudget) copy.lastRequestBudget = normalizeRequestBudget(copy.lastRequestBudget);
    if (copy.outputFailure) copy.outputFailure = {
      kind: 'tool_output_truncated', finishReason: copy.outputFailure.finishReason, toolIntegrity: 'incomplete', toolsExecuted: 0,
      requestHash: copy.outputFailure.requestHash, requestId: copy.outputFailure.requestId,
      budget: normalizeRequestBudget(copy.outputFailure.budget)!
    };
    if (copy.outputBudgetMigrations) copy.outputBudgetMigrations = copy.outputBudgetMigrations.map((m) => ({
      reason: m.reason, oldPolicy: m.oldPolicy, newPolicy: m.newPolicy, oldRequestHash: m.oldRequestHash,
      newRequestHash: m.newRequestHash, oldOutputTokens: m.oldOutputTokens, newOutputTokens: m.newOutputTokens
    }));
    copy.request.executionMode = normalizeExecutionMode(copy.request.executionMode);
    copy.maxCost ??= 0;
    copy.usedCostByCurrency ??= {};
    const hasSerializedRunBudget = Object.prototype.hasOwnProperty.call(copy, 'runBudget');
    if (hasSerializedRunBudget && (!copy.runBudget || typeof copy.runBudget !== 'object'
      || Array.isArray(copy.runBudget))) return undefined;
    const legacyCapacityStop = !hasSerializedRunBudget && (copy.stopReason === 'budget_exhausted'
      || copy.state?.budgetStopReason || copy.finalResponse?.runDetails.budgetStopReason);
    const legacyToolBudgetStop = legacyCapacityStop && isToolBudgetReason(readBudgetStopReason(copy));
    if (hasSerializedRunBudget) {
      copy.runBudget = createLogicalRunBudgetState(copy.runBudget);
      copy.modelRequests = copy.runBudget.modelRequests;
      if (isToolBudgetReason(readBudgetStopReason(copy))
        && copy.finalResponse?.runDetails.budgetPause?.resumable !== true
        && !copy.request.subagentContext) {
        // Pre-segment checkpoints could only have received these root limits
        // from the old model profile. Do not perpetuate that implicit ceiling.
        copy.request.executionLimits = {
          ...copy.request.executionLimits,
          maxToolIterations: 0,
          maxToolCalls: 0
        };
      }
    } else if (!legacyCapacityStop || legacyToolBudgetStop) {
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
      if (legacyToolBudgetStop && !copy.request.subagentContext) {
        copy.request.executionLimits = {
          ...copy.request.executionLimits,
          maxToolIterations: 0,
          maxToolCalls: 0
        };
      }
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
    if (isResumableToolBudgetCheckpoint(copy)) {
      copy.status = 'interrupted';
      copy.stopReason = 'budget_pause';
    }
    return copy;
  } catch { return undefined; }
}

export function recoveryBlocker(cp: RunCheckpoint, currentModel?: AgentRequest['model']): string | undefined {
  if (cp.stopReason === 'storage_failure' || cp.stopReason === 'resource_limit') return cp.error ?? cp.stopReason;
  if (cp.status === 'completed') return 'Task already completed / 任务已完成';
  if (cp.maxExecutionMs > 0 && cp.usedMs >= cp.maxExecutionMs) return 'Time budget exhausted / 时间预算已用尽';
  if (isCostLimitExhausted(cp)) {
    return 'Configured Provider cost limit reached / 已达到用户配置的 Provider 费用上限';
  }
  if (cp.outputFailure) {
    if ((cp.modelStepAttempts ?? 0) >= 6) return 'Model-round request allowance exhausted; send a new user message requesting smaller complete edits / 当前模型轮请求次数已用尽，请发送新消息要求分小步生成完整修改。';
    if (cp.modelStepGenerationStrategy === 'small_tools'
      && ((currentModel?.sourceId === cp.source.sourceId && currentModel.id === cp.source.modelId ? currentModel.maxOutputTokens : cp.request.model.maxOutputTokens) ?? cp.outputFailure.budget.modelMaxOutputTokens) <= cp.outputFailure.budget.modelMaxOutputTokens) {
      return 'Output limit reached again after task decomposition; send a new message with a smaller scope / 分解生成后仍达到输出上限，请发送新消息缩小本步范围；无需删除会话。';
    }
  }
  if (cp.exactRecoveryBlocked) return 'The frozen request changed; preserve history and send a new user message / 冻结请求已变化，请保留会话并发送新用户消息开始新的请求边界。';
  if ((cp.outputBudgetPolicyVersion ?? 1) < OUTPUT_BUDGET_POLICY_VERSION
    && !cp.outputFailure && !cp.state?.pending && /Incomplete tool|工具响应未完成/iu.test(cp.error ?? '')) {
    return 'Legacy interrupted request has no structured output-truncation evidence; preserve history and send a new user message / 旧中断请求缺少结构化长度截断证据，请保留会话并发送新用户消息开始新的请求边界。';
  }
  if (isResumableToolBudgetCheckpoint(cp)) return undefined;
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
  if (copy.runBudget) {
    if (isResumableToolBudgetCheckpoint(copy)) {
      copy.status = 'interrupted';
      copy.stopReason = 'budget_pause';
      if (copy.finalResponse?.runDetails.budgetPause?.resumable !== true
        && !copy.request.subagentContext) {
        copy.request.executionLimits = {
          ...copy.request.executionLimits,
          maxToolIterations: 0,
          maxToolCalls: 0
        };
      }
    }
    return copy;
  }
  const legacyToolBudgetStop = isToolBudgetReason(readBudgetStopReason(copy));
  if (legacyToolBudgetStop) {
    copy.runBudget = createLogicalRunBudgetState({
      modelRequests: copy.modelRequests,
      toolRounds: copy.state?.turn ?? 0,
      toolCalls: copy.state?.toolCallCount ?? 0,
      continuations: copy.state?.continuation?.requests ?? 0,
      contextEpochRollovers: copy.state?.epoch?.totalRollovers ?? 0,
      usedMs: copy.usedMs
    });
    if (!copy.request.subagentContext) {
      copy.request.executionLimits = {
        ...copy.request.executionLimits,
        maxToolIterations: 0,
        maxToolCalls: 0
      };
    }
  }
  if (!copy.state?.budgetStopReason && !copy.finalResponse?.runDetails.budgetStopReason
    && copy.stopReason !== 'budget_exhausted' && copy.stopReason !== 'budget_pause') return copy;
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

export function isResumableToolBudgetCheckpoint(cp: RunCheckpoint): boolean {
  if (cp.stopReason === 'budget_pause' || cp.finalResponse?.runDetails.budgetPause?.resumable === true) return true;
  return cp.stopReason === 'budget_exhausted' && isToolBudgetReason(readBudgetStopReason(cp));
}

function readBudgetStopReason(cp: RunCheckpoint): string | undefined {
  return cp.state?.budgetStopReason ?? cp.finalResponse?.runDetails.budgetStopReason;
}

function isToolBudgetReason(reason: string | undefined): boolean {
  return typeof reason === 'string'
    && /^(?:tool_budget_exhausted|tool_round_budget_exhausted|tool_call_budget_exhausted|tool_iterations_exhausted|tool_call_limit_exhausted|tool_result_budget_exhausted)$/u.test(reason);
}

/** Called only for the real Continue UI action. It grants another finite tool
 * segment while preserving task identity, evidence, aggregate usage and all
 * idempotency/approval state. */
export function grantCheckpointToolBudgetSegment(cp: RunCheckpoint): RunCheckpoint {
  const copy = checkpointCopy(cp);
  if (!isResumableToolBudgetCheckpoint(copy) || !copy.runBudget) return copy;
  copy.runBudget = grantNextToolBudgetSegment(copy.runBudget);
  copy.modelRequests = copy.runBudget.modelRequests;
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
