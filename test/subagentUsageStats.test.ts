import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  addSubagentHandoffEstimate,
  allocateSharedMessageTokens,
  calculateIsolatedIntermediateTokensEstimate,
  createAcceptedRootSubagentHandoffEstimate,
  createSubagentRunUsageSummary,
  createUsageDetailsViewModel,
  MAX_RECENT_SUBAGENT_RUNS,
  normalizeSubagentSessionUsageStatsValue,
  splitActualUsage,
  toSubagentProgressViewModel,
  upsertSubagentRunUsageSummary
} from '../src/agent/subagentUsageStats';
import {
  addTurnUsageToSessionStats,
  addUsageEventToSessionStats,
  addUsageEventToTurnStats,
  createUsageEvent,
  normalizeSessionUsageStatsValue,
  normalizeTurnUsageStatsValue
} from '../src/agent/usageStats';
import { applyUsageLedgerDeltaToSessionStats, applyUsageLedgerSummaryToSessionStats, rebuildSessionUsageStatsFromLedger } from '../src/agent/usageStats';
import { summarizeUsageLedger, mergePendingUsageLedger, createUsageLedgerRecords, createUsagePriceSnapshot } from '../src/agent/usageLedger';
import { getVisibleMessages, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ContextUsageEstimate, SubagentSessionUsageStats, SubagentTerminalStatus, UsageSource } from '../src/shared/types';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getInputScript } from '../src/webview/input/script';
import { getInputStyles } from '../src/webview/input/styles';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { createProviderCacheObservation } from '../src/agent/cacheObservation';
import { buildReferenceCostView } from '../src/agent/usageReferenceCosts';

test('host ledger flush preserves ref damage and does not spin after storage failure', async () => {
  const price = createUsagePriceSnapshot({ originalModelId: 'fixture', sourceId: 'fixture', provider: 'qwencloud',
    protocol: 'chat_completions', supportsBilling: false });
  const records = createUsageLedgerRecords({ requestId: 'survivor', attempts: [price], source: 'executor' });
  const session = { id: 's', messages: [], usageLedger: { version: 1, records },
    usageLedgerRef: { version: 2, sessionId: 's', incomplete: true, damagedBucketCount: 1 } } as unknown as import('../src/shared/types').ChatSession;
  let writes = 0, fail = true;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    usageLedgerFlushes: new Map<string, Promise<void>>(),
    referenceCostViews: new Map(),
    usageLedgerStore: {
      appendMany: async () => { writes++; if (fail) throw new Error('injected storage failure'); },
      rebuild: async () => ({ ledger: { version: 1, records, incomplete: false, legacyAggregate: false }, damagedBucketCount: 0 })
    }, sessionStore: { persist: async () => {} }
  }) as { queueUsageLedgerFlush(session: import('../src/shared/types').ChatSession): void; usageLedgerFlushes: Map<string, Promise<void>> };
  host.queueUsageLedgerFlush(session);
  await host.usageLedgerFlushes.get(session.id);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(writes, 1);
  assert.equal(session.usageLedger?.records.length, records.length);
  fail = false;
  host.queueUsageLedgerFlush(session);
  await host.usageLedgerFlushes.get(session.id);
  assert.equal(writes, 2);
  assert.equal(session.usageLedger, undefined, 'successful retry finishes the durable flush');
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: session.usageStats }).session.total.attemptStatsIncomplete, true);
});

test('reference fees propagate to child totals, model groups, work types and individual runs', () => {
  const summary = run('child-reference');
  const subagents = upsertSubagentRunUsageSummary(undefined, summary);
  const snapshot = createUsagePriceSnapshot({ originalModelId: summary.modelId, sourceId: summary.sourceId,
    provider: 'deepseek', protocol: 'chat-completions', supportsBilling: false, requestStartedAt: summary.startedAt });
  const observation = createProviderCacheObservation({ requestId: 'child-request', attemptIndex: 0,
    source: 'subagent', sourceId: summary.sourceId, provider: 'deepseek', baseUrl: 'https://proxy.example/v1',
    body: { model: summary.modelId, stream: true, messages: [{ role: 'user', content: 'hello' }] },
    conversationId: summary.subagentId, subagentProfile: summary.profile, subagentLane: summary.lane });
  const records = createUsageLedgerRecords({ requestId: 'child-request', attempts: [snapshot],
    source: 'subagent', usage: event('subagent').usage, cacheObservations: [observation] });
  const original = JSON.stringify(subagents);
  const view = buildReferenceCostView({ version: 1, records, incomplete: false, legacyAggregate: false }, { subagentUsageStats: subagents });
  const expected = view.session!.sessionCost;
  assert.ok(expected > 0);
  assert.equal(view.subagents?.byModel[0].usage?.cost, expected);
  assert.equal(view.subagents?.byProfileLane[0].usage?.cost, expected);
  assert.equal(view.subagents?.recentRuns[0].usage?.cost, expected);
  assert.equal(JSON.stringify(subagents), original);
});

test('attempt and usage response counts survive normalization, aggregation and host view conversion', () => {
  const normalized = normalizeSessionUsageStatsValue({ promptTokens: 97349731, completionTokens: 534073,
    totalTokens: 97883804, cacheHitTokens: 0, cacheMissTokens: 0, sessionCost: 0, currency: '',
    requestCount: 274, providerAttemptCount: 274, usageResponseCount: 256, attemptStatsIncomplete: false });
  const view = createUsageDetailsViewModel({ sessionUsageStats: normalized });
  assert.equal(view.session.total.providerAttemptCount, 274);
  assert.equal(view.session.total.usageResponseCount, 256);
  const old = normalizeTurnUsageStatsValue({ promptTokens: 100, totalTokens: 100, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, requestCount: 1, cost: 0, currency: '' });
  assert.equal(createUsageDetailsViewModel({ lastTurnUsage: old }).lastTurn!.total.attemptStatsIncomplete, true);
});

test('pending ledger deltas do not replace session totals or double-count a repeated attempt', () => {
  const empty = summarizeUsageLedger(undefined);
  const base = applyUsageLedgerSummaryToSessionStats(undefined, { ...empty,
    providerAttemptCount: 274, usageResponseCount: 256,
    bySourceCounts: { executor: { providerAttemptCount: 270, usageResponseCount: 253 }, subagent: { providerAttemptCount: 4, usageResponseCount: 3 } } });
  const pending = { ...empty, providerAttemptCount: 1, usageResponseCount: 0,
    bySourceCounts: { executor: { providerAttemptCount: 1, usageResponseCount: 0 } } };
  const next = applyUsageLedgerDeltaToSessionStats(base, empty, pending);
  assert.equal(next!.providerAttemptCount, 275); assert.equal(next!.usageResponseCount, 256);
  const duplicate = applyUsageLedgerDeltaToSessionStats(next, pending, pending);
  assert.equal(duplicate!.providerAttemptCount, 275);
  const split = splitActualUsage(duplicate);
  assert.equal(split.mainSession.providerAttemptCount, 271);
  assert.equal(split.subagent.providerAttemptCount, 4);
  assert.equal(split.subagent.usageResponseCount, 3);
  assert.equal(split.mainSession.attemptStatsIncomplete, false);
});

test('durable ledger rebuild includes attempts arriving during its await without counting flushed records twice', () => {
  const price = createUsagePriceSnapshot({ originalModelId: 'fixture', sourceId: 'fixture', provider: 'qwencloud',
    protocol: 'chat_completions', supportsBilling: false });
  const first = createUsageLedgerRecords({ requestId: 'first', attempts: [price], source: 'executor' })[0];
  const late = createUsageLedgerRecords({ requestId: 'late', attempts: [price], source: 'executor',
    usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11, cacheHitTokens: 0, cacheMissTokens: 10, cacheDataStatus: 'unavailable' } })[0];
  const durable = { version: 1 as const, records: [first], legacyAggregate: false, incomplete: false };
  const pending = { ...durable, records: [first, late] };
  const merged = mergePendingUsageLedger(durable, pending);
  assert.equal(summarizeUsageLedger(merged).providerAttemptCount, 2);
  assert.equal(summarizeUsageLedger(merged).usageResponseCount, 1);
  assert.equal(summarizeUsageLedger(merged).totalTokens, 11);
  assert.deepEqual(mergePendingUsageLedger(merged, pending), merged);
  assert.equal(pending.records.length, 2, 'unflushed records remain available for the next durable batch');
});

test('ledger reconstruction preserves incomplete durable and pending provenance through the host view', () => {
  const price = createUsagePriceSnapshot({ originalModelId: 'fixture', sourceId: 'fixture', provider: 'qwencloud',
    protocol: 'chat_completions', supportsBilling: false });
  const records = createUsageLedgerRecords({ requestId: 'surviving-bucket', attempts: [price], source: 'executor' });
  for (const metadata of [{ incomplete: true }, { legacyAggregate: true }]) {
    const stats = rebuildSessionUsageStatsFromLedger(records, metadata);
    const view = createUsageDetailsViewModel({ sessionUsageStats: normalizeSessionUsageStatsValue(stats) });
    assert.equal(view.session.total.providerAttemptCount, 1, 'surviving attempts are a lower bound');
    assert.equal(view.session.total.attemptStatsIncomplete, true);
  }
  assert.equal(rebuildSessionUsageStatsFromLedger(records)?.attemptStatsIncomplete, false);
});

test('source usage keeps separate currencies, priced zero cost, partial pricing, and cache coverage through merges', () => {
  let turn = addUsageEventToTurnStats(undefined, event('subagent', 120, 'CNY', 1));
  assert.deepEqual(turn.bySource?.subagent?.costByCurrency, { CNY: 1 });
  turn = addUsageEventToTurnStats(turn, event('subagent', 60, 'USD', 2));
  turn = addUsageEventToTurnStats(turn, event('subagent', 40, '', 0, false));
  const source = turn.bySource?.subagent;
  assert.equal(source?.cost, 0);
  assert.deepEqual(source?.costByCurrency, { CNY: 1, USD: 2 });
  assert.equal(source?.pricedRequestCount, 2);
  assert.equal(source?.unpricedRequestCount, 1);
  assert.equal(source?.cacheDataRequestCount, 2);
  assert.equal(source?.cacheDataMissingRequestCount, 1);
  assert.equal(source?.cacheDataStatus, 'partial');
  const session = addTurnUsageToSessionStats(undefined, normalizeTurnUsageStatsValue(turn)!);
  assert.deepEqual(session.bySource?.subagent, source);
  assert.deepEqual(normalizeSessionUsageStatsValue(session)?.bySource?.subagent, source);
  const free = addUsageEventToTurnStats(undefined, event('subagent', 1, 'USD', 0));
  const grouped = upsertSubagentRunUsageSummary(undefined, { ...run('free'), usage: free });
  assert.deepEqual(grouped.byModel[0].usage?.costByCurrency, { USD: 0 });
});

test('old source usage inherits only an unambiguous currency and missing cache data stays unavailable', () => {
  const legacy = {
    promptTokens: 100, completionTokens: 20, totalTokens: 120,
    cacheHitTokens: 0, cacheMissTokens: 0, requestCount: 1, cost: 0.5
  };
  const single = normalizeSessionUsageStatsValue({ ...legacy, sessionCost: 0.5, currency: 'CNY', bySource: { executor: legacy } })!;
  assert.deepEqual(single.bySource?.executor?.costByCurrency, { CNY: 0.5 });
  assert.equal(single.bySource?.executor?.cacheDataRequestCount, 0);
  assert.equal(single.bySource?.executor?.cacheDataMissingRequestCount, 1);
  const mixed = normalizeSessionUsageStatsValue({
    ...legacy, sessionCost: 0, currency: 'USD', costByCurrency: { CNY: 1, USD: 2 }, bySource: { executor: legacy }
  })!;
  assert.deepEqual(mixed.bySource?.executor?.costByCurrency, {});
  assert.deepEqual(splitActualUsage(mixed).unattributed.costByCurrency, { CNY: 1, USD: 2 });
});

test('main-session attribution keeps reviewer and subagent calls separate and does not absorb unclassified history', () => {
  let stats = normalizeSessionUsageStatsValue({
    promptTokens: 80, completionTokens: 20, totalTokens: 100, cacheHitTokens: 0, cacheMissTokens: 0,
    requestCount: 1, sessionCost: 0.25, currency: 'CNY'
  });
  const mainSources: UsageSource[] = ['executor', 'retry', 'continuation', 'summary', 'background', 'retrieval', 'router'];
  for (const source of mainSources) { stats = addUsageEventToSessionStats(stats, event(source, 10, 'CNY', 0.01)); }
  stats = addUsageEventToSessionStats(stats, event('reviewer', 15, 'USD', 0.03));
  stats = addUsageEventToSessionStats(stats, event('subagent', 30, 'USD', 0.02));
  const split = splitActualUsage(stats);
  assert.equal(split.total.totalTokens, 215);
  assert.equal(split.mainSession.totalTokens, 70);
  assert.equal(split.reviewer.totalTokens, 15);
  assert.equal(split.subagent.totalTokens, 30);
  assert.equal(split.unattributed.totalTokens, 100);
  assert.equal(split.mainSession.requestCount, 7);
  assert.equal(split.reviewer.requestCount, 1);
  assert.equal(split.subagent.requestCount, 1);
  assert.equal(split.unattributed.requestCount, 1);
  assert.ok((split.reviewerPercent ?? 0) > 0);
  assert.deepEqual(split.reviewer.costByCurrency, { USD: 0.03 });
  assert.deepEqual(split.subagent.costByCurrency, { USD: 0.02 });
  assert.ok(Math.abs(split.unattributed.costByCurrency.CNY - 0.25) < 1e-12);
});

test('fixed child model groups use sourceId plus modelId and never merge same-named models across accounts', () => {
  let stats = upsertSubagentRunUsageSummary(undefined, run('one', 'completed', 'account-a', 'fixed-small'));
  stats = upsertSubagentRunUsageSummary(stats, run('two', 'failed', 'account-b', 'fixed-small'));
  stats = upsertSubagentRunUsageSummary(stats, run('three', 'stopped', 'account-a', 'other-model'));
  assert.equal(stats.byModel.length, 3);
  assert.equal(stats.byModel.find((group) => group.sourceId === 'account-b')?.failedCount, 1);
  assert.equal(stats.byProfileLane[0].taskCount, 3);
  assert.equal(stats.byProfileLane[0].usage?.totalTokens, 360);
  assert.equal(stats.completedCount, 1);
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.stoppedCount, 1);
});

test('subagent updates are idempotent and concurrent terminal callbacks merge against the latest session value', async () => {
  let stats: SubagentSessionUsageStats | undefined;
  await Promise.all(Array.from({ length: 12 }, async (_, index) => {
    await Promise.resolve();
    stats = upsertSubagentRunUsageSummary(stats, run('concurrent-' + index));
  }));
  assert.equal(stats?.totalCount, 12);
  assert.equal(stats?.byModel[0].usage?.totalTokens, 1440);
  const previous = JSON.stringify(stats);
  stats = upsertSubagentRunUsageSummary(stats, run('concurrent-0'));
  assert.equal(JSON.stringify(stats), previous);
  stats = upsertSubagentRunUsageSummary(stats, run('concurrent-0', 'failed'));
  assert.equal(stats.totalCount, 12);
  assert.equal(stats.completedCount, 11);
  assert.equal(stats.failedCount, 1);
  assert.equal(stats.byModel[0].usage?.totalTokens, 1440);
});

test('trimming recent run details retains cumulative counts and ignores late duplicate terminal callbacks', () => {
  let stats: SubagentSessionUsageStats | undefined;
  for (let index = 0; index < MAX_RECENT_SUBAGENT_RUNS + 10; index += 1) {
    stats = upsertSubagentRunUsageSummary(stats, {
      ...run('run-' + index), completedAt: new Date(index * 1000).toISOString()
    });
  }
  assert.equal(stats?.recentRuns.length, MAX_RECENT_SUBAGENT_RUNS);
  assert.equal(stats?.totalCount, MAX_RECENT_SUBAGENT_RUNS + 10);
  const total = stats?.byModel[0].usage?.totalTokens;
  stats = upsertSubagentRunUsageSummary(stats, run('run-0'));
  assert.equal(stats.byModel[0].usage?.totalTokens, total);
  assert.equal(stats.totalCount, MAX_RECENT_SUBAGENT_RUNS + 10);
});

test('isolation estimates include only new tool calls, tool results, and reasoning; invalid inputs cannot produce NaN or negatives', () => {
  const summary = run('formula');
  assert.equal(summary.isolatedIntermediateTokensEstimate, 600);
  assert.equal(calculateIsolatedIntermediateTokensEstimate({ toolCallTokensEstimate: -5, toolResultTokensEstimate: NaN, reasoningTokensEstimate: Infinity }), 0);
  let stats = upsertSubagentRunUsageSummary(undefined, summary);
  stats = addSubagentHandoffEstimate(stats, {
    handoffId: 'handoff', rootRunId: 'root', kind: 'delegate', tokensEstimate: 200, createdAt: summary.completedAt
  });
  const view = createUsageDetailsViewModel({ subagentUsageStats: stats });
  assert.equal(view.subagents?.contextIsolationRate, 75);
  assert.equal(view.subagents?.isolatedIntermediateTokensEstimate, 600);
  assert.equal(addSubagentHandoffEstimate(stats, {
    handoffId: 'handoff', rootRunId: 'root', kind: 'delegate', tokensEstimate: 200, createdAt: summary.completedAt
  }).rootHandoffCount, 1);
  const empty = upsertSubagentRunUsageSummary(undefined, { ...summary, toolCallTokensEstimate: 0, toolResultTokensEstimate: 0, reasoningTokensEstimate: 0 });
  assert.equal(createUsageDetailsViewModel({ subagentUsageStats: empty }).subagents?.contextIsolationRate, undefined);
});

test('handoff observer accepts the three root tools only and excludes nested or budget-rejected results', () => {
  for (const [name, kind] of [
    ['keepseek_delegate_task', 'delegate'], ['keepseek_delegate_parallel', 'parallel'], ['keepseek_read_subagent_result', 'read-result']
  ]) {
    const input = { toolName: name, handoffId: name, rootRunId: 'root', tokensEstimate: 42, accepted: true, nested: false };
    assert.equal(createAcceptedRootSubagentHandoffEstimate(input)?.kind, kind);
    assert.equal(createAcceptedRootSubagentHandoffEstimate({ ...input, nested: true }), undefined);
    assert.equal(createAcceptedRootSubagentHandoffEstimate({ ...input, accepted: false }), undefined);
  }
  assert.equal(createAcceptedRootSubagentHandoffEstimate({ toolName: 'keepseek_read_workspace_file', handoffId: 'read', rootRunId: 'root', tokensEstimate: 42, accepted: true, nested: false }), undefined);
  assert.ok(Date.parse(createAcceptedRootSubagentHandoffEstimate({toolName: 'keepseek_delegate_task', handoffId: 'now', rootRunId: 'root', tokensEstimate: 1, accepted: true, nested: false})!.createdAt) > 0);
  assert.deepEqual(allocateSharedMessageTokens(100, [1, 2, 3]), [16, 33, 51]);
  assert.deepEqual(allocateSharedMessageTokens(0, [NaN, -1]), [0, 0]);
});

test('session persistence and the Webview view model whitelist statistics, never child private content', () => {
  const stats = upsertSubagentRunUsageSummary(undefined, run('private'));
  const polluted = {
    ...stats, transcript: 'PRIVATE_TRANSCRIPT', toolResults: 'PRIVATE_TOOLS',
    recentRuns: [{ ...stats.recentRuns[0], task: 'PRIVATE_TASK', result: 'PRIVATE_RESULT', reasoning: 'PRIVATE_REASONING', error: 'PRIVATE_ERROR' }]
  };
  const stored = normalizeStoredSessions({ sessions: [{
    id: 'session', title: 'test', messages: [], createdAt: '2026-01-01T00:00:00.000Z',
    subagentUsageStats: polluted
  }] }, { key: 'workspace', name: 'workspace', folderUris: [] })[0];
  assert.equal(stored.subagentUsageStats?.totalCount, 1);
  assert.doesNotMatch(JSON.stringify(stored.subagentUsageStats), /PRIVATE_/u);
  assert.doesNotMatch(JSON.stringify(createUsageDetailsViewModel({ subagentUsageStats: polluted })), /PRIVATE_|transcript|toolResults|"reasoning"|"task"|"error"/u);
  assert.equal(normalizeSubagentSessionUsageStatsValue(undefined), undefined);
  assert.equal(createUsageDetailsViewModel({}).subagents, undefined);
  const main = addUsageEventToSessionStats(undefined, event('executor'));
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: main }).session.mainSession.totalTokens, 120);
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: main }).subagents, undefined);
  const legacyChild = addUsageEventToSessionStats(undefined, event('subagent'));
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: legacyChild }).subagents?.estimatesAvailable, false);
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: legacyChild }).subagents?.byModel[0].usage.totalTokens, 120);
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: legacyChild }).subagents?.byModel[0].taskCountsAvailable, false);
  const progress = toSubagentProgressViewModel({ id: 'sa_child', parentSessionId: 'session', parentRunId: 'root',
    profile: 'research', lane: 'research-read', depth: 1, status: 'failed', summary: 'PRIVATE_ERROR_AND_RESULT', updatedAt: '' });
  assert.doesNotMatch(JSON.stringify(progress), /PRIVATE_|summary/u);
  const messages = getVisibleMessages([{ id: 'assistant', role: 'assistant', content: 'Visible final response', createdAt: '',
    toolRounds: [{ assistantContent: 'PRIVATE_TOOL_ROUND', reasoningContent: 'PRIVATE_TOOL_REASONING', toolCalls: [], toolResults: [] }] }]);
  assert.doesNotMatch(JSON.stringify(messages), /PRIVATE_|toolRounds/u);
});

test('usage details are keyboard-accessible, localized, and generated Webview scripts compile', async () => {
  const template = getInputTemplate();
  const script = getInputScript();
  assert.match(template, /<button id="contextProgress"[^>]*type="button"[^>]*aria-expanded="false"/u);
  assert.match(template, /<dialog id="usageDetailsDialog"[^>]*aria-labelledby="usageDetailsTitle"[^>]*aria-describedby="usageDetailsDescription"/u);
  assert.match(script, /usageDetailsDialog\.showModal\(\)/u);
  assert.match(script, /usageDetailsDialog\.addEventListener\('cancel'/u);
  assert.match(script, /usageDetailsDialog\.addEventListener\('close'[\s\S]*?target\.focus\(\)/u);
  assert.match(script, /subagents\.recentRuns/u);
  assert.match(script, /details\.session\.subagent\.totalTokens/u);
  assert.match(script, /usageMetricEffectiveExecution/u);
  assert.match(script, /function getLatestRunState\(\)/u);
  assert.match(script, /var usageAnalysisMode = 'source'/u);
  assert.match(script, /button\[data-usage-analysis\]/u);
  assert.doesNotMatch(script, /data-usage-scope|usageDetailsScope|usageOverviewLabel|usageThisTurn/u);
  const tooltipRenderer = script.slice(script.indexOf('function renderContextProgress()'), script.indexOf('function getLatestRunState()'));
  assert.doesNotMatch(tooltipRenderer, /usageMetric(?:CacheReasons|CompactThreshold|CacheHitTokens|CacheMissTokens)/u);
  assert.doesNotMatch(tooltipRenderer, /usageMetric(?:UsageGroups|LegacyUnattributed)/u);
  assert.doesNotMatch(tooltipRenderer, /usageOpenDetails/u);
  assert.match(tooltipRenderer, /costDisplay\.available \? costDisplay\.amountText/u);
  assert.doesNotMatch(tooltipRenderer, /costDisplay\.available \? costDisplay\.text/u);
  for (const isOfficialDeepSeek of [true, false]) {
    for (const available of [true, false]) {
      const rows: string[] = [];
      const noop = () => undefined;
      const env = {
        state: { usageMetrics: { isOfficialDeepSeek, sessionUsageStats: { totalTokens: 100 }, turnCount: 1 } },
        normalizeUsageMetrics: (value: unknown) => value,
        contextProgress: { style: { setProperty: noop }, classList: { toggle: noop }, setAttribute: noop },
        contextProgressTitle: null, contextProgressPercent: null, contextProgressTokens: null,
        contextProgressBreakdown: { innerHTML: '', append: (row: string) => rows.push(row), classList: { remove: noop } },
        usageDetailsDialog: null,
        findCurrentUsageGroup: noop, clampNumber: () => 0,
        t: (key: string) => key, formatContextPercentValue: () => '0%',
        formatMetricTokens: () => '100', hasUsageData: () => true,
        hasCacheUsageData: () => false, formatCacheHitRate: () => '--',
        formatMetricInteger: () => '1',
        formatAccountedCosts: () => ({ available, amountText: '¥1.00' }),
        formatUsageAvailabilityValue: () => '--', getLatestRunState: noop,
        createMetricLine: (label: string) => label
      };
      new Function(...Object.keys(env), tooltipRenderer + ';renderContextProgress();')(...Object.values(env));
      assert.equal(rows.some((row) => /Cost/u.test(row)), true);
      assert.ok(rows.includes('usageMetricTurnTokens'));
    }
  }
  const inputStyles = getInputStyles();
  const labelRenderer = script.slice(script.indexOf('function createUsageMetricLabel('), script.indexOf('function createUsageAnalysisCard('));
  for (const [official, referenceIds, sourceId, expected] of [
    [true, [], undefined, false], [false, ['proxy'], undefined, true],
    [true, ['proxy'], 'official', false], [true, ['proxy'], 'proxy', true], [true, ['proxy'], undefined, true]
  ] as const) {
    const makeLabel = new Function('state', 'normalizeUsageMetrics', 't', 'usageNode',
      labelRenderer + '; return createUsageMetricLabel;')(
      { usageMetrics: { isOfficialDeepSeek: official, referenceCostSourceIds: referenceIds } },
      (value: unknown) => value, (key: string) => WEBVIEW_TRANSLATIONS.en[key],
      (tagName: string, className: string, textContent?: string) => ({ tagName, className, textContent, children: [] as unknown[], attributes: {} as Record<string, string>, append(...children: unknown[]) { this.children.push(...children); }, setAttribute(key: string, value: string) { this.attributes[key] = value; } })
    );
    const label = makeLabel('usageCostLabel', sourceId);
    assert.equal(label.children.length > 0, expected);
    if (expected) {
      const [trigger, tooltip] = label.children[0].children;
      assert.match(trigger.attributes['aria-label'], /DeepSeek Flash V4.1/u);
      assert.equal(trigger.title, undefined, 'no duplicate native tooltip');
      assert.equal(tooltip.attributes.role, 'tooltip');
      assert.equal(tooltip.textContent, WEBVIEW_TRANSLATIONS.en.usageFlashReferencePriceHint);
      assert.match(trigger.innerHTML, /<svg[^>]+viewBox="0 0 20 20"/u);
    }
    assert.equal(makeLabel('usageTotalTokensLabel', sourceId).children.length, 0);
  }
  assert.match(inputStyles, /\.context-progress:hover::before[\s\S]*?context-progress-inward-scan 900ms linear infinite/u);
  assert.match(inputStyles, /@keyframes context-progress-inward-scan[\s\S]*?transform: scale\(1\)[\s\S]*?transform: scale\(0\.08\)[\s\S]*?transform: scale\(0\)/u);
  assert.match(inputStyles, /\.context-progress:hover \.context-progress-ring::before[\s\S]*?context-progress-outer-sync 900ms linear infinite/u);
  assert.match(inputStyles, /@keyframes context-progress-outer-sync[\s\S]*?opacity: 0\.85[\s\S]*?opacity: 0/u);
  assert.doesNotMatch(inputStyles, /\.context-progress::after|context-progress-(?:ripple|breathe|center-flash|inward-pulse)|scale\(2\.2\)|drop-shadow/u);
  assert.equal('usageOpenDetails' in WEBVIEW_TRANSLATIONS.en, false);
  assert.equal(WEBVIEW_TRANSLATIONS.en.usageCostLabel, 'Reference cost');
  assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].usageCostLabel, '参考费用');
  assert.equal('usageOpenDetails' in WEBVIEW_TRANSLATIONS['zh-CN'], false);
  const detailsRenderer = script.slice(script.indexOf('function renderUsageDetails()'), script.indexOf('function createUsageSection('));
  assert.match(detailsRenderer, /createContextWindowSection\(metrics\)/u);
  assert.match(detailsRenderer, /usageCacheAttribution/u);
  assert.match(detailsRenderer, /usageCompactSource/u);
  assert.match(detailsRenderer, /usageAnalysisTitle/u);
  assert.match(detailsRenderer, /usageBySource/u);
  assert.match(detailsRenderer, /usageByType/u);
  assert.match(detailsRenderer, /usage-details-eyebrow', t\('usageDetailsTitle'\)/u);
  assert.match(detailsRenderer, /var selected = details\.session/u);
  assert.match(detailsRenderer, /usageMetricLegacyUnattributed/u);
  assert.match(detailsRenderer, /var mainSessionOnly = selected\.total\.totalTokens > 0 && selected\.mainPercent >= 100/u);
  assert.match(detailsRenderer, /if \(mainSessionOnly\) \{\s*list\.append\(createActualAnalysisCard/u);
  assert.match(script, /function createSourceAnalysisCard\(group, colorClass\)/u);
  const analysisCardRenderer = script.slice(
    script.indexOf('function createUsageAnalysisCard('),
    script.indexOf('function createSubagentAnalysisDetails(')
  );
  assert.match(analysisCardRenderer, /usageNode\('div', 'usage-analysis-card'\)/u);
  assert.match(analysisCardRenderer, /card\.append\(header\)[\s\S]*?card\.append\(body\)/u);
  assert.doesNotMatch(analysisCardRenderer, /usageNode\('details'|usageNode\('summary'|usageAnalysisExpand/u);
  assert.doesNotMatch(inputStyles, /\.usage-analysis-(?:summary|expand)|\.usage-analysis-card\[open\]/u);
  assert.equal('usageAnalysisExpand' in WEBVIEW_TRANSLATIONS.en, false);
  assert.equal('usageAnalysisExpand' in WEBVIEW_TRANSLATIONS['zh-CN'], false);
  assert.match(script, /amountText: amountText, text: textValue/u);
  const costFormatterSource = script.slice(
    script.indexOf('function formatMetricCost('),
    script.indexOf('function formatMetricBalance(')
  );
  const formatMetricCost = new Function('t', costFormatterSource + '; return formatMetricCost;')(
    (key: string) => key
  ) as (value: number, currency: string, hasData: boolean) => string;
  assert.equal(formatMetricCost(12.239, '¥', true), '¥12.23');
  assert.equal(formatMetricCost(12.235, '¥', true), '¥12.23');
  assert.equal(formatMetricCost(0.009, '¥', true), '¥0.00');
  assert.equal(formatMetricCost(1.15, '¥', true), '¥1.15');
  assert.equal(formatMetricCost(12.999999999999998, '¥', true), '¥12.99');
  assert.equal(formatMetricCost(1e-9, '$', true), '$0.00');
  assert.equal(formatMetricCost(1.2, '$', true), '$1.20');
  const accountedCostsSource = script.slice(
    script.indexOf('function formatAccountedCosts('),
    script.indexOf('function normalizeCacheReasonList(')
  );
  const formatAccountedCosts = new Function(
    't', accountedCostsSource + costFormatterSource + '; return formatAccountedCosts;'
  )((key: string) => key) as (usage: Record<string, unknown>) => { amountText: string };
  const pricedUsage = {
    costByCurrency: { '¥': 12.239 }, pricingStatus: 'priced', pricedRequestCount: 1, unpricedRequestCount: 0
  };
  assert.equal(formatAccountedCosts({ ...pricedUsage, provider: 'deepseek' }).amountText, '¥12.23');
  assert.equal(formatAccountedCosts({ ...pricedUsage, provider: 'kimi' }).amountText, '¥12.23');
  const mixedCosts = { ...pricedUsage, costByCurrency: { '¥': 12.239, '$': 2.999 } };
  const recorded = JSON.stringify(mixedCosts);
  assert.equal(formatAccountedCosts(mixedCosts).amountText, '¥12.23 · $2.99');
  assert.equal(JSON.stringify(mixedCosts), recorded, 'display truncation never alters recorded amounts');
  assert.doesNotThrow(() => new Function(script));
  const webviewScript = getScript();
  assert.doesNotThrow(() => new Function(webviewScript));
  assert.match(webviewScript, /if \(run\.status === 'running' \|\| run\.status === 'completed'\) return null/u);
  assert.doesNotMatch(webviewScript, /t\('run(?:Execution|Limit|LastActivity|Calls)'/u);
  const keys = new Set([...script.matchAll(/['"](usage[A-Z][A-Za-z]+)['"]/gu)].map((match) => match[1]));
  for (const key of keys) {
    // DOM ids and CSS-independent state keys are not translation keys.
    if (/^(usageDetails(Dialog|Body|Close))$/u.test(key)) { continue; }
    assert.ok(WEBVIEW_TRANSLATIONS.en[key], 'missing English ' + key);
    assert.ok(WEBVIEW_TRANSLATIONS['zh-CN'][key], 'missing Chinese ' + key);
    assert.doesNotMatch(WEBVIEW_TRANSLATIONS.en[key], /[\u3400-\u9fff]/u);
  }
  assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].usageEstimateDisclaimer, '这是对子代理内部中间工作与主会话实际回传内容的本地估算，不等于账单 Token 节省值。');
  assert.equal(WEBVIEW_TRANSLATIONS.en.usagePendingValue, '--');
  assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].usagePendingValue, '--');
  assert.equal(WEBVIEW_TRANSLATIONS.en.usageNoRatio, '--');
  assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].usageNoRatio, '--');
  assert.match(detailsRenderer, /var hasSessionUsage = hasUsageData\(selected\.total\)/u);
  assert.match(detailsRenderer, /formatUsageAvailabilityValue\(selected\.total, 'usageMetricCostUnavailableValue'\)/u);
  assert.match(detailsRenderer, /selected\.total\.attemptStatsIncomplete && !selected\.total\.providerAttemptCount \? t\('usageMetricUnavailableValue'\)/u);
  assert.match(detailsRenderer, /selected\.total\.attemptStatsIncomplete && !selected\.total\.usageResponseCount \? t\('usageMetricUnavailableValue'\)/u);
  assert.match(detailsRenderer, /selected\.total\.attemptStatsIncomplete \? '≥ ' : ''/u);
  assert.match(script, /function formatUsageAvailabilityValue\(usage, unavailableKey\) \{\s*return hasUsageData\(usage\) \? t\(unavailableKey\) : t\('usagePendingValue'\);/u);
  const provider = await readFile(path.resolve('src/provider/KeepseekChatViewProvider.ts'), 'utf8');
  assert.match(provider, /usageDetails: createUsageDetailsViewModel\(/u);
  assert.match(provider, /\.map\(toSubagentProgressViewModel\)/u);
  assert.doesNotMatch(provider, /usageMetrics:\s*\{[^}]*transcript/u);
});

function event(source: UsageSource, totalTokens = 120, currency = 'CNY', cost = 0.01, reported = true) {
  return createUsageEvent({
    usage: { promptTokens: totalTokens - 1, completionTokens: 1, totalTokens,
      cacheHitTokens: reported ? totalTokens - 1 : 0, cacheMissTokens: 0, cacheDataStatus: reported ? 'reported' : 'unavailable' },
    source, sourceId: 'account-a', modelId: 'fixed-small', provider: 'deepseek', currency, cost,
    pricingStatus: currency ? 'priced' : 'unavailable'
  });
}

function run(id: string, status: SubagentTerminalStatus = 'completed', sourceId = 'account-a', modelId = 'fixed-small') {
  return createSubagentRunUsageSummary({
    subagentId: id, parentRunId: 'parent', rootRunId: 'root', depth: 1, profile: 'research', lane: 'research-read',
    status, sourceId, modelId, provider: 'deepseek', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z',
    usage: addUsageEventToTurnStats(undefined, event('subagent'), '2026-01-01T00:00:01.000Z'),
    lastUsageEstimate: { breakdown: {
      systemTokensEstimate: 99999, toolSchemaTokensEstimate: 99999, inputTokensEstimate: 99999,
      historyTokensEstimate: 99999, contextFileTokensEstimate: 99999, outputReserveTokensEstimate: 99999, safetyReserveTokensEstimate: 99999,
      toolCallTokensEstimate: 100, toolResultTokensEstimate: 200, reasoningTokensEstimate: 300
    } } as ContextUsageEstimate
  });
}
