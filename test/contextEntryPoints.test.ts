import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { getStyles } from '../src/webview/styles';
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
  assert.equal(terminalSelectionMenu?.when, 'terminalTextSelected');
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
  assert.ok(match?.[1] && containerIds.includes(match[1]));
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

  assert.deepEqual(properties['keepseek.selectedSourceId'], {
    type: 'string',
    default: '',
    scope: 'window',
    markdownDescription: 'Source ID paired with `keepseek.selectedModelId` for the selected model. This is model identity, not a globally active source.'
  });

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
  assert.deepEqual(properties['keepseek.compressionThreshold'], {
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
  assert.match(inputScript, /type: 'refreshSourceModels'/u);
  assert.doesNotMatch(inputScript, /type: 'selectAccount'/u);
  assert.match(inputScript, /function beginSettingsDialogAction/u);
  assert.match(inputScript, /function blockSettingsActionForUnsavedChanges/u);
  assert.match(inputScript, /function blockAccountSettingsWhileRunBusy/u);
  assert.match(inputScript, /function syncAccountSettingsRunBusyStatus/u);
  assert.match(inputScript, /function trapSettingsDialogFocus/u);
  assert.match(inputScript, /var runBusy = Boolean\(state\.isBusy\)/u);
  assert.match(inputScript, /var controlsDisabled = operationBusy \|\| runBusy/u);
  assert.match(inputScript, /button\.disabled = controlsDisabled \|\| !account\.enabled/u);
  assert.match(inputScript, /settingsCancelBtn\.disabled = operationBusy/u);
  assert.match(inputScript, /t\('modelSettingsReadonlyWhileBusy'\)/u);
  assert.ok((inputScript.match(/blockAccountSettingsWhileRunBusy\(\)/gu) ?? []).length >= 9);
  assert.match(i18nSource, /modelSettingsReadonlyWhileBusy: '正在生成回复；完成或停止后才能修改模型设置。'/u);
  assert.match(i18nSource, /modelSettingsReadonlyWhileBusy: 'Model settings are read-only while a response is being generated\. Finish or stop it first\.'/u);
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
  assert.match(inputScript, /enableCheckbox\.type = 'checkbox'/u);
  assert.match(inputScript, /disabledModelIds/u);
  assert.match(styles, /@media \(max-width: 540px\)/u);
  assert.match(messageSource, /type: 'addModel'/u);
  assert.match(messageSource, /contextWindowTokens\?: number/u);
  assert.match(messageSource, /maxOutputTokens\?: number/u);
  assert.match(messageSource, /type: 'saveModelSource'/u);
  assert.match(messageSource, /type: 'deleteModel'/u);
  assert.match(messageSource, /type: 'setModelEnabled'/u);
  assert.doesNotMatch(inputScript, /window\.(?:prompt|alert|confirm)\s*\(/u);
});

test('command model labels prefer fetched names while hover keeps the model id', () => {
  const inputScript = getInputScript();

  assert.match(
    inputScript,
    /return model\.fetchedName \|\| model\.label \|\| model\.id \|\| 'Model'/u
  );
  assert.match(inputScript, /label\.title = model\.id \|\| getModelDisplayLabel\(model\)/u);
  assert.match(inputScript, /option\.title = model\.id \|\| getModelDisplayLabel\(model\)/u);
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
  assert.doesNotThrow(() => new Function(getInputScript()));
  assert.doesNotThrow(() => new Function(getScript()));
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
  assert.doesNotMatch(script, /function renderDraftEdits/u);
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

test('Skill creation and Legacy Memory migration attach their ChangeSets to explicit timeline messages', async () => {
  const providerSource = await readFile(
    path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'),
    'utf8'
  );

  assert.match(providerSource, /appendChangeSetTimelineMessage\([\s\S]*?createSkillDraftCreated[\s\S]*?messageId: timelineMessage\.id/u);
  assert.match(providerSource, /legacyMemoryMigrationDraftCreated[\s\S]*?messageId: timelineMessage\?\.id/u);
});

function getGeneratedSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `Missing generated section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `Missing generated section end: ${endMarker}`);
  return source.slice(start, end);
}
