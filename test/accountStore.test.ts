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
  normalizeModelSource
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
      models: [{
        id: ' model-a ',
        contextWindowTokens: 128_000,
        maxOutputTokens: 16_000
      }, { id: 'model-a' }],
      disabledModelIds: [' model-b ', 'model-b', '', 1],
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
      models: [{ id: 'model-a', contextWindowTokens: 128_000, maxOutputTokens: 16_000 }],
      disabledModelIds: ['model-b'],
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
    assert.equal(normalizeModelDiscoveryCache({ models: 'invalid' }), undefined);
  });

  it('drops invalid manual capability metadata at persistence boundaries', () => {
    const source = normalizeModelSource({
      id: 'manual',
      provider: 'openai-compatible',
      models: [
        { id: 'valid', contextWindowTokens: 64_000, maxOutputTokens: 4_000 },
        { id: 'invalid', contextWindowTokens: -1, maxOutputTokens: 2_000_000 }
      ]
    }, { now: NOW });

    assert.deepEqual(source?.models, [
      { id: 'valid', contextWindowTokens: 64_000, maxOutputTokens: 4_000 },
      { id: 'invalid' }
    ]);
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

    const storedPath = path.join(storageRoot, 'accounts', 'openai-compatible', 'generated-id.json');
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { apiKey: string };
    assert.equal(stored.apiKey, 'proxy-key');
    assert.equal((await store.listSources()).length, 1);

    const updated = await store.updateSource('generated-id', {
      name: 'Renamed',
      models: [{ id: 'proxy-model' }],
      disabledModelIds: ['proxy-model']
    });
    assert.equal(updated?.name, 'Renamed');
    assert.deepEqual(updated?.models, [{ id: 'proxy-model' }]);
    assert.deepEqual(updated?.disabledModelIds, ['proxy-model']);

    assert.equal((await store.deleteSource('generated-id'))?.id, 'generated-id');
    await assert.rejects(access(storedPath));
  });

  it('stores Responses accounts in their own provider directory', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'responses-account'
    });
    await store.createSource({
      provider: 'openai-responses',
      name: 'Responses',
      apiKey: 'responses-key'
    });
    const storedPath = path.join(
      storageRoot,
      'accounts',
      'openai-responses',
      'responses-account.json'
    );
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { provider: string; baseUrl: string };
    assert.equal(stored.provider, 'openai-responses');
    assert.equal(stored.baseUrl, 'https://api.openai.com/v1');
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
  });

});
