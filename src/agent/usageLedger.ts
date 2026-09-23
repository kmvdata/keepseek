import {
  getConfiguredModelUsagePricing,
  USAGE_PRICE_TABLE_VERSION
} from '../shared/config';
import {
  getCanonicalModelIdentity,
  getCanonicalPricingKey
} from '../shared/deepSeekModels';
import type {
  ProviderUsageLedger,
  ProviderUsageLedgerRecord,
  ProviderCacheObservation,
  CacheDiagnosticsMetrics,
  CacheSourceMetrics,
  CacheLaneMetrics,
  Usage,
  UsageCostRates,
  UsagePriceSnapshot,
  UsagePricingStatus,
  UsageSource
} from '../shared/types';
import { getPricingPeriod } from './usagePricingPeriod';
import {
  CACHE_HEALTH_REUSE_TARGET_PERCENT,
  finalizeCacheObservationWithUsage,
  reasonCategory
} from './cacheObservation';

export const USAGE_LEDGER_SCHEMA_VERSION = 1;
export const USAGE_PRICE_SNAPSHOT_VERSION = 1;

export interface UsageLedgerSummary {
  providerAttemptCount: number;
  usageResponseCount: number;
  pricedRequestCount: number;
  estimatedRequestCount: number;
  unpricedRequestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  cacheDataRequestCount: number;
  cacheDataMissingRequestCount: number;
  costByCurrency: Record<string, number>;
  legacyAggregate: boolean;
  incomplete: boolean;
  cacheDiagnostics: CacheDiagnosticsMetrics;
}

export function createUsagePriceSnapshot(input: {
  originalModelId: string;
  sourceId: string;
  provider: string;
  protocol: string;
  supportsBilling: boolean;
  requestStartedAt?: string;
  rates?: UsageCostRates;
  priceTableVersion?: string;
}): UsagePriceSnapshot {
  const requestStartedAt = normalizeTimestamp(input.requestStartedAt);
  const pricingPeriod = getPricingPeriod(new Date(requestStartedAt));
  const configuredRates = input.rates ?? (input.supportsBilling
    ? getConfiguredModelUsagePricing(input.originalModelId)
    : undefined);
  const canonicalPricingKey = getCanonicalPricingKey(input.originalModelId)
    ?? (configuredRates ? input.originalModelId.trim() : undefined);
  const unavailableReason = !input.supportsBilling
    ? 'unsupported_source' as const
    : !configuredRates
      ? 'price_not_configured' as const
      : undefined;
  const snapshot: UsagePriceSnapshot = {
    version: USAGE_PRICE_SNAPSHOT_VERSION,
    originalModelId: input.originalModelId,
    canonicalModelIdentity: getCanonicalModelIdentity(input.originalModelId),
    ...(canonicalPricingKey ? { canonicalPricingKey } : {}),
    sourceId: input.sourceId,
    provider: input.provider,
    protocol: input.protocol,
    requestStartedAt,
    currency: configuredRates?.currency.trim() ?? '',
    ...(configuredRates ? {
      cacheHitRate: selectRate(configuredRates.cacheHitPrice, configuredRates.peakCacheHitPrice, pricingPeriod),
      inputRate: selectRate(configuredRates.inputPrice, configuredRates.peakInputPrice, pricingPeriod),
      outputRate: selectRate(configuredRates.outputPrice, configuredRates.peakOutputPrice, pricingPeriod)
    } : {}),
    pricingPeriod,
    priceTableVersion: input.priceTableVersion ?? USAGE_PRICE_TABLE_VERSION,
    supportsBilling: input.supportsBilling,
    ...(unavailableReason ? { unavailableReason } : {})
  };
  return Object.freeze(snapshot);
}

export function priceUsageFromSnapshot(
  usage: Usage,
  snapshot: UsagePriceSnapshot
): { cost: number; currency: string; pricingStatus: UsagePricingStatus; unpricedReason?: string } {
  if (!snapshot.supportsBilling || snapshot.unavailableReason || !hasRates(snapshot)) {
    return {
      cost: 0,
      currency: snapshot.currency,
      pricingStatus: 'unavailable',
      unpricedReason: snapshot.unavailableReason ?? 'invalid_price'
    };
  }
  const cacheReported = usage.cacheDataStatus === 'reported';
  const cacheHitTokens = cacheReported ? usage.cacheHitTokens : 0;
  const cacheMissTokens = cacheReported ? usage.cacheMissTokens : usage.promptTokens;
  const cost = normalizeCost((
    cacheHitTokens * snapshot.cacheHitRate! +
    cacheMissTokens * snapshot.inputRate! +
    usage.completionTokens * snapshot.outputRate!
  ) / 1_000_000);
  return {
    cost,
    currency: snapshot.currency,
    pricingStatus: cacheReported ? 'priced' : 'estimated_upper_bound'
  };
}

export function createUsageLedgerRecords(input: {
  requestId: string;
  attempts: readonly UsagePriceSnapshot[];
  usage?: Usage;
  source: UsageSource;
  cacheObservations?: readonly ProviderCacheObservation[];
}): ProviderUsageLedgerRecord[] {
  if (!input.attempts.length) return [];
  const usageAttemptIndex = input.usage ? input.attempts.length - 1 : -1;
  return input.attempts.map((snapshot, attemptIndex) => {
    const usage = attemptIndex === usageAttemptIndex ? input.usage : undefined;
    const priced = usage
      ? priceUsageFromSnapshot(usage, snapshot)
      : { cost: 0, currency: snapshot.currency, pricingStatus: 'unavailable' as const, unpricedReason: 'no_usage' };
    const cacheObservation = input.cacheObservations?.[attemptIndex];
    return {
      version: USAGE_LEDGER_SCHEMA_VERSION,
      requestId: input.requestId,
      attemptIndex,
      kind: usage ? 'usage_response' : 'attempt_without_usage',
      source: input.source,
      sourceId: snapshot.sourceId,
      provider: snapshot.provider,
      protocol: snapshot.protocol,
      originalModelId: snapshot.originalModelId,
      canonicalModelIdentity: snapshot.canonicalModelIdentity,
      ...(snapshot.canonicalPricingKey ? { canonicalPricingKey: snapshot.canonicalPricingKey } : {}),
      requestStartedAt: snapshot.requestStartedAt,
      ...(usage ? { usage: { ...usage } } : {}),
      providerCacheDataStatus: usage?.cacheDataStatus ?? 'unavailable',
      priceSnapshot: snapshot,
      cost: priced.cost,
      currency: priced.currency,
      pricingStatus: priced.pricingStatus,
      ...(priced.unpricedReason ? { unpricedReason: priced.unpricedReason } : {}),
      ...(cacheObservation ? {
        cacheObservation: finalizeCacheObservationWithUsage(cacheObservation, usage)
      } : {})
    };
  });
}

export function appendUsageLedgerRecord(
  current: ProviderUsageLedger | undefined,
  record: ProviderUsageLedgerRecord,
  legacyAggregate = false
): ProviderUsageLedger {
  const base = normalizeUsageLedgerValue(current) ?? {
    version: USAGE_LEDGER_SCHEMA_VERSION,
    records: [],
    legacyAggregate,
    incomplete: legacyAggregate
  };
  const duplicate = base.records.some((item) => item.requestId === record.requestId
    && item.attemptIndex === record.attemptIndex);
  return duplicate ? base : {
    ...base,
    records: [...base.records, normalizeUsageLedgerRecord(record)!]
  };
}

export function normalizeUsageLedgerValue(value: unknown): ProviderUsageLedger | undefined {
  if (!isRecord(value)) return undefined;
  const rawRecords = Array.isArray(value.records) ? value.records : [];
  const normalizedRecords = Array.isArray(value.records)
    ? rawRecords.map(normalizeUsageLedgerRecord).filter((item): item is ProviderUsageLedgerRecord => Boolean(item))
    : [];
  const seen = new Set<string>();
  const records = normalizedRecords.filter((record) => {
    const key = `${record.requestId}\u0000${record.attemptIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (value.version !== USAGE_LEDGER_SCHEMA_VERSION && !records.length) return undefined;
  const damagedRecords = !Array.isArray(value.records) || records.length !== rawRecords.length;
  return {
    version: USAGE_LEDGER_SCHEMA_VERSION,
    records,
    legacyAggregate: value.legacyAggregate === true || value.version !== USAGE_LEDGER_SCHEMA_VERSION,
    incomplete: value.incomplete === true || value.version !== USAGE_LEDGER_SCHEMA_VERSION || damagedRecords
  };
}

export function summarizeUsageLedger(ledger: ProviderUsageLedger | undefined): UsageLedgerSummary {
  const normalized = normalizeUsageLedgerValue(ledger);
  const summary: UsageLedgerSummary = {
    providerAttemptCount: 0,
    usageResponseCount: 0,
    pricedRequestCount: 0,
    estimatedRequestCount: 0,
    unpricedRequestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {},
    legacyAggregate: normalized?.legacyAggregate ?? false,
    incomplete: normalized?.incomplete ?? false,
    cacheDiagnostics: summarizeCacheDiagnostics(normalized?.records ?? [], normalized?.incomplete ?? false)
  };
  for (const record of normalized?.records ?? []) {
    summary.providerAttemptCount += 1;
    if (record.kind !== 'usage_response' || !record.usage) continue;
    summary.usageResponseCount += 1;
    summary.promptTokens += record.usage.promptTokens;
    summary.completionTokens += record.usage.completionTokens;
    summary.totalTokens += record.usage.totalTokens;
    summary.cacheHitTokens += record.usage.cacheHitTokens;
    summary.cacheMissTokens += record.usage.cacheMissTokens;
    if (record.providerCacheDataStatus === 'reported') summary.cacheDataRequestCount += 1;
    else summary.cacheDataMissingRequestCount += 1;
    if (record.pricingStatus === 'priced') summary.pricedRequestCount += 1;
    else if (record.pricingStatus === 'estimated_upper_bound') summary.estimatedRequestCount += 1;
    else summary.unpricedRequestCount += 1;
    if (record.pricingStatus !== 'unavailable' && record.currency) {
      summary.costByCurrency[record.currency] = normalizeCost(
        (summary.costByCurrency[record.currency] ?? 0) + record.cost
      );
    }
  }
  return summary;
}

export function recalculateUsageLedgerRecordCost(
  record: ProviderUsageLedgerRecord
): ProviderUsageLedgerRecord {
  if (record.kind !== 'usage_response' || !record.usage) return { ...record };
  const priced = priceUsageFromSnapshot(record.usage, record.priceSnapshot);
  return { ...record, ...priced };
}

export function repriceUsageLedger(
  ledger: ProviderUsageLedger,
  input: {
    priceTableVersion: string;
    pricingByKey: Readonly<Record<string, UsageCostRates>>;
  }
): ProviderUsageLedger {
  if (!input.priceTableVersion.trim()) throw new Error('A target price-table version is required.');
  const normalized = normalizeUsageLedgerValue(ledger) ?? {
    version: USAGE_LEDGER_SCHEMA_VERSION,
    records: [],
    legacyAggregate: true,
    incomplete: true
  };
  return {
    ...normalized,
    records: normalized.records.map((record) => {
      if (record.kind !== 'usage_response' || !record.usage || !record.canonicalPricingKey) return { ...record };
      const rates = input.pricingByKey[record.canonicalPricingKey];
      if (!rates) {
        return {
          ...record,
          cost: 0,
          currency: '',
          pricingStatus: 'unavailable',
          unpricedReason: 'price_not_configured'
        };
      }
      const snapshot = createUsagePriceSnapshot({
        originalModelId: record.originalModelId,
        sourceId: record.sourceId,
        provider: record.provider,
        protocol: record.protocol,
        supportsBilling: record.priceSnapshot.supportsBilling,
        requestStartedAt: record.requestStartedAt,
        rates,
        priceTableVersion: input.priceTableVersion
      });
      return recalculateUsageLedgerRecordCost({ ...record, priceSnapshot: snapshot });
    })
  };
}

export function normalizeUsageLedgerRecord(value: unknown): ProviderUsageLedgerRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.requestId !== 'string'
    || !Number.isSafeInteger(value.attemptIndex) || Number(value.attemptIndex) < 0
    || (value.kind !== 'usage_response' && value.kind !== 'attempt_without_usage')
    || !isRecord(value.priceSnapshot)) return undefined;
  const snapshot = normalizeUsagePriceSnapshot(value.priceSnapshot);
  const requestStartedAt = normalizePersistedTimestamp(value.requestStartedAt);
  if (!snapshot || !requestStartedAt || requestStartedAt !== snapshot.requestStartedAt) return undefined;
  const usage = value.kind === 'usage_response' ? normalizeUsage(value.usage) : undefined;
  if (value.kind === 'usage_response' && !usage) return undefined;
  const priced = usage
    ? priceUsageFromSnapshot(usage, snapshot)
    : { cost: 0, currency: snapshot.currency, pricingStatus: 'unavailable' as const, unpricedReason: 'no_usage' };
  return {
    version: 1,
    requestId: value.requestId,
    attemptIndex: Number(value.attemptIndex),
    kind: value.kind,
    source: normalizeSource(value.source),
    sourceId: snapshot.sourceId,
    provider: snapshot.provider,
    protocol: snapshot.protocol,
    originalModelId: snapshot.originalModelId,
    canonicalModelIdentity: snapshot.canonicalModelIdentity,
    ...(snapshot.canonicalPricingKey ? { canonicalPricingKey: snapshot.canonicalPricingKey } : {}),
    requestStartedAt,
    ...(usage ? { usage } : {}),
    providerCacheDataStatus: usage?.cacheDataStatus ?? 'unavailable',
    priceSnapshot: snapshot,
    ...priced,
    ...(normalizeCacheObservation(value.cacheObservation, value.requestId, Number(value.attemptIndex))
      ? { cacheObservation: normalizeCacheObservation(value.cacheObservation, value.requestId, Number(value.attemptIndex)) }
      : {})
  };
}

export function summarizeCacheDiagnostics(
  records: readonly ProviderUsageLedgerRecord[],
  incomplete = false
): CacheDiagnosticsMetrics {
  const usageRecords = records.filter((record) => record.kind === 'usage_response' && record.usage);
  const all = summarizeCacheSlice(usageRecords);
  const main = summarizeCacheSlice(usageRecords.filter((record) => record.source === 'executor'));
  const bySource = Array.from(new Set(usageRecords.map((record) => record.source)))
    .map((source): CacheSourceMetrics => ({ source, ...summarizeCacheSlice(
      usageRecords.filter((record) => record.source === source)
    ) }));
  const laneRecords = new Map<string, ProviderUsageLedgerRecord[]>();
  for (const record of usageRecords) {
    const laneKey = record.cacheObservation?.cacheFamilyKey ?? record.cacheObservation?.laneKey;
    if (!laneKey) continue;
    const groupKey = `${record.source}\u0000${laneKey}`;
    laneRecords.set(groupKey, [...(laneRecords.get(groupKey) ?? []), record]);
  }
  const byLane = Array.from(laneRecords.values()).map((items): CacheLaneMetrics => {
    const first = items[0]!;
    return {
      source: first.source,
      sourceId: first.sourceId,
      provider: first.provider,
      protocol: first.protocol,
      originalModelId: first.originalModelId,
      ...(first.cacheObservation?.cacheFamilyId ? { cacheFamilyId: first.cacheObservation.cacheFamilyId } : {}),
      ...(first.cacheObservation?.subagentProfile ? { profile: first.cacheObservation.subagentProfile } : {}),
      ...(first.cacheObservation?.subagentLane ? { subagentLane: first.cacheObservation.subagentLane } : {}),
      coldRequestCount: items.filter((item) => item.cacheObservation?.prefixRelation === 'cold').length,
      continuedRequestCount: items.filter((item) => item.cacheObservation?.comparisonScope === 'conversation').length,
      siblingRequestCount: items.filter((item) => item.cacheObservation?.prefixRelation === 'family_common_prefix').length,
      ...summarizeCacheSlice(items)
    };
  });
  const observations = records.map((record) => record.cacheObservation).filter(
    (value): value is ProviderCacheObservation => Boolean(value)
  );
  const eligible = usageRecords.filter((record) => record.cacheObservation?.eligibleForHealthTarget
    && record.providerCacheDataStatus === 'reported');
  const healthy = eligible.filter((record) => (record.cacheObservation?.reuseEfficiencyRaw ?? 0)
    >= CACHE_HEALTH_REUSE_TARGET_PERCENT);
  const anomalous = eligible.filter((record) => (record.cacheObservation?.reuseEfficiencyRaw ?? 100)
    < CACHE_HEALTH_REUSE_TARGET_PERCENT);
  const localBoundaryRecords = usageRecords.filter((record) => record.cacheObservation?.reasonCategory === 'local_anomaly');
  const estimatedLocalBoundaryExtraCostByCurrency: Record<string, number> = {};
  let estimatedLocalBoundaryLossTokens = 0;
  for (const record of localBoundaryRecords) {
    const observation = record.cacheObservation!;
    const previousTokens = Math.max(observation.commonPrefixTokensEstimate,
      observation.previousPromptTokensEstimate ?? 0);
    const lost = Math.max(0, previousTokens - observation.commonPrefixTokensEstimate);
    estimatedLocalBoundaryLossTokens += lost;
    const snapshot = record.priceSnapshot;
    if (record.currency && typeof snapshot.inputRate === 'number' && typeof snapshot.cacheHitRate === 'number') {
      estimatedLocalBoundaryExtraCostByCurrency[record.currency] = normalizeCost(
        (estimatedLocalBoundaryExtraCostByCurrency[record.currency] ?? 0)
          + lost * Math.max(0, snapshot.inputRate - snapshot.cacheHitRate) / 1_000_000
      );
    }
  }
  const lastAnomaly = [...observations].reverse().find((observation) => observation.reasonCategory === 'local_anomaly'
    || observation.reason === 'provider_cache_eviction_possible');
  return {
    rawHitRate: all.rawHitRate,
    mainAgentRawHitRate: main.rawHitRate,
    expectedRawHitRateCeiling: all.expectedRawHitRateCeiling,
    mainAgentExpectedRawHitRateCeiling: main.expectedRawHitRateCeiling,
    reuseEfficiency: all.reuseEfficiency,
    reuseEfficiencyRaw: all.reuseEfficiencyRaw,
    mainAgentReuseEfficiency: main.reuseEfficiency,
    mainAgentReuseEfficiencyRaw: main.reuseEfficiencyRaw,
    cacheDataResponseCount: all.cacheDataResponseCount,
    cacheDataMissingResponseCount: all.cacheDataMissingResponseCount,
    coldStartRequestCount: observations.filter((observation) => observation.prefixRelation === 'cold'
      && !Object.values(observation.boundary).some(Boolean)).length,
    controlledBoundaryRequestCount: observations.filter((observation) => Object.values(observation.boundary).some(Boolean)
      || observation.reasonCategory === 'controlled_boundary').length,
    comparableRequestCount: eligible.length,
    healthyReusableRequestCount: healthy.length,
    anomalousReusableRequestCount: anomalous.length,
    providerCacheEvictionPossibleCount: observations.filter((observation) => observation.reason === 'provider_cache_eviction_possible').length,
    estimatedReusableTokensNotHit: anomalous.reduce((sum, record) => sum + Math.max(0,
      (record.cacheObservation?.reusablePrefixTokensEstimate ?? 0) - (record.usage?.cacheHitTokens ?? 0)), 0),
    estimatedLocalBoundaryLossTokens,
    estimatedLocalBoundaryExtraCostByCurrency,
    reusablePrefixTokens: all.reusablePrefixTokens,
    unavoidableNewTokens: all.unavoidableNewTokens,
    localEstimateLowCount: all.localEstimateLowCount,
    ...(lastAnomaly ? { lastAnomalyReason: lastAnomaly.reason } : {}),
    bySource,
    byLane,
    incomplete: incomplete || usageRecords.some((record) => !record.cacheObservation)
  };
}

function summarizeCacheSlice(records: readonly ProviderUsageLedgerRecord[]): Omit<CacheSourceMetrics, 'source'> {
  let reportedHit = 0;
  let reportedPrompt = 0;
  let eligibleHit = 0;
  let eligibleReusable = 0;
  let allReusable = 0;
  let allPrompt = 0;
  let unavoidable = 0;
  let reported = 0;
  let missing = 0;
  let comparable = 0;
  let healthy = 0;
  let anomalous = 0;
  let requestCount = 0;
  let localEstimateLowCount = 0;
  for (const record of records) {
    const usage = record.usage;
    if (!usage) continue;
    requestCount += 1;
    if (record.providerCacheDataStatus === 'reported') {
      reportedHit += usage.cacheHitTokens;
      reportedPrompt += usage.promptTokens;
      reported += 1;
    } else {
      missing += 1;
    }
    const observation = record.cacheObservation;
    if (observation) {
      allPrompt += usage.promptTokens;
      allReusable += Math.min(usage.promptTokens, observation.reusablePrefixTokensEstimate);
      unavoidable += Math.max(0, usage.promptTokens - observation.reusablePrefixTokensEstimate);
      if (record.providerCacheDataStatus === 'reported'
        && usage.cacheHitTokens > observation.reusablePrefixTokensEstimate) localEstimateLowCount += 1;
    }
    if (!observation?.eligibleForHealthTarget || record.providerCacheDataStatus !== 'reported') continue;
    comparable += 1;
    eligibleReusable += Math.min(usage.promptTokens, observation.reusablePrefixTokensEstimate);
    eligibleHit += usage.cacheHitTokens;
    if ((observation.reuseEfficiencyRaw ?? 0) >= CACHE_HEALTH_REUSE_TARGET_PERCENT) healthy += 1;
    else anomalous += 1;
  }
  const rawHitRate = reportedPrompt > 0 ? reportedHit / reportedPrompt * 100 : undefined;
  const expectedRawHitRateCeiling = allPrompt > 0 ? allReusable / allPrompt * 100 : undefined;
  const reuseEfficiencyRaw = eligibleReusable > 0 ? eligibleHit / eligibleReusable * 100 : undefined;
  return {
    ...(rawHitRate === undefined ? {} : { rawHitRate }),
    ...(expectedRawHitRateCeiling === undefined ? {} : { expectedRawHitRateCeiling }),
    ...(reuseEfficiencyRaw === undefined ? {} : {
      reuseEfficiencyRaw,
      reuseEfficiency: Math.max(0, Math.min(100, reuseEfficiencyRaw))
    }),
    cacheDataResponseCount: reported,
    cacheDataMissingResponseCount: missing,
    comparableRequestCount: comparable,
    healthyReusableRequestCount: healthy,
    anomalousReusableRequestCount: anomalous,
    requestCount,
    promptTokens: allPrompt,
    reusablePrefixTokens: allReusable,
    unavoidableNewTokens: unavoidable,
    localEstimateLowCount
  };
}

function normalizeCacheObservation(
  value: unknown,
  requestId: string,
  attemptIndex: number
): ProviderCacheObservation | undefined {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2) || value.requestId !== requestId
    || value.attemptIndex !== attemptIndex || typeof value.laneKey !== 'string'
    || typeof value.endpointLaneIdentity !== 'string' || typeof value.originalModelId !== 'string'
    || typeof value.canonicalModelIdentity !== 'string' || typeof value.sourceId !== 'string'
    || typeof value.provider !== 'string' || typeof value.protocol !== 'string'
    || !isRecord(value.system) || !isRecord(value.contextInstructions) || !isRecord(value.tools)
    || !isRecord(value.providerHistory) || !isRecord(value.newTail) || !isRecord(value.cacheableProjection)
    || !isRecord(value.boundary)) return undefined;
  const fingerprints = [value.system, value.contextInstructions, value.tools, value.providerHistory,
    value.newTail, value.cacheableProjection].map(normalizeFingerprint);
  if (fingerprints.some((item) => !item)) return undefined;
  const reason = normalizeCacheReason(value.reason);
  if (!reason) return undefined;
  return {
    version: value.version,
    requestId,
    attemptIndex,
    source: normalizeSource(value.source),
    sourceId: value.sourceId,
    provider: value.provider,
    protocol: value.protocol,
    endpointLaneIdentity: value.endpointLaneIdentity,
    laneKey: value.laneKey,
    ...(optionalString(value.cacheFamilyKey) ? { cacheFamilyKey: optionalString(value.cacheFamilyKey) } : {}),
    ...(optionalString(value.cacheFamilyId) ? { cacheFamilyId: optionalString(value.cacheFamilyId) } : {}),
    ...(optionalString(value.subagentProfile) ? { subagentProfile: optionalString(value.subagentProfile) } : {}),
    ...(optionalString(value.subagentLane) ? { subagentLane: optionalString(value.subagentLane) } : {}),
    ...(finiteNumber(value.subagentDepth) === undefined ? {} : { subagentDepth: nonNegativeInteger(value.subagentDepth) }),
    originalModelId: value.originalModelId,
    canonicalModelIdentity: value.canonicalModelIdentity,
    ...(optionalString(value.taskId) ? { taskId: optionalString(value.taskId) } : {}),
    ...(optionalString(value.conversationId) ? { conversationId: optionalString(value.conversationId) } : {}),
    ...(optionalString(value.runId) ? { runId: optionalString(value.runId) } : {}),
    contextEpochIndex: nonNegativeInteger(value.contextEpochIndex),
    requestProtocolVersion: Math.max(1, nonNegativeInteger(value.requestProtocolVersion)),
    system: fingerprints[0]!, contextInstructions: fingerprints[1]!, tools: fingerprints[2]!,
    providerHistory: fingerprints[3]!, newTail: fingerprints[4]!, cacheableProjection: fingerprints[5]!,
    ...(normalizeFingerprint(value.stablePrefix) ? { stablePrefix: normalizeFingerprint(value.stablePrefix) } : {}),
    estimatedPromptTokens: nonNegativeInteger(value.estimatedPromptTokens),
    ...(finiteNumber(value.previousPromptTokensEstimate) === undefined
      ? {} : { previousPromptTokensEstimate: nonNegativeInteger(value.previousPromptTokensEstimate) }),
    ...(optionalString(value.previousRequestIdentity) ? { previousRequestIdentity: optionalString(value.previousRequestIdentity) } : {}),
    ...(optionalString(value.previousSameLaneRequestIdentity)
      ? { previousSameLaneRequestIdentity: optionalString(value.previousSameLaneRequestIdentity) } : {}),
    prefixRelation: value.prefixRelation === 'strict_prefix' || value.prefixRelation === 'identical_retry'
      || value.prefixRelation === 'family_common_prefix'
      || value.prefixRelation === 'broken' ? value.prefixRelation : 'cold',
    ...(value.comparisonScope === 'conversation' || value.comparisonScope === 'family'
      ? { comparisonScope: value.comparisonScope } : {}),
    inheritsPreviousCacheablePrefix: value.inheritsPreviousCacheablePrefix === true,
    ...(value.firstChangedSegment === 'lane' || value.firstChangedSegment === 'system'
      || value.firstChangedSegment === 'context_instructions' || value.firstChangedSegment === 'tools'
      || value.firstChangedSegment === 'provider_history' ? { firstChangedSegment: value.firstChangedSegment } : {}),
    commonPrefixTokensEstimate: nonNegativeInteger(value.commonPrefixTokensEstimate),
    reusablePrefixTokensEstimate: nonNegativeInteger(value.reusablePrefixTokensEstimate),
    unavoidableNewTokensEstimate: nonNegativeInteger(value.unavoidableNewTokensEstimate),
    ...(finiteNumber(value.expectedRawHitRateCeiling) === undefined ? {} : { expectedRawHitRateCeiling: finiteNumber(value.expectedRawHitRateCeiling) }),
    ...(finiteNumber(value.reuseEfficiencyRaw) === undefined ? {} : { reuseEfficiencyRaw: finiteNumber(value.reuseEfficiencyRaw) }),
    eligibleForHealthTarget: value.eligibleForHealthTarget === true,
    reason,
    reasonCategory: reasonCategory(reason),
    boundary: {
      historyCompacted: value.boundary.historyCompacted === true,
      historyRewritten: value.boundary.historyRewritten === true,
      contextEpochRollover: value.boundary.contextEpochRollover === true,
      protocolMigration: value.boundary.protocolMigration === true
    }
  };
}

function normalizeFingerprint(value: unknown): import('../shared/types').CacheProjectionFingerprint | undefined {
  if (!isRecord(value) || typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.hash)) return undefined;
  return { hash: value.hash, byteLength: nonNegativeInteger(value.byteLength), tokensEstimate: nonNegativeInteger(value.tokensEstimate) };
}

function normalizeCacheReason(value: unknown): import('../shared/types').CacheObservationReason | undefined {
  const reasons: import('../shared/types').CacheObservationReason[] = [
    'cold_start', 'append_only_prefix_preserved', 'family_common_prefix_preserved', 'retry_projection_unchanged', 'model_lane_changed',
    'source_lane_changed', 'protocol_lane_changed', 'endpoint_lane_changed', 'system_prompt_changed',
    'context_instructions_changed', 'tools_schema_changed', 'history_rewritten', 'history_compacted',
    'context_epoch_rollover', 'protocol_migration', 'provider_context_too_long', 'stale_capacity_calibration',
    'provider_cache_eviction_possible', 'provider_cache_metrics_unavailable', 'unexpected_local_prefix_break'
  ];
  return typeof value === 'string' && reasons.includes(value as import('../shared/types').CacheObservationReason)
    ? value as import('../shared/types').CacheObservationReason : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeUsagePriceSnapshot(value: unknown): UsagePriceSnapshot | undefined {
  if (!isRecord(value) || value.version !== USAGE_PRICE_SNAPSHOT_VERSION
    || typeof value.originalModelId !== 'string'
    || typeof value.canonicalModelIdentity !== 'string'
    || typeof value.sourceId !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.protocol !== 'string'
    || typeof value.currency !== 'string'
    || typeof value.priceTableVersion !== 'string'
    || typeof value.supportsBilling !== 'boolean'
    || (value.pricingPeriod !== 'offPeak' && value.pricingPeriod !== 'peak')) return undefined;
  const requestStartedAt = normalizePersistedTimestamp(value.requestStartedAt);
  if (!requestStartedAt) return undefined;
  const optionalRate = (rate: unknown): number | undefined => rate === undefined
    ? undefined
    : typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : Number.NaN;
  const cacheHitRate = optionalRate(value.cacheHitRate);
  const inputRate = optionalRate(value.inputRate);
  const outputRate = optionalRate(value.outputRate);
  if ([cacheHitRate, inputRate, outputRate].some((rate) => Number.isNaN(rate))) return undefined;
  const unavailableReason = value.unavailableReason === 'unsupported_source'
    || value.unavailableReason === 'price_not_configured'
    || value.unavailableReason === 'invalid_price' ? value.unavailableReason : undefined;
  return Object.freeze({
    version: USAGE_PRICE_SNAPSHOT_VERSION,
    originalModelId: value.originalModelId,
    canonicalModelIdentity: value.canonicalModelIdentity,
    ...(optionalString(value.canonicalPricingKey)
      ? { canonicalPricingKey: optionalString(value.canonicalPricingKey) } : {}),
    sourceId: value.sourceId,
    provider: value.provider,
    protocol: value.protocol,
    requestStartedAt,
    currency: value.currency,
    ...(cacheHitRate === undefined ? {} : { cacheHitRate }),
    ...(inputRate === undefined ? {} : { inputRate }),
    ...(outputRate === undefined ? {} : { outputRate }),
    pricingPeriod: value.pricingPeriod,
    priceTableVersion: value.priceTableVersion,
    supportsBilling: value.supportsBilling,
    ...(unavailableReason ? { unavailableReason } : {})
  });
}

function normalizeUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  return {
    promptTokens: nonNegativeInteger(value.promptTokens),
    completionTokens: nonNegativeInteger(value.completionTokens),
    totalTokens: nonNegativeInteger(value.totalTokens),
    cacheHitTokens: nonNegativeInteger(value.cacheHitTokens),
    cacheMissTokens: nonNegativeInteger(value.cacheMissTokens),
    cacheDataStatus: value.cacheDataStatus === 'reported' || value.cacheDataStatus === 'partial'
      ? value.cacheDataStatus : 'unavailable',
    ...(Number.isFinite(Number(value.reasoningTokens))
      ? { reasoningTokens: nonNegativeInteger(value.reasoningTokens) } : {})
  };
}

function selectRate(offPeak: number, peak: number | undefined, period: 'offPeak' | 'peak'): number {
  return normalizeRate(period === 'peak' && peak !== undefined ? peak : offPeak);
}

function hasRates(snapshot: UsagePriceSnapshot): boolean {
  return [snapshot.cacheHitRate, snapshot.inputRate, snapshot.outputRate]
    .every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    && Boolean(snapshot.currency);
}

function normalizeTimestamp(value: unknown): string {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

function normalizePersistedTimestamp(value: unknown): string | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeSource(value: unknown): UsageSource {
  return value === 'summary' || value === 'retry' || value === 'continuation'
    || value === 'background' || value === 'reviewer' || value === 'subagent'
    || value === 'retrieval' || value === 'router' ? value : 'executor';
}

function normalizeRate(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function normalizeCost(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
