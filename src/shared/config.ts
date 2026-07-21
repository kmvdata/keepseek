import * as vscode from 'vscode';
import { AgentSettings, KeepseekModel, UsageCostRates, ValidationAuthorizationPolicy } from './types';
import { SESSION_HARD_RETENTION_DAYS } from '../sessions/sessionRetention';
import {
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  getSupportedDeepSeekV4Models
} from './modelProfiles';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_WORKSPACE_TOOL_FILE_LIMIT = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 200_000;
export const DEFAULT_MAX_REQUEST_RETRIES = 2;
export const DEFAULT_REQUEST_RETRY_BASE_MS = 1_000;
export const DEFAULT_SELECTED_MODEL_ID = '';
export const DEFAULT_HISTORY_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_ENABLED = false;
export const DEFAULT_TRACE_LEVEL: InteractionTraceLevel = 'full';
export const DEFAULT_TRACE_LOG_RAW_STREAM = true;
export const DEFAULT_TRACE_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_MAX_FILE_BYTES = 20_000_000;
export const DEFAULT_BALANCE_ENDPOINT_URL = '';
export const DEFAULT_BALANCE_REFRESH_INTERVAL_MS = 60_000;
export const DEFAULT_SLIM_TOOL_MODE_ENABLED = true;
export const DEFAULT_VALIDATION_AUTHORIZATION_POLICY: ValidationAuthorizationPolicy = 'ask';
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
  'deepseek-v4-flash': {
    cacheHitPrice: 0.02,
    inputPrice: 1,
    outputPrice: 2,
    currency: '¥'
  },
  'deepseek-v4-pro': {
    cacheHitPrice: 0.025,
    inputPrice: 3,
    outputPrice: 6,
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

export function getConfiguredSelectedModelId(models = getConfiguredModels()): string {
  const configured = vscode.workspace
    .getConfiguration('keepseek')
    .get<string>('selectedModelId', DEFAULT_SELECTED_MODEL_ID)
    .trim();
  if (configured && models.some((model) => model.id === configured)) {
    return configured;
  }

  return models[0]?.id ?? DEFAULT_SELECTED_MODEL_ID;
}

export function getConfiguredAgentSettings(): AgentSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return normalizeAgentSettings({
    thinkingEnabled: config.get<boolean>('thinkingEnabled', true),
    reasoningEffort: config.get<AgentSettings['reasoningEffort']>('reasoningEffort', 'high')
  });
}

export function getConfiguredMaxFileBytes(): number {
  return vscode.workspace.getConfiguration('keepseek').get('maxFileBytes', DEFAULT_MAX_FILE_BYTES);
}

export function getConfiguredContextWindowTokens(model?: KeepseekModel): number {
  const modelLimit = normalizePositiveInteger(model?.contextWindowTokens);
  return modelLimit ?? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS;
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

export function getConfiguredModelUsagePricing(modelId: string): UsageCostRates {
  const pricing = getConfiguredUsagePricingMap();
  return pricing[modelId] ?? pricing['deepseek-v4-flash'];
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
        : fallback?.reasoningEffort ?? 'high'
  };
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
