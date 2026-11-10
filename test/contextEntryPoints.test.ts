import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { getStyles } from '../src/webview/styles';
import { getTemplate } from '../src/webview/template';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { commandSkillsImplementationFragment } from '../src/webview/input/commandMenu/skills';
import { composerSerializationFragment } from '../src/webview/input/composer/serialization';
import { referenceMenuImplementationFragment } from '../src/webview/input/references/menu';
import { skillsImplementationFragment } from '../src/webview/input/skills/script';
import { createWebviewDomHarness } from './webviewDomHarness';
import { focusView } from '../src/provider/focusView';
import { clearCommandHandlers, setCommandHandler } from './stubs/vscode';

test('history fills the shared horizontal gutter and wraps controls in narrow views', () => {
  const styles = getStyles();
  const menu = styles.match(/\.session-menu\s*\{([^}]+)\}/u)?.[1] ?? '';
  assert.match(menu, /left:\s*var\(--keepseek-edge-padding\)/u);
  assert.match(menu, /right:\s*var\(--keepseek-edge-padding\)/u);
  assert.match(menu, /width:\s*auto/u);
  assert.doesNotMatch(menu, /380px|100vw/u);
  assert.match(styles, /\.session-menu-controls\s*\{[^}]*flex-wrap:\s*wrap/u);
});

test('header timeout dropdown offers exactly six presets with a one-hour default in both languages', async () => {
  const template = getTemplate();
  const select = template.match(/<select id="settingsRequestTimeoutValue"[^>]*>([\s\S]*?)<\/select>/u)?.[1] ?? '';
  const options = [...select.matchAll(/<option value="(\d+)" data-i18n="([^"]+)"( selected)?>([^<]+)<\/option>/gu)];
  assert.deepEqual(options.map((option) => Number(option[1])), [300, 900, 3600, 7200, 28800, 86400]);
  assert.deepEqual(options.filter((option) => option[3]).map((option) => option[1]), ['3600']);
  assert.deepEqual(options.map((option) => option[4]), ['5 分钟', '15 分钟', '1 小时', '2 小时', '8 小时', '24 小时']);
  assert.deepEqual(options.map((option) => WEBVIEW_TRANSLATIONS.en[option[2]]),
    ['5 minutes', '15 minutes', '1 hour', '2 hours', '8 hours', '24 hours']);
  assert.match(template, /<label for="settingsRequestTimeoutValue"/u);
  const manifest = JSON.parse(await readFile(path.resolve(process.cwd(), 'package.json'), 'utf8'));
  const setting = manifest.contributes.configuration.properties['kmvdata.keepseek.modelRequestTimeoutSeconds'];
  assert.deepEqual(setting.enum, [300, 900, 3600, 7200, 28800, 86400]);
  assert.equal(setting.default, 3600);
  assert.equal(setting.scope, 'application');
});

test('timeout dropdown saves in place, prevents overlapping saves and restores the host value on completion', () => {
  const script = getScript();
  const binding = script.slice(script.indexOf('    if (settingsRequestTimeoutValue) {'),
    script.indexOf('    if (settingsHistoryMenuItem) {'));
  const render = script.match(/      if \(settingsRequestTimeoutValue\) \{[\s\S]*?\n      \}/u)?.[0];
  const result = script.match(/      if \(message.type === 'requestTimeoutSettingsResult'\) \{([\s\S]*?)\n      \} else if/u)?.[1];
  assert.ok(render);
  assert.ok(result);
  const harness = new Function(`
    const requestTimeoutPresets = [300, 900, 3600, 7200, 28800, 86400];
    const state = { modelRequestTimeoutSeconds: 3600, isBusy: false };
    let pendingModelRequestTimeoutSeconds = null;
    let pendingModelRequestTimeoutFocus = false;
    const settingsMenuOpen = true;
    const sent = [], handlers = {};
    const vscode = { postMessage: message => sent.push(message) };
    const settingsRequestTimeoutValue = { value: '3600', disabled: false,
      focus: () => { document.activeElement = settingsRequestTimeoutValue; },
      addEventListener: (event, handler) => { handlers[event] = handler; } };
    const document = { body: {}, activeElement: settingsRequestTimeoutValue };
    function renderSettingsControls() { ${render} }
    ${binding}
    return { sent, state, document, select: settingsRequestTimeoutValue,
      change: value => {
        settingsRequestTimeoutValue.value = value;
        handlers.change({ stopPropagation() {} });
        if (settingsRequestTimeoutValue.disabled) document.activeElement = document.body;
      },
      acknowledge: seconds => { const message = { seconds }; ${result} }
    };
  `)() as {
    sent: unknown[]; state: { isBusy: boolean }; document: { activeElement: unknown };
    select: { value: string; disabled: boolean };
    change(value: string): void; acknowledge(seconds: number): void;
  };
  harness.change('3600');
  harness.change('600');
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.select.value, '3600');
  harness.change('7200');
  assert.deepEqual(harness.sent, [{ type: 'setModelRequestTimeout', seconds: 7200 }]);
  assert.equal(harness.select.disabled, true);
  harness.change('86400');
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.select.value, '7200');
  harness.acknowledge(7200);
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.document.activeElement, harness.select, 'restore focus after the save');
  harness.change('28800');
  const otherControl = {};
  harness.document.activeElement = otherControl;
  harness.acknowledge(7200); // A failed save restores the last persisted choice.
  assert.equal(harness.select.value, '7200');
  assert.equal(harness.select.disabled, false);
  assert.equal(harness.document.activeElement, otherControl, 'do not steal focus after the user moves away');
  harness.state.isBusy = true;
  harness.change('300');
  assert.equal(harness.sent.length, 2);
});

test('contributes concise English editor, Explorer, and Windows-friendly terminal context commands', async () => {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    contributes?: {
      commands?: Array<{ command?: string; title?: string; icon?: string }>;
      keybindings?: Array<{ command?: string; key?: string; when?: string }>;
      menus?: Record<string, Array<{ command?: string; when?: string }>>;
    };
  };
  const commands = packageJson.contributes?.commands ?? [];
  const commandIds = new Set((packageJson.contributes?.commands ?? []).map((command) => command.command));
  const keybindings = packageJson.contributes?.keybindings ?? [];
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
  assert.equal(terminalSelectionMenu?.when, 'terminalTextSelected');
  assert.equal(
    commands.find((command) => command.command === 'keepseek.addSelectionToContext')?.title,
    'KeepSeek: Add to Context'
  );
  assert.equal(
    commands.find((command) => command.command === 'keepseek.addTerminalSelectionToContext')?.title,
    'KeepSeek: Add to Context'
  );
  assert.equal(
    commands.find((command) => command.command === 'keepseek.addDebugConsoleSelectionToContext')?.title,
    'KeepSeek: Add to Context'
  );
  assert.equal(
    commands.find((command) => command.command === 'keepseek.addExplorerFileToContext')?.title,
    'KeepSeek: Add File to Context'
  );

  const terminalKeybinding = keybindings.find(
    (binding) => binding.command === 'keepseek.addTerminalSelectionToContext'
  );
  assert.equal(terminalKeybinding?.key, 'ctrl+shift+l');
  assert.equal(terminalKeybinding?.when, 'terminalFocus && terminalTextSelectedInFocused');

  const windowsTerminalTitleAction = menus['view/title']?.find(
    (item) => item.command === 'keepseek.addTerminalSelectionToContext'
  );
  assert.equal(windowsTerminalTitleAction?.when, 'view == terminal && isWindows && terminalTextSelected');
});

test('KeepSeek contributes one secondary sidebar view and preserves its existing focus identities', async () => {
  const packagePath = path.resolve(process.cwd(), 'package.json');
  const providerPath = path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    engines?: { vscode?: string };
    contributes?: {
      viewsContainers?: Record<string, Array<{ id?: string }>>;
      views?: Record<string, Array<{ id?: string; type?: string }>>;
    };
  };
  const providerSource = await readFile(providerPath, 'utf8');
  const containers = packageJson.contributes?.viewsContainers ?? {};
  const containerId = /const CHAT_CONTAINER_ID = '([^']+)'/u.exec(providerSource)?.[1];
  const viewId = /const CHAT_VIEW_TYPE = '([^']+)'/u.exec(providerSource)?.[1];

  assert.equal(packageJson.engines?.vscode, '^1.106.0');
  assert.equal(containerId, 'keepseek-sidebar');
  assert.equal(viewId, 'keepseek.chat');
  assert.deepEqual(Object.keys(containers), ['secondarySidebar']);
  assert.deepEqual(containers.secondarySidebar?.map(container => container.id), [containerId]);
  assert.deepEqual(Object.keys(packageJson.contributes?.views ?? {}), [containerId]);
  assert.deepEqual(packageJson.contributes?.views?.[containerId]?.map(view => ({ id: view.id, type: view.type })),
    [{ id: viewId, type: 'webview' }]);
});

test('opening the KeepSeek view waits for its container before focusing the chat', async () => {
  const events: string[] = [];
  let completeContainerOpen!: () => void;
  const containerOpened = new Promise<void>(resolve => { completeContainerOpen = resolve; });
  setCommandHandler('workbench.view.extension.keepseek-sidebar', async () => {
    events.push('open-container');
    await containerOpened;
    events.push('container-opened');
  });
  setCommandHandler('keepseek.chat.focus', () => { events.push('focus-chat'); });
  try {
    const opening = focusView('keepseek-sidebar', 'keepseek.chat');
    assert.deepEqual(events, ['open-container']);
    completeContainerOpen();
    await opening;
    assert.deepEqual(events, ['open-container', 'container-opened', 'focus-chat']);
  } finally {
    completeContainerOpen();
    clearCommandHandlers();
  }
});

test('DraftRun interactions settle visibly with clone and continuation feedback', async () => {
  const script = getScript();
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  assert.match(script, /pendingDraftRunApprovals\.add\(id\)[\s\S]*?vscode\.postMessage\(payload\)/u);
  assert.match(script, /draftRunResultPendingNextMessage/u);
  assert.match(script, /draftRunRunAndContinue/u);
  assert.match(script, /payload\.autoContinue/u);
  assert.match(script, /getDraftRunTitle/u);
  assert.match(script, /draftRunCloneFeedback/u);
  assert.match(script, /draftRunCloneCreating/u);
  // Busy/capability behavior is exercised by sessionNavigation and complete Webview tests.
  assert.match(providerSource, /claimReadyAutoContinuation/u);
  assert.match(providerSource, /displayKind: 'draft_run_auto_continue'/u);
  assert.match(providerSource, /type: 'draftRunCloneFeedback'/u);
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

  assert.deepEqual(properties['kmvdata.keepseek.selectedSourceId'], {
    type: 'string',
    default: '',
    scope: 'window',
    markdownDescription: 'Source ID paired with `kmvdata.keepseek.selectedModelId` for the selected model. This is model identity, not a globally active source.'
  });

  assert.deepEqual(properties['kmvdata.keepseek.selectedModelId'], {
    type: 'string',
    default: '',
    scope: 'window',
    markdownDescription: 'Selected model for the current workspace. An empty or unavailable value adopts the global default model, or the first available model when no explicit default is valid.'
  });
  assert.deepEqual(properties['kmvdata.keepseek.thinkingEnabled'], {
    type: 'boolean',
    default: true,
    scope: 'window',
    markdownDescription: 'Enable Thinking mode for the current workspace.'
  });
  assert.deepEqual(properties['kmvdata.keepseek.reasoningEffort'], {
    type: 'string',
    default: 'high',
    scope: 'window',
    enum: ['high', 'max'],
    markdownDescription: 'Thinking effort for the current workspace.'
  });
  assert.deepEqual(properties['kmvdata.keepseek.compressionThreshold'], {
    type: 'string',
    default: 'balanced',
    scope: 'window',
    enum: ['aggressive', 'balanced', 'cache'],
    markdownDescription: 'Automatic history compaction threshold for the current workspace: 70% early cleanup, 80% balanced, or 85% cache first.'
  });
  assert.match(
    providerSource,
    /config\.update\('selectedModelId', modelId, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.match(
    providerSource,
    /config\.update\('selectedSourceId', sourceId, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.doesNotMatch(providerSource, /activeAccountId/u);
  assert.match(
    providerSource,
    /config\.update\('thinkingEnabled', this\.agentSettings\.thinkingEnabled, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.match(
    providerSource,
    /config\.update\('reasoningEffort', this\.agentSettings\.reasoningEffort, vscode\.ConfigurationTarget\.Workspace\)/u
  );
  assert.match(
    providerSource,
    /config\.update\('compressionThreshold', this\.agentSettings\.compressionThreshold, vscode\.ConfigurationTarget\.Workspace\)/u
  );
});

test('command menu exposes an accessible persisted compression threshold tab selector', () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();
  const modelListIndex = inputTemplate.indexOf('id="commandModelList"');
  const compressionTabsIndex = inputTemplate.indexOf('id="commandCompressionTabs"');
  const reasoningSectionIndex = inputTemplate.indexOf('aria-label="Reasoning"');

  assert.ok(modelListIndex >= 0 && compressionTabsIndex > modelListIndex);
  assert.ok(reasoningSectionIndex > compressionTabsIndex);
  assert.match(inputTemplate, /id="commandCompressionTabs"[\s\S]*?role="tablist"/u);
  assert.equal((inputTemplate.match(/role="tab"/gu) ?? []).length, 3);
  assert.equal((inputTemplate.match(/aria-controls="commandCompressionDescription"/gu) ?? []).length, 3);
  assert.match(inputTemplate, /data-threshold="balanced"[\s\S]*?aria-selected="true"/u);
  assert.match(inputScript, /function renderCompressionThreshold\(\)/u);
  assert.match(inputScript, /tab\.disabled = Boolean\(state\.isBusy\)/u);
  assert.match(inputScript, /type: 'setAgentSettings', settings: settings/u);
  assert.match(styles, /\.command-compression-tab\[aria-selected="true"\]/u);
  assert.match(styles, /\.command-menu\.is-readonly \.command-compression-tab/u);
});

test('command menu nests low-frequency Skill creation under the expanded Skills picker', () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();
  const titleIndex = inputTemplate.indexOf('data-i18n="skillsCommandTitle"');
  const mainButtonIndex = inputTemplate.indexOf('id="commandSkillsMainButton"');
  const filterButtonIndex = inputTemplate.indexOf('id="commandSkillFilterButton"');
  const createButtonIndex = inputTemplate.indexOf('id="commandCreateSkillButton"');
  const skillsButtonIndex = inputTemplate.indexOf('id="commandSkillsButton"');
  const skillActionHandler = getGeneratedSection(
    inputScript,
    'function handleSkillAction(action, skillId, selected)',
    'function getSelectedModel(models)'
  );

  assert.ok(mainButtonIndex >= 0 && titleIndex > mainButtonIndex && filterButtonIndex > titleIndex && createButtonIndex > filterButtonIndex && skillsButtonIndex > createButtonIndex);
  assert.match(inputTemplate, /id="commandCreateSkillButton"[\s\S]*?class="command-skill-icon-button command-skill-create-button hidden"/u);
  assert.match(inputTemplate, /id="commandSkillsButton"[\s\S]*?aria-controls="commandSkillList"/u);
  assert.match(inputTemplate, /data-i18n="skillsCommandTitle">使用 Skills</u);
  assert.match(inputTemplate, /data-i18n="skillsDescription">[^<]*\$[^<]*Skills 选择器</u);
  assert.doesNotMatch(inputTemplate, />\/create-skill</u);
  assert.doesNotMatch(inputTemplate, /id="commandSkillsValue"/u);
  assert.doesNotMatch(inputScript, /commandSkillsValue/u);
  assert.match(inputScript, /commandCreateSkillButton\.classList\.toggle\('hidden', !commandSkillListOpen\)/u);
  assert.match(inputScript, /commandCreateSkillButton[\s\S]*?showCreateSkillDialog\(\)/u);
  assert.match(inputScript, /\[commandSkillsMainButton, commandSkillsButton\]\.forEach\(function\(toggleButton\)/u);
  assert.doesNotMatch(skillActionHandler, /closeCommandMenu\(\)/u);
  assert.match(styles, /\.command-skills-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/u);
  assert.match(styles, /\.command-skills-toggle-button\[aria-expanded="true"\] \.command-skills-chevron[\s\S]*?rotate\(90deg\)/u);
});

test('command Skills filter expands leftward and shares name filtering with the dollar picker', () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();
  const commandOrdering = getGeneratedSection(
    inputScript,
    'function getCommandSkillItems()',
    'function getFilteredSkillMenuItems()'
  );
  const dollarFiltering = getGeneratedSection(
    inputScript,
    'function getFilteredSkillMenuItems()',
    'function isSkillUserSelectable(skill)'
  );
  const sharedFiltering = getGeneratedSection(
    inputScript,
    'function filterSkillItemsByName(skills, query)',
    'function getActiveSkillIds()'
  );

  assert.match(inputTemplate, /id="commandSkillFilterControl" class="command-skill-filter-control hidden"/u);
  assert.match(inputTemplate, /id="commandSkillFilterInput"[\s\S]*?data-i18n-placeholder="skillsFilterPlaceholder"/u);
  assert.match(inputTemplate, /id="commandSkillFilterButton"[\s\S]*?aria-controls="commandSkillFilterInput commandSkillList"/u);
  assert.match(inputScript, /commandSkillFilterButton\.addEventListener\('click'[\s\S]*?setCommandSkillFilterOpen\(!commandSkillFilterOpen, true\)/u);
  assert.match(inputScript, /commandSkillFilterInput\.addEventListener\('input'[\s\S]*?commandSkillFilterQuery = commandSkillFilterInput\.value[\s\S]*?renderCommandSkills\(\)/u);
  assert.match(inputScript, /commandSkillFilterControl\.classList\.toggle\('hidden', !commandSkillListOpen\)/u);
  assert.match(inputScript, /commandSkillFilterControl\.classList\.toggle\('is-open', commandSkillFilterOpen\)/u);
  assert.match(commandOrdering, /filterSkillItemsByName\(orderedSkills, commandSkillFilterQuery\)/u);
  assert.match(dollarFiltering, /filterSkillItemsByName\(getSkillItems\(\)\.filter\(isSkillUserSelectable\), activeMentionQuery\)/u);
  assert.match(sharedFiltering, /normalizeReferenceQuery\(query\)[\s\S]*?skillNameMatchesQuery\(skill, normalizedQuery\)/u);
  assert.doesNotMatch(sharedFiltering, /skill\.description|skill\.sourceLabel|skill\.source/u);
  assert.match(styles, /\.command-skill-filter-control\s*\{[\s\S]*?max-width:\s*26px[\s\S]*?transition:\s*max-width/u);
  assert.match(styles, /\.command-skill-filter-control\.is-open \.command-skill-filter-input\s*\{[\s\S]*?width:\s*clamp/u);
});

test('Skills picker uses checkboxes and keeps selected Skills in activation order before name-sorted items', () => {
  const inputScript = getInputScript();
  const styles = getStyles();
  const skillItemRenderer = getGeneratedSection(
    inputScript,
    'function createCommandSkillItem(skill)',
    'function formatSkillMeta(skill)'
  );
  const skillOrdering = getGeneratedSection(
    inputScript,
    'function getCommandSkillItems()',
    'function getFilteredSkillMenuItems()'
  );
  const skillActionHandler = getGeneratedSection(
    inputScript,
    'function handleSkillAction(action, skillId, selected)',
    'function getSelectedModel(models)'
  );

  assert.match(skillItemRenderer, /checkbox\.type = 'checkbox'/u);
  assert.match(skillItemRenderer, /checkbox\.checked = active/u);
  assert.match(skillItemRenderer, /checkbox\.dataset\.skillAction = 'toggle-use'/u);
  assert.doesNotMatch(skillItemRenderer, /skillsActive|skillsUse|command-skill-status/u);
  assert.match(skillActionHandler, /if \(selected\)[\s\S]*?type: 'useSkill'[\s\S]*?type: 'removeActiveSkill'/u);
  assert.match(skillOrdering, /getActiveSkillIds\(\)\.forEach[\s\S]*?activeOrder\.set\(skillId, index\)/u);
  assert.match(skillOrdering, /if \(leftActive && rightActive\)[\s\S]*?activeOrder\.get\(left\.id\) - activeOrder\.get\(right\.id\)/u);
  assert.match(skillOrdering, /leftActive \? -1 : 1[\s\S]*?leftName\.localeCompare\(rightName/u);
  assert.match(styles, /\.command-skill-checkbox\s*\{/u);
  assert.doesNotMatch(styles, /\.command-skill-status/u);

  const harness = new Function('translations', `
    const state = { isBusy: false };
    const canChangeContext = () => !state.isBusy;
    const sent = [];
    const items = [
      { id: 'ready', name: 'Ready Skill', description: 'Ready description', enabled: true },
      { id: 'failed', name: 'Failed Skill', enabled: false, loadError: 'Fixture read failed' }
    ];
    const skills = { items, diagnostics: ['Fixture discovery warning'], scopeUri: 'file:///fixture/task-directory',
      configSummary: { projectDocMaxBytes: 4321, fallbackFilenames: ['FIXTURE.md'], origins: {} } };
    const vscode = { postMessage: message => sent.push(message) };
    const t = (key, values = {}) => (translations[key] || key)
      .replace(/\\{(\\w+)\\}/g, (_, name) => values[name] || '');
    const document = { createElement: tag => ({ tag, children: [], dataset: {}, textContent: '',
      classList: { toggle() {} }, setAttribute() {}, append(...children) { this.children.push(...children); },
      set innerHTML(value) { this.children = []; } }) };
    const commandSkillList = document.createElement('div');
    const commandSkillsMainButton = null, commandSkillsButton = null;
    const commandSkillListOpen = true, commandSkillFilterQuery = '';
    const getSkillsState = () => skills;
    const getCommandSkillItems = () => items;
    const getSkillById = id => items.find(skill => skill.id === id);
    const isSkillActive = () => false;
    const setComposerStatus = () => {};
    function flatten(node) { return [node].concat(...node.children.map(flatten)); }
    ${commandSkillsImplementationFragment.source}
    renderCommandSkills();
    return { sent, state, handleSkillAction, nodes: flatten(commandSkillList) };
  `)(WEBVIEW_TRANSLATIONS.en);
  assert.equal(harness.nodes.some((node: { tag: string }) => node.tag === 'button'), false);
  const menuText = harness.nodes.map((node: { textContent: string }) => node.textContent).join('\n');
  assert.match(menuText, /Ready Skill[\s\S]*Ready description/u);
  assert.match(menuText, /Fixture discovery warning/u);
  assert.match(menuText, /Fixture read failed/u);
  assert.doesNotMatch(menuText, /fixture\/task-directory|project_doc_max_bytes|project_doc_fallback_filenames|4321|FIXTURE\.md/u);
  assert.equal(harness.nodes.filter((node: { tag: string }) => node.tag === 'input').length, 2);
  harness.handleSkillAction('open', 'ready');
  harness.handleSkillAction('workspace-default', 'ready');
  harness.handleSkillAction('toggle-use', 'failed', true);
  assert.deepEqual(harness.sent, []);
  harness.handleSkillAction('toggle-use', 'ready', true);
  harness.handleSkillAction('toggle-use', 'ready', false);
  assert.deepEqual(harness.sent, [
    { type: 'useSkill', skillId: 'ready' },
    { type: 'removeActiveSkill', skillId: 'ready' }
  ]);
  harness.state.isBusy = true;
  harness.handleSkillAction('toggle-use', 'ready', true);
  assert.equal(harness.sent.length, 2);
});

test('plugin selections insert a task reference and keep its original path when the catalog refreshes', () => {
  const helpers = getSkillWebviewHelpers();
  const run = new Function('translations', 'language', `
    const state = { skills: { items: [] } };
    const canChangeContext = () => !state.isBusy;
    const links = [];
    const sent = [];
    const vscode = { postMessage: message => sent.push(message) };
    const promptInput = { querySelectorAll: () => links };
    const activeMentionRange = { cloneRange: () => 'typed mention' };
    const isRangeInsidePrompt = () => true;
    const getPromptInsertionRange = () => 'cursor';
    const makeElement = () => ({ children: [], dataset: {}, setAttribute() {},
      append(...children) { this.children.push(...children); } });
    const document = { createElement: makeElement, createDocumentFragment: makeElement };
    const renderSkillReferenceContent = (link, name) => { link.textContent = name; };
    const appendReferenceBoundarySpace = () => {};
    const insertFragmentAtRange = (range, fragment) => {
      fragment.children.forEach(link => { link.range = range; links.push(link); });
    };
    const t = (key, values = {}) => (translations[key] || key)
      .replace(/\\{(\\w+)\\}/g, (_, name) => values[name] || '');
    const getLanguage = () => language;
    const referenceMenu = null;
    const setComposerStatus = () => {};
    ${helpers}
    ${skillsImplementationFragment.source}
    ${composerSerializationFragment.source}
    ${commandSkillsImplementationFragment.source}
    ${referenceMenuImplementationFragment.source}
    return { state, links, sent, handleSkillAction, insertSkillFromReferenceMenu, collectActiveSkillIds,
      refreshPromptSkillLinkLabels, skillLinkToText, isPluginSkillInPrompt, filterSkillItemsByName,
      createCommandSkillItem, hasStalePluginSkillInPrompt };
  `);
  const fixture = {
    id: 'plugin-one',
    name: 'index',
    skillPath: '/cache/plugin (test)/1/skills/index/SKILL.md',
    skillUri: 'file:///cache/plugin%20(test)/1/skills/index/SKILL.md',
    enabled: true,
    plugin: {
      name: 'Product Design',
      version: '1',
      marketplace: 'remote-fixture',
      source: 'remote',
      qualifiedName: 'product-design:index',
      selectionStamp: 'a'.repeat(64),
      capabilityStatus: 'missing',
      capabilityDetails: [{ en: 'Interactive browser', zh: '交互式浏览器', status: 'missing' }]
    }
  };
  const ordinary = { id: 'shared-one', name: 'index', enabled: true };
  const harness = run(WEBVIEW_TRANSLATIONS.en, 'en');
  harness.state.skills.items = [ordinary, fixture];
  assert.deepEqual(harness.filterSkillItemsByName(harness.state.skills.items, 'remote-fixture'), [fixture]);
  const item = harness.createCommandSkillItem(fixture);
  assert.match(item.children[0].children[0].children[2].textContent, /Product Design 1 · Remote install · remote-fixture/u);
  assert.equal(item.children[0].children[0].children[3].textContent, 'Tools missing · Interactive browser (Missing)');
  assert.equal(item.children.length, 1);
  const zh = run(WEBVIEW_TRANSLATIONS['zh-CN'], 'zh-CN');
  assert.equal(zh.createCommandSkillItem(fixture).children[0].children[0].children[3].textContent, '缺少工具 · 交互式浏览器 (缺失)');
  harness.handleSkillAction('open', fixture.id);
  harness.handleSkillAction('toggle-use', fixture.id, true);
  assert.deepEqual(harness.sent, []);
  assert.equal(harness.links[0].range, 'cursor');
  assert.equal(harness.isPluginSkillInPrompt(fixture), true);
  assert.equal(harness.hasStalePluginSkillInPrompt(), false);
  assert.deepEqual(harness.collectActiveSkillIds(), []);
  harness.insertSkillFromReferenceMenu(fixture);
  assert.equal(harness.links[1].range, 'typed mention');

  const expected = '[$product-design:index](file:///cache/plugin%20%28test%29/1/skills/index/SKILL.md#keepseek-plugin-' + 'a'.repeat(64) + ')';
  const next = { ...fixture, plugin: { ...fixture.plugin, version: '2', selectionStamp: 'b'.repeat(64) } };
  harness.state.skills.items = [ordinary, next];
  harness.refreshPromptSkillLinkLabels();
  assert.equal(harness.isPluginSkillInPrompt(next), false);
  assert.equal(harness.hasStalePluginSkillInPrompt(), true);
  assert.match(harness.links[0].title, /temporarily disabled.*standalone Skills/u);
  assert.deepEqual(harness.links.map((link: unknown) => harness.skillLinkToText(link)), [expected, expected]);
  harness.handleSkillAction('toggle-use', ordinary.id, true);
  assert.deepEqual(harness.sent.at(-1), { type: 'useSkill', skillId: ordinary.id });
});

test('edit and resend keeps qualified plugin references verbatim and resolves a selected path uniquely', () => {
  const transcript = getScript();
  const helpers = getSkillWebviewHelpers();
  const editor = getGeneratedSection(transcript, 'function renderInlineEditorContent(editor, value)', 'function sanitizeInlineEditorContent(editor)');
  const serialize = getGeneratedSection(transcript, 'function inlineSkillLinkToText(link)', 'function makeStandaloneInlineReferenceText(text)');
  const run = new Function('items', 'prompt', `
    const state = { skills: { items } };
    const document = { createTextNode: text => text, createElement: () => ({ dataset: {}, setAttribute() {} }) };
    const renderSkillReferenceContent = () => {};
    const sanitizeInlineEditorContent = () => {};
    const isOffsetInsideMarkdownFence = () => false;
    const rendered = { children: [], append(value) { this.children.push(value); } };
    ${helpers}
    ${editor}
    ${serialize}
    renderInlineEditorContent(rendered, prompt);
    return { chipCount: rendered.children.filter(value => typeof value !== 'string').length,
      resent: rendered.children.map(value => typeof value === 'string' ? value : inlineSkillLinkToText(value)).join('') };
  `);
  const first = { id: 'first', skillPath: '/first/index/SKILL.md', plugin: { qualifiedName: 'product-design:index' } };
  const second = { id: 'second', skillPath: '/second/index/SKILL.md', plugin: { qualifiedName: 'product-design:index' } };
  const prompt = 'Use [$product-design:index](/second/index/SKILL.md) with $product-design:index';
  assert.deepEqual(run([first, second], prompt), { chipCount: 1, resent: prompt });
  assert.deepEqual(run([first], prompt), { chipCount: 0, resent: prompt });
  assert.deepEqual(run([second, { ...second, id: 'duplicate' }], prompt), { chipCount: 0, resent: prompt });
});

function getSkillWebviewHelpers(): string {
  const script = getScript();
  return [
    getGeneratedSection(script, 'function getSkillItemsForView()', 'var fileReferenceIconTemplate'),
    getGeneratedSection(script, 'function getSkillPathForView(skill)', 'function mergeSkillIdsForRequest()')
  ].join('\n');
}

test('command menu owns project-scoped main and subagent model selection', async () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );
  const settingsStoreSource = await readFile(
    path.resolve(process.cwd(), 'src/accounts/subagentSettingsStore.ts'),
    'utf8'
  );
  const runtimeSource = await readFile(
    path.resolve(process.cwd(), 'src/agent/subagents/runtime.ts'),
    'utf8'
  );
  const mainModelIndex = inputTemplate.indexOf('id="commandModelSwitch"');
  const subagentModelIndex = inputTemplate.indexOf('id="commandSubagentModelSwitch"');
  const compressionIndex = inputTemplate.indexOf('id="commandCompressionTabs"');

  assert.ok(mainModelIndex >= 0 && subagentModelIndex > mainModelIndex);
  assert.ok(compressionIndex > subagentModelIndex);
  assert.match(inputTemplate, /data-i18n="switchModel">主模型</u);
  assert.match(inputTemplate, /data-i18n="subagentModelTitle">子代理模型</u);
  assert.match(inputTemplate, /id="commandSubagentModelSwitch"[\s\S]*?aria-controls="commandSubagentModelList"/u);
  assert.match(inputTemplate, /id="commandSubagentModelValue"[\s\S]*?data-i18n="subagentProfileModelScope"/u);
  assert.match(inputTemplate, /id="commandSubagentModelList"[\s\S]*?class="command-subagent-profile-list hidden"[\s\S]*?role="group"/u);
  assert.doesNotMatch(inputTemplate, /settingsSubagentModel|settings-subagent-card/u);
  assert.doesNotMatch(inputScript, /settingsSubagentModel/u);
  assert.doesNotMatch(styles, /settings-subagent-card/u);
  assert.match(inputScript, /type: 'setSubagentModel', mode: 'follow-main'/u);
  assert.match(inputScript, /type: 'setSubagentModel', mode: 'fixed', sourceId: sourceId, modelId: modelId/u);
  assert.match(inputScript, /function renderCommandSubagentModel\(\)/u);
  assert.match(inputScript, /\['default', 'research', 'review', 'proposal', 'approval'\]\.forEach/u);
  assert.match(inputScript, /profile: selectedProfile === 'default' \? undefined : selectedProfile/u);
  assert.match(inputScript, /profileRow\.className = 'command-subagent-profile-row'/u);
  assert.match(inputScript, /profileButton\.append\(currentLogo\)/u);
  assert.match(inputScript, /profileButton\.append\(profileModelText\)/u);
  assert.match(inputScript, /function appendCommandSubagentModelOptions\(input\)/u);
  assert.match(inputScript, /option\.dataset\.subagentModelProfile = input\.profile/u);
  assert.match(inputScript, /commandSubagentModelProfile === requestedProfile \? '' : requestedProfile/u);
  assert.match(inputScript, /function isSubagentModelSelectionLocked\(\)/u);
  assert.match(styles, /\.command-subagent-profile-row\s*\{[\s\S]*?grid-template-columns:/u);
  assert.match(styles, /\.command-subagent-profile-model-button\[aria-expanded="true"\]/u);
  assert.match(styles, /\.command-subagent-profile-model-text\s*\{[\s\S]*?text-overflow: ellipsis/u);
  assert.match(settingsStoreSource, /getWorkspaceHash\(workspaceKey\.trim\(\) \|\| 'workspace:empty'\)/u);
  assert.match(providerSource, /new SubagentSettingsStore\([\s\S]*?this\.sessionStore\.workspaceKey/u);
  assert.doesNotMatch(runtimeSource, /global subagent|Global subagent|全局子代理|Account management/u);
});

test('subagent model overview renders safely before the startup model catalog arrives', () => {
  const inputScript = getInputScript();
  const renderStartupState = new Function(`
    const state = {
      models: [],
      isBusy: false,
      commandSettingsReadiness: { mainModel: 'loading', subagentModel: 'loading' }
    };
    var commandSubagentModelListOpen = false;
    var commandSubagentModelProfile = '';
    function createNode() {
      return {
        children: [],
        dataset: {},
        classList: { toggle() {} },
        append(...children) { this.children.push(...children); },
        setAttribute() {}
      };
    }
    const document = { createElement: createNode };
    const commandSubagentModelValue = createNode();
    const commandSubagentModelSwitch = createNode();
    const commandSubagentModelDescription = createNode();
    const commandSubagentModelList = createNode();
    const t = key => key;
    const getCommandSettingReadiness = key => state.commandSettingsReadiness[key] || 'loading';
    const isModelSelectionLocked = () => false;
    const getSubagentModelLockText = () => 'subagentModelLoading';
    const getSelectedModel = () => null;
    const findModelForSelection = () => null;
    const getModelSourceLabel = () => 'source';
    const getModelDisplayLabel = () => 'model';
    const createCommandModelProtocolLogo = () => null;
    ${getGeneratedSection(inputScript, 'function renderCommandSubagentModel()', 'function appendCommandSubagentModelOptions')}
    renderCommandSubagentModel();
    return {
      rowCount: commandSubagentModelList.children.length,
      defaultLabel: commandSubagentModelList.children[0]?.children[0]?.textContent,
      approvalLabel: commandSubagentModelList.children[4]?.children[0]?.textContent,
      approvalDisabled: commandSubagentModelList.children[4]?.children[1]?.disabled,
      value: commandSubagentModelValue.children[0]?.textContent
    };
  `);

  assert.deepEqual(renderStartupState(), {
    rowCount: 5,
    defaultLabel: 'subagentProfile_default',
    approvalLabel: 'approvalModelTitle',
    approvalDisabled: true,
    value: 'subagentModelLoading'
  });
});

test('model picker waits for authoritative extension state and exposes pending cancellation', () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();

  assert.match(inputTemplate, /id="commandModelStatus"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u);
  assert.match(inputTemplate, /id="commandModelCancelPending"/u);
  assert.match(inputTemplate, /id="composerModelStatus"[\s\S]*?role="status"[\s\S]*?aria-live="polite"/u);
  assert.match(inputTemplate, /id="composerModelCancelPending"/u);
  assert.match(inputScript, /type: 'setSelectedModel',[\s\S]*?requestId: nextModelSelectionRequestId\(\)/u);
  assert.match(inputScript, /type: 'cancelPendingModelSelection'/u);
  assert.doesNotMatch(inputScript, /state\.selectedSourceId = sourceId;[\s\S]*?state\.selectedModelId = modelId;/u);
  assert.doesNotMatch(inputScript, /type: 'refreshBalance'/u);
  assert.match(inputScript, /commandModelSwitch\.disabled = locked/u);
});

test('model settings dialog manages flat logo-led accounts and per-source models', async () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();
  const messageSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/webviewMessages.ts'),
    'utf8'
  );
  const i18nSource = await readFile(
    path.resolve(process.cwd(), 'src/shared/i18n.ts'),
    'utf8'
  );
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  for (const legacyId of [
    'settingsDialogOverlay',
    'settingsApiKey',
    'settingsBaseUrl',
    'settingsSaveBtn',
    'settingsCancelBtn',
    'settingsApiKeyVisibilityBtn'
  ]) {
    assert.match(inputTemplate, new RegExp(`id="${legacyId}"`, 'u'));
  }
  for (const accountId of [
    'newAccountProvider',
    'settingsCreateAccountBtn',
    'settingsAccountList',
    'settingsAccountName',
    'settingsDeleteAccountBtn',
    'settingsRefreshModelsBtn',
    'settingsModelList',
    'settingsManualModelId',
    'settingsManualContextWindow',
    'settingsManualMaxOutput',
    'settingsAddModelBtn'
  ]) {
    assert.match(inputTemplate, new RegExp(`id="${accountId}"`, 'u'));
  }
  assert.match(inputTemplate, /value="deepseek"/u);
  assert.match(inputTemplate, /value="openai-compatible"/u);
  assert.match(inputTemplate, /value="openai-responses"/u);
  assert.match(inputTemplate, /settings-account-dialog" role="dialog" aria-modal="true"/u);
  assert.match(inputTemplate, /id="settingsDialogStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(inputScript, /type: 'addModel'/u);
  assert.match(inputScript, /type: 'saveModelSource'/u);
  assert.match(inputScript, /type: 'deleteModelSource'/u);
  assert.match(inputScript, /type: 'deleteModel'/u);
  assert.match(inputScript, /type: 'setModelEnabled'/u);
  assert.match(inputScript, /type: 'setModelContextWindow'/u);
  assert.match(inputScript, /type: 'setModelMaxOutput'/u);
  assert.match(inputScript, /formatContextWindowTokens/u);
  assert.match(inputScript, /tokenCount === 1048576/u);
  assert.match(inputScript, /return '1M tokens'/u);
  assert.match(inputScript, /return String\(tokenCount \/ 1024\) \+ 'K tokens'/u);
  assert.match(inputScript, /binaryKVariants = \[8, 16, 32, 64\]/u);
  assert.match(inputScript, /kiloTokens \* 1024/u);
  assert.match(inputScript, /Math\.round\(kiloTokens \* 1000\)/u);
  assert.match(inputScript, /renderSettingsModelContextEditor/u);
  assert.match(inputScript, /renderSettingsModelMaxOutputEditor/u);
  assert.match(inputScript, /contextWindowSource === 'guessed'/u);
  assert.match(inputScript, /maxOutputSource === 'guessed'/u);
  assert.match(inputScript, /model\.agentCompatible === false/u);
  assert.match(inputScript, /t\('notApplicable'\)/u);
  assert.match(inputScript, /t\('imageGenerationResource'\)/u);
  assert.match(inputScript, /t\('speechSynthesisResource'\)/u);
  assert.match(inputTemplate, /max="10000" step="0\.001" placeholder="32"/u);
  assert.match(inputTemplate, /max="1048576" step="1" placeholder="8192"/u);
  assert.match(inputScript, /type: 'refreshSourceModels'/u);
  assert.doesNotMatch(inputScript, /type: 'selectAccount'/u);
  assert.match(inputScript, /function beginSettingsDialogAction/u);
  assert.match(inputScript, /function blockSettingsActionForUnsavedChanges/u);
  assert.match(inputScript, /function blockAccountSettingsWhileRunBusy/u);
  assert.match(inputScript, /function syncAccountSettingsRunBusyStatus/u);
  assert.match(inputScript, /function trapSettingsDialogFocus/u);
  assert.match(inputScript, /var runBusy = !canChangeContext\(\) \|\| isModelSelectionLocked\(\)/u);
  assert.match(inputScript, /var controlsDisabled = operationBusy \|\| runBusy/u);
  assert.match(inputScript, /button\.disabled = controlsDisabled \|\| !account\.enabled/u);
  assert.match(inputScript, /settingsCancelBtn\.disabled = operationBusy/u);
  assert.match(inputScript, /modelSettingsReadonlyWhileBusy/u);
  assert.match(inputScript, /modelSelectionLockedByBackground/u);
  assert.ok((inputScript.match(/blockAccountSettingsWhileRunBusy\(\)/gu) ?? []).length >= 9);
  assert.match(i18nSource, /modelSettingsReadonlyWhileBusy: '当前操作完成并且会话就绪后可修改模型设置。'/u);
  assert.match(inputScript, /var settingsSaveCompleted = false/u);
  assert.match(inputScript, /settingsSaveCompleted = values\.settingsSaved === true/u);
  assert.match(inputScript, /settingsSaveCompleted && !settingsDialogBusyAction/u);
  assert.match(inputScript, /t\('closeWindow'\)/u);
  assert.match(i18nSource, /closeWindow: '关闭窗口'/u);
  assert.match(i18nSource, /closeWindow: 'Close window'/u);
  assert.ok(providerSource.includes('settingsSaved: outcome.settingsSaved === true'));
  assert.ok(providerSource.includes('private postModelSettingsDialog(outcome: { settingsSaved?: boolean } = {}): void'));
  assert.ok((providerSource.match(/settingsSaved: true/gu) ?? []).length >= 2);
  assert.match(i18nSource, /modelSettingsReadonlyWhileBusy: 'Model settings are available when the current operation finishes and the conversation is ready\.'/u);
  assert.match(
    inputScript,
    /settingsDialogBusyTimer = setTimeout\(function\(\) \{[\s\S]*?setSettingsDialogStatus\(t\('modelOperationStillPending'\)\)[\s\S]*?\}, 15000\)/u
  );
  assert.doesNotMatch(inputScript, /settings-account-group/u);
  assert.doesNotMatch(styles, /\.settings-account-group/u);
  assert.match(inputScript, /settingsSources\.forEach\(function\(account\)/u);
  assert.match(inputScript, /getSettingsProviderLogoUri\(account\.provider\)/u);
  assert.match(inputScript, /settings-account-item-logo/u);
  assert.match(styles, /\.settings-account-item-logo-box/u);
  assert.match(styles, /\.settings-account-item-logo\[data-provider="deepseek"\]/u);
  assert.match(styles, /\.settings-model-enable/u);
  assert.match(styles, /\.settings-model-context-value/u);
  assert.match(styles, /\.settings-model-context-input/u);
  assert.match(inputScript, /enableCheckbox\.type = 'checkbox'/u);
  assert.match(inputScript, /controlsDisabled \|\| model\.agentCompatible === false/u);
  assert.match(inputScript, /disabledModelIds/u);
  assert.match(styles, /@media \(max-width: 540px\)/u);
  assert.match(messageSource, /type: 'addModel'/u);
  assert.match(messageSource, /contextWindowTokens\?: number/u);
  assert.match(messageSource, /maxOutputTokens\?: number/u);
  assert.match(messageSource, /type: 'saveModelSource'/u);
  assert.match(messageSource, /type: 'deleteModel'/u);
  assert.match(messageSource, /type: 'setModelEnabled'/u);
  assert.match(messageSource, /type: 'setModelContextWindow'/u);
  assert.match(messageSource, /type: 'setModelMaxOutput'/u);
  assert.doesNotMatch(inputScript, /window\.(?:prompt|alert|confirm)\s*\(/u);
});

test('command model labels prefer fetched names while hover keeps the model id', () => {
  const inputScript = getInputScript();

  assert.match(
    inputScript,
    /return model\.fetchedName \|\| model\.label \|\| model\.id \|\| 'Model'/u
  );
  assert.match(inputScript, /label\.title = model\.id \|\| getModelDisplayLabel\(model\)/u);
  assert.match(
    inputScript,
    /option\.title = lockText[\s\S]*?: isPending[\s\S]*?: model\.id \|\| getModelDisplayLabel\(model\)/u
  );
});

test('command model picker shows protocol logos when collapsed and beside expanded account names', () => {
  const inputTemplate = getInputTemplate();
  const inputScript = getInputScript();
  const styles = getStyles();

  assert.match(
    inputTemplate,
    /id="commandModelValue" class="command-row-value command-model-current"/u
  );
  assert.match(inputScript, /function createCommandModelProtocolLogo\(provider\)/u);
  assert.match(
    inputScript,
    /var currentLogo = createCommandModelProtocolLogo\(selected\.model\.provider\)/u
  );
  assert.match(
    inputScript,
    /groupLabel\.className = 'command-model-source'[\s\S]*?createCommandModelProtocolLogo\(model\.provider\)[\s\S]*?groupName\.textContent = getModelSourceLabel\(model\)/u
  );
  assert.match(inputScript, /logo\.dataset\.provider = normalizedProvider/u);
  assert.match(styles, /\.command-model-current \{/u);
  assert.match(styles, /\.command-model-source \{/u);
  assert.match(styles, /\.command-model-protocol-logo-box \{/u);
});

test('rich prompt script exposes reference, skill, and external drop entry points', () => {
  const script = getInputScript();

  assert.match(script, /character === '\$'/u);
  assert.match(script, /character === '@'/u);
  assert.match(script, /application\/vnd\.code\.uri-list/u);
  assert.match(script, /insertDroppedFileReferences/u);
  assert.match(script, /getPromptInsertionRange/u);
});

test('references open once from a single click in the prompt, message editor, and transcript', async () => {
  const inputScript = getInputScript();
  const transcriptScript = getScript();
  const promptClickHandler = getGeneratedSection(
    inputScript,
    "promptInput.addEventListener('click'",
    "promptInput.addEventListener('paste'"
  );
  const transcriptClickHandler = getGeneratedSection(
    transcriptScript,
    "transcript.addEventListener('click'",
    "transcript.addEventListener('submit'"
  );
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  assert.match(promptClickHandler, /a\.rich-skill-link/u);
  assert.match(promptClickHandler, /event\.detail > 1/u);
  assert.match(promptClickHandler, /type: 'openSkill'/u);
  assert.match(promptClickHandler, /type: 'openFileReference'/u);
  assert.equal(promptClickHandler.match(/type: 'openSkill'/gu)?.length, 1);
  assert.doesNotMatch(inputScript, /promptInput\.addEventListener\('dblclick'/u);

  assert.match(transcriptClickHandler, /a\.rich-file-link, a\.rich-skill-link/u);
  assert.match(transcriptClickHandler, /event\.detail > 1/u);
  assert.match(transcriptClickHandler, /type: 'openSkill'/u);
  assert.match(transcriptClickHandler, /type: 'openDirectoryReference'/u);
  assert.match(transcriptClickHandler, /type: 'openFileReference'/u);
  assert.equal(transcriptClickHandler.match(/type: 'openSkill'/gu)?.length, 1);
  assert.doesNotMatch(transcriptScript, /transcript\.addEventListener\('dblclick'/u);

  assert.match(
    providerSource,
    /const manifest = this\.skillStore\.getManifest\(skillId\);[\s\S]*?openTextDocument\(manifest\.skillUri\)[\s\S]*?showTextDocument\(document, \{ preview: false \}\)/u
  );
  assert.match(providerSource, /revealReferenceInOperatingSystem\(manifest\.skillUri\)/u);
  assert.match(
    providerSource,
    /private async openDirectoryReference\(inputPath: string\)[\s\S]*?await openDirectoryReferenceUri\(uri\)/u
  );
});

test('reference chips use type icons, one-line names, and full-path hover labels', () => {
  const transcriptScript = getScript();
  const styles = getStyles();
  const labelRenderer = getGeneratedSection(
    transcriptScript,
    'function renderFileReferenceLinkLabel',
    'function createReferenceChipLabelPart'
  );

  assert.match(transcriptScript, /fileReferenceIconTemplate\.innerHTML = '<svg/u);
  assert.match(transcriptScript, /directoryReferenceIconTemplate\.innerHTML = '<svg/u);
  assert.match(transcriptScript, /function createReferenceTypeIcon\(kind, className\)/u);
  assert.match(labelRenderer, /getReferenceChipDisplayName\(reference\)/u);
  assert.match(labelRenderer, /createReferenceTypeIcon\(kind\)/u);
  assert.doesNotMatch(labelRenderer, /rich-file-link-secondary/u);
  assert.match(labelRenderer, /getReferenceChipTitle\(reference\)/u);
  assert.match(labelRenderer, /getReferenceChipAriaLabel\(reference\.kind, title\)/u);
  assert.match(styles, /\.rich-reference-link-icon\s*\{[^}]*width:\s*14px/us);
  assert.match(styles, /\.rich-file-link:focus-visible\s*\{[^}]*outline:/us);
  assert.doesNotMatch(styles, /rich-file-link-secondary/u);
  assert.match(styles, /\.message\.user \.message-content \.message-file-link\s*\{[^}]*white-space:\s*nowrap/us);
  assert.match(transcriptScript, /function formatFileReferenceLabelContents\(reference\)[\s\S]*?getReferenceChipLabel\(reference\)/u);
});

test('reference chip display names distinguish whole files, lines, ranges, columns, and directories', () => {
  const displayName = new Function('reference', 'language', `
    const state = { workspaceFolders: [] };
    const getLanguage = () => language;
    ${getGeneratedSection(getScript(), 'function makeMessageFileHref', 'function isLikelyMessageFilePath')}
    return getReferenceChipDisplayName(reference);
  `);
  const base = { kind: 'file', path: 'src/config.ts', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
  const cases = [
    { input: base, expected: 'config.ts' },
    { input: { ...base, startLine: 52, endLine: 52 }, expected: 'config.ts:52' },
    { input: { ...base, startLine: 52 }, expected: 'config.ts:52' },
    { input: { ...base, startLine: 52, endLine: -1 }, expected: 'config.ts:52' },
    { input: { ...base, startLine: 81, endLine: 87 }, expected: 'config.ts:81-87' },
    { input: { ...base, path: 'src/utils.ts', startLine: 10, endLine: 10, startColumn: 5, endColumn: 20 }, expected: 'utils.ts:10' },
    { input: { ...base, startLine: 81, endLine: 87, startColumn: 5, endColumn: 20 }, expected: 'config.ts:81-87' },
    { input: { ...base, kind: 'directory', path: 'src/agent/' }, expected: 'agent' }
  ];

  for (const language of ['zh-CN', 'en']) {
    for (const { input, expected } of cases) {
      const before = { ...input };
      assert.equal(displayName(input, language), expected);
      assert.deepEqual(input, before);
    }
  }
});

test('line-only chip display preserves column datasets, hrefs, hover labels, and serialized bytes', () => {
  const script = getScript();
  const inputScript = getInputScript();
  const inspectReference = new Function(`
    const state = { workspaceFolders: [] };
    const getLanguage = () => 'en';
    const t = key => key;
    ${getGeneratedSection(script, 'function makeMessageFileHref', 'function isLikelyMessageFilePath')}
    ${getGeneratedSection(script, 'function isMessageWindowsDrivePath', 'function readReferenceInteger')}
    ${getGeneratedSection(inputScript, 'function makeFileHref', 'function insertFileReferences')}
    ${getGeneratedSection(inputScript, 'function fileReferenceLinkToText', 'function skillLinkToText')}
    ${getGeneratedSection(inputScript, 'function makeStandaloneReferenceText', 'function collectPromptFileReferences')}
    ${getGeneratedSection(inputScript, 'function readFileReferenceLink', 'function isBlockElement')}
    ${getGeneratedSection(inputScript, 'function readPositiveInteger', 'function sanitizePromptContent')}
    const reference = normalizeReferenceLinkInput({
      kind: 'file', path: 'src/utils.ts', startLine: 10, endLine: 10, startColumn: 5, endColumn: 20
    });
    const link = { dataset: {}, textContent: getReferenceChipDisplayName(reference) };
    writeReferenceLinkDataset(link, reference);
    const title = getReferenceChipTitle(reference);
    return {
      text: link.textContent, dataset: link.dataset, href: makeFileReferenceHref(reference),
      title, ariaLabel: getReferenceChipAriaLabel(reference.kind, title),
      serialized: fileReferenceLinkToText(link)
    };
  `);
  const result = inspectReference();

  assert.equal(result.text, 'utils.ts:10');
  assert.deepEqual(result.dataset, {
    kind: 'file', path: 'src/utils.ts', startLine: '10', endLine: '10', startColumn: '5', endColumn: '20'
  });
  assert.equal(result.href, 'src/utils.ts#L10C5-L10C20');
  assert.equal(result.title, 'src/utils.ts (L10#C5-L10#C20)');
  assert.equal(result.ariaLabel, 'fileReferenceType: src/utils.ts (L10#C5-L10#C20)');
  assert.equal(result.serialized, '\n[utils.ts (L10#C5-L10#C20) - src]\n<src/utils.ts#L10C5-L10C20>\n');
});

test('Skill reference chips reuse plugin.svg and hide the protocol dollar prefix', async () => {
  const inputScript = getInputScript();
  const transcriptScript = getScript();
  const styles = getStyles();
  const htmlSource = await readFile(path.resolve(process.cwd(), 'src/webview/html.ts'), 'utf8');

  assert.match(styles, /\.rich-skill-link\s*\{[^}]*cursor:\s*pointer/us);
  assert.match(styles, /\.rich-skill-link:hover\s*\{[^}]*background:/us);
  assert.match(styles, /\.rich-skill-link-icon\s*\{[^}]*width:\s*12px/us);
  assert.match(styles, /\.rich-skill-link-label\s*\{[^}]*text-overflow:\s*ellipsis/us);
  assert.match(htmlSource, /resources', 'plugin\.svg'/u);
  assert.match(htmlSource, /window\.keepseekSkillIconUri/u);
  assert.match(transcriptScript, /function createSkillReferenceIcon\(className\)[\s\S]*?image\.src = keepseekPluginIconUri/u);
  assert.match(inputScript, /createSkillLink\(skill\)[\s\S]*?renderSkillReferenceContent\(anchor, getSkillMentionName\(skill\)\)/u);
  assert.match(inputScript, /refreshPromptSkillLinkLabels\(\)[\s\S]*?renderSkillReferenceContent\(link, getSkillMentionName\(skill\)\)/u);
  assert.match(inputScript, /createSkillPill\(skill\)[\s\S]*?createSkillReferenceIcon\('skill-pill-icon'\)[\s\S]*?name\.textContent = getSkillMentionName\(skill\)/u);
  assert.match(transcriptScript, /createInlineSkillLink\(skill\)[\s\S]*?renderSkillReferenceContent\(anchor, getSkillMentionNameForView\(skill\)\)/u);
  assert.match(transcriptScript, /sanitizeInlineEditorLinks\(editor\)[\s\S]*?renderSkillReferenceContent\(link, getSkillMentionNameForView\(skill\)\)/u);
  assert.match(transcriptScript, /token\.type === 'skill-link'[\s\S]*?createMessageSkillLink\(token\.skill\)/u);
  assert.match(transcriptScript, /type: 'skill-link'[\s\S]*?skill: skill/u);
  assert.match(inputScript, /function getSkillMarkdownText\(skill\)[\s\S]*?getSkillPromptText\(skill\)/u);
  assert.match(transcriptScript, /function getSkillMarkdownTextForView\(skill\)[\s\S]*?getSkillPromptTextForView\(skill\)/u);
});

test('skill suggestions reuse the plugin icon asset', () => {
  const inputScript = getInputScript();
  const transcriptScript = getScript();
  const styles = getStyles();

  assert.match(
    inputScript,
    /createSkillReferenceButton\(skill, index\)[\s\S]*?createSkillReferenceIcon\('reference-menu-item-icon reference-menu-skill-icon'\)/u
  );
  assert.doesNotMatch(inputScript, /icon\.textContent = '\$'/u);
  assert.match(transcriptScript, /image\.src = keepseekPluginIconUri/u);
  assert.match(styles, /\.reference-menu-skill-icon img\s*\{[^}]*width:\s*13px/us);
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

  assert.ok(!keys.some((key) => key.startsWith('kmvdata.keepseek.memory.')));
  assert.ok(!keys.includes('kmvdata.keepseek.projectInstructions.contextBudgetTokens'));
  assert.ok(keys.includes('kmvdata.keepseek.skills.maxImplicitActivations'));
});

test('Legacy Memory migration menu and host messages are removed', () => {
  assert.doesNotMatch(getInputTemplate(), /commandLegacyMemorySection/u);
  assert.doesNotMatch(getInputScript(), /createLegacyMemoryMigrationDraft|setSkillEnabled|setSkillAllowImplicit/u);
});

test('generated Webview JavaScript passes syntax compilation', () => {
  assert.doesNotThrow(() => new Function(getInputScript()));
  assert.doesNotThrow(() => new Function(getScript()));
});

test('context usage shows a placeholder instead of 0.00% before the session starts', () => {
  const inputScript = getInputScript();

  assert.match(inputScript, /var contextLine = \['usageMetricContextPercent', formatContextPercentValue\(usedPercent\)\];/u);
  assert.match(
    inputScript,
    /isContextUsagePending\(usedPercent\) \? t\('usagePendingValue'\) : formatRoundedPercent\(usedPercent\)/u
  );
  assert.match(
    inputScript,
    /progress\.setAttribute\('aria-label', t\('usageMetricContextPercent'\) \+ ' ' \+ formatContextPercentValue\(usedPercent\)\);/u
  );

  const formatContextPercent = new Function(`
    const t = key => key === 'usagePendingValue' ? '--' : key;
    const clampNumber = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
    ${getGeneratedSection(inputScript, 'function isContextUsagePending(value)', 'function formatMetricTokens(value, hasData)')}
    return { pending: isContextUsagePending, value: formatContextPercentValue };
  `)() as { pending: (value: number) => boolean; value: (value: number) => string };

  assert.equal(formatContextPercent.pending(0), true);
  assert.equal(formatContextPercent.pending(0), true);
  assert.equal(formatContextPercent.pending(0.001), true);
  assert.equal(formatContextPercent.pending(0.39), false);
  assert.equal(formatContextPercent.value(0), '--');
  assert.equal(formatContextPercent.value(0.001), '--');
  assert.equal(formatContextPercent.value(0.39), '0.39%');
  assert.equal(formatContextPercent.value(12), '12.00%');
});

test('ordinary notifications fade after eight seconds and expose long UTF-8 text in their tooltip', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'A',
    startup: { interactiveReady: true }, isBusy: false } });
  view.window.keepseekInputControls.showStatus('short');
  assert.equal(view.element('statusTooltip').classList.contains('hidden'), true);
  view.window.keepseekInputControls.showStatus('超过二十四个UTF8字节的提示');
  assert.equal(view.element('statusTooltip').classList.contains('hidden'), false);
  view.advance(7999);
  assert.equal(view.element('status').classList.contains('is-active'), true);
  view.advance(1);
  assert.equal(view.element('status').classList.contains('is-fading'), true);
  view.advance(120);
  assert.equal(view.element('statusText').textContent, '');
  assert.equal(view.element('statusTooltip').classList.contains('hidden'), true);
});

test('stream reconnect replaces only the failed model attempt and rejects stale or already consumed deltas', () => {
  const current = { id: 'answer', isStreaming: true, content: 'committedfailed', reasoningContent: 'keptfailed', runState: { attempt: 2 } };
  const previous = { id: 'previous', isStreaming: false, content: 'earlier message', reasoningContent: '', runState: { attempt: 1 } };
  const state = { activeSessionId: 'session', messages: [previous, current], agentActivity: {} };
  const apply = new Function('state', 'runStreamRevisions', `
    ${getGeneratedSection(getScript(), 'function applyAgentRunStreamPatch(message)', "window.removeEventListener('message'")}
    return applyAgentRunStreamPatch;
  `)(state, new Map()) as (message: Record<string, unknown>) => { reset?: boolean; contentTail?: string } | null;
  const identity = { sessionId: 'session', messageId: 'answer', attempt: 2, runState: { attempt: 2 }, activity: {} };
  const reset = { ...identity, type: 'agentRunAttemptReset', streamRevision: 2, content: 'committed', reasoningContent: 'kept' };
  assert.equal(apply(reset)?.reset, true);
  assert.equal(current.content, 'committed');
  assert.equal(current.reasoningContent, 'kept');
  assert.equal(previous.content, 'earlier message');
  assert.equal(apply({ ...identity, type: 'agentRunDelta', streamRevision: 1, contentOffset: 9, contentDelta: 'stale' }), null);
  const delta = { ...identity, type: 'agentRunDelta', streamRevision: 2, contentOffset: 9, contentDelta: 'success', reasoningOffset: 4, reasoningDelta: 'new' };
  assert.equal(apply(delta)?.contentTail, 'success');
  assert.equal(current.content, 'committedsuccess');
  assert.equal(current.reasoningContent, 'keptnew');
  assert.equal(apply(delta)?.contentTail, '');
  assert.equal(apply(reset), null, 'duplicate reset cannot erase the new attempt');
  assert.equal(apply({ ...delta, sessionId: 'another' }), null);
  assert.equal(apply({ ...delta, attempt: 1 }), null, 'task run attempt is distinct from stream revision');
  current.isStreaming = false;
  assert.equal(apply(delta), null);
});

test('reconnect status follows the operation through backoff and clears immediately on stop', () => {
  const view = createWebviewDomHarness();
  const activity = { base: 'thinking', phase: 'reconnecting', reconnectAttempt: 2,
    maxReconnectAttempts: 5, retryDelayMs: 16000 };
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'A', language: 'en',
    startup: { interactiveReady: true }, isBusy: true, agentActivity: activity } });
  assert.equal(view.element('statusText').textContent, 'Connection interrupted. Reconnecting (2/5).');
  view.advance(32000);
  assert.equal(view.element('statusText').textContent, 'Connection interrupted. Reconnecting (2/5).');
  view.receive({ type: 'state', revision: 2, state: { language: 'zh-CN',
    agentActivity: { ...activity, reconnectAttempt: 5 } } });
  assert.equal(view.element('statusText').textContent, '网络连接中断，正在重连（第 5/5 次）');
  view.receive({ type: 'state', revision: 3, state: { agentActivity: { ...activity, phase: 'generating' } } });
  assert.equal(view.element('statusText').textContent, '生成回答...');
  view.receive({ type: 'state', revision: 4, state: { isBusy: false,
    agentActivity: { base: 'stopped', phase: 'finalizing' } } });
  assert.equal(view.element('statusText').textContent, '已中止');
  view.advance(8120);
  assert.equal(view.element('statusText').textContent, '');
});

test('ChangeSets render in their assistant timeline entry with an unlinked actionable fallback', () => {
  const template = getTemplate();
  const script = getScript();

  assert.doesNotMatch(template, /id="draftRegion"|id="draftList"/u);
  assert.match(template, /id="unlinkedChangeSetRegion"/u);
  assert.match(script, /buildChangeSetTimelineProjection/u);
  assert.match(script, /changeSet\.messageId/u);
  assert.match(script, /body\.append\(createChangeSetCard\(changeSet\)\)/u);
  assert.match(script, /message\.role === 'assistant' && !message\.isStreaming/u);
  assert.match(script, /liveChangeSetFileIds\.has\(String\(file\.id\)\)/u);
  assert.match(script, /t\('changeSetBatchHint'\)/u);
  assert.match(script, /t\('changeSetApplyAll', \{ count: applicableFiles\.length \}\)/u);
  assert.doesNotMatch(script, /function renderDraftEdits/u);
});

test('conversation panels and expanded draft content share the transcript vertical scrollbar', () => {
  const template = getTemplate();
  const script = getScript();
  const styles = getStyles();
  const draftBarStyles = getGeneratedSection(styles, '    .draft-bar {', '\n    .draft-bar-header');
  const draftOutputStyles = getGeneratedSection(styles, '    .draft-run-output {', '\n    .change-set-partially_failed');
  const codeBlockStyles = getGeneratedSection(styles, '    .message-code-block pre {', '\n    .message-code-block code');

  assert.match(template, /<section id="transcript"[^>]*>[\s\S]*?<section id="planRegion"[\s\S]*?<aside id="unlinkedChangeSetRegion"[\s\S]*?<\/aside>\s*<\/section>/u);
  assert.match(script, /function renderTranscript[\s\S]*?planRegion\.remove\(\)[\s\S]*?unlinkedChangeSetRegion\.remove\(\)[\s\S]*?transcript\.append\(planRegion\)[\s\S]*?transcript\.append\(unlinkedChangeSetRegion\)[\s\S]*?renderUnlinkedChangeSets/u);
  assert.doesNotMatch(script, /unlinkedChangeSetList\.addEventListener\('click'/u);
  assert.match(styles, /\.transcript\s*\{[\s\S]*?overflow-y:\s*auto/u);
  assert.match(draftBarStyles, /max-height:\s*none/u);
  assert.match(draftBarStyles, /overflow-y:\s*visible/u);
  assert.doesNotMatch(draftOutputStyles, /max-height|overflow-y:\s*auto/u);
  assert.match(draftOutputStyles, /overflow-y:\s*visible/u);
  assert.doesNotMatch(codeBlockStyles, /max-height|overflow-y:\s*auto/u);
  assert.match(codeBlockStyles, /overflow-y:\s*visible/u);
});

test('ChangeSet controls stay stacked and wrapping in a narrow Secondary Sidebar', () => {
  const styles = getStyles();

  assert.match(styles, /\.change-set-actions\s*\{[\s\S]*?flex-wrap:\s*wrap/u);
  assert.match(styles, /\.draft-chip-actions\s*\{[\s\S]*?flex-wrap:\s*wrap/u);
  assert.match(styles, /@media \(min-width: 380px\)/u);
  assert.match(styles, /\.change-set-actions button\s*\{[\s\S]*?max-width:\s*100%/u);
});

test('delete DraftEdits require a path-aware modal before the Provider applies them', async () => {
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  assert.match(providerSource, /getPendingDeleteTargetsForEdit\(message\.id\)[\s\S]*?confirmDeleteApply/u);
  assert.match(providerSource, /getPendingDeleteTargetsForChangeSet\(message\.id\)[\s\S]*?confirmDeleteApply/u);
  assert.match(providerSource, /showWarningMessage\([\s\S]*?\{ modal: true, detail \}/u);
});

test('Skill creation attaches its grouped ChangeSet to an explicit timeline message', async () => {
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  assert.match(providerSource, /appendChangeSetTimelineMessage\([\s\S]*?createSkillDraftCreated[\s\S]*?messageId: timelineMessage\.id/u);
  assert.doesNotMatch(providerSource, /legacyMemoryMigrationDraftCreated/u);
});

function getGeneratedSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing generated section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing generated section end: ${endMarker}`);
  return source.slice(start, end);
}
