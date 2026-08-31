import { createHash, randomUUID } from 'node:crypto';
import type { AgentRequest, AgentToolRound, DraftEdit, DraftRunProposal, RepairLoopState } from '../shared/types';
import type { DeepSeekAssistantMessage, DeepSeekMessage, DeepSeekUsage } from './deepseek/types';
import type { ProviderNativeRunState } from './runner';

export type StopReason = 'user_stop' | 'time_budget' | 'tool_timeout' | 'connection_interrupted'
  | 'provider_error' | 'extension_restart' | 'waiting_for_user' | 'completed' | 'storage_failure' | 'resource_limit';

export interface RunCheckpoint {
  version: 1;
  taskId: string;
  attempt: number;
  attemptIds: string[];
  status: 'running' | 'interrupted' | 'completed' | 'blocked';
  stopReason?: StopReason;
  error?: string;
  usedMs: number;
  maxExecutionMs: number;
  limitSource: string;
  modelRequests: number;
  retries: number;
  lastNetworkAt?: string;
  lastEventAt?: string;
  lastContentAt?: string;
  lastStepAt?: string;
  updatedAt: string;
  /** Exact original projection input; credentials and runtime handles excluded. */
  request: Omit<AgentRequest, 'sourceConfig' | 'signal' | 'checkpoint' | 'taskClock'>;
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
    budgetStopReason?: 'tool_iterations_exhausted' | 'tool_call_limit_exhausted' | 'tool_result_budget_exhausted' | 'run_time_limit_exhausted';
    budgetStopInstructionQueued: boolean;
    /** Complete response plus individual completed tool results. Never a delta. */
    pending?: {
      response: { message: DeepSeekAssistantMessage; finishReason?: string | null; usage?: DeepSeekUsage | null };
      results: Record<string, string>;
      executing?: { id: string; name: string };
    };
  };
}

export class AgentInterruptedError extends Error {
  public constructor(public readonly reason: StopReason, message: string) { super(message); }
}

export const MAX_LENGTH_CONTINUATION_REQUESTS = 1;
export const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
export function endpointHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function createRunCheckpoint(request: AgentRequest, maxExecutionMs: number, source: string, workspaceFolders: string[]): RunCheckpoint {
  const sourceConfig = request.sourceConfig;
  const input = { ...request };
  delete input.sourceConfig;
  delete input.signal;
  delete input.checkpoint;
  delete input.taskClock;
  input.history = input.history.map(({ runCheckpoint: _cp, ...message }) => message);
  return {
    version: 1, taskId: randomUUID(), attempt: 0, attemptIds: [], status: 'running', usedMs: 0,
    maxExecutionMs, limitSource: source, modelRequests: 0, retries: 0, updatedAt: new Date().toISOString(),
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
    if (cp.version !== 1 || !cp.taskId || !cp.request?.model?.id || !Array.isArray(cp.request.history)
      || !cp.source?.endpointHash || !Array.isArray(cp.workspaceFolders)
      || !Array.isArray(cp.attemptIds) || !Number.isFinite(cp.usedMs) || cp.usedMs < 0
      || !Number.isFinite(cp.maxExecutionMs) || cp.maxExecutionMs < 0) return undefined;
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
    if (copy.status === 'running') {
      copy.status = 'interrupted'; copy.stopReason = 'extension_restart';
      if (copy.taskPlan) copy.taskPlan.status = 'stopped';
    }
    return copy;
  } catch { return undefined; }
}

export function recoveryBlocker(cp: RunCheckpoint): string | undefined {
  if (cp.state?.continuation && cp.state.continuation.requests >= MAX_LENGTH_CONTINUATION_REQUESTS && cp.state.continuation.inFlight) return 'Continuation request budget exhausted / 续写请求预算已用尽';
  if (cp.finalResponse?.runDetails.budgetStopReason) return 'Declared safety budget exhausted / 已声明的安全预算已用尽';
  if (cp.status === 'completed') return 'Task already completed / 任务已完成';
  if (cp.maxExecutionMs > 0 && cp.usedMs >= cp.maxExecutionMs) return 'Time budget exhausted / 时间预算已用尽';
  if (cp.state?.pending?.executing) return `Uncertain tool result: ${cp.state.pending.executing.name}. Verify before starting another task. / 工具结果未知，请先核实实际状态。`;
  if (cp.state?.budgetStopReason) return 'Declared safety budget exhausted / 已声明的安全预算已用尽';
  if (cp.stopReason === 'storage_failure' || cp.stopReason === 'resource_limit') return cp.error ?? cp.stopReason;
  return undefined;
}
