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
import { usageBindingsFragment, usageDeclarationFragment, usageRenderFragment } from '../src/webview/input/usage/script';
import { usageFormattersFragment } from '../src/webview/input/usage/formatters';
import { getScript } from '../src/webview/script';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { createProviderCacheObservation } from '../src/agent/cacheObservation';
import { buildReferenceCostView, ReferenceCostIndex } from '../src/agent/usageReferenceCosts';

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
      current: async () => ({ ledger: { version: 1, records, incomplete: false },
        stats: rebuildSessionUsageStatsFromLedger(records), damagedBucketCount: 0 })
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
  const view = buildReferenceCostView({ version: 1, records, incomplete: false }, { subagentUsageStats: subagents });
  const expected = view.session!.sessionCost;
  assert.ok(expected > 0);
  assert.equal(view.subagents?.byModel[0].usage?.cost, expected);
  assert.equal(view.subagents?.byProfileLane[0].usage?.cost, expected);
  assert.equal(view.subagents?.recentRuns[0].usage?.cost, expected);
  assert.equal(JSON.stringify(subagents), original);
});

test('automatic title usage is a labeled subagent subset without tool child tasks', () => {
  const price = createUsagePriceSnapshot({ originalModelId: 'title-model', sourceId: 'title-account', provider: 'qwencloud',
    protocol: 'chat-completions', supportsBilling: false, requestStartedAt: '2026-11-06T00:00:00.000Z' });
  const records = createUsageLedgerRecords({ requestId: 'session_title_fixture', attempts: [price], source: 'subagent',
    usage: event('subagent').usage }).map(record => ({ ...record, purpose: 'session_title' as const }));
  const failed = createUsageLedgerRecords({ requestId: 'session_title_failed', attempts: [price], source: 'subagent' })
    .map(record => ({ ...record, purpose: 'session_title' as const }));
  const all = [...records, ...failed];
  const sessionUsageStats = rebuildSessionUsageStatsFromLedger(all);
  const details = createUsageDetailsViewModel({ sessionUsageStats, subagentLedgerRecords: all });
  assert.equal(details.sessionTitle?.totalTokens, 120);
  assert.equal(details.sessionTitle?.providerAttemptCount, 2);
  assert.equal(details.sessionTitle?.usageResponseCount, 1);
  assert.equal(details.subagents?.totalCount, 0);
  assert.equal(details.subagents?.recentRuns.length, 0);
  assert.equal(details.subagents?.summariesIncomplete, false, 'auxiliary requests need no fabricated child summaries');
  assert.equal(details.subagents?.byModel[0].sourceId, 'title-account');
  for (const language of ['zh-CN', 'en'] as const) {
    const ui = createUsageAnalysisHarness(language, false);
    ui.setSession({ sessionUsageStats, subagentLedgerRecords: all });
    ui.render();
    const note = ui.body.querySelector('.usage-session-title-purpose');
    assert.ok(note?.textContent.includes(WEBVIEW_TRANSLATIONS[language].usageSessionTitlePurpose));
    assert.match(note!.textContent, /120 Tokens/u);
  }
});

test('automatic title reference costs join session totals while preserving the latest main reply', () => {
  const lastUserAt = '2026-11-06T00:00:00.000Z';
  const price = createUsagePriceSnapshot({ originalModelId: 'fixture', sourceId: 'fixture', provider: 'qwencloud',
    protocol: 'chat-completions', supportsBilling: false, requestStartedAt: '2026-11-06T00:00:01.000Z' });
  const main = createUsageLedgerRecords({ requestId: 'main_reply', attempts: [price], source: 'executor', usage: event('executor').usage });
  const title = createUsageLedgerRecords({ requestId: 'session_title_cost', attempts: [price], source: 'subagent', usage: event('subagent').usage })
    .map(record => ({ ...record, purpose: 'session_title' as const }));
  const ledger = (records: typeof main) => ({ version: 1 as const, records, incomplete: false });
  const index = new ReferenceCostIndex();
  const before = buildReferenceCostView(ledger(main), { lastUserAt }, index);
  const after = buildReferenceCostView(ledger([...main, ...title]), { lastUserAt }, index);
  assert.ok(after.session!.sessionCost > before.session!.sessionCost);
  assert.deepEqual(after.turn, before.turn, 'incremental title bookkeeping cannot change the main reply display');
  const restored = buildReferenceCostView(ledger([...main, ...title]), { lastUserAt });
  assert.deepEqual(restored.turn, before.turn, 'restored reference indices use the same boundary');
  assert.equal(restored.session!.bySource?.subagent?.totalTokens, 120);
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
  const durable = { version: 1 as const, records: [first], incomplete: false };
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
  for (const metadata of [{ incomplete: true }]) {
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

test('scalar source costs are not promoted into current currency attribution', () => {
  const incomplete = {
    promptTokens: 100, completionTokens: 20, totalTokens: 120,
    cacheHitTokens: 0, cacheMissTokens: 0, requestCount: 1, cost: 0.5
  };
  const single = normalizeSessionUsageStatsValue({ ...incomplete, sessionCost: 0.5, currency: 'CNY', bySource: { executor: incomplete } })!;
  assert.deepEqual(single.bySource?.executor?.costByCurrency, {});
  assert.equal(single.sessionCost, 0);
  assert.equal(single.bySource?.executor?.cost, 0);
  assert.equal(single.bySource?.executor?.cacheDataRequestCount, 0);
  assert.equal(single.bySource?.executor?.cacheDataMissingRequestCount, 1);
  const mixed = normalizeSessionUsageStatsValue({
    ...incomplete, sessionCost: 0, currency: 'USD', costByCurrency: { CNY: 1, USD: 2 }, bySource: { executor: incomplete }
  })!;
  assert.deepEqual(mixed.bySource?.executor?.costByCurrency, {});
  assert.deepEqual(splitActualUsage(mixed).unattributed.costByCurrency, { CNY: 1, USD: 2 });
});

test('main-session attribution keeps reviewer and subagent calls separate and does not absorb unclassified history', () => {
  let stats = normalizeSessionUsageStatsValue({
    promptTokens: 80, completionTokens: 20, totalTokens: 100, cacheHitTokens: 0, cacheMissTokens: 0,
    requestCount: 1, sessionCost: 0.25, costByCurrency: { CNY: 0.25 }, currency: 'CNY', attemptStatsIncomplete: true
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
  const untrackedChild = addUsageEventToSessionStats(undefined, event('subagent'));
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: untrackedChild }).subagents?.estimatesAvailable, false);
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: untrackedChild }).subagents?.byModel[0].usage.totalTokens, 120);
  assert.equal(createUsageDetailsViewModel({ sessionUsageStats: untrackedChild }).subagents?.byModel[0].taskCountsAvailable, false);
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
  assert.doesNotMatch(script, /function getLatestRunState\(\)/u);
  assert.match(script, /metrics\.executionTime\.currentMs/u);
  assert.doesNotMatch(script, /usageAnalysisMode|data-usage-analysis/u);
  assert.doesNotMatch(script, /data-usage-scope|usageDetailsScope|usageOverviewLabel|usageThisTurn/u);
  const tooltipRenderer = script.slice(script.indexOf('function renderContextProgress()'), script.indexOf('function renderUsageDetails()'));
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
        state: { usageMetrics: { executionTime: {}, isOfficialDeepSeek, sessionUsageStats: { totalTokens: 100 }, turnCount: 1 } },
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
  const labelRenderer = script.slice(script.indexOf('function createUsageMetricLabel('), script.indexOf('function createSubagentAnalysisDetails('));
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
  assert.match(detailsRenderer, /usageSourceTitle/u);
  assert.match(detailsRenderer, /usageTypeTitle/u);
  assert.match(detailsRenderer, /usage-details-eyebrow', t\('usageDetailsTitle'\)/u);
  assert.match(detailsRenderer, /var selected = details\.session/u);
  assert.doesNotMatch(detailsRenderer, /mainPercent >= 100|createUsageSharePanel|createActualAnalysisCard|createUsageAnalysisCard/u);
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

for (const language of ['zh-CN', 'en'] as const) {
  test(`usage sources, types, and expanded subagent details are visible together (${language})`, () => {
    const ui = createUsageAnalysisHarness(language, true);
    ui.render();
    assert.equal(ui.body.querySelector('.usage-segmented-control'), null);
    assert.deepEqual(ui.body.querySelectorAll('.usage-analysis-group-title').map(title => title.textContent),
      [WEBVIEW_TRANSLATIONS[language].usageSourceTitle, WEBVIEW_TRANSLATIONS[language].usageTypeTitle,
        WEBVIEW_TRANSLATIONS[language].usageAnalysisNotesTitle]);
    const sources = ui.body.querySelector('.usage-analysis-source')!;
    const types = ui.body.querySelector('.usage-analysis-type')!;
    assert.equal(sources.attributes['aria-label'], WEBVIEW_TRANSLATIONS[language].usageSourceTitle);
    assert.equal(types.attributes['aria-label'], WEBVIEW_TRANSLATIONS[language].usageTypeTitle);
    assert.deepEqual(sources.querySelectorAll('.usage-source-entry').map(card => card.querySelector('strong')?.textContent),
      ['account-a / fixed-small', 'account-b / child-model']);
    assert.deepEqual(types.children[2].querySelectorAll('.usage-compact-row').map(card => card.querySelector('strong')?.textContent),
      [WEBVIEW_TRANSLATIONS[language].usageMainSession, WEBVIEW_TRANSLATIONS[language].usageSubagentLabel]);
    assert.equal(sources.querySelectorAll('.usage-source-bar').length, 2);
    assert.equal(types.querySelectorAll('.usage-analysis-share').length, 0);

    const details = ui.body.querySelector('details')!;
    assert.ok(details);
    assert.equal(ui.body.querySelectorAll('details').length, 1);
    assert.equal(details.open, true);
    const summary = details.querySelector('summary')!;
    assert.equal(summary.textContent, language === 'zh-CN' ? '子代理明细' : 'Subagent details');
    assert.equal(details.querySelector('.usage-note')?.textContent, WEBVIEW_TRANSLATIONS[language].usageIsolationExplanation);
    assert.equal(details.querySelectorAll('.usage-subagent-group-title').length, 2);
    assert.equal(details.querySelectorAll('.usage-subagent-run').length, 1);
    ui.body.scrollTop = 75;
    summary.focus();
    summary.click();
    ui.render();
    assert.equal(ui.body.querySelector('.usage-analysis-source'), sources, 'interactions and unchanged metrics do not rebuild the analysis');
    assert.equal(ui.body.querySelector('.usage-analysis-type'), types);
    assert.equal(ui.document.activeElement, summary);
    assert.equal(ui.body.scrollTop, 75);
  });
}

test('pure main sessions omit redundant execution totals and empty child sections', () => {
  const empty = createUsageAnalysisHarness('en', false);
  empty.render();
  assert.equal(empty.body.querySelector('.usage-analysis-source')?.querySelectorAll('.usage-source-entry').length, 1);
  assert.equal(empty.body.querySelector('.usage-analysis-type'), null);
  assert.equal(empty.body.querySelector('details'), null);

  const ui = createUsageAnalysisHarness('en', true);
  ui.render();
  ui.body.scrollTop = 75;
  ui.state.usageMetrics = empty.state.usageMetrics;
  ui.render();
  assert.equal(ui.body.querySelector('details'), null);
  assert.equal(ui.body.querySelectorAll('.usage-analysis-group').length, 2);
  assert.equal(ui.body.scrollTop, 75);
});

test('missing source attribution and empty usage do not render empty analysis groups', () => {
  const ui = createUsageAnalysisHarness('en', false);
  ui.state.usageMetrics.sessionUsageStats!.byModelSource = [];
  ui.render();
  assert.ok(ui.body.querySelector('.usage-source-attribution-note'), 'missing source attribution is not silently assigned to the current account');
  assert.equal(ui.body.querySelector('.usage-analysis-type'), null, 'pure main usage needs no duplicate total');

  ui.state.usageMetrics.sessionUsageStats = undefined;
  ui.state.usageMetrics.usageDetails = createUsageDetailsViewModel({});
  ui.render();
  assert.equal(ui.body.querySelectorAll('.usage-analysis-group').length, 1);
  assert.equal(ui.body.querySelector('details'), null);
  assert.equal(ui.body.querySelector('.usage-note')?.textContent, WEBVIEW_TRANSLATIONS.en.usageNoProviderData);

  ui.state.usageMetrics.usageDetails = createUsageDetailsViewModel({ lifecycleIncomplete: true });
  ui.render();
  assert.equal(ui.body.querySelectorAll('.usage-analysis-group').length, 2);
  assert.equal(ui.body.querySelector('details')?.open, true, 'child lifecycle data is visible before Provider usage arrives');
});

test('Escape closes the usage dialog and restores its trigger from expanded analysis', () => {
  const ui = createUsageAnalysisHarness('en', true);
  ui.trigger.focus();
  ui.trigger.click();
  assert.equal(ui.dialog.open, true);
  ui.body.querySelector('summary')!.focus();
  let prevented = false;
  ui.dialog.emit('keydown', { key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation: () => undefined });
  assert.equal(prevented, true);
  assert.equal(ui.dialog.open, false);
  assert.equal(ui.document.activeElement, ui.trigger);
  assert.equal(ui.trigger.attributes['aria-expanded'], 'false');
});

for (const language of ['zh-CN', 'en'] as const) {
  test(`single 8,340 Token main source has one entry, no duplicate total, and one footer (${language})`, () => {
    const ui = createUsageAnalysisHarness(language, false);
    const sample = event('executor', 8340, 'CNY', 0);
    sample.usage.cacheHitTokens = 0;
    sample.usage.cacheMissTokens = 8339;
    sample.sourceId = 'Qwen'; sample.modelId = 'deepseek-v4.1-flash-1017'; sample.provider = 'qwencloud';
    ui.setSession({ sessionUsageStats: usageFixture(sample) });
    ui.state.usageMetrics.isOfficialDeepSeek = false;
    ui.state.usageMetrics.referenceCostSourceIds = ['Qwen'];
    const recorded = JSON.stringify(ui.state.usageMetrics);
    ui.render();
    const source = ui.body.querySelector('.usage-source-entry')!;
    assert.equal(ui.body.querySelectorAll('.usage-source-entry').length, 1);
    assert.equal(ui.body.querySelectorAll('.usage-source-name').length, 1);
    assert.equal(source.querySelector('.usage-source-name')!.textContent, 'Qwen / deepseek-v4.1-flash-1017');
    assert.deepEqual(source.querySelectorAll('.usage-analysis-card-metric').map(metric => metric.querySelector('strong')!.textContent),
      ['8,340', '0.00%', 'CNY0.00']);
    assert.equal(source.querySelector('.usage-token-share')!.textContent, WEBVIEW_TRANSLATIONS[language].usageTokenShare + ': 100%');
    assert.equal(source.querySelector('.usage-source-bar')!.attributes.role, 'meter');
    assert.equal(ui.body.querySelector('.usage-analysis-type'), null);
    assert.equal(ui.body.textContent.includes(WEBVIEW_TRANSLATIONS[language].usageSessionTotal), false);
    assert.equal(ui.body.querySelectorAll('.usage-analysis-coverage').length, 1);
    assert.equal(ui.body.querySelector('.usage-analysis-coverage')!.textContent,
      language === 'en' ? 'Cache data: 1 reported, 0 missing' : '缓存数据：1 次已报告，0 次缺失');
    assert.equal(ui.body.textContent.split(WEBVIEW_TRANSLATIONS[language].usageCurrencyExplanation).length - 1, 1);
    const help = source.querySelector('.usage-cost-help-trigger')!;
    assert.ok(help); help.focus(); help.click(); help.emit('mouseover');
    ui.body.scrollTop = 61; ui.render();
    assert.equal(ui.body.querySelector('.usage-source-entry'), source);
    assert.equal(ui.document.activeElement, help);
    assert.equal(ui.body.scrollTop, 61);
    assert.equal(JSON.stringify(ui.state.usageMetrics), recorded, 'read-only rendering preserves all recorded usage');
  });
}

test('source identities remain distinct and shares use Tokens instead of response counts', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const values = [
    { ...event('executor', 900), sourceId: 'account-a', modelId: 'same' },
    ...Array.from({ length: 8 }, () => ({ ...event('executor', 10), sourceId: 'account-b', modelId: 'same' })),
    { ...event('executor', 20), sourceId: 'account-a', modelId: 'other' }
  ];
  ui.setSession({ sessionUsageStats: usageFixture(...values) }); ui.render();
  const entries = ui.body.querySelectorAll('.usage-source-entry');
  assert.deepEqual(entries.map(entry => entry.querySelector('.usage-source-name')!.textContent),
    ['account-a / same', 'account-b / same', 'account-a / other']);
  assert.deepEqual(entries.map(entry => entry.querySelector('.usage-source-bar')!.attributes['aria-valuenow']), ['90', '8', '2']);
  entries.forEach(entry => {
    assert.equal(entry.querySelectorAll('.usage-source-bar').length, 1);
    assert.equal(entry.querySelectorAll('.usage-analysis-card-metric').length, 3);
  });
  assert.equal(ui.body.querySelector('.usage-analysis-type'), null, 'multiple main sources still need no repeated type total');
});

test('execution rows retain all four responsibilities and use the authoritative coverage total once', () => {
  const ui = createUsageAnalysisHarness('en', true);
  const incomplete = normalizeSessionUsageStatsValue({ ...event('executor', 40).usage, requestCount: 1, sessionCost: 0.01, costByCurrency: { CNY: 0.01 }, currency: 'CNY', attemptStatsIncomplete: true })!;
  const stats = addUsageEventToSessionStats(addUsageEventToSessionStats(addUsageEventToSessionStats(incomplete,
    event('executor', 100)), event('subagent', 200)), event('reviewer', 60));
  ui.setSession({ sessionUsageStats: stats, subagentUsageStats: upsertSubagentRunUsageSummary(undefined, run('scope')) });
  const total = ui.state.usageMetrics.usageDetails.session.total;
  ui.render();
  const types = ui.body.querySelector('.usage-analysis-type')!;
  const rows = types.children[2].children;
  assert.deepEqual(rows.map(row => row.querySelector('.usage-compact-name')!.textContent),
    [WEBVIEW_TRANSLATIONS.en.usageMainSession, WEBVIEW_TRANSLATIONS.en.usageReviewerLabel, WEBVIEW_TRANSLATIONS.en.usageSubagentLabel, WEBVIEW_TRANSLATIONS.en.usageUnattributed]);
  assert.deepEqual(rows.map(row => row.querySelector('.usage-compact-values')!.children[0].textContent),
    ['100 Tokens', '60 Tokens', '200 Tokens', '40 Tokens']);
  assert.ok(types.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageResponsibilityScope));
  assert.equal(ui.body.querySelectorAll('.usage-analysis-coverage').length, 1);
  assert.equal(ui.body.querySelector('.usage-analysis-coverage')!.textContent,
    `Cache data: ${total.cacheDataRequestCount} reported, ${total.cacheDataMissingRequestCount} missing`);
  assert.equal(ui.body.textContent.split(WEBVIEW_TRANSLATIONS.en.usageCurrencyExplanation).length - 1, 1);
});

test('reviewer-only, child-only, and historical-only sessions keep explicit type labels', () => {
  for (const source of ['reviewer', 'subagent', 'history'] as const) {
    const ui = createUsageAnalysisHarness('en', false);
    const stats = usageFixture(event(source === 'history' ? 'executor' : source));
    if (source === 'history') { stats.bySource = undefined; }
    ui.setSession({ sessionUsageStats: stats }); ui.render();
    const type = ui.body.querySelector('.usage-analysis-type')!;
    assert.equal(type.children[2].children.length, 1);
    assert.equal(type.children[2].querySelector('.usage-compact-name')!.textContent,
      source === 'reviewer' ? WEBVIEW_TRANSLATIONS.en.usageReviewerLabel : source === 'subagent' ? WEBVIEW_TRANSLATIONS.en.usageSubagentLabel : WEBVIEW_TRANSLATIONS.en.usageUnattributed);
    assert.equal(ui.body.querySelector('.usage-source-attribution-note'), null,
      'execution attribution is independent from complete per-model source attribution');
  }
});

test('known zero usage, zero costs, and unknown costs are not confused with missing usage', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const zero = event('reviewer', 0, 'CNY', 0);
  zero.usage.promptTokens = 0; zero.usage.completionTokens = 0; zero.usage.cacheHitTokens = 0;
  ui.setSession({ sessionUsageStats: usageFixture(zero) }); ui.render();
  const entry = ui.body.querySelector('.usage-source-entry')!;
  assert.equal(entry.querySelectorAll('.usage-analysis-card-metric')[0].querySelector('strong')!.textContent, '0');
  assert.ok(entry.textContent.includes('CNY0.00'));
  assert.ok(ui.body.querySelector('.usage-analysis-type')!.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageReviewerLabel));
  assert.equal(entry.querySelector('.usage-source-bar')!.attributes['aria-valuenow'], undefined);
  assert.ok(entry.querySelector('.usage-token-share')!.textContent.includes('unavailable'));
  assert.doesNotMatch(ui.body.textContent, /NaN|Infinity|100%/u);
  ui.setSession({ sessionUsageStats: usageFixture(event('executor', 120, '', 0, false)) }); ui.render();
  const unknown = ui.body.querySelector('.usage-source-entry')!;
  assert.ok(unknown.textContent.includes(WEBVIEW_TRANSLATIONS.en.usagePricingUnknownShort));
  assert.equal(unknown.textContent.includes('CNY0.00'), false);
});

test('zero-token reviewer costs and attempts remain visible beside 100% main Tokens', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const stats = usageFixture(event('executor'));
  const details = createUsageDetailsViewModel({ sessionUsageStats: stats });
  details.session.reviewer = { ...details.session.reviewer, costByCurrency: { CNY: 0.25 } };
  ui.state.usageMetrics.usageDetails = details;
  ui.render();
  assert.equal(ui.body.querySelector('.usage-analysis-type')!.children[2].children.length, 2);
  assert.ok(ui.body.querySelector('.usage-analysis-type')!.textContent.includes('CNY0.25'));
  details.session.reviewer.costByCurrency = {};
  details.session.reviewer.providerAttemptCount = 2;
  ui.render();
  assert.ok(ui.body.querySelector('.usage-analysis-type')!.textContent.includes('2 attempts without usage'));
  assert.ok(ui.body.querySelector('.usage-analysis-type')!.textContent.includes('not reported'));
});

test('source-only attempts stay visible without inventing token shares or response coverage', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const price = createUsagePriceSnapshot({ originalModelId: 'failed-model', sourceId: 'failed-account', provider: 'qwencloud',
    protocol: 'chat_completions', supportsBilling: false });
  const stats = rebuildSessionUsageStatsFromLedger(createUsageLedgerRecords({ requestId: 'failed-only', attempts: [price], source: 'reviewer' }))!;
  // Source groups in some host views carry attempt telemetry even before usage.
  stats.byModelSource = [{ ...stats, sourceId: 'failed-account', modelId: 'failed-model', provider: 'qwencloud',
    pricedRequestCount: 0, unpricedRequestCount: 0, cacheDataRequestCount: 0, cacheDataMissingRequestCount: 0 }];
  ui.setSession({ sessionUsageStats: stats }); ui.render();
  assert.equal(ui.body.querySelectorAll('.usage-source-entry').length, 1);
  const entry = ui.body.querySelector('.usage-source-entry')!;
  assert.ok(entry.textContent.includes('Usage not reported'));
  assert.equal(entry.querySelector('.usage-source-bar')!.children.length, 0);
  assert.equal(ui.body.querySelector('.usage-analysis-coverage')!.textContent, WEBVIEW_TRANSLATIONS.en.usageCacheCoverageUnknown);
  assert.doesNotMatch(ui.body.textContent, /NaN|Infinity|100%|0 missing/u);
});

test('partial historical source attribution and missing identity are explicit without reassigning history', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const stats = usageFixture(event('executor', 100), { ...event('executor', 900), sourceId: 'old' });
  stats.byModelSource = stats.byModelSource!.slice(0, 1);
  ui.setSession({ sessionUsageStats: stats }); ui.render();
  assert.ok(ui.body.querySelector('.usage-source-attribution-note'));
  assert.equal(ui.body.querySelector('.usage-source-bar')!.attributes['aria-valuenow'], '100', 'denominator covers attributed sources only');
  assert.equal(ui.body.querySelector('.usage-analysis-type'), null, 'source gaps do not imply execution-type gaps');
  stats.byModelSource![0].sourceId = '';
  ui.setSession({ sessionUsageStats: stats }); ui.render();
  assert.ok(ui.body.querySelector('.usage-source-name')!.textContent.includes('Source unknown'));
  assert.ok(ui.body.querySelector('.usage-source-attribution-note'));
});

test('child-only sources use a role marker; mixed sources keep a subset; mismatches retain fallback evidence', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const child = run('child-role');
  const summaries = upsertSubagentRunUsageSummary(undefined, child);
  const stats = usageFixture(event('subagent'));
  ui.setSession({ sessionUsageStats: stats, subagentUsageStats: summaries }); ui.render();
  const entry = ui.body.querySelector('.usage-source-entry')!;
  assert.ok(entry.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageSourceSubagentOnly));
  assert.equal(entry.querySelectorAll('.usage-analysis-card-metric').length, 3);
  assert.equal(entry.textContent.split('120').length - 1, 1, 'entire child source does not repeat its Tokens');
  assert.equal(ui.body.querySelector('.usage-subagent-model-fallback'), null);
  assert.ok(ui.body.querySelector('.usage-subagent-run'), 'task records are a different granularity');
  const mixed = usageFixture(event('executor', 360), event('subagent'));
  ui.setSession({ sessionUsageStats: mixed, subagentUsageStats: summaries }); ui.render();
  assert.ok(ui.body.querySelector('.usage-source-subagent')!.textContent.includes('120 Tokens'));
  assert.ok(ui.body.querySelector('.usage-source-subagent')!.textContent.includes('Of which subagents'));
  assert.equal(ui.body.querySelector('.usage-subagent-model-fallback'), null);
  delete mixed.byModelSource![0].bySource;
  ui.setSession({ sessionUsageStats: mixed, subagentUsageStats: summaries }); ui.render();
  assert.ok(ui.body.querySelector('.usage-subagent-model-fallback')!.textContent.includes('120 Tokens'));
  assert.ok(ui.body.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageSubagentSourceFallback));
  mixed.byModelSource![0].bySource = { subagent: { ...stats.bySource!.subagent!, providerAttemptCount: 1, usageResponseCount: 1 } };
  mixed.byModelSource![0].provider = 'other-provider';
  ui.setSession({ sessionUsageStats: mixed, subagentUsageStats: summaries }); ui.render();
  assert.ok(ui.body.querySelector('.usage-subagent-model-fallback'), 'provider mismatch cannot erase another model group');
});

test('subagent cache slices survive merging and fallback without borrowing the overall source rate', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const child = event('subagent', 120);
  child.usage.cacheHitTokens = 0; child.usage.cacheMissTokens = 119;
  const summary = { ...run('cache-slice'), usage: addUsageEventToTurnStats(undefined, child) };
  const stats = usageFixture(event('executor', 360), child);
  const summaries = upsertSubagentRunUsageSummary(undefined, summary);
  ui.setSession({ sessionUsageStats: stats, subagentUsageStats: summaries }); ui.render();
  const source = ui.body.querySelector('.usage-source-entry')!;
  assert.equal(source.querySelectorAll('.usage-analysis-card-metric')[1].querySelector('strong')!.textContent, '75.10%');
  assert.ok(source.querySelector('.usage-source-subagent')!.textContent.includes('Cache hit rate: 0.00%'));
  assert.equal(ui.body.querySelector('.usage-subagent-model-fallback'), null);
  delete stats.byModelSource![0].bySource;
  ui.setSession({ sessionUsageStats: stats, subagentUsageStats: summaries }); ui.render();
  assert.equal(ui.body.querySelector('.usage-subagent-model-fallback')!.querySelector('.usage-slice-cache')!.textContent,
    'Cache hit rate: 0.00%');
  assert.ok(ui.body.querySelector('details')!.querySelectorAll('.usage-slice-cache').length >= 2,
    'model and profile/lane slices keep their own cache evidence');
});

test('multiple child levels preserve task counts, local anomalies, and a single authoritative footer', () => {
  const ui = createUsageAnalysisHarness('en', true);
  const first = run('multi-one');
  const second = { ...run('multi-two', 'failed', 'account-b', 'child-model'), profile: 'review', lane: 'review-read' };
  const summaries = upsertSubagentRunUsageSummary(upsertSubagentRunUsageSummary(undefined, first), second);
  const stats = usageFixture(event('executor'), event('subagent'),
    { ...event('subagent'), sourceId: 'account-b', modelId: 'child-model' },
    { ...event('reviewer', 50, '', 0, false), sourceId: 'unpriced', modelId: 'unknown' },
    { ...event('executor', 100, '', 0, false), sourceId: 'partial', modelId: 'partial' },
    { ...event('executor', 300), sourceId: 'partial', modelId: 'partial' });
  ui.setSession({ sessionUsageStats: stats, subagentUsageStats: summaries }); ui.render();
  const sourceEntries = ui.body.querySelectorAll('.usage-source-entry');
  assert.equal(sourceEntries[0].textContent.includes('Cache fields missing'), false);
  assert.ok(sourceEntries.find(entry => entry.textContent.includes('unpriced / unknown'))!.textContent.includes('Cost unknown'));
  const partial = sourceEntries.find(entry => entry.textContent.includes('partial / partial'))!;
  assert.ok(partial.textContent.includes('Partially priced (1 unpriced)'));
  assert.ok(partial.textContent.includes('Cache fields missing (1 usage responses)'));
  assert.equal(ui.body.querySelectorAll('.usage-subagent-run').length, 2);
  const subdetails = ui.body.querySelector('details')!;
  assert.ok(subdetails.textContent.includes('Tasks: 2'));
  assert.ok(subdetails.textContent.includes('Review and verification') || subdetails.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageProfileReview));
  assert.equal(ui.body.querySelectorAll('.usage-analysis-coverage').length, 1);
  assert.equal(ui.body.querySelector('.usage-analysis-coverage')!.textContent, 'Cache data: 4 reported, 2 missing');
  for (const key of ['usageCurrencyExplanation', 'usageSubagentPrivacy', 'usageEstimateDisclaimer', 'usageIsolationExplanation']) {
    assert.equal(ui.body.textContent.split(WEBVIEW_TRANSLATIONS.en[key]).length - 1, 1, key);
  }
});

test('child lifecycle remains visible before usage, including queue, reuse, and interrupted recovery', () => {
  const ui = createUsageAnalysisHarness('en', false);
  ui.setSession({ subagentActivities: [
    { id: 'queued-child', parentRunId: 'parent', parentSessionId: 'session', rootRunId: 'root', treeId: 'tree', profile: 'research', lane: 'research-read',
      status: 'queued', updatedAt: '', sourceId: 'account-a', modelId: 'fixed-small', provider: 'deepseek' },
    { id: 'running-child', parentRunId: 'parent', parentSessionId: 'session', rootRunId: 'root', treeId: 'tree', profile: 'review', lane: 'review-read',
      status: 'running', updatedAt: '', reused: true, interrupted: true }
  ], observedInvocations: { delegate: 2, parallel: 1, readResult: 0 } });
  const before = JSON.stringify(ui.state.usageMetrics); ui.render();
  const details = ui.body.querySelector('details')!;
  assert.equal(details.open, true);
  assert.ok(details.textContent.includes('Queued 1'));
  assert.ok(details.textContent.includes('Running 1'));
  assert.ok(details.textContent.includes('Reused 1'));
  assert.ok(details.textContent.includes('Interrupted 1'));
  assert.ok(details.textContent.includes('Usage not reported'));
  assert.equal(details.textContent.includes('0 Tokens'), false, 'unreported child usage is never invented zero consumption');
  assert.ok(details.textContent.includes(WEBVIEW_TRANSLATIONS.en.usageSubagentReconciliationPending));
  assert.equal(JSON.stringify(ui.state.usageMetrics), before);
});

test('historical unknown cache counts are not confirmed as zero missing; observed diagnostics have a separate scope', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const stats = usageFixture(event('executor'));
  ui.setSession({ sessionUsageStats: stats });
  const total = ui.state.usageMetrics.usageDetails.session.total;
  total.cacheDataRequestCount = 0; total.cacheDataMissingRequestCount = 0;
  ui.render();
  assert.equal(ui.body.querySelector('.usage-analysis-coverage')!.textContent, WEBVIEW_TRANSLATIONS.en.usageCacheCoverageUnknown);
  assert.doesNotMatch(ui.body.querySelector('.usage-analysis-coverage')!.textContent, /0 missing/u);
  assert.match(usageRenderFragment.source, /usageDiagnosticCacheCoverage/u);
  assert.notEqual(WEBVIEW_TRANSLATIONS.en.usageDiagnosticCacheCoverage, WEBVIEW_TRANSLATIONS.en.usageCacheCoverage);
});

test('official and reference sources keep per-source hints, currencies, truncation, and partial cost states', () => {
  const ui = createUsageAnalysisHarness('en', false);
  const stats = usageFixture(
    { ...event('executor', 100, 'CNY', 12.239), sourceId: 'official' },
    { ...event('executor', 300, 'USD', 2.999), sourceId: 'proxy' },
    { ...event('executor', 200, 'CNY', 0.009), sourceId: 'proxy' },
    { ...event('executor', 50, '', 0, false), sourceId: 'proxy' });
  ui.setSession({ sessionUsageStats: stats });
  ui.state.usageMetrics.referenceCostSourceIds = ['proxy'];
  const original = JSON.stringify(stats); ui.render();
  const [official, proxy] = ui.body.querySelectorAll('.usage-source-entry');
  assert.equal(official.querySelector('.usage-cost-help-trigger'), null);
  assert.equal(proxy.querySelectorAll('.usage-cost-help-trigger').length, 1);
  assert.ok(official.textContent.includes('CNY12.23'));
  assert.ok(proxy.textContent.includes('USD2.99 · CNY0.00'));
  assert.ok(proxy.textContent.includes('Partially priced'));
  assert.equal(official.textContent.includes('Partially priced'), false);
  assert.equal(JSON.stringify(stats), original);
});

function createUsageAnalysisHarness(language: 'zh-CN' | 'en', withSubagents: boolean) {
  class UsageElement {
    dataset: Record<string, string> = {};
    attributes: Record<string, string> = {};
    children: UsageElement[] = [];
    parent: UsageElement | null = null;
    className = '';
    private ownText = '';
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set textContent(value: string) { this.ownText = value; this.children = []; }
    style: Record<string, string> = {};
    open = false;
    isConnected = true;
    scrollTop = 0;
    listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    constructor(public tagName: string) {}
    append(...children: UsageElement[]): void {
      children.forEach(child => { child.parent = this; this.children.push(child); });
    }
    replaceChildren(): void { this.children.forEach(child => { child.parent = null; }); this.children = []; }
    setAttribute(name: string, value: string): void { this.attributes[name] = value; }
    matches(selector: string): boolean {
      if (selector.startsWith('.')) { return this.className.split(' ').includes(selector.slice(1)); }
      return this.tagName === selector;
    }
    querySelectorAll(selector: string): UsageElement[] {
      return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector: string): UsageElement | null { return this.querySelectorAll(selector)[0] ?? null; }
    focus(): void { document.activeElement = this; }
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, event: Record<string, unknown> = {}): void {
      this.listeners.get(type)?.forEach(listener => listener({ target: this, ...event }));
      if (this.parent) { this.parent.emit(type, { target: this, ...event }); }
    }
    click(): void { this.emit('click'); }
    showModal(): void { this.open = true; }
    close(): void { this.open = false; this.emit('close'); }
  }
  const nodes: Record<string, UsageElement> = {
    contextProgress: new UsageElement('button'), usageDetailsBody: new UsageElement('div'),
    usageDetailsDialog: new UsageElement('dialog'), usageDetailsClose: new UsageElement('button')
  };
  const document = {
    activeElement: null as UsageElement | null,
    getElementById: (id: string) => nodes[id] ?? null,
    createElement: (tag: string) => new UsageElement(tag),
    createTextNode: (text: string) => { const node = new UsageElement('#text'); node.textContent = text; return node; }
  };
  const sessionUsageStats = usageFixture(event('executor'), ...(withSubagents
    ? [{ ...event('subagent'), sourceId: 'account-b', modelId: 'child-model' }] : []));
  const state = { usageMetrics: {
    isOfficialDeepSeek: true, referenceCostSourceIds: [] as string[],
    sessionUsageStats: sessionUsageStats as typeof sessionUsageStats | undefined,
    usageDetails: createUsageDetailsViewModel({ sessionUsageStats,
      subagentUsageStats: withSubagents
        ? upsertSubagentRunUsageSummary(undefined, run('ui-child', 'completed', 'account-b', 'child-model')) : undefined })
  } };
  const env = {
    document, state, getLanguage: () => language,
    t: (key: string, values: Record<string, string | number> = {}) => (WEBVIEW_TRANSLATIONS[language][key] ?? key)
      .replace(/\{(\w+)\}/gu, (_, name: string) => String(values[name] ?? '')),
    closeCommandMenu: () => undefined, closeReferenceMenu: () => undefined,
    findModelForSelection: () => undefined, formatDuration: (ms: number) => String(ms)
  };
  const api = new Function(...Object.keys(env), [
    usageDeclarationFragment.source, usageRenderFragment.source, usageFormattersFragment.source,
    // Keep the real analysis, rendering cache, and event handlers; unrelated metric panels are outside this fixture.
    "createContextWindowSection = createSessionMetricsSection = createCacheDiagnosticsSection = function() { return usageNode('section', 'fixture-metrics'); };",
    usageBindingsFragment.source, 'return { render: renderUsageDetails };'
  ].join('\n'))(...Object.values(env)) as { render(): void };
  const setSession = (input: Parameters<typeof createUsageDetailsViewModel>[0]) => {
    state.usageMetrics.sessionUsageStats = input.sessionUsageStats;
    state.usageMetrics.usageDetails = createUsageDetailsViewModel(input);
  };
  return { ...api, setSession, state, document, body: nodes.usageDetailsBody, trigger: nodes.contextProgress, dialog: nodes.usageDetailsDialog };
}

// Events carry usage; per-source physical attempt counts are supplied by the
// ledger summary in production. Keep the fixture's two inputs consistent.
function usageFixture(...events: ReturnType<typeof event>[]) {
  let stats;
  const counts: NonNullable<ReturnType<typeof summarizeUsageLedger>['bySourceCounts']> = {};
  for (const value of events) {
    stats = addUsageEventToSessionStats(stats, value);
    const count = counts[value.source] ?? { providerAttemptCount: 0, usageResponseCount: 0 };
    counts[value.source] = { providerAttemptCount: count.providerAttemptCount + 1, usageResponseCount: count.usageResponseCount + 1 };
  }
  return applyUsageLedgerSummaryToSessionStats(stats, { ...summarizeUsageLedger(undefined),
    incomplete: false, providerAttemptCount: events.length, usageResponseCount: events.length,
    bySourceCounts: counts })!;
}

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
