import './registerVscodeStub';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import {
  AccountStore,
  normalizeAccount,
  normalizeAccountModelCache,
  normalizeModelAliases
} from '../src/accounts/accountStore';

const NOW = 1_710_000_000_000;

describe('AccountStore', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-accounts-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('normalizes account schema, aliases, model cache, and timestamps', () => {
    const account = normalizeAccount({
      id: ' account-1 ',
      name: ' My Account ',
      provider: 'deepseek',
      apiKey: ' sk-secret ',
      baseUrl: ' https://proxy.example.com/v1 ',
      modelAliases: {
        ' model-a ': ' Daily ',
        'model-b': '   ',
        'model-c': 123
      },
      modelCache: {
        models: [
          { id: ' model-a ', name: ' Model A ' },
          { id: 'model-a', name: ' duplicate' },
          { id: 'model-b' },
          { name: 'missing id' }
        ],
        fetchedAt: NOW - 100
      },
      enabled: false,
      createdAt: 'invalid',
      updatedAt: NOW - 200
    }, { now: NOW });

    assert.deepEqual(account, {
      id: 'account-1',
      name: 'My Account',
      provider: 'deepseek',
      apiKey: 'sk-secret',
      baseUrl: 'https://proxy.example.com/v1',
      modelAliases: { 'model-a': 'Daily' },
      modelCache: {
        models: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b' }
        ],
        fetchedAt: NOW - 100
      },
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW
    });
    assert.equal(normalizeAccount({ id: '../escape', provider: 'deepseek' }, { now: NOW }), undefined);
    assert.equal(normalizeAccount({ id: 'a', provider: 'anthropic' }, { now: NOW }), undefined);
    assert.deepEqual(normalizeModelAliases(null), {});
    assert.equal(normalizeAccountModelCache({ models: 'invalid' }), undefined);
  });

  it('creates, lists, updates, and physically deletes provider-scoped account files', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'generated-id'
    });
    const created = await store.createAccount({
      provider: 'openai-compatible',
      name: 'Proxy',
      apiKey: 'proxy-key',
      baseUrl: 'https://proxy.example.com/v1'
    });
    assert.equal(created.id, 'generated-id');
    assert.equal(created.provider, 'openai-compatible');
    assert.equal(await store.hasStoredAccountFiles(), true);

    const storedPath = path.join(
      storageRoot,
      'accounts',
      'openai-compatible',
      'generated-id.json'
    );
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { apiKey: string };
    assert.equal(stored.apiKey, 'proxy-key');
    assert.equal((await store.listAccounts()).length, 1);

    const updated = await store.updateAccount('generated-id', {
      name: 'Renamed',
      modelAliases: { 'proxy-model': 'Fast' }
    });
    assert.equal(updated?.name, 'Renamed');
    assert.deepEqual(updated?.modelAliases, { 'proxy-model': 'Fast' });

    assert.equal((await store.deleteAccount('generated-id'))?.id, 'generated-id');
    await assert.rejects(access(storedPath));
    assert.equal(await store.hasStoredAccountFiles(), false);
    assert.equal(await store.isStorageInitialized(), true);
  });

  it('ignores damaged and path-mismatched JSON while preserving other accounts', async () => {
    const deepseekDir = path.join(storageRoot, 'accounts', 'deepseek');
    await mkdir(deepseekDir, { recursive: true });
    await writeFile(path.join(deepseekDir, 'broken.json'), 'not-json{{', 'utf8');
    await writeFile(path.join(deepseekDir, 'mismatch.json'), JSON.stringify({
      id: 'different-id',
      provider: 'deepseek',
      apiKey: 'do-not-load'
    }), 'utf8');

    const store = new AccountStore(vscode.Uri.file(storageRoot), {
      now: () => NOW,
      createId: () => 'healthy-id'
    });
    await store.createAccount({
      provider: 'openai-compatible',
      apiKey: 'healthy-key',
      baseUrl: 'https://proxy.example.com/v1'
    });

    const accounts = await store.listAccounts();
    assert.deepEqual(accounts.map((account) => account.id), ['healthy-id']);
    assert.equal(await store.hasStoredAccountFiles(), true);
  });

  it('creates the legacy default without overwriting an existing account', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const first = await store.upsertDefaultAccount({
      apiKey: 'first-key',
      baseUrl: 'https://first.example.com'
    });
    const second = await store.upsertDefaultAccount({
      apiKey: 'second-key',
      baseUrl: 'https://second.example.com'
    });

    assert.equal(first.id, 'default');
    assert.equal(second.apiKey, 'first-key');
    assert.equal(second.baseUrl, 'https://first.example.com');
  });
});
