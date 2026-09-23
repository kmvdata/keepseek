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

export const APPROVAL_REVIEW_MAX_OUTPUT_TOKENS = 512;
export const APPROVAL_REVIEW_TIMEOUT_MS = 20_000;

export function buildApprovalReviewerProviderBody(input: {
  modelId: string;
  provider: ModelSourceConfigSnapshot['provider'];
  systemPrompt: string;
  userPrompt: string;
}): DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody {
  if (input.provider === 'openai-responses') {
    return {
      model: input.modelId,
      input: [
        { role: 'system', content: input.systemPrompt },
        { role: 'user', content: input.userPrompt }
      ],
      stream: true,
      store: false,
      max_output_tokens: APPROVAL_REVIEW_MAX_OUTPUT_TOKENS,
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
      max_tokens: APPROVAL_REVIEW_MAX_OUTPUT_TOKENS,
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
    max_tokens: APPROVAL_REVIEW_MAX_OUTPUT_TOKENS,
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
  const deadlineAt = Date.now() + APPROVAL_REVIEW_TIMEOUT_MS;
  const abort = createDeadlineSignal(input.signal, APPROVAL_REVIEW_TIMEOUT_MS);
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
    provider: input.sourceConfig.provider,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt
  });
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
  try {
    const response = await createProviderClient(input.sourceConfig.provider).createModelResponse({
      apiKey: input.sourceConfig.apiKey,
      baseUrl: input.sourceConfig.baseUrl,
      streamIdleTimeoutMs: APPROVAL_REVIEW_TIMEOUT_MS,
      maxRequestRetries: 0,
      requestRetryBaseMs: 250
    }, {
      body,
      language: input.language,
      signal: abort.signal,
      runDeadlineAt: deadlineAt,
      requestId,
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
    });
    ledgerRecords.forEach((record) => input.onUsageLedgerRecord?.(record));
    if (!response.ok || !response.message?.content?.trim()) {
      throw new Error(response.error ?? (input.language === 'en'
        ? 'Approval reviewer returned no usable response.'
        : '审批模型未返回可用响应。'));
    }
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
    // Provider reasoning is intentionally ignored and never leaves this call.
    return response.message.content.trim();
  } finally {
    abort.dispose();
  }
}

function createDeadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Approval reviewer timed out.')), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abortFromParent);
    }
  };
}
