import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { createModelCatalog, findModelBySelection } from '../src/accounts/modelCatalog';
import { ModelSourceService } from '../src/accounts/modelSourceService';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { isOfficialDeepSeekSource } from '../src/accounts/sourceCapabilities';
import type { ModelSource } from '../src/accounts/types';

const NOW = 1_710_000_000_000;

describe('model source catalog', () => {
  it('recognizes only the exact official DeepSeek host, including /v1 paths', () => {
    assert.equal(isOfficialDeepSeekSource({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com' }), true);
    assert.equal(isOfficialDeepSeekSource({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1' }), true);
    assert.equal(isOfficialDeepSeekSource({ provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com' }), false);
    assert.equal(isOfficialDeepSeekSource({ provider: 'deepseek', baseUrl: 'https://deepseek.proxy.example/v1' }), false);
    assert.equal(isOfficialDeepSeekSource({ provider: 'deepseek', baseUrl: 'not-a-url' }), false);
  });

  it('aggregates every source and keeps duplicate model IDs distinct by sourceId', () => {
    const sources = [
      createSource({ id: 'official', name: 'DeepSeek 官网', baseUrl: 'https://api.deepseek.com' }),
      createSource({
        id: 'proxy',
        name: 'Proxy',
        baseUrl: 'https://proxy.example/v1',
        models: [{ id: 'shared' }],
        modelCache: { fetchedAt: NOW, models: [{ id: 'shared', name: 'Proxy Shared' }] }
      }),
      createSource({
        id: 'compatible',
        name: 'Compatible',
        provider: 'openai-compatible',
        baseUrl: 'https://compatible.example/v1',
        models: [{ id: 'shared' }, { id: 'vendor-model' }]
      })
    ];
    const catalog = createModelCatalog(sources);

    assert.ok(catalog.some((model) => model.sourceId === 'official' && model.id === 'deepseek-v4-flash'));
    assert.equal(catalog.filter((model) => model.id === 'shared').length, 2);
    assert.equal(findModelBySelection(catalog, { sourceId: 'proxy', modelId: 'shared' })?.fetchedName, 'Proxy Shared');
    assert.equal(findModelBySelection(catalog, { sourceId: 'compatible', modelId: 'shared' })?.provider, 'openai-compatible');
    assert.equal(catalog.find((model) => model.sourceId === 'official')?.supportsBilling, true);
    assert.equal(catalog.find((model) => model.sourceId === 'proxy')?.supportsBilling, false);
  });

  it('uses successful official discovery instead of built-ins while preserving explicit models', () => {
    const catalog = createModelCatalog([createSource({
      id: 'official',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'manual-model' }],
      modelCache: { fetchedAt: NOW, models: [{ id: 'discovered-model', name: 'Discovered' }] }
    })]);
    assert.deepEqual(catalog.map((model) => model.id), ['discovered-model', 'manual-model']);
    assert.equal(catalog.some((model) => model.id === 'deepseek-v4-flash'), false);
  });

  it('hides disabled model IDs from normal catalogs while keeping the full settings inventory', () => {
    const source = createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [{ id: 'enabled-model' }, { id: 'disabled-model' }],
      disabledModelIds: ['disabled-model']
    });

    assert.deepEqual(
      createModelCatalog([source]).map((model) => model.id),
      ['enabled-model']
    );
    assert.deepEqual(
      createModelCatalog([source], { includeDisabledModels: true }).map((model) => model.id),
      ['enabled-model', 'disabled-model']
    );
  });

  it('merges manual capability overrides before discovery and built-in metadata', () => {
    const catalog = createModelCatalog([createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [{ id: 'shared', contextWindowTokens: 96_000, maxOutputTokens: 7_000 }],
      modelCache: {
        fetchedAt: NOW,
        models: [{ id: 'shared', contextWindowTokens: 128_000, maxOutputTokens: 12_000 }]
      }
    })]);

    assert.equal(catalog[0]?.contextWindowTokens, 96_000);
    assert.equal(catalog[0]?.maxOutputTokens, 7_000);
  });

  it('does not grant DeepSeek built-in metadata to a compatible lookalike model id', () => {
    const catalog = createModelCatalog([createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [{ id: 'deepseek-v4-pro' }]
    })]);

    assert.equal(catalog[0]?.contextWindowTokens, undefined);
    assert.equal(catalog[0]?.maxOutputTokens, undefined);
  });
});

describe('ModelSourceService', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-model-source-service-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('automatically discovers official DeepSeek models after add', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW, createId: () => 'official' });
    const refreshCalls: Array<{ sourceId: string; force?: boolean }> = [];
    const service = new ModelSourceService(store, async (_store, sourceId, options) => {
      refreshCalls.push({ sourceId, force: options.force });
      await store.updateSource(sourceId, {
        modelCache: { fetchedAt: NOW, models: [{ id: 'deepseek-chat' }] }
      });
      return { status: 'fresh', cache: { fetchedAt: NOW, models: [{ id: 'deepseek-chat' }] } };
    }, async () => ({ ok: true, status: 200 }));

    const result = await service.addModel({
      provider: 'deepseek', name: 'DeepSeek', apiKey: 'key', baseUrl: 'https://api.deepseek.com', modelId: ''
    });
    assert.deepEqual(refreshCalls, [{ sourceId: 'official', force: true }]);
    assert.deepEqual(result.source.modelCache?.models, [{ id: 'deepseek-chat' }]);
  });

  it('creates sources without API keys or model IDs and reuses matching credentials', async () => {
    const ids = ['compatible', 'unused'];
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => ids.shift() ?? 'fallback'
    });
    let refreshCount = 0;
    let probeCount = 0;
    const service = new ModelSourceService(
      store,
      async () => {
        refreshCount += 1;
        return { status: 'failed' };
      },
      async () => {
        probeCount += 1;
        return { ok: true, status: 200 };
      }
    );

    // A source name is required before creating an account.
    await assert.rejects(service.addModel({
      provider: 'openai-compatible', apiKey: '', baseUrl: 'https://proxy.example/v1'
    }), /Source name is required/u);
    // Without an API key or model ID the account can still be created.
    const first = await service.addModel({
      provider: 'openai-compatible', name: 'Proxy One', apiKey: '', baseUrl: 'https://proxy.example/v1'
    });
    assert.equal(first.source.name, 'Proxy One');
    assert.deepEqual(first.source.models, []);
    // Duplicate names (case-insensitive) are rejected.
    await assert.rejects(service.addModel({
      provider: 'openai-compatible', name: 'proxy one', apiKey: 'key', baseUrl: 'https://proxy.example/v2'
    }), /name already exists/u);
    // Matching credentials reuse the existing source; the name is not applied.
    const second = await service.addModel({
      provider: 'openai-compatible', name: 'Proxy One', apiKey: '', baseUrl: 'https://proxy.example/v1/', modelId: 'two'
    });
    assert.equal(first.source.id, second.source.id);
    assert.equal(second.reusedSource, true);
    assert.deepEqual(second.source.models.map((model) => model.id), ['two']);
    assert.equal((await store.listSources()).length, 1);
    assert.equal(refreshCount, 0);
    assert.equal(probeCount, 1);
  });

  it('persists per-model availability and re-enables a model when it is added again', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'compatible'
    });
    const source = await store.createSource({
      provider: 'openai-compatible',
      name: 'Compatible',
      apiKey: '',
      baseUrl: 'https://proxy.example/v1',
      models: [{ id: 'model-one' }, { id: 'model-two' }]
    });
    const service = new ModelSourceService(store);

    const disabled = await service.setModelEnabled(source.id, 'model-one', false);
    assert.deepEqual(disabled.disabledModelIds, ['model-one']);
    assert.deepEqual(createModelCatalog([disabled]).map((model) => model.id), ['model-two']);
    await assert.rejects(
      service.setModelEnabled(source.id, 'unknown-model', false),
      /Model not found/u
    );

    const readded = await service.addModel({
      sourceId: source.id,
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'https://proxy.example/v1',
      modelId: 'model-one',
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_000
    });
    assert.deepEqual(readded.source.disabledModelIds, []);
    assert.deepEqual(
      createModelCatalog([readded.source]).map((model) => model.id),
      ['model-one', 'model-two']
    );
    assert.deepEqual(readded.source.models[0], {
      id: 'model-one',
      contextWindowTokens: 64_000,
      maxOutputTokens: 4_000
    });
  });

  it('rejects account creation when the Base URL probe fails', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const service = new ModelSourceService(
      store,
      async () => ({ status: 'failed' }),
      async () => ({ ok: false, status: 401, error: 'Authentication failed (HTTP 401). Check the API Key and Base URL.' })
    );
    await assert.rejects(service.addModel({
      provider: 'openai-compatible', name: 'Proxy', apiKey: 'bad-key', baseUrl: 'https://proxy.example/v1'
    }), /HTTP 401/u);
    assert.equal((await store.listSources()).length, 0);
  });

  it('keeps Chat Completions and Responses credentials in distinct accounts and refreshes Responses models', async () => {
    const ids = ['chat-account', 'responses-account'];
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => ids.shift() ?? 'fallback'
    });
    const refreshCalls: string[] = [];
    const service = new ModelSourceService(
      store,
      async (_store, sourceId) => {
        refreshCalls.push(sourceId);
        return { status: 'fresh', cache: { fetchedAt: NOW, models: [{ id: 'model' }] } };
      },
      async () => ({ ok: true, status: 200 })
    );
    const chat = await service.addModel({
      provider: 'openai-compatible', name: 'Chat', apiKey: 'same-key', baseUrl: 'https://api.example/v1'
    });
    const responses = await service.addModel({
      provider: 'openai-responses', name: 'Responses', apiKey: 'same-key', baseUrl: 'https://api.example/v1'
    });
    assert.notEqual(chat.source.id, responses.source.id);
    assert.equal(responses.reusedSource, false);
    const reusedResponses = await service.addModel({
      provider: 'openai-responses',
      name: 'Responses alias',
      apiKey: 'same-key',
      baseUrl: 'https://api.example/v1/'
    });
    assert.equal(reusedResponses.source.id, responses.source.id);
    assert.equal(reusedResponses.reusedSource, true);
    assert.deepEqual(refreshCalls, ['responses-account', 'responses-account']);
    await assert.rejects(service.addModel({
      sourceId: responses.source.id,
      provider: 'openai-compatible',
      apiKey: 'same-key',
      baseUrl: 'https://api.example/v1'
    }), /protocol cannot be changed/iu);
  });
});

function createSource(overrides: Partial<ModelSource>): ModelSource {
  return {
    id: 'source',
    name: 'Source',
    provider: 'deepseek',
    apiKey: 'key',
    baseUrl: 'https://proxy.example/v1',
    models: [],
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}
