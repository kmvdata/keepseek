import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getConfiguredAgentSettings,
  getConfiguredBalanceEndpointUrl,
  getConfiguredDraftRunMaxTranscriptBytes,
  getConfiguredDraftRunTimeoutMs,
  getConfiguredModelUsagePricing,
  getConfiguredPatchSettings,
  normalizeAgentSettings,
  normalizeCompressionThreshold
} from '../src/shared/config';

// vscode stub 的 getConfiguration().get() 总是返回 fallback,
// 因此这些用例覆盖 URL 推导分支(不覆盖 balanceEndpointUrl 配置项)。

test('official DeepSeek baseUrl without version prefix maps to /user/balance', () => {
  assert.equal(
    getConfiguredBalanceEndpointUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/user/balance'
  );
});

test('official DeepSeek baseUrl with /v1 prefix still maps to /user/balance without /v1', () => {
  assert.equal(
    getConfiguredBalanceEndpointUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/user/balance'
  );
});

test('official DeepSeek baseUrl with chat completions path maps to /user/balance', () => {
  assert.equal(
    getConfiguredBalanceEndpointUrl('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/user/balance'
  );
});

test('non-official proxy baseUrl keeps its path prefix', () => {
  assert.equal(
    getConfiguredBalanceEndpointUrl('https://proxy.example.com/v1'),
    'https://proxy.example.com/v1/user/balance'
  );
  assert.equal(
    getConfiguredBalanceEndpointUrl('https://proxy.example.com'),
    'https://proxy.example.com/user/balance'
  );
});

test('compression threshold configuration defaults to balanced and normalizes invalid values', () => {
  assert.equal(getConfiguredAgentSettings().compressionThreshold, 'balanced');
  assert.equal(normalizeCompressionThreshold('aggressive'), 'aggressive');
  assert.equal(normalizeCompressionThreshold('cache'), 'cache');
  assert.equal(normalizeCompressionThreshold('invalid'), 'balanced');
});

test('usage pricing has no unknown-model fallback', () => {
  assert.equal(getConfiguredModelUsagePricing('unknown-vendor-model'), undefined);
  const flashPricing = {
    cacheHitPrice: 0.02,
    inputPrice: 1,
    outputPrice: 4,
    currency: '¥',
    peakCacheHitPrice: 0.04,
    peakInputPrice: 2,
    peakOutputPrice: 8
  };
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4.1-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-pro'), {
    cacheHitPrice: 0.15,
    inputPrice: 4.5,
    outputPrice: 13.5,
    currency: '¥',
    peakCacheHitPrice: 0.3,
    peakInputPrice: 9,
    peakOutputPrice: 27
  });
  assert.deepEqual(getConfiguredModelUsagePricing('kimi-k2.7-code'), {
    cacheHitPrice: 1.3,
    inputPrice: 6.5,
    outputPrice: 27,
    currency: '¥'
  });
});

test('partial agent settings preserve the fallback compression threshold', () => {
  assert.deepEqual(normalizeAgentSettings(
    { thinkingEnabled: false },
    { thinkingEnabled: true, reasoningEffort: 'max', compressionThreshold: 'cache' }
  ), {
    thinkingEnabled: false,
    reasoningEffort: 'max',
    compressionThreshold: 'cache'
  });
});

test('DraftRun uses bounded timeout and transcript defaults', () => {
  assert.equal(getConfiguredDraftRunTimeoutMs(), 120_000);
  assert.equal(getConfiguredDraftRunMaxTranscriptBytes(), 131_072);
});

test('patch limits are independent risk-object defaults rather than maxFileBytes aliases', () => {
  assert.deepEqual(getConfiguredPatchSettings(), {
    maxPayloadBytes: 1_048_576,
    maxHunks: 256,
    maxChangedBytes: 2_097_152,
    maxInlineBytes: 65_536,
    maxProviderBufferBytes: 16_777_216,
    maxBackupBytes: 33_554_432,
    maxChangeSetArtifactBytes: 134_217_728,
    blobStoreQuotaBytes: 1_073_741_824,
    maxDiffBytes: 4_194_304
  });
});
