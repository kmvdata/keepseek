import type { KeepseekLanguage } from '../shared/i18n';
import type { ProviderClientRequest } from './providers/types';
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

export const CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION = 10;
export const LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION = 1;
export const PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION = 2;
export const CURRENT_PROVIDER_TOOL_SCHEMA_VERSION = 10;

/** Final context surface shared by dispatch, candidate admission and usage.
 * Candidate results are explicit additions; native replay is never rebuilt or
 * converted to another protocol here. Non-context sampling/output options are
 * applied by dispatch after this projection. */
export function buildProviderPayloadProjection(input: {
  modelId: string; maxOutputTokens: number; provider?: string; messages: DeepSeekMessage[]; tools: DeepSeekFunctionTool[];
  native?: { protocol: 'openai-responses'; input: OpenAiResponsesItem[]; tools: OpenAiResponsesFunctionTool[] }
    | { protocol: 'anthropic-messages'; system: AnthropicSystemTextBlock[]; messages: AnthropicMessage[]; tools: AnthropicFunctionTool[] };
  additionalResponsesItems?: OpenAiResponsesItem[];
  additionalAnthropicResults?: import('./providers/anthropicTypes').AnthropicUserContentBlock[];
}): ProviderClientRequest['body'] {
  const native = input.native;
  if (input.provider === 'openai-responses') {
    if (native?.protocol !== 'openai-responses') throw new Error('Responses projection lane mismatch');
    return { model: input.modelId, input: input.additionalResponsesItems?.length
      ? [...native.input, ...input.additionalResponsesItems] : native.input,
      tools: native.tools.length ? native.tools : undefined, stream: true, store: false };
  }
  if (input.provider === 'anthropic-compatible') {
    if (native?.protocol !== 'anthropic-messages') throw new Error('Anthropic projection lane mismatch');
    return { model: input.modelId, system: native.system, messages: input.additionalAnthropicResults?.length
      ? [...native.messages, { role: 'user', content: input.additionalAnthropicResults }] : native.messages,
      tools: native.tools.length ? native.tools : undefined, stream: true, max_tokens: input.maxOutputTokens };
  }
  if (native) throw new Error('Native replay cannot enter the chat-completions lane');
  return { model: input.modelId, messages: normalizeProviderMessages(input.messages, input.provider),
    tools: input.tools.length ? input.tools : undefined, stream: true };
}

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
  const provider = input.provider ?? input.model.provider;
  const lane = getProviderRequestLane({ provider: input.provider ?? (provider === 'openai-responses' || provider === 'anthropic-compatible' ? provider : 'openai-compatible'),
    sourceId: input.sourceId ?? input.model.sourceId ?? '', baseUrl: input.baseUrl ?? '', modelId: input.model.id });
  // History fallback admission must also see only bytes eligible for this
  // source/lane. The persisted audit objects remain untouched.
  const wireHistory = input.history.map(message => {
    const stripReasoning = provider && provider !== 'deepseek';
    const stripReplay = message.providerReplay && hasProviderNativeReplayFidelityRisk([message], lane);
    if (!stripReasoning && !stripReplay) return message;
    return { ...message, ...(stripReasoning ? { reasoningContent: undefined,
      toolRounds: message.toolRounds?.map(round => ({ ...round, reasoningContent: null })) } : {}),
      ...(stripReplay ? { providerReplay: undefined } : {}) };
  });
  const historyProjection = buildHistoryProjection({
    history: wireHistory,
    prompt: input.prompt,
    language: input.language,
    contextCompression: input.contextCompression,
    settings: profile.contextCompression,
    requestProtocolVersion,
    maxProjectionTokens: input.maxProjectionTokens,
    includeProviderReplay: provider === 'openai-responses' || provider === 'anthropic-compatible'
  });
  const messages = normalizeProviderMessages(buildInitialAgentMessages({
    prompt: input.prompt,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    contextInstructions: input.contextInstructions,
    history: input.history,
    language: input.language,
    projection: historyProjection,
    requestProtocolVersion,
    systemPrompt: input.systemPrompt
  }), provider);
  // Tool exposure is an execution capability, not a model capability or a
  // budget sentinel. Callers that need a no-tools lane must say so explicitly.
  const includeTools = input.includeTools ?? true;
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

/** Final Chat lane adaptation, shared by initial projection, live tool turns,
 * admission and transport. Never mutate audit history or DeepSeek prefix bytes. */
export function normalizeProviderMessages(messages: DeepSeekMessage[], provider?: string): DeepSeekMessage[] {
  if (!provider || provider === 'deepseek') return messages;
  return messages.map((message) => {
    if (message.role !== 'assistant' || !Object.prototype.hasOwnProperty.call(message, 'reasoning_content')) return message;
    const portable = { ...message };
    delete portable.reasoning_content;
    return portable;
  });
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
  if (normalized >= 9) return 9;
  if (normalized >= 8) return 8;
  if (normalized >= 7) return 7;
  if (normalized >= 6) return 6;
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
