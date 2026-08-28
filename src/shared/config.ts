import * as vscode from 'vscode';
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

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_WORKSPACE_TOOL_FILE_LIMIT = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 200_000;
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
export const DEFAULT_BACKGROUND_MAX_DURATION_MS = 30 * 60 * 1_000;
export const DEFAULT_BACKGROUND_MAX_TOOL_CALLS = 60;
export const DEFAULT_USAGE_PRICING: Record<string, UsageCostRates> = {
  // DeepSeek 峰谷定价(自 2026-08-17 北京时间 00:00 起生效)。
  // 空闲档为常规价;高峰档(北京时间每日 9-12 点、14-18 点)价格更高。
  'deepseek-v4-flash': {
    cacheHitPrice: 0.05,
    inputPrice: 1.5,
    outputPrice: 4.5,
    peakCacheHitPrice: 0.1,
    peakInputPrice: 3.0,
    peakOutputPrice: 9.0,
    currency: '¥'
  },
  'deepseek-v4-pro': {
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

export function getConfiguredModels(): KeepseekModel[] {
  return getSupportedDeepSeekV4Models();
}

export function getConfiguredModelSelection(models: readonly KeepseekModel[]): ModelSelection {
  const config = vscode.workspace.getConfiguration('keepseek');
  const sourceId = config.get<string>('selectedSourceId', DEFAULT_SELECTED_SOURCE_ID).trim();
  const modelId = config.get<string>('selectedModelId', DEFAULT_SELECTED_MODEL_ID).trim();
  const exact = sourceId && modelId
    ? models.find((model) => model.sourceId === sourceId && model.id === modelId)
    : undefined;
  const backwardCompatible = !exact && modelId
    ? models.find((model) => model.id === modelId)
    : undefined;
  const selected = exact ?? backwardCompatible ?? models[0];
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
    merged[normalizedModelId] = normalizeUsageCostRates(rates, merged[normalizedModelId]);
  }
  return merged;
}

export function getConfiguredModelUsagePricing(modelId: string): UsageCostRates | undefined {
  const pricing = getConfiguredUsagePricingMap();
  return pricing[modelId];
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

export function getConfiguredBackgroundMaxDurationMs(): number {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('background.maxDurationMs', DEFAULT_BACKGROUND_MAX_DURATION_MS);
  return normalizeIntegerInRange(configured, 60_000, 3_600_000, DEFAULT_BACKGROUND_MAX_DURATION_MS);
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

function normalizeUsageCostRates(
  rates: Partial<UsageCostRates>,
  fallback: UsageCostRates = DEFAULT_USAGE_PRICING['deepseek-v4-flash']
): UsageCostRates {
  return {
    cacheHitPrice: normalizeNonNegativeNumber(rates.cacheHitPrice, fallback.cacheHitPrice),
    inputPrice: normalizeNonNegativeNumber(rates.inputPrice, fallback.inputPrice),
    outputPrice: normalizeNonNegativeNumber(rates.outputPrice, fallback.outputPrice),
    currency: typeof rates.currency === 'string' && rates.currency.trim()
      ? rates.currency.trim()
      : fallback.currency
  };
}

function normalizeNonNegativeNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}
