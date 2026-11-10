import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KEEPSEEK_BASELINE_VERSION, KEEPSEEK_CONFIGURATION_NAMESPACE, KEEPSEEK_EXTENSION_ID, KEEPSEEK_STORAGE_NAMESPACE } from '../src/shared/identity';
import { getNativeStoragePath, getNativeStorageUri } from '../src/shared/storageRoot';
import * as vscode from './stubs/vscode';
import { getConfiguredAgentMaxExecutionMs, getConfiguredMaxFileBytes, getConfiguredModelRequestTimeoutMs, getSavedModelSelection } from '../src/shared/config';
import { getConfiguredKeepseekLanguage } from '../src/shared/i18n';
import { saveModelRequestTimeout } from '../src/provider/requestTimeoutSettings';

test('0.5.2 starts a distinct native data domain on each host platform', () => {
  assert.equal(KEEPSEEK_BASELINE_VERSION, '0.5.2');
  assert.equal(KEEPSEEK_EXTENSION_ID, 'kmvdata.keepseek');
  assert.equal(KEEPSEEK_STORAGE_NAMESPACE, 'com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'darwin', home: '/Users/example', env: {} }),
    '/Users/example/Library/Application Support/com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'linux', home: '/home/example', env: {} }),
    '/home/example/.local/share/com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'linux', home: '/home/example', env: { XDG_DATA_HOME: '/data' } }),
    '/data/com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'linux', home: '/home/example', env: { XDG_DATA_HOME: 'relative' } }),
    '/home/example/.local/share/com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'win32', home: 'C:\\Users\\example', env: { LOCALAPPDATA: 'D:\\Data' } }),
    'D:\\Data\\com.kmvdata.keepseek');
  assert.equal(getNativeStoragePath({ platform: 'win32', home: 'C:\\Users\\example', env: {} }),
    'C:\\Users\\example\\AppData\\Local\\com.kmvdata.keepseek');
});

test('native storage remains file-backed independently of VS Code virtual storage providers', () => {
  const uri = getNativeStorageUri();
  assert.equal(uri.scheme, 'file');
  assert.equal(uri.fsPath, getNativeStoragePath());
  const extension = readFileSync('src/extension.ts', 'utf8');
  assert.doesNotMatch(extension, /context\.globalStorageUri|migrateLegacyWorkspaceState|ensureKeybindings/u);
  assert.match(extension, /new GlobalSessionStorage\(storageUri,/u);
  assert.match(extension, /sessionStore,\s*storageUri,/u);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(`${manifest.publisher}.${manifest.name}`, KEEPSEEK_EXTENSION_ID);
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.ok(Object.keys(manifest.contributes.configuration.properties)
    .every(key => key.startsWith(`${KEEPSEEK_CONFIGURATION_NAMESPACE}.`)));
  assert.match(extension, /affectsConfiguration\(KEEPSEEK_CONFIGURATION_NAMESPACE\)/u);
});

test('current settings ignore the old namespace in every workspace and save only into the new namespace', async () => {
  const original = vscode.workspace.getConfiguration;
  const oldSettings: Record<string, unknown> = {
    maxFileBytes: 1, 'agent.maxExecutionMs': 1, language: 'en', modelRequestTimeoutSeconds: 300,
    selectedSourceId: 'old-source', selectedModelId: 'old-model'
  };
  const currentSettings: Record<string, unknown> = {};
  const reads: Array<string | undefined> = [];
  const writes: Array<{ section: string | undefined; key: string; target: number }> = [];
  vscode.workspace.getConfiguration = (section?: string) => {
    reads.push(section);
    const values = section === KEEPSEEK_CONFIGURATION_NAMESPACE ? currentSettings : oldSettings;
    return {
      get<T>(key: string, fallback: T): T { return (values[key] ?? fallback) as T; },
      inspect(key: string) { return key in values ? { globalValue: values[key], workspaceValue: values[key] } : undefined; },
      async update(key: string, value: unknown, target: number) {
        writes.push({ section, key, target });
        values[key] = value;
      }
    } as ReturnType<typeof original>;
  };
  try {
    assert.equal(getConfiguredMaxFileBytes(), 200_000);
    assert.equal(getConfiguredAgentMaxExecutionMs(), 0);
    assert.equal(getConfiguredModelRequestTimeoutMs(), 3_600_000);
    assert.deepEqual(getSavedModelSelection(), { sourceId: '', modelId: '' });
    assert.equal(writes.length, 0, 'reading the fresh baseline never scans or rewrites old settings');
    Object.assign(currentSettings, { maxFileBytes: 123_456, 'agent.maxExecutionMs': 500, language: 'en',
      selectedSourceId: 'new-source', selectedModelId: 'new-model' });
    assert.equal(getConfiguredMaxFileBytes(), 123_456);
    assert.equal(getConfiguredAgentMaxExecutionMs(), 500);
    assert.equal(getConfiguredKeepseekLanguage(), 'en');
    assert.deepEqual(getSavedModelSelection(), { sourceId: 'new-source', modelId: 'new-model' });
    assert.equal(await saveModelRequestTimeout(7200), true);
    assert.equal(getConfiguredModelRequestTimeoutMs(), 7_200_000);
    assert.deepEqual(writes, [{ section: KEEPSEEK_CONFIGURATION_NAMESPACE, key: 'modelRequestTimeoutSeconds',
      target: vscode.ConfigurationTarget.Global }]);
    assert.ok(reads.every(section => section === KEEPSEEK_CONFIGURATION_NAMESPACE));
    assert.equal(oldSettings.modelRequestTimeoutSeconds, 300, 'old configuration is neither imported nor rewritten');
  } finally { vscode.workspace.getConfiguration = original; }
});
