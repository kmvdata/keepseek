import './registerVscodeStub';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import {
  ModelSourceStore,
  normalizeModelDiscoveryCache,
  normalizeModelSource,
  normalizeModelAliases
} from '../src/accounts/accountStore';

const NOW = 1_710_000_000_000;

describe('ModelSourceStore', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-sources-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('normalizes the source schema, models, cache, and timestamps', () => {
    const source = normalizeModelSource({
      id: ' source-1 ',
      name: ' My Source ',
      provider: 'deepseek',
      apiKey: ' sk-secret ',
      baseUrl: ' https://proxy.example.com/v1 ',
      models: [{ id: ' model-a ', name: ' Daily ' }, { id: 'model-a', name: 'duplicate' }],
      modelCache: {
        models: [{ id: ' model-a ', name: ' Model A ' }, { id: 'model-b' }],
        fetchedAt: NOW - 100
      },
      enabled: false,
      createdAt: 'invalid',
      updatedAt: NOW - 200
    }, { now: NOW });

    assert.deepEqual(source, {
      id: 'source-1',
      name: 'My Source',
      provider: 'deepseek',
      apiKey: 'sk-secret',
      baseUrl: 'https://proxy.example.com/v1',
      models: [{ id: 'model-a', name: 'Daily' }],
      modelCache: {
        models: [{ id: 'model-a', name: 'Model A' }, { id: 'model-b' }],
        fetchedAt: NOW - 100
      },
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW
    });
    assert.equal(normalizeModelSource({ id: '../escape', provider: 'deepseek' }, { now: NOW }), undefined);
    assert.equal(normalizeModelSource({ id: 'a', provider: 'anthropic' }, { now: NOW }), undefined);
    assert.deepEqual(normalizeModelAliases(null), {});
    assert.equal(normalizeModelDiscoveryCache({ models: 'invalid' }), undefined);
  });

  it('reads old account JSON and projects aliases/manual cache entries into source models', () => {
    const source = normalizeModelSource({
      id: 'legacy',
      name: 'Legacy Account',
      provider: 'openai-compatible',
      apiKey: 'key',
      baseUrl: 'https://proxy.example/v1',
      modelAliases: { 'manual-model': 'Daily', 'cached-model': 'Named' },
      modelCache: {
        fetchedAt: NOW,
        models: [{ id: 'manual-model' }, { id: 'discovered', name: 'Discovered' }]
      },
      createdAt: NOW,
      updatedAt: NOW
    }, { now: NOW });
    assert.deepEqual(source?.models, [
      { id: 'manual-model', name: 'Daily' },
      { id: 'cached-model', name: 'Named' }
    ]);
    assert.equal(source?.modelCache?.models[1]?.name, 'Discovered');
  });

  it('creates, lists, updates, and physically deletes provider-scoped source files', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'generated-id'
    });
    const created = await store.createSource({
      provider: 'openai-compatible',
      name: 'Proxy',
      apiKey: 'proxy-key',
      baseUrl: 'https://proxy.example.com/v1'
    });
    assert.equal(created.id, 'generated-id');
    assert.equal(await store.hasStoredSourceFiles(), true);

    const storedPath = path.join(storageRoot, 'accounts', 'openai-compatible', 'generated-id.json');
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { apiKey: string };
    assert.equal(stored.apiKey, 'proxy-key');
    assert.equal((await store.listSources()).length, 1);

    const updated = await store.updateSource('generated-id', {
      name: 'Renamed',
      models: [{ id: 'proxy-model', name: 'Fast' }]
    });
    assert.equal(updated?.name, 'Renamed');
    assert.deepEqual(updated?.models, [{ id: 'proxy-model', name: 'Fast' }]);

    assert.equal((await store.deleteSource('generated-id'))?.id, 'generated-id');
    await assert.rejects(access(storedPath));
    assert.equal(await store.hasStoredSourceFiles(), false);
    assert.equal(await store.isStorageInitialized(), true);
  });

  it('ignores damaged and path-mismatched JSON while preserving other sources', async () => {
    const deepseekDir = path.join(storageRoot, 'accounts', 'deepseek');
    await mkdir(deepseekDir, { recursive: true });
    await writeFile(path.join(deepseekDir, 'broken.json'), 'not-json{{', 'utf8');
    await writeFile(path.join(deepseekDir, 'mismatch.json'), JSON.stringify({
      id: 'different-id', provider: 'deepseek', apiKey: 'do-not-load'
    }), 'utf8');

    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'healthy-id'
    });
    await store.createSource({
      provider: 'openai-compatible', apiKey: 'healthy-key', baseUrl: 'https://proxy.example.com/v1'
    });

    const sources = await store.listSources();
    assert.deepEqual(sources.map((source) => source.id), ['healthy-id']);
    assert.equal(await store.hasStoredSourceFiles(), true);
  });

  it('creates the legacy default without overwriting an existing source', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const first = await store.upsertDefaultSource({ apiKey: 'first-key', baseUrl: 'https://first.example.com' });
    const second = await store.upsertDefaultSource({ apiKey: 'second-key', baseUrl: 'https://second.example.com' });
    assert.equal(first.id, 'default');
    assert.equal(second.apiKey, 'first-key');
    assert.equal(second.baseUrl, 'https://first.example.com');
  });
});
