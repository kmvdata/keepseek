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
import { getVisibleMessages, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ContextUsageEstimate, SubagentSessionUsageStats, SubagentTerminalStatus, UsageSource } from '../src/shared/types';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';

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

test('main-session attribution excludes subagents and does not absorb unclassified history', () => {
  let stats = normalizeSessionUsageStatsValue({
    promptTokens: 80, completionTokens: 20, totalTokens: 100, cacheHitTokens: 0, cacheMissTokens: 0,
    requestCount: 1, sessionCost: 0.25, currency: 'CNY'
  });
  const mainSources: UsageSource[] = ['executor', 'retry', 'continuation', 'summary', 'background', 'retrieval', 'router'];
  for (const source of mainSources) { stats = addUsageEventToSessionStats(stats, event(source, 10, 'CNY', 0.01)); }
  stats = addUsageEventToSessionStats(stats, event('subagent', 30, 'USD', 0.02));
  const split = splitActualUsage(stats);
  assert.equal(split.total.totalTokens, 200);
  assert.equal(split.mainSession.totalTokens, 70);
  assert.equal(split.subagent.totalTokens, 30);
  assert.equal(split.unattributed.totalTokens, 100);
  assert.equal(split.mainSession.requestCount, 7);
  assert.equal(split.subagent.requestCount, 1);
  assert.equal(split.unattributed.requestCount, 1);
  assert.equal(split.mainPercent, 35);
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
  const tooltipRenderer = script.slice(script.indexOf('function renderContextProgress()'), script.indexOf('function getLatestRunState()'));
  assert.doesNotMatch(tooltipRenderer, /usageMetric(?:CacheReasons|CompactThreshold)/u);
  assert.doesNotMatch(tooltipRenderer, /usageMetric(?:UsageGroups|LegacyUnattributed)/u);
  assert.match(tooltipRenderer, /costDisplay\.available \? costDisplay\.amountText/u);
  assert.doesNotMatch(tooltipRenderer, /costDisplay\.available \? costDisplay\.text/u);
  const detailsRenderer = script.slice(script.indexOf('function renderUsageDetails()'), script.indexOf('function createUsageSection('));
  assert.match(detailsRenderer, /usageMetricCacheReasons/u);
  assert.match(detailsRenderer, /usageMetricCompactThreshold/u);
  assert.match(detailsRenderer, /usageSourceModelTitle/u);
  assert.match(detailsRenderer, /usageMetricLegacyUnattributed/u);
  assert.match(detailsRenderer, /var mainSessionOnly = selected\.total\.totalTokens > 0 && selected\.mainPercent >= 100/u);
  assert.match(detailsRenderer, /if \(!mainSessionOnly\) \{\s*cards\.append\(createActualUsageCard\('usageMainSession'/u);
  assert.match(script, /function createSourceModelUsageCard\(group\)/u);
  assert.match(script, /amountText: amountText, text: textValue/u);
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
