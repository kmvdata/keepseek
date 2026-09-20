import type { DeepSeekUsage } from './deepseek/types';
import type {
  CacheDiagnosticsMetrics,
  ModelSourceBalanceState,
  PromptCacheDiagnostics,
  SessionUsageStats,
  TurnUsageStats,
  Usage,
  UsageCostRates,
  UsageEvent,
  UsageModelGroupStats,
  UsagePricingStatus,
  UsageSource,
  UsageSourceStats,
  ProviderUsageLedgerRecord
} from '../shared/types';
import { summarizeUsageLedger, type UsageLedgerSummary } from './usageLedger';
import { getPricingPeriod } from './usagePricingPeriod';
export { getPricingPeriod } from './usagePricingPeriod';
export type { PricingPeriod } from './usagePricingPeriod';

const DEFAULT_CURRENCY = '¥';

export function normalizeDeepSeekUsage(usage: DeepSeekUsage | null | undefined): Usage | undefined {
  if (!usage) {
    return undefined;
  }

  const promptTokens = readNonNegativeInteger(usage.prompt_tokens);
  const completionTokens = readNonNegativeInteger(usage.completion_tokens);
  const totalTokens = readOptionalNonNegativeInteger(usage.total_tokens) ?? promptTokens + completionTokens;
  const directHitTokens = readOptionalNonNegativeInteger(usage.prompt_cache_hit_tokens);
  const compatibleHitTokens = readOptionalNonNegativeInteger(usage.cached_tokens);
  const detailsHitTokens = readOptionalNonNegativeInteger(readNestedUsageNumber(
    usage.prompt_tokens_details,
    'cached_tokens'
  ));
  const returnedHitTokens = directHitTokens ?? compatibleHitTokens ?? detailsHitTokens;
  const directMissTokens = readOptionalNonNegativeInteger(usage.prompt_cache_miss_tokens);
  const cacheHitTokens = returnedHitTokens
    ?? (directMissTokens === undefined ? 0 : Math.max(0, promptTokens - directMissTokens));
  const cacheMissTokens = directMissTokens
    ?? (returnedHitTokens === undefined ? 0 : Math.max(0, promptTokens - cacheHitTokens));
  const cacheDataStatus = returnedHitTokens !== undefined || directMissTokens !== undefined
    ? 'reported' as const
    : 'unavailable' as const;
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
    cacheDataStatus,
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
    providerAttemptCount: 0,
    usageResponseCount: 0,
    sessionCost: 0,
    currency: normalizeCurrency(currency),
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    estimatedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {},
    byModelSource: []
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
    providerAttemptCount: 0,
    usageResponseCount: 0,
    cost: 0,
    currency: normalizeCurrency(currency),
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    estimatedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {},
    ...(modelId ? { modelId } : {})
  };
}

export function createUsageEvent(input: {
  usage: Usage;
  cost: number;
  currency: string;
  sourceId?: string;
  modelId: string;
  provider?: string;
  protocol?: string;
  pricingStatus?: UsagePricingStatus;
  requestId?: string;
  source?: UsageSource;
  requestCount?: number;
  providerAttemptCount?: number;
  unpricedReason?: string;
  ledgerRecorded?: boolean;
}): UsageEvent {
  const currency = normalizeCurrency(input.currency);
  const pricingStatus = input.pricingStatus ?? (currency ? 'priced' : 'unavailable');
  return {
    usage: normalizeUsage(input.usage),
    cost: isCostKnownPricingStatus(pricingStatus) ? normalizeCost(input.cost) : 0,
    currency,
    sourceId: normalizeOptionalString(input.sourceId),
    modelId: input.modelId,
    provider: normalizeOptionalString(input.provider),
    protocol: normalizeOptionalString(input.protocol),
    pricingStatus,
    requestId: input.requestId,
    source: input.source ?? 'executor',
    requestCount: Math.max(1, Math.floor(input.requestCount ?? 1)),
    providerAttemptCount: Math.max(1, Math.floor(input.providerAttemptCount ?? input.requestCount ?? 1)),
    unpricedReason: input.unpricedReason,
    ledgerRecorded: input.ledgerRecorded === true
  };
}

export function addUsageEventToTurnStats(
  current: TurnUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): TurnUsageStats {
  const base = normalizeTurnUsageStatsValue(current) ?? createEmptyTurnUsageStats(event.currency, event.modelId);
  const requestCount = normalizeRequestCount(event.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? requestCount : 0);
  const estimatedRequestCount = (base.estimatedRequestCount ?? 0)
    + (event.pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (event.pricingStatus === 'unavailable' ? requestCount : 0);
  const costByCurrency = addCostByCurrency(base.costByCurrency, event);
  const cacheCounts = addCacheDataCounts(base, event.usage, requestCount);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + requestCount,
    providerAttemptCount: (base.providerAttemptCount ?? base.requestCount)
      + (event.providerAttemptCount ?? requestCount),
    usageResponseCount: (base.usageResponseCount ?? base.requestCount) + requestCount,
    cost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(event.currency || base.currency),
    sourceId: event.sourceId ?? base.sourceId,
    modelId: event.modelId || base.modelId,
    provider: event.provider ?? base.provider,
    protocol: event.protocol ?? base.protocol,
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, estimatedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    estimatedRequestCount,
    unpricedRequestCount,
    ...cacheCounts,
    costByCurrency,
    updatedAt: now,
    bySource: addUsageSourceStats(
      base.bySource,
      event.source,
      event.usage,
      event.cost,
      event.currency,
      requestCount,
      event.pricingStatus
    )
  };
}

export function addUsageEventToSessionStats(
  current: SessionUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): SessionUsageStats {
  const base = normalizeSessionUsageStatsValue(current) ?? createEmptySessionUsageStats(event.currency);
  const requestCount = normalizeRequestCount(event.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? requestCount : 0);
  const estimatedRequestCount = (base.estimatedRequestCount ?? 0)
    + (event.pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (event.pricingStatus === 'unavailable' ? requestCount : 0);
  const costByCurrency = addCostByCurrency(base.costByCurrency, event);
  const cacheCounts = addCacheDataCounts(base, event.usage, requestCount);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + requestCount,
    providerAttemptCount: (base.providerAttemptCount ?? base.requestCount)
      + (event.ledgerRecorded ? 0 : event.providerAttemptCount ?? requestCount),
    usageResponseCount: (base.usageResponseCount ?? base.requestCount)
      + (event.ledgerRecorded ? 0 : requestCount),
    sessionCost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(event.currency || base.currency),
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, estimatedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    estimatedRequestCount,
    unpricedRequestCount,
    ...cacheCounts,
    costByCurrency,
    byModelSource: addUsageModelGroup(base.byModelSource, event),
    legacyUnattributed: base.legacyUnattributed,
    updatedAt: now,
    bySource: addUsageSourceStats(
      base.bySource,
      event.source,
      event.usage,
      event.cost,
      event.currency,
      requestCount,
      event.pricingStatus
    )
  };
}

/** Attempt telemetry is sourced from the append-only ledger, not zero-token usage events. */
export function applyUsageLedgerSummaryToSessionStats(
  current: SessionUsageStats | undefined,
  summary: UsageLedgerSummary
): SessionUsageStats | undefined {
  const base = normalizeSessionUsageStatsValue(current);
  if (!base && summary.providerAttemptCount === 0) return undefined;
  const stats = base ?? createEmptySessionUsageStats();
  return {
    ...stats,
    providerAttemptCount: summary.providerAttemptCount,
    usageResponseCount: summary.usageResponseCount,
    attemptStatsIncomplete: summary.incomplete || summary.legacyAggregate,
    cacheDiagnostics: summary.cacheDiagnostics
  };
}

/** Deterministic reconstruction for v2 ledger-backed sessions. */
export function rebuildSessionUsageStatsFromLedger(
  records: readonly ProviderUsageLedgerRecord[]
): SessionUsageStats | undefined {
  let stats: SessionUsageStats | undefined;
  for (const record of records) {
    if (record.kind !== 'usage_response' || !record.usage) continue;
    stats = addUsageEventToSessionStats(stats, createUsageEvent({
      usage: record.usage,
      cost: record.cost,
      currency: record.currency,
      sourceId: record.sourceId,
      modelId: record.originalModelId,
      provider: record.provider,
      protocol: record.protocol,
      pricingStatus: record.pricingStatus,
      unpricedReason: record.unpricedReason,
      ledgerRecorded: true,
      providerAttemptCount: 1,
      requestId: record.requestId,
      source: record.source
    }), record.requestStartedAt);
  }
  const ledger = {
    version: 1 as const,
    records: [...records],
    legacyAggregate: false,
    incomplete: false
  };
  return applyUsageLedgerSummaryToSessionStats(stats, summarizeUsageLedger(ledger));
}

export function addTurnUsageToSessionStats(
  current: SessionUsageStats | undefined,
  turn: TurnUsageStats,
  now = new Date().toISOString()
): SessionUsageStats {
  turn = normalizeTurnUsageStatsValue(turn) ?? turn;
  const base = normalizeSessionUsageStatsValue(current) ?? createEmptySessionUsageStats(turn.currency);
  const requestCount = Math.max(1, turn.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0));
  const estimatedRequestCount = (base.estimatedRequestCount ?? 0)
    + (turn.estimatedRequestCount ?? (turn.pricingStatus === 'estimated_upper_bound' ? requestCount : 0));
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (turn.unpricedRequestCount ?? (turn.pricingStatus === 'unavailable' ? requestCount : 0));
  const cacheDataRequestCount = (base.cacheDataRequestCount ?? 0)
    + (turn.cacheDataRequestCount ?? (turn.cacheDataStatus === 'reported' ? requestCount : 0));
  const cacheDataMissingRequestCount = (base.cacheDataMissingRequestCount ?? 0)
    + (turn.cacheDataMissingRequestCount ?? (turn.cacheDataStatus === 'reported' ? 0 : requestCount));
  const costByCurrency = mergeCostByCurrency(
    base.costByCurrency,
    turn.costByCurrency,
    turn.cost,
    turn.currency,
    (turn.pricedRequestCount ?? 0) + (turn.estimatedRequestCount ?? 0) > 0
  );
  return {
    ...sumUsage(base, turn),
    requestCount: base.requestCount + requestCount,
    providerAttemptCount: (base.providerAttemptCount ?? base.requestCount)
      + (turn.providerAttemptCount ?? requestCount),
    usageResponseCount: (base.usageResponseCount ?? base.requestCount)
      + (turn.usageResponseCount ?? requestCount),
    sessionCost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(turn.currency || base.currency),
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, estimatedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    estimatedRequestCount,
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    costByCurrency,
    byModelSource: addTurnUsageModelGroup(base.byModelSource, turn),
    legacyUnattributed: base.legacyUnattributed,
    updatedAt: now,
    bySource: mergeUsageSourceStats(base.bySource, turn.bySource)
  };
}

/** 高峰档字段未配置时回退到空闲档。 */
function pickPeakRate(
  peakValue: number | undefined,
  isPeak: boolean,
  offPeakValue: number
): number {
  if (!isPeak) {
    return normalizePrice(offPeakValue);
  }
  return peakValue === undefined
    ? normalizePrice(offPeakValue)
    : normalizePrice(peakValue);
}

/** 按当前时刻所在的峰/谷时段折算成本。 */
export function calculateUsageCost(usage: Usage, rates: UsageCostRates): number {
  return calculateUsageCostAt(usage, rates, new Date());
}

/**
 * 按请求发生时刻的峰/谷时段选价并折算成本。
 * 高峰档字段(peakCacheHitPrice / peakInputPrice / peakOutputPrice)缺省时,
 * 回退到空闲档对应字段(兼容升级前的单档配置)。
 */
export function calculateUsageCostAt(
  usage: Usage,
  rates: UsageCostRates,
  at: Date
): number {
  const peak = getPricingPeriod(at) === 'peak';
  const cacheReported = usage.cacheDataStatus === 'reported';
  const cacheHitTokens = cacheReported ? usage.cacheHitTokens : 0;
  const cacheMissTokens = cacheReported ? usage.cacheMissTokens : usage.promptTokens;
  return normalizeCost((
    cacheHitTokens * pickPeakRate(peak ? rates.peakCacheHitPrice : undefined, peak, rates.cacheHitPrice) +
    cacheMissTokens * pickPeakRate(peak ? rates.peakInputPrice : undefined, peak, rates.inputPrice) +
    usage.completionTokens * pickPeakRate(peak ? rates.peakOutputPrice : undefined, peak, rates.outputPrice)
  ) / 1_000_000);
}

export function calculateCacheHitRate(
  usage: Pick<Usage, 'cacheHitTokens' | 'cacheMissTokens'> & Partial<Pick<Usage, 'cacheDataStatus'>>
): number | undefined {
  if (usage.cacheDataStatus === 'unavailable') {
    return undefined;
  }
  const denominator = Math.max(0, usage.cacheHitTokens) + Math.max(0, usage.cacheMissTokens);
  return denominator > 0 ? (Math.max(0, usage.cacheHitTokens) / denominator) * 100 : undefined;
}

export interface CacheMissReasonInput {
  previousDiagnostics: PromptCacheDiagnostics | undefined;
  diagnostics: PromptCacheDiagnostics;
  previousTurnUsage: TurnUsageStats | undefined;
  currentTurnUsage: TurnUsageStats | undefined;
}

/**
 * 前缀缓存失效归因。
 *
 * - system / tools schema 指纹变化是从该点起整段前缀失效的直接证据，无条件归因（不依赖命中率门槛）。
 * - history 段在 append-only 投影下每轮必然追加新消息，historyPrefixHash 逐轮变化是预期行为。
 * - 历史改写和 Provider 逐出只能由逐请求账本中基于真实原生投影的字节前缀证明得出；
 *   这个旧聚合兼容入口不根据整段 hash 或命中率变化猜测。
 */
export function getCacheMissPossibleReasons(input: CacheMissReasonInput): string[] {
  const reasons: string[] = [];
  const previous = input.previousDiagnostics;
  const current = input.diagnostics;

  if (previous?.systemPromptHash && previous.systemPromptHash !== current.systemPromptHash) {
    reasons.push('system_prompt_changed');
  }
  if (previous?.toolsSchemaHash && previous.toolsSchemaHash !== current.toolsSchemaHash) {
    reasons.push('tools_schema_changed');
  }
  if (previous?.modelId && previous.modelId !== current.modelId) {
    reasons.push('model_lane_changed');
  }
  if (previous?.sourceId && previous.sourceId !== current.sourceId) {
    reasons.push('source_lane_changed');
  }
  if (previous?.protocol && previous.protocol !== current.protocol) {
    reasons.push('protocol_lane_changed');
  }
  if (previous?.baseUrl && previous.baseUrl !== current.baseUrl) {
    reasons.push('endpoint_lane_changed');
  }
  if (current.historyCompacted) {
    reasons.push('history_compacted');
  }
  if (current.historyRewriteReason) {
    reasons.push('history_rewritten');
  }
  // Whole-history hashes change on every healthy append-only turn. Provider
  // eviction and history rewrites are now diagnosed only by the request-ledger
  // observation, which proves the previous byte prefix against the actual
  // provider-native projection.
  return reasons;
}

export function normalizeSessionUsageStatsValue(value: unknown): SessionUsageStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = normalizeUsage(value);
  const requestCount = readNonNegativeInteger(value.requestCount);
  const sessionCost = normalizeCost(value.sessionCost);
  const pricingStatus = normalizeAggregatePricingStatus(value.pricingStatus)
    ?? (sessionCost > 0 ? 'priced' : 'unavailable');
  const estimatedRequestCount = readOptionalNonNegativeInteger(value.estimatedRequestCount)
    ?? (pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
  const stats: SessionUsageStats = {
    ...usage,
    requestCount,
    providerAttemptCount: readOptionalNonNegativeInteger(value.providerAttemptCount) ?? 0,
    usageResponseCount: readOptionalNonNegativeInteger(value.usageResponseCount) ?? 0,
    sessionCost,
    currency: normalizeCurrency(value.currency),
    pricingStatus,
    pricedRequestCount: readOptionalNonNegativeInteger(value.pricedRequestCount)
      ?? (pricingStatus === 'priced' ? requestCount : 0),
    estimatedRequestCount,
    unpricedRequestCount: readOptionalNonNegativeInteger(value.unpricedRequestCount)
      ?? (pricingStatus === 'unavailable' ? requestCount : 0),
    cacheDataRequestCount: readOptionalNonNegativeInteger(value.cacheDataRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? requestCount : 0),
    cacheDataMissingRequestCount: readOptionalNonNegativeInteger(value.cacheDataMissingRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? 0 : requestCount),
    costByCurrency: normalizeCostByCurrency(value.costByCurrency, value.sessionCost, value.currency),
    byModelSource: normalizeUsageModelGroups(value.byModelSource, getLegacySourceCurrency(value.costByCurrency, value.currency)),
    legacyUnattributed: typeof value.legacyUnattributed === 'boolean'
      ? value.legacyUnattributed
      : !Array.isArray(value.byModelSource),
    attemptStatsIncomplete: typeof value.attemptStatsIncomplete === 'boolean'
      ? value.attemptStatsIncomplete
      : value.providerAttemptCount === undefined || value.usageResponseCount === undefined,
    updatedAt: normalizeOptionalString(value.updatedAt),
    bySource: normalizeUsageSourceStatsMap(value.bySource, getLegacySourceCurrency(value.costByCurrency, value.currency)),
    cacheDiagnostics: normalizeCacheDiagnosticsMetrics(value.cacheDiagnostics)
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || (stats.providerAttemptCount ?? 0) > 0
    || stats.sessionCost > 0 ? stats : undefined;
}

export function normalizeTurnUsageStatsValue(value: unknown): TurnUsageStats | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const usage = normalizeUsage(value);
  const requestCount = readNonNegativeInteger(value.requestCount);
  const cost = normalizeCost(value.cost);
  const pricingStatus = normalizeAggregatePricingStatus(value.pricingStatus)
    ?? (cost > 0 ? 'priced' : 'unavailable');
  const estimatedRequestCount = readOptionalNonNegativeInteger(value.estimatedRequestCount)
    ?? (pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
  const stats: TurnUsageStats = {
    ...usage,
    requestCount,
    providerAttemptCount: readOptionalNonNegativeInteger(value.providerAttemptCount) ?? 0,
    usageResponseCount: readOptionalNonNegativeInteger(value.usageResponseCount) ?? 0,
    cost,
    currency: normalizeCurrency(value.currency),
    sourceId: normalizeOptionalString(value.sourceId),
    modelId: normalizeOptionalString(value.modelId),
    provider: normalizeOptionalString(value.provider),
    protocol: normalizeOptionalString(value.protocol),
    pricingStatus,
    pricedRequestCount: readOptionalNonNegativeInteger(value.pricedRequestCount)
      ?? (pricingStatus === 'priced' ? requestCount : 0),
    estimatedRequestCount,
    unpricedRequestCount: readOptionalNonNegativeInteger(value.unpricedRequestCount)
      ?? (pricingStatus === 'unavailable' ? requestCount : 0),
    cacheDataRequestCount: readOptionalNonNegativeInteger(value.cacheDataRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? requestCount : 0),
    cacheDataMissingRequestCount: readOptionalNonNegativeInteger(value.cacheDataMissingRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? 0 : requestCount),
    costByCurrency: normalizeCostByCurrency(value.costByCurrency, value.cost, value.currency),
    updatedAt: normalizeOptionalString(value.updatedAt),
    bySource: normalizeUsageSourceStatsMap(value.bySource, getLegacySourceCurrency(value.costByCurrency, value.currency))
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || (stats.providerAttemptCount ?? 0) > 0
    || stats.cost > 0 ? stats : undefined;
}

function normalizeCacheDiagnosticsMetrics(value: unknown): CacheDiagnosticsMetrics | undefined {
  if (!isRecord(value)) return undefined;
  const percent = (input: unknown): number | undefined => {
    const number = Number(input);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const count = (input: unknown): number => readNonNegativeInteger(input);
  const bySource = Array.isArray(value.bySource) ? value.bySource.flatMap((item) => {
    if (!isRecord(item) || typeof item.source !== 'string') return [];
    const source = USAGE_SOURCES.includes(item.source as UsageSource) ? item.source as UsageSource : 'executor';
    return [{
      source,
      ...(percent(item.rawHitRate) === undefined ? {} : { rawHitRate: percent(item.rawHitRate) }),
      ...(percent(item.expectedRawHitRateCeiling) === undefined ? {} : {
        expectedRawHitRateCeiling: percent(item.expectedRawHitRateCeiling)
      }),
      ...(percent(item.reuseEfficiency) === undefined ? {} : { reuseEfficiency: percent(item.reuseEfficiency) }),
      ...(percent(item.reuseEfficiencyRaw) === undefined ? {} : { reuseEfficiencyRaw: percent(item.reuseEfficiencyRaw) }),
      cacheDataResponseCount: count(item.cacheDataResponseCount),
      cacheDataMissingResponseCount: count(item.cacheDataMissingResponseCount),
      comparableRequestCount: count(item.comparableRequestCount),
      healthyReusableRequestCount: count(item.healthyReusableRequestCount),
      anomalousReusableRequestCount: count(item.anomalousReusableRequestCount)
    }];
  }) : [];
  const byLane = Array.isArray(value.byLane) ? value.byLane.flatMap((item) => {
    if (!isRecord(item) || typeof item.source !== 'string' || typeof item.sourceId !== 'string'
      || typeof item.provider !== 'string' || typeof item.protocol !== 'string'
      || typeof item.originalModelId !== 'string') return [];
    const source = USAGE_SOURCES.includes(item.source as UsageSource) ? item.source as UsageSource : 'executor';
    return [{
      source,
      sourceId: item.sourceId,
      provider: item.provider,
      protocol: item.protocol,
      originalModelId: item.originalModelId,
      ...(percent(item.rawHitRate) === undefined ? {} : { rawHitRate: percent(item.rawHitRate) }),
      ...(percent(item.expectedRawHitRateCeiling) === undefined ? {} : {
        expectedRawHitRateCeiling: percent(item.expectedRawHitRateCeiling)
      }),
      ...(percent(item.reuseEfficiency) === undefined ? {} : { reuseEfficiency: percent(item.reuseEfficiency) }),
      ...(percent(item.reuseEfficiencyRaw) === undefined ? {} : { reuseEfficiencyRaw: percent(item.reuseEfficiencyRaw) }),
      cacheDataResponseCount: count(item.cacheDataResponseCount),
      cacheDataMissingResponseCount: count(item.cacheDataMissingResponseCount),
      comparableRequestCount: count(item.comparableRequestCount),
      healthyReusableRequestCount: count(item.healthyReusableRequestCount),
      anomalousReusableRequestCount: count(item.anomalousReusableRequestCount)
    }];
  }) : [];
  return {
    ...(percent(value.rawHitRate) === undefined ? {} : { rawHitRate: percent(value.rawHitRate) }),
    ...(percent(value.mainAgentRawHitRate) === undefined ? {} : { mainAgentRawHitRate: percent(value.mainAgentRawHitRate) }),
    ...(percent(value.expectedRawHitRateCeiling) === undefined ? {} : {
      expectedRawHitRateCeiling: percent(value.expectedRawHitRateCeiling)
    }),
    ...(percent(value.mainAgentExpectedRawHitRateCeiling) === undefined ? {} : {
      mainAgentExpectedRawHitRateCeiling: percent(value.mainAgentExpectedRawHitRateCeiling)
    }),
    ...(percent(value.reuseEfficiency) === undefined ? {} : { reuseEfficiency: percent(value.reuseEfficiency) }),
    ...(percent(value.reuseEfficiencyRaw) === undefined ? {} : { reuseEfficiencyRaw: percent(value.reuseEfficiencyRaw) }),
    ...(percent(value.mainAgentReuseEfficiency) === undefined ? {} : {
      mainAgentReuseEfficiency: percent(value.mainAgentReuseEfficiency)
    }),
    ...(percent(value.mainAgentReuseEfficiencyRaw) === undefined ? {} : {
      mainAgentReuseEfficiencyRaw: percent(value.mainAgentReuseEfficiencyRaw)
    }),
    cacheDataResponseCount: count(value.cacheDataResponseCount),
    cacheDataMissingResponseCount: count(value.cacheDataMissingResponseCount),
    coldStartRequestCount: count(value.coldStartRequestCount),
    controlledBoundaryRequestCount: count(value.controlledBoundaryRequestCount),
    comparableRequestCount: count(value.comparableRequestCount),
    healthyReusableRequestCount: count(value.healthyReusableRequestCount),
    anomalousReusableRequestCount: count(value.anomalousReusableRequestCount),
    providerCacheEvictionPossibleCount: count(value.providerCacheEvictionPossibleCount),
    estimatedReusableTokensNotHit: count(value.estimatedReusableTokensNotHit),
    estimatedLocalBoundaryLossTokens: count(value.estimatedLocalBoundaryLossTokens),
    estimatedLocalBoundaryExtraCostByCurrency: normalizeCostByCurrency(
      value.estimatedLocalBoundaryExtraCostByCurrency, undefined, undefined
    ) ?? {},
    ...(typeof value.lastAnomalyReason === 'string'
      ? { lastAnomalyReason: value.lastAnomalyReason as CacheDiagnosticsMetrics['lastAnomalyReason'] } : {}),
    bySource,
    byLane,
    incomplete: value.incomplete === true
  };
}

export function normalizeBalanceStateValue(value: unknown): ModelSourceBalanceState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const totalBalance = readOptionalFiniteNumber(value.totalBalance);
  const cashBalance = readOptionalFiniteNumber(value.cashBalance);
  const voucherBalance = readOptionalFiniteNumber(value.voucherBalance);
  const error = normalizeOptionalString(value.error);
  if (totalBalance === undefined && cashBalance === undefined && voucherBalance === undefined && !error) {
    return undefined;
  }
  return {
    totalBalance,
    cashBalance,
    voucherBalance,
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
    historyPrefixHash: normalizeOptionalString(value.historyPrefixHash),
    modelId: normalizeOptionalString(value.modelId),
    protocol: normalizeOptionalString(value.protocol),
    sourceId: normalizeOptionalString(value.sourceId),
    baseUrl: normalizeOptionalString(value.baseUrl),
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
    cacheDataStatus: mergeCacheDataStatus(left.cacheDataStatus, right.cacheDataStatus),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
}

const USAGE_SOURCES: UsageSource[] = [
  'executor',
  'summary',
  'retry',
  'continuation',
  'background',
  'reviewer',
  'subagent',
  'retrieval',
  'router'
];

function addUsageSourceStats(
  current: Partial<Record<UsageSource, UsageSourceStats>> | undefined,
  source: UsageSource,
  usage: Usage,
  cost: number,
  currency: string,
  requestCount = 1,
  pricingStatus: UsagePricingStatus = 'unavailable'
): Partial<Record<UsageSource, UsageSourceStats>> {
  const previous = current?.[source] ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    requestCount: 0,
    cost: 0
  };
  const normalizedRequestCount = Math.max(1, Math.floor(requestCount));
  const costByCurrency = addCostByCurrency(previous.costByCurrency, {
    cost,
    currency,
    pricingStatus
  });
  const cacheCounts = addCacheDataCounts(previous, usage, normalizedRequestCount);
  return {
    ...(current ?? {}),
    [source]: {
      ...sumUsage(previous, usage),
      requestCount: previous.requestCount + normalizedRequestCount,
      usageResponseCount: (previous.usageResponseCount ?? previous.requestCount) + normalizedRequestCount,
      cost: getSingleCurrencyCost(costByCurrency),
      pricedRequestCount: (previous.pricedRequestCount ?? 0)
        + (pricingStatus === 'priced' ? normalizedRequestCount : 0),
      estimatedRequestCount: (previous.estimatedRequestCount ?? 0)
        + (pricingStatus === 'estimated_upper_bound' ? normalizedRequestCount : 0),
      unpricedRequestCount: (previous.unpricedRequestCount ?? 0)
        + (pricingStatus === 'unavailable' ? normalizedRequestCount : 0),
      ...cacheCounts,
      costByCurrency
    }
  };
}

function mergeUsageSourceStats(
  left: Partial<Record<UsageSource, UsageSourceStats>> | undefined,
  right: Partial<Record<UsageSource, UsageSourceStats>> | undefined
): Partial<Record<UsageSource, UsageSourceStats>> | undefined {
  let merged = left ? { ...left } : undefined;
  for (const source of USAGE_SOURCES) {
    const stats = right?.[source];
    if (!stats) {
      continue;
    }
    const previous = merged?.[source] ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      requestCount: 0,
      cost: 0
    };
    const costByCurrency = mergeCostByCurrency(
      previous.costByCurrency,
      stats.costByCurrency,
      stats.cost,
      '',
      (stats.pricedRequestCount ?? 0) + (stats.estimatedRequestCount ?? 0) > 0
    );
    merged = {
      ...(merged ?? {}),
      [source]: {
        ...sumUsage(previous, stats),
        requestCount: previous.requestCount + stats.requestCount,
        usageResponseCount: (previous.usageResponseCount ?? previous.requestCount)
          + (stats.usageResponseCount ?? stats.requestCount),
        cost: getSingleCurrencyCost(costByCurrency),
        pricedRequestCount: (previous.pricedRequestCount ?? 0) + (stats.pricedRequestCount ?? 0),
        estimatedRequestCount: (previous.estimatedRequestCount ?? 0) + (stats.estimatedRequestCount ?? 0),
        unpricedRequestCount: (previous.unpricedRequestCount ?? 0) + (stats.unpricedRequestCount ?? 0),
        cacheDataRequestCount: (previous.cacheDataRequestCount ?? 0) + (stats.cacheDataRequestCount ?? 0),
        cacheDataMissingRequestCount: (previous.cacheDataMissingRequestCount ?? 0)
          + (stats.cacheDataMissingRequestCount ?? 0),
        costByCurrency
      }
    };
  }
  return merged;
}

function normalizeUsageSourceStatsMap(
  value: unknown,
  fallbackCurrency?: unknown
): Partial<Record<UsageSource, UsageSourceStats>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Partial<Record<UsageSource, UsageSourceStats>> = {};
  for (const source of USAGE_SOURCES) {
    const raw = value[source];
    if (!isRecord(raw)) {
      continue;
    }
    const usage = normalizeUsage(raw);
    const requestCount = readNonNegativeInteger(raw.requestCount);
    const legacyCost = normalizeCost(raw.cost);
    const pricedRequestCount = readOptionalNonNegativeInteger(raw.pricedRequestCount)
      ?? (raw.pricingStatus === 'estimated_upper_bound' ? 0 : legacyCost > 0 ? requestCount : 0);
    const estimatedRequestCount = readOptionalNonNegativeInteger(raw.estimatedRequestCount)
      ?? (raw.pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
    const costByCurrency = normalizeCostByCurrency(raw.costByCurrency, raw.cost, fallbackCurrency);
    result[source] = {
      ...usage,
      requestCount,
      usageResponseCount: readOptionalNonNegativeInteger(raw.usageResponseCount) ?? requestCount,
      cost: costByCurrency ? getSingleCurrencyCost(costByCurrency) : legacyCost,
      pricedRequestCount,
      estimatedRequestCount,
      unpricedRequestCount: readOptionalNonNegativeInteger(raw.unpricedRequestCount)
        ?? Math.max(0, requestCount - pricedRequestCount),
      cacheDataRequestCount: readOptionalNonNegativeInteger(raw.cacheDataRequestCount)
        ?? (usage.cacheDataStatus === 'reported' ? requestCount : 0),
      cacheDataMissingRequestCount: readOptionalNonNegativeInteger(raw.cacheDataMissingRequestCount)
        ?? (usage.cacheDataStatus === 'reported' ? 0 : requestCount),
      costByCurrency
    };
  }
  return Object.keys(result).length ? result : undefined;
}

function normalizeUsage(value: unknown): Usage {
  const record = isRecord(value) ? value : {};
  const reasoningTokens = readOptionalNonNegativeInteger(record.reasoningTokens);
  const cacheHitTokens = readNonNegativeInteger(record.cacheHitTokens);
  const cacheMissTokens = readNonNegativeInteger(record.cacheMissTokens);
  return {
    promptTokens: readNonNegativeInteger(record.promptTokens),
    completionTokens: readNonNegativeInteger(record.completionTokens),
    totalTokens: readNonNegativeInteger(record.totalTokens),
    cacheHitTokens,
    cacheMissTokens,
    cacheDataStatus: normalizeCacheDataStatus(record.cacheDataStatus)
      ?? (cacheHitTokens + cacheMissTokens > 0 ? 'reported' : 'unavailable'),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

function addUsageModelGroup(
  current: UsageModelGroupStats[] | undefined,
  event: UsageEvent
): UsageModelGroupStats[] {
  const groups: UsageModelGroupStats[] = (current ?? []).map((group): UsageModelGroupStats => ({
    ...group,
    costByCurrency: group.costByCurrency ? { ...group.costByCurrency } : undefined,
    bySource: group.bySource ? { ...group.bySource } : undefined
  }));
  const sourceId = event.sourceId?.trim() ?? '';
  const index = groups.findIndex((group) => group.sourceId === sourceId && group.modelId === event.modelId);
  const previous = index >= 0 ? groups[index] : createEmptyUsageModelGroup(event);
  const requestCount = normalizeRequestCount(event.requestCount);
  const pricedRequestCount = previous.pricedRequestCount
    + (event.pricingStatus === 'priced' ? requestCount : 0);
  const estimatedRequestCount = (previous.estimatedRequestCount ?? 0)
    + (event.pricingStatus === 'estimated_upper_bound' ? requestCount : 0);
  const unpricedRequestCount = previous.unpricedRequestCount
    + (event.pricingStatus === 'unavailable' ? requestCount : 0);
  const cacheDataRequestCount = previous.cacheDataRequestCount
    + (event.usage.cacheDataStatus === 'reported' ? requestCount : 0);
  const cacheDataMissingRequestCount = previous.cacheDataMissingRequestCount
    + (event.usage.cacheDataStatus === 'reported' ? 0 : requestCount);
  const next: UsageModelGroupStats = {
    ...sumUsage(previous, event.usage),
    sourceId,
    modelId: event.modelId,
    provider: event.provider ?? previous.provider,
    protocol: event.protocol ?? previous.protocol,
    requestCount: previous.requestCount + requestCount,
    pricedRequestCount,
    estimatedRequestCount,
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    costByCurrency: addCostByCurrency(previous.costByCurrency, event),
    bySource: addUsageSourceStats(
      previous.bySource,
      event.source,
      event.usage,
      event.cost,
      event.currency,
      requestCount,
      event.pricingStatus
    )
  };
  if (index >= 0) {
    groups[index] = next;
  } else {
    groups.push(next);
  }
  return groups;
}

function addTurnUsageModelGroup(
  current: UsageModelGroupStats[] | undefined,
  turn: TurnUsageStats
): UsageModelGroupStats[] {
  const groups: UsageModelGroupStats[] = (current ?? []).map((group): UsageModelGroupStats => ({
    ...group,
    costByCurrency: group.costByCurrency ? { ...group.costByCurrency } : undefined,
    bySource: group.bySource ? { ...group.bySource } : undefined
  }));
  const sourceId = turn.sourceId?.trim() ?? '';
  const modelId = turn.modelId?.trim() ?? '';
  const index = groups.findIndex((group) => group.sourceId === sourceId && group.modelId === modelId);
  const previous = index >= 0
    ? groups[index]
    : createEmptyUsageModelGroup({
        usage: turn,
        cost: turn.cost,
        currency: turn.currency,
        sourceId,
        modelId,
        provider: turn.provider,
        protocol: turn.protocol,
        pricingStatus: turn.pricingStatus === 'priced' || turn.pricingStatus === 'estimated_upper_bound'
          ? turn.pricingStatus : 'unavailable',
        source: 'executor',
        requestCount: Math.max(1, turn.requestCount)
      });
  const requestCount = Math.max(1, turn.requestCount);
  const pricedRequestCount = previous.pricedRequestCount
    + (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0));
  const estimatedRequestCount = (previous.estimatedRequestCount ?? 0)
    + (turn.estimatedRequestCount ?? (turn.pricingStatus === 'estimated_upper_bound' ? requestCount : 0));
  const next: UsageModelGroupStats = {
    ...sumUsage(previous, turn),
    sourceId,
    modelId,
    provider: turn.provider ?? previous.provider,
    protocol: turn.protocol ?? previous.protocol,
    requestCount: previous.requestCount + requestCount,
    pricedRequestCount,
    estimatedRequestCount,
    unpricedRequestCount: previous.unpricedRequestCount
      + (turn.unpricedRequestCount ?? (turn.pricingStatus === 'unavailable' ? requestCount : 0)),
    cacheDataRequestCount: previous.cacheDataRequestCount
      + (turn.cacheDataRequestCount ?? (turn.cacheDataStatus === 'reported' ? requestCount : 0)),
    cacheDataMissingRequestCount: previous.cacheDataMissingRequestCount
      + (turn.cacheDataMissingRequestCount ?? (turn.cacheDataStatus === 'reported' ? 0 : requestCount)),
    costByCurrency: mergeCostByCurrency(
      previous.costByCurrency,
      turn.costByCurrency,
      turn.cost,
      turn.currency,
      (turn.pricedRequestCount ?? 0) + (turn.estimatedRequestCount ?? 0) > 0
    ),
    bySource: mergeUsageSourceStats(previous.bySource, turn.bySource)
  };
  if (index >= 0) {
    groups[index] = next;
  } else {
    groups.push(next);
  }
  return groups;
}

function createEmptyUsageModelGroup(event: UsageEvent): UsageModelGroupStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    sourceId: event.sourceId?.trim() ?? '',
    modelId: event.modelId,
    provider: event.provider,
    protocol: event.protocol,
    requestCount: 0,
    pricedRequestCount: 0,
    estimatedRequestCount: 0,
    unpricedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  };
}

function normalizeUsageModelGroups(value: unknown, fallbackCurrency?: unknown): UsageModelGroupStats[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const groups: UsageModelGroupStats[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.modelId !== 'string' || !item.modelId.trim()) {
      continue;
    }
    groups.push({
      ...normalizeUsage(item),
      sourceId: normalizeOptionalString(item.sourceId) ?? '',
      modelId: item.modelId.trim(),
      provider: normalizeOptionalString(item.provider),
      protocol: normalizeOptionalString(item.protocol),
      requestCount: readNonNegativeInteger(item.requestCount),
      pricedRequestCount: readNonNegativeInteger(item.pricedRequestCount),
      estimatedRequestCount: readNonNegativeInteger(item.estimatedRequestCount),
      unpricedRequestCount: readNonNegativeInteger(item.unpricedRequestCount),
      cacheDataRequestCount: readNonNegativeInteger(item.cacheDataRequestCount),
      cacheDataMissingRequestCount: readNonNegativeInteger(item.cacheDataMissingRequestCount),
      costByCurrency: normalizeCostByCurrency(item.costByCurrency),
      bySource: normalizeUsageSourceStatsMap(item.bySource, getLegacySourceCurrency(item.costByCurrency, fallbackCurrency))
    });
  }
  return groups.length ? groups : [];
}

function addCacheDataCounts(
  current: { cacheDataRequestCount?: number; cacheDataMissingRequestCount?: number },
  usage: Usage,
  requestCount: number
): { cacheDataRequestCount: number; cacheDataMissingRequestCount: number } {
  const reported = usage.cacheDataStatus === 'reported';
  return {
    cacheDataRequestCount: (current.cacheDataRequestCount ?? 0) + (reported ? requestCount : 0),
    cacheDataMissingRequestCount: (current.cacheDataMissingRequestCount ?? 0) + (reported ? 0 : requestCount)
  };
}

function addCostByCurrency(
  current: Record<string, number> | undefined,
  event: Pick<UsageEvent, 'pricingStatus' | 'currency' | 'cost'>
): Record<string, number> {
  const result = { ...(current ?? {}) };
  const currency = normalizeCurrency(event.currency);
  if (isCostKnownPricingStatus(event.pricingStatus) && currency) {
    result[currency] = normalizeCost((result[currency] ?? 0) + event.cost);
  }
  return result;
}

function mergeCostByCurrency(
  current: Record<string, number> | undefined,
  incoming: Record<string, number> | undefined,
  fallbackCost: number,
  fallbackCurrency: string,
  hasPricedRequests: boolean
): Record<string, number> {
  const result = { ...(current ?? {}) };
  const normalizedIncoming = normalizeCostByCurrency(incoming);
  if (normalizedIncoming && Object.keys(normalizedIncoming).length) {
    for (const [currency, cost] of Object.entries(normalizedIncoming)) {
      result[currency] = normalizeCost((result[currency] ?? 0) + cost);
    }
    return result;
  }
  const currency = normalizeCurrency(fallbackCurrency);
  if (hasPricedRequests && currency) {
    result[currency] = normalizeCost((result[currency] ?? 0) + fallbackCost);
  }
  return result;
}

function normalizeCostByCurrency(
  value: unknown,
  legacyCost?: unknown,
  legacyCurrency?: unknown
): Record<string, number> | undefined {
  const result: Record<string, number> = {};
  if (isRecord(value)) {
    for (const [currency, cost] of Object.entries(value)) {
      if (currency.trim()) {
        result[currency.trim()] = normalizeCost(cost);
      }
    }
  } else {
    const cost = normalizeCost(legacyCost);
    const currency = normalizeCurrency(legacyCurrency);
    if (cost > 0 && currency) {
      result[currency] = cost;
    }
  }
  return Object.keys(result).length ? result : {};
}

function getSingleCurrency(costs: Record<string, number>): string | undefined {
  const currencies = Object.keys(costs);
  return currencies.length === 1 ? currencies[0] : undefined;
}

function getLegacySourceCurrency(value: unknown, fallback: unknown): string {
  const costs = normalizeCostByCurrency(value);
  const currencies = Object.keys(costs ?? {});
  // Old per-source scalar costs cannot be assigned to a currency when the
  // containing aggregate already includes multiple currencies.
  return currencies.length > 1 ? '' : currencies[0] ?? normalizeCurrency(fallback);
}

function getSingleCurrencyCost(costs: Record<string, number>): number {
  const currency = getSingleCurrency(costs);
  return currency ? normalizeCost(costs[currency]) : 0;
}

function getAggregatePricingStatus(
  pricedRequestCount: number,
  estimatedRequestCount: number,
  unpricedRequestCount: number
): 'priced' | 'estimated_upper_bound' | 'unavailable' | 'partial' {
  const knownCount = pricedRequestCount + estimatedRequestCount;
  if (knownCount > 0 && unpricedRequestCount > 0) {
    return 'partial';
  }
  if (estimatedRequestCount > 0) return 'estimated_upper_bound';
  return pricedRequestCount > 0 ? 'priced' : 'unavailable';
}

function normalizeAggregatePricingStatus(
  value: unknown
): 'priced' | 'estimated_upper_bound' | 'unavailable' | 'partial' | undefined {
  return value === 'priced' || value === 'estimated_upper_bound'
    || value === 'unavailable' || value === 'partial' ? value : undefined;
}

function isCostKnownPricingStatus(value: UsagePricingStatus | undefined): boolean {
  return value === 'priced' || value === 'estimated_upper_bound';
}

function normalizeCacheDataStatus(value: unknown): Usage['cacheDataStatus'] | undefined {
  return value === 'reported' || value === 'partial' || value === 'unavailable' ? value : undefined;
}

function mergeCacheDataStatus(
  left: Usage['cacheDataStatus'],
  right: Usage['cacheDataStatus']
): NonNullable<Usage['cacheDataStatus']> {
  if (!left) {
    return right ?? 'unavailable';
  }
  if (!right) {
    return left;
  }
  const normalizedLeft = left ?? 'unavailable';
  const normalizedRight = right ?? 'unavailable';
  if (normalizedLeft === 'partial' || normalizedRight === 'partial') {
    return 'partial';
  }
  return normalizedLeft === normalizedRight ? normalizedLeft : 'partial';
}

function normalizeRequestCount(value: number | undefined): number {
  return Math.max(1, Math.floor(value ?? 1));
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
  return typeof value === 'string' ? value.trim() : DEFAULT_CURRENCY;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
