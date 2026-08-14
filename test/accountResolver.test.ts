import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import {
  MissingModelSourceApiKeyError,
  resolveModelSourceConfig,
  shouldMigrateLegacySource,
  type ModelSourceConfigurationReader
} from '../src/accounts/accountResolver';

const NOW = 1_710_000_000_000;

describe('resolveModelSourceConfig', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-source-resolver-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('keeps legacy and environment values only as unconfigured compatibility snapshots', async () => {
    const legacy = await resolveModelSourceConfig(undefined, undefined, {
      configuration: configuration({ apiKey: ' legacy-key ', baseUrl: ' https://legacy.example.com/v1 ' }),
      environmentApiKey: 'env-key',
      requireApiKey: false
    });
    assert.equal(legacy.sourceId, '');
    assert.equal(legacy.apiKey, 'legacy-key');
    assert.equal(legacy.source, 'legacy-config');
    assert.equal(legacy.unconfigured, true);
    assert.equal(legacy.supportsBilling, false);

    const environment = await resolveModelSourceConfig(undefined, undefined, {
      configuration: configuration({ apiKey: '', baseUrl: '' }),
      environmentApiKey: ' env-key ',
      requireApiKey: false
    });
    assert.equal(environment.apiKey, 'env-key');
    assert.equal(environment.source, 'environment');

    await assert.rejects(
      resolveModelSourceConfig(undefined, undefined, { environmentApiKey: 'env-key', language: 'en' }),
      MissingModelSourceApiKeyError
    );
  });

  it('migrates a non-empty legacy key once and resolves the explicit default source', async () => {
    assert.equal(shouldMigrateLegacySource({ hasStoredSourceFiles: false, legacyApiKey: ' key ' }), true);
    assert.equal(shouldMigrateLegacySource({ hasStoredSourceFiles: true, legacyApiKey: 'key' }), false);
    assert.equal(shouldMigrateLegacySource({ hasStoredSourceFiles: false, legacyApiKey: '   ' }), false);

    const resolved = await resolveModelSourceConfig('default', vscode.Uri.file(storageRoot), {
      configuration: configuration({ apiKey: 'legacy-key', baseUrl: 'https://api.deepseek.com/v1' }),
      environmentApiKey: '',
      now: NOW
    });
    assert.equal(resolved.sourceId, 'default');
    assert.equal(resolved.source, 'migration');
    assert.equal(resolved.apiKey, 'legacy-key');
    assert.equal(resolved.supportsBilling, true);

    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    const migrated = await store.getSourceByProvider('deepseek', 'default');
    assert.equal(migrated?.baseUrl, 'https://api.deepseek.com/v1');
  });

  it('resolves only the requested source and never chooses another source implicitly', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({ id: 'one', provider: 'deepseek', apiKey: 'one-key' });
    await store.createSource({
      id: 'two', provider: 'openai-compatible', apiKey: 'two-key', baseUrl: 'https://proxy.example.com/v1'
    });

    const resolved = await resolveModelSourceConfig('two', vscode.Uri.file(storageRoot), {
      sourceStore: store,
      legacyApiKey: 'legacy-key'
    });
    assert.equal(resolved.sourceId, 'two');
    assert.equal(resolved.provider, 'openai-compatible');
    assert.equal(resolved.apiKey, 'two-key');
    assert.equal(resolved.supportsBilling, false);
    await assert.rejects(
      resolveModelSourceConfig('missing', vscode.Uri.file(storageRoot), { sourceStore: store }),
      MissingModelSourceApiKeyError
    );
  });

  it('suppresses migration when a damaged legacy account JSON exists', async () => {
    const providerDir = path.join(storageRoot, 'accounts', 'deepseek');
    await mkdir(providerDir, { recursive: true });
    await writeFile(path.join(providerDir, 'broken.json'), 'invalid', 'utf8');

    const resolved = await resolveModelSourceConfig(undefined, vscode.Uri.file(storageRoot), {
      legacyApiKey: 'legacy-key',
      legacyBaseUrl: 'https://legacy.example.com',
      environmentApiKey: '',
      requireApiKey: false
    });
    assert.equal(resolved.source, 'legacy-config');
    assert.equal(resolved.unconfigured, true);
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot));
    assert.equal(await store.getSource('default'), undefined);
  });

  it('allows settings to inspect an empty-key source while runtime rejects it', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({ id: 'empty', provider: 'deepseek', apiKey: '' });

    const settings = await resolveModelSourceConfig('empty', vscode.Uri.file(storageRoot), {
      sourceStore: store,
      requireApiKey: false
    });
    assert.equal(settings.sourceId, 'empty');
    assert.equal(settings.apiKey, '');

    await assert.rejects(
      resolveModelSourceConfig('empty', vscode.Uri.file(storageRoot), { sourceStore: store, language: 'en' }),
      (error: unknown) => error instanceof MissingModelSourceApiKeyError
        && error.message === 'Add a model and configure its API Key in KeepSeek settings first.'
    );
  });

  it('does not recreate a deleted final source from the preserved legacy key', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await resolveModelSourceConfig('default', vscode.Uri.file(storageRoot), {
      sourceStore: store,
      legacyApiKey: 'preserved-legacy-key',
      environmentApiKey: ''
    });
    await store.deleteSource('default');

    const afterDelete = await resolveModelSourceConfig(undefined, vscode.Uri.file(storageRoot), {
      sourceStore: store,
      legacyApiKey: 'preserved-legacy-key',
      environmentApiKey: '',
      requireApiKey: false
    });
    assert.equal(afterDelete.source, 'unconfigured');
    assert.equal(afterDelete.apiKey, '');
    assert.equal(await store.getSource('default'), undefined);
  });
});

function configuration(values: Record<string, string>): ModelSourceConfigurationReader {
  return {
    get<T>(section: string, defaultValue: T): T {
      return (Object.prototype.hasOwnProperty.call(values, section) ? values[section] : defaultValue) as T;
    }
  };
}
