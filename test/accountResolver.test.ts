import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { AccountStore } from '../src/accounts/accountStore';
import {
  MissingAccountApiKeyError,
  resolveActiveAccountConfig,
  shouldMigrateLegacyAccount,
  type AccountConfigurationReader
} from '../src/accounts/accountResolver';

const NOW = 1_710_000_000_000;

describe('resolveActiveAccountConfig', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-account-resolver-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('keeps the no-storage legacy config and environment fallback behavior', async () => {
    const legacy = await resolveActiveAccountConfig(undefined, {
      configuration: configuration({
        apiKey: ' legacy-key ',
        baseUrl: ' https://legacy.example.com/v1 '
      }),
      environmentApiKey: 'env-key',
      language: 'en'
    });
    assert.equal(legacy.apiKey, 'legacy-key');
    assert.equal(legacy.baseUrl, 'https://legacy.example.com/v1');
    assert.equal(legacy.source, 'legacy-config');
    assert.equal(legacy.legacyFallback, true);

    const environment = await resolveActiveAccountConfig(undefined, {
      configuration: configuration({ apiKey: '', baseUrl: '' }),
      environmentApiKey: ' env-key '
    });
    assert.equal(environment.apiKey, 'env-key');
    assert.equal(environment.baseUrl, 'https://api.deepseek.com');
    assert.equal(environment.source, 'environment');
  });

  it('migrates only a non-empty legacy key when no account JSON exists', async () => {
    assert.equal(shouldMigrateLegacyAccount({ hasStoredAccountFiles: false, legacyApiKey: ' key ' }), true);
    assert.equal(shouldMigrateLegacyAccount({ hasStoredAccountFiles: true, legacyApiKey: 'key' }), false);
    assert.equal(shouldMigrateLegacyAccount({ hasStoredAccountFiles: false, legacyApiKey: '   ' }), false);

    const resolved = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      configuration: configuration({
        activeAccountId: '',
        apiKey: 'legacy-key',
        baseUrl: 'https://api.deepseek.com/v1'
      }),
      environmentApiKey: '',
      now: NOW
    });
    assert.equal(resolved.accountId, 'default');
    assert.equal(resolved.source, 'migration');
    assert.equal(resolved.legacyFallback, false);
    assert.equal(resolved.apiKey, 'legacy-key');

    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const migrated = await store.getAccountByProvider('deepseek', 'default');
    assert.equal(migrated?.apiKey, 'legacy-key');
    assert.equal(migrated?.baseUrl, 'https://api.deepseek.com/v1');
  });

  it('does not migrate over an existing account and honors activeAccountId', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createAccount({
      id: 'one',
      provider: 'deepseek',
      apiKey: 'one-key'
    });
    await store.createAccount({
      id: 'two',
      provider: 'openai-compatible',
      apiKey: 'two-key',
      baseUrl: 'https://proxy.example.com/v1'
    });

    const resolved = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      accountStore: store,
      activeAccountId: 'two',
      legacyApiKey: 'legacy-key',
      legacyBaseUrl: 'https://legacy.example.com',
      environmentApiKey: ''
    });
    assert.equal(resolved.accountId, 'two');
    assert.equal(resolved.provider, 'openai-compatible');
    assert.equal(resolved.apiKey, 'two-key');
    assert.equal(await store.getAccount('default'), undefined);
  });

  it('treats damaged account JSON as non-loadable but suppresses migration overwrite', async () => {
    const providerDir = path.join(storageRoot, 'accounts', 'deepseek');
    await mkdir(providerDir, { recursive: true });
    await writeFile(path.join(providerDir, 'broken.json'), 'invalid', 'utf8');

    const resolved = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      legacyApiKey: 'legacy-key',
      legacyBaseUrl: 'https://legacy.example.com',
      environmentApiKey: '',
      now: NOW
    });
    assert.equal(resolved.source, 'legacy-config');
    assert.equal(resolved.legacyFallback, true);
    const store = new AccountStore(vscode.Uri.file(storageRoot));
    assert.equal(await store.getAccount('default'), undefined);
  });

  it('can resolve an empty-key account for settings while runtime resolution rejects it', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createAccount({ id: 'empty', provider: 'deepseek', apiKey: '' });

    const settings = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      accountStore: store,
      activeAccountId: 'empty',
      legacyApiKey: '',
      environmentApiKey: '',
      requireApiKey: false
    });
    assert.equal(settings.accountId, 'empty');
    assert.equal(settings.apiKey, '');

    await assert.rejects(
      resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
        accountStore: store,
        activeAccountId: 'empty',
        legacyApiKey: '',
        environmentApiKey: '',
        language: 'en'
      }),
      (error: unknown) => error instanceof MissingAccountApiKeyError
        && error.message === 'Save a DeepSeek API Key in KeepSeek Settings > Api Key, or set the DEEPSEEK_API_KEY environment variable.'
    );
  });

  it('does not recreate a deleted last account from the preserved legacy key', async () => {
    const store = new AccountStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const migrated = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      accountStore: store,
      legacyApiKey: 'preserved-legacy-key',
      environmentApiKey: '',
      now: NOW
    });
    assert.equal(migrated.source, 'migration');
    await store.deleteAccount('default');

    const afterDelete = await resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      accountStore: store,
      legacyApiKey: 'preserved-legacy-key',
      environmentApiKey: '',
      now: NOW + 1,
      requireApiKey: false
    });
    assert.equal(afterDelete.source, 'unconfigured');
    assert.equal(afterDelete.apiKey, '');
    assert.equal(afterDelete.legacyFallback, false);
    assert.equal(await store.getAccount('default'), undefined);
    await assert.rejects(resolveActiveAccountConfig(vscode.Uri.file(storageRoot), {
      accountStore: store,
      legacyApiKey: 'preserved-legacy-key',
      environmentApiKey: '',
      now: NOW + 1
    }), MissingAccountApiKeyError);
  });
});

function configuration(values: Record<string, string>): AccountConfigurationReader {
  return {
    get<T>(section: string, defaultValue: T): T {
      return (Object.prototype.hasOwnProperty.call(values, section)
        ? values[section]
        : defaultValue) as T;
    }
  };
}
