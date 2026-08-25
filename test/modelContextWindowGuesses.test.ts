import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getGuessedContextWindowTokens } from '../src/shared/modelContextWindowGuesses';

test('known model families use the centrally documented context-window guesses', () => {
  const cases: Array<[string, number]> = [
    ['meta-llama/Llama-4-Scout-17B-Instruct', 10_000_000],
    ['qwen-long-latest', 10_000_000],
    ['gpt-5.5-2026-08-01', 1_000_000],
    ['gpt-5.4', 1_000_000],
    ['gpt-5.4-mini', 400_000],
    ['gpt-5.2-codex', 400_000],
    ['gpt-4o-2024-11-20', 128_000],
    ['gpt-4-turbo', 128_000],
    ['gpt-4-32k', 32_768],
    ['gpt-4-8k', 8_192],
    ['claude-opus-4.8', 1_000_000],
    ['claude-sonnet-4-6', 1_000_000],
    ['claude-fable-5', 1_000_000],
    ['claude-sonnet-4-5', 200_000],
    ['claude-haiku-4.5', 200_000],
    ['gemini-3.1-pro-preview', 1_048_576],
    ['gemini-3.5-flash', 1_048_576],
    ['gemini-3.6-flash', 1_048_576],
    ['gemini-2.5-pro', 1_048_576],
    ['qwen3.8-max', 1_000_000],
    ['qwen3.5-plus', 1_000_000],
    ['deepseek-v4-flash', 1_000_000],
    ['deepseek-v3.2', 1_000_000],
    ['deepseek-v3.1', 128_000],
    ['glm-5.2', 1_000_000],
    ['glm-5.1', 200_000],
    ['glm-4.7', 200_000],
    ['glm-4.6', 200_000],
    ['kimi-k3', 1_000_000],
    ['kimi-k2.7', 256_000],
    ['kimi-k2.7-code', 256_000],
    ['kimi-k2.6', 256_000],
    ['minimax-m3', 1_000_000],
    ['ernie-4.5', 128_000],
    ['ernie-4.0-turbo', 128_000],
    ['ernie-3.5-turbo', 128_000],
    ['qwen-2.5', 128_000],
    ['qwen-omni-turbo', 32_768]
  ];

  for (const [modelId, expectedTokens] of cases) {
    assert.equal(getGuessedContextWindowTokens(modelId), expectedTokens, modelId);
  }
});

test('unknown and near-miss model IDs do not accidentally inherit a named-family guess', () => {
  assert.equal(getGuessedContextWindowTokens('vendor-model'), undefined);
  assert.equal(getGuessedContextWindowTokens('gpt-4ocean'), undefined);
  assert.equal(getGuessedContextWindowTokens('glm-50'), undefined);
});
