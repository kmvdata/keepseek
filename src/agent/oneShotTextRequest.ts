import type * as vscode from 'vscode';
import type { AgentRequest } from '../shared/types';
import { ExecutionCostBudget } from './executionPolicy';
import { getConfiguredAgentMaxCost, getConfiguredModelUsagePricing } from '../shared/config';
import { applyProviderRequestBudget, loadProviderRequestBudget } from './requestBudget';
import { getAgentRuntimeProfile } from '../shared/modelProfiles';
import { randomUUID } from 'node:crypto';
import type { ModelSourceConfigSnapshot } from '../accounts/types';
import { isOfficialAnthropicSource, requiresModelSourceApiKey } from '../accounts/sourceCapabilities';
import type { KeepseekLanguage } from '../shared/i18n';
import type { KeepseekModel, ProviderCacheObservation, ProviderUsageLedgerRecord, UsageEvent, UsagePriceSnapshot } from '../shared/types';
import type { DeepSeekChatRequestBody } from './deepseek/types';
import { createProviderClient } from './providers/factory';
import type { AnthropicMessagesRequestBody } from './providers/anthropicTypes';
import type { OpenAiResponsesRequestBody } from './providers/responsesTypes';
import { createUsageEvent, normalizeDeepSeekUsage } from './usageStats';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot
} from './usageLedger';
import { createProviderCacheObservation } from './cacheObservation';

export function buildOneShotTextProviderBody(input: {
  modelId: string;
  model?: KeepseekModel;
  provider: ModelSourceConfigSnapshot['provider'];
  systemPrompt: string;
  userPrompt: string;
  maxOutputTokens?: number;
  cacheControl?: AnthropicMessagesRequestBody['cache_control'];
}): DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody {
  const modelMaxTokens = getAgentRuntimeProfile(input.model ?? { id: input.modelId, label: input.modelId, provider: input.provider },
    { thinkingEnabled: false, reasoningEffort: 'high' }).maxTokens;
  const maxTokens = input.maxOutputTokens === undefined ? modelMaxTokens
    : Math.min(modelMaxTokens, Math.max(1, Math.floor(input.maxOutputTokens)));
  if (input.provider === 'openai-responses') {
    return {
      model: input.modelId,
      input: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt }
      ],
      stream: true,
      store: false,
      max_output_tokens: maxTokens,
      temperature: 0,
      top_p: 0.1
    };
  }
  if (input.provider === 'anthropic-compatible') {
    return {
      model: input.modelId,
      system: [{ type: 'text', text: input.systemPrompt }],
      messages: [{ role: 'user', content: [{ type: 'text', text: input.userPrompt }] }],
      stream: true,
      max_tokens: maxTokens,
      temperature: 0,
      ...(input.cacheControl ? { cache_control: input.cacheControl } : {})
    };
  }
  return {
    model: input.modelId,
    messages: [
      { role: 'system', content: input.systemPrompt },
      { role: 'user', content: input.userPrompt }
    ],
    stream: true,
    enable_thinking: input.provider === 'qwencloud' ? false : undefined,
    thinking: input.provider === 'deepseek' ? { type: 'disabled' } : undefined,
    temperature: 0,
    top_p: 0.1,
    max_tokens: maxTokens,
    stream_options: { include_usage: true }
  };
}

export interface OneShotTextRequestInput {
  model: KeepseekModel;
  sourceConfig: ModelSourceConfigSnapshot;
  systemPrompt: string;
  userPrompt: string;
  language: KeepseekLanguage;
  /** Isolated auxiliary purpose; never a tool-enabled child task. */
  purpose: 'approval_review' | 'session_title';
  /** Stable host claim ID, reused for storage retries rather than model retries. */
  requestId?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  globalStorageUri?: vscode.Uri;
  taskCostBudget?: AgentRequest['taskCostBudget'];
  taskRunBudget?: AgentRequest['taskRunBudget'];
  onUsage?: (event: UsageEvent) => void;
  onUsageLedgerRecord?: (record: ProviderUsageLedgerRecord) => Promise<void> | void;
  /** Persist shared reservations before dispatch and settled state after cleanup. */
  onBudgetChanged?: () => Promise<void> | void;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}

export class OneShotTextRequestError extends Error {
  public constructor(public readonly reason: 'unavailable' | 'invalid' | 'timeout' | 'cancelled', message: string) {
    super(message);
    this.name = 'OneShotTextRequestError';
  }
}

/** One physical request with no tools, retries, history replay, or format repair.
 * All dispatched attempts, including failed/cancelled ones, retain usage records.
 * Unknown usage retains conservative shared budget reservations. */
export async function requestOneShotText(input: OneShotTextRequestInput): Promise<string> {
  const isTitle = input.purpose === 'session_title';
  const source = isTitle ? 'subagent' : 'reviewer';
  if (isTitle && (!input.taskCostBudget || !input.taskRunBudget)) {
    throw new OneShotTextRequestError('unavailable', 'Session title requires the owning task budget / 会话标题需要所属任务预算');
  }
  if (!input.sourceConfig.apiKey.trim() && requiresModelSourceApiKey(input.sourceConfig)) {
    throw new OneShotTextRequestError('unavailable', input.language === 'en'
      ? (isTitle ? 'The configured subagent model credentials are invalid or missing.' : 'The configured approval model credentials are invalid or missing.')
      : (isTitle ? '子代理模型的凭据无效或缺失。' : '审批模型的凭据无效或缺失。'));
  }
  const requestId = input.requestId ?? `${isTitle ? 'session_title' : 'approval'}_${randomUUID()}`;
  const protocol = input.sourceConfig.provider === 'openai-responses'
    ? 'openai-responses'
    : input.sourceConfig.provider === 'anthropic-compatible' ? 'anthropic-messages' : 'chat-completions';
  const createSnapshot = (requestStartedAt: string): UsagePriceSnapshot => createUsagePriceSnapshot({
    originalModelId: input.model.id, sourceId: input.sourceConfig.sourceId,
    provider: input.sourceConfig.provider, protocol,
    supportsBilling: input.sourceConfig.supportsBilling, requestStartedAt
  });
  const maxOutputTokens = isTitle ? Math.min(input.maxOutputTokens ?? 256, 256) : input.maxOutputTokens;
  const body = buildOneShotTextProviderBody({
    modelId: input.model.id, model: input.model, provider: input.sourceConfig.provider,
    systemPrompt: input.systemPrompt, userPrompt: input.userPrompt, maxOutputTokens,
    // Match the existing main/summary policy only on the canonical Anthropic
    // endpoint. Compatible gateways and approval reviewer bytes stay unchanged.
    cacheControl: isTitle && isOfficialAnthropicSource(input.sourceConfig) ? { type: 'ephemeral' } : undefined
  });
  // Use the same admission estimator/calibration as all other Provider requests,
  // while respecting this auxiliary request's smaller output cap.
  const admittedModel = maxOutputTokens === undefined ? input.model
    : { ...input.model, maxOutputTokens: Math.min(getAgentRuntimeProfile(input.model,
      { thinkingEnabled: false, reasoningEffort: 'high' }).maxTokens, Math.max(1, Math.floor(maxOutputTokens))) };
  const budget = await loadProviderRequestBudget({ model: admittedModel, sourceId: input.sourceConfig.sourceId,
    baseUrl: input.sourceConfig.baseUrl, provider: input.sourceConfig.provider, body }, input.globalStorageUri);
  applyProviderRequestBudget(body, budget);
  const attemptSnapshots: UsagePriceSnapshot[] = [];
  const attemptCacheObservations: ProviderCacheObservation[] = [];
  const costBudget = input.taskCostBudget ?? new ExecutionCostBudget(getConfiguredAgentMaxCost());
  let costReservation: ReturnType<ExecutionCostBudget['reserve']> | undefined;
  let tokenReservation: ReturnType<NonNullable<AgentRequest['taskRunBudget']>['reservePhysicalRequest']> | undefined;
  const timeoutMs = isTitle ? Math.min(20_000, Math.max(1, input.timeoutMs ?? 20_000)) : input.timeoutMs;
  const deadlines = [input.taskRunBudget?.deadlineAt,
    timeoutMs === undefined ? undefined : Date.now() + timeoutMs].filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  const runDeadlineAt = deadlines.length ? Math.min(...deadlines) : undefined;
  let response: import('./providers/types').ProviderClientResult | undefined;
  try {
    response = await createProviderClient(input.sourceConfig.provider).createModelResponse({
      apiKey: input.sourceConfig.apiKey, baseUrl: input.sourceConfig.baseUrl,
      streamIdleTimeoutMs: 0, maxRequestRetries: 0, requestRetryBaseMs: 250
    }, {
      body, language: input.language, signal: input.signal, requestId, runDeadlineAt,
      callbacks: { beforeModelRequest: async () => {
        input.taskRunBudget?.assertCanDispatch();
        if (costBudget.limit > 0) {
          const price = createSnapshot(new Date().toISOString());
          const rates = getConfiguredModelUsagePricing(input.model.id);
          const inputBound = isTitle ? budget.inputBudgetTokens : getAgentRuntimeProfile(input.model,
            { thinkingEnabled: false, reasoningEffort: 'high' }).contextWindowTokens;
          const upperCost = (inputBound
            * Math.max(price.inputRate ?? NaN, price.cacheHitRate ?? NaN, rates?.peakInputPrice ?? 0, rates?.peakCacheHitPrice ?? 0)
            + budget.actualMaxOutputTokens * Math.max(price.outputRate ?? NaN, rates?.peakOutputPrice ?? 0)) / 1_000_000;
          if (!price.supportsBilling || price.unavailableReason || !Number.isFinite(upperCost) || !price.currency) {
            throw new OneShotTextRequestError('unavailable', isTitle
              ? 'Session title model cannot be priced under the task cost limit / 标题模型无法在任务费用上限内计价'
              : 'Approval reviewer cannot be priced under the configured task cost limit / 审批模型无法在任务费用上限内计价');
          }
          costReservation = costBudget.reserve(upperCost, price.currency);
        }
        try { tokenReservation = input.taskRunBudget?.reservePhysicalRequest(budget.inputBudgetTokens, budget.actualMaxOutputTokens); }
        catch (error) { if (costReservation) costBudget.settle(costReservation, 0); costReservation = undefined; throw error; }
        await input.onBudgetChanged?.();
      } },
      onAttempt: async ({ attemptIndex, startedAt }) => {
        attemptSnapshots[attemptIndex] = createSnapshot(startedAt);
        attemptCacheObservations[attemptIndex] = createProviderCacheObservation({
          requestId, attemptIndex, source, sourceId: input.sourceConfig.sourceId,
          provider: input.sourceConfig.provider, baseUrl: input.sourceConfig.baseUrl,
          body, taskId: input.taskId, runId: input.runId, requestProtocolVersion: 1
        });
        if (isTitle) {
          // Durable dispatch intent survives a host crash. The final callback
          // upgrades this same request/attempt identity instead of adding a
          // second Provider attempt. A failed write prevents the POST.
          const attempt = createUsageLedgerRecords({ requestId, attempts: attemptSnapshots,
            source, cacheObservations: attemptCacheObservations })[attemptIndex];
          await input.onUsageLedgerRecord?.({ ...attempt, requestBudget: budget, purpose: 'session_title' });
        }
      }
    });
  } finally {
    // Cleanup/settlement is independent of a late stale result or a ledger write
    // failure. No missing Provider counters are synthesized from response text.
    const usage = normalizeDeepSeekUsage(response?.usage);
    const records = createUsageLedgerRecords({
      requestId, attempts: attemptSnapshots, usage, source,
      observedUsage: response?.usage ? { promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens, totalTokens: response.usage.total_tokens,
        reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens } : undefined,
      cacheObservations: attemptCacheObservations
    }).map((record): ProviderUsageLedgerRecord => ({ ...record, requestBudget: budget,
      ...(isTitle ? { purpose: 'session_title' } : {}) }));
    if (tokenReservation) input.taskRunBudget?.settlePhysicalRequest(tokenReservation, response?.usage ?? undefined, response?.ok === true);
    const billed = records.find((record) => record.kind === 'usage_response');
    if (costReservation && response?.ok && billed?.cost !== undefined
      && (billed.pricingStatus === 'priced' || billed.pricingStatus === 'estimated_upper_bound')) costBudget.settle(costReservation, billed.cost);
    if (isTitle && !costReservation && billed?.cost !== undefined
      && (billed.pricingStatus === 'priced' || billed.pricingStatus === 'estimated_upper_bound')) costBudget.record(billed.cost, billed.currency);
    try {
      for (const record of records) await input.onUsageLedgerRecord?.(record);
      if (usage) input.onUsage?.({ ...createUsageEvent({
        usage, cost: billed?.cost ?? 0, currency: billed?.currency ?? '',
        pricingStatus: billed?.pricingStatus ?? 'unavailable', unpricedReason: billed?.unpricedReason,
        ledgerRecorded: true, providerAttemptCount: records.length,
        sourceId: input.sourceConfig.sourceId, modelId: input.model.id,
        provider: input.sourceConfig.provider, protocol, requestId, source
      }), ...(isTitle ? { purpose: 'session_title' as const } : {}) });
    } finally { await input.onBudgetChanged?.(); }
  }
  const hasTools = Boolean(response.message?.tool_calls?.length
    || response.nativeOutputItems?.some(item => item.type === 'function_call')
    || response.nativeAnthropicContentBlocks?.some(block => block.type === 'tool_use'));
  if (!response.ok || response.finishReason === 'length' || hasTools || !response.message?.content?.trim()) {
    const reason = input.signal?.aborted ? 'cancelled'
      : response.failureKind === 'run_time_limit' || response.failureKind === 'request_timeout' ? 'timeout'
        : response.ok ? 'invalid' : 'unavailable';
    throw new OneShotTextRequestError(reason, isTitle
      ? 'Session title returned no usable response / 会话标题未返回可用响应'
      : response.error ?? (input.language === 'en' ? 'Approval reviewer returned no usable response.' : '审批模型未返回可用响应。'));
  }
  // Provider reasoning is intentionally ignored and never leaves this call.
  return response.message.content.trim();
}
