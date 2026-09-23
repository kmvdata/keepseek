import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import {
  getConfiguredAgentSettings,
  getConfiguredAgentContinuationMaxOutputTokens,
  getConfiguredAgentFinalMaxOutputTokens,
  getConfiguredAgentMaxContextEpochRollovers,
  getConfiguredAgentMaxContinuations,
  getConfiguredAgentMaxExecutionMs,
  getConfiguredAgentMaxModelRequests,
  getConfiguredAgentMaxTreeUpstreamTokens,
  getConfiguredAgentRepairMaxOutputTokens,
  getConfiguredAgentToolMaxOutputTokens,
  getConfiguredBalanceEndpointUrl,
  getConfiguredDraftRunMaxTranscriptBytes,
  getConfiguredDraftRunTimeoutMs,
  getConfiguredModelUsagePricing,
  getConfiguredPatchSettings,
  getConfiguredSubagentMaxExecutionMs,
  getConfiguredSubagentMaxUpstreamTokens,
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
    peakCacheHitPrice: 0.04,
    peakInputPrice: 2,
    peakOutputPrice: 8,
    currency: '¥'
  };
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4.1-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-flash'), flashPricing);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-flash-vision-exp'), flashPricing);
  assert.equal(getConfiguredModelUsagePricing('deepseek-v4-flash-0731'), undefined);
  assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-pro'), {
    cacheHitPrice: 0.15,
    inputPrice: 4.5,
    outputPrice: 13.5,
    peakCacheHitPrice: 0.3,
    peakInputPrice: 9,
    peakOutputPrice: 27,
    currency: '¥'
  });
  assert.deepEqual(getConfiguredModelUsagePricing('kimi-k2.7-code'), {
    cacheHitPrice: 1.3,
    inputPrice: 6.5,
    outputPrice: 27,
    currency: '¥'
  });
});

test('usage pricing preserves peak fields and prefers exact custom model IDs before canonical fallback', () => {
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    ...original(),
    get: <T>(key: string, fallback: T): T => key === 'usagePricing' ? ({
      'deepseek-v4.1-flash': {
        cacheHitPrice: 1,
        inputPrice: 2,
        outputPrice: 3,
        peakCacheHitPrice: 4,
        peakInputPrice: 5,
        peakOutputPrice: 6,
        currency: 'CNY'
      },
      'deepseek-flash': {
        inputPrice: 9,
        peakInputPrice: 18
      }
    } as T) : fallback
  });
  try {
    assert.deepEqual(getConfiguredModelUsagePricing('deepseek-v4-flash'), {
      cacheHitPrice: 1,
      inputPrice: 2,
      outputPrice: 3,
      peakCacheHitPrice: 4,
      peakInputPrice: 5,
      peakOutputPrice: 6,
      currency: 'CNY'
    });
    assert.deepEqual(getConfiguredModelUsagePricing('deepseek-flash'), {
      cacheHitPrice: 1,
      inputPrice: 9,
      outputPrice: 3,
      peakCacheHitPrice: 4,
      peakInputPrice: 18,
      peakOutputPrice: 6,
      currency: 'CNY'
    });
  } finally {
    vscode.workspace.getConfiguration = original;
  }
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

test('logical run safety fuses have finite defaults and bounded configuration normalization', () => {
  assert.equal(getConfiguredAgentMaxExecutionMs(), 900_000);
  assert.equal(getConfiguredSubagentMaxExecutionMs(), 300_000);
  assert.equal(getConfiguredAgentMaxModelRequests(), 32);
  assert.equal(getConfiguredAgentMaxModelRequests(true), 12);
  assert.equal(getConfiguredAgentMaxContinuations(), 1);
  assert.equal(getConfiguredAgentMaxContextEpochRollovers(), 3);
  assert.equal(getConfiguredAgentMaxTreeUpstreamTokens(), 2_000_000);
  assert.equal(getConfiguredSubagentMaxUpstreamTokens(), 500_000);
  assert.equal(getConfiguredAgentToolMaxOutputTokens(), 8_192);
  assert.equal(getConfiguredAgentFinalMaxOutputTokens(), 16_384);
  assert.equal(getConfiguredAgentContinuationMaxOutputTokens(), 8_192);
  assert.equal(getConfiguredAgentRepairMaxOutputTokens(), 4_096);

  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    ...original(),
    get: <T>(key: string, fallback: T): T => ({
      'agent.maxModelRequests': 4,
      'agent.subagentMaxModelRequests': 2,
      'agent.maxContinuations': 99,
      'agent.maxContextEpochRollovers': -3,
      'agent.maxTreeUpstreamTokens': 1_000,
      'agent.toolMaxOutputTokens': 256
    }[key] as T | undefined) ?? fallback
  });
  try {
    assert.equal(getConfiguredAgentMaxModelRequests(), 4);
    assert.equal(getConfiguredAgentMaxModelRequests(true), 2);
    assert.equal(getConfiguredAgentMaxContinuations(), 8);
    assert.equal(getConfiguredAgentMaxContextEpochRollovers(), 0);
    assert.equal(getConfiguredAgentMaxTreeUpstreamTokens(), 1_000);
    assert.equal(getConfiguredAgentToolMaxOutputTokens(), 256);
  } finally {
    vscode.workspace.getConfiguration = original;
  }
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
