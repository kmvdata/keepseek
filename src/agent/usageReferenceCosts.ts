import type {
  ProviderUsageLedger, ProviderUsageLedgerRecord, SessionUsageStats,
  SubagentSessionUsageStats, TurnUsageStats, UsageSourceStats
} from '../shared/types';
import { DEEPSEEK_FLASH_PRICING_KEY } from '../shared/deepSeekModels';
import { DEFAULT_USAGE_PRICING } from '../shared/config';
import { createUsagePriceSnapshot, normalizeUsageLedgerValue, priceUsageFromSnapshot } from './usageLedger';
import { rebuildSessionUsageStatsFromLedger } from './usageStats';

/** Display-only projection. Never persist these records or feed them to task cost budgets. */
export function projectReferenceCostRecord(record: ProviderUsageLedgerRecord): ProviderUsageLedgerRecord {
  if (record.provider === 'deepseek' && record.priceSnapshot.supportsBilling) return record;
  if (!record.usage || record.kind !== 'usage_response') return record;
  const snapshot = createUsagePriceSnapshot({
    originalModelId: record.originalModelId, sourceId: record.sourceId, provider: record.provider,
    protocol: record.protocol, supportsBilling: true, requestStartedAt: record.requestStartedAt,
    rates: DEFAULT_USAGE_PRICING[DEEPSEEK_FLASH_PRICING_KEY]
  });
  return { ...record, ...priceUsageFromSnapshot(record.usage, snapshot), priceSnapshot: snapshot };
}

type CostStats = Pick<UsageSourceStats, 'requestCount' | 'pricedRequestCount' | 'estimatedRequestCount'
  | 'unpricedRequestCount' | 'costByCurrency'>;

/** Keep token/audit counters intact; missing historical requests remain explicitly unpriced. */
function costFields(base: CostStats, projected?: CostStats) {
  const priced = projected?.pricedRequestCount ?? 0;
  const estimated = projected?.estimatedRequestCount ?? 0;
  const unpriced = Math.max(0, base.requestCount - priced - estimated);
  const costs = { ...projected?.costByCurrency };
  const currencies = Object.keys(costs);
  return {
    pricedRequestCount: priced, estimatedRequestCount: estimated, unpricedRequestCount: unpriced,
    costByCurrency: costs,
    currency: currencies.length === 1 ? currencies[0] : '',
    cost: currencies.length === 1 ? costs[currencies[0]] : 0,
    pricingStatus: unpriced > 0 ? (priced + estimated > 0 ? 'partial' as const : 'unavailable' as const)
      : estimated > 0 ? 'estimated_upper_bound' as const : 'priced' as const
  };
}

export function applyReferenceCostView<T extends SessionUsageStats | TurnUsageStats>(base: T | undefined,
  projected: SessionUsageStats | undefined): T | undefined {
  if (!base) return undefined;
  const costs = costFields(base, projected);
  const bySource = { ...base.bySource };
  for (const key of Object.keys(bySource) as Array<keyof typeof bySource>) {
    const source = bySource[key];
    if (source) bySource[key] = { ...source, ...costFields(source, projected?.bySource?.[key]) };
  }
  const result = { ...base, ...costs, bySource };
  if ('sessionCost' in base) {
    return { ...result, sessionCost: costs.cost,
      byModelSource: base.byModelSource?.map((group) => {
        const match = projected?.byModelSource?.find((item) => item.sourceId === group.sourceId
          && item.modelId === group.modelId && item.provider === group.provider && item.protocol === group.protocol);
        const sources = { ...group.bySource };
        for (const key of Object.keys(sources) as Array<keyof typeof sources>) {
          if (sources[key]) sources[key] = { ...sources[key]!, ...costFields(sources[key]!, match?.bySource?.[key]) };
        }
        return { ...group, ...costFields(group, match), bySource: sources };
      }) } as T;
  }
  return result as T;
}

export function buildReferenceCostView(ledger: ProviderUsageLedger, input: {
  lastUserAt?: string;
  subagentUsageStats?: SubagentSessionUsageStats;
}) {
  const original = normalizeUsageLedgerValue(ledger)?.records ?? [];
  const records = original.map(projectReferenceCostRecord);
  const build = (subset: readonly ProviderUsageLedgerRecord[]) => rebuildSessionUsageStatsFromLedger(subset);
  const session = build(records);
  const since = input.lastUserAt ? Date.parse(input.lastUserAt) : NaN;
  // Without a real user-turn boundary, do not invent a split from an aggregate timestamp.
  const turn = Number.isFinite(since) ? build(records.filter((record) => Date.parse(record.requestStartedAt) >= since)) : undefined;
  const children = records.filter((record) => record.source === 'subagent');
  const subagents = input.subagentUsageStats ? {
    ...input.subagentUsageStats,
    byModel: input.subagentUsageStats.byModel.map((group) => ({ ...group,
      usage: applyReferenceCostView(group.usage, build(children.filter((record) => record.sourceId === group.sourceId
        && record.originalModelId === group.modelId && record.provider === group.provider))) })),
    byProfileLane: input.subagentUsageStats.byProfileLane.map((group) => ({ ...group,
      usage: applyReferenceCostView(group.usage, build(children.filter((record) => record.cacheObservation?.subagentProfile === group.profile
        && record.cacheObservation?.subagentLane === group.lane))) })),
    recentRuns: input.subagentUsageStats.recentRuns.map((run) => ({ ...run,
      usage: applyReferenceCostView(run.usage, build(children.filter((record) => record.cacheObservation?.conversationId === run.subagentId))) }))
  } : undefined;
  return { session, turn, subagents, lastUserAt: input.lastUserAt,
    referenceSourceIds: [...new Set(original.filter((record) => record.kind === 'usage_response'
      && !(record.provider === 'deepseek' && record.priceSnapshot.supportsBilling)).map((record) => record.sourceId))] };
}
