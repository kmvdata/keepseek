import type * as vscode from 'vscode';
import type { AgentRequest } from '../shared/types';
import { ExecutionCostBudget } from '../agent/executionPolicy';
import { getConfiguredAgentMaxCost, getConfiguredModelUsagePricing } from '../shared/config';
import { applyProviderRequestBudget, loadProviderRequestBudget } from '../agent/requestBudget';
import { getAgentRuntimeProfile } from '../shared/modelProfiles';
import { randomUUID } from 'node:crypto';
import type { ModelSourceConfigSnapshot } from '../accounts/types';
import { requiresModelSourceApiKey } from '../accounts/sourceCapabilities';
import type { KeepseekLanguage } from '../shared/i18n';
import type { KeepseekModel, ProviderCacheObservation, ProviderUsageLedgerRecord, UsageEvent, UsagePriceSnapshot } from '../shared/types';
import type { DeepSeekChatRequestBody } from '../agent/deepseek/types';
import { createProviderClient } from '../agent/providers/factory';
import type { AnthropicMessagesRequestBody } from '../agent/providers/anthropicTypes';
import type { OpenAiResponsesRequestBody } from '../agent/providers/responsesTypes';
import { createUsageEvent, normalizeDeepSeekUsage } from '../agent/usageStats';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot
} from '../agent/usageLedger';
import { createProviderCacheObservation } from '../agent/cacheObservation';

export function buildApprovalReviewerProviderBody(input: {
  modelId: string;
  model?: KeepseekModel;
  provider: ModelSourceConfigSnapshot['provider'];
  systemPrompt: string;
  userPrompt: string;
}): DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody {
  const maxTokens = getAgentRuntimeProfile(input.model ?? { id: input.modelId, label: input.modelId, provider: input.provider },
    { thinkingEnabled: false, reasoningEffort: 'high' }).maxTokens;
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
      temperature: 0
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

export async function requestApprovalReviewText(input: {
  model: KeepseekModel;
  sourceConfig: ModelSourceConfigSnapshot;
  systemPrompt: string;
  userPrompt: string;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  globalStorageUri?: vscode.Uri;
  taskCostBudget?: AgentRequest['taskCostBudget'];
  taskRunBudget?: AgentRequest['taskRunBudget'];
  onUsage?: (event: UsageEvent) => void;
  onUsageLedgerRecord?: (record: ProviderUsageLedgerRecord) => void;
  sessionId?: string;
  taskId?: string;
  runId?: string;
}): Promise<string> {
  if (!input.sourceConfig.apiKey.trim() && requiresModelSourceApiKey(input.sourceConfig)) {
    throw new Error(input.language === 'en'
      ? 'The configured approval model credentials are invalid or missing.'
      : '审批模型的凭据无效或缺失。');
  }
  const requestId = `approval_${randomUUID()}`;
  const protocol = input.sourceConfig.provider === 'openai-responses'
    ? 'openai-responses'
    : input.sourceConfig.provider === 'anthropic-compatible'
      ? 'anthropic-messages'
      : 'chat-completions';
  const createSnapshot = (requestStartedAt: string): UsagePriceSnapshot => createUsagePriceSnapshot({
    originalModelId: input.model.id,
    sourceId: input.sourceConfig.sourceId,
    provider: input.sourceConfig.provider,
    protocol,
    supportsBilling: input.sourceConfig.supportsBilling,
    requestStartedAt
  });
  const fallbackSnapshot = createSnapshot(new Date().toISOString());
  const attemptSnapshots: UsagePriceSnapshot[] = [];
  const body = buildApprovalReviewerProviderBody({
    modelId: input.model.id,
    model: input.model,
    provider: input.sourceConfig.provider,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt
  });
  const budget = await loadProviderRequestBudget({ model: input.model, sourceId: input.sourceConfig.sourceId,
    baseUrl: input.sourceConfig.baseUrl, provider: input.sourceConfig.provider, body }, input.globalStorageUri);
  applyProviderRequestBudget(body, budget);
  const attemptCacheObservations: ProviderCacheObservation[] = [];
  const createObservation = (attemptIndex: number) => createProviderCacheObservation({
    requestId,
    attemptIndex,
    source: 'reviewer',
    sourceId: input.sourceConfig.sourceId,
    provider: input.sourceConfig.provider,
    baseUrl: input.sourceConfig.baseUrl,
    body,
    taskId: input.taskId,
    runId: input.runId,
    requestProtocolVersion: 1,
    // Reviewer calls are isolated one-shot decisions, not append-only
    // continuations of an earlier review. Only physical retries of this same
    // logical request are comparable.
    previous: attemptIndex > 0 ? attemptCacheObservations[0] : undefined
  });
  const costBudget = input.taskCostBudget ?? new ExecutionCostBudget(getConfiguredAgentMaxCost());
  let costReservation: ReturnType<ExecutionCostBudget['reserve']> | undefined;
  let tokenReservation: ReturnType<NonNullable<AgentRequest['taskRunBudget']>['reservePhysicalRequest']> | undefined;
  const response = await createProviderClient(input.sourceConfig.provider).createModelResponse({
    apiKey: input.sourceConfig.apiKey,
    baseUrl: input.sourceConfig.baseUrl,
    streamIdleTimeoutMs: 0,
    maxRequestRetries: 0,
    requestRetryBaseMs: 250
  }, {
    body,
    language: input.language,
    signal: input.signal,
    requestId,
    callbacks: { beforeModelRequest: async () => {
      input.taskRunBudget?.assertCanDispatch();
      if (costBudget.limit > 0) {
        const price = createSnapshot(new Date().toISOString());
        const rates = getConfiguredModelUsagePricing(input.model.id);
        const upperCost = (getAgentRuntimeProfile(input.model, { thinkingEnabled: false, reasoningEffort: 'high' }).contextWindowTokens
          * Math.max(price.inputRate ?? NaN, price.cacheHitRate ?? NaN, rates?.peakInputPrice ?? 0, rates?.peakCacheHitPrice ?? 0)
          + budget.actualMaxOutputTokens * Math.max(price.outputRate ?? NaN, rates?.peakOutputPrice ?? 0)) / 1_000_000;
        if (!price.supportsBilling || price.unavailableReason || !Number.isFinite(upperCost) || !price.currency) {
          throw new Error('Approval reviewer cannot be priced under the configured task cost limit / 审批模型无法在任务费用上限内计价');
        }
        costReservation = costBudget.reserve(upperCost, price.currency);
      }
      try { tokenReservation = input.taskRunBudget?.reservePhysicalRequest(budget.inputBudgetTokens, budget.actualMaxOutputTokens); }
      catch (error) { if (costReservation) costBudget.settle(costReservation, 0); throw error; }
    } },
    onAttempt: ({ attemptIndex, startedAt }) => {
      attemptSnapshots[attemptIndex] = createSnapshot(startedAt);
      attemptCacheObservations[attemptIndex] = createObservation(attemptIndex);
    }
  });
  while (attemptSnapshots.length < (response.attemptCount ?? 1)) {
    const attemptIndex = attemptSnapshots.length;
    attemptSnapshots.push(attemptSnapshots.length === 0
      ? fallbackSnapshot
      : createSnapshot(new Date().toISOString()));
    attemptCacheObservations[attemptIndex] = createObservation(attemptIndex);
  }
  const usage = normalizeDeepSeekUsage(response.usage);
  const ledgerRecords = createUsageLedgerRecords({
    requestId,
    attempts: attemptSnapshots,
    usage,
    source: 'reviewer',
    cacheObservations: attemptCacheObservations
  }).map((record) => ({ ...record, requestBudget: budget }));
  ledgerRecords.forEach((record) => input.onUsageLedgerRecord?.(record));
  if (usage) {
    const billed = ledgerRecords.find((record) => record.kind === 'usage_response');
    input.onUsage?.(createUsageEvent({
      usage,
      cost: billed?.cost ?? 0,
      currency: billed?.currency ?? '',
      pricingStatus: billed?.pricingStatus ?? 'unavailable',
      unpricedReason: billed?.unpricedReason,
      ledgerRecorded: true,
      providerAttemptCount: ledgerRecords.length,
      sourceId: input.sourceConfig.sourceId,
      modelId: input.model.id,
      provider: input.sourceConfig.provider,
      protocol,
      requestId,
      source: 'reviewer'
    }));
  }
  if (tokenReservation) input.taskRunBudget?.settlePhysicalRequest(tokenReservation, response.usage ?? undefined, response.ok);
  const billed = ledgerRecords.find((record) => record.kind === 'usage_response');
  if (costReservation && response.ok && billed?.cost !== undefined
    && (billed.pricingStatus === 'priced' || billed.pricingStatus === 'estimated_upper_bound')) costBudget.settle(costReservation, billed.cost);
  if (!response.ok || response.finishReason === 'length' || !response.message?.content?.trim()) {
    throw new Error(response.error ?? (input.language === 'en'
      ? 'Approval reviewer returned no usable response.'
      : '审批模型未返回可用响应。'));
  }
  // Provider reasoning is intentionally ignored and never leaves this call.
  return response.message.content.trim();
}
