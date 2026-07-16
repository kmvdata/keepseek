import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { getInputScript } from '../src/webview/input/script';

test('contributes editor, Explorer, and terminal context commands', async () => {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    contributes?: {
      commands?: Array<{ command?: string }>;
      menus?: Record<string, Array<{ command?: string; when?: string }>>;
    };
  };
  const commandIds = new Set((packageJson.contributes?.commands ?? []).map((command) => command.command));
  const menus = packageJson.contributes?.menus ?? {};

  assert.ok(commandIds.has('keepseek.addSelectionToContext'));
  assert.ok(commandIds.has('keepseek.addExplorerFileToContext'));
  assert.ok(commandIds.has('keepseek.addExplorerDirectoryToContext'));
  assert.ok(commandIds.has('keepseek.addTerminalSelectionToContext'));
  assert.ok(menus['editor/context']?.some((item) => item.command === 'keepseek.addSelectionToContext'));
  assert.ok(menus['explorer/context']?.some((item) => item.command === 'keepseek.addExplorerFileToContext'));
  assert.ok(menus['explorer/context']?.some((item) => item.command === 'keepseek.addExplorerDirectoryToContext'));
  const terminalSelectionMenu = menus['terminal/context']?.find(
    (item) => item.command === 'keepseek.addTerminalSelectionToContext'
  );
  assert.ok(terminalSelectionMenu);
  assert.equal(terminalSelectionMenu.when, 'terminalTextSelected');
});

test('provider focuses the contributed KeepSeek view container before inserting references', async () => {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const providerPath = path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    contributes?: { viewsContainers?: { activitybar?: Array<{ id?: string }> } };
  };
  const providerSource = await readFile(providerPath, 'utf8');
  const containerIds = packageJson.contributes?.viewsContainers?.activitybar?.map((container) => container.id) ?? [];
  const match = /const CHAT_CONTAINER_ID = '([^']+)'/u.exec(providerSource);

  assert.ok(match);
  assert.ok(containerIds.includes(match[1]));
});

test('rich prompt script exposes reference, skill, and external drop entry points', () => {
  const script = getInputScript();

  assert.match(script, /character === '\$'/u);
  assert.match(script, /character === '@'/u);
  assert.match(script, /application\/vnd\.code\.uri-list/u);
  assert.match(script, /insertDroppedFileReferences/u);
  assert.match(script, /getPromptInsertionRange/u);
});
