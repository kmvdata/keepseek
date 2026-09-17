import type {
  SessionUsageStats,
  TurnUsageStats,
  UsageCostRates,
  UsageSource,
  UsageSourceStats
} from '../shared/types';
import {
  calculateUsageCostAt,
  normalizeSessionUsageStatsValue,
  normalizeTurnUsageStatsValue
} from './usageStats';

export interface UsagePricingIdentity {
  sourceId?: string;
  modelId?: string;
  provider?: string;
  protocol?: string;
}

export type UsagePricingResolver = (
  identity: UsagePricingIdentity
) => UsageCostRates | undefined;

export interface UsagePricingDisplayProjection {
  sessionUsageStats?: SessionUsageStats;
  lastTurnUsage?: TurnUsageStats;
}

interface SourcePricingDelta {
  requestCount: number;
  costByCurrency: Record<string, number>;
}

/**
 * Reconstruct display-only cost for old aggregate records created before a
 * known official model alias had pricing. The stored accounting record remains
 * append-only; only completely unpriced, currently verified billing-capable
 * model groups are projected.
 */
export function projectUsagePricingForDisplay(input: {
  sessionUsageStats?: SessionUsageStats;
  lastTurnUsage?: TurnUsageStats;
  resolvePricing: UsagePricingResolver;
}): UsagePricingDisplayProjection {
  const session = normalizeSessionUsageStatsValue(input.sessionUsageStats);
  return {
    sessionUsageStats: projectSessionUsagePricing(session, input.resolvePricing),
    lastTurnUsage: projectTurnUsagePricing(
      input.lastTurnUsage,
      getSoleSessionIdentity(session),
      input.resolvePricing
    )
  };
}

function projectSessionUsagePricing(
  session: SessionUsageStats | undefined,
  resolvePricing: UsagePricingResolver
): SessionUsageStats | undefined {
  if (!session?.byModelSource?.length) {
    return session;
  }
  const at = readUsageDate(session.updatedAt);
  let addedCosts: Record<string, number> = {};
  const sourceDeltas: Partial<Record<UsageSource, SourcePricingDelta>> = {};
  let addedPricedRequests = 0;
  const byModelSource = session.byModelSource.map((group) => {
    const unpricedRequestCount = group.unpricedRequestCount ?? 0;
    if ((group.pricedRequestCount ?? 0) > 0 || unpricedRequestCount <= 0) {
      return group;
    }
    const rates = resolvePricing(group);
    if (!rates?.currency) {
      return group;
    }
    const cost = calculateUsageCostAt(group, rates, at);
    addedCosts = addCurrencyCost(addedCosts, rates.currency, cost);
    addedPricedRequests += unpricedRequestCount;
    const bySource = projectSourceStats(group.bySource, rates, at, sourceDeltas);
    return {
      ...group,
      pricedRequestCount: (group.pricedRequestCount ?? 0) + unpricedRequestCount,
      unpricedRequestCount: 0,
      costByCurrency: addCurrencyCost(group.costByCurrency, rates.currency, cost),
      bySource
    };
  });
  if (!addedPricedRequests) {
    return session;
  }
  const pricedRequestCount = (session.pricedRequestCount ?? 0) + addedPricedRequests;
  const unpricedRequestCount = Math.max(0, (session.unpricedRequestCount ?? 0) - addedPricedRequests);
  const costByCurrency = mergeCurrencyCosts(session.costByCurrency, addedCosts);
  const currency = getSingleCurrency(costByCurrency) ?? session.currency;
  return {
    ...session,
    sessionCost: getSingleCurrencyCost(costByCurrency),
    currency,
    pricingStatus: aggregatePricingStatus(pricedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    unpricedRequestCount,
    costByCurrency,
    byModelSource,
    bySource: applySourcePricingDeltas(session.bySource, sourceDeltas)
  };
}

function projectTurnUsagePricing(
  value: TurnUsageStats | undefined,
  soleSessionIdentity: UsagePricingIdentity | undefined,
  resolvePricing: UsagePricingResolver
): TurnUsageStats | undefined {
  const turn = normalizeTurnUsageStatsValue(value);
  const unpricedRequestCount = turn?.unpricedRequestCount ?? 0;
  if (
    !turn
    || !sameUsageIdentity(turn, soleSessionIdentity)
    || (turn.pricedRequestCount ?? 0) > 0
    || unpricedRequestCount <= 0
  ) {
    return turn;
  }
  const rates = resolvePricing(turn);
  if (!rates?.currency) {
    return turn;
  }
  const at = readUsageDate(turn.updatedAt);
  const cost = calculateUsageCostAt(turn, rates, at);
  const costByCurrency = addCurrencyCost(turn.costByCurrency, rates.currency, cost);
  const sourceDeltas: Partial<Record<UsageSource, SourcePricingDelta>> = {};
  return {
    ...turn,
    cost: getSingleCurrencyCost(costByCurrency),
    currency: getSingleCurrency(costByCurrency) ?? rates.currency,
    pricingStatus: 'priced',
    pricedRequestCount: (turn.pricedRequestCount ?? 0) + unpricedRequestCount,
    unpricedRequestCount: 0,
    costByCurrency,
    bySource: projectSourceStats(turn.bySource, rates, at, sourceDeltas)
  };
}

function getSoleSessionIdentity(
  session: SessionUsageStats | undefined
): UsagePricingIdentity | undefined {
  return session?.byModelSource?.length === 1
    ? session.byModelSource[0]
    : undefined;
}

function sameUsageIdentity(
  left: UsagePricingIdentity,
  right: UsagePricingIdentity | undefined
): boolean {
  return Boolean(
    right
    && left.sourceId === right.sourceId
    && left.modelId === right.modelId
  );
}

function projectSourceStats(
  value: Partial<Record<UsageSource, UsageSourceStats>> | undefined,
  rates: UsageCostRates,
  at: Date,
  deltas: Partial<Record<UsageSource, SourcePricingDelta>>
): Partial<Record<UsageSource, UsageSourceStats>> | undefined {
  if (!value) {
    return undefined;
  }
  const result: Partial<Record<UsageSource, UsageSourceStats>> = {};
  for (const [source, stats] of Object.entries(value) as Array<[UsageSource, UsageSourceStats]>) {
    const unpricedRequestCount = stats.unpricedRequestCount ?? 0;
    if ((stats.pricedRequestCount ?? 0) > 0 || unpricedRequestCount <= 0) {
      result[source] = stats;
      continue;
    }
    const cost = calculateUsageCostAt(stats, rates, at);
    const costByCurrency = addCurrencyCost(stats.costByCurrency, rates.currency, cost);
    result[source] = {
      ...stats,
      cost: getSingleCurrencyCost(costByCurrency),
      pricedRequestCount: (stats.pricedRequestCount ?? 0) + unpricedRequestCount,
      unpricedRequestCount: 0,
      costByCurrency
    };
    const delta = deltas[source] ?? { requestCount: 0, costByCurrency: {} };
    delta.requestCount += unpricedRequestCount;
    delta.costByCurrency = addCurrencyCost(delta.costByCurrency, rates.currency, cost);
    deltas[source] = delta;
  }
  return result;
}

function applySourcePricingDeltas(
  value: Partial<Record<UsageSource, UsageSourceStats>> | undefined,
  deltas: Partial<Record<UsageSource, SourcePricingDelta>>
): Partial<Record<UsageSource, UsageSourceStats>> | undefined {
  if (!value) {
    return undefined;
  }
  const result: Partial<Record<UsageSource, UsageSourceStats>> = { ...value };
  for (const [source, delta] of Object.entries(deltas) as Array<[UsageSource, SourcePricingDelta]>) {
    const stats = value[source];
    if (!stats) {
      continue;
    }
    const costByCurrency = mergeCurrencyCosts(stats.costByCurrency, delta.costByCurrency);
    result[source] = {
      ...stats,
      cost: getSingleCurrencyCost(costByCurrency),
      pricedRequestCount: (stats.pricedRequestCount ?? 0) + delta.requestCount,
      unpricedRequestCount: Math.max(0, (stats.unpricedRequestCount ?? 0) - delta.requestCount),
      costByCurrency
    };
  }
  return result;
}

function addCurrencyCost(
  value: Record<string, number> | undefined,
  currency: string,
  cost: number
): Record<string, number> {
  const result = { ...(value ?? {}) };
  result[currency] = normalizeCost((result[currency] ?? 0) + cost);
  return result;
}

function mergeCurrencyCosts(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined
): Record<string, number> {
  const result = { ...(left ?? {}) };
  for (const [currency, cost] of Object.entries(right ?? {})) {
    result[currency] = normalizeCost((result[currency] ?? 0) + cost);
  }
  return result;
}

function getSingleCurrency(value: Record<string, number>): string | undefined {
  const currencies = Object.keys(value);
  return currencies.length === 1 ? currencies[0] : undefined;
}

function getSingleCurrencyCost(value: Record<string, number>): number {
  const currency = getSingleCurrency(value);
  return currency ? value[currency] ?? 0 : 0;
}

function aggregatePricingStatus(
  pricedRequestCount: number,
  unpricedRequestCount: number
): SessionUsageStats['pricingStatus'] {
  return pricedRequestCount > 0
    ? unpricedRequestCount > 0 ? 'partial' : 'priced'
    : 'unavailable';
}

function readUsageDate(value: string | undefined): Date {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function normalizeCost(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}
