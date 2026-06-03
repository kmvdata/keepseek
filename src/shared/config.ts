import * as vscode from 'vscode';
import { AgentSettings, KeepseekModel } from './types';
import { SESSION_HARD_RETENTION_DAYS } from '../sessions/sessionRetention';

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 0;
export const DEFAULT_MAX_TOKENS = 64_000;
export const MAX_GENERATION_TOKENS = 384_000;
export const DEFAULT_MAX_TOOL_ITERATIONS = 8;
export const DEFAULT_WORKSPACE_TOOL_FILE_LIMIT = 2_000;
export const DEFAULT_MAX_FILE_BYTES = 200_000;
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEFAULT_MAX_TOOL_CALLS = 24;
export const DEFAULT_MAX_RUN_MS = 600_000;
export const DEFAULT_TOOL_RESULT_TOKEN_BUDGET = 0;
export const DEFAULT_MAX_REQUEST_RETRIES = 2;
export const DEFAULT_REQUEST_RETRY_BASE_MS = 1_000;
export const DEFAULT_SELECTED_MODEL_ID = '';
export const DEFAULT_HISTORY_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_ENABLED = false;
export const DEFAULT_TRACE_LEVEL: InteractionTraceLevel = 'full';
export const DEFAULT_TRACE_LOG_RAW_STREAM = true;
export const DEFAULT_TRACE_RETENTION_DAYS = 7;
export const DEFAULT_TRACE_MAX_FILE_BYTES = 20_000_000;
export const DEFAULT_CONTEXT_COMPRESSION_ENABLED = true;
export const DEFAULT_CONTEXT_KEEP_RECENT_TURNS = 12;
export const DEFAULT_CONTEXT_COMPRESSION_TRIGGER_RATIO = 0.7;
export const DEFAULT_CONTEXT_SUMMARY_BUDGET_TOKENS = 3_000;
export const MIN_HISTORY_RETENTION_DAYS = 1;
export const MAX_HISTORY_RETENTION_DAYS = SESSION_HARD_RETENTION_DAYS;
export const MIN_TRACE_RETENTION_DAYS = 1;
export const MAX_TRACE_RETENTION_DAYS = 60;
export const MIN_TRACE_MAX_FILE_BYTES = 1_000_000;
export const MAX_TRACE_MAX_FILE_BYTES = 1_000_000_000;
export const MIN_CONTEXT_KEEP_RECENT_TURNS = 1;
export const MAX_CONTEXT_KEEP_RECENT_TURNS = 64;
export const MIN_CONTEXT_COMPRESSION_TRIGGER_RATIO = 0.1;
export const MAX_CONTEXT_COMPRESSION_TRIGGER_RATIO = 0.95;
export const MIN_CONTEXT_SUMMARY_BUDGET_TOKENS = 500;
export const MAX_CONTEXT_SUMMARY_BUDGET_TOKENS = 100_000;
export const MAX_TOOL_ITERATIONS = 64;
export const MAX_TOOL_CALLS = 256;
export const MAX_RUN_MS = 3_600_000;
export const MAX_STREAM_IDLE_TIMEOUT_MS = 3_600_000;
export const MAX_TOOL_RESULT_TOKEN_BUDGET = DEFAULT_CONTEXT_WINDOW_TOKENS;
export const MAX_REQUEST_RETRIES = 10;
export const MAX_REQUEST_RETRY_BASE_MS = 60_000;
export const AGENT_HISTORY_MESSAGE_LIMIT = 24;

export type InteractionTraceLevel = 'metadata' | 'request' | 'full';

export interface InteractionTraceSettings {
  enabled: boolean;
  level: InteractionTraceLevel;
  logRawStream: boolean;
  retentionDays: number;
  maxFileBytes: number;
}

export interface ContextCompressionSettings {
  enabled: boolean;
  keepRecentTurns: number;
  triggerRatio: number;
  summaryBudgetTokens: number;
}

export function getConfiguredModels(): KeepseekModel[] {
  const configured = vscode.workspace.getConfiguration('keepseek').get<KeepseekModel[]>('models', []);
  const models = configured.filter((model) => model?.id && model.label);
  if (models.length) {
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider ?? 'custom',
      contextWindowTokens: normalizePositiveInteger(model.contextWindowTokens)
    }));
  }

  return [
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek-V4-Flash',
      provider: 'deepseek'
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek-V4-Pro',
      provider: 'deepseek'
    }
  ];
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

export function getConfiguredMaxTokens(): number {
  return normalizeIntegerInRange(
    vscode.workspace.getConfiguration('keepseek').get<number>('maxTokens', DEFAULT_MAX_TOKENS),
    0,
    MAX_GENERATION_TOKENS,
    DEFAULT_MAX_TOKENS
  );
}

export function getConfiguredContextWindowTokens(model?: KeepseekModel): number {
  const modelLimit = normalizePositiveInteger(model?.contextWindowTokens);
  if (modelLimit) {
    return modelLimit;
  }

  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('contextWindowTokens', DEFAULT_CONTEXT_WINDOW_TOKENS);
  return normalizePositiveInteger(configuredLimit) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

export function getConfiguredMaxToolIterations(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxToolIterations', DEFAULT_MAX_TOOL_ITERATIONS);
  return normalizeIntegerInRange(configuredLimit, 0, MAX_TOOL_ITERATIONS, DEFAULT_MAX_TOOL_ITERATIONS);
}

export function getConfiguredMaxToolCalls(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxToolCalls', DEFAULT_MAX_TOOL_CALLS);
  return normalizeIntegerInRange(configuredLimit, 0, MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS);
}

export function getConfiguredMaxRunMs(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('maxRunMs', DEFAULT_MAX_RUN_MS);
  return normalizeIntegerInRange(configuredLimit, 0, MAX_RUN_MS, DEFAULT_MAX_RUN_MS);
}

export function getConfiguredToolResultTokenBudget(): number {
  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('toolResultTokenBudget', DEFAULT_TOOL_RESULT_TOKEN_BUDGET);
  return normalizeIntegerInRange(
    configuredLimit,
    0,
    MAX_TOOL_RESULT_TOKEN_BUDGET,
    DEFAULT_TOOL_RESULT_TOKEN_BUDGET
  );
}

export function getConfiguredContextCompressionSettings(): ContextCompressionSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return {
    enabled: config.get<boolean>('contextCompressionEnabled', DEFAULT_CONTEXT_COMPRESSION_ENABLED),
    keepRecentTurns: normalizeIntegerInRange(
      config.get<number>('contextKeepRecentTurns', DEFAULT_CONTEXT_KEEP_RECENT_TURNS),
      MIN_CONTEXT_KEEP_RECENT_TURNS,
      MAX_CONTEXT_KEEP_RECENT_TURNS,
      DEFAULT_CONTEXT_KEEP_RECENT_TURNS
    ),
    triggerRatio: normalizeNumberInRange(
      config.get<number>('contextCompressionTriggerRatio', DEFAULT_CONTEXT_COMPRESSION_TRIGGER_RATIO),
      MIN_CONTEXT_COMPRESSION_TRIGGER_RATIO,
      MAX_CONTEXT_COMPRESSION_TRIGGER_RATIO,
      DEFAULT_CONTEXT_COMPRESSION_TRIGGER_RATIO
    ),
    summaryBudgetTokens: normalizeIntegerInRange(
      config.get<number>('contextSummaryBudgetTokens', DEFAULT_CONTEXT_SUMMARY_BUDGET_TOKENS),
      MIN_CONTEXT_SUMMARY_BUDGET_TOKENS,
      MAX_CONTEXT_SUMMARY_BUDGET_TOKENS,
      DEFAULT_CONTEXT_SUMMARY_BUDGET_TOKENS
    )
  };
}

export function getConfiguredStreamIdleTimeoutMs(): number {
  const configuredTimeout = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('streamIdleTimeoutMs', DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  return normalizeIntegerInRange(
    configuredTimeout,
    0,
    MAX_STREAM_IDLE_TIMEOUT_MS,
    DEFAULT_STREAM_IDLE_TIMEOUT_MS
  );
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

export function normalizeNumberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}
