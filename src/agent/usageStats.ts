import type { DeepSeekUsage } from './deepseek/types';
import type {
  DeepSeekBalanceState,
  PromptCacheDiagnostics,
  SessionUsageStats,
  TurnUsageStats,
  Usage,
  UsageCostRates,
  UsageEvent
} from '../shared/types';

const DEFAULT_CURRENCY = '¥';

export function normalizeDeepSeekUsage(usage: DeepSeekUsage | null | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = readNonNegativeInteger(usage.prompt_tokens);
  const completionTokens = readNonNegativeInteger(usage.completion_tokens);
  const totalTokens = readOptionalNonNegativeInteger(usage.total_tokens) ?? promptTokens + completionTokens;
  const directHitTokens = readOptionalNonNegativeInteger(usage.prompt_cache_hit_tokens);
  const detailsHitTokens = readOptionalNonNegativeInteger(readNestedUsageNumber(
    usage.prompt_tokens_details,
    'cached_tokens'
  ));
  const cacheHitTokens = directHitTokens ?? detailsHitTokens ?? 0;
  const directMissTokens = readOptionalNonNegativeInteger(usage.prompt_cache_miss_tokens);
  const cacheMissTokens = directMissTokens ?? Math.max(0, promptTokens - cacheHitTokens);
  const reasoningTokens = readOptionalNonNegativeInteger(readNestedUsageNumber(
    usage.completion_tokens_details,
    'reasoning_tokens'
  ));

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    cacheHitTokens,
    cacheMissTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

export function createEmptySessionUsageStats(currency = DEFAULT_CURRENCY): SessionUsageStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    requestCount: 0,
    sessionCost: 0,
    currency: normalizeCurrency(currency)
  };
}

export function createEmptyTurnUsageStats(currency = DEFAULT_CURRENCY, modelId?: string): TurnUsageStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    requestCount: 0,
    cost: 0,
    currency: normalizeCurrency(currency),
    ...(modelId ? { modelId } : {})
  };
}

export function createUsageEvent(input: {
  usage: Usage;
  cost: number;
  currency: string;
  modelId: string;
  requestId?: string;
}): UsageEvent {
  return {
    usage: normalizeUsage(input.usage),
    cost: normalizeCost(input.cost),
    currency: normalizeCurrency(input.currency),
    modelId: input.modelId,
    requestId: input.requestId
  };
}

export function addUsageEventToTurnStats(
  current: TurnUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): TurnUsageStats {
  const base = current ?? createEmptyTurnUsageStats(event.currency, event.modelId);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + 1,
    cost: normalizeCost(base.cost + event.cost),
    currency: normalizeCurrency(event.currency || base.currency),
    modelId: event.modelId || base.modelId,
    updatedAt: now
  };
}

export function addUsageEventToSessionStats(
  current: SessionUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): SessionUsageStats {
  const base = current ?? createEmptySessionUsageStats(event.currency);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + 1,
    sessionCost: normalizeCost(base.sessionCost + event.cost),
    currency: normalizeCurrency(event.currency || base.currency),
    updatedAt: now
  };
}

export function addTurnUsageToSessionStats(
  current: SessionUsageStats | undefined,
  turn: TurnUsageStats,
  now = new Date().toISOString()
): SessionUsageStats {
  const base = current ?? createEmptySessionUsageStats(turn.currency);
  return {
    ...sumUsage(base, turn),
    requestCount: base.requestCount + turn.requestCount,
    sessionCost: normalizeCost(base.sessionCost + turn.cost),
    currency: normalizeCurrency(turn.currency || base.currency),
    updatedAt: now
  };
}

export function calculateUsageCost(usage: Usage, rates: UsageCostRates): number {
  return normalizeCost((
    usage.cacheHitTokens * normalizePrice(rates.cacheHitPrice) +
    usage.cacheMissTokens * normalizePrice(rates.inputPrice) +
    usage.completionTokens * normalizePrice(rates.outputPrice)
  ) / 1_000_000);
}

export function calculateCacheHitRate(usage: Pick<Usage, 'cacheHitTokens' | 'cacheMissTokens'>): number | undefined {
  const denominator = Math.max(0, usage.cacheHitTokens) + Math.max(0, usage.cacheMissTokens);
  return denominator > 0 ? (Math.max(0, usage.cacheHitTokens) / denominator) * 100 : undefined;
}

export function normalizeSessionUsageStatsValue(value: unknown): SessionUsageStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stats: SessionUsageStats = {
    ...normalizeUsage(value),
    requestCount: readNonNegativeInteger(value.requestCount),
    sessionCost: normalizeCost(value.sessionCost),
    currency: normalizeCurrency(value.currency),
    updatedAt: normalizeOptionalString(value.updatedAt)
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || stats.sessionCost > 0 ? stats : undefined;
}

export function normalizeTurnUsageStatsValue(value: unknown): TurnUsageStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const stats: TurnUsageStats = {
    ...normalizeUsage(value),
    requestCount: readNonNegativeInteger(value.requestCount),
    cost: normalizeCost(value.cost),
    currency: normalizeCurrency(value.currency),
    modelId: normalizeOptionalString(value.modelId),
    updatedAt: normalizeOptionalString(value.updatedAt)
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || stats.cost > 0 ? stats : undefined;
}

export function normalizeBalanceStateValue(value: unknown): DeepSeekBalanceState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const totalBalance = readOptionalFiniteNumber(value.totalBalance);
  const error = normalizeOptionalString(value.error);
  if (totalBalance === undefined && !error) {
    return undefined;
  }
  return {
    totalBalance,
    currency: normalizeCurrency(value.currency),
    isAvailable: typeof value.isAvailable === 'boolean' ? value.isAvailable : undefined,
    updatedAt: normalizeOptionalString(value.updatedAt),
    error
  };
}

export function normalizePromptCacheDiagnosticsValue(value: unknown): PromptCacheDiagnostics | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const diagnostics: PromptCacheDiagnostics = {
    systemPromptHash: normalizeOptionalString(value.systemPromptHash),
    toolsSchemaHash: normalizeOptionalString(value.toolsSchemaHash),
    modelId: normalizeOptionalString(value.modelId),
    historyCompacted: typeof value.historyCompacted === 'boolean' ? value.historyCompacted : undefined,
    historyRewriteReason: normalizeOptionalString(value.historyRewriteReason),
    cacheMissPossibleReasons: Array.isArray(value.cacheMissPossibleReasons)
      ? value.cacheMissPossibleReasons.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : undefined,
    updatedAt: normalizeOptionalString(value.updatedAt)
  };
  return diagnostics.systemPromptHash ||
    diagnostics.toolsSchemaHash ||
    diagnostics.modelId ||
    diagnostics.historyCompacted !== undefined ||
    diagnostics.historyRewriteReason
    ? diagnostics
    : undefined;
}

function sumUsage<T extends Usage>(left: T, right: Usage): Usage {
  const reasoningTokens = (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0);
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheHitTokens: left.cacheHitTokens + right.cacheHitTokens,
    cacheMissTokens: left.cacheMissTokens + right.cacheMissTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
}

function normalizeUsage(value: unknown): Usage {
  const record = isRecord(value) ? value : {};
  const reasoningTokens = readOptionalNonNegativeInteger(record.reasoningTokens);
  return {
    promptTokens: readNonNegativeInteger(record.promptTokens),
    completionTokens: readNonNegativeInteger(record.completionTokens),
    totalTokens: readNonNegativeInteger(record.totalTokens),
    cacheHitTokens: readNonNegativeInteger(record.cacheHitTokens),
    cacheMissTokens: readNonNegativeInteger(record.cacheMissTokens),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

function hasAnyUsage(usage: Usage): boolean {
  return usage.promptTokens > 0 ||
    usage.completionTokens > 0 ||
    usage.totalTokens > 0 ||
    usage.cacheHitTokens > 0 ||
    usage.cacheMissTokens > 0 ||
    (usage.reasoningTokens ?? 0) > 0;
}

function readNestedUsageNumber(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readNonNegativeInteger(value: unknown): number {
  return readOptionalNonNegativeInteger(value) ?? 0;
}

function readOptionalNonNegativeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeCost(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizePrice(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeCurrency(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_CURRENCY;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
