import * as vscode from 'vscode';
import { mergeDurations, normalizeCostLimit, normalizeDuration } from '../agent/executionPolicy';
import {
  AgentSettings,
  CompressionThreshold,
  KeepseekModel,
  ModelSelection,
  UsageCostRates,
  ValidationAuthorizationPolicy
} from './types';
import { SESSION_HARD_RETENTION_DAYS } from '../sessions/sessionRetention';
import {
  getEffectiveContextWindowTokens,
  getSupportedDeepSeekV4Models
} from './modelProfiles';
import { isOfficialDeepSeekSource } from '../accounts/sourceCapabilities';
import { resolveProjectModel } from '../accounts/modelCatalog';
import {
  DEEPSEEK_FLASH_PRICING_KEY,
  DEEPSEEK_PRO_PRICING_KEY,
  getCanonicalPricingKey
} from './deepSeekModels';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_WORKSPACE_TOOL_FILE_LIMIT = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 200_000;
export const DEFAULT_PATCH_MAX_PAYLOAD_BYTES = 1_048_576;
export const DEFAULT_PATCH_MAX_HUNKS = 256;
export const DEFAULT_PATCH_MAX_CHANGED_BYTES = 2_097_152;
export const DEFAULT_PATCH_MAX_INLINE_BYTES = 65_536;
export const DEFAULT_PATCH_MAX_PROVIDER_BUFFER_BYTES = 16_777_216;
export const DEFAULT_PATCH_MAX_BACKUP_BYTES = 33_554_432;
export const DEFAULT_PATCH_MAX_CHANGE_SET_ARTIFACT_BYTES = 134_217_728;
export const DEFAULT_PATCH_BLOB_STORE_QUOTA_BYTES = 1_073_741_824;
export const DEFAULT_PATCH_MAX_DIFF_BYTES = 4_194_304;
export const DEFAULT_PROVIDER_INLINE_RESULT_MAX_CHARS = 48_000;
export const DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES = 10_240;
export const DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES = 20_480;
export const DEFAULT_EVIDENCE_MAX_BYTES = 100_000_000;
export const DEFAULT_AGENT_MAX_COST = 0;
export const DEFAULT_AGENT_MAX_EXECUTION_MS = 0;
export const DEFAULT_SUBAGENT_MAX_EXECUTION_MS = 5 * 60 * 1000;
export const DEFAULT_AGENT_MAX_TOOL_ITERATIONS = 0;
export const DEFAULT_AGENT_MAX_TOOL_CALLS = 0;
export const DEFAULT_AGENT_MAX_MODEL_REQUESTS = 0;
export const DEFAULT_SUBAGENT_MAX_MODEL_REQUESTS = 12;
export const DEFAULT_AGENT_MAX_CONTINUATIONS = 1;
export const DEFAULT_AGENT_MAX_CONTEXT_EPOCH_ROLLOVERS = 0;
export const DEFAULT_SUBAGENT_MAX_CONTEXT_EPOCH_ROLLOVERS = 3;
export const DEFAULT_AGENT_MAX_TREE_UPSTREAM_TOKENS = 0;
export const DEFAULT_SUBAGENT_MAX_UPSTREAM_TOKENS = 500_000;
export const DEFAULT_AGENT_TOOL_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_AGENT_FINAL_MAX_OUTPUT_TOKENS = 16_384;
export const DEFAULT_AGENT_CONTINUATION_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_AGENT_REPAIR_MAX_OUTPUT_TOKENS = 4_096;
export const DEFAULT_DRAFT_RUN_TIMEOUT_MS = 120_000;
export const DEFAULT_DRAFT_RUN_MAX_TRANSCRIPT_BYTES = 131_072;
export const DEFAULT_MAX_REQUEST_RETRIES = 2;
export const DEFAULT_REQUEST_RETRY_BASE_MS = 1_000;
export const DEFAULT_SELECTED_MODEL_ID = '';
export const DEFAULT_SELECTED_SOURCE_ID = '';
export const DEFAULT_HISTORY_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_ENABLED = false;
export const DEFAULT_TRACE_LEVEL: InteractionTraceLevel = 'full';
export const DEFAULT_TRACE_LOG_RAW_STREAM = true;
export const DEFAULT_TRACE_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_MAX_FILE_BYTES = 20_000_000;
export const DEFAULT_BALANCE_ENDPOINT_URL = '';
export const DEFAULT_BALANCE_REFRESH_INTERVAL_MS = 60_000;
// Default off for prompt-cache stability: the exposed tool set must not vary with
// the prompt text, otherwise the tools section of the request prefix changes and
// DeepSeek's prefix cache (byte-identical from token 0) is invalidated. Users can
// opt into the smaller schema explicitly.
export const DEFAULT_SLIM_TOOL_MODE_ENABLED = false;
/** Conservative DeepSeek prompt-cache boundary used before rewriting persisted history. */
export const DEFAULT_PROMPT_CACHE_TTL_MINUTES = 24 * 60;
export const DEFAULT_TOTAL_CONTEXT_BUDGET_TOKENS = 32_000;
export const DEFAULT_COMPRESSION_THRESHOLD: CompressionThreshold = 'balanced';
export const DEFAULT_VALIDATION_AUTHORIZATION_POLICY: ValidationAuthorizationPolicy = 'always';
export const DEFAULT_MAX_VALIDATION_RUNS = 3;
export const DEFAULT_MAX_REPAIR_ITERATIONS = 2;
export const DEFAULT_VALIDATION_TIMEOUT_MS = 120_000;
export const DEFAULT_PROJECT_INSTRUCTIONS_CONTEXT_BUDGET_TOKENS = 4_000;
export const DEFAULT_SKILL_CONTEXT_BUDGET_CHARS = 72_000;
export const DEFAULT_MAX_IMPLICIT_SKILLS = 3;
export const DEFAULT_BACKGROUND_MAX_ROUNDS = 5;
export const DEFAULT_BACKGROUND_MAX_DURATION_MS = 0;
export const DEFAULT_BACKGROUND_MAX_TOOL_CALLS = 60;
const DEEPSEEK_V41_FLASH_USAGE_PRICING: UsageCostRates = {
  cacheHitPrice: 0.02,
  inputPrice: 1.0,
  outputPrice: 4.0,
  peakCacheHitPrice: 0.04,
  peakInputPrice: 2.0,
  peakOutputPrice: 8.0,
  currency: '¥'
};

/**
 * Increment only when the built-in monetary rates or their time-band rules
 * change. Alias additions and capability metadata changes do not change it.
 */
export const USAGE_PRICE_TABLE_VERSION = 'keepseek-pricing-2026-09-01';

export const DEFAULT_USAGE_PRICING: Record<string, UsageCostRates> = {
  // DeepSeek 当前峰谷价格:北京时间工作日 9-12 点、14-18 点为高峰,
  // 其余时间(含周六、周日全天)为空闲档。旧 V4 Flash 名称按 V4.1 Flash 计费。
  [DEEPSEEK_FLASH_PRICING_KEY]: { ...DEEPSEEK_V41_FLASH_USAGE_PRICING },
  [DEEPSEEK_PRO_PRICING_KEY]: {
    cacheHitPrice: 0.15,
    inputPrice: 4.5,
    outputPrice: 13.5,
    peakCacheHitPrice: 0.3,
    peakInputPrice: 9.0,
    peakOutputPrice: 27.0,
    currency: '¥'
  },
  // Kimi 国内开放平台按百万 tokens 计费（官方公开价）。
  'kimi-k3': {
    cacheHitPrice: 2,
    inputPrice: 20,
    outputPrice: 100,
    currency: '¥'
  },
  'kimi-k2.7-code': {
    cacheHitPrice: 1.3,
    inputPrice: 6.5,
    outputPrice: 27,
    currency: '¥'
  },
  'kimi-k2.6': {
    cacheHitPrice: 1.1,
    inputPrice: 6.5,
    outputPrice: 27,
    currency: '¥'
  }
};
export const MIN_HISTORY_RETENTION_DAYS = 1;
export const MAX_HISTORY_RETENTION_DAYS = SESSION_HARD_RETENTION_DAYS;
export const MIN_TRACE_RETENTION_DAYS = 1;
export const MAX_TRACE_RETENTION_DAYS = 60;
export const MIN_TRACE_MAX_FILE_BYTES = 1_000_000;
export const MAX_TRACE_MAX_FILE_BYTES = 1_000_000_000;
export const MIN_BALANCE_REFRESH_INTERVAL_MS = 10_000;
export const MAX_BALANCE_REFRESH_INTERVAL_MS = 3_600_000;
export const MAX_REQUEST_RETRIES = 10;
export const MAX_REQUEST_RETRY_BASE_MS = 60_000;

export type InteractionTraceLevel = 'metadata' | 'request' | 'full';

export interface InteractionTraceSettings {
  enabled: boolean;
  level: InteractionTraceLevel;
  logRawStream: boolean;
  retentionDays: number;
  maxFileBytes: number;
}

export interface PatchSettings {
  maxPayloadBytes: number;
  maxHunks: number;
  maxChangedBytes: number;
  maxInlineBytes: number;
  maxProviderBufferBytes: number;
  maxBackupBytes: number;
  maxChangeSetArtifactBytes: number;
  blobStoreQuotaBytes: number;
  maxDiffBytes: number;
}

export function getConfiguredModels(): KeepseekModel[] {
  return getSupportedDeepSeekV4Models();
}

export function getSavedModelSelection(): ModelSelection {
  const config = vscode.workspace.getConfiguration('keepseek');
  const sourceId = getWorkspaceConfigurationString(config, 'selectedSourceId');
  const modelId = getWorkspaceConfigurationString(config, 'selectedModelId');
  return { sourceId, modelId };
}

function getWorkspaceConfigurationString(
  config: vscode.WorkspaceConfiguration,
  key: string
): string {
  // The main-model choice is project-scoped. `get()` is a merged view and may
  // contain a user-level value left by an older KeepSeek version; treating that
  // as a project choice makes every new workspace override the global default.
  // Read only the value explicitly stored for this workspace. The fallback is
  // retained for lightweight hosts/tests that do not implement `inspect()`.
  const inspected = typeof config.inspect === 'function'
    ? config.inspect<string>(key)
    : undefined;
  const value = inspected
    ? inspected.workspaceValue
    : config.get<string>(key, '');
  return typeof value === 'string' ? value.trim() : '';
}

export function getConfiguredModelSelection(
  models: readonly KeepseekModel[],
  defaultSelection?: Partial<ModelSelection>
): ModelSelection {
  const selected = resolveProjectModel(models, getSavedModelSelection(), defaultSelection);
  return {
    sourceId: selected?.sourceId ?? DEFAULT_SELECTED_SOURCE_ID,
    modelId: selected?.id ?? DEFAULT_SELECTED_MODEL_ID
  };
}

export function getConfiguredAgentSettings(): AgentSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return normalizeAgentSettings({
    thinkingEnabled: config.get<boolean>('thinkingEnabled', true),
    reasoningEffort: config.get<AgentSettings['reasoningEffort']>('reasoningEffort', 'high'),
    compressionThreshold: getConfiguredCompressionThreshold()
  });
}

export function getConfiguredCompressionThreshold(): CompressionThreshold {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<unknown>('compressionThreshold', DEFAULT_COMPRESSION_THRESHOLD);
  return normalizeCompressionThreshold(configured);
}

export function getConfiguredMaxFileBytes(): number {
  return vscode.workspace.getConfiguration('keepseek').get('maxFileBytes', DEFAULT_MAX_FILE_BYTES);
}

export function getConfiguredContextWindowTokens(model?: KeepseekModel): number {
  // Backward-compatible entry point. Capability fallback is owned by the
  // centralized runtime profile resolver, never by configuration callers.
  return getEffectiveContextWindowTokens(model);
}

export function getConfiguredUsagePricingMap(): Record<string, UsageCostRates> {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<Record<string, Partial<UsageCostRates>>>('usagePricing', {});
  const merged: Record<string, UsageCostRates> = { ...DEFAULT_USAGE_PRICING };

  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    return merged;
  }

  for (const [modelId, rates] of Object.entries(configured)) {
    const normalizedModelId = modelId.trim();
    if (!normalizedModelId || !rates || typeof rates !== 'object' || Array.isArray(rates)) {
      continue;
    }
    const canonicalPricingKey = getCanonicalPricingKey(normalizedModelId);
    const canonicalConfigured = canonicalPricingKey && canonicalPricingKey !== normalizedModelId
      ? configured[canonicalPricingKey]
      : undefined;
    const canonicalFallback = canonicalPricingKey
      ? canonicalConfigured && typeof canonicalConfigured === 'object' && !Array.isArray(canonicalConfigured)
        ? normalizeUsageCostRates(
          canonicalConfigured,
          merged[canonicalPricingKey] ?? DEFAULT_USAGE_PRICING[DEEPSEEK_FLASH_PRICING_KEY]
        )
        : merged[canonicalPricingKey]
      : undefined;
    merged[normalizedModelId] = normalizeUsageCostRates(
      rates,
      merged[normalizedModelId] ?? canonicalFallback
    );
  }
  return merged;
}

export function getConfiguredModelUsagePricing(modelId: string): UsageCostRates | undefined {
  const pricing = getConfiguredUsagePricingMap();
  const exactId = modelId.trim();
  const canonicalPricingKey = getCanonicalPricingKey(exactId);
  return pricing[exactId] ?? (canonicalPricingKey ? pricing[canonicalPricingKey] : undefined);
}

export function getConfiguredBalanceEndpointUrl(baseUrl: string): string {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<string>('balanceEndpointUrl', DEFAULT_BALANCE_ENDPOINT_URL)
    .trim();
  if (configured) {
    return configured;
  }

  const url = new URL(baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
  // DeepSeek 官方余额端点固定为 https://api.deepseek.com/user/balance,不带
  // /v1 或 /chat/completions 前缀(baseUrl 可能是 .../v1 或 .../v1/chat/completions)。
  // 只有非官方域名(自托管 / 代理)才按 baseUrl 路径推导。
  if (isOfficialDeepSeekSource({ provider: 'deepseek', baseUrl: url.toString() })) {
    url.pathname = '/user/balance';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  const basePath = cleanPath.endsWith('/chat/completions')
    ? cleanPath.slice(0, -'/chat/completions'.length)
    : cleanPath;
  url.pathname = `${basePath || ''}/user/balance`;
  return url.toString();
}

export function getConfiguredBalanceRefreshIntervalMs(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('balanceRefreshIntervalMs', DEFAULT_BALANCE_REFRESH_INTERVAL_MS);
  return normalizeIntegerInRange(
    configured,
    MIN_BALANCE_REFRESH_INTERVAL_MS,
    MAX_BALANCE_REFRESH_INTERVAL_MS,
    DEFAULT_BALANCE_REFRESH_INTERVAL_MS
  );
}

export function getConfiguredSlimToolModeEnabled(): boolean {
  return vscode.workspace
    .getConfiguration('keepseek')
    .get<boolean>('slimToolModeEnabled', DEFAULT_SLIM_TOOL_MODE_ENABLED);
}

export function getConfiguredPromptCacheTtlMs(): number {
  const minutes = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('promptCacheTtlMinutes', DEFAULT_PROMPT_CACHE_TTL_MINUTES);
  return normalizeIntegerInRange(minutes, 5, 10_080, DEFAULT_PROMPT_CACHE_TTL_MINUTES) * 60_000;
}

export function getConfiguredTotalContextBudgetTokens(): number {
  const value = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('context.totalBudgetTokens', DEFAULT_TOTAL_CONTEXT_BUDGET_TOKENS);
  return normalizeIntegerInRange(value, 1_000, 96_000, DEFAULT_TOTAL_CONTEXT_BUDGET_TOKENS);
}

export function getConfiguredValidationAuthorizationPolicy(): ValidationAuthorizationPolicy {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<string>('validation.authorizationPolicy', DEFAULT_VALIDATION_AUTHORIZATION_POLICY);
  return configured === 'never' || configured === 'always'
    ? configured
    : DEFAULT_VALIDATION_AUTHORIZATION_POLICY;
}

export function getConfiguredMaxValidationRuns(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('validation.maxRunsPerAgentRun', DEFAULT_MAX_VALIDATION_RUNS);
  return normalizeIntegerInRange(configured, 0, 8, DEFAULT_MAX_VALIDATION_RUNS);
}

export function getConfiguredMaxRepairIterations(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('validation.maxRepairIterations', DEFAULT_MAX_REPAIR_ITERATIONS);
  return normalizeIntegerInRange(configured, 0, 5, DEFAULT_MAX_REPAIR_ITERATIONS);
}

export function getConfiguredValidationTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('validation.timeoutMs', DEFAULT_VALIDATION_TIMEOUT_MS);
  return normalizeIntegerInRange(configured, 1_000, 600_000, DEFAULT_VALIDATION_TIMEOUT_MS);
}

export function getConfiguredDraftRunTimeoutMs(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('draftRun.timeoutMs', DEFAULT_DRAFT_RUN_TIMEOUT_MS);
  return normalizeIntegerInRange(configured, 1_000, 1_800_000, DEFAULT_DRAFT_RUN_TIMEOUT_MS);
}

export function getConfiguredDraftRunMaxTranscriptBytes(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('draftRun.maxTranscriptBytes', DEFAULT_DRAFT_RUN_MAX_TRANSCRIPT_BYTES);
  return normalizeIntegerInRange(configured, 4_096, 1_048_576, DEFAULT_DRAFT_RUN_MAX_TRANSCRIPT_BYTES);
}

export function getConfiguredProjectInstructionsContextBudgetTokens(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('projectInstructions.contextBudgetTokens', DEFAULT_PROJECT_INSTRUCTIONS_CONTEXT_BUDGET_TOKENS);
  return normalizeIntegerInRange(configured, 0, 32_000, DEFAULT_PROJECT_INSTRUCTIONS_CONTEXT_BUDGET_TOKENS);
}

export function getConfiguredSkillContextBudgetChars(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('skills.contextBudgetChars', DEFAULT_SKILL_CONTEXT_BUDGET_CHARS);
  return normalizeIntegerInRange(configured, 0, 200_000, DEFAULT_SKILL_CONTEXT_BUDGET_CHARS);
}

export function getConfiguredMaxImplicitSkills(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('skills.maxImplicitActivations', DEFAULT_MAX_IMPLICIT_SKILLS);
  return normalizeIntegerInRange(configured, 0, 8, DEFAULT_MAX_IMPLICIT_SKILLS);
}

export function getConfiguredBackgroundMaxRounds(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('background.maxRounds', DEFAULT_BACKGROUND_MAX_ROUNDS);
  return normalizeIntegerInRange(configured, 1, 10, DEFAULT_BACKGROUND_MAX_ROUNDS);
}

export function getConfiguredAgentMaxExecutionMs(): number {
  return normalizeDuration(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxExecutionMs', DEFAULT_AGENT_MAX_EXECUTION_MS));
}

export function getConfiguredAgentMaxToolIterations(): number {
  return normalizeUnlimitedInteger(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxToolIterations', DEFAULT_AGENT_MAX_TOOL_ITERATIONS), 512, DEFAULT_AGENT_MAX_TOOL_ITERATIONS);
}

export function getConfiguredAgentMaxToolCalls(): number {
  return normalizeUnlimitedInteger(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxToolCalls', DEFAULT_AGENT_MAX_TOOL_CALLS), 2_048, DEFAULT_AGENT_MAX_TOOL_CALLS);
}

export function getConfiguredSubagentMaxExecutionMs(): number {
  return normalizeDuration(vscode.workspace.getConfiguration('keepseek').get(
    'agent.subagentMaxExecutionMs', DEFAULT_SUBAGENT_MAX_EXECUTION_MS));
}

export function getConfiguredSubagentHandoffPreviewBytes(): number {
  return normalizeIntegerInRange(vscode.workspace.getConfiguration('keepseek').get(
    'subagent.handoffPreviewBytes', DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES),
  1_024, 24_576, DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES);
}

export function getConfiguredSubagentParallelHandoffBytes(): number {
  return normalizeIntegerInRange(vscode.workspace.getConfiguration('keepseek').get(
    'subagent.parallelHandoffBytes', DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES),
  16_384, 65_536, DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES);
}

export function getConfiguredAgentMaxModelRequests(subagent = false): number {
  const fallback = subagent ? DEFAULT_SUBAGENT_MAX_MODEL_REQUESTS : DEFAULT_AGENT_MAX_MODEL_REQUESTS;
  const key = subagent ? 'agent.subagentMaxModelRequests' : 'agent.maxModelRequests';
  const configured = vscode.workspace.getConfiguration('keepseek').get(key, fallback);
  return subagent
    ? normalizeIntegerInRange(configured, 1, 512, fallback)
    : normalizeUnlimitedInteger(configured, 512, fallback);
}

export function getConfiguredAgentMaxContinuations(): number {
  return normalizeIntegerInRange(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxContinuations', DEFAULT_AGENT_MAX_CONTINUATIONS), 0, 8, DEFAULT_AGENT_MAX_CONTINUATIONS);
}

export function getConfiguredAgentMaxContextEpochRollovers(): number {
  return normalizeUnlimitedInteger(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxContextEpochRollovers', DEFAULT_AGENT_MAX_CONTEXT_EPOCH_ROLLOVERS),
  32, DEFAULT_AGENT_MAX_CONTEXT_EPOCH_ROLLOVERS);
}

export function getConfiguredAgentMaxTreeUpstreamTokens(): number {
  return normalizeUnlimitedInteger(vscode.workspace.getConfiguration('keepseek').get(
    'agent.maxTreeUpstreamTokens', DEFAULT_AGENT_MAX_TREE_UPSTREAM_TOKENS),
  100_000_000, DEFAULT_AGENT_MAX_TREE_UPSTREAM_TOKENS, 1_000);
}

export function getConfiguredSubagentMaxUpstreamTokens(): number {
  return normalizeIntegerInRange(vscode.workspace.getConfiguration('keepseek').get(
    'agent.subagentMaxUpstreamTokens', DEFAULT_SUBAGENT_MAX_UPSTREAM_TOKENS),
  1_000, 100_000_000, DEFAULT_SUBAGENT_MAX_UPSTREAM_TOKENS);
}

export function getConfiguredAgentToolMaxOutputTokens(): number {
  return getConfiguredOutputLimit('agent.toolMaxOutputTokens', DEFAULT_AGENT_TOOL_MAX_OUTPUT_TOKENS);
}

export function getConfiguredAgentFinalMaxOutputTokens(): number {
  return getConfiguredOutputLimit('agent.finalMaxOutputTokens', DEFAULT_AGENT_FINAL_MAX_OUTPUT_TOKENS);
}

export function getConfiguredAgentContinuationMaxOutputTokens(): number {
  return getConfiguredOutputLimit('agent.continuationMaxOutputTokens', DEFAULT_AGENT_CONTINUATION_MAX_OUTPUT_TOKENS);
}

export function getConfiguredAgentRepairMaxOutputTokens(): number {
  return getConfiguredOutputLimit('agent.repairMaxOutputTokens', DEFAULT_AGENT_REPAIR_MAX_OUTPUT_TOKENS);
}

function getConfiguredOutputLimit(key: string, fallback: number): number {
  return normalizeIntegerInRange(vscode.workspace.getConfiguration('keepseek').get(key, fallback), 256, 65_536, fallback);
}

export function getConfiguredAgentMaxCost(): number {
  return normalizeCostLimit(vscode.workspace.getConfiguration('keepseek').get('agent.maxCost', DEFAULT_AGENT_MAX_COST));
}

export function getConfiguredStreamIdleTimeoutMs(): number {
  return Math.min(2_147_483_647, normalizeDuration(vscode.workspace.getConfiguration('keepseek').get('agent.streamIdleTimeoutMs', 0)));
}

export function getConfiguredBackgroundMaxDurationMs(): number {
  // The old 30-minute constant was never a user setting. Only stored overrides
  // survive migration; absence uses the new zero default.
  return mergeDurations(getConfiguredAgentMaxExecutionMs(),
    vscode.workspace.getConfiguration('keepseek').get('background.maxDurationMs', 0));
}

export function getConfiguredBackgroundMaxToolCalls(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('background.maxToolCalls', DEFAULT_BACKGROUND_MAX_TOOL_CALLS);
  return normalizeIntegerInRange(configured, 1, 256, DEFAULT_BACKGROUND_MAX_TOOL_CALLS);
}

export function getConfiguredMaxRequestRetries(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxRequestRetries', DEFAULT_MAX_REQUEST_RETRIES);
  return normalizeIntegerInRange(configuredLimit, 0, MAX_REQUEST_RETRIES, DEFAULT_MAX_REQUEST_RETRIES);
}

export function getConfiguredRequestRetryBaseMs(): number {
  const configuredDelay = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('requestRetryBaseMs', DEFAULT_REQUEST_RETRY_BASE_MS);
  return normalizeIntegerInRange(configuredDelay, 0, MAX_REQUEST_RETRY_BASE_MS, DEFAULT_REQUEST_RETRY_BASE_MS);
}

export function getConfiguredDebugMode(): boolean {
  return vscode.workspace
    .getConfiguration('keepseek')
    .get<boolean>('trace.enabled', DEFAULT_TRACE_ENABLED);
}

export function getConfiguredInteractionTraceSettings(): InteractionTraceSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return {
    enabled: getConfiguredDebugMode(),
    level: normalizeInteractionTraceLevel(config.get<string>('trace.level', DEFAULT_TRACE_LEVEL)),
    logRawStream: config.get<boolean>('trace.logRawStream', DEFAULT_TRACE_LOG_RAW_STREAM),
    retentionDays: normalizeIntegerInRange(
      config.get<number>('trace.retentionDays', DEFAULT_TRACE_RETENTION_DAYS),
      MIN_TRACE_RETENTION_DAYS,
      MAX_TRACE_RETENTION_DAYS,
      DEFAULT_TRACE_RETENTION_DAYS
    ),
    maxFileBytes: normalizeIntegerInRange(
      config.get<number>('trace.maxFileBytes', DEFAULT_TRACE_MAX_FILE_BYTES),
      MIN_TRACE_MAX_FILE_BYTES,
      MAX_TRACE_MAX_FILE_BYTES,
      DEFAULT_TRACE_MAX_FILE_BYTES
    )
  };
}

export function getConfiguredWorkspaceToolFileLimit(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxWorkspaceToolFiles', DEFAULT_WORKSPACE_TOOL_FILE_LIMIT);
  return normalizeIntegerInRange(configuredLimit, 1, 50_000, DEFAULT_WORKSPACE_TOOL_FILE_LIMIT);
}

export function getConfiguredWorkspaceReadMaxBytes(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxFileBytes', DEFAULT_MAX_FILE_BYTES);
  return normalizeIntegerInRange(configuredLimit, 1, 20_000_000, DEFAULT_MAX_FILE_BYTES);
}

export function getConfiguredPatchSettings(): PatchSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return {
    maxPayloadBytes: normalizeIntegerInRange(config.get('patch.maxPayloadBytes', DEFAULT_PATCH_MAX_PAYLOAD_BYTES), 1_024, 16_777_216, DEFAULT_PATCH_MAX_PAYLOAD_BYTES),
    maxHunks: normalizeIntegerInRange(config.get('patch.maxHunks', DEFAULT_PATCH_MAX_HUNKS), 1, 4_096, DEFAULT_PATCH_MAX_HUNKS),
    maxChangedBytes: normalizeIntegerInRange(config.get('patch.maxChangedBytes', DEFAULT_PATCH_MAX_CHANGED_BYTES), 1, 67_108_864, DEFAULT_PATCH_MAX_CHANGED_BYTES),
    maxInlineBytes: normalizeIntegerInRange(config.get('patch.maxInlineBytes', DEFAULT_PATCH_MAX_INLINE_BYTES), 1_024, 4_194_304, DEFAULT_PATCH_MAX_INLINE_BYTES),
    maxProviderBufferBytes: normalizeIntegerInRange(config.get('patch.maxProviderBufferBytes', DEFAULT_PATCH_MAX_PROVIDER_BUFFER_BYTES), 1_024, 268_435_456, DEFAULT_PATCH_MAX_PROVIDER_BUFFER_BYTES),
    maxBackupBytes: normalizeIntegerInRange(config.get('patch.maxBackupBytes', DEFAULT_PATCH_MAX_BACKUP_BYTES), 1_024, 536_870_912, DEFAULT_PATCH_MAX_BACKUP_BYTES),
    maxChangeSetArtifactBytes: normalizeIntegerInRange(config.get('patch.maxChangeSetArtifactBytes', DEFAULT_PATCH_MAX_CHANGE_SET_ARTIFACT_BYTES), 1_048_576, 1_073_741_824, DEFAULT_PATCH_MAX_CHANGE_SET_ARTIFACT_BYTES),
    blobStoreQuotaBytes: normalizeIntegerInRange(config.get('patch.blobStoreQuotaBytes', DEFAULT_PATCH_BLOB_STORE_QUOTA_BYTES), 1_048_576, 10_737_418_240, DEFAULT_PATCH_BLOB_STORE_QUOTA_BYTES),
    maxDiffBytes: normalizeIntegerInRange(config.get('patch.maxDiffBytes', DEFAULT_PATCH_MAX_DIFF_BYTES), 65_536, 67_108_864, DEFAULT_PATCH_MAX_DIFF_BYTES)
  };
}

export function getConfiguredProviderInlineResultMaxChars(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('providerInlineResultMaxChars', DEFAULT_PROVIDER_INLINE_RESULT_MAX_CHARS);
  return normalizeIntegerInRange(configuredLimit, 1_024, 1_000_000, DEFAULT_PROVIDER_INLINE_RESULT_MAX_CHARS);
}

export function getConfiguredEvidenceMaxBytes(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('evidenceMaxBytes', DEFAULT_EVIDENCE_MAX_BYTES);
  return normalizeIntegerInRange(configuredLimit, 1_000_000, 1_000_000_000, DEFAULT_EVIDENCE_MAX_BYTES);
}

export function getConfiguredHistoryRetentionDays(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('historyRetentionDays', DEFAULT_HISTORY_RETENTION_DAYS);
  return normalizeIntegerInRange(
    configuredLimit,
    MIN_HISTORY_RETENTION_DAYS,
    MAX_HISTORY_RETENTION_DAYS,
    DEFAULT_HISTORY_RETENTION_DAYS
  );
}

export function normalizeAgentSettings(settings: Partial<AgentSettings> | undefined, fallback?: AgentSettings): AgentSettings {
  return {
    thinkingEnabled: typeof settings?.thinkingEnabled === 'boolean'
      ? settings.thinkingEnabled
      : fallback?.thinkingEnabled ?? true,
    reasoningEffort: settings?.reasoningEffort === 'max'
      ? 'max'
      : settings?.reasoningEffort === 'high'
        ? 'high'
        : fallback?.reasoningEffort ?? 'high',
    compressionThreshold: normalizeCompressionThreshold(
      settings?.compressionThreshold,
      fallback?.compressionThreshold ?? DEFAULT_COMPRESSION_THRESHOLD
    )
  };
}

export function normalizeCompressionThreshold(
  value: unknown,
  fallback: CompressionThreshold = DEFAULT_COMPRESSION_THRESHOLD
): CompressionThreshold {
  return value === 'aggressive' || value === 'balanced' || value === 'cache'
    ? value
    : fallback;
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return undefined;
  }
  return Math.floor(number);
}

export function normalizeInteractionTraceLevel(value: unknown): InteractionTraceLevel {
  return value === 'metadata' || value === 'request' || value === 'full'
    ? value
    : DEFAULT_TRACE_LEVEL;
}

export function normalizeIntegerInRange(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(number)));
}

/** Numeric execution budgets use one serialized convention: zero is
 * unlimited and only a positive integer creates a boundary. */
function normalizeUnlimitedInteger(value: unknown, max: number, fallback: number, minPositive = 1): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const normalized = Math.floor(number);
  if (normalized <= 0) return 0;
  return Math.min(max, Math.max(minPositive, normalized));
}

function normalizeUsageCostRates(
  rates: Partial<UsageCostRates>,
  fallback: UsageCostRates = DEFAULT_USAGE_PRICING[DEEPSEEK_FLASH_PRICING_KEY]
): UsageCostRates {
  return {
    cacheHitPrice: normalizeNonNegativeNumber(rates.cacheHitPrice, fallback.cacheHitPrice),
    inputPrice: normalizeNonNegativeNumber(rates.inputPrice, fallback.inputPrice),
    outputPrice: normalizeNonNegativeNumber(rates.outputPrice, fallback.outputPrice),
    peakCacheHitPrice: normalizeOptionalNonNegativeNumber(
      rates.peakCacheHitPrice,
      fallback.peakCacheHitPrice
    ),
    peakInputPrice: normalizeOptionalNonNegativeNumber(rates.peakInputPrice, fallback.peakInputPrice),
    peakOutputPrice: normalizeOptionalNonNegativeNumber(rates.peakOutputPrice, fallback.peakOutputPrice),
    currency: typeof rates.currency === 'string' && rates.currency.trim()
      ? rates.currency.trim()
      : fallback.currency
  };
}

function normalizeOptionalNonNegativeNumber(
  value: unknown,
  fallback: number | undefined
): number | undefined {
  if (value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
