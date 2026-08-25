import './registerVscodeStub';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  DEFAULT_GLM_BASE_URL,
  DEFAULT_KIMI_BASE_URL,
  getDefaultModelSourceBaseUrl,
  getDefaultModelSourceName,
  isModelSourceProvider
} from '../src/accounts/accountStore';
import {
  createModelDiscoveryHeaders,
  getSourceModelsEndpointUrl,
  parseSourceModelsResponse,
  probeSourceConnection
} from '../src/accounts/modelDiscovery';
import {
  isOfficialGlmSource,
  isOfficialKimiSource,
  requiresModelSourceApiKey,
  supportsOfficialBillingSource
} from '../src/accounts/sourceCapabilities';
import { parseKimiBalanceResponse } from '../src/agent/kimi/balance';
import { createProviderClient } from '../src/agent/providers/factory';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getInputScript } from '../src/webview/input/script';
import {
  getNewAccountDialogScript,
  getNewAccountDialogTemplate
} from '../src/webview/input/newAccountDialog';

describe('official Kimi and GLM provider presets', () => {
  it('registers defaults, capabilities, and shared Chat Completions transport', () => {
    assert.equal(isModelSourceProvider('kimi'), true);
    assert.equal(isModelSourceProvider('glm'), true);
    assert.equal(getDefaultModelSourceName('kimi'), 'Kimi');
    assert.equal(getDefaultModelSourceName('glm'), 'GLM');
    assert.equal(getDefaultModelSourceBaseUrl('kimi'), DEFAULT_KIMI_BASE_URL);
    assert.equal(getDefaultModelSourceBaseUrl('glm'), DEFAULT_GLM_BASE_URL);
    assert.ok(createProviderClient('kimi') instanceof OpenAICompatibleClient);
    assert.ok(createProviderClient('glm') instanceof OpenAICompatibleClient);

    const kimi = { provider: 'kimi' as const, baseUrl: DEFAULT_KIMI_BASE_URL };
    const glm = { provider: 'glm' as const, baseUrl: DEFAULT_GLM_BASE_URL };
    assert.equal(isOfficialKimiSource(kimi), true);
    assert.equal(isOfficialKimiSource({ ...kimi, baseUrl: 'https://moonshot-proxy.example/v1' }), false);
    assert.equal(isOfficialGlmSource(glm), true);
    assert.equal(isOfficialGlmSource({ ...glm, baseUrl: 'https://glm-proxy.example/v4' }), false);
    assert.equal(requiresModelSourceApiKey(kimi), true);
    assert.equal(requiresModelSourceApiKey(glm), true);
    assert.equal(supportsOfficialBillingSource(kimi), true);
    assert.equal(supportsOfficialBillingSource(glm), false);
  });

  it('normalizes official model endpoints and parses documented list shapes', () => {
    assert.equal(
      getSourceModelsEndpointUrl('https://api.moonshot.cn/v1/chat/completions', 'kimi'),
      'https://api.moonshot.cn/v1/models'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm'),
      'https://open.bigmodel.cn/api/paas/v4/models'
    );
    assert.deepEqual(createModelDiscoveryHeaders('kimi', 'kimi-key'), {
      Accept: 'application/json',
      Authorization: 'Bearer kimi-key'
    });
    assert.deepEqual(createModelDiscoveryHeaders('glm', 'glm-key'), {
      Accept: 'application/json',
      Authorization: 'Bearer glm-key'
    });
    assert.deepEqual(parseSourceModelsResponse({
      object: 'list',
      data: [{ id: 'kimi-k3', object: 'model', context_length: 1_000_000 }]
    }, 'kimi'), [{ id: 'kimi-k3', contextWindowTokens: 1_000_000 }]);
    assert.deepEqual(parseSourceModelsResponse({
      object: 'list',
      data: [{ id: 'glm-5.2', object: 'model' }]
    }, 'glm'), [{ id: 'glm-5.2' }]);
  });

  it('does not block official chat setup when model discovery has a non-auth failure', async () => {
    for (const source of [
      { provider: 'kimi' as const, apiKey: 'key', baseUrl: DEFAULT_KIMI_BASE_URL },
      { provider: 'glm' as const, apiKey: 'key', baseUrl: DEFAULT_GLM_BASE_URL }
    ]) {
      const unavailable = await probeSourceConnection(source, {
        timeoutMs: 0,
        fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' })
      });
      assert.deepEqual(unavailable, {
        ok: true,
        status: 404,
        modelDiscoveryUnavailable: true
      });
      const unauthorized = await probeSourceConnection(source, {
        timeoutMs: 0,
        fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' })
      });
      assert.equal(unauthorized.ok, false);
      assert.equal(unauthorized.status, 401);
    }
  });

  it('parses the documented Kimi yuan balance while GLM remains non-billing', () => {
    const balance = parseKimiBalanceResponse({
      code: 0,
      status: true,
      data: {
        available_balance: '17.25',
        voucher_balance: '20.00',
        cash_balance: '-2.75'
      }
    });
    assert.deepEqual({ ...balance, updatedAt: undefined }, {
      totalBalance: 17.25,
      cashBalance: -2.75,
      voucherBalance: 20,
      currency: '¥',
      isAvailable: true,
      updatedAt: undefined
    });
    assert.match(balance.updatedAt ?? '', /^\d{4}-\d{2}-\d{2}T/u);
  });

  it('shows both providers, official presets, localized names, and account-list icons', async () => {
    const dialog = getNewAccountDialogTemplate() + getNewAccountDialogScript();
    const settings = getInputScript();
    assert.match(dialog, /value="kimi"/u);
    assert.match(dialog, /value="glm"/u);
    assert.match(dialog, /https:\/\/api\.moonshot\.cn\/v1/u);
    assert.match(dialog, /https:\/\/open\.bigmodel\.cn\/api\/paas\/v4/u);
    assert.match(settings, /t\('kimiOfficial'\)/u);
    assert.match(settings, /t\('glmOfficial'\)/u);
    assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].kimiOfficial, 'Kimi（月之暗面）官方');
    assert.equal(WEBVIEW_TRANSLATIONS.en.glmOfficial, 'GLM (Zhipu) official');

    const resources = path.resolve(process.cwd(), 'resources');
    await access(path.join(resources, 'kimi.svg'));
    await access(path.join(resources, 'glm.svg'));
    assert.match(await readFile(path.join(resources, 'kimi.svg'), 'utf8'), /<title[^>]*>Kimi<\/title>/u);
    assert.match(await readFile(path.join(resources, 'glm.svg'), 'utf8'), /<title[^>]*>GLM<\/title>/u);
  });
});
