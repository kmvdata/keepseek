import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { AccountStore } from '../src/accounts/accountStore';
import {
  discoverAccountModels,
  getAccountModelsEndpointUrl,
  mergeDiscoveredCacheWithManualModels,
  parseAccountModelsResponse,
  refreshAccountModelCache,
  retainManualAccountModelCache,
  type ModelsFetch
} from '../src/accounts/modelDiscovery';

const NOW = 1_710_000_000_000;

describe('account model discovery', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-model-discovery-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('derives canonical DeepSeek and proxy /models URLs', () => {
    assert.equal(
      getAccountModelsEndpointUrl('https://api.deepseek.com'),
      'https://api.deepseek.com/models'
    );
    assert.equal(
      getAccountModelsEndpointUrl('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/models'
    );
    assert.equal(
      getAccountModelsEndpointUrl('https://proxy.example.com/openai/v1'),
      'https://proxy.example.com/openai/v1/models'
    );
    assert.equal(
      getAccountModelsEndpointUrl('https://proxy.example.com/openai/v1/chat/completions?tenant=a'),
      'https://proxy.example.com/openai/v1/models?tenant=a'
    );
    assert.equal(
      getAccountModelsEndpointUrl('https://proxy.example.com/openai/v1/models'),
      'https://proxy.example.com/openai/v1/models'
    );
  });

  it('parses OpenAI-compatible response names, alternate fields, and duplicates', () => {
    assert.deepEqual(parseAccountModelsResponse({
      object: 'list',
      data: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', display_name: 'Beta Display' },
        { id: 'gamma' },
        { id: 'alpha', name: 'Duplicate' },
        { name: 'Missing id' },
        'delta'
      ]
    }), [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta Display' },
      { id: 'gamma' },
      { id: 'delta' }
    ]);
    assert.deepEqual(parseAccountModelsResponse({ data: [] }), []);
    assert.equal(parseAccountModelsResponse({ data: 'invalid' }), undefined);
    assert.equal(parseAccountModelsResponse(null), undefined);
  });

  it('sends an authenticated GET and silently degrades malformed or failed responses', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const fetchImpl: ModelsFetch = async (url, init) => {
      requestUrl = url;
      requestInit = init;
      return {
        ok: true,
        async text() {
          return JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }] });
        }
      };
    };
    const cache = await discoverAccountModels({
      provider: 'openai-compatible',
      apiKey: 'secret-key',
      baseUrl: 'https://proxy.example.com/v1'
    }, { fetchImpl, now: NOW, timeoutMs: 0 });
    assert.deepEqual(cache, {
      models: [{ id: 'model-a', name: 'Model A' }],
      fetchedAt: NOW
    });
    assert.equal(requestUrl, 'https://proxy.example.com/v1/models');
    assert.equal(requestInit?.method, 'GET');
    assert.equal((requestInit?.headers as Record<string, string>).Authorization, 'Bearer secret-key');

    const malformed = await discoverAccountModels({
      provider: 'deepseek',
      apiKey: 'key',
      baseUrl: 'https://api.deepseek.com'
    }, {
      timeoutMs: 0,
      fetchImpl: async () => ({ ok: true, text: async () => 'not-json' })
    });
    assert.equal(malformed, undefined);

    const failed = await discoverAccountModels({
      provider: 'deepseek',
      apiKey: 'key',
      baseUrl: 'https://api.deepseek.com'
    }, {
      timeoutMs: 0,
      fetchImpl: async () => { throw new Error('offline'); }
    });
    assert.equal(failed, undefined);
  });

  it('persists fresh models, reuses a warm cache, and keeps stale cache on failure', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createAccount({
      id: 'account-a',
      provider: 'openai-compatible',
      apiKey: 'key',
      baseUrl: 'https://proxy.example.com/v1'
    });
    let fetchCount = 0;
    const fetchImpl: ModelsFetch = async () => {
      fetchCount += 1;
      return {
        ok: true,
        text: async () => JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }] })
      };
    };

    const fresh = await refreshAccountModelCache(store, 'account-a', {
      fetchImpl,
      force: true,
      now: NOW,
      timeoutMs: 0
    });
    assert.equal(fetchCount, 1);
    assert.deepEqual(fresh?.models, [{ id: 'model-a', name: 'Model A' }]);
    assert.deepEqual((await store.getAccount('account-a'))?.modelCache, fresh);

    const warm = await refreshAccountModelCache(store, 'account-a', {
      fetchImpl: async () => { throw new Error('warm cache should avoid fetch'); },
      now: NOW + 1_000
    });
    assert.deepEqual(warm, fresh);

    const stale = await refreshAccountModelCache(store, 'account-a', {
      fetchImpl: async () => { throw new Error('offline'); },
      force: true,
      now: NOW + 20 * 60_000,
      timeoutMs: 0
    });
    assert.deepEqual(stale, fresh);
  });

  it('retains unnamed manual model ids while replacing stale discovered entries', () => {
    assert.deepEqual(mergeDiscoveredCacheWithManualModels({
      fetchedAt: NOW,
      models: [
        { id: 'current', name: 'Current' },
        { id: 'shared', name: 'Shared Current' }
      ]
    }, {
      fetchedAt: NOW - 1,
      models: [
        { id: 'stale', name: 'Stale Provider Name' },
        { id: 'manual' },
        { id: 'shared' }
      ]
    }), {
      fetchedAt: NOW,
      models: [
        { id: 'current', name: 'Current' },
        { id: 'shared', name: 'Shared Current' },
        { id: 'manual' }
      ]
    });
  });

  it('retains only manual model ids when connection settings change', () => {
    const original = {
      fetchedAt: NOW,
      models: [
        { id: 'discovered', name: 'Provider Name' },
        { id: 'manual' },
        { id: 'manual-empty-name', name: '   ' }
      ]
    };

    assert.deepEqual(retainManualAccountModelCache(original), {
      fetchedAt: 0,
      models: [
        { id: 'manual' },
        { id: 'manual-empty-name' }
      ]
    });
    assert.deepEqual(original, {
      fetchedAt: NOW,
      models: [
        { id: 'discovered', name: 'Provider Name' },
        { id: 'manual' },
        { id: 'manual-empty-name', name: '   ' }
      ]
    });
    assert.equal(retainManualAccountModelCache({
      fetchedAt: NOW,
      models: [{ id: 'discovered', name: 'Provider Name' }]
    }), undefined);
    assert.equal(retainManualAccountModelCache(undefined), undefined);
  });

  it('does not persist a slow discovery response after connection settings change', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createAccount({
      id: 'changing-account',
      provider: 'openai-compatible',
      apiKey: 'old-key',
      baseUrl: 'https://old.example.com/v1'
    });
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const refresh = refreshAccountModelCache(store, 'changing-account', {
      force: true,
      now: NOW,
      timeoutMs: 0,
      fetchImpl: async () => {
        await responseGate;
        return {
          ok: true,
          text: async () => JSON.stringify({ data: [{ id: 'old-model' }] })
        };
      }
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await store.updateAccount('changing-account', {
      apiKey: 'new-key',
      baseUrl: 'https://new.example.com/v1',
      modelCache: undefined
    });
    releaseResponse?.();

    assert.equal(await refresh, undefined);
    const latest = await store.getAccount('changing-account');
    assert.equal(latest?.apiKey, 'new-key');
    assert.equal(latest?.baseUrl, 'https://new.example.com/v1');
    assert.equal(latest?.modelCache, undefined);
  });
});
