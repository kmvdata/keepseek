import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEEPSEEK_V4_FLASH_MODEL_ID,
  DEEPSEEK_V4_PRO_MODEL_ID,
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
  assert.ok(proMax.contextCompression.triggerRatio < proHigh.contextCompression.triggerRatio);
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
      assert.ok(compression.summaryBudgetTokens > 0);
    }
  }
});
