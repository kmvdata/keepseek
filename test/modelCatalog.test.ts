import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { createContextUsageEstimateFromMessages } from '../src/agent/contextUsage';
import { createModelCatalog, findModelBySelection } from '../src/accounts/modelCatalog';
import { ModelSourceService } from '../src/accounts/modelSourceService';
import { ModelSourceStore, normalizeDiscoveredModels, normalizeSourceModels } from '../src/accounts/accountStore';
import { createImageModelCatalog, resolveImageModelSourceConfig } from '../src/accounts/imageModels';
import { normalizeOpenAIImagesEndpoint, OPENAI_IMAGE_MODEL_ID } from '../src/accounts/imageCapabilities';
import { parseSourceModelsResponse } from '../src/accounts/modelDiscovery';
import { isOfficialDeepSeekSource } from '../src/accounts/sourceCapabilities';
import { getAgentRuntimeProfile } from '../src/shared/modelProfiles';
import type { ModelSource } from '../src/accounts/types';

const NOW = 1_710_000_000_000;

describe('independent image model availability', () => {
  it('keeps image models out of text Agent catalogs while providing a distinct image catalog', () => {
    const source = createSource({
      id: 'images', name: 'Images', provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1/', apiKey: 'private-key',
      models: [{ id: OPENAI_IMAGE_MODEL_ID }, { id: 'gpt-5' }]
    });
    assert.deepEqual(createModelCatalog([source]).map((model) => model.id), ['gpt-5']);
    const [inventory] = createModelCatalog([source], { includeDisabledModels: true });
    assert.equal(inventory?.agentCompatible, false);
    assert.deepEqual(inventory?.imageCapabilities?.operations, ['generate', 'edit']);
    const [image] = createImageModelCatalog([source]);
    assert.equal(image?.available, true);
    assert.equal(image?.sourceId, 'images');
    assert.equal(image?.endpointId, 'https://api.openai.com/v1');
    assert.equal(JSON.stringify(image).includes('private-key'), false);
    assert.deepEqual(image?.capabilities.inputMimeTypes, ['image/png', 'image/jpeg', 'image/webp']);
  });

  it('does not infer native image endpoints from text compatibility or merge namesake accounts', () => {
    const sources = [
      createSource({ id: 'first', provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: [{ id: OPENAI_IMAGE_MODEL_ID }] }),
      createSource({ id: 'second', provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1', models: [{ id: OPENAI_IMAGE_MODEL_ID }] }),
      createSource({ id: 'third', provider: 'qwencloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: [{ id: OPENAI_IMAGE_MODEL_ID }] }),
      createSource({ id: 'empty', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: '', models: [{ id: OPENAI_IMAGE_MODEL_ID }] }),
      createSource({ id: 'disabled', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', disabledModelIds: [OPENAI_IMAGE_MODEL_ID], models: [{ id: OPENAI_IMAGE_MODEL_ID }] }),
      createSource({ id: 'off', provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', enabled: false, models: [{ id: OPENAI_IMAGE_MODEL_ID }] })
    ];
    assert.deepEqual(createImageModelCatalog(sources).map((entry) => [entry.sourceId, entry.available, entry.reason]), [
      ['first', true, undefined], ['second', false, 'unsupported_endpoint'],
      ['third', false, 'unsupported_endpoint'], ['empty', false, 'missing_api_key'],
      ['disabled', false, 'model_disabled'], ['off', false, 'source_disabled']
    ]);
    for (const url of [
      'http://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1?secret=1', 'https://api.openai.com/v1#fragment',
      'https://user:pass@api.openai.com/v1', 'https://api.openai.com.evil.example/v1',
      'https://localhost/v1', 'https://api.openai.com', 'not-a-url'
    ]) assert.equal(normalizeOpenAIImagesEndpoint(url), undefined, url);
  });

  it('reads old manual/discovery records and persists verified capabilities without trusting arbitrary flags', () => {
    const manual = normalizeSourceModels([{ id: OPENAI_IMAGE_MODEL_ID }, { id: 'other', imageCapabilities: { adapter: 'openai-images-v1' } }]);
    const discovered = normalizeDiscoveredModels([{ id: OPENAI_IMAGE_MODEL_ID }]);
    const parsed = parseSourceModelsResponse({ data: [{ id: OPENAI_IMAGE_MODEL_ID }] });
    assert.equal(manual[0]?.imageCapabilities?.version, 1);
    assert.equal(manual[1]?.imageCapabilities, undefined);
    assert.deepEqual(discovered[0]?.imageCapabilities, manual[0]?.imageCapabilities);
    assert.deepEqual(parsed?.[0]?.imageCapabilities, manual[0]?.imageCapabilities);
    assert.deepEqual(normalizeSourceModels(manual), manual);
    assert.deepEqual(normalizeDiscoveredModels(discovered), discovered);
  });

  it('enables image use independently and resolves exactly the selected account through the shared resolver', async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-image-models-'));
    try {
      const store = new ModelSourceStore(vscode.Uri.file(storageRoot));
      const source = await store.createSource({
        id: 'images', name: 'Images', provider: 'openai-compatible',
        apiKey: 'selected-key', baseUrl: 'https://api.openai.com/v1',
        models: [{ id: OPENAI_IMAGE_MODEL_ID }], disabledModelIds: [OPENAI_IMAGE_MODEL_ID]
      });
      const service = new ModelSourceService(store);
      await service.setModelEnabled(source.id, OPENAI_IMAGE_MODEL_ID, true);
      const resolved = await resolveImageModelSourceConfig({ sourceId: 'images', modelId: OPENAI_IMAGE_MODEL_ID }, undefined, { sourceStore: store });
      assert.equal(resolved.source.apiKey, 'selected-key');
      assert.equal(resolved.model.available, true);
      assert.deepEqual(createModelCatalog([resolved.source.modelSource!]), []);
      await assert.rejects(resolveImageModelSourceConfig({ sourceId: 'missing', modelId: OPENAI_IMAGE_MODEL_ID }, undefined, { sourceStore: store }));
      await store.updateSource('images', { baseUrl: 'https://gateway.example/v1' });
      await assert.rejects(resolveImageModelSourceConfig({ sourceId: 'images', modelId: OPENAI_IMAGE_MODEL_ID }, undefined, { sourceStore: store }), /unsupported_endpoint/u);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});

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

  it('uses canonical DeepSeek capabilities when discovery omits capability metadata', () => {
    const [model] = createModelCatalog([createSource({
      id: 'official',
      baseUrl: 'https://api.deepseek.com/v1',
      modelCache: { fetchedAt: NOW, models: [{ id: 'deepseek-v4.1-flash' }] }
    })]);

    assert.equal(model?.contextWindowTokens, 1_048_576);
    assert.equal(model?.contextWindowSource, 'built-in');
    const usage = createContextUsageEstimateFromMessages({
      model: model!,
      messages: [{ role: 'user', content: '中'.repeat(300_000) }],
      outputReserveTokens: 0,
      safetyReserveTokens: 0
    });
    assert.ok(usage.usedTokensEstimate > 300_000 && usage.usedTokensEstimate < 301_000);
    assert.ok(usage.usedPercent > 28 && usage.usedPercent < 29);
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

  it('keeps non-text resources in settings without exposing them to the text Agent', () => {
    const source = createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [
        { id: 'qwen3.7-max' },
        { id: 'wan2.7-image' },
        { id: 'wan2.7-image-pro' },
        { id: 'qwen-audio-3.0-tts-plus' }
      ]
    });

    assert.deepEqual(createModelCatalog([source]).map((model) => model.id), ['qwen3.7-max']);
    const inventory = createModelCatalog([source], { includeDisabledModels: true });
    assert.deepEqual(inventory.map((model) => model.id), [
      'qwen3.7-max',
      'wan2.7-image',
      'wan2.7-image-pro',
      'qwen-audio-3.0-tts-plus'
    ]);
    assert.equal(inventory[0]?.contextWindowTokens, 1_000_000);
    assert.equal(inventory[0]?.maxOutputTokens, 131_072);
    assert.deepEqual(
      inventory.slice(1).map((model) => ({
        id: model.id,
        agentCompatible: model.agentCompatible,
        kind: model.nonTextModelKind,
        contextWindowTokens: model.contextWindowTokens,
        maxOutputTokens: model.maxOutputTokens
      })),
      [
        {
          id: 'wan2.7-image',
          agentCompatible: false,
          kind: 'image-generation',
          contextWindowTokens: undefined,
          maxOutputTokens: undefined
        },
        {
          id: 'wan2.7-image-pro',
          agentCompatible: false,
          kind: 'image-generation',
          contextWindowTokens: undefined,
          maxOutputTokens: undefined
        },
        {
          id: 'qwen-audio-3.0-tts-plus',
          agentCompatible: false,
          kind: 'speech-synthesis',
          contextWindowTokens: undefined,
          maxOutputTokens: undefined
        }
      ]
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
    assert.equal(catalog[0]?.contextWindowSource, 'manual');
    assert.equal(catalog[0]?.maxOutputTokens, 7_000);
    assert.equal(catalog[0]?.maxOutputSource, 'manual');
  });

  it('marks compatible named-model capabilities as low-trust guesses', () => {
    const catalog = createModelCatalog([createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [{ id: 'deepseek-v4-pro' }]
    })]);

    assert.equal(catalog[0]?.contextWindowTokens, 1_048_576);
    assert.equal(catalog[0]?.contextWindowSource, 'guessed');
    assert.equal(catalog[0]?.maxOutputTokens, 393_216);
    assert.equal(catalog[0]?.maxOutputSource, 'guessed');
    assert.equal(getAgentRuntimeProfile(catalog[0]!, {
      thinkingEnabled: true,
      reasoningEffort: 'high'
    }).maxTokens, 393_216);
  });

  it('shows the conservative fallback for unknown model IDs', () => {
    const catalog = createModelCatalog([createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      models: [{ id: 'vendor-model' }]
    })]);

    assert.equal(catalog[0]?.contextWindowTokens, 32_768);
    assert.equal(catalog[0]?.contextWindowSource, 'fallback');
    assert.equal(catalog[0]?.maxOutputTokens, 8_192);
    assert.equal(catalog[0]?.maxOutputSource, 'fallback');
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

    const disabledAgain = await service.setModelEnabled(source.id, 'model-two', false);
    const contextUpdated = await service.setModelContextWindowTokens(
      disabledAgain.id,
      'model-two',
      250_000
    );
    assert.deepEqual(contextUpdated.disabledModelIds, ['model-two']);
    assert.deepEqual(contextUpdated.models[1], {
      id: 'model-two',
      contextWindowTokens: 250_000
    });
    assert.equal(
      createModelCatalog([contextUpdated], { includeDisabledModels: true })[1]?.contextWindowSource,
      'manual'
    );
    const maxOutputUpdated = await service.setModelMaxOutputTokens(
      contextUpdated.id,
      'model-two',
      128_000
    );
    assert.deepEqual(maxOutputUpdated.models[1], {
      id: 'model-two',
      contextWindowTokens: 250_000,
      maxOutputTokens: 128_000
    });
    assert.equal(
      createModelCatalog([maxOutputUpdated], { includeDisabledModels: true })[1]?.maxOutputSource,
      'manual'
    );
    await assert.rejects(
      service.setModelContextWindowTokens(source.id, 'unknown-model', 64_000),
      /Model not found/u
    );
    await assert.rejects(
      service.setModelContextWindowTokens(source.id, 'model-one', 10_000_001),
      /contextWindowTokens/u
    );
    await assert.rejects(
      service.setModelMaxOutputTokens(source.id, 'unknown-model', 64_000),
      /Model not found/u
    );
    await assert.rejects(
      service.setModelMaxOutputTokens(source.id, 'model-one', 1_048_577),
      /maxOutputTokens/u
    );
  });

  it('rejects token capability edits and text-Agent enabling for non-text resources', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'compatible'
    });
    const source = await store.createSource({
      provider: 'openai-compatible',
      name: 'Compatible',
      apiKey: '',
      baseUrl: 'https://proxy.example/v1',
      models: [{ id: 'wan2.7-image' }]
    });
    const service = new ModelSourceService(store);

    await assert.rejects(
      service.setModelEnabled(source.id, 'wan2.7-image', true),
      /not compatible with the text Agent/u
    );
    await assert.rejects(
      service.setModelContextWindowTokens(source.id, 'wan2.7-image', 32_768),
      /do not apply/u
    );
    await assert.rejects(
      service.setModelMaxOutputTokens(source.id, 'wan2.7-image', 8_192),
      /do not apply/u
    );
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
