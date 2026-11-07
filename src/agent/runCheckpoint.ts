import { OUTPUT_BUDGET_POLICY_VERSION } from '../shared/outputBudget';
import { normalizeRequestBudget, type RequestBudgetSnapshot } from './requestBudget';
import { createHash, randomUUID } from 'node:crypto';
import type { ActivatedSkill, AgentRequest, AgentToolRound, DraftEdit, DraftRunProposal, RepairLoopState } from '../shared/types';
import type { DeepSeekAssistantMessage, DeepSeekMessage, DeepSeekUsage } from './deepseek/types';
import type { ProviderNativeRunState } from './runner';
import { validEpochProgressState, type ContextEpochState } from './contextEpoch';
import { getEffectiveContextWindowTokens } from '../shared/modelProfiles';
import { DEEPSEEK_MODEL_IDENTITY_VERSION, getCanonicalModelIdentity } from '../shared/deepSeekModels';
import { migrateContextWindowCalibrationState } from './toolResultAdmission';
import { normalizeExecutionMode } from './executionMode';
import { createLogicalRunBudgetState, grantNextToolBudgetSegment, normalizeLogicalRunBudgetLimits, type LogicalRunBudgetState } from './executionPolicy';
import { normalizeSubagentHostContext } from './subagents/contextCapsule';
import { normalizeDelegationState } from './delegation';
import { normalizeProjectRouterRole } from './taskRouter';
import { validTaskContinuationState, validTaskEpoch } from '../sessions/userTaskBudget';
import { normalizeCodexPluginSnapshot, normalizeCodexPluginTraversalState, type CodexPluginSnapshot,
  type CodexPluginTraversalState } from '../skills/codexPluginResources';

/** Latest durable traversal for one pinned plugin entry. */
export interface PluginSkillProgress {
  skillId: string;
  progress: CodexPluginTraversalState;
}

export type StopReason = 'user_stop' | 'time_budget' | 'tool_timeout' | 'connection_interrupted'
  | 'provider_error' | 'extension_restart' | 'waiting_for_user' | 'budget_pause' | 'budget_exhausted' | 'completed' | 'storage_failure' | 'resource_limit'
  | 'output_truncated' | 'cost_limit' | 'no_progress_loop' | 'uncertain_tool_result' | 'supplement_boundary';

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
  budgetLimits?: import('./executionPolicy').LogicalRunBudgetLimits;
  retries: number;
  /** Finite correction ledger inherited by every segment and epoch in a task. */
  commandRecoveryKeys?: string[];
  commandRecoveryExhausted?: boolean;
  /** Same response siblings count as one observation; persisted for interrupted delivery. */
  commandRecoveryBatch?: { id: string; keys: string[] };
  lastNetworkAt?: string;
  lastEventAt?: string;
  lastContentAt?: string;
  lastStepAt?: string;
  updatedAt: string;
  /** Exact original projection input; credentials and runtime handles excluded. */
  request: Omit<AgentRequest, 'sourceConfig' | 'signal' | 'checkpoint' | 'taskClock' | 'taskCostBudget'
    | 'taskRunBudget' | 'taskRouter' | 'taskRouterContext' | 'hasPendingSupplement'>;
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
  /** Same-root project continuation state, without copying a prior transcript. */
  inheritedEpoch?: ContextEpochState;
  /** Same-root semantic guards; never prior assistant/tool replay or permits. */
  continuationState?: {
    validationState?: import('./repairLoop').RunValidationState;
    validationRunCount: number;
    repairLoop: RepairLoopState;
  };
  pluginSkillProgress?: PluginSkillProgress[];
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
  delete input.taskRouter;
  delete input.taskRouterContext;
  delete input.hasPendingSupplement;
  input.history = input.history.map(({ runCheckpoint: _cp, runCheckpointArchive: _archive, ...message }) => message);
  return {
    outputBudgetPolicyVersion: OUTPUT_BUDGET_POLICY_VERSION,
    version: 2, taskId: request.projectTaskIdentity?.segmentId ?? randomUUID(), attempt: 0, attemptIds: [], status: 'running', usedMs: 0,
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
    if (cp.budgetLimits !== undefined && !normalizeLogicalRunBudgetLimits(cp.budgetLimits)) return undefined;
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
    if (cp.commandRecoveryKeys !== undefined && (!Array.isArray(cp.commandRecoveryKeys)
      || cp.commandRecoveryKeys.length > 2 || cp.commandRecoveryKeys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)))) return undefined;
    if (cp.commandRecoveryBatch !== undefined && (!cp.commandRecoveryBatch || !/^[a-f0-9]{64}$/u.test(cp.commandRecoveryBatch.id)
      || !Array.isArray(cp.commandRecoveryBatch.keys) || cp.commandRecoveryBatch.keys.length > 2
      || cp.commandRecoveryBatch.keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)))) return undefined;
    if (cp.commandRecoveryExhausted !== undefined && typeof cp.commandRecoveryExhausted !== 'boolean') return undefined;
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
    if (cp.state?.epoch && !validEpochProgressState(cp.state.epoch)) return undefined;
    const copy = checkpointCopy(cp);
    copy.request.agentRole = normalizeProjectRouterRole(copy.request.agentRole);
    if (copy.request.projectTaskIdentity !== undefined) {
      const identity = copy.request.projectTaskIdentity;
      if (!identity || !['projectId', 'taskCardId', 'rootTaskId', 'segmentId'].every(key => {
        const value = identity[key as 'projectId' | 'taskCardId' | 'rootTaskId' | 'segmentId'];
        return typeof value === 'string' && !!value && value.length <= 256;
      }) || !Number.isSafeInteger(identity.generation) || identity.generation < 1
        || identity.segmentId !== copy.taskId) return undefined;
    }
    if (copy.inheritedEpoch && (!copy.request.projectTaskIdentity || !validTaskEpoch(copy.inheritedEpoch))) return undefined;
    if (copy.continuationState && (!copy.request.projectTaskIdentity || !validTaskContinuationState(copy.continuationState))) return undefined;
    if (!normalizeCheckpointPluginSkills(copy)) return undefined;
    copy.budgetLimits = normalizeLogicalRunBudgetLimits(copy.budgetLimits);
    if (copy.request.subagentHostContext !== undefined) {
      const context = normalizeSubagentHostContext(copy.request.subagentHostContext);
      if (!context) return undefined;
      copy.request.subagentHostContext = context;
    }
    if (copy.taskPlan?.delegation !== undefined) {
      const delegation = normalizeDelegationState(copy.taskPlan.delegation);
      if (!delegation) return undefined;
      copy.taskPlan.delegation = delegation;
    }
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

export function getCheckpointPluginSnapshot(checkpoint: RunCheckpoint, skill: ActivatedSkill): CodexPluginSnapshot | undefined {
  const snapshot = skill.pluginSnapshot;
  if (!snapshot || skill.source !== 'codexPlugin' || skill.activation?.source !== 'explicit' || skill.runAs) return undefined;
  const progress = checkpoint.pluginSkillProgress?.find(item => item.skillId === skill.id)?.progress;
  return progress ? { ...snapshot, progress } : snapshot;
}

/** Apply an evidence receipt only to the frozen entry that authorized the read. */
export function restorePluginSkillProgress(checkpoint: RunCheckpoint, receipt: PluginSkillProgress): void {
  const skill = checkpoint.request.currentRunContext?.skills.find(item => item.id === receipt.skillId);
  const snapshot = skill && getCheckpointPluginSnapshot(checkpoint, skill);
  const progress = snapshot && normalizeCodexPluginTraversalState(receipt.progress, snapshot);
  const current = snapshot?.progress;
  const invalidReceipt = 'Invalid Codex plugin read receipt / Codex 插件读取凭据无效';
  if (!progress || !current) throw new Error(invalidReceipt);
  if (progress.reads <= current.reads && progress.seen.every((item, index) => item === current.seen[index])) return;
  if (progress.reads !== current.reads + 1 || progress.bytes < current.bytes
    || !current.seen.every((item, index) => item === progress.seen[index])) throw new Error(invalidReceipt);
  checkpoint.pluginSkillProgress = [
    ...(checkpoint.pluginSkillProgress ?? []).filter(item => item.skillId !== receipt.skillId),
    { skillId: receipt.skillId, progress }
  ];
}

function normalizeCheckpointPluginSkills(checkpoint: RunCheckpoint): boolean {
  const skills = checkpoint.request.currentRunContext?.skills ?? [];
  if (!Array.isArray(skills)) return false;
  const pluginIds = new Set<string>();
  for (const skill of skills) {
    if (skill.source !== 'codexPlugin' && skill.pluginSnapshot === undefined && skill.pluginPolicyCwd === undefined) continue;
    if (!skill.pluginSnapshot || skill.source !== 'codexPlugin' || skill.activation?.source !== 'explicit' || skill.runAs
      || typeof skill.id !== 'string' || !skill.id || pluginIds.has(skill.id)
      || (skill.pluginPolicyCwd !== undefined && (typeof skill.pluginPolicyCwd !== 'string' || new URL(skill.pluginPolicyCwd).protocol !== 'file:'))) return false;
    const normalized = normalizeCodexPluginSnapshot(skill.pluginSnapshot);
    if (!normalized) return false;
    skill.pluginSnapshot = normalized;
    pluginIds.add(skill.id);
  }
  const receipts = checkpoint.pluginSkillProgress;
  if (receipts === undefined) return true;
  if (!Array.isArray(receipts) || receipts.length > pluginIds.size) return false;
  const normalizedReceipts: PluginSkillProgress[] = [];
  for (const receipt of receipts) {
    if (!receipt || !pluginIds.delete(receipt.skillId)) return false;
    const snapshot = skills.find(skill => skill.id === receipt.skillId)?.pluginSnapshot;
    const progress = snapshot && normalizeCodexPluginTraversalState(receipt.progress, snapshot);
    if (!snapshot || !progress || progress.reads < snapshot.progress.reads || progress.bytes < snapshot.progress.bytes
      || !snapshot.progress.seen.every((item, index) => item === progress.seen[index])) return false;
    normalizedReceipts.push({ skillId: receipt.skillId, progress });
  }
  checkpoint.pluginSkillProgress = normalizedReceipts;
  return true;
}

export function recoveryBlocker(cp: RunCheckpoint, currentModel?: AgentRequest['model']): string | undefined {
  if (cp.request.subagentContext && !normalizeSubagentHostContext(cp.request.subagentHostContext)) {
    return 'Child recovery lacks a valid controlled project/profile context; preserve the audit record and start a fresh delegation / 子任务恢复缺少有效项目与 Profile 继承证明，请保留审计记录并重新委派。';
  }
  if (cp.stopReason === 'no_progress_loop') return 'No-progress state is preserved. Provide new evidence, a changed scope or an explicit new instruction / 无进展状态已保留，请补充新证据、调整范围或发送新的明确指令。';
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

/** A real, persisted user turn may reopen a stopped task, but cannot grant a
 * fresh budget or forget the no-progress window. Ordinary Continue stays blocked.
 * Caller must have checked workspace trust and current external grants. */
export function recoverNoProgressWithUserTurn(cp: RunCheckpoint, request: AgentRequest,
  workspaceFolders: readonly string[]): RunCheckpoint {
  const user = request.history.at(-1);
  if (cp.stopReason !== 'no_progress_loop' || !cp.state || cp.state.pending || cp.state.continuation
    || !user || user.role !== 'user' || !(user.expandedContent ?? user.content).trim()
    || cp.request.history.some(message => message.id === user.id)) throw new Error('A new persisted user turn is required for no-progress recovery');
  const source = request.sourceConfig;
  if (!source || source.sourceId !== cp.source.sourceId || source.provider !== cp.source.provider
    || endpointHash(source.baseUrl) !== cp.source.endpointHash || request.model.id !== cp.source.modelId
    || JSON.stringify(request.model) !== JSON.stringify(cp.request.model)
    || normalizeExecutionMode(request.executionMode) !== normalizeExecutionMode(cp.request.executionMode)
    || request.contextInstructions !== cp.request.contextInstructions
    || JSON.stringify(workspaceFolders) !== JSON.stringify(cp.workspaceFolders)
    || cp.request.authorizedExternalReferenceUris?.some(uri => !request.authorizedExternalReferenceUris?.includes(uri))) {
    throw new Error('No-progress recovery context changed; restore the original model, workspace and permissions');
  }
  const copy = checkpointCopy(cp);
  copy.stopReason = undefined;
  const blocker = recoveryBlocker(copy, request.model);
  if (blocker) throw new Error(blocker);
  const content = user.providerContent ?? (user.expandedContent ?? user.content).trim();
  copy.request = createRunCheckpoint(request, cp.maxExecutionMs, cp.limitSource, cp.workspaceFolders, cp.maxCost).request;
  copy.request.executionLimits = structuredClone(cp.request.executionLimits);
  copy.request.approvalRootTaskId = cp.request.approvalRootTaskId;
  copy.status = 'interrupted'; copy.error = undefined; copy.finalResponse = undefined;
  copy.state!.messages.push({ role: 'user', content });
  const native = copy.state!.provider;
  if (native?.protocol === 'openai-responses') {
    native.input.push({ role: 'user', content }); native.replayItems = [];
  } else if (native?.protocol === 'anthropic-messages') {
    native.messages.push({ role: 'user', content: [{ type: 'text', text: content }] }); native.replayMessages = [];
  }
  // Old rounds stay in the preceding assistant's immutable audit. The next
  // assistant publishes only its new rounds; execution counters remain cumulative.
  copy.state!.toolRounds = []; copy.state!.completedReplay = undefined; copy.state!.reasoningParts = [];
  copy.updatedAt = new Date().toISOString();
  return copy;
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

/** A host continuation inherits safety counters, never prior tool state or approvals. */
export function inheritTaskBudget(cp: RunCheckpoint, budget: import('../sessions/userTaskBudget').UserTaskBudget): void {
  cp.commandRecoveryKeys = budget.commandRecoveryKeys?.slice();
  cp.commandRecoveryExhausted = budget.commandRecoveryExhausted;
  cp.usedMs = budget.usedMs;
  cp.maxExecutionMs = budget.maxExecutionMs;
  cp.maxCost = budget.maxCost;
  cp.usedCostByCurrency = { ...budget.usedCostByCurrency };
  cp.budgetLimits = budget.budgetLimits ? { ...budget.budgetLimits } : undefined;
  cp.runBudget = budget.runBudget ? createLogicalRunBudgetState(budget.runBudget) : undefined;
  cp.modelRequests = cp.runBudget?.modelRequests ?? 0;
  cp.delegationBudget = budget.delegationBudget ? structuredClone(budget.delegationBudget) : undefined;
  if (cp.request.projectTaskIdentity && budget.epoch) cp.inheritedEpoch = structuredClone(budget.epoch);
  if (cp.request.projectTaskIdentity && budget.continuationState) cp.continuationState = structuredClone(budget.continuationState);
}
