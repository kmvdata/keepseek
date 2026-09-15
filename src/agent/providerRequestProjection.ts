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
import { endpointHash } from './runCheckpoint';
import { buildHistoryProjection, type HistoryProjectionResult } from './historyProjection';
import {
  buildInitialAgentMessages,
  getMessageContentForAgent,
  getAgentToolNamesForPrompt,
  getAgentTools
} from './protocol';

export const CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION = 9;
/** V10 is opt-in for active Goal sessions. Ordinary session creation remains v9. */
export const GOAL_PROVIDER_REQUEST_PROTOCOL_VERSION = 10;
export const LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION = 1;
export const PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION = 2;
export const CURRENT_PROVIDER_TOOL_SCHEMA_VERSION = 9;

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
  const initialMessages = buildInitialAgentMessages({
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
  const goalReplayAnchor = requestProtocolVersion >= GOAL_PROVIDER_REQUEST_PROTOCOL_VERSION
    ? findGoalReplayAnchor(input.history, provider ?? 'openai-compatible', input.sourceId ?? input.model.sourceId ?? '', input.baseUrl ?? '')
    : undefined;
  const messages = goalReplayAnchor?.replay.protocol === 'chat-completions'
    ? appendChatHistoryAfterGoalReplay(goalReplayAnchor.replay.messages, input.history.slice(goalReplayAnchor.index + 1), input.prompt, requestProtocolVersion)
    : initialMessages;
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
    ? goalReplayAnchor?.replay.protocol === 'openai-responses'
      ? buildOpenAiResponsesAfterGoalReplay({
          replayInput: goalReplayAnchor.replay.input,
          tools,
          history: input.history.slice(goalReplayAnchor.index + 1),
          prompt: input.prompt,
          sourceId: input.sourceId ?? input.model.sourceId ?? '',
          baseUrl: input.baseUrl ?? ''
        })
      : buildOpenAiResponsesRequestProjection({
        messages,
        tools,
        history: historyProjection.history,
        prompt: input.prompt,
        sourceId: input.sourceId ?? input.model.sourceId ?? '',
        baseUrl: input.baseUrl ?? ''
      })
    : undefined;
  const anthropic = provider === 'anthropic-compatible'
    ? goalReplayAnchor?.replay.protocol === 'anthropic-messages'
      ? buildAnthropicAfterGoalReplay({
          replaySystem: goalReplayAnchor.replay.system,
          replayMessages: goalReplayAnchor.replay.messages,
          tools,
          history: input.history.slice(goalReplayAnchor.index + 1),
          prompt: input.prompt,
          sourceId: input.sourceId ?? input.model.sourceId ?? '',
          baseUrl: input.baseUrl ?? ''
        })
      : buildAnthropicMessagesRequestProjection({
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

function findGoalReplayAnchor(
  history: ChatMessage[],
  provider: ModelSourceProvider,
  sourceId: string,
  baseUrl: string
): { index: number; replay: NonNullable<ChatMessage['goalReplay']> } | undefined {
  const protocol = provider === 'openai-responses' ? 'openai-responses'
    : provider === 'anthropic-compatible' ? 'anthropic-messages' : 'chat-completions';
  const expectedEndpointHash = endpointHash(baseUrl);
  for (let index = history.length - 1; index >= 0; index--) {
    const replay = history[index].goalReplay;
    if (replay?.protocol === protocol && replay.sourceId === sourceId && replay.endpointHash === expectedEndpointHash) {
      return { index, replay };
    }
  }
  return undefined;
}

function appendChatHistoryAfterGoalReplay(
  replayMessages: DeepSeekMessage[],
  history: ChatMessage[],
  prompt: string,
  requestProtocolVersion: number
): DeepSeekMessage[] {
  const messages = structuredClone(replayMessages);
  let promptIncluded = false;
  const normalizedPrompt = prompt.trim();
  for (const message of history) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    if (message.role === 'assistant') {
      for (const round of message.toolRounds ?? []) {
        messages.push({ role: 'assistant', content: round.assistantContent,
          reasoning_content: round.reasoningContent, tool_calls: structuredClone(round.toolCalls) });
        for (const result of round.toolResults) {
          messages.push({ role: 'tool', tool_call_id: result.toolCallId, content: result.content });
        }
      }
      messages.push({ role: 'assistant', content: getMessageContentForAgent(message),
        ...(requestProtocolVersion <= 1 ? { reasoning_content: message.reasoningContent ?? null } : {}) });
      continue;
    }
    const content = getMessageContentForAgent(message);
    if (!content) continue;
    messages.push({ role: 'user', content });
    promptIncluded = promptIncluded || content === normalizedPrompt
      || (message.expandedContent ?? message.content).trim() === normalizedPrompt
      || message.content.trim() === normalizedPrompt;
  }
  if (normalizedPrompt && !promptIncluded) messages.push({ role: 'user', content: normalizedPrompt });
  return messages;
}

function buildOpenAiResponsesAfterGoalReplay(input: {
  replayInput: OpenAiResponsesItem[]; tools: DeepSeekFunctionTool[]; history: ChatMessage[];
  prompt: string; sourceId: string; baseUrl: string;
}): OpenAiResponsesRequestProjection {
  const responseInput = structuredClone(input.replayInput);
  let promptIncluded = false;
  const normalizedPrompt = input.prompt.trim();
  const lane = { sourceId: input.sourceId, baseUrl: normalizeOpenAiResponsesLaneBaseUrl(input.baseUrl) };
  for (const message of input.history) {
    if (message.role === 'user') {
      const content = getMessageContentForAgent(message); if (!content) continue;
      responseInput.push({ role: 'user', content });
      promptIncluded = promptIncluded || content === normalizedPrompt
        || (message.expandedContent ?? message.content).trim() === normalizedPrompt
        || message.content.trim() === normalizedPrompt;
    } else if (isReplayInLane(message, lane) && message.providerReplay?.protocol === 'openai-responses') {
      responseInput.push(...structuredClone(message.providerReplay.items));
    } else {
      const content = getMessageContentForAgent(message); if (content) responseInput.push({ role: 'assistant', content });
    }
  }
  if (normalizedPrompt && !promptIncluded) responseInput.push({ role: 'user', content: normalizedPrompt });
  return { input: responseInput, tools: toOpenAiResponsesTools(input.tools), lane };
}

function buildAnthropicAfterGoalReplay(input: {
  replaySystem: AnthropicSystemTextBlock[]; replayMessages: AnthropicMessage[]; tools: DeepSeekFunctionTool[];
  history: ChatMessage[]; prompt: string; sourceId: string; baseUrl: string;
}): AnthropicMessagesRequestProjection {
  const messages = structuredClone(input.replayMessages);
  let promptIncluded = false;
  const normalizedPrompt = input.prompt.trim();
  const lane = { sourceId: input.sourceId, baseUrl: normalizeAnthropicMessagesLaneBaseUrl(input.baseUrl) };
  for (const message of input.history) {
    if (message.role === 'user') {
      const content = getMessageContentForAgent(message); if (!content) continue;
      messages.push({ role: 'user', content: [{ type: 'text', text: content }] });
      promptIncluded = promptIncluded || content === normalizedPrompt
        || (message.expandedContent ?? message.content).trim() === normalizedPrompt
        || message.content.trim() === normalizedPrompt;
    } else if (isAnthropicReplayInLane(message, lane) && message.providerReplay?.protocol === 'anthropic-messages') {
      messages.push(...structuredClone(message.providerReplay.messages));
    } else {
      const content = getMessageContentForAgent(message); if (content) messages.push({ role: 'assistant', content: [{ type: 'text', text: content }] });
    }
  }
  if (normalizedPrompt && !promptIncluded) messages.push({ role: 'user', content: [{ type: 'text', text: normalizedPrompt }] });
  return { system: structuredClone(input.replaySystem), messages, tools: toAnthropicTools(input.tools), lane };
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
  if (normalized >= GOAL_PROVIDER_REQUEST_PROTOCOL_VERSION) {
    return GOAL_PROVIDER_REQUEST_PROTOCOL_VERSION;
  }
  if (normalized >= CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION) {
    return CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION;
  }
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
