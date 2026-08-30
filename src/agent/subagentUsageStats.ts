import type {
  ContextUsageEstimate,
  SessionUsageStats,
  SubagentHandoffEstimate,
  SubagentHandoffKind,
  SubagentRunUsageSummary,
  SubagentSessionUsageStats,
  SubagentTerminalStatus,
  SubagentUsageGroup,
  TurnUsageStats,
  Usage,
  UsageSource,
  UsageSourceStats
} from '../shared/types';
import { normalizeTurnUsageStatsValue } from './usageStats';

export const SUBAGENT_USAGE_ESTIMATOR_VERSION = 'local-context-v1';
export const MAX_RECENT_SUBAGENT_RUNS = 50;

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
const HANDOFF_KINDS: SubagentHandoffKind[] = ['delegate', 'parallel', 'read-result'];

export interface ActualUsageSlice extends Usage {
  requestCount: number;
  pricedRequestCount: number;
  unpricedRequestCount: number;
  cacheDataRequestCount: number;
  cacheDataMissingRequestCount: number;
  pricingStatus: 'priced' | 'partial' | 'unavailable';
  costByCurrency: Record<string, number>;
}

export interface ActualUsageBreakdown {
  total: ActualUsageSlice;
  mainSession: ActualUsageSlice;
  subagent: ActualUsageSlice;
  unattributed: ActualUsageSlice;
  mainPercent?: number;
  subagentPercent?: number;
  unattributedPercent?: number;
}

export interface UsageDetailsViewModel {
  session: ActualUsageBreakdown;
  lastTurn?: ActualUsageBreakdown;
  subagents?: {
    totalCount: number;
    completedCount: number;
    failedCount: number;
    stoppedCount: number;
    isolatedIntermediateTokensEstimate: number;
    rootHandoffTokensEstimate: number;
    contextIsolationRate?: number;
    rootHandoffCount: number;
    handoffCountByKind: Record<SubagentHandoffKind, number>;
    byModel: SubagentUsageGroup[];
    byProfileLane: SubagentUsageGroup[];
    recentRuns: SubagentRunUsageSummary[];
    estimatorVersion: string;
  };
}

export function createEmptySubagentSessionUsageStats(
  now = new Date().toISOString()
): SubagentSessionUsageStats {
  return {
    schemaVersion: 1,
    totalCount: 0,
    completedCount: 0,
    failedCount: 0,
    stoppedCount: 0,
    byModel: [],
    byProfileLane: [],
    recentRuns: [],
    countedSubagentIds: [],
    isolatedIntermediateTokensEstimate: 0,
    rootHandoffTokensEstimate: 0,
    rootHandoffCount: 0,
    handoffCountByKind: createEmptyHandoffCounts(),
    countedHandoffIds: [],
    updatedAt: now
  };
}

export function calculateIsolatedIntermediateTokensEstimate(input: {
  toolCallTokensEstimate?: unknown;
  toolResultTokensEstimate?: unknown;
  reasoningTokensEstimate?: unknown;
}): number {
  return safeInteger(input.toolCallTokensEstimate)
    + safeInteger(input.toolResultTokensEstimate)
    + safeInteger(input.reasoningTokensEstimate);
}

export function createSubagentRunUsageSummary(input: {
  subagentId: string;
  parentRunId: string;
  rootRunId: string;
  depth: number;
  profile: string;
  lane: string;
  status: SubagentTerminalStatus;
  sourceId: string;
  modelId: string;
  provider: string;
  startedAt: string;
  completedAt: string;
  usage?: TurnUsageStats;
  lastUsageEstimate?: ContextUsageEstimate;
}): SubagentRunUsageSummary {
  const toolCallTokensEstimate = safeInteger(input.lastUsageEstimate?.breakdown.toolCallTokensEstimate);
  const toolResultTokensEstimate = safeInteger(input.lastUsageEstimate?.breakdown.toolResultTokensEstimate);
  const reasoningTokensEstimate = safeInteger(input.lastUsageEstimate?.breakdown.reasoningTokensEstimate);
  const startedMs = parseTimestamp(input.startedAt);
  const completedMs = parseTimestamp(input.completedAt);
  return {
    subagentId: input.subagentId.trim(),
    parentRunId: input.parentRunId.trim(),
    rootRunId: input.rootRunId.trim(),
    depth: safeInteger(input.depth),
    profile: input.profile.trim(),
    lane: input.lane.trim(),
    status: input.status,
    sourceId: input.sourceId.trim(),
    modelId: input.modelId.trim(),
    provider: input.provider.trim(),
    startedAt: normalizeTimestamp(input.startedAt),
    completedAt: normalizeTimestamp(input.completedAt),
    durationMs: Math.max(0, completedMs - startedMs),
    usage: input.usage ? normalizeTurnUsageStatsValue(input.usage) : undefined,
    toolCallTokensEstimate,
    toolResultTokensEstimate,
    reasoningTokensEstimate,
    isolatedIntermediateTokensEstimate: calculateIsolatedIntermediateTokensEstimate({
      toolCallTokensEstimate,
      toolResultTokensEstimate,
      reasoningTokensEstimate
    }),
    estimatorVersion: SUBAGENT_USAGE_ESTIMATOR_VERSION
  };
}

export function upsertSubagentRunUsageSummary(
  current: SubagentSessionUsageStats | undefined,
  summary: SubagentRunUsageSummary
): SubagentSessionUsageStats {
  const normalizedSummary = normalizeSubagentRunUsageSummary(summary);
  const base = normalizeSubagentSessionUsageStatsValue(current)
    ?? createEmptySubagentSessionUsageStats(normalizedSummary.completedAt);
  const previousIndex = base.recentRuns.findIndex((item) => item.subagentId === normalizedSummary.subagentId);
  const alreadyCounted = base.countedSubagentIds.includes(normalizedSummary.subagentId);
  if (alreadyCounted && previousIndex < 0) {
    // The detail was intentionally trimmed. Terminal callbacks are immutable, so
    // ignoring a late duplicate preserves exact cumulative totals without growing
    // the detailed run list indefinitely.
    return base;
  }

  let next = cloneSubagentSessionUsageStats(base);
  if (previousIndex >= 0) {
    next = applyRunContribution(next, base.recentRuns[previousIndex], -1);
    next.recentRuns.splice(previousIndex, 1);
  } else {
    next.countedSubagentIds.push(normalizedSummary.subagentId);
  }
  next = applyRunContribution(next, normalizedSummary, 1);
  next.recentRuns.push(normalizedSummary);
  next.recentRuns.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  next.recentRuns = next.recentRuns.slice(0, MAX_RECENT_SUBAGENT_RUNS);
  next.updatedAt = normalizedSummary.completedAt;
  return normalizeSubagentSessionUsageStatsValue(next) ?? next;
}

export function addSubagentHandoffEstimate(
  current: SubagentSessionUsageStats | undefined,
  estimate: SubagentHandoffEstimate
): SubagentSessionUsageStats {
  const base = normalizeSubagentSessionUsageStatsValue(current)
    ?? createEmptySubagentSessionUsageStats(estimate.createdAt);
  const handoffId = normalizeString(estimate.handoffId);
  if (!handoffId || base.countedHandoffIds.includes(handoffId)) {
    return base;
  }
  const kind = normalizeHandoffKind(estimate.kind) ?? 'delegate';
  const tokensEstimate = safeInteger(estimate.tokensEstimate);
  return {
    ...cloneSubagentSessionUsageStats(base),
    rootHandoffTokensEstimate: base.rootHandoffTokensEstimate + tokensEstimate,
    rootHandoffCount: base.rootHandoffCount + 1,
    handoffCountByKind: {
      ...base.handoffCountByKind,
      [kind]: base.handoffCountByKind[kind] + 1
    },
    countedHandoffIds: [...base.countedHandoffIds, handoffId],
    updatedAt: normalizeTimestamp(estimate.createdAt)
  };
}

export function createAcceptedRootSubagentHandoffEstimate(input: {
  toolName: string;
  handoffId: string;
  rootRunId: string;
  tokensEstimate: number;
  accepted: boolean;
  nested: boolean;
  createdAt?: string;
}): SubagentHandoffEstimate | undefined {
  if (!input.accepted || input.nested) {
    return undefined;
  }
  const kind = getSubagentHandoffKind(input.toolName);
  if (!kind) {
    return undefined;
  }
  return {
    handoffId: normalizeString(input.handoffId),
    rootRunId: normalizeString(input.rootRunId),
    kind,
    tokensEstimate: safeInteger(input.tokensEstimate),
    createdAt: normalizeTimestamp(input.createdAt)
  };
}

export function getSubagentHandoffKind(toolName: string): SubagentHandoffKind | undefined {
  switch (toolName) {
    case 'keepseek_delegate_task':
      return 'delegate';
    case 'keepseek_delegate_parallel':
      return 'parallel';
    case 'keepseek_read_subagent_result':
      return 'read-result';
    default:
      return undefined;
  }
}

export function splitActualUsage(
  stats: SessionUsageStats | TurnUsageStats | undefined
): ActualUsageBreakdown {
  const total = toActualUsageSlice(stats);
  const sourceStats = stats?.bySource;
  const mainSession = sumActualUsageSlices(USAGE_SOURCES
    .filter((source) => source !== 'subagent')
    .map((source) => toActualUsageSlice(sourceStats?.[source])));
  const subagent = toActualUsageSlice(sourceStats?.subagent);
  const known = sumActualUsageSlices([mainSession, subagent]);
  const unattributed = subtractActualUsageSlice(total, known);
  const denominator = total.totalTokens;
  return {
    total,
    mainSession,
    subagent,
    unattributed,
    ...(denominator > 0 ? {
      mainPercent: safePercent(mainSession.totalTokens, denominator),
      subagentPercent: safePercent(subagent.totalTokens, denominator),
      unattributedPercent: safePercent(unattributed.totalTokens, denominator)
    } : {})
  };
}

export function createUsageDetailsViewModel(input: {
  sessionUsageStats?: SessionUsageStats;
  lastTurnUsage?: TurnUsageStats;
  subagentUsageStats?: SubagentSessionUsageStats;
}): UsageDetailsViewModel {
  const session = splitActualUsage(input.sessionUsageStats);
  const lastTurn = input.lastTurnUsage ? splitActualUsage(input.lastTurnUsage) : undefined;
  const subagentStats = normalizeSubagentSessionUsageStatsValue(input.subagentUsageStats);
  const hasSubagentActualUsage = session.subagent.requestCount > 0 || session.subagent.totalTokens > 0;
  const hasSubagents = Boolean(subagentStats?.totalCount || hasSubagentActualUsage);
  if (!hasSubagents) {
    return { session, lastTurn };
  }
  const isolated = subagentStats?.isolatedIntermediateTokensEstimate ?? 0;
  const handoff = subagentStats?.rootHandoffTokensEstimate ?? 0;
  const denominator = isolated + handoff;
  return {
    session,
    lastTurn,
    subagents: {
      totalCount: subagentStats?.totalCount ?? 0,
      completedCount: subagentStats?.completedCount ?? 0,
      failedCount: subagentStats?.failedCount ?? 0,
      stoppedCount: subagentStats?.stoppedCount ?? 0,
      isolatedIntermediateTokensEstimate: isolated,
      rootHandoffTokensEstimate: handoff,
      ...(denominator > 0 ? { contextIsolationRate: safePercent(isolated, denominator) } : {}),
      rootHandoffCount: subagentStats?.rootHandoffCount ?? 0,
      handoffCountByKind: subagentStats?.handoffCountByKind ?? createEmptyHandoffCounts(),
      byModel: (subagentStats?.byModel ?? []).map(cloneSubagentUsageGroup),
      byProfileLane: (subagentStats?.byProfileLane ?? []).map(cloneSubagentUsageGroup),
      recentRuns: (subagentStats?.recentRuns ?? []).map(cloneSubagentRunUsageSummary),
      estimatorVersion: SUBAGENT_USAGE_ESTIMATOR_VERSION
    }
  };
}

export function normalizeSubagentSessionUsageStatsValue(value: unknown): SubagentSessionUsageStats | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return undefined;
  }
  const recentRuns = Array.isArray(value.recentRuns)
    ? value.recentRuns.map(normalizeSubagentRunUsageSummaryValue)
      .filter((item): item is SubagentRunUsageSummary => Boolean(item))
      .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
      .slice(0, MAX_RECENT_SUBAGENT_RUNS)
    : [];
  const countedSubagentIds = normalizeUniqueStrings(value.countedSubagentIds);
  for (const run of recentRuns) {
    if (!countedSubagentIds.includes(run.subagentId)) {
      countedSubagentIds.push(run.subagentId);
    }
  }
  return {
    schemaVersion: 1,
    totalCount: safeInteger(value.totalCount),
    completedCount: safeInteger(value.completedCount),
    failedCount: safeInteger(value.failedCount),
    stoppedCount: safeInteger(value.stoppedCount),
    byModel: normalizeSubagentUsageGroups(value.byModel, 'model'),
    byProfileLane: normalizeSubagentUsageGroups(value.byProfileLane, 'profile'),
    recentRuns,
    countedSubagentIds,
    isolatedIntermediateTokensEstimate: safeInteger(value.isolatedIntermediateTokensEstimate),
    rootHandoffTokensEstimate: safeInteger(value.rootHandoffTokensEstimate),
    rootHandoffCount: safeInteger(value.rootHandoffCount),
    handoffCountByKind: normalizeHandoffCounts(value.handoffCountByKind),
    countedHandoffIds: normalizeUniqueStrings(value.countedHandoffIds),
    updatedAt: normalizeTimestamp(value.updatedAt)
  };
}

function applyRunContribution(
  stats: SubagentSessionUsageStats,
  run: SubagentRunUsageSummary,
  direction: 1 | -1
): SubagentSessionUsageStats {
  const next = cloneSubagentSessionUsageStats(stats);
  next.totalCount = clampCount(next.totalCount + direction);
  next.completedCount = clampCount(next.completedCount + (run.status === 'completed' ? direction : 0));
  next.failedCount = clampCount(next.failedCount + (run.status === 'failed' ? direction : 0));
  next.stoppedCount = clampCount(next.stoppedCount + (run.status === 'stopped' ? direction : 0));
  next.isolatedIntermediateTokensEstimate = clampCount(
    next.isolatedIntermediateTokensEstimate + direction * run.isolatedIntermediateTokensEstimate
  );
  next.byModel = applyGroupContribution(next.byModel, run, 'model', direction);
  next.byProfileLane = applyGroupContribution(next.byProfileLane, run, 'profile', direction);
  return next;
}

function applyGroupContribution(
  groups: SubagentUsageGroup[],
  run: SubagentRunUsageSummary,
  kind: 'model' | 'profile',
  direction: 1 | -1
): SubagentUsageGroup[] {
  const next = groups.map(cloneSubagentUsageGroup);
  const index = next.findIndex((group) => kind === 'model'
    ? group.sourceId === run.sourceId && group.modelId === run.modelId
    : group.profile === run.profile && group.lane === run.lane);
  const base = index >= 0 ? next[index] : {
    ...(kind === 'model'
      ? { sourceId: run.sourceId, modelId: run.modelId, provider: run.provider }
      : { profile: run.profile, lane: run.lane }),
    taskCount: 0,
    completedCount: 0,
    failedCount: 0,
    stoppedCount: 0
  };
  const updated: SubagentUsageGroup = {
    ...base,
    taskCount: clampCount(base.taskCount + direction),
    completedCount: clampCount(base.completedCount + (run.status === 'completed' ? direction : 0)),
    failedCount: clampCount(base.failedCount + (run.status === 'failed' ? direction : 0)),
    stoppedCount: clampCount(base.stoppedCount + (run.status === 'stopped' ? direction : 0)),
    usage: mergeTurnUsage(base.usage, run.usage, direction)
  };
  if (updated.taskCount === 0) {
    if (index >= 0) {
      next.splice(index, 1);
    }
    return next;
  }
  if (index >= 0) {
    next[index] = updated;
  } else if (direction > 0) {
    next.push(updated);
  }
  return next;
}

function mergeTurnUsage(
  left: TurnUsageStats | undefined,
  right: TurnUsageStats | undefined,
  direction: 1 | -1
): TurnUsageStats | undefined {
  if (!right) {
    return left ? { ...left, costByCurrency: { ...(left.costByCurrency ?? {}) } } : undefined;
  }
  const leftUsage = left ?? createEmptyTurnUsage();
  const pricedRequestCount = clampCount((leftUsage.pricedRequestCount ?? 0)
    + direction * (right.pricedRequestCount ?? (right.pricingStatus === 'priced' ? right.requestCount : 0)));
  const unpricedRequestCount = clampCount((leftUsage.unpricedRequestCount ?? 0)
    + direction * (right.unpricedRequestCount ?? (right.pricingStatus === 'priced' ? 0 : right.requestCount)));
  const cacheDataRequestCount = clampCount((leftUsage.cacheDataRequestCount ?? 0)
    + direction * (right.cacheDataRequestCount ?? (right.cacheDataStatus === 'reported' ? right.requestCount : 0)));
  const cacheDataMissingRequestCount = clampCount((leftUsage.cacheDataMissingRequestCount ?? 0)
    + direction * (right.cacheDataMissingRequestCount ?? (right.cacheDataStatus === 'reported' ? 0 : right.requestCount)));
  const costByCurrency = mergeCurrencyCosts(leftUsage.costByCurrency, right.costByCurrency, direction);
  const currencies = Object.keys(costByCurrency);
  const currency = currencies.length === 1 ? currencies[0] : '';
  const requestCount = clampCount(leftUsage.requestCount + direction * right.requestCount);
  if (direction < 0 && requestCount === 0) {
    return undefined;
  }
  const reasoningTokens = clampCount((leftUsage.reasoningTokens ?? 0) + direction * (right.reasoningTokens ?? 0));
  return {
    promptTokens: clampCount(leftUsage.promptTokens + direction * right.promptTokens),
    completionTokens: clampCount(leftUsage.completionTokens + direction * right.completionTokens),
    totalTokens: clampCount(leftUsage.totalTokens + direction * right.totalTokens),
    cacheHitTokens: clampCount(leftUsage.cacheHitTokens + direction * right.cacheHitTokens),
    cacheMissTokens: clampCount(leftUsage.cacheMissTokens + direction * right.cacheMissTokens),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    cacheDataStatus: cacheStatus(cacheDataRequestCount, cacheDataMissingRequestCount),
    requestCount,
    cost: currency ? costByCurrency[currency] ?? 0 : 0,
    currency,
    pricingStatus: pricingStatus(pricedRequestCount, unpricedRequestCount),
    pricedRequestCount,
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    costByCurrency,
    updatedAt: right.updatedAt ?? leftUsage.updatedAt
  };
}

function toActualUsageSlice(value: (Usage & {
  requestCount?: number;
  pricedRequestCount?: number;
  unpricedRequestCount?: number;
  cacheDataRequestCount?: number;
  cacheDataMissingRequestCount?: number;
  costByCurrency?: Record<string, number>;
  currency?: string;
  cost?: number;
  sessionCost?: number;
  pricingStatus?: string;
}) | undefined): ActualUsageSlice {
  if (!value) {
    return createEmptyActualUsageSlice();
  }
  const requestCount = safeInteger(value.requestCount);
  const legacyCost = safeNumber(value.sessionCost ?? value.cost);
  const costByCurrency = normalizeCurrencyCosts(value.costByCurrency, legacyCost, value.currency);
  const pricedRequestCount = safeInteger(value.pricedRequestCount
    ?? (value.pricingStatus === 'priced' || legacyCost > 0 ? requestCount : 0));
  const unpricedRequestCount = safeInteger(value.unpricedRequestCount
    ?? Math.max(0, requestCount - pricedRequestCount));
  const cacheDataRequestCount = safeInteger(value.cacheDataRequestCount
    ?? (value.cacheDataStatus === 'reported' ? requestCount : 0));
  const cacheDataMissingRequestCount = safeInteger(value.cacheDataMissingRequestCount
    ?? (value.cacheDataStatus === 'reported' ? 0 : requestCount));
  return {
    promptTokens: safeInteger(value.promptTokens),
    completionTokens: safeInteger(value.completionTokens),
    totalTokens: safeInteger(value.totalTokens),
    cacheHitTokens: safeInteger(value.cacheHitTokens),
    cacheMissTokens: safeInteger(value.cacheMissTokens),
    ...(safeInteger(value.reasoningTokens) > 0 ? { reasoningTokens: safeInteger(value.reasoningTokens) } : {}),
    cacheDataStatus: cacheStatus(cacheDataRequestCount, cacheDataMissingRequestCount),
    requestCount,
    pricedRequestCount,
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    pricingStatus: pricingStatus(pricedRequestCount, unpricedRequestCount),
    costByCurrency
  };
}

function sumActualUsageSlices(values: ActualUsageSlice[]): ActualUsageSlice {
  return values.reduce((total, value) => {
    const pricedRequestCount = total.pricedRequestCount + value.pricedRequestCount;
    const unpricedRequestCount = total.unpricedRequestCount + value.unpricedRequestCount;
    const cacheDataRequestCount = total.cacheDataRequestCount + value.cacheDataRequestCount;
    const cacheDataMissingRequestCount = total.cacheDataMissingRequestCount + value.cacheDataMissingRequestCount;
    const reasoningTokens = (total.reasoningTokens ?? 0) + (value.reasoningTokens ?? 0);
    return {
      promptTokens: total.promptTokens + value.promptTokens,
      completionTokens: total.completionTokens + value.completionTokens,
      totalTokens: total.totalTokens + value.totalTokens,
      cacheHitTokens: total.cacheHitTokens + value.cacheHitTokens,
      cacheMissTokens: total.cacheMissTokens + value.cacheMissTokens,
      ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
      cacheDataStatus: cacheStatus(cacheDataRequestCount, cacheDataMissingRequestCount),
      requestCount: total.requestCount + value.requestCount,
      pricedRequestCount,
      unpricedRequestCount,
      cacheDataRequestCount,
      cacheDataMissingRequestCount,
      pricingStatus: pricingStatus(pricedRequestCount, unpricedRequestCount),
      costByCurrency: mergeCurrencyCosts(total.costByCurrency, value.costByCurrency, 1)
    };
  }, createEmptyActualUsageSlice());
}

function subtractActualUsageSlice(total: ActualUsageSlice, known: ActualUsageSlice): ActualUsageSlice {
  const pricedRequestCount = clampCount(total.pricedRequestCount - known.pricedRequestCount);
  const unpricedRequestCount = clampCount(total.unpricedRequestCount - known.unpricedRequestCount);
  const cacheDataRequestCount = clampCount(total.cacheDataRequestCount - known.cacheDataRequestCount);
  const cacheDataMissingRequestCount = clampCount(total.cacheDataMissingRequestCount - known.cacheDataMissingRequestCount);
  const reasoningTokens = clampCount((total.reasoningTokens ?? 0) - (known.reasoningTokens ?? 0));
  return {
    promptTokens: clampCount(total.promptTokens - known.promptTokens),
    completionTokens: clampCount(total.completionTokens - known.completionTokens),
    totalTokens: clampCount(total.totalTokens - known.totalTokens),
    cacheHitTokens: clampCount(total.cacheHitTokens - known.cacheHitTokens),
    cacheMissTokens: clampCount(total.cacheMissTokens - known.cacheMissTokens),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
    cacheDataStatus: cacheStatus(cacheDataRequestCount, cacheDataMissingRequestCount),
    requestCount: clampCount(total.requestCount - known.requestCount),
    pricedRequestCount,
    unpricedRequestCount,
    cacheDataRequestCount,
    cacheDataMissingRequestCount,
    pricingStatus: pricingStatus(pricedRequestCount, unpricedRequestCount),
    costByCurrency: subtractCurrencyCosts(total.costByCurrency, known.costByCurrency)
  };
}

function createEmptyActualUsageSlice(): ActualUsageSlice {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheDataStatus: 'unavailable',
    requestCount: 0,
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    pricingStatus: 'unavailable',
    costByCurrency: {}
  };
}

function createEmptyTurnUsage(): TurnUsageStats {
  return {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheDataStatus: 'unavailable',
    requestCount: 0,
    cost: 0,
    currency: '',
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 0,
    cacheDataRequestCount: 0,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  };
}

function normalizeSubagentRunUsageSummary(value: SubagentRunUsageSummary): SubagentRunUsageSummary {
  return normalizeSubagentRunUsageSummaryValue(value)
    ?? createSubagentRunUsageSummary({
      ...value,
      status: normalizeTerminalStatus(value.status) ?? 'failed'
    });
}

function normalizeSubagentRunUsageSummaryValue(value: unknown): SubagentRunUsageSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const subagentId = normalizeString(value.subagentId);
  const parentRunId = normalizeString(value.parentRunId);
  const rootRunId = normalizeString(value.rootRunId);
  const status = normalizeTerminalStatus(value.status);
  if (!subagentId || !parentRunId || !rootRunId || !status) {
    return undefined;
  }
  const toolCallTokensEstimate = safeInteger(value.toolCallTokensEstimate);
  const toolResultTokensEstimate = safeInteger(value.toolResultTokensEstimate);
  const reasoningTokensEstimate = safeInteger(value.reasoningTokensEstimate);
  return {
    subagentId,
    parentRunId,
    rootRunId,
    depth: safeInteger(value.depth),
    profile: normalizeString(value.profile),
    lane: normalizeString(value.lane),
    status,
    sourceId: normalizeString(value.sourceId),
    modelId: normalizeString(value.modelId),
    provider: normalizeString(value.provider),
    startedAt: normalizeTimestamp(value.startedAt),
    completedAt: normalizeTimestamp(value.completedAt),
    durationMs: safeInteger(value.durationMs),
    usage: normalizeTurnUsageStatsValue(value.usage),
    toolCallTokensEstimate,
    toolResultTokensEstimate,
    reasoningTokensEstimate,
    isolatedIntermediateTokensEstimate: calculateIsolatedIntermediateTokensEstimate({
      toolCallTokensEstimate,
      toolResultTokensEstimate,
      reasoningTokensEstimate
    }),
    estimatorVersion: normalizeString(value.estimatorVersion) || SUBAGENT_USAGE_ESTIMATOR_VERSION
  };
}

function normalizeSubagentUsageGroups(value: unknown, kind: 'model' | 'profile'): SubagentUsageGroup[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: SubagentUsageGroup[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const sourceId = normalizeOptionalString(item.sourceId);
    const modelId = normalizeOptionalString(item.modelId);
    const profile = normalizeOptionalString(item.profile);
    const lane = normalizeOptionalString(item.lane);
    if ((kind === 'model' && !modelId) || (kind === 'profile' && (!profile || !lane))) {
      continue;
    }
    result.push({
      ...(sourceId ? { sourceId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(normalizeOptionalString(item.provider) ? { provider: normalizeOptionalString(item.provider) } : {}),
      ...(profile ? { profile } : {}),
      ...(lane ? { lane } : {}),
      taskCount: safeInteger(item.taskCount),
      completedCount: safeInteger(item.completedCount),
      failedCount: safeInteger(item.failedCount),
      stoppedCount: safeInteger(item.stoppedCount),
      usage: normalizeTurnUsageStatsValue(item.usage)
    });
  }
  return result;
}

function cloneSubagentSessionUsageStats(value: SubagentSessionUsageStats): SubagentSessionUsageStats {
  return {
    ...value,
    byModel: value.byModel.map(cloneSubagentUsageGroup),
    byProfileLane: value.byProfileLane.map(cloneSubagentUsageGroup),
    recentRuns: value.recentRuns.map(cloneSubagentRunUsageSummary),
    countedSubagentIds: [...value.countedSubagentIds],
    handoffCountByKind: { ...value.handoffCountByKind },
    countedHandoffIds: [...value.countedHandoffIds]
  };
}

function cloneSubagentUsageGroup(value: SubagentUsageGroup): SubagentUsageGroup {
  return {
    ...value,
    usage: value.usage ? {
      ...value.usage,
      costByCurrency: { ...(value.usage.costByCurrency ?? {}) },
      bySource: value.usage.bySource ? { ...value.usage.bySource } : undefined
    } : undefined
  };
}

function cloneSubagentRunUsageSummary(value: SubagentRunUsageSummary): SubagentRunUsageSummary {
  return {
    ...value,
    usage: value.usage ? {
      ...value.usage,
      costByCurrency: { ...(value.usage.costByCurrency ?? {}) },
      bySource: value.usage.bySource ? { ...value.usage.bySource } : undefined
    } : undefined
  };
}

function normalizeHandoffCounts(value: unknown): Record<SubagentHandoffKind, number> {
  const record = isRecord(value) ? value : {};
  return {
    delegate: safeInteger(record.delegate),
    parallel: safeInteger(record.parallel),
    'read-result': safeInteger(record['read-result'])
  };
}

function createEmptyHandoffCounts(): Record<SubagentHandoffKind, number> {
  return { delegate: 0, parallel: 0, 'read-result': 0 };
}

function normalizeHandoffKind(value: unknown): SubagentHandoffKind | undefined {
  return HANDOFF_KINDS.includes(value as SubagentHandoffKind) ? value as SubagentHandoffKind : undefined;
}

function normalizeTerminalStatus(value: unknown): SubagentTerminalStatus | undefined {
  return value === 'completed' || value === 'failed' || value === 'stopped' ? value : undefined;
}

function pricingStatus(priced: number, unpriced: number): 'priced' | 'partial' | 'unavailable' {
  return priced > 0 && unpriced > 0 ? 'partial' : priced > 0 ? 'priced' : 'unavailable';
}

function cacheStatus(reported: number, missing: number): Usage['cacheDataStatus'] {
  return reported > 0 && missing > 0 ? 'partial' : reported > 0 ? 'reported' : 'unavailable';
}

function normalizeCurrencyCosts(
  value: unknown,
  legacyCost?: unknown,
  legacyCurrency?: unknown
): Record<string, number> {
  const result: Record<string, number> = {};
  if (isRecord(value)) {
    for (const [currency, cost] of Object.entries(value)) {
      const normalizedCurrency = currency.trim();
      if (normalizedCurrency) {
        result[normalizedCurrency] = safeNumber(cost);
      }
    }
  } else {
    const currency = normalizeString(legacyCurrency);
    const cost = safeNumber(legacyCost);
    if (currency && cost > 0) {
      result[currency] = cost;
    }
  }
  return result;
}

function mergeCurrencyCosts(
  left: Record<string, number> | undefined,
  right: Record<string, number> | undefined,
  direction: 1 | -1
): Record<string, number> {
  const result = normalizeCurrencyCosts(left);
  for (const [currency, cost] of Object.entries(normalizeCurrencyCosts(right))) {
    const next = Math.max(0, (result[currency] ?? 0) + direction * cost);
    if (next > 0) {
      result[currency] = next;
    } else {
      delete result[currency];
    }
  }
  return result;
}

function subtractCurrencyCosts(
  total: Record<string, number>,
  known: Record<string, number>
): Record<string, number> {
  return mergeCurrencyCosts(total, known, -1);
}

function normalizeUniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeString).filter(Boolean))];
}

function safePercent(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (numerator / denominator) * 100));
}

function clampCount(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function safeInteger(value: unknown): number {
  const number = Number(value);
  return Math.max(0, Math.floor(Number.isFinite(number) ? number : 0));
}

function safeNumber(value: unknown): number {
  const number = Number(value);
  return Math.max(0, Number.isFinite(number) ? number : 0);
}

function parseTimestamp(value: unknown): number {
  const timestamp = Date.parse(normalizeTimestamp(value));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(Date.parse(value)).toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeOptionalString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
