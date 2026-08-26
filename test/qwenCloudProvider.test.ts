import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import {
  DEFAULT_QWEN_CLOUD_BASE_URL,
  getDefaultModelSourceBaseUrl,
  getDefaultModelSourceName,
  isModelSourceProvider,
  ModelSourceStore
} from '../src/accounts/accountStore';
import {
  createModelDiscoveryHeaders,
  getSourceModelsEndpointUrl,
  probeSourceConnection
} from '../src/accounts/modelDiscovery';
import { ModelSourceService } from '../src/accounts/modelSourceService';
import {
  requiresModelSourceApiKey,
  supportsOfficialBillingSource
} from '../src/accounts/sourceCapabilities';
import { MODEL_SOURCE_PROVIDERS } from '../src/accounts/types';
import { createProviderClient } from '../src/agent/providers/factory';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import {
  getNewAccountDialogScript,
  getNewAccountDialogTemplate
} from '../src/webview/input/newAccountDialog';
import { getInputScript } from '../src/webview/input/script';

describe('QwenCloud provider preset', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-qwencloud-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('registers an isolated QwenCloud account type with the official Chat Completions preset', async () => {
    assert.deepEqual(MODEL_SOURCE_PROVIDERS, [
      'deepseek', 'kimi', 'glm', 'qwencloud', 'ollama', 'openai-compatible', 'openai-responses', 'anthropic-compatible'
    ]);
    assert.equal(isModelSourceProvider('qwencloud'), true);
    assert.equal(getDefaultModelSourceName('qwencloud'), 'QwenCloud');
    assert.equal(getDefaultModelSourceBaseUrl('qwencloud'), DEFAULT_QWEN_CLOUD_BASE_URL);
    assert.ok(createProviderClient('qwencloud') instanceof OpenAICompatibleClient);

    const source = { provider: 'qwencloud' as const, baseUrl: DEFAULT_QWEN_CLOUD_BASE_URL };
    assert.equal(requiresModelSourceApiKey(source), true);
    assert.equal(supportsOfficialBillingSource(source), false);

    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      createId: () => 'qwen-account'
    });
    await store.createSource({ provider: 'qwencloud', apiKey: 'qwen-key' });
    const storedPath = path.join(storageRoot, 'accounts', 'qwencloud', 'qwen-account.json');
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as {
      provider: string;
      name: string;
      baseUrl: string;
    };
    assert.equal(stored.provider, 'qwencloud');
    assert.equal(stored.name, 'QwenCloud');
    assert.equal(stored.baseUrl, DEFAULT_QWEN_CLOUD_BASE_URL);
  });

  it('uses Bearer auth and derives the documented models endpoint', async () => {
    assert.equal(
      getSourceModelsEndpointUrl(DEFAULT_QWEN_CLOUD_BASE_URL, 'qwencloud'),
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models'
    );
    assert.equal(
      getSourceModelsEndpointUrl(`${DEFAULT_QWEN_CLOUD_BASE_URL}/chat/completions`, 'qwencloud'),
      'https://dashscope.aliyuncs.com/compatible-mode/v1/models'
    );
    assert.deepEqual(createModelDiscoveryHeaders('qwencloud', 'qwen-key'), {
      Accept: 'application/json',
      Authorization: 'Bearer qwen-key'
    });
    assert.deepEqual(await probeSourceConnection({
      provider: 'qwencloud',
      apiKey: '',
      baseUrl: DEFAULT_QWEN_CLOUD_BASE_URL
    }), {
      ok: false,
      error: 'An API Key is required for this official model endpoint.'
    });
  });

  it('refreshes the QwenCloud model catalog immediately after account creation', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      createId: () => 'qwen-refresh-account'
    });
    let refreshCount = 0;
    const service = new ModelSourceService(
      store,
      async () => {
        refreshCount += 1;
        return {
          status: 'fresh',
          cache: { models: [{ id: 'qwen-plus' }], fetchedAt: 1 }
        };
      },
      async () => ({ ok: true })
    );

    const result = await service.addModel({
      provider: 'qwencloud',
      name: 'QwenCloud',
      apiKey: 'qwen-key',
      baseUrl: DEFAULT_QWEN_CLOUD_BASE_URL
    });
    assert.equal(refreshCount, 1);
    assert.equal(result.discovery?.status, 'fresh');
  });

  it('shows QwenCloud in account management and ships the protocol logo used by model switching', async () => {
    const dialog = getNewAccountDialogTemplate() + getNewAccountDialogScript();
    const settings = getInputScript();
    assert.match(dialog, /value="qwencloud" data-i18n="qwenCloud">QwenCloud<\/option>/u);
    assert.match(dialog, /'deepseek', 'kimi', 'glm', 'qwencloud', 'ollama'/u);
    assert.match(dialog, /https:\/\/dashscope\.aliyuncs\.com\/compatible-mode\/v1/u);
    assert.match(dialog, /data-i18n="modelProviderLabel">模型协议或服务商<\/span>/u);
    assert.match(dialog, /closeProviderMenu\(true\);\s+setProviderValue\(selected\);/u);
    assert.match(dialog, /providerMenu\.hidden = true;/u);
    assert.match(dialog, /providerMenu\.setAttribute\('aria-hidden', 'true'\)/u);
    assert.match(settings, /provider === 'qwencloud' \? t\('qwenCloud'\)/u);
    assert.match(settings, /value === 'qwencloud'/u);
    assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].qwenCloud, 'QwenCloud');
    assert.equal(WEBVIEW_TRANSLATIONS.en.qwenCloud, 'QwenCloud');
    assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].modelProviderLabel, '模型协议或服务商');
    assert.equal(WEBVIEW_TRANSLATIONS.en.modelProviderLabel, 'Model protocol or provider');

    const icon = await readFile(path.resolve(process.cwd(), 'resources', 'qwencloud.svg'), 'utf8');
    assert.match(icon, /<svg\b/u);
    assert.match(icon, /<title[^>]*>qwencloud<\/title>/iu);
  });
});
