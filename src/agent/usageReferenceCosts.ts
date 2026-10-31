import type {
  ProviderUsageLedger, ProviderUsageLedgerRecord, SessionUsageStats,
  SubagentSessionUsageStats, TurnUsageStats, UsageSourceStats
} from '../shared/types';
import { DEEPSEEK_FLASH_PRICING_KEY } from '../shared/deepSeekModels';
import { DEFAULT_USAGE_PRICING } from '../shared/config';
import { createUsagePriceSnapshot, normalizeUsageLedgerValue, priceUsageFromSnapshot, usageLedgerRecordIdentity, preferUsageLedgerRecord } from './usageLedger';
import { updateUsageLedgerStatsIndex, type UsageLedgerStatsIndex } from './usageStats';

const emptyIndex = (): UsageLedgerStatsIndex => ({ records: new Map() });
const groupKey = (...parts: unknown[]) => JSON.stringify(parts);
/** Display costs are incremental too; they never feed the durable billing or budgets. */
export class ReferenceCostIndex {
  public readonly total = emptyIndex();
  public turn = emptyIndex();
  public readonly groups = new Map<string, UsageLedgerStatsIndex>();
  private readonly original = new Map<string, ProviderUsageLedgerRecord>();
  private since?: string;
  public reconcile(records: ProviderUsageLedgerRecord[], lastUserAt?: string): ProviderUsageLedgerRecord[] {
    const identities = new Set(records.map(usageLedgerRecordIdentity));
    if ([...this.original.keys()].some(key => !identities.has(key))) {
      // Explicit disk rebuild/damage may remove records. Never keep ghost fees
      // in the derived display index when the durable authority is incomplete.
      this.original.clear(); this.total.records.clear(); this.total.stats = undefined;
      this.groups.clear(); this.turn = emptyIndex(); this.since = undefined;
    }
    const resetTurn = this.since !== lastUserAt;
    if (resetTurn) { this.turn = emptyIndex(); this.since = lastUserAt; }
    const since = Date.parse(lastUserAt ?? '');
    for (const record of records) {
      const key = usageLedgerRecordIdentity(record), previous = this.original.get(key);
      if (preferUsageLedgerRecord(previous, record) !== previous) {
        this.original.set(key, record);
        const projected = projectReferenceCostRecord(record);
        updateUsageLedgerStatsIndex(this.total, projected);
        if (record.source === 'subagent') {
          for (const name of [groupKey('model', record.sourceId, record.originalModelId, record.provider),
            groupKey('profile', record.cacheObservation?.subagentProfile, record.cacheObservation?.subagentLane),
            groupKey('child', record.subagentId ?? record.cacheObservation?.conversationId)]) {
            let group = this.groups.get(name); if (!group) { group = emptyIndex(); this.groups.set(name, group); }
            updateUsageLedgerStatsIndex(group, projected);
          }
        }
        if (!resetTurn && Number.isFinite(since) && Date.parse(record.requestStartedAt) >= since) updateUsageLedgerStatsIndex(this.turn, projected);
      }
    }
    const projected = [...this.total.records.values()];
    if (resetTurn && Number.isFinite(since)) for (const record of projected) {
      if (Date.parse(record.requestStartedAt) >= since) updateUsageLedgerStatsIndex(this.turn, record);
    }
    return projected;
  }
  public group(...parts: unknown[]) { return this.groups.get(groupKey(...parts))?.stats; }
}

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
}, index = new ReferenceCostIndex()) {
  const original = normalizeUsageLedgerValue(ledger)?.records ?? [];
  const records = index.reconcile(original, input.lastUserAt);
  const session = index.total.stats;
  const since = input.lastUserAt ? Date.parse(input.lastUserAt) : NaN;
  // Without a real user-turn boundary, do not invent a split from an aggregate timestamp.
  const turn = Number.isFinite(since) ? index.turn.stats : undefined;
  const subagents = input.subagentUsageStats ? {
    ...input.subagentUsageStats,
    byModel: input.subagentUsageStats.byModel.map((group) => ({ ...group,
      usage: applyReferenceCostView(group.usage, index.group('model', group.sourceId, group.modelId, group.provider)) })),
    byProfileLane: input.subagentUsageStats.byProfileLane.map((group) => ({ ...group,
      usage: applyReferenceCostView(group.usage, index.group('profile', group.profile, group.lane)) })),
    recentRuns: input.subagentUsageStats.recentRuns.map((run) => ({ ...run,
      usage: applyReferenceCostView(run.usage, index.group('child', run.subagentId)) }))
  } : undefined;
  return { session, turn, subagents, records, lastUserAt: input.lastUserAt,
    referenceSourceIds: [...new Set(original.filter((record) => record.kind === 'usage_response'
      && !(record.provider === 'deepseek' && record.priceSnapshot.supportsBilling)).map((record) => record.sourceId))] };
}
