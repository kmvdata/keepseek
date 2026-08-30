import type { DeepSeekUsage } from './deepseek/types';
import type {
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
  UsageSourceStats
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
    sessionCost: 0,
    currency: normalizeCurrency(currency),
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
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
    cost: 0,
    currency: normalizeCurrency(currency),
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
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
}): UsageEvent {
  const currency = normalizeCurrency(input.currency);
  const pricingStatus = input.pricingStatus ?? (currency ? 'priced' : 'unavailable');
  return {
    usage: normalizeUsage(input.usage),
    cost: pricingStatus === 'priced' ? normalizeCost(input.cost) : 0,
    currency,
    sourceId: normalizeOptionalString(input.sourceId),
    modelId: input.modelId,
    provider: normalizeOptionalString(input.provider),
    protocol: normalizeOptionalString(input.protocol),
    pricingStatus,
    requestId: input.requestId,
    source: input.source ?? 'executor',
    requestCount: Math.max(1, Math.floor(input.requestCount ?? 1))
  };
}

export function addUsageEventToTurnStats(
  current: TurnUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): TurnUsageStats {
  const base = current ?? createEmptyTurnUsageStats(event.currency, event.modelId);
  const requestCount = normalizeRequestCount(event.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? requestCount : 0);
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? 0 : requestCount);
  const costByCurrency = addCostByCurrency(base.costByCurrency, event);
  const cacheCounts = addCacheDataCounts(base, event.usage, requestCount);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + requestCount,
    cost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(event.currency || base.currency),
    sourceId: event.sourceId ?? base.sourceId,
    modelId: event.modelId || base.modelId,
    provider: event.provider ?? base.provider,
    protocol: event.protocol ?? base.protocol,
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    unpricedRequestCount,
    ...cacheCounts,
    costByCurrency,
    updatedAt: now,
    bySource: addUsageSourceStats(base.bySource, event.source, event.usage, event.cost, requestCount, event.pricingStatus)
  };
}

export function addUsageEventToSessionStats(
  current: SessionUsageStats | undefined,
  event: UsageEvent,
  now = new Date().toISOString()
): SessionUsageStats {
  const base = current ?? createEmptySessionUsageStats(event.currency);
  const requestCount = normalizeRequestCount(event.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? requestCount : 0);
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (event.pricingStatus === 'priced' ? 0 : requestCount);
  const costByCurrency = addCostByCurrency(base.costByCurrency, event);
  const cacheCounts = addCacheDataCounts(base, event.usage, requestCount);
  return {
    ...sumUsage(base, event.usage),
    requestCount: base.requestCount + requestCount,
    sessionCost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(event.currency || base.currency),
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    unpricedRequestCount,
    ...cacheCounts,
    costByCurrency,
    byModelSource: addUsageModelGroup(base.byModelSource, event),
    legacyUnattributed: base.legacyUnattributed,
    updatedAt: now,
    bySource: addUsageSourceStats(base.bySource, event.source, event.usage, event.cost, requestCount, event.pricingStatus)
  };
}

export function addTurnUsageToSessionStats(
  current: SessionUsageStats | undefined,
  turn: TurnUsageStats,
  now = new Date().toISOString()
): SessionUsageStats {
  const base = current ?? createEmptySessionUsageStats(turn.currency);
  const requestCount = Math.max(1, turn.requestCount);
  const pricedRequestCount = (base.pricedRequestCount ?? 0)
    + (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0));
  const unpricedRequestCount = (base.unpricedRequestCount ?? 0)
    + (turn.unpricedRequestCount ?? (turn.pricingStatus === 'priced' ? 0 : requestCount));
  const cacheDataRequestCount = (base.cacheDataRequestCount ?? 0)
    + (turn.cacheDataRequestCount ?? (turn.cacheDataStatus === 'reported' ? requestCount : 0));
  const cacheDataMissingRequestCount = (base.cacheDataMissingRequestCount ?? 0)
    + (turn.cacheDataMissingRequestCount ?? (turn.cacheDataStatus === 'reported' ? 0 : requestCount));
  const costByCurrency = mergeCostByCurrency(
    base.costByCurrency,
    turn.costByCurrency,
    turn.cost,
    turn.currency,
    (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0)) > 0
  );
  return {
    ...sumUsage(base, turn),
    requestCount: base.requestCount + requestCount,
    sessionCost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? normalizeCurrency(turn.currency || base.currency),
    pricingStatus: getAggregatePricingStatus(pricedRequestCount, unpricedRequestCount),
    pricedRequestCount,
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

export type PricingPeriod = 'offPeak' | 'peak';

/**
 * DeepSeek 峰谷计价时段判定(北京时间,公告口径 2026-08-17 起)。
 *
 * 高峰时段 = 北京时间每日 9:00-12:00 与 14:00-18:00,其余为空闲时段。
 * 把时间整体加 8 小时再读 UTC 小时,得到等价于北京时钟的小时数,不依赖运行环境时区。
 */
export function getPricingPeriod(date: Date = new Date()): PricingPeriod {
  const beijingHour = new Date(date.getTime() + 8 * 60 * 60 * 1000).getUTCHours();
  const isPeak =
    (beijingHour >= 9 && beijingHour < 12) ||
    (beijingHour >= 14 && beijingHour < 18);
  return isPeak ? 'peak' : 'offPeak';
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

/** 按空闲档价格折算成本(保留旧入口,等价于按非高峰档计费)。 */
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
  return normalizeCost((
    usage.cacheHitTokens * pickPeakRate(peak ? rates.peakCacheHitPrice : undefined, peak, rates.cacheHitPrice) +
    usage.cacheMissTokens * pickPeakRate(peak ? rates.peakInputPrice : undefined, peak, rates.inputPrice) +
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
 * - history 段在 append-only 投影下每轮必然追加新消息，historyPrefixHash 逐轮变化是预期行为；
 *   只有命中率显著下降时才把 history 变化或 provider 缓存逐出列为候选原因。
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
    reasons.push('model_changed');
  }
  if (previous?.sourceId && previous.sourceId !== current.sourceId) {
    reasons.push('source_changed');
  }
  if (previous?.protocol && previous.protocol !== current.protocol) {
    reasons.push('protocol_changed');
  }
  if (previous?.baseUrl && previous.baseUrl !== current.baseUrl) {
    reasons.push('endpoint_lane_changed');
  }
  if (current.historyCompacted) {
    reasons.push('history_compacted');
  }
  if (current.historyRewriteReason) {
    reasons.push(`history_rewrite:${current.historyRewriteReason}`);
  }

  const previousHitRate = input.previousTurnUsage ? calculateCacheHitRate(input.previousTurnUsage) : undefined;
  const currentHitRate = input.currentTurnUsage ? calculateCacheHitRate(input.currentTurnUsage) : undefined;
  if (
    previousHitRate !== undefined &&
    currentHitRate !== undefined &&
    previousHitRate >= 60 &&
    previousHitRate - currentHitRate >= 30
  ) {
    if (previous?.historyPrefixHash && previous.historyPrefixHash !== current.historyPrefixHash) {
      reasons.push('history_prefix_changed');
    }
    if (!reasons.length) {
      reasons.push('provider_cache_eviction_possible');
    }
  }
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
  const stats: SessionUsageStats = {
    ...usage,
    requestCount,
    sessionCost,
    currency: normalizeCurrency(value.currency),
    pricingStatus,
    pricedRequestCount: readOptionalNonNegativeInteger(value.pricedRequestCount)
      ?? (pricingStatus === 'priced' ? requestCount : 0),
    unpricedRequestCount: readOptionalNonNegativeInteger(value.unpricedRequestCount)
      ?? (pricingStatus === 'priced' ? 0 : requestCount),
    cacheDataRequestCount: readOptionalNonNegativeInteger(value.cacheDataRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? requestCount : 0),
    cacheDataMissingRequestCount: readOptionalNonNegativeInteger(value.cacheDataMissingRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? 0 : requestCount),
    costByCurrency: normalizeCostByCurrency(value.costByCurrency, value.sessionCost, value.currency),
    byModelSource: normalizeUsageModelGroups(value.byModelSource),
    legacyUnattributed: typeof value.legacyUnattributed === 'boolean'
      ? value.legacyUnattributed
      : !Array.isArray(value.byModelSource),
    updatedAt: normalizeOptionalString(value.updatedAt),
    bySource: normalizeUsageSourceStatsMap(value.bySource)
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || stats.sessionCost > 0 ? stats : undefined;
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
  const stats: TurnUsageStats = {
    ...usage,
    requestCount,
    cost,
    currency: normalizeCurrency(value.currency),
    sourceId: normalizeOptionalString(value.sourceId),
    modelId: normalizeOptionalString(value.modelId),
    provider: normalizeOptionalString(value.provider),
    protocol: normalizeOptionalString(value.protocol),
    pricingStatus,
    pricedRequestCount: readOptionalNonNegativeInteger(value.pricedRequestCount)
      ?? (pricingStatus === 'priced' ? requestCount : 0),
    unpricedRequestCount: readOptionalNonNegativeInteger(value.unpricedRequestCount)
      ?? (pricingStatus === 'priced' ? 0 : requestCount),
    cacheDataRequestCount: readOptionalNonNegativeInteger(value.cacheDataRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? requestCount : 0),
    cacheDataMissingRequestCount: readOptionalNonNegativeInteger(value.cacheDataMissingRequestCount)
      ?? (usage.cacheDataStatus === 'reported' ? 0 : requestCount),
    costByCurrency: normalizeCostByCurrency(value.costByCurrency, value.cost, value.currency),
    updatedAt: normalizeOptionalString(value.updatedAt),
    bySource: normalizeUsageSourceStatsMap(value.bySource)
  };
  return hasAnyUsage(stats) || stats.requestCount > 0 || stats.cost > 0 ? stats : undefined;
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
  'subagent',
  'retrieval',
  'router'
];

function addUsageSourceStats(
  current: Partial<Record<UsageSource, UsageSourceStats>> | undefined,
  source: UsageSource,
  usage: Usage,
  cost: number,
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
  return {
    ...(current ?? {}),
    [source]: {
      ...sumUsage(previous, usage),
      requestCount: previous.requestCount + Math.max(1, Math.floor(requestCount)),
      cost: normalizeCost(previous.cost + (pricingStatus === 'priced' ? cost : 0)),
      pricedRequestCount: (previous.pricedRequestCount ?? 0)
        + (pricingStatus === 'priced' ? requestCount : 0),
      unpricedRequestCount: (previous.unpricedRequestCount ?? 0)
        + (pricingStatus === 'priced' ? 0 : requestCount)
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
    merged = {
      ...(merged ?? {}),
      [source]: {
        ...sumUsage(previous, stats),
        requestCount: previous.requestCount + stats.requestCount,
        cost: normalizeCost(previous.cost + stats.cost),
        pricedRequestCount: (previous.pricedRequestCount ?? 0) + (stats.pricedRequestCount ?? 0),
        unpricedRequestCount: (previous.unpricedRequestCount ?? 0) + (stats.unpricedRequestCount ?? 0)
      }
    };
  }
  return merged;
}

function normalizeUsageSourceStatsMap(
  value: unknown
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
    result[source] = {
      ...normalizeUsage(raw),
      requestCount: readNonNegativeInteger(raw.requestCount),
      cost: normalizeCost(raw.cost),
      pricedRequestCount: readOptionalNonNegativeInteger(raw.pricedRequestCount),
      unpricedRequestCount: readOptionalNonNegativeInteger(raw.unpricedRequestCount)
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
  const unpricedRequestCount = previous.unpricedRequestCount
    + (event.pricingStatus === 'priced' ? 0 : requestCount);
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
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    costByCurrency: addCostByCurrency(previous.costByCurrency, event),
    bySource: addUsageSourceStats(
      previous.bySource,
      event.source,
      event.usage,
      event.cost,
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
        pricingStatus: turn.pricingStatus === 'priced' ? 'priced' : 'unavailable',
        source: 'executor',
        requestCount: Math.max(1, turn.requestCount)
      });
  const requestCount = Math.max(1, turn.requestCount);
  const pricedRequestCount = previous.pricedRequestCount
    + (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0));
  const next: UsageModelGroupStats = {
    ...sumUsage(previous, turn),
    sourceId,
    modelId,
    provider: turn.provider ?? previous.provider,
    protocol: turn.protocol ?? previous.protocol,
    requestCount: previous.requestCount + requestCount,
    pricedRequestCount,
    unpricedRequestCount: previous.unpricedRequestCount
      + (turn.unpricedRequestCount ?? (turn.pricingStatus === 'priced' ? 0 : requestCount)),
    cacheDataRequestCount: previous.cacheDataRequestCount
      + (turn.cacheDataRequestCount ?? (turn.cacheDataStatus === 'reported' ? requestCount : 0)),
    cacheDataMissingRequestCount: previous.cacheDataMissingRequestCount
      + (turn.cacheDataMissingRequestCount ?? (turn.cacheDataStatus === 'reported' ? 0 : requestCount)),
    costByCurrency: mergeCostByCurrency(
      previous.costByCurrency,
      turn.costByCurrency,
      turn.cost,
      turn.currency,
      (turn.pricedRequestCount ?? (turn.pricingStatus === 'priced' ? requestCount : 0)) > 0
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
    unpricedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  };
}

function normalizeUsageModelGroups(value: unknown): UsageModelGroupStats[] | undefined {
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
      unpricedRequestCount: readNonNegativeInteger(item.unpricedRequestCount),
      cacheDataRequestCount: readNonNegativeInteger(item.cacheDataRequestCount),
      cacheDataMissingRequestCount: readNonNegativeInteger(item.cacheDataMissingRequestCount),
      costByCurrency: normalizeCostByCurrency(item.costByCurrency),
      bySource: normalizeUsageSourceStatsMap(item.bySource)
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
  if (event.pricingStatus === 'priced' && currency) {
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

function getSingleCurrencyCost(costs: Record<string, number>): number {
  const currency = getSingleCurrency(costs);
  return currency ? normalizeCost(costs[currency]) : 0;
}

function getAggregatePricingStatus(
  pricedRequestCount: number,
  unpricedRequestCount: number
): 'priced' | 'unavailable' | 'partial' {
  if (pricedRequestCount > 0 && unpricedRequestCount > 0) {
    return 'partial';
  }
  return pricedRequestCount > 0 ? 'priced' : 'unavailable';
}

function normalizeAggregatePricingStatus(value: unknown): 'priced' | 'unavailable' | 'partial' | undefined {
  return value === 'priced' || value === 'unavailable' || value === 'partial' ? value : undefined;
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
