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
        models: [{ id: 'shared', name: 'Proxy Shared' }]
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
    assert.equal(findModelBySelection(catalog, { sourceId: 'proxy', modelId: 'shared' })?.alias, 'Proxy Shared');
    assert.equal(findModelBySelection(catalog, { sourceId: 'compatible', modelId: 'shared' })?.provider, 'openai-compatible');
    assert.equal(catalog.find((model) => model.sourceId === 'official')?.supportsBilling, true);
    assert.equal(catalog.find((model) => model.sourceId === 'proxy')?.supportsBilling, false);
  });

  it('uses successful official discovery instead of built-ins while preserving explicit models', () => {
    const catalog = createModelCatalog([createSource({
      id: 'official',
      baseUrl: 'https://api.deepseek.com/v1',
      models: [{ id: 'manual-model', name: 'Manual' }],
      modelCache: { fetchedAt: NOW, models: [{ id: 'discovered-model', name: 'Discovered' }] }
    })]);
    assert.deepEqual(catalog.map((model) => model.id), ['discovered-model', 'manual-model']);
    assert.equal(catalog.some((model) => model.id === 'deepseek-v4-flash'), false);
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
    });

    const result = await service.addModel({
      provider: 'deepseek', apiKey: 'key', baseUrl: 'https://api.deepseek.com', modelId: ''
    });
    assert.deepEqual(refreshCalls, [{ sourceId: 'official', force: true }]);
    assert.deepEqual(result.source.modelCache?.models, [{ id: 'deepseek-chat' }]);
  });

  it('requires manual IDs for other sources and reuses matching credentials', async () => {
    const ids = ['compatible', 'unused'];
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => ids.shift() ?? 'fallback'
    });
    let refreshCount = 0;
    const service = new ModelSourceService(store, async () => {
      refreshCount += 1;
      return { status: 'failed' };
    });

    await assert.rejects(service.addModel({
      provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://proxy.example/v1'
    }), /Model ID is required/u);
    const first = await service.addModel({
      provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://proxy.example/v1', modelId: 'one'
    });
    const second = await service.addModel({
      provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://proxy.example/v1/', modelId: 'two'
    });
    assert.equal(first.source.id, second.source.id);
    assert.equal(second.reusedSource, true);
    assert.deepEqual(second.source.models.map((model) => model.id), ['one', 'two']);
    assert.equal((await store.listSources()).length, 1);
    assert.equal(refreshCount, 0);
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
