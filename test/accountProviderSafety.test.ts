import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';

test('provider model-source refresh prevents stale catalog commits', async () => {
  const source = await readProviderSource();
  assert.match(source, /private modelSourceStateRefreshGeneration = 0/u);
  assert.match(source, /const generation = \+\+this\.modelSourceStateRefreshGeneration/u);
  assert.match(source, /if \(generation !== this\.modelSourceStateRefreshGeneration\) \{\s*return;/u);
  assert.match(source, /const availableModels = createModelCatalog\(modelSources\)/u);
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
