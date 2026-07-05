import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addUsageEventToSessionStats,
  calculateCacheHitRate,
  calculateUsageCost,
  createUsageEvent,
  normalizeDeepSeekUsage
} from '../src/agent/usageStats';

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
    cacheMissTokens: 450
  });
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
});
