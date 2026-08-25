import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPRESSION_THRESHOLDS,
  DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS,
  DEFAULT_GENERIC_MAX_OUTPUT_TOKENS,
  DEEPSEEK_V4_FLASH_MODEL_ID,
  DEEPSEEK_V4_PRO_MODEL_ID,
  getAgentRuntimeProfile,
  getDeepSeekV4ContextCompressionSettings,
  getDeepSeekV4RuntimeProfile,
  getSupportedDeepSeekV4Models
} from '../src/shared/modelProfiles';

test('KeepSeek exposes only DeepSeek V4 Flash and Pro', () => {
  assert.deepEqual(
    getSupportedDeepSeekV4Models().map((model) => model.id),
    [DEEPSEEK_V4_FLASH_MODEL_ID, DEEPSEEK_V4_PRO_MODEL_ID]
  );
});

test('runtime profiles follow model and thinking mode automatically', () => {
  const flashNonThinking = getDeepSeekV4RuntimeProfile(DEEPSEEK_V4_FLASH_MODEL_ID, {
    thinkingEnabled: false,
    reasoningEffort: 'max'
  });
  const flashHigh = getDeepSeekV4RuntimeProfile(DEEPSEEK_V4_FLASH_MODEL_ID, {
    thinkingEnabled: true,
    reasoningEffort: 'high'
  });
  const flashMax = getDeepSeekV4RuntimeProfile(DEEPSEEK_V4_FLASH_MODEL_ID, {
    thinkingEnabled: true,
    reasoningEffort: 'max'
  });
  const proHigh = getDeepSeekV4RuntimeProfile(DEEPSEEK_V4_PRO_MODEL_ID, {
    thinkingEnabled: true,
    reasoningEffort: 'high'
  });
  const proMax = getDeepSeekV4RuntimeProfile(DEEPSEEK_V4_PRO_MODEL_ID, {
    thinkingEnabled: true,
    reasoningEffort: 'max'
  });

  assert.equal(flashNonThinking.reasoningMode, 'non-thinking');
  assert.equal(flashNonThinking.maxTokens, 48_000);
  assert.equal(flashHigh.maxTokens, 96_000);
  assert.equal(flashMax.maxTokens, 192_000);
  assert.equal(proHigh.maxTokens, 128_000);
  assert.equal(proMax.maxTokens, 256_000);
  assert.ok(proMax.maxToolIterations > flashMax.maxToolIterations);
  assert.ok(proMax.contextCompression.summaryBudgetTokens > proHigh.contextCompression.summaryBudgetTokens);
  assert.equal(flashNonThinking.contextCompression.triggerRatio, 0.8);
  assert.equal(flashNonThinking.contextCompression.forceRatio, 0.92);
});

test('generic models use metadata first and never inherit DeepSeek output amplification', () => {
  const unknownHigh = getAgentRuntimeProfile({
    id: 'vendor-model',
    label: 'Vendor model',
    provider: 'openai-compatible'
  }, {
    thinkingEnabled: true,
    reasoningEffort: 'high'
  });
  const unknownMax = getAgentRuntimeProfile({
    id: 'vendor-model',
    label: 'Vendor model',
    provider: 'openai-compatible'
  }, {
    thinkingEnabled: true,
    reasoningEffort: 'max'
  });

  assert.equal(unknownHigh.profileKind, 'generic');
  assert.equal(unknownHigh.contextWindowTokens, DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS);
  assert.equal(unknownHigh.maxTokens, DEFAULT_GENERIC_MAX_OUTPUT_TOKENS);
  assert.equal(unknownMax.maxTokens, unknownHigh.maxTokens);
  assert.ok(unknownMax.contextCompression.summaryBudgetTokens <= unknownMax.maxTokens);
});

test('declared capabilities clamp output and summary budgets to the effective context window', () => {
  const declared = getAgentRuntimeProfile({
    id: 'manual-model',
    label: 'Manual model',
    provider: 'ollama',
    contextWindowTokens: 12_000,
    maxOutputTokens: 20_000
  }, {
    thinkingEnabled: true,
    reasoningEffort: 'max',
    compressionThreshold: 'aggressive'
  });
  assert.equal(declared.contextWindowTokens, 12_000);
  assert.equal(declared.maxTokens, 12_000);
  assert.ok(declared.contextCompression.summaryBudgetTokens <= declared.maxTokens);
  assert.equal(declared.contextCompression.triggerRatio, COMPRESSION_THRESHOLDS.aggressive.triggerRatio);

  const lookalike = getAgentRuntimeProfile({
    id: DEEPSEEK_V4_PRO_MODEL_ID,
    label: 'Lookalike',
    provider: 'openai-compatible'
  }, {
    thinkingEnabled: true,
    reasoningEffort: 'max'
  });
  assert.equal(lookalike.profileKind, 'generic', 'model names never grant DeepSeek capabilities across providers');
  assert.equal(lookalike.maxTokens, DEFAULT_GENERIC_MAX_OUTPUT_TOKENS);
});

test('all runtime profiles keep context compression configured', () => {
  for (const modelId of [DEEPSEEK_V4_FLASH_MODEL_ID, DEEPSEEK_V4_PRO_MODEL_ID]) {
    for (const settings of [
      { thinkingEnabled: false, reasoningEffort: 'high' as const },
      { thinkingEnabled: true, reasoningEffort: 'high' as const },
      { thinkingEnabled: true, reasoningEffort: 'max' as const }
    ]) {
      const compression = getDeepSeekV4RuntimeProfile(modelId, settings).contextCompression;
      assert.ok(compression.keepRecentTurns > 0);
      assert.ok(compression.triggerRatio > compression.softCompactRatio);
      assert.ok(compression.forceRatio > compression.triggerRatio);
      assert.equal(compression.triggerRatio, 0.8);
      assert.equal(compression.forceRatio, 0.92);
      assert.ok(compression.summaryBudgetTokens > 0);
    }
  }
});

test('compression threshold tiers override only the trigger and force ratios', () => {
  const balanced = getDeepSeekV4ContextCompressionSettings(DEEPSEEK_V4_FLASH_MODEL_ID, {
    thinkingEnabled: false,
    reasoningEffort: 'high',
    compressionThreshold: 'balanced'
  });
  const preservedSettings = {
    keepRecentTurns: balanced.keepRecentTurns,
    softCompactRatio: balanced.softCompactRatio,
    toolResultSnipRatio: balanced.toolResultSnipRatio,
    summaryBudgetTokens: balanced.summaryBudgetTokens,
    summaryRequestTimeoutMs: balanced.summaryRequestTimeoutMs
  };

  for (const threshold of ['aggressive', 'balanced', 'cache'] as const) {
    const compression = getDeepSeekV4ContextCompressionSettings(DEEPSEEK_V4_FLASH_MODEL_ID, {
      thinkingEnabled: false,
      reasoningEffort: 'high',
      compressionThreshold: threshold
    });
    assert.deepEqual(
      { triggerRatio: compression.triggerRatio, forceRatio: compression.forceRatio },
      COMPRESSION_THRESHOLDS[threshold]
    );
    assert.ok(compression.forceRatio > compression.triggerRatio);
    assert.deepEqual({
      keepRecentTurns: compression.keepRecentTurns,
      softCompactRatio: compression.softCompactRatio,
      toolResultSnipRatio: compression.toolResultSnipRatio,
      summaryBudgetTokens: compression.summaryBudgetTokens,
      summaryRequestTimeoutMs: compression.summaryRequestTimeoutMs
    }, preservedSettings);
  }
});
