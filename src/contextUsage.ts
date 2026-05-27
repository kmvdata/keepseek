import {
  DEFAULT_MAX_TOKENS,
  getConfiguredContextWindowTokens,
  getConfiguredMaxTokens,
  getConfiguredMaxToolIterations
} from './config';
import { DeepSeekFunctionTool, DeepSeekMessage } from './deepSeekTypes';
import {
  buildInitialAgentMessages,
  estimateChatMessageTokens,
  estimateDeepSeekMessageTokens,
  estimateDeepSeekToolsTokens,
  getAgentSystemPrompt,
  getAgentTools
} from './agentProtocol';
import type { KeepseekLanguage } from './i18n';
import { ChatMessage, ContextFile, ContextUsageEstimate, KeepseekModel } from './types';

type ContextUsageBreakdown = ContextUsageEstimate['breakdown'];

export function createContextUsageEstimate(input: {
  model: KeepseekModel;
  contextFiles: ContextFile[];
  messages: ChatMessage[];
  language: KeepseekLanguage;
  prompt?: string;
  includeTools?: boolean;
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
}): ContextUsageEstimate {
  const prompt = input.prompt?.trim() ?? '';
  const messages = buildInitialAgentMessages({
    prompt,
    contextFiles: input.contextFiles,
    history: input.messages,
    language: input.language
  });
  const includeTools = input.includeTools ?? getConfiguredMaxToolIterations() > 0;
  const tools = includeTools ? getAgentTools() : [];
  const outputReserveTokens = input.outputReserveTokens ?? resolveOutputReserveTokens(getConfiguredMaxTokens());
  const breakdown = estimateInitialBreakdown({
    messages,
    contextFiles: input.contextFiles,
    language: input.language,
    prompt,
    tools,
    outputReserveTokens,
    safetyReserveTokens: input.safetyReserveTokens ?? 0
  });

  return createContextUsageEstimateFromMessages({
    model: input.model,
    messages,
    tools,
    outputReserveTokens,
    safetyReserveTokens: input.safetyReserveTokens,
    breakdown
  });
}

export function createContextUsageEstimateFromMessages(input: {
  model: KeepseekModel;
  messages: DeepSeekMessage[];
  tools?: DeepSeekFunctionTool[];
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  breakdown?: Partial<ContextUsageBreakdown>;
}): ContextUsageEstimate {
  const maxTokensEstimate = getConfiguredContextWindowTokens(input.model);
  const messageTokensEstimate = input.messages.reduce(
    (total, message) => total + estimateDeepSeekMessageTokens(message),
    0
  );
  const toolSchemaTokensEstimate = estimateDeepSeekToolsTokens(input.tools);
  const outputReserveTokensEstimate = Math.max(0, Math.floor(input.outputReserveTokens ?? 0));
  const safetyReserveTokensEstimate = Math.max(0, Math.floor(input.safetyReserveTokens ?? 0));
  const usedTokensEstimate = messageTokensEstimate +
    toolSchemaTokensEstimate +
    outputReserveTokensEstimate +
    safetyReserveTokensEstimate;

  return normalizeContextUsageEstimate({
    maxTokensEstimate,
    usedTokensEstimate,
    breakdown: {
      ...createEmptyBreakdown(),
      ...input.breakdown,
      toolSchemaTokensEstimate: input.breakdown?.toolSchemaTokensEstimate ?? toolSchemaTokensEstimate,
      outputReserveTokensEstimate,
      safetyReserveTokensEstimate
    }
  });
}

export function toSessionContextUsageEstimate(usage: ContextUsageEstimate): ContextUsageEstimate {
  const breakdown = normalizeBreakdown({
    ...usage.breakdown,
    systemTokensEstimate: 0,
    toolSchemaTokensEstimate: 0,
    outputReserveTokensEstimate: 0,
    safetyReserveTokensEstimate: 0
  });
  const usedTokensEstimate = breakdown.contextFileTokensEstimate +
    breakdown.historyTokensEstimate +
    breakdown.inputTokensEstimate +
    breakdown.toolCallTokensEstimate +
    breakdown.toolResultTokensEstimate +
    breakdown.reasoningTokensEstimate;

  return normalizeContextUsageEstimate({
    maxTokensEstimate: usage.maxTokensEstimate,
    usedTokensEstimate,
    breakdown
  });
}

export function resolveOutputReserveTokens(maxTokens: number): number {
  return maxTokens > 0 ? maxTokens : DEFAULT_MAX_TOKENS;
}

function estimateInitialBreakdown(input: {
  messages: DeepSeekMessage[];
  contextFiles: ContextFile[];
  language: KeepseekLanguage;
  prompt: string;
  tools: DeepSeekFunctionTool[];
  outputReserveTokens: number;
  safetyReserveTokens: number;
}): ContextUsageBreakdown {
  const breakdown = createEmptyBreakdown();
  const systemMessage = input.messages[0];
  const fullSystemTokens = systemMessage ? estimateDeepSeekMessageTokens(systemMessage) : 0;
  const systemOnlyTokens = estimateChatMessageTokens(
    'system',
    getAgentSystemPrompt({
      contextFiles: [],
      language: input.language
    })
  );

  breakdown.systemTokensEstimate = Math.min(fullSystemTokens, systemOnlyTokens);
  breakdown.contextFileTokensEstimate = Math.max(0, fullSystemTokens - breakdown.systemTokensEstimate);
  breakdown.toolSchemaTokensEstimate = estimateDeepSeekToolsTokens(input.tools);
  breakdown.outputReserveTokensEstimate = input.outputReserveTokens;
  breakdown.safetyReserveTokensEstimate = input.safetyReserveTokens;

  const promptIndex = findPromptMessageIndex(input.messages, input.prompt);
  for (let index = 1; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    const tokens = estimateDeepSeekMessageTokens(message);
    if (index === promptIndex) {
      breakdown.inputTokensEstimate += tokens;
    } else {
      breakdown.historyTokensEstimate += tokens;
    }
  }

  return breakdown;
}

function findPromptMessageIndex(messages: DeepSeekMessage[], prompt: string): number {
  if (!prompt.trim()) {
    return -1;
  }
  for (let index = messages.length - 1; index >= 1; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && (message.content ?? '').trim() === prompt) {
      return index;
    }
  }
  return -1;
}

function normalizeContextUsageEstimate(input: {
  maxTokensEstimate: number;
  usedTokensEstimate: number;
  breakdown: Partial<ContextUsageBreakdown>;
}): ContextUsageEstimate {
  const maxTokensEstimate = Math.max(1, Math.floor(input.maxTokensEstimate));
  const usedTokensEstimate = Math.max(0, Math.floor(input.usedTokensEstimate));
  const remainingTokensEstimate = Math.max(0, maxTokensEstimate - usedTokensEstimate);
  const usedPercent = Math.min(100, (usedTokensEstimate / maxTokensEstimate) * 100);
  const breakdown = normalizeBreakdown(input.breakdown);

  return {
    usedTokensEstimate,
    maxTokensEstimate,
    remainingTokensEstimate,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    breakdown
  };
}

function createEmptyBreakdown(): ContextUsageBreakdown {
  return {
    systemTokensEstimate: 0,
    contextFileTokensEstimate: 0,
    historyTokensEstimate: 0,
    inputTokensEstimate: 0,
    toolSchemaTokensEstimate: 0,
    toolCallTokensEstimate: 0,
    toolResultTokensEstimate: 0,
    reasoningTokensEstimate: 0,
    outputReserveTokensEstimate: 0,
    safetyReserveTokensEstimate: 0
  };
}

function normalizeBreakdown(input: Partial<ContextUsageBreakdown>): ContextUsageBreakdown {
  return {
    systemTokensEstimate: normalizeTokenEstimate(input.systemTokensEstimate),
    contextFileTokensEstimate: normalizeTokenEstimate(input.contextFileTokensEstimate),
    historyTokensEstimate: normalizeTokenEstimate(input.historyTokensEstimate),
    inputTokensEstimate: normalizeTokenEstimate(input.inputTokensEstimate),
    toolSchemaTokensEstimate: normalizeTokenEstimate(input.toolSchemaTokensEstimate),
    toolCallTokensEstimate: normalizeTokenEstimate(input.toolCallTokensEstimate),
    toolResultTokensEstimate: normalizeTokenEstimate(input.toolResultTokensEstimate),
    reasoningTokensEstimate: normalizeTokenEstimate(input.reasoningTokensEstimate),
    outputReserveTokensEstimate: normalizeTokenEstimate(input.outputReserveTokensEstimate),
    safetyReserveTokensEstimate: normalizeTokenEstimate(input.safetyReserveTokensEstimate)
  };
}

function normalizeTokenEstimate(value: unknown): number {
  const number = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(number) ? number : 0));
}
