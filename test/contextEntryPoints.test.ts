import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { getTemplate } from '../src/webview/template';

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

test('command menu model settings are registered and persisted for the current workspace', async () => {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const providerPath = path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    contributes?: {
      configuration?: {
        properties?: Record<string, { type?: string; default?: unknown; scope?: string; enum?: unknown[] }>;
      };
    };
  };
  const properties = packageJson.contributes?.configuration?.properties ?? {};
  const providerSource = await readFile(providerPath, 'utf8');

  assert.deepEqual(properties['keepseek.selectedModelId'], {
    type: 'string',
    default: '',
    scope: 'window',
    markdownDescription: 'Selected model for the current workspace. An empty or unavailable value falls back to the first supported model.'
  });
  assert.deepEqual(properties['keepseek.thinkingEnabled'], {
    type: 'boolean',
    default: true,
    scope: 'window',
    markdownDescription: 'Enable Thinking mode for the current workspace.'
  });
  assert.deepEqual(properties['keepseek.reasoningEffort'], {
    type: 'string',
    default: 'high',
    scope: 'window',
    enum: ['high', 'max'],
    markdownDescription: 'Thinking effort for the current workspace.'
  });
  assert.match(
    providerSource,
    /config\.update\('selectedModelId', modelId, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.match(
    providerSource,
    /config\.update\('thinkingEnabled', this\.agentSettings\.thinkingEnabled, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.match(
    providerSource,
    /config\.update\('reasoningEffort', this\.agentSettings\.reasoningEffort, vscode\.ConfigurationTarget\.Workspace\)/u
  );
});

test('rich prompt script exposes reference, skill, and external drop entry points', () => {
  const script = getInputScript();

  assert.match(script, /character === '\$'/u);
  assert.match(script, /character === '@'/u);
  assert.match(script, /application\/vnd\.code\.uri-list/u);
  assert.match(script, /insertDroppedFileReferences/u);
  assert.match(script, /getPromptInsertionRange/u);
});

test('reference menu puts the external resource picker before workspace resources by default', () => {
  const script = getInputScript();

  assert.match(script, /return \[createExternalPickerReferenceEntry\(\)\]\.concat\(resources\)/u);
  assert.match(
    script,
    /var loadingEntries = shouldShowExternalPickerReferenceEntry\(\) \? \[createExternalPickerReferenceEntry\(\)\] : \[\]/u
  );
});

test('background runs use an on-demand command instead of an always-visible launcher', () => {
  const mainTemplate = getTemplate();
  const inputTemplate = getInputTemplate();
  const backgroundRegion = /<section id="backgroundRegion"[\s\S]*?<\/section>/u.exec(mainTemplate)?.[0] ?? '';

  assert.match(backgroundRegion, /class="background-region hidden"/u);
  assert.doesNotMatch(backgroundRegion, /id="backgroundStart"/u);
  assert.match(inputTemplate, /id="commandBackgroundRunButton"/u);
  assert.match(inputTemplate, /id="backgroundRunDialogOverlay" class="settings-overlay hidden"/u);
});

test('Project Memory add/edit UI and blocking browser dialogs are removed', () => {
  const mainTemplate = getTemplate();
  const inputTemplate = getInputTemplate();
  const script = getInputScript();

  assert.doesNotMatch(mainTemplate, /projectMemoryTab|memoryAddButton|memoryPanel/u);
  assert.doesNotMatch(`${mainTemplate}\n${inputTemplate}\n${script}`, /window\.(?:prompt|alert|confirm)\s*\(/u);
  assert.doesNotMatch(script, /proposeMemory|applyMemory|discardMemory|deleteMemory/u);
});

test('retired Project Memory configuration keys are no longer contributed', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
    contributes?: { configuration?: { properties?: Record<string, unknown> } };
  };
  const keys = Object.keys(packageJson.contributes?.configuration?.properties ?? {});

  assert.ok(!keys.some((key) => key.startsWith('keepseek.memory.')));
  assert.ok(keys.includes('keepseek.projectInstructions.contextBudgetTokens'));
  assert.ok(keys.includes('keepseek.skills.maxImplicitActivations'));
});

test('Legacy Memory migration command is hidden by default and appears only from detected state', () => {
  const inputTemplate = getInputTemplate();
  const script = getInputScript();

  assert.match(inputTemplate, /id="commandLegacyMemorySection" class="command-section hidden"/u);
  assert.match(script, /var visible = migration\.detected === true/u);
  assert.match(script, /classList\.toggle\('hidden', !visible\)/u);
  assert.match(script, /createLegacyMemoryMigrationDraft/u);
});

test('generated Webview JavaScript passes syntax compilation', () => {
  assert.doesNotThrow(() => new Function(getScript()));
});
