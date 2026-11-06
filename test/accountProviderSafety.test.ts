import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { KeepseekModel } from '../src/shared/types';

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
