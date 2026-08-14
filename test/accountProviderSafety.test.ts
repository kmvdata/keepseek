import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';

test('provider account state prevents stale refresh commits and stale secret payloads', async () => {
  const source = await readProviderSource();

  assert.match(source, /private accountStateRefreshGeneration = 0/u);
  assert.match(source, /const generation = \+\+this\.accountStateRefreshGeneration/u);
  assert.match(source, /if \(generation !== this\.accountStateRefreshGeneration\) \{\s*return;/u);
  assert.match(
    source,
    /const useLegacyFallback = !activeAccount && this\.activeAccountConfig\?\.legacyFallback === true/u
  );
  assert.match(
    source,
    /const legacyApiKey = useLegacyFallback && this\.activeAccountConfig\?\.source === 'legacy-config'[\s\S]*?apiKey: activeAccount\?\.apiKey \?\? legacyApiKey/u
  );
});

test('legacy save recreates an initialized empty default and deletion scrubs cached credentials', async () => {
  const source = await readProviderSource();

  assert.match(
    source,
    /this\.activeAccountConfig\?\.source === 'unconfigured'[\s\S]*?this\.accounts\.length === 0[\s\S]*?upsertDefaultAccount\([\s\S]*?activeAccountId', DEFAULT_ACCOUNT_ID/u
  );
  assert.match(
    source,
    /await this\.accountStore\.deleteAccount\(account\.id\);\s*accountRemoved = true;\s*this\.scrubDeletedAccountFromMemory\(account\.id\)/u
  );
  assert.match(
    source,
    /private scrubDeletedAccountFromMemory\(accountId: string\): void \{[\s\S]*?this\.accountStateRefreshGeneration \+= 1;[\s\S]*?this\.accounts = this\.accounts\.filter/u
  );
  assert.match(
    source,
    /catch \(error\) \{\s*try \{\s*await this\.refreshAccountState\(\);[\s\S]*?if \(accountRemoved\) \{\s*this\.scrubDeletedAccountFromMemory\(account\.id\)/u
  );
});

test('connection changes discard discovered names without dropping manual model ids', async () => {
  const source = await readProviderSource();

  assert.match(
    source,
    /activeAccount\.baseUrl === baseUrl && activeAccount\.apiKey === apiKey[\s\S]*?: retainManualAccountModelCache\(activeAccount\.modelCache\)/u
  );
  assert.match(
    source,
    /modelCache: connectionChanged[\s\S]*?\? retainManualAccountModelCache\(account\.modelCache\)[\s\S]*?: account\.modelCache/u
  );
});

async function readProviderSource(): Promise<string> {
  return await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );
}
