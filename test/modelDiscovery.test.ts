import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import {
  discoverSourceModels,
  getSourceModelsEndpointUrl,
  parseSourceModelsResponse,
  refreshSourceModelCache,
  type ModelsFetch
} from '../src/accounts/modelDiscovery';

const NOW = 1_710_000_000_000;

describe('model source discovery', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-model-discovery-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('derives canonical official DeepSeek and prefixed compatible /models URLs', () => {
    assert.equal(getSourceModelsEndpointUrl('https://api.deepseek.com'), 'https://api.deepseek.com/models');
    assert.equal(
      getSourceModelsEndpointUrl('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/models'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://proxy.example.com/openai/v1', 'deepseek'),
      'https://proxy.example.com/openai/v1/models'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://proxy.example.com/openai/v1/chat/completions?tenant=a', 'openai-compatible'),
      'https://proxy.example.com/openai/v1/models?tenant=a'
    );
  });

  it('parses OpenAI-compatible response names, alternate fields, and duplicates', () => {
    assert.deepEqual(parseSourceModelsResponse({
      data: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', display_name: 'Beta Display' },
        { id: 'gamma' },
        { id: 'alpha', name: 'Duplicate' },
        'delta'
      ]
    }), [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta Display' },
      { id: 'gamma' },
      { id: 'delta' }
    ]);
    assert.deepEqual(parseSourceModelsResponse({ data: [] }), []);
    assert.equal(parseSourceModelsResponse({ data: 'invalid' }), undefined);
  });

  it('sends an authenticated GET and silently degrades malformed or failed responses', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl: ModelsFetch = async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }] }) };
    };
    const cache = await discoverSourceModels({
      provider: 'openai-compatible', apiKey: 'secret-key', baseUrl: 'https://proxy.example.com/v1'
    }, { fetchImpl, now: NOW, timeoutMs: 0 });
    assert.deepEqual(cache, { models: [{ id: 'model-a', name: 'Model A' }], fetchedAt: NOW });
    assert.equal(requestUrl, 'https://proxy.example.com/v1/models');
    assert.equal(requestInit?.method, 'GET');
    assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer secret-key');

    assert.equal(await discoverSourceModels({
      provider: 'deepseek', apiKey: 'key', baseUrl: 'https://api.deepseek.com'
    }, { timeoutMs: 0, fetchImpl: async () => ({ ok: true, text: async () => 'not-json' }) }), undefined);
  });

  it('persists fresh models, reuses a warm cache, and keeps stale cache on failure', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({
      id: 'source-a', provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://proxy.example.com/v1'
    });
    let fetchCount = 0;
    const fetchImpl: ModelsFetch = async () => {
      fetchCount += 1;
      return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }] }) };
    };

    const fresh = await refreshSourceModelCache(store, 'source-a', {
      fetchImpl, force: true, now: NOW, timeoutMs: 0
    });
    assert.equal(fresh.status, 'fresh');
    assert.deepEqual(fresh.cache?.models, [{ id: 'model-a', name: 'Model A' }]);
    assert.deepEqual((await store.getSource('source-a'))?.modelCache, fresh.cache);

    const warm = await refreshSourceModelCache(store, 'source-a', {
      fetchImpl: async () => { throw new Error('warm cache should avoid fetch'); },
      now: NOW + 1_000
    });
    assert.equal(warm.status, 'cached');
    assert.equal(fetchCount, 1);

    const stale = await refreshSourceModelCache(store, 'source-a', {
      fetchImpl: async () => { throw new Error('offline'); },
      force: true,
      now: NOW + 20 * 60_000,
      timeoutMs: 0
    });
    assert.equal(stale.status, 'failed');
    assert.deepEqual(stale.cache, fresh.cache);
  });

  it('does not persist a slow response after source credentials change', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({
      id: 'changing-source', provider: 'openai-compatible', apiKey: 'old-key', baseUrl: 'https://old.example.com/v1'
    });
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const refresh = refreshSourceModelCache(store, 'changing-source', {
      force: true,
      now: NOW,
      timeoutMs: 0,
      fetchImpl: async () => {
        await responseGate;
        return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'old-model' }] }) };
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.updateSource('changing-source', {
      apiKey: 'new-key', baseUrl: 'https://new.example.com/v1', modelCache: undefined
    });
    releaseResponse?.();

    assert.equal((await refresh).status, 'failed');
    const latest = await store.getSource('changing-source');
    assert.equal(latest?.apiKey, 'new-key');
    assert.equal(latest?.modelCache, undefined);
  });
});
