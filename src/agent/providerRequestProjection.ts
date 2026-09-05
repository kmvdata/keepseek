import type { KeepseekLanguage } from '../shared/i18n';
import type { ModelSourceProvider } from '../accounts/types';
import type {
  AgentSettings,
  ChatMessage,
  ContextCompressionState,
  ContextFile,
  CurrentRunContext,
  KeepseekModel
} from '../shared/types';
import { getConfiguredSlimToolModeEnabled } from '../shared/config';
import {
  getAgentRuntimeProfile,
  type AgentRuntimeProfile
} from '../shared/modelProfiles';
import type { DeepSeekFunctionTool, DeepSeekMessage } from './deepseek/types';
import type {
  OpenAiResponsesFunctionTool,
  OpenAiResponsesItem
} from './providers/responsesTypes';
import { getOpenAiResponsesEndpointUrl } from './providers/openAiResponsesClient';
import { getAnthropicMessagesEndpointUrl } from './providers/anthropicMessagesClient';
import type {
  AnthropicFunctionTool,
  AnthropicMessage,
  AnthropicSystemTextBlock
} from './providers/anthropicTypes';
import { buildHistoryProjection, type HistoryProjectionResult } from './historyProjection';
import {
  buildInitialAgentMessages,
  getMessageContentForAgent,
  getAgentToolNamesForPrompt,
  getAgentTools
} from './protocol';

export const CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION = 6;
export const LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION = 1;
export const PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION = 2;
export const CURRENT_PROVIDER_TOOL_SCHEMA_VERSION = 6;

export interface ProviderRequestProjectionInput {
  model: KeepseekModel;
  agentSettings: AgentSettings;
  contextFiles: ContextFile[];
  currentRunContext?: CurrentRunContext;
  contextInstructions?: string;
  history: ChatMessage[];
  contextCompression?: ContextCompressionState;
  language: KeepseekLanguage;
  prompt: string;
  slimToolNames?: string[];
  requestProtocolVersion?: number;
  systemPrompt?: string;
  includeTools?: boolean;
  maxProjectionTokens?: number;
  provider?: ModelSourceProvider;
  sourceId?: string;
  baseUrl?: string;
}

export interface OpenAiResponsesRequestProjection {
  input: OpenAiResponsesItem[];
  tools: OpenAiResponsesFunctionTool[];
  lane: {
    sourceId: string;
    baseUrl: string;
  };
}

export interface AnthropicMessagesRequestProjection {
  system: AnthropicSystemTextBlock[];
  messages: AnthropicMessage[];
  tools: AnthropicFunctionTool[];
  lane: {
    sourceId: string;
    baseUrl: string;
  };
}

export interface ProviderRequestProjection {
  runtimeProfile: AgentRuntimeProfile;
  messages: DeepSeekMessage[];
  tools: DeepSeekFunctionTool[];
  toolNames: string[];
  historyProjection: HistoryProjectionResult;
  requestProtocolVersion: number;
  responses?: OpenAiResponsesRequestProjection;
  anthropic?: AnthropicMessagesRequestProjection;
}

export type ProviderRequestProtocolLane = 'chat-completions' | 'openai-responses' | 'anthropic-messages';

export interface ProviderRequestLane {
  protocol: ProviderRequestProtocolLane;
  sourceId: string;
  endpointLane: string;
  modelId: string;
}

export function getProviderRequestLane(input: {
  provider: ModelSourceProvider;
  sourceId: string;
  baseUrl: string;
  modelId: string;
}): ProviderRequestLane {
  const protocol: ProviderRequestProtocolLane = input.provider === 'openai-responses'
    ? 'openai-responses'
    : input.provider === 'anthropic-compatible'
      ? 'anthropic-messages'
      : 'chat-completions';
  return {
    protocol,
    sourceId: input.sourceId.trim(),
    endpointLane: protocol === 'openai-responses'
      ? normalizeOpenAiResponsesLaneBaseUrl(input.baseUrl)
      : protocol === 'anthropic-messages'
        ? normalizeAnthropicMessagesLaneBaseUrl(input.baseUrl)
        : normalizeChatCompletionsLaneBaseUrl(input.baseUrl),
    modelId: input.modelId.trim()
  };
}

/**
 * Mirrors the native replay checks used by the request projection. Ordinary
 * Chat Completions toolRounds are intentionally ignored because they remain
 * replayable through the shared message projection.
 */
export function hasProviderNativeReplayFidelityRisk(
  messages: readonly ChatMessage[],
  targetLane: ProviderRequestLane
): boolean {
  return messages.some((message) => {
    const replay = message.providerReplay;
    if (!replay) {
      return false;
    }
    if (replay.protocol === 'openai-responses') {
      return targetLane.protocol !== 'openai-responses'
        || replay.sourceId !== targetLane.sourceId
        || normalizeOpenAiResponsesLaneBaseUrl(replay.baseUrl) !== targetLane.endpointLane;
    }
    return targetLane.protocol !== 'anthropic-messages'
      || replay.sourceId !== targetLane.sourceId
      || normalizeAnthropicMessagesLaneBaseUrl(replay.baseUrl) !== targetLane.endpointLane;
  });
}

/**
 * The one authoritative projection of persisted KeepSeek state into a provider
 * request. Runner, context accounting, compaction decisions, hard limits and
 * cache-prefix tests must consume this result instead of rebuilding messages or
 * tool schemas independently.
 */
export function buildProviderRequestProjection(
  input: ProviderRequestProjectionInput
): ProviderRequestProjection {
  const profile = getAgentRuntimeProfile(input.model, input.agentSettings);
  const requestProtocolVersion = normalizeRequestProtocolVersion(input.requestProtocolVersion);
  const provider = input.provider ?? (
    input.model.provider === 'openai-responses' || input.model.provider === 'anthropic-compatible'
      ? input.model.provider
      : undefined
  );
  const historyProjection = buildHistoryProjection({
    history: input.history,
    prompt: input.prompt,
    language: input.language,
    contextCompression: input.contextCompression,
    settings: profile.contextCompression,
    requestProtocolVersion,
    maxProjectionTokens: input.maxProjectionTokens,
    includeProviderReplay: provider === 'openai-responses' || provider === 'anthropic-compatible'
  });
  const messages = buildInitialAgentMessages({
    prompt: input.prompt,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    contextInstructions: input.contextInstructions,
    history: input.history,
    language: input.language,
    projection: historyProjection,
    requestProtocolVersion,
    systemPrompt: input.systemPrompt
  });
  const includeTools = input.includeTools ?? profile.maxToolIterations > 0;
  const toolNames = includeTools
    ? [...(input.slimToolNames ?? getAgentToolNamesForPrompt(
        input.prompt,
        getConfiguredSlimToolModeEnabled(),
        requestProtocolVersion
      ))]
    : [];
  const tools = includeTools ? getAgentTools({ toolNames, requestProtocolVersion }) : [];
  const responses = provider === 'openai-responses'
    ? buildOpenAiResponsesRequestProjection({
        messages,
        tools,
        history: historyProjection.history,
        prompt: input.prompt,
        sourceId: input.sourceId ?? input.model.sourceId ?? '',
        baseUrl: input.baseUrl ?? ''
      })
    : undefined;
  const anthropic = provider === 'anthropic-compatible'
    ? buildAnthropicMessagesRequestProjection({
        messages,
        tools,
        history: historyProjection.history,
        prompt: input.prompt,
        sourceId: input.sourceId ?? input.model.sourceId ?? '',
        baseUrl: input.baseUrl ?? ''
      })
    : undefined;

  return {
    runtimeProfile: profile,
    messages,
    tools,
    toolNames,
    historyProjection,
    requestProtocolVersion,
    responses,
    anthropic
  };
}

function buildAnthropicMessagesRequestProjection(input: {
  messages: DeepSeekMessage[];
  tools: DeepSeekFunctionTool[];
  history: ChatMessage[];
  prompt: string;
  sourceId: string;
  baseUrl: string;
}): AnthropicMessagesRequestProjection {
  const lane = {
    sourceId: input.sourceId,
    baseUrl: normalizeAnthropicMessagesLaneBaseUrl(input.baseUrl)
  };
  const system: AnthropicSystemTextBlock[] = [];
  for (const message of input.messages) {
    if (message.role === 'system' && typeof message.content === 'string' && message.content) {
      system.push({ type: 'text', text: message.content });
    }
  }
  const messages: AnthropicMessage[] = [];
  const normalizedPrompt = input.prompt.trim();
  let currentPromptIncluded = false;

  for (const message of input.history) {
    if (message.role === 'user') {
      const content = getMessageContentForAgent(message);
      if (!content) continue;
      messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
      const originalContent = (message.expandedContent ?? message.content).trim();
      currentPromptIncluded = currentPromptIncluded || Boolean(normalizedPrompt
        && (content === normalizedPrompt
          || originalContent === normalizedPrompt
          || message.content.trim() === normalizedPrompt));
      continue;
    }

    if (isAnthropicReplayInLane(message, lane)) {
      if (message.providerReplay?.protocol === 'anthropic-messages') {
        for (const replayMessage of message.providerReplay.messages) {
          messages.push(replayMessage.role === 'assistant'
            ? { role: 'assistant', content: replayMessage.content }
            : { role: 'user', content: replayMessage.content });
        }
      }
      continue;
    }

    const visibleContent = getMessageContentForAgent(message);
    if (visibleContent) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: visibleContent }] });
    }
  }
  if (normalizedPrompt && !currentPromptIncluded) {
    messages.push({ role: 'user', content: [{ type: 'text', text: normalizedPrompt }] });
  }
  return {
    system,
    messages,
    tools: toAnthropicTools(input.tools),
    lane
  };
}

function buildOpenAiResponsesRequestProjection(input: {
  messages: DeepSeekMessage[];
  tools: DeepSeekFunctionTool[];
  history: ChatMessage[];
  prompt: string;
  sourceId: string;
  baseUrl: string;
}): OpenAiResponsesRequestProjection {
  const lane = {
    sourceId: input.sourceId,
    baseUrl: normalizeOpenAiResponsesLaneBaseUrl(input.baseUrl)
  };
  const responseInput: OpenAiResponsesItem[] = [];

  // System/context/summary messages are already ordered by the authoritative
  // Chat projection. They contain no tool rounds, so projecting just this stable
  // prefix cannot alter the legacy Chat Completions serialization.
  for (const message of input.messages) {
    if (message.role !== 'system' || typeof message.content !== 'string' || !message.content) {
      continue;
    }
    responseInput.push({ role: 'system', content: message.content });
  }

  let currentPromptIncluded = false;
  const normalizedPrompt = input.prompt.trim();
  for (const message of input.history) {
    if (message.role === 'user') {
      const content = getMessageContentForAgent(message);
      if (!content) {
        continue;
      }
      responseInput.push({ role: 'user', content });
      const originalContent = (message.expandedContent ?? message.content).trim();
      currentPromptIncluded = currentPromptIncluded || Boolean(normalizedPrompt
        && (content === normalizedPrompt
          || originalContent === normalizedPrompt
          || message.content.trim() === normalizedPrompt));
      continue;
    }

    if (isReplayInLane(message, lane)) {
      // Persisted objects are appended without rebuilding or key reordering.
      responseInput.push(...message.providerReplay?.protocol === 'openai-responses'
        ? message.providerReplay.items
        : []);
      continue;
    }

    const visibleContent = getMessageContentForAgent(message);
    if (visibleContent) {
      // At a provider-lane boundary only visible text survives. Standard
      // toolRounds and orphan function outputs must not cross the boundary.
      responseInput.push({ role: 'assistant', content: visibleContent });
    }
  }

  if (normalizedPrompt && !currentPromptIncluded) {
    responseInput.push({ role: 'user', content: normalizedPrompt });
  }

  return {
    input: responseInput,
    tools: toOpenAiResponsesTools(input.tools),
    lane
  };
}

export function toOpenAiResponsesTools(
  tools: DeepSeekFunctionTool[]
): OpenAiResponsesFunctionTool[] {
  return tools.map((tool) => ({
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: tool.function.strict ?? false
    }));
}

export function toAnthropicTools(tools: DeepSeekFunctionTool[]): AnthropicFunctionTool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    ...(tool.function.strict === undefined ? {} : { strict: tool.function.strict })
  }));
}

function isAnthropicReplayInLane(
  message: ChatMessage,
  lane: AnthropicMessagesRequestProjection['lane']
): boolean {
  return message.providerReplay?.protocol === 'anthropic-messages'
    && message.providerReplay.sourceId === lane.sourceId
    && normalizeAnthropicMessagesLaneBaseUrl(message.providerReplay.baseUrl) === lane.baseUrl;
}

function isReplayInLane(
  message: ChatMessage,
  lane: OpenAiResponsesRequestProjection['lane']
): boolean {
  return message.providerReplay?.protocol === 'openai-responses'
    && message.providerReplay.sourceId === lane.sourceId
    && normalizeOpenAiResponsesLaneBaseUrl(message.providerReplay.baseUrl) === lane.baseUrl;
}

export function normalizeOpenAiResponsesLaneBaseUrl(rawBaseUrl: string): string {
  try {
    return getOpenAiResponsesEndpointUrl(rawBaseUrl).replace(/#.*$/u, '');
  } catch {
    return rawBaseUrl.trim().replace(/\/+$/u, '');
  }
}

export function normalizeAnthropicMessagesLaneBaseUrl(rawBaseUrl: string): string {
  try {
    return getAnthropicMessagesEndpointUrl(rawBaseUrl).replace(/#.*$/u, '');
  } catch {
    return rawBaseUrl.trim().replace(/\/+$/u, '');
  }
}

export function normalizeChatCompletionsLaneBaseUrl(rawBaseUrl: string): string {
  return rawBaseUrl.trim().replace(/\/+$/u, '').replace(/#.*$/u, '');
}

function normalizeRequestProtocolVersion(value: number | undefined): number {
  const normalized = Number.isFinite(value) ? Math.floor(Number(value)) : LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION;
  if (normalized >= CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION) {
    return CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION;
  }
  if (normalized >= 5) return 5;
  if (normalized >= 4) {
    return 4;
  }
  if (normalized >= 3) {
    return 3;
  }
  return normalized >= PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION
    ? PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION
    : LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION;
}
