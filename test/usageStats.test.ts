import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PromptCacheDiagnostics, TurnUsageStats } from '../src/shared/types';
import {
  addTurnUsageToSessionStats,
  addUsageEventToSessionStats,
  calculateCacheHitRate,
  calculateUsageCost,
  createUsageEvent,
  getCacheMissPossibleReasons,
  normalizeBalanceStateValue,
  normalizeDeepSeekUsage,
  normalizeSessionUsageStatsValue
} from '../src/agent/usageStats';

test('normalizes Kimi balance details without breaking legacy total-only records', () => {
  assert.deepEqual(normalizeBalanceStateValue({
    totalBalance: 12.5,
    cashBalance: -1,
    voucherBalance: 13.5,
    currency: '¥',
    isAvailable: true,
    updatedAt: '2026-08-25T00:00:00.000Z'
  }), {
    totalBalance: 12.5,
    cashBalance: -1,
    voucherBalance: 13.5,
    currency: '¥',
    isAvailable: true,
    updatedAt: '2026-08-25T00:00:00.000Z',
    error: undefined
  });
  assert.deepEqual(normalizeBalanceStateValue({ totalBalance: 3, currency: '¥' }), {
    totalBalance: 3,
    cashBalance: undefined,
    voucherBalance: undefined,
    currency: '¥',
    isAvailable: undefined,
    updatedAt: undefined,
    error: undefined
  });
});

test('normalizes DeepSeek cache hit and miss usage fields', () => {
  const usage = normalizeDeepSeekUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cache_hit_tokens: 700,
    prompt_cache_miss_tokens: 300,
    completion_tokens_details: {
      reasoning_tokens: 80
    }
  });

  assert.deepEqual(usage, {
    promptTokens: 1000,
    completionTokens: 200,
    totalTokens: 1200,
    cacheHitTokens: 700,
    cacheMissTokens: 300,
    cacheDataStatus: 'reported',
    reasoningTokens: 80
  });
  assert.equal(calculateCacheHitRate(usage!), 70);
});

test('uses cached_tokens fallback and derives miss tokens', () => {
  const usage = normalizeDeepSeekUsage({
    prompt_tokens: 900,
    completion_tokens: 100,
    prompt_tokens_details: {
      cached_tokens: 450
    }
  });

  assert.deepEqual(usage, {
    promptTokens: 900,
    completionTokens: 100,
    totalTokens: 1000,
    cacheHitTokens: 450,
    cacheMissTokens: 450,
    cacheDataStatus: 'reported'
  });
});

test('uses the Kimi-compatible top-level cached_tokens field for cost accounting', () => {
  assert.deepEqual(normalizeDeepSeekUsage({
    prompt_tokens: 1_000,
    completion_tokens: 100,
    cached_tokens: 600
  }), {
    promptTokens: 1_000,
    completionTokens: 100,
    totalTokens: 1_100,
    cacheHitTokens: 600,
    cacheMissTokens: 400,
    cacheDataStatus: 'reported'
  });
});

test('marks absent provider cache fields unavailable instead of presenting a zero hit rate', () => {
  const usage = normalizeDeepSeekUsage({
    prompt_tokens: 900,
    completion_tokens: 100,
    total_tokens: 1_000
  });
  assert.equal(usage?.cacheDataStatus, 'unavailable');
  assert.equal(usage?.cacheHitTokens, 0);
  assert.equal(usage?.cacheMissTokens, 0);
  assert.equal(calculateCacheHitRate(usage!), undefined);
});

test('calculates turn cost and cumulative average hit rate', () => {
  const rates = {
    cacheHitPrice: 0.02,
    inputPrice: 1,
    outputPrice: 2,
    currency: '¥'
  };
  const firstUsage = normalizeDeepSeekUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 700
  })!;
  const secondUsage = normalizeDeepSeekUsage({
    prompt_tokens: 500,
    completion_tokens: 100,
    prompt_cache_hit_tokens: 100,
    prompt_cache_miss_tokens: 400
  })!;

  assert.equal(calculateUsageCost(firstUsage, rates), 0.000714);

  const firstEvent = createUsageEvent({
    usage: firstUsage,
    cost: calculateUsageCost(firstUsage, rates),
    currency: rates.currency,
    modelId: 'deepseek-v4-flash'
  });
  const secondEvent = createUsageEvent({
    usage: secondUsage,
    cost: calculateUsageCost(secondUsage, rates),
    currency: rates.currency,
    modelId: 'deepseek-v4-flash'
  });
  const stats = addUsageEventToSessionStats(
    addUsageEventToSessionStats(undefined, firstEvent, '2026-01-01T00:00:00.000Z'),
    secondEvent,
    '2026-01-01T00:00:01.000Z'
  );

  assert.equal(stats.requestCount, 2);
  assert.equal(stats.totalTokens, 1800);
  assert.equal(stats.cacheHitTokens, 800);
  assert.equal(stats.cacheMissTokens, 700);
  assert.equal(calculateCacheHitRate(stats), (800 / 1500) * 100);
  assert.equal(stats.sessionCost, 0.001316);
  assert.equal(stats.bySource?.executor?.requestCount, 2);
});

test('classifies hidden calls by source without dropping their cost', () => {
  const event = createUsageEvent({
    usage: {
      promptTokens: 500,
      completionTokens: 100,
      totalTokens: 600,
      cacheHitTokens: 200,
      cacheMissTokens: 300,
      reasoningTokens: 40
    },
    cost: 0.001,
    currency: '¥',
    modelId: 'deepseek-v4-flash',
    source: 'summary'
  });
  const stats = addUsageEventToSessionStats(undefined, event);
  assert.equal(stats.requestCount, 1);
  assert.equal(stats.sessionCost, 0.001);
  assert.equal(stats.bySource?.summary?.promptTokens, 500);
  assert.equal(stats.bySource?.summary?.reasoningTokens, 40);
  assert.equal(stats.bySource?.executor, undefined);
});

test('groups identical model IDs by source and keeps unpriced requests out of accounted cost', () => {
  const usage = {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    cacheHitTokens: 60,
    cacheMissTokens: 40,
    cacheDataStatus: 'reported' as const
  };
  const priced = createUsageEvent({
    usage,
    cost: 0.01,
    currency: '¥',
    sourceId: 'account-a',
    modelId: 'same-model',
    provider: 'deepseek',
    protocol: 'chat-completions',
    pricingStatus: 'priced'
  });
  const unpriced = createUsageEvent({
    usage,
    cost: 0,
    currency: '',
    sourceId: 'account-b',
    modelId: 'same-model',
    provider: 'openai-compatible',
    protocol: 'chat-completions',
    pricingStatus: 'unavailable'
  });
  const stats = addUsageEventToSessionStats(addUsageEventToSessionStats(undefined, priced), unpriced);

  assert.equal(stats.byModelSource?.length, 2);
  assert.equal(stats.byModelSource?.find((group) => group.sourceId === 'account-a')?.pricedRequestCount, 1);
  assert.equal(stats.byModelSource?.find((group) => group.sourceId === 'account-b')?.unpricedRequestCount, 1);
  assert.equal(stats.pricingStatus, 'partial');
  assert.equal(stats.sessionCost, 0.01);
  assert.deepEqual(stats.costByCurrency, { '¥': 0.01 });
});

test('does not add different currencies into one misleading session total', () => {
  const usage = {
    promptTokens: 10,
    completionTokens: 1,
    totalTokens: 11,
    cacheHitTokens: 5,
    cacheMissTokens: 5,
    cacheDataStatus: 'reported' as const
  };
  const yuan = createUsageEvent({ usage, cost: 1, currency: '¥', sourceId: 'a', modelId: 'm', pricingStatus: 'priced' });
  const dollars = createUsageEvent({ usage, cost: 2, currency: '$', sourceId: 'a', modelId: 'm', pricingStatus: 'priced' });
  const stats = addUsageEventToSessionStats(addUsageEventToSessionStats(undefined, yuan), dollars);
  assert.equal(stats.sessionCost, 0);
  assert.equal(stats.currency, '$');
  assert.deepEqual(stats.costByCurrency, { '¥': 1, '$': 2 });
});

test('keeps accounted cost and request attribution when a completed turn has mixed pricing availability', () => {
  const turn: TurnUsageStats = {
    promptTokens: 200,
    completionTokens: 20,
    totalTokens: 220,
    cacheHitTokens: 80,
    cacheMissTokens: 20,
    cacheDataStatus: 'partial',
    requestCount: 2,
    cost: 0.02,
    currency: '¥',
    sourceId: 'account-a',
    modelId: 'same-model',
    provider: 'deepseek',
    protocol: 'chat-completions',
    pricingStatus: 'partial',
    pricedRequestCount: 1,
    unpricedRequestCount: 1,
    cacheDataRequestCount: 1,
    cacheDataMissingRequestCount: 1,
    costByCurrency: { '¥': 0.02 },
    bySource: {
      executor: {
        promptTokens: 200,
        completionTokens: 20,
        totalTokens: 220,
        cacheHitTokens: 80,
        cacheMissTokens: 20,
        cacheDataStatus: 'partial',
        requestCount: 2,
        cost: 0.02,
        pricedRequestCount: 1,
        unpricedRequestCount: 1
      }
    }
  };
  const stats = addTurnUsageToSessionStats(undefined, turn);
  const group = stats.byModelSource?.[0];

  assert.equal(stats.pricingStatus, 'partial');
  assert.equal(stats.sessionCost, 0.02);
  assert.deepEqual(stats.costByCurrency, { '¥': 0.02 });
  assert.equal(stats.pricedRequestCount, 1);
  assert.equal(stats.unpricedRequestCount, 1);
  assert.equal(group?.pricedRequestCount, 1);
  assert.equal(group?.unpricedRequestCount, 1);
  assert.equal(group?.bySource?.executor?.requestCount, 2);
});

test('normalizes old aggregate usage without inventing model attribution', () => {
  const stats = normalizeSessionUsageStatsValue({
    promptTokens: 100,
    completionTokens: 10,
    totalTokens: 110,
    cacheHitTokens: 50,
    cacheMissTokens: 50,
    requestCount: 1,
    sessionCost: 0,
    currency: '¥'
  });
  assert.equal(stats?.legacyUnattributed, true);
  assert.equal(stats?.byModelSource, undefined);
  assert.equal(stats?.pricingStatus, 'unavailable');
});

function createTurnUsage(cacheHitTokens: number, cacheMissTokens: number): TurnUsageStats {
  const promptTokens = cacheHitTokens + cacheMissTokens;
  return {
    promptTokens,
    completionTokens: 0,
    totalTokens: promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    requestCount: 1,
    cost: 0,
    currency: '¥'
  };
}

function createDiagnostics(overrides: Partial<PromptCacheDiagnostics>): PromptCacheDiagnostics {
  return {
    systemPromptHash: 'system-a',
    toolsSchemaHash: 'tools-a',
    historyPrefixHash: 'history-a',
    modelId: 'deepseek-v4-pro',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

test('attributes system/tools schema changes without hit-rate threshold', () => {
  // 命中率仅从 88% 掉到 77%（低于旧门槛 30 点），system 变化仍必须被归因
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({ systemPromptHash: 'system-b' }),
    previousTurnUsage: createTurnUsage(880, 120),
    currentTurnUsage: createTurnUsage(770, 230)
  });
  assert.deepEqual(reasons, ['system_prompt_changed']);
});

test('attributes tools schema change unconditionally', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({ toolsSchemaHash: 'tools-b' }),
    previousTurnUsage: createTurnUsage(900, 100),
    currentTurnUsage: createTurnUsage(700, 300)
  });
  assert.deepEqual(reasons, ['tools_schema_changed']);
});

test('does not report history change when hit rate is stable (append-only is expected)', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({ historyPrefixHash: 'history-b' }),
    previousTurnUsage: createTurnUsage(900, 100),
    currentTurnUsage: createTurnUsage(880, 120)
  });
  assert.deepEqual(reasons, []);
});

test('reports history change when hit rate drops sharply', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({ historyPrefixHash: 'history-b' }),
    previousTurnUsage: createTurnUsage(900, 100),
    currentTurnUsage: createTurnUsage(400, 600)
  });
  assert.deepEqual(reasons, ['history_prefix_changed']);
});

test('reports provider cache eviction when nothing locally changed but hit rate dropped', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({}),
    previousTurnUsage: createTurnUsage(900, 100),
    currentTurnUsage: createTurnUsage(300, 700)
  });
  assert.deepEqual(reasons, ['provider_cache_eviction_possible']);
});

test('attributes source, protocol, and endpoint cache-lane changes independently', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({
      sourceId: 'source-a',
      protocol: 'chat-completions',
      baseUrl: 'https://a.example/v1'
    }),
    diagnostics: createDiagnostics({
      sourceId: 'source-b',
      protocol: 'openai-responses',
      baseUrl: 'https://b.example/v1/responses'
    }),
    previousTurnUsage: undefined,
    currentTurnUsage: undefined
  });
  assert.deepEqual(reasons, ['source_changed', 'protocol_changed', 'endpoint_lane_changed']);
});

test('reports model change, compaction and rewrite reasons directly', () => {
  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: createDiagnostics({}),
    diagnostics: createDiagnostics({
      modelId: 'deepseek-v4-flash',
      historyCompacted: true,
      historyRewriteReason: 'user_edited'
    }),
    previousTurnUsage: createTurnUsage(500, 500),
    currentTurnUsage: createTurnUsage(500, 500)
  });
  assert.deepEqual(reasons, ['model_changed', 'history_compacted', 'history_rewrite:user_edited']);
});
