import type { KeepseekLanguage } from '../shared/i18n';
import type {
  AgentSettings,
  ChatMessage,
  ContextCompressionState,
  ContextFile,
  CurrentRunContext,
  KeepseekModel
} from '../shared/types';
import { getConfiguredSlimToolModeEnabled } from '../shared/config';
import { getDeepSeekV4RuntimeProfile } from '../shared/modelProfiles';
import type { DeepSeekFunctionTool, DeepSeekMessage } from './deepseek/types';
import { buildHistoryProjection, type HistoryProjectionResult } from './historyProjection';
import {
  buildInitialAgentMessages,
  getAgentToolNamesForPrompt,
  getAgentTools
} from './protocol';

export const CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION = 2;
export const LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION = 1;
export const CURRENT_PROVIDER_TOOL_SCHEMA_VERSION = 2;

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
  includeTools?: boolean;
  maxProjectionTokens?: number;
}

export interface ProviderRequestProjection {
  messages: DeepSeekMessage[];
  tools: DeepSeekFunctionTool[];
  toolNames: string[];
  historyProjection: HistoryProjectionResult;
  requestProtocolVersion: number;
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
  const profile = getDeepSeekV4RuntimeProfile(input.model, input.agentSettings);
  const requestProtocolVersion = normalizeRequestProtocolVersion(input.requestProtocolVersion);
  const historyProjection = buildHistoryProjection({
    history: input.history,
    prompt: input.prompt,
    language: input.language,
    contextCompression: input.contextCompression,
    settings: profile.contextCompression,
    requestProtocolVersion,
    maxProjectionTokens: input.maxProjectionTokens
  });
  const messages = buildInitialAgentMessages({
    prompt: input.prompt,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    contextInstructions: input.contextInstructions,
    history: input.history,
    language: input.language,
    projection: historyProjection,
    requestProtocolVersion
  });
  const includeTools = input.includeTools ?? profile.maxToolIterations > 0;
  const toolNames = includeTools
    ? [...(input.slimToolNames ?? getAgentToolNamesForPrompt(
        input.prompt,
        getConfiguredSlimToolModeEnabled(),
        requestProtocolVersion
      ))]
    : [];
  const tools = includeTools ? getAgentTools({ toolNames }) : [];

  return {
    messages,
    tools,
    toolNames,
    historyProjection,
    requestProtocolVersion
  };
}

function normalizeRequestProtocolVersion(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION
    ? CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION
    : LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION;
}
