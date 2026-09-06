import { randomUUID } from 'node:crypto';
import type { ModelSourceConfigSnapshot } from '../accounts/types';
import { requiresModelSourceApiKey } from '../accounts/sourceCapabilities';
import type { KeepseekLanguage } from '../shared/i18n';
import type { KeepseekModel, UsageEvent } from '../shared/types';
import { getConfiguredModelUsagePricing } from '../shared/config';
import type { DeepSeekChatRequestBody } from '../agent/deepseek/types';
import { createProviderClient } from '../agent/providers/factory';
import type { AnthropicMessagesRequestBody } from '../agent/providers/anthropicTypes';
import type { OpenAiResponsesRequestBody } from '../agent/providers/responsesTypes';
import { calculateUsageCost, createUsageEvent, normalizeDeepSeekUsage } from '../agent/usageStats';

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
}): Promise<string> {
  if (!input.sourceConfig.apiKey.trim() && requiresModelSourceApiKey(input.sourceConfig)) {
    throw new Error(input.language === 'en'
      ? 'The configured approval model credentials are invalid or missing.'
      : '审批模型的凭据无效或缺失。');
  }
  const requestId = `approval_${randomUUID()}`;
  const deadlineAt = Date.now() + APPROVAL_REVIEW_TIMEOUT_MS;
  const abort = createDeadlineSignal(input.signal, APPROVAL_REVIEW_TIMEOUT_MS);
  try {
    const response = await createProviderClient(input.sourceConfig.provider).createModelResponse({
      apiKey: input.sourceConfig.apiKey,
      baseUrl: input.sourceConfig.baseUrl,
      streamIdleTimeoutMs: APPROVAL_REVIEW_TIMEOUT_MS,
      maxRequestRetries: 0,
      requestRetryBaseMs: 250
    }, {
      body: buildApprovalReviewerProviderBody({
        modelId: input.model.id,
        provider: input.sourceConfig.provider,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt
      }),
      language: input.language,
      signal: abort.signal,
      runDeadlineAt: deadlineAt,
      requestId
    });
    if (!response.ok || !response.message?.content?.trim()) {
      throw new Error(response.error ?? (input.language === 'en'
        ? 'Approval reviewer returned no usable response.'
        : '审批模型未返回可用响应。'));
    }
    const usage = normalizeDeepSeekUsage(response.usage);
    if (usage) {
      const rates = input.sourceConfig.supportsBilling
        ? getConfiguredModelUsagePricing(input.model.id)
        : undefined;
      input.onUsage?.(createUsageEvent({
        usage,
        cost: rates ? calculateUsageCost(usage, rates) : 0,
        currency: rates?.currency ?? '',
        pricingStatus: rates ? 'priced' : 'unavailable',
        sourceId: input.sourceConfig.sourceId,
        modelId: input.model.id,
        provider: input.sourceConfig.provider,
        protocol: input.sourceConfig.provider === 'openai-responses'
          ? 'openai-responses'
          : input.sourceConfig.provider === 'anthropic-compatible'
            ? 'anthropic-messages'
            : 'chat-completions',
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
