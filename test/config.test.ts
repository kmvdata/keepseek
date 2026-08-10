import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getConfiguredAgentSettings,
  getConfiguredBalanceEndpointUrl,
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
