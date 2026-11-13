import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { KeepseekModel } from '../src/shared/types';
import * as vscodeStub from './stubs/vscode';

test('clipboard write acknowledgements reflect the completed host write and keep untracked callers silent', async () => {
  const stub = vscodeStub as unknown as { env?: { clipboard: { writeText(text: string): Promise<void> } } };
  const previousEnv = Object.getOwnPropertyDescriptor(stub, 'env');
  const posted: unknown[] = [];
  const written: string[] = [];
  let fail = false;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.defineProperty(stub, 'env', { configurable: true, writable: true, value: {
    clipboard: { writeText: async (text: string) => {
      written.push(text);
      if (fail) { throw new Error('Clipboard unavailable'); }
      await gate;
    } }
  } });
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    postToWebview: (message: unknown) => { posted.push(message); }
  }) as { writeClipboardText(text: string, requestId?: string): Promise<void> };
  try {
    const pending = host.writeClipboardText('copied text', 'write-ok');
    assert.deepEqual(written, ['copied text']);
    assert.deepEqual(posted, [], 'no acknowledgement is sent before the clipboard write finishes');
    release();
    await pending;
    assert.deepEqual(posted, [{ type: 'clipboardWriteResult', requestId: 'write-ok', ok: true }]);

    fail = true;
    await host.writeClipboardText('failed text', 'write-failed');
    assert.deepEqual(posted[1], { type: 'clipboardWriteResult', requestId: 'write-failed', ok: false });

    await host.writeClipboardText('untracked failure');
    fail = false;
    await host.writeClipboardText('untracked success');
    assert.equal(posted.length, 2, 'existing callers without request IDs receive no acknowledgements');
    assert.deepEqual(written, ['copied text', 'failed text', 'untracked failure', 'untracked success']);
  } finally {
    release();
    if (previousEnv) { Object.defineProperty(stub, 'env', previousEnv); }
    else { delete stub.env; }
  }
});

test('provider model-source refresh prevents stale catalog commits', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let reads = 0, stalePublications = 0, currentPublications = 0;
  const model = (id: string): KeepseekModel => ({ id, label: id, sourceId: `source-${id}`, provider: 'deepseek' });
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    modelSourceStateRefreshGeneration: 0, availableModels: [], modelSources: [],
    selectedModelId: 'b', selectedSourceId: 'source-b',
    balanceStore: { selectSource: () => {} },
    getBalanceSourceScope: (sourceId: string) => ({ provider: 'deepseek', sourceId }),
    persistModelSelection: async () => {},
    defaultModelStore: { refresh: async () => {
      const id = ++reads === 1 ? 'a' : 'b';
      if (id === 'a') { started(); await gate; }
      return { modelSources: [], availableModels: [model(id)], defaultModel: model(id) };
    } }
  }) as { refreshModelSourceState(options: { preserveAuthoritativeSelection: boolean; onResolved(): void }): Promise<void>;
    availableModels: KeepseekModel[]; selectedSourceId: string; selectedModelId: string };
  const stale = host.refreshModelSourceState({ preserveAuthoritativeSelection: true, onResolved: () => { stalePublications++; } });
  await reading;
  const current = host.refreshModelSourceState({ preserveAuthoritativeSelection: true, onResolved: () => { currentPublications++; } });
  release();
  await Promise.all([stale, current]);
  assert.equal(reads, 2);
  assert.equal(stalePublications, 0, 'the superseded catalog cannot publish');
  assert.equal(currentPublications, 1);
  assert.deepEqual(host.availableModels.map(item => item.id), ['b']);
  assert.equal(host.selectedSourceId, 'source-b');
  assert.equal(host.selectedModelId, 'b');
});

test('request credentials are resolved from the exact selected model source', async () => {
  const source = await readProviderSource();
  assert.match(
    source,
    /findModelBySelection\(models, \{ sourceId, modelId \}\)[\s\S]*?resolveModelSourceConfig\(model\.sourceId/u
  );
  assert.match(
    source,
    /const sourceConfig: ModelSourceConfigSnapshot = Object\.freeze\(\{[\s\S]*?sourceId: resolvedSource\.sourceId[\s\S]*?supportsBilling: resolvedSource\.supportsBilling/u
  );
  assert.doesNotMatch(source, /activeAccountId|resolveActiveAccountConfig|selectAccount/u);
});

test('source deletion scrubs cached credentials and cascades the balance record', async () => {
  const source = await readProviderSource();
  assert.match(
    source,
    /await this\.balanceStore\.deleteSource\(\{ provider: source\.provider, sourceId: source\.id \}\);[\s\S]*?await this\.sourceStore\.deleteSource\(source\.id\);[\s\S]*?this\.scrubDeletedModelSourceFromMemory\(source\.id\)/u
  );
  assert.match(
    source,
    /private scrubDeletedModelSourceFromMemory\(sourceId: string\): void \{[\s\S]*?this\.modelSourceStateRefreshGeneration \+= 1;[\s\S]*?this\.modelSources = this\.modelSources\.filter/u
  );
});

async function readProviderSource(): Promise<string> {
  return await readFile(path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'), 'utf8');
}
