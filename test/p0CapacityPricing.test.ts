import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEEPSEEK_FLASH_CANONICAL_FAMILY,
  DEEPSEEK_FLASH_CANONICAL_MODEL_ID,
  DEEPSEEK_FLASH_PRICING_KEY,
  DEEPSEEK_PRO_CANONICAL_FAMILY,
  getDeepSeekModelIdentity
} from '../src/shared/deepSeekModels';
import {
  migrateContextWindowCalibrationState,
  ToolResultAdmissionController
} from '../src/agent/toolResultAdmission';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot,
  normalizeUsageLedgerValue,
  priceUsageFromSnapshot,
  recalculateUsageLedgerRecordCost,
  repriceUsageLedger,
  summarizeUsageLedger
} from '../src/agent/usageLedger';
import { calculateCacheHitRate } from '../src/agent/usageStats';
import type { ProviderUsageLedger, Usage, UsageCostRates } from '../src/shared/types';

const FLASH_ALIASES = [
  'deepseek-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision-exp'
] as const;

const OFF_PEAK_RATES: UsageCostRates = {
  cacheHitPrice: 0.02,
  inputPrice: 1,
  outputPrice: 4,
  peakCacheHitPrice: 0.04,
  peakInputPrice: 2,
  peakOutputPrice: 8,
  currency: '¥'
};

const REPORTED_USAGE: Usage = {
  promptTokens: 1_000,
  completionTokens: 100,
  totalTokens: 1_100,
  cacheHitTokens: 600,
  cacheMissTokens: 400,
  cacheDataStatus: 'reported'
};

test('explicit Flash aliases share one canonical family, model identity, pricing key and capabilities', () => {
  for (const alias of FLASH_ALIASES) {
    const identity = getDeepSeekModelIdentity(alias);
    assert.equal(identity?.canonicalFamily, DEEPSEEK_FLASH_CANONICAL_FAMILY, alias);
    assert.equal(identity?.canonicalModelId, DEEPSEEK_FLASH_CANONICAL_MODEL_ID, alias);
    assert.equal(identity?.pricingKey, DEEPSEEK_FLASH_PRICING_KEY, alias);
    assert.equal(identity?.contextWindowTokens, 1_048_576, alias);
    assert.equal(identity?.maxOutputTokens, 393_216, alias);
  }
});

test('Pro stays separate and unknown near-match names are not canonicalized', () => {
  assert.equal(getDeepSeekModelIdentity('deepseek-v4-pro')?.canonicalFamily, DEEPSEEK_PRO_CANONICAL_FAMILY);
  assert.equal(getDeepSeekModelIdentity('deepseek-v4-flash-0731'), undefined);
  assert.equal(getDeepSeekModelIdentity('prefix-deepseek-v4-flash'), undefined);
});

test('v1 fallback calibration rebaselines at the current declaration while preserving estimator scale', () => {
  const migrated = migrateContextWindowCalibrationState({
    version: 1,
    declaredWindowTokens: 32_768,
    learnedEffectiveWindowTokens: 32_768,
    estimatorScale: 1.37,
    observations: 7,
    contextTooLongCount: 0
  }, 1_048_576, { identity: DEEPSEEK_FLASH_CANONICAL_MODEL_ID, version: 'identity-v1:1048576' });
  assert.equal(migrated.state.learnedEffectiveWindowTokens, 1_048_576);
  assert.equal(migrated.state.estimatorScale, 1.37);
  assert.equal(migrated.migration?.reason, 'stale_capacity_calibration');
  assert.equal(migrated.state.legacyConservativeCeilingTokens, 32_768);
});

test('v1 Provider context-too-long evidence survives declaration upgrades and clamps on downgrades', () => {
  const upgraded = migrateContextWindowCalibrationState(
    {
      version: 1,
      declaredWindowTokens: 32_768,
      learnedEffectiveWindowTokens: 26_214,
      estimatorScale: 1.2,
      observations: 3,
      contextTooLongCount: 1
    },
    1_048_576,
    { identity: DEEPSEEK_FLASH_CANONICAL_MODEL_ID, version: 'new' }
  ).state;
  assert.equal(upgraded.learnedEffectiveWindowTokens, 26_214);
  assert.equal(upgraded.providerContextTooLongCeilingTokens, 26_214);
  assert.equal(upgraded.contextTooLongCount, 1);
  assert.equal(upgraded.lastAdjustmentSource, 'provider_context_too_long');
  assert.ok(upgraded.learnedEffectiveWindowTokens < 32_768);
  const downgraded = migrateContextWindowCalibrationState(
    { ...upgraded, providerContextTooLongCeilingTokens: 500_000, learnedEffectiveWindowTokens: 500_000 },
    128_000,
    { identity: DEEPSEEK_FLASH_CANONICAL_MODEL_ID, version: 'smaller' }
  ).state;
  assert.equal(downgraded.learnedEffectiveWindowTokens, 128_000);
});

test('successful actual input establishes a floor and stale repair cannot repeat in one state', () => {
  const controller = new ToolResultAdmissionController(1_048_576);
  controller.state.learnedEffectiveWindowTokens = 32_768;
  controller.state.estimatorScale = 1.37;
  const adjustment = controller.recordSuccessfulRequest(40_960);
  assert.equal(adjustment?.reason, 'stale_capacity_calibration');
  assert.equal(controller.state.learnedEffectiveWindowTokens, 1_048_576);
  assert.equal(controller.state.successfulInputFloorTokens, 40_960);
  assert.equal(controller.reconcileSuccessfulFloor(), undefined);
  assert.equal(controller.decide({
    estimatedInputTokens: 30_000,
    configuredMaxOutputTokens: 4_000,
    phase: 'tool',
    remainingBatchResults: 1
  }).shouldRollover, false);
});

test('a later real context-too-long rejection still downshifts prior success evidence', () => {
  const controller = new ToolResultAdmissionController(1_048_576);
  controller.recordSuccessfulRequest(100_000);
  controller.recordContextTooLong(40_000);
  assert.ok(controller.state.learnedEffectiveWindowTokens < 40_000);
  assert.equal(controller.state.lastAdjustmentSource, 'provider_context_too_long');
  assert.equal(controller.decide({
    estimatedInputTokens: 40_000,
    configuredMaxOutputTokens: 4_000,
    phase: 'tool',
    remainingBatchResults: 1
  }).shouldRollover, true);
});

test('request-start snapshots freeze peak/off-peak and rate configuration', () => {
  const peak = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: '2026-09-21T01:30:00.000Z', rates: OFF_PEAK_RATES
  });
  const offPeak = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: '2026-09-21T04:30:00.000Z', rates: OFF_PEAK_RATES
  });
  assert.equal(peak.pricingPeriod, 'peak');
  assert.equal(offPeak.pricingPeriod, 'offPeak');
  assert.equal(peak.inputRate, 2);
  assert.equal(offPeak.inputRate, 1);
  assert.equal(priceUsageFromSnapshot(REPORTED_USAGE, peak).cost,
    (600 * 0.04 + 400 * 2 + 100 * 8) / 1_000_000);
  assert.equal(priceUsageFromSnapshot(REPORTED_USAGE, offPeak).cost,
    (600 * 0.02 + 400 * 1 + 100 * 4) / 1_000_000);

  const changedRates = { ...OFF_PEAK_RATES, inputPrice: 99, outputPrice: 99 };
  const later = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: offPeak.requestStartedAt, rates: changedRates
  });
  assert.notEqual(priceUsageFromSnapshot(REPORTED_USAGE, later).cost,
    priceUsageFromSnapshot(REPORTED_USAGE, offPeak).cost);
  assert.equal(offPeak.inputRate, 1, 'the already-issued request remains frozen');
});

test('missing cache detail is priced as all-miss upper bound without fabricating hit-rate data', () => {
  const usage: Usage = {
    promptTokens: 10_000,
    completionTokens: 1_000,
    totalTokens: 11_000,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheDataStatus: 'unavailable'
  };
  const snapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: '2026-09-21T04:30:00.000Z', rates: OFF_PEAK_RATES
  });
  const result = priceUsageFromSnapshot(usage, snapshot);
  assert.equal(result.pricingStatus, 'estimated_upper_bound');
  assert.equal(result.cost, (10_000 * 1 + 1_000 * 4) / 1_000_000);
  assert.equal(calculateCacheHitRate(usage), undefined);
  assert.equal(usage.cacheMissTokens, 0, 'billing assumptions never overwrite Provider cache telemetry');
});

test('66 physical attempts and 26 usage responses do not become 40 unpriced billing requests', () => {
  const records = [];
  for (let request = 0; request < 26; request += 1) {
    const attemptCount = request === 0 ? 41 : 1;
    const snapshots = Array.from({ length: attemptCount }, (_, attemptIndex) => createUsagePriceSnapshot({
      originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
      protocol: 'chat-completions', supportsBilling: true,
      requestStartedAt: `2026-09-21T04:${String(attemptIndex).padStart(2, '0')}:00.000Z`,
      rates: OFF_PEAK_RATES
    }));
    records.push(...createUsageLedgerRecords({
      requestId: `request-${request}`,
      attempts: snapshots,
      usage: REPORTED_USAGE,
      source: request % 2 ? 'summary' : 'executor'
    }));
  }
  const summary = summarizeUsageLedger({ version: 1, records, legacyAggregate: false, incomplete: false });
  assert.equal(summary.providerAttemptCount, 66);
  assert.equal(summary.usageResponseCount, 26);
  assert.equal(summary.providerAttemptCount - summary.usageResponseCount, 40);
  assert.equal(summary.unpricedRequestCount, 0);
  assert.equal(summary.pricedRequestCount, 26);
});

test('usage without an eligible price remains genuinely unpriced', () => {
  const snapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'proxy', provider: 'openai-compatible',
    protocol: 'chat-completions', supportsBilling: false,
    requestStartedAt: '2026-09-21T04:30:00.000Z'
  });
  const records = createUsageLedgerRecords({
    requestId: 'proxy-1', attempts: [snapshot], usage: REPORTED_USAGE, source: 'executor'
  });
  const summary = summarizeUsageLedger({ version: 1, records, legacyAggregate: false, incomplete: false });
  assert.equal(summary.unpricedRequestCount, 1);
  assert.equal(summary.pricedRequestCount, 0);
  assert.equal(records[0]?.unpricedReason, 'unsupported_source');
});

test('hidden request categories keep the same frozen snapshot and ledger rules', () => {
  const sources = ['summary', 'reviewer', 'subagent', 'background', 'continuation'] as const;
  for (const source of sources) {
    const snapshot = createUsagePriceSnapshot({
      originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
      protocol: 'chat-completions', supportsBilling: true,
      requestStartedAt: '2026-09-21T04:30:00.000Z', rates: OFF_PEAK_RATES
    });
    const [record] = createUsageLedgerRecords({
      requestId: `hidden-${source}`, attempts: [snapshot], usage: REPORTED_USAGE, source
    });
    assert.equal(record?.source, source);
    assert.equal(record?.priceSnapshot.requestStartedAt, '2026-09-21T04:30:00.000Z');
    assert.equal(record?.pricingStatus, 'priced');
  }
});

test('usage ledger serializes, restores, re-summarizes and reprices by request time and canonical key', () => {
  const cnySnapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: '2026-09-21T01:30:00.000Z', rates: OFF_PEAK_RATES
  });
  const usdRates = { ...OFF_PEAK_RATES, currency: '$' };
  const usdSnapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4.1-flash', sourceId: 'other-official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true,
    requestStartedAt: '2026-09-21T04:30:00.000Z', rates: usdRates
  });
  const ledger: ProviderUsageLedger = {
    version: 1,
    records: [
      ...createUsageLedgerRecords({ requestId: 'cny', attempts: [cnySnapshot], usage: REPORTED_USAGE, source: 'reviewer' }),
      ...createUsageLedgerRecords({ requestId: 'usd', attempts: [usdSnapshot], usage: REPORTED_USAGE, source: 'subagent' })
    ],
    legacyAggregate: false,
    incomplete: false
  };
  const restored = normalizeUsageLedgerValue(JSON.parse(JSON.stringify(ledger)));
  assert.deepEqual(restored, ledger);
  const migrated = normalizeUsageLedgerValue({
    ...JSON.parse(JSON.stringify(ledger)),
    version: 0
  });
  assert.equal(migrated?.version, 1);
  assert.equal(migrated?.records.length, 2);
  assert.equal(migrated?.legacyAggregate, true);
  assert.equal(migrated?.incomplete, true);
  const damagedPayload = JSON.parse(JSON.stringify(ledger));
  damagedPayload.records[0].requestStartedAt = 'not-a-time';
  const damaged = normalizeUsageLedgerValue(damagedPayload);
  assert.equal(damaged?.records.length, 1);
  assert.equal(damaged?.incomplete, true);
  assert.equal(damaged?.records[0]?.requestId, 'usd', 'corrupt timestamps are dropped, never replaced with restore time');
  const summary = summarizeUsageLedger(restored);
  assert.deepEqual(Object.keys(summary.costByCurrency).sort(), ['$', '¥']);
  assert.equal(summary.usageResponseCount, 2);
  assert.equal(recalculateUsageLedgerRecordCost(ledger.records[0]!).cost, ledger.records[0]!.cost);

  const repriced = repriceUsageLedger(ledger, {
    priceTableVersion: 'test-price-v2',
    pricingByKey: {
      [DEEPSEEK_FLASH_PRICING_KEY]: { ...OFF_PEAK_RATES, inputPrice: 3, peakInputPrice: 6 }
    }
  });
  assert.ok(repriced.records.every((record) => record.priceSnapshot.priceTableVersion === 'test-price-v2'));
  assert.equal(repriced.records[0]?.priceSnapshot.pricingPeriod, 'peak');
  assert.equal(repriced.records[1]?.priceSnapshot.pricingPeriod, 'offPeak');
});

test('legacy aggregate ledgers stay explicitly incomplete instead of inventing attempt counts', () => {
  const normalized = normalizeUsageLedgerValue({ version: 0, records: [] });
  assert.equal(normalized, undefined);
  const summary = summarizeUsageLedger({ version: 1, records: [], legacyAggregate: true, incomplete: true });
  assert.equal(summary.providerAttemptCount, 0);
  assert.equal(summary.usageResponseCount, 0);
  assert.equal(summary.incomplete, true);
});
