import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectUsagePricingForDisplay } from '../src/agent/usagePricingProjection';
import type { SessionUsageStats, UsageCostRates } from '../src/shared/types';

const FLASH_RATES: UsageCostRates = {
  cacheHitPrice: 0.02,
  inputPrice: 1,
  outputPrice: 4,
  peakCacheHitPrice: 0.04,
  peakInputPrice: 2,
  peakOutputPrice: 8,
  currency: '¥'
};

test('projects old official deepseek-flash aggregates into display cost', () => {
  const session = createLegacySessionUsage();
  const projected = projectUsagePricingForDisplay({
    sessionUsageStats: session,
    lastTurnUsage: {
      promptTokens: 66_427,
      completionTokens: 4_416,
      totalTokens: 70_843,
      cacheHitTokens: 52_224,
      cacheMissTokens: 14_203,
      cacheDataStatus: 'reported',
      requestCount: 2,
      cost: 0,
      currency: '',
      sourceId: 'default',
      modelId: 'deepseek-flash',
      provider: 'deepseek',
      pricingStatus: 'unavailable',
      pricedRequestCount: 0,
      unpricedRequestCount: 2,
      cacheDataRequestCount: 2,
      cacheDataMissingRequestCount: 0,
      costByCurrency: {},
      updatedAt: '2026-09-17T16:14:13.694Z'
    },
    resolvePricing: ({ sourceId, modelId }) => sourceId === 'default' && modelId === 'deepseek-flash'
      ? FLASH_RATES : undefined
  });

  assert.equal(projected.sessionUsageStats?.pricingStatus, 'priced');
  assert.equal(projected.sessionUsageStats?.pricedRequestCount, 15);
  assert.equal(projected.sessionUsageStats?.unpricedRequestCount, 0);
  assert.deepEqual(projected.sessionUsageStats?.costByCurrency, { '¥': 0.140936 });
  assert.equal(projected.sessionUsageStats?.sessionCost, 0.140936);
  assert.deepEqual(projected.sessionUsageStats?.byModelSource?.[0]?.costByCurrency, { '¥': 0.140936 });
  assert.ok(Math.abs((projected.lastTurnUsage?.costByCurrency?.['¥'] ?? 0) - 0.03291148) < 1e-12);
  assert.equal(session.pricingStatus, 'unavailable', 'display projection must not rewrite persisted accounting');
});

test('leaves unknown or non-official groups unpriced without hiding the official estimate', () => {
  const session = createLegacySessionUsage();
  session.requestCount += 1;
  session.promptTokens += 1_000;
  session.totalTokens += 1_000;
  session.unpricedRequestCount = (session.unpricedRequestCount ?? 0) + 1;
  session.byModelSource?.push({
    promptTokens: 1_000,
    completionTokens: 0,
    totalTokens: 1_000,
    cacheHitTokens: 0,
    cacheMissTokens: 1_000,
    cacheDataStatus: 'reported',
    sourceId: 'proxy',
    modelId: 'unknown-model',
    provider: 'openai-compatible',
    requestCount: 1,
    pricedRequestCount: 0,
    unpricedRequestCount: 1,
    cacheDataRequestCount: 1,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  });

  const projected = projectUsagePricingForDisplay({
    sessionUsageStats: session,
    resolvePricing: ({ sourceId }) => sourceId === 'default' ? FLASH_RATES : undefined
  }).sessionUsageStats;

  assert.equal(projected?.pricingStatus, 'partial');
  assert.equal(projected?.pricedRequestCount, 15);
  assert.equal(projected?.unpricedRequestCount, 1);
  assert.deepEqual(projected?.costByCurrency, { '¥': 0.140936 });
});

test('does not attribute a mixed-model legacy turn entirely to its last official model', () => {
  const session = createLegacySessionUsage();
  session.byModelSource?.push({
    promptTokens: 1_000,
    completionTokens: 0,
    totalTokens: 1_000,
    cacheHitTokens: 0,
    cacheMissTokens: 1_000,
    cacheDataStatus: 'reported',
    sourceId: 'proxy',
    modelId: 'unknown-model',
    provider: 'openai-compatible',
    requestCount: 1,
    pricedRequestCount: 0,
    unpricedRequestCount: 1,
    cacheDataRequestCount: 1,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  });
  const legacyTurn = {
    promptTokens: 2_000,
    completionTokens: 100,
    totalTokens: 2_100,
    cacheHitTokens: 0,
    cacheMissTokens: 2_000,
    cacheDataStatus: 'reported' as const,
    requestCount: 2,
    cost: 0,
    currency: '',
    sourceId: 'default',
    modelId: 'deepseek-flash',
    pricingStatus: 'unavailable' as const,
    pricedRequestCount: 0,
    unpricedRequestCount: 2,
    costByCurrency: {},
    updatedAt: '2026-09-17T16:14:13.694Z'
  };

  const projected = projectUsagePricingForDisplay({
    sessionUsageStats: session,
    lastTurnUsage: legacyTurn,
    resolvePricing: ({ sourceId }) => sourceId === 'default' ? FLASH_RATES : undefined
  });

  assert.equal(projected.lastTurnUsage?.pricingStatus, 'unavailable');
  assert.deepEqual(projected.lastTurnUsage?.costByCurrency, {});
  assert.deepEqual(projected.sessionUsageStats?.costByCurrency, { '¥': 0.140936 });
});

function createLegacySessionUsage(): SessionUsageStats {
  const executor = {
    promptTokens: 244_801,
    completionTokens: 7_645,
    totalTokens: 252_446,
    cacheHitTokens: 203_392,
    cacheMissTokens: 41_409,
    cacheDataStatus: 'reported' as const,
    requestCount: 12,
    cost: 0,
    pricedRequestCount: 0,
    unpricedRequestCount: 12,
    cacheDataRequestCount: 12,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  };
  const continuation = {
    promptTokens: 67_783,
    completionTokens: 5_891,
    totalTokens: 73_674,
    cacheHitTokens: 27_008,
    cacheMissTokens: 40_775,
    cacheDataStatus: 'reported' as const,
    requestCount: 3,
    cost: 0,
    pricedRequestCount: 0,
    unpricedRequestCount: 3,
    cacheDataRequestCount: 3,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {}
  };
  return {
    promptTokens: 312_584,
    completionTokens: 13_536,
    totalTokens: 326_120,
    cacheHitTokens: 230_400,
    cacheMissTokens: 82_184,
    cacheDataStatus: 'reported',
    requestCount: 15,
    sessionCost: 0,
    currency: '',
    pricingStatus: 'unavailable',
    pricedRequestCount: 0,
    unpricedRequestCount: 15,
    cacheDataRequestCount: 15,
    cacheDataMissingRequestCount: 0,
    costByCurrency: {},
    updatedAt: '2026-09-17T16:14:13.694Z',
    byModelSource: [{
      promptTokens: 312_584,
      completionTokens: 13_536,
      totalTokens: 326_120,
      cacheHitTokens: 230_400,
      cacheMissTokens: 82_184,
      cacheDataStatus: 'reported',
      sourceId: 'default',
      modelId: 'deepseek-flash',
      provider: 'deepseek',
      protocol: 'chat-completions',
      requestCount: 15,
      pricedRequestCount: 0,
      unpricedRequestCount: 15,
      cacheDataRequestCount: 15,
      cacheDataMissingRequestCount: 0,
      costByCurrency: {},
      bySource: { executor, continuation }
    }],
    bySource: { executor, continuation }
  };
}
