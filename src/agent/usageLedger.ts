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
  Usage,
  UsageCostRates,
  UsagePriceSnapshot,
  UsagePricingStatus,
  UsageSource
} from '../shared/types';
import { getPricingPeriod } from './usageStats';

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
}): ProviderUsageLedgerRecord[] {
  if (!input.attempts.length) return [];
  const usageAttemptIndex = input.usage ? input.attempts.length - 1 : -1;
  return input.attempts.map((snapshot, attemptIndex) => {
    const usage = attemptIndex === usageAttemptIndex ? input.usage : undefined;
    const priced = usage
      ? priceUsageFromSnapshot(usage, snapshot)
      : { cost: 0, currency: snapshot.currency, pricingStatus: 'unavailable' as const, unpricedReason: 'no_usage' };
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
      ...(priced.unpricedReason ? { unpricedReason: priced.unpricedReason } : {})
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
    incomplete: normalized?.incomplete ?? false
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

function normalizeUsageLedgerRecord(value: unknown): ProviderUsageLedgerRecord | undefined {
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
    ...priced
  };
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
