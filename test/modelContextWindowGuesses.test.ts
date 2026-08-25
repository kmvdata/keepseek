import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getGuessedContextWindowTokens,
  getGuessedMaxOutputTokens,
  getKnownNonTextModelKind
} from '../src/shared/modelContextWindowGuesses';

test('known model families use the centrally documented context-window guesses', () => {
  const cases: Array<[string, number]> = [
    ['meta-llama/Llama-4-Scout-17B-Instruct', 10_000_000],
    ['qwen-long-latest', 10_000_000],
    ['gpt-5.5-2026-08-01', 1_000_000],
    ['gpt-5.4', 1_050_000],
    ['gpt-5.4-mini', 400_000],
    ['gpt-5.2-codex', 400_000],
    ['gpt-5-2026-08-01', 400_000],
    ['gpt-4o-2024-11-20', 128_000],
    ['gpt-4-turbo', 128_000],
    ['gpt-4-32k', 32_768],
    ['gpt-4-8k', 8_192],
    ['claude-opus-4.8', 1_000_000],
    ['claude-sonnet-4-6', 1_000_000],
    ['claude-fable-5', 1_000_000],
    ['claude-opus-5', 1_000_000],
    ['claude-5-sonnet', 1_000_000],
    ['claude-sonnet-4-5', 200_000],
    ['claude-haiku-4.5', 200_000],
    ['gemini-3.1-pro-preview', 1_048_576],
    ['gemini-3.5-flash', 1_048_576],
    ['gemini-3.6-flash', 1_000_000],
    ['gemini-3.7-flash', 1_000_000],
    ['gemini-2.5-pro', 1_048_576],
    ['qwen3.8-max', 1_000_000],
    ['qwen3.8-2.4T-A95B', 1_000_000],
    ['qwen3.7-max', 1_000_000],
    ['qwen3.7-plus', 1_000_000],
    ['qwen3.6-flash', 1_000_000],
    ['qwen3.5-plus', 1_000_000],
    ['deepseek-v4-flash', 1_000_000],
    ['deepseek-v3.2', 1_000_000],
    ['deepseek-v3.1', 128_000],
    ['glm-5.2', 1_000_000],
    ['glm-5.3', 1_000_000],
    ['glm-5-turbo', 200_000],
    ['glm-5.1', 200_000],
    ['glm-5', 200_000],
    ['glm-4.7', 200_000],
    ['glm-4.6', 200_000],
    ['glm-4.5', 128_000],
    ['glm-4.5-air', 128_000],
    ['kimi-k3', 1_000_000],
    ['kimi-k2.7', 256_000],
    ['kimi-k2.7-code', 256_000],
    ['kimi-k2.6', 256_000],
    ['kimi-k2.5', 262_144],
    ['minimax-m3', 1_000_000],
    ['MiniMax-M2.5-Lightning', 1_000_000],
    ['hy3', 256_000],
    ['ernie-4.5', 128_000],
    ['ernie-4.0-turbo', 128_000],
    ['ernie-3.5-turbo', 128_000],
    ['qwen-2.5', 128_000],
    ['qwen-omni-turbo', 32_768],
    ['qwen-audio-3.0-realtime-plus', 40_960]
  ];

  for (const [modelId, expectedTokens] of cases) {
    assert.equal(getGuessedContextWindowTokens(modelId), expectedTokens, modelId);
  }
});

test('known model families use centrally documented max-output guesses', () => {
  const cases: Array<[string, number]> = [
    ['gpt-5.4-2026-08-01', 128_000],
    ['gpt-5', 128_000],
    ['gpt-4o-2024-11-20', 16_384],
    ['claude-opus-5', 128_000],
    ['claude-5-sonnet', 128_000],
    ['claude-fable-5', 128_000],
    ['claude-5-fable', 128_000],
    ['gemini-3.6-flash', 65_535],
    ['gemini-3.7-flash', 64_000],
    ['gemini-3.1-pro-preview', 65_535],
    ['gemini-2.5-pro', 65_535],
    ['deepseek-v4-pro', 384_000],
    ['deepseek-v4-flash-0731', 384_000],
    ['qwen3.8-2.4T-A95B', 131_072],
    ['qwen3.8-max', 131_072],
    ['qwen3.7-max', 131_072],
    ['qwen3.7-plus', 131_072],
    ['qwen3.6-flash', 65_536],
    ['qwen-audio-3.0-realtime-plus', 8_192],
    ['glm-5.2', 128_000],
    ['glm-5.3', 128_000],
    ['glm-5-turbo', 128_000],
    ['glm-5.1', 128_000],
    ['glm-5', 128_000],
    ['glm-4.7', 128_000],
    ['glm-4.6', 128_000],
    ['glm-4.5', 96_000],
    ['glm-4.5-air', 96_000],
    ['kimi-k3', 131_072],
    ['minimax-m3', 131_000],
    ['MiniMax-M2.5-Lightning', 8_192]
  ];

  for (const [modelId, expectedTokens] of cases) {
    assert.equal(getGuessedMaxOutputTokens(modelId), expectedTokens, modelId);
  }
});

test('known image and speech resources are classified without invented token limits', () => {
  assert.equal(getKnownNonTextModelKind('wan2.7-image'), 'image-generation');
  assert.equal(getKnownNonTextModelKind('wan2.7-image-pro'), 'image-generation');
  assert.equal(getKnownNonTextModelKind('qwen-audio-3.0-tts-plus'), 'speech-synthesis');
  assert.equal(getKnownNonTextModelKind('qwen-audio-3.0-realtime-plus'), undefined);
  assert.equal(getGuessedContextWindowTokens('wan2.7-image'), undefined);
  assert.equal(getGuessedMaxOutputTokens('qwen-audio-3.0-tts-plus'), undefined);
});

test('models without a published max output do not receive a name guess', () => {
  assert.equal(getGuessedMaxOutputTokens('qwen-long-latest'), undefined);
  assert.equal(getGuessedMaxOutputTokens('kimi-k2.5'), undefined);
  assert.equal(getGuessedMaxOutputTokens('hy3'), undefined);
  assert.equal(getGuessedMaxOutputTokens('vendor-model'), undefined);
});

test('unknown and near-miss model IDs do not accidentally inherit a named-family guess', () => {
  assert.equal(getGuessedContextWindowTokens('vendor-model'), undefined);
  assert.equal(getGuessedContextWindowTokens('gpt-4ocean'), undefined);
  assert.equal(getGuessedContextWindowTokens('glm-50'), undefined);
  assert.equal(getGuessedMaxOutputTokens('gpt-4ocean'), undefined);
  assert.equal(getKnownNonTextModelKind('wan2.7-imagery'), undefined);
});
