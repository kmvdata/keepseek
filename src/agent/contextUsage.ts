import { getEffectiveContextWindowTokens } from '../shared/modelProfiles';
import { DeepSeekFunctionTool, DeepSeekMessage } from './deepseek/types';
import { isRecord } from '../shared/errors';
import {
  estimateChatMessageTokens,
  estimateDeepSeekMessageTokens,
  estimateDeepSeekToolsTokens,
  formatActiveSkills,
  formatAgentContextFiles,
  formatLegacyMemoryForAgent,
  formatProjectInstructionsForAgent,
  getAgentSystemPrompt
} from './protocol';
import type { KeepseekLanguage } from '../shared/i18n';
import { AgentSettings, ChatMessage, ContextCompressionState, ContextFile, ContextUsageEstimate, CurrentRunContext, KeepseekModel } from '../shared/types';
import { buildProviderRequestProjection } from './providerRequestProjection';
import type { ModelSourceProvider } from '../accounts/types';
import type { OpenAiResponsesFunctionTool, OpenAiResponsesItem } from './providers/responsesTypes';
import type { AnthropicFunctionTool, AnthropicMessage, AnthropicSystemTextBlock } from './providers/anthropicTypes';
import { estimateTokenCount } from './tokenEstimate';

type ContextUsageBreakdown = ContextUsageEstimate['breakdown'];

export function createContextUsageEstimate(input: {
  model: KeepseekModel;
  agentSettings: AgentSettings;
  contextFiles: ContextFile[];
  currentRunContext?: CurrentRunContext;
  contextInstructions?: string;
  messages: ChatMessage[];
  contextCompression?: ContextCompressionState;
  language: KeepseekLanguage;
  prompt?: string;
  includeTools?: boolean;
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  /** 会话冻结的 slim 工具集；与真实请求保持一致（缺省时按 prompt 现算） */
  slimToolNames?: string[];
  requestProtocolVersion?: number;
  provider?: ModelSourceProvider;
  sourceId?: string;
  baseUrl?: string;
}): ContextUsageEstimate {
  const prompt = input.prompt?.trim() ?? '';
  const providerProjection = buildProviderRequestProjection({
    model: input.model,
    agentSettings: input.agentSettings,
    prompt,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    contextInstructions: input.contextInstructions,
    history: input.messages,
    contextCompression: input.contextCompression,
    language: input.language,
    slimToolNames: input.slimToolNames,
    requestProtocolVersion: input.requestProtocolVersion,
    includeTools: input.includeTools,
    provider: input.provider ?? normalizeKnownProvider(input.model.provider),
    sourceId: input.sourceId ?? input.model.sourceId,
    baseUrl: input.baseUrl
  });
  const messages = providerProjection.messages;
  const tools = providerProjection.tools;
  const outputReserveTokens = input.outputReserveTokens ?? resolveOutputReserveTokens(
    providerProjection.runtimeProfile.maxTokens
  );
  const breakdown = estimateInitialBreakdown({
    messages,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    language: input.language,
    prompt,
    tools,
    outputReserveTokens,
    safetyReserveTokens: input.safetyReserveTokens ?? 0
  });

  if (providerProjection.anthropic) {
    return createContextUsageEstimateFromAnthropic({
      model: input.model,
      system: providerProjection.anthropic.system,
      messages: providerProjection.anthropic.messages,
      tools: providerProjection.anthropic.tools,
      outputReserveTokens,
      safetyReserveTokens: input.safetyReserveTokens,
      breakdown
    });
  }

  if (providerProjection.responses) {
    return createContextUsageEstimateFromResponses({
      model: input.model,
      input: providerProjection.responses.input,
      tools: providerProjection.responses.tools,
      outputReserveTokens,
      safetyReserveTokens: input.safetyReserveTokens,
      breakdown
    });
  }

  return createContextUsageEstimateFromMessages({
    model: input.model,
    messages,
    tools,
    outputReserveTokens,
    safetyReserveTokens: input.safetyReserveTokens,
    breakdown
  });
}

export function createContextUsageEstimateFromAnthropic(input: {
  model: KeepseekModel;
  system: AnthropicSystemTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicFunctionTool[];
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  breakdown?: Partial<ContextUsageBreakdown>;
}): ContextUsageEstimate {
  const maxTokensEstimate = getEffectiveContextWindowTokens(input.model);
  const nativeInputTokensEstimate = estimateTokenCount(JSON.stringify({
    system: input.system,
    messages: input.messages
  })) + (input.system.length + input.messages.length) * 4;
  const toolSchemaTokensEstimate = input.tools?.length
    ? estimateTokenCount(JSON.stringify(input.tools))
    : 0;
  const outputReserveTokensEstimate = Math.max(0, Math.floor(input.outputReserveTokens ?? 0));
  const safetyReserveTokensEstimate = Math.max(0, Math.floor(input.safetyReserveTokens ?? 0));
  const breakdown = scaleProviderInputBreakdown(
    input.breakdown,
    nativeInputTokensEstimate,
    toolSchemaTokensEstimate,
    outputReserveTokensEstimate,
    safetyReserveTokensEstimate
  );
  return normalizeContextUsageEstimate({
    maxTokensEstimate,
    usedTokensEstimate: nativeInputTokensEstimate
      + toolSchemaTokensEstimate
      + outputReserveTokensEstimate
      + safetyReserveTokensEstimate,
    breakdown
  });
}

export function createDisplayedSessionContextUsageEstimate(input: {
  model: KeepseekModel;
  agentSettings: AgentSettings;
  contextFiles: ContextFile[];
  currentRunContext?: CurrentRunContext;
  contextInstructions?: string;
  messages: ChatMessage[];
  contextCompression?: ContextCompressionState;
  language: KeepseekLanguage;
  prompt?: string;
  /** 会话冻结的 slim 工具集；与真实请求保持一致 */
  slimToolNames?: string[];
  requestProtocolVersion?: number;
  provider?: ModelSourceProvider;
  sourceId?: string;
  baseUrl?: string;
}): ContextUsageEstimate {
  // The authoritative provider projection already contains every reasoning byte
  // that will be sent (tool-call reasoning and legacy-v1 final reasoning). UI-only
  // v2 final reasoning must not be counted a second time.
  return toSessionContextUsageEstimate(createContextUsageEstimate(input));
}

export function createContextUsageEstimateFromMessages(input: {
  model: KeepseekModel;
  messages: DeepSeekMessage[];
  tools?: DeepSeekFunctionTool[];
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  breakdown?: Partial<ContextUsageBreakdown>;
}): ContextUsageEstimate {
  const maxTokensEstimate = getEffectiveContextWindowTokens(input.model);
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

export function createContextUsageEstimateFromResponses(input: {
  model: KeepseekModel;
  input: OpenAiResponsesItem[];
  tools?: OpenAiResponsesFunctionTool[];
  outputReserveTokens?: number;
  safetyReserveTokens?: number;
  breakdown?: Partial<ContextUsageBreakdown>;
}): ContextUsageEstimate {
  const maxTokensEstimate = getEffectiveContextWindowTokens(input.model);
  const inputTokensEstimate = estimateTokenCount(JSON.stringify(input.input)) + input.input.length * 4;
  const toolSchemaTokensEstimate = input.tools?.length
    ? estimateTokenCount(JSON.stringify(input.tools))
    : 0;
  const outputReserveTokensEstimate = Math.max(0, Math.floor(input.outputReserveTokens ?? 0));
  const safetyReserveTokensEstimate = Math.max(0, Math.floor(input.safetyReserveTokens ?? 0));
  const breakdown = scaleProviderInputBreakdown(
    input.breakdown,
    inputTokensEstimate,
    toolSchemaTokensEstimate,
    outputReserveTokensEstimate,
    safetyReserveTokensEstimate
  );
  return normalizeContextUsageEstimate({
    maxTokensEstimate,
    usedTokensEstimate: inputTokensEstimate
      + toolSchemaTokensEstimate
      + outputReserveTokensEstimate
      + safetyReserveTokensEstimate,
    breakdown
  });
}

function scaleProviderInputBreakdown(
  inputBreakdown: Partial<ContextUsageBreakdown> | undefined,
  inputTokensEstimate: number,
  toolSchemaTokensEstimate: number,
  outputReserveTokensEstimate: number,
  safetyReserveTokensEstimate: number
): ContextUsageBreakdown {
  const breakdown = normalizeBreakdown({
    ...createEmptyBreakdown(),
    ...inputBreakdown,
    toolSchemaTokensEstimate,
    outputReserveTokensEstimate,
    safetyReserveTokensEstimate
  });
  const responseInputKeys: Array<keyof ContextUsageBreakdown> = [
    'systemTokensEstimate',
    'contextFileTokensEstimate',
    'historyTokensEstimate',
    'inputTokensEstimate',
    'toolCallTokensEstimate',
    'toolResultTokensEstimate',
    'reasoningTokensEstimate'
  ];
  const previousInputEstimate = responseInputKeys.reduce((total, key) => total + breakdown[key], 0);
  const scale = previousInputEstimate > 0 ? inputTokensEstimate / previousInputEstimate : 0;
  for (const key of responseInputKeys) {
    breakdown[key] = Math.max(0, Math.floor(breakdown[key] * scale));
  }
  const scaledInput = responseInputKeys.reduce((total, key) => total + breakdown[key], 0);
  breakdown.historyTokensEstimate = Math.max(
    0,
    breakdown.historyTokensEstimate + inputTokensEstimate - scaledInput
  );
  return breakdown;
}

/**
 * Replaces the character-based prompt estimate with usage returned by the
 * provider, without issuing another request. Breakdown categories are scaled so
 * the UI, hard-limit telemetry and the recorded prompt total remain consistent.
 */
export function calibrateContextUsageEstimate(
  estimate: ContextUsageEstimate,
  actualPromptTokens: number
): ContextUsageEstimate {
  const promptTokens = Math.max(0, Math.floor(actualPromptTokens));
  const reserveKeys: Array<keyof ContextUsageBreakdown> = [
    'outputReserveTokensEstimate',
    'safetyReserveTokensEstimate'
  ];
  const promptKeys = (Object.keys(estimate.breakdown) as Array<keyof ContextUsageBreakdown>)
    .filter((key) => !reserveKeys.includes(key));
  const estimatedPromptTokens = promptKeys.reduce((total, key) => total + estimate.breakdown[key], 0);
  const ratio = estimatedPromptTokens > 0 ? promptTokens / estimatedPromptTokens : 1;
  const breakdown = { ...estimate.breakdown };
  for (const key of promptKeys) {
    breakdown[key] = Math.max(0, Math.floor(breakdown[key] * ratio));
  }
  const scaledTotal = promptKeys.reduce((total, key) => total + breakdown[key], 0);
  const adjustmentKey: keyof ContextUsageBreakdown = 'historyTokensEstimate';
  breakdown[adjustmentKey] = Math.max(0, breakdown[adjustmentKey] + promptTokens - scaledTotal);
  return normalizeContextUsageEstimate({
    maxTokensEstimate: estimate.maxTokensEstimate,
    usedTokensEstimate: promptTokens
      + breakdown.outputReserveTokensEstimate
      + breakdown.safetyReserveTokensEstimate,
    breakdown
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

  return normalizeContextUsageEstimate({
    maxTokensEstimate: usage.maxTokensEstimate,
    usedTokensEstimate: sumSessionBreakdownTokens(breakdown),
    breakdown
  });
}

export function finalizeSessionContextUsageEstimate(usage: ContextUsageEstimate): ContextUsageEstimate {
  const breakdown = normalizeBreakdown({
    ...usage.breakdown,
    historyTokensEstimate: usage.breakdown.historyTokensEstimate + usage.breakdown.inputTokensEstimate,
    inputTokensEstimate: 0
  });
  return normalizeContextUsageEstimate({
    maxTokensEstimate: usage.maxTokensEstimate,
    usedTokensEstimate: sumSessionBreakdownTokens(breakdown),
    breakdown
  });
}

export function addInputTokensToContextUsage(
  usage: ContextUsageEstimate,
  inputTokensEstimate: number
): ContextUsageEstimate {
  const inputTokens = normalizeTokenEstimate(inputTokensEstimate);
  const breakdown = normalizeBreakdown({
    ...usage.breakdown,
    inputTokensEstimate: inputTokens
  });
  return normalizeContextUsageEstimate({
    maxTokensEstimate: usage.maxTokensEstimate,
    usedTokensEstimate: usage.usedTokensEstimate + inputTokens,
    breakdown
  });
}

export function pickLargerContextUsageEstimate(
  left: ContextUsageEstimate | undefined,
  right: ContextUsageEstimate | undefined
): ContextUsageEstimate | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.usedTokensEstimate >= right.usedTokensEstimate ? left : right;
}

export function normalizeContextUsageEstimateValue(value: unknown): ContextUsageEstimate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return normalizeContextUsageEstimate({
    maxTokensEstimate: readFiniteNumber(value.maxTokensEstimate, 0),
    usedTokensEstimate: readFiniteNumber(value.usedTokensEstimate, 0),
    breakdown: isRecord(value.breakdown) ? value.breakdown : {}
  });
}

export function resolveOutputReserveTokens(maxTokens: number): number {
  return Math.max(0, Math.floor(maxTokens));
}

function estimateInitialBreakdown(input: {
  messages: DeepSeekMessage[];
  contextFiles: ContextFile[];
  currentRunContext?: CurrentRunContext;
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
      language: input.language
    })
  );

  const dynamicContextContent = [
    formatAgentContextFiles({
      contextFiles: input.contextFiles,
      language: input.language
    }),
    formatActiveSkills({
      skills: input.currentRunContext?.skills,
      language: input.language
    }),
    formatProjectInstructionsForAgent(input.currentRunContext, input.language),
    formatLegacyMemoryForAgent(input.currentRunContext?.legacyMemory, input.language)
  ].filter(Boolean).join('\n\n');

  breakdown.systemTokensEstimate = Math.min(fullSystemTokens, systemOnlyTokens);
  breakdown.contextFileTokensEstimate = dynamicContextContent
    ? estimateChatMessageTokens('user', dynamicContextContent)
    : 0;
  breakdown.toolSchemaTokensEstimate = estimateDeepSeekToolsTokens(input.tools);
  breakdown.outputReserveTokensEstimate = input.outputReserveTokens;
  breakdown.safetyReserveTokensEstimate = input.safetyReserveTokens;

  const promptIndex = findPromptMessageIndex(input.messages, input.prompt);
  for (let index = 1; index < input.messages.length; index += 1) {
    const message = input.messages[index];
    const tokens = estimateDeepSeekMessageTokens(message);
    if (index === promptIndex) {
      breakdown.inputTokensEstimate += Math.max(0, tokens - breakdown.contextFileTokensEstimate);
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
    if (message.role === 'user') {
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

function readFiniteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sumSessionBreakdownTokens(breakdown: ContextUsageBreakdown): number {
  return breakdown.contextFileTokensEstimate +
    breakdown.historyTokensEstimate +
    breakdown.inputTokensEstimate +
    breakdown.toolCallTokensEstimate +
    breakdown.toolResultTokensEstimate +
    breakdown.reasoningTokensEstimate;
}

function normalizeKnownProvider(value: string): ModelSourceProvider | undefined {
  return value === 'deepseek'
    || value === 'kimi'
    || value === 'glm'
    || value === 'ollama'
    || value === 'openai-compatible'
    || value === 'openai-responses'
    || value === 'anthropic-compatible'
    ? value
    : undefined;
}
