import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { saveModelRequestTimeout } from '../src/provider/requestTimeoutSettings';
import {
  getConfiguredAgentSettings,
  getConfiguredAgentContinuationMaxOutputTokens,
  getConfiguredAgentFinalMaxOutputTokens,
  getConfiguredAgentMaxContextEpochRollovers,
  getConfiguredAgentMaxContinuations,
  getConfiguredAgentMaxExecutionMs,
  getConfiguredAgentMaxModelRequests,
  getConfiguredAgentMaxToolCalls,
  getConfiguredAgentMaxToolIterations,
  getConfiguredAgentMaxTreeUpstreamTokens,
  getConfiguredAgentRepairMaxOutputTokens,
  getConfiguredAgentToolMaxOutputTokens,
  getConfiguredBalanceEndpointUrl,
  getConfiguredDraftRunMaxTranscriptBytes,
  getConfiguredDraftRunTimeoutMs,
  getConfiguredModelUsagePricing,
  getConfiguredModelRequestTimeoutMs,
  MODEL_REQUEST_TIMEOUT_PRESETS,
  getConfiguredPatchSettings,
  getConfiguredSubagentMaxExecutionMs,
  getConfiguredSubagentHandoffPreviewBytes,
  getConfiguredSubagentParallelHandoffBytes,
  getConfiguredSubagentMaxUpstreamTokens,
  normalizeAgentSettings,
  normalizeCompressionThreshold
} from '../src/shared/config';

test('model timeout accepts only the six shared presets and normalizes legacy values to one hour', () => {
  assert.equal(getConfiguredModelRequestTimeoutMs(), 3_600_000);
  assert.deepEqual(MODEL_REQUEST_TIMEOUT_PRESETS.map((preset) => preset.seconds), [300, 900, 3600, 7200, 28800, 86400]);
  const original = vscode.workspace.getConfiguration;
  let value: unknown;
  vscode.workspace.getConfiguration = () => ({
    ...original(),
    inspect: () => ({ globalValue: value, workspaceValue: 300, defaultValue: 3600 })
  });
  try {
    for (const seconds of [300, 900, 3600, 7200, 28800, 86400]) {
      value = seconds;
      assert.equal(getConfiguredModelRequestTimeoutMs(), seconds * 1000);
    }
    for (const invalid of [undefined, null, '7200', true, 120, 0, -1, 5.9, 600, NaN, Infinity, 1e10]) {
      value = invalid;
      assert.equal(getConfiguredModelRequestTimeoutMs(), 3_600_000, String(invalid));
    }
  } finally {
    vscode.workspace.getConfiguration = original;
  }
});

test('timeout changes save presets globally and reject arbitrary or malformed messages without writes', async () => {
  const originalConfig = vscode.workspace.getConfiguration;
  const writes: unknown[][] = [];
  let saved = 3600;
  let fail = false;
  vscode.workspace.getConfiguration = () => ({
    ...originalConfig(),
    inspect: () => ({ globalValue: saved }),
    update: async (...args: unknown[]) => {
      if (fail) throw new Error('settings unavailable');
      writes.push(args);
      saved = args[1] as number;
    }
  });
  try {
    for (const seconds of [300, 900, 3600, 7200, 28800, 86400]) {
      assert.equal(await saveModelRequestTimeout(seconds), true);
      assert.deepEqual(writes.at(-1), ['modelRequestTimeoutSeconds', seconds, vscode.ConfigurationTarget.Global]);
      assert.equal(getConfiguredModelRequestTimeoutMs(), seconds * 1000);
    }
    for (const invalid of [undefined, null, '7200', true, 120, 0, -1, 5.9, 600, NaN, Infinity, 1e10]) {
      assert.equal(await saveModelRequestTimeout(invalid), false);
    }
    assert.equal(writes.length, 6);
    fail = true;
    await assert.rejects(saveModelRequestTimeout(7200), /settings unavailable/u);
    assert.equal(getConfiguredModelRequestTimeoutMs(), 86_400_000);
  } finally {
    vscode.workspace.getConfiguration = originalConfig;
  }
});

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

test('known DeepSeek reference prices ignore stale overrides while custom models remain configurable', () => {
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    ...original(),
    get: <T>(key: string, fallback: T): T => key === 'usagePricing' ? ({
      'deepseek-v4.1-flash': { inputPrice: 99, currency: 'USD' },
      'deepseek-flash': { inputPrice: 88 },
      'custom-model': { cacheHitPrice: 1, inputPrice: 2, outputPrice: 3, currency: '$' }
    } as T) : fallback
  });
  try {
    for (const alias of ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4.1-flash-1017']) {
      assert.deepEqual(getConfiguredModelUsagePricing(alias), {
        cacheHitPrice: 0.02, inputPrice: 1, outputPrice: 4,
        peakCacheHitPrice: 0.04, peakInputPrice: 2, peakOutputPrice: 8, currency: '¥'
      });
    }
    assert.equal(getConfiguredModelUsagePricing('custom-model')?.inputPrice, 2);
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

test('root execution budgets default to unlimited while child safety budgets stay finite', () => {
  assert.equal(getConfiguredAgentMaxExecutionMs(), 0);
  assert.equal(getConfiguredSubagentMaxExecutionMs(), 300_000);
  assert.equal(getConfiguredSubagentHandoffPreviewBytes(), 10_240);
  assert.equal(getConfiguredSubagentParallelHandoffBytes(), 20_480);
  assert.equal(getConfiguredAgentMaxToolIterations(), 0);
  assert.equal(getConfiguredAgentMaxToolCalls(), 0);
  assert.equal(getConfiguredAgentMaxModelRequests(), 0);
  assert.equal(getConfiguredAgentMaxModelRequests(true), 12);
  assert.equal(getConfiguredAgentMaxContinuations(), 1);
  assert.equal(getConfiguredAgentMaxContextEpochRollovers(), 0);
  assert.equal(getConfiguredAgentMaxTreeUpstreamTokens(), 0);
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
      'agent.maxToolIterations': 3,
      'agent.maxToolCalls': 7,
      'agent.subagentMaxModelRequests': 2,
      'agent.maxContinuations': 99,
      'agent.maxContextEpochRollovers': -3,
      'agent.maxTreeUpstreamTokens': 1_000,
      'agent.toolMaxOutputTokens': 256,
      'subagent.handoffPreviewBytes': 99_999,
      'subagent.parallelHandoffBytes': 1
    }[key] as T | undefined) ?? fallback
  });
  try {
    assert.equal(getConfiguredAgentMaxModelRequests(), 4);
    assert.equal(getConfiguredAgentMaxToolIterations(), 3);
    assert.equal(getConfiguredAgentMaxToolCalls(), 7);
    assert.equal(getConfiguredAgentMaxModelRequests(true), 2);
    assert.equal(getConfiguredAgentMaxContinuations(), 8);
    assert.equal(getConfiguredAgentMaxContextEpochRollovers(), 0);
    assert.equal(getConfiguredAgentMaxTreeUpstreamTokens(), 1_000);
    assert.equal(getConfiguredAgentToolMaxOutputTokens(), 256);
    assert.equal(getConfiguredSubagentHandoffPreviewBytes(), 24_576);
    assert.equal(getConfiguredSubagentParallelHandoffBytes(), 16_384);
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
