import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import {
  MissingModelSourceApiKeyError,
  resolveModelSourceConfig
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

  it('returns an unconfigured snapshot when no source id is requested', async () => {
    const resolved = await resolveModelSourceConfig(undefined, vscode.Uri.file(storageRoot), {
      requireApiKey: false
    });
    assert.equal(resolved.sourceId, '');
    assert.equal(resolved.source, 'unconfigured');
    assert.equal(resolved.unconfigured, true);
    assert.equal(resolved.apiKey, '');
    assert.equal(resolved.supportsBilling, false);
  });

  it('throws when credentials are required but no source is configured', async () => {
    await assert.rejects(
      resolveModelSourceConfig(undefined, vscode.Uri.file(storageRoot), { language: 'en' }),
      MissingModelSourceApiKeyError
    );
  });

  it('resolves only the requested source and never chooses another source implicitly', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({ id: 'one', provider: 'deepseek', apiKey: 'one-key' });
    await store.createSource({
      id: 'two', provider: 'openai-compatible', apiKey: 'two-key', baseUrl: 'https://proxy.example.com/v1'
    });

    const resolved = await resolveModelSourceConfig('two', vscode.Uri.file(storageRoot), {
      sourceStore: store
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

  it('treats a missing or disabled source as unconfigured when inspection allows it', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({ id: 'disabled', provider: 'deepseek', apiKey: 'key', enabled: false });

    const missing = await resolveModelSourceConfig('missing', vscode.Uri.file(storageRoot), {
      sourceStore: store,
      requireApiKey: false
    });
    assert.equal(missing.source, 'unconfigured');
    assert.equal(missing.apiKey, '');

    const disabled = await resolveModelSourceConfig('disabled', vscode.Uri.file(storageRoot), {
      sourceStore: store,
      requireApiKey: false
    });
    assert.equal(disabled.source, 'unconfigured');
    assert.equal(disabled.apiKey, '');
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

  it('marks official DeepSeek sources as billing-capable', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({
      id: 'official',
      provider: 'deepseek',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com'
    });
    const resolved = await resolveModelSourceConfig('official', vscode.Uri.file(storageRoot), {
      sourceStore: store
    });
    assert.equal(resolved.supportsBilling, true);
  });

  it('resolves Responses credentials without enabling DeepSeek billing', async () => {
    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { now: () => NOW });
    await store.createSource({
      id: 'responses',
      provider: 'openai-responses',
      apiKey: 'responses-key',
      baseUrl: 'https://api.openai.com/v1'
    });
    const resolved = await resolveModelSourceConfig('responses', vscode.Uri.file(storageRoot), {
      sourceStore: store
    });
    assert.equal(resolved.provider, 'openai-responses');
    assert.equal(resolved.apiKey, 'responses-key');
    assert.equal(resolved.supportsBilling, false);
  });
});
