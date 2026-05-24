import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getExplorerFileUris, getFileReferenceAuthorizationKey, resolveFileReferenceUri } from './fileReference';
import { AgentRunner } from './agentRunner';
import { FileContextStore } from './fileContext';
import { SafeFileEditor } from './safeFileEditor';
import { AgentSettings, ChatMessage } from './types';
import { getConfiguredKeepseekLanguage, getKeepseekLanguageName, localize, normalizeKeepseekLanguage, type KeepseekLanguage } from './i18n';
import { ChatSessionStore, createSessionTitle, getVisibleMessages } from './chatSessionStore';
import { createContextUsageEstimate } from './contextUsage';
import { DraftEditStore } from './draftEditStore';
import { openFileReference } from './fileReferenceOpener';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_RUN_MS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
  getConfiguredAgentSettings,
  getConfiguredMaxFileBytes,
  getConfiguredMaxRunMs,
  getConfiguredMaxToolCalls,
  getConfiguredMaxToolIterations,
  getConfiguredMaxTokens,
  getConfiguredModels,
  getConfiguredSelectedModelId,
  getConfiguredStreamIdleTimeoutMs,
  getConfiguredToolResultTokenBudget,
  MAX_GENERATION_TOKENS,
  MAX_RUN_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MAX_TOOL_CALLS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_TOKEN_BUDGET,
  normalizeAgentSettings,
  normalizeIntegerInRange
} from './config';
import { getErrorMessage } from './errors';
import { formatBytes } from './format';
import { ensureKeybindings } from './keybindings';
import { expandPromptReferencesInPrompt } from './promptReferences';
import { getWorkspaceReferenceResources } from './referenceResources';
import { getHtmlForWebview } from './webview/html';
import {
  copySelectionTextWithClipboardRestore,
  createTextReferenceFileName,
  getDocumentSelectionTextReferenceSource,
  getTextReferenceDocumentName,
  sanitizeDroppedFileName,
  sanitizeTextReferenceFileName,
  TEXT_REFERENCE_STORAGE_DIR,
  type TextReferenceSource
} from './textReferences';

const CHAT_CONTAINER_ID = 'keepseek';
const CHAT_VIEW_TYPE = 'keepseek.chatView';

interface PromptReferenceInput {
  path: string;
  kind?: 'file' | 'directory';
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

interface DroppedFileReferenceInput {
  name: string;
  type?: string;
  size?: number;
  lastModified?: number;
  dataBase64: string;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[] }
  | { type: 'editUserPrompt'; messageId: string; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[] }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'setSelectedModel'; modelId: string }
  | { type: 'setAgentSettings'; settings: Partial<AgentSettings> }
  | { type: 'openApiSettings' }
  | { type: 'openAgentBudgetSettings' }
  | {
      type: 'saveApiSettings';
      apiKey: string;
      baseUrl: string;
    }
  | {
      type: 'saveAgentBudgetSettings';
      maxTokens?: number;
      maxToolIterations?: number;
      maxToolCalls?: number;
      maxRunMs?: number;
      streamIdleTimeoutMs?: number;
      toolResultTokenBudget?: number;
    }
  | { type: 'setLanguage'; language: KeepseekLanguage }
  | { type: 'addCurrentFile' }
  | { type: 'pickWorkspaceFiles' }
  | { type: 'pickExternalFiles' }
  | { type: 'pickExternalFileReferences' }
  | { type: 'insertDroppedFileReferences'; files: DroppedFileReferenceInput[] }
  | { type: 'requestReferenceResources'; requestId: string }
  | { type: 'readPath'; path: string }
  | { type: 'openFileReference'; path: string; startLine: number; endLine: number; startColumn: number; endColumn: number }
  | { type: 'openDirectoryReference'; path: string }
  | { type: 'removeContextFile'; uri: string }
  | { type: 'clearContext' }
  | { type: 'applyDraftEdit'; id: string }
  | { type: 'discardDraftEdit'; id: string }
  | { type: 'applyAllDraftEdits' }
  | { type: 'discardAllDraftEdits' };

class KeepseekChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner = new AgentRunner();
  private readonly sessionStore: ChatSessionStore;
  private readonly draftEdits: DraftEditStore;
  private readonly authorizedExternalReferenceUris = new Set<string>();
  private readonly views = new Set<vscode.WebviewView>();
  private selectedModelId = getConfiguredSelectedModelId();
  private agentSettings = getConfiguredAgentSettings();
  private language = getConfiguredKeepseekLanguage();
  private isBusy = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    sessionStorage: vscode.Memento,
    private readonly globalStorageUri: vscode.Uri
  ) {
    this.sessionStore = new ChatSessionStore(sessionStorage, this.language);
    this.draftEdits = new DraftEditStore(new SafeFileEditor(), this.sessionStore, (key, values) => this.t(key, values));
  }

  public refreshConfiguration(): void {
    this.syncConfiguredState();
    this.postState();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.views.add(webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      enableDragAndDrop: true,
      localResourceRoots: [this.extensionUri]
    } as vscode.WebviewOptions;
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      this.views.delete(webviewView);
    });
  }

  public async reveal(): Promise<void> {
    await focusView(CHAT_CONTAINER_ID, CHAT_VIEW_TYPE);
  }

  public async addCurrentFileToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const file = await this.fileContext.addCurrentEditor();
      vscode.window.showInformationMessage(this.t('addedFile', { label: file.label }));
    });
  }

  public async pickWorkspaceFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickWorkspaceFiles();
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedWorkspaceFiles', { count: files.length }));
      }
    });
  }

  public async insertSelectionToInput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const documentSelectionSource = getDocumentSelectionTextReferenceSource(editor.document);
    if (documentSelectionSource) {
      await this.insertDocumentSelectionReferenceToInput(editor, documentSelectionSource);
      return;
    }

    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const startColumn = editor.selection.start.character + 1;
    const endColumn = editor.selection.end.character + 1;
    const path = editor.document.uri.fsPath;

    await this.reveal();
    this.authorizeExternalReferenceUri(editor.document.uri);
    this.postToWebview({ type: 'insertFileReference', path, startLine, endLine, startColumn, endColumn });
  }

  public async insertTerminalSelectionToInput(): Promise<void> {
    if (!vscode.window.activeTerminal) {
      vscode.window.showWarningMessage(this.t('selectTerminalTextToAdd'));
      return;
    }

    await this.insertClipboardSelectionReferenceToInput({
      copyCommand: 'workbench.action.terminal.copySelection',
      fileName: createTextReferenceFileName('terminal-selection', vscode.window.activeTerminal.name),
      emptySelectionMessageKey: 'selectTerminalTextToAdd',
      errorMessageKey: 'cannotAddTerminalSelection'
    });
  }

  public async insertDebugConsoleSelectionToInput(): Promise<void> {
    await this.insertClipboardSelectionReferenceToInput({
      copyCommand: 'debug.replCopy',
      fileName: createTextReferenceFileName('debug-console-selection'),
      emptySelectionMessageKey: 'selectDebugConsoleTextToAdd',
      errorMessageKey: 'cannotAddDebugConsoleSelection'
    });
  }

  public async insertExplorerFileToInput(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): Promise<void> {
    let targetUris = getExplorerFileUris(uri, selectedUris);
    if (!targetUris.length) {
      // Keybinding invocation — no context-menu arguments. Fall back to the active editor's file,
      // which matches the Explorer selection when the user single-clicked it (preview mode).
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme !== 'output' && editor.document.uri.scheme !== 'debug') {
        targetUris = [editor.document.uri];
      }
    }
    if (!targetUris.length) {
      vscode.window.showWarningMessage(this.t('chooseFileToAdd'));
      return;
    }

    try {
      const files: vscode.Uri[] = [];
      for (const targetUri of targetUris) {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.File) {
          files.push(targetUri);
        }
      }

      if (!files.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertExplorerFiles'));
        return;
      }

      await this.reveal();
      for (const file of files) {
        this.authorizeExternalReferenceUri(file);
        this.postToWebview({
          type: 'insertFileReference',
          path: file.fsPath,
          startLine: 0,
          endLine: 0
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddFileReference', { message: getErrorMessage(error) }));
    }
  }

  public async insertExplorerDirectoryToInput(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): Promise<void> {
    const targetUris = getExplorerFileUris(uri, selectedUris);
    if (!targetUris.length) {
      vscode.window.showWarningMessage(this.t('chooseDirectoryToAdd'));
      return;
    }

    try {
      const directories: vscode.Uri[] = [];
      for (const targetUri of targetUris) {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.Directory) {
          directories.push(targetUri);
        }
      }

      if (!directories.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertExplorerDirectories'));
        return;
      }

      await this.reveal();
      for (const directory of directories) {
        this.authorizeExternalReferenceUri(directory);
        this.postToWebview({
          type: 'insertDirectoryReference',
          path: directory.fsPath
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddDirectoryReference', { message: getErrorMessage(error) }));
    }
  }

  public async pickExternalFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickExternalFiles();
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedExternalFiles', { count: files.length }));
      }
    });
  }

  public async pickExternalFileReferencesToInput(): Promise<void> {
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: this.t('addExternalFilesLabel')
      });

      if (!picked?.length) {
        return;
      }

      const files: vscode.Uri[] = [];
      let skipped = 0;
      for (const uri of picked) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            files.push(uri);
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }

      if (!files.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertFileReferencesForFiles'));
        return;
      }
      if (skipped > 0) {
        vscode.window.showWarningMessage(this.t('skippedUnreadableItems', { count: skipped }));
      }

      for (const file of files) {
        this.authorizeExternalReferenceUri(file);
        this.postToWebview({
          type: 'insertFileReference',
          path: file.fsPath,
          startLine: 0,
          endLine: 0
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddExternalFileReference', { message: getErrorMessage(error) }));
    }
  }

  public async insertDroppedFileReferencesToInput(files: DroppedFileReferenceInput[]): Promise<void> {
    if (!Array.isArray(files) || !files.length) {
      return;
    }

    try {
      const maxBytes = getConfiguredMaxFileBytes();
      const dropDir = vscode.Uri.joinPath(this.globalStorageUri, 'dropped-file-references', randomUUID());
      await vscode.workspace.fs.createDirectory(dropDir);

      let inserted = 0;
      let skipped = 0;

      for (const file of files) {
        if (!file || typeof file.dataBase64 !== 'string') {
          skipped += 1;
          continue;
        }

        const declaredSize = typeof file.size === 'number' ? file.size : undefined;
        const maxBase64Length = Math.ceil(maxBytes / 3) * 4 + 4;
        if ((declaredSize !== undefined && declaredSize > maxBytes) || file.dataBase64.length > maxBase64Length) {
          skipped += 1;
          continue;
        }

        const bytes = Buffer.from(file.dataBase64, 'base64');
        const expectedSize = declaredSize ?? bytes.byteLength;
        if (!bytes.byteLength && expectedSize > 0) {
          skipped += 1;
          continue;
        }
        if (bytes.byteLength > maxBytes || expectedSize > maxBytes) {
          skipped += 1;
          continue;
        }

        const fileName = sanitizeDroppedFileName(file.name);
        const fileDir = vscode.Uri.joinPath(dropDir, randomUUID());
        await vscode.workspace.fs.createDirectory(fileDir);
        const fileUri = vscode.Uri.joinPath(fileDir, fileName);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
        this.authorizeExternalReferenceUri(fileUri);
        this.postToWebview({
          type: 'insertFileReference',
          path: fileUri.fsPath,
          startLine: 0,
          endLine: 0
        });
        inserted += 1;
      }

      if (skipped > 0) {
        vscode.window.showWarningMessage(this.t('skippedDroppedFiles', { count: skipped }));
      }
      if (!inserted && skipped === 0) {
        vscode.window.showWarningMessage(this.t('didNotFindDroppedFiles'));
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotImportDroppedFile', { message: getErrorMessage(error) }));
    }
  }

  private async insertDocumentSelectionReferenceToInput(editor: vscode.TextEditor, source: TextReferenceSource): Promise<void> {
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage(this.t('selectTextToAdd'));
      return;
    }

    try {
      const fileName = createTextReferenceFileName(`${source === 'output' ? 'output' : 'debug-console'}-selection`, getTextReferenceDocumentName(editor.document));
      await this.insertTextReferenceToInput(editor.document.getText(editor.selection), fileName);
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddTextSelection', { message: getErrorMessage(error) }));
    }
  }

  private async insertClipboardSelectionReferenceToInput(options: {
    copyCommand: string;
    fileName: string;
    emptySelectionMessageKey: string;
    errorMessageKey: string;
  }): Promise<void> {
    try {
      const selectionText = await copySelectionTextWithClipboardRestore(options.copyCommand);
      if (!selectionText.trim()) {
        vscode.window.showWarningMessage(this.t(options.emptySelectionMessageKey));
        return;
      }

      await this.insertTextReferenceToInput(selectionText, options.fileName);
    } catch (error) {
      vscode.window.showErrorMessage(this.t(options.errorMessageKey, { message: getErrorMessage(error) }));
    }
  }

  private async insertTextReferenceToInput(content: string, fileName: string): Promise<void> {
    const normalizedContent = content.replace(/\r\n?/gu, '\n');
    if (!normalizedContent.trim()) {
      vscode.window.showWarningMessage(this.t('selectTextToAdd'));
      return;
    }

    const bytes = new TextEncoder().encode(normalizedContent);
    const maxBytes = getConfiguredMaxFileBytes();
    if (bytes.byteLength > maxBytes) {
      vscode.window.showWarningMessage(this.t('selectedTextTooLarge', { limit: formatBytes(maxBytes) }));
      return;
    }

    const referenceDir = vscode.Uri.joinPath(this.globalStorageUri, TEXT_REFERENCE_STORAGE_DIR, randomUUID());
    await vscode.workspace.fs.createDirectory(referenceDir);
    const fileUri = vscode.Uri.joinPath(referenceDir, sanitizeTextReferenceFileName(fileName));
    await vscode.workspace.fs.writeFile(fileUri, bytes);

    await this.reveal();
    this.authorizeExternalReferenceUri(fileUri);
    this.postToWebview({
      type: 'insertFileReference',
      path: fileUri.fsPath,
      startLine: 0,
      endLine: 0
    });
    vscode.window.showInformationMessage(this.t('addedTextSelection'));
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.syncConfiguredState();
        this.postState();
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt, message.modelId, message.settings, { references: message.references });
        return;
      case 'editUserPrompt':
        await this.sendPrompt(message.prompt, message.modelId, message.settings, { replaceMessageId: message.messageId, references: message.references });
        return;
      case 'newSession':
        await this.createNewSession();
        return;
      case 'selectSession':
        await this.selectSession(message.sessionId);
        return;
      case 'setSelectedModel':
        await this.setSelectedModel(message.modelId);
        return;
      case 'setAgentSettings':
        await this.setAgentSettings(message.settings);
        return;
      case 'openApiSettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        this.postToWebview({
          type: 'showSettingsDialog',
          apiKey: config.get<string>('apiKey', ''),
          baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL)
        });
        return;
      }
      case 'openAgentBudgetSettings': {
        this.postToWebview({
          type: 'showAgentBudgetDialog',
          maxTokens: getConfiguredMaxTokens(),
          maxToolIterations: getConfiguredMaxToolIterations(),
          maxToolCalls: getConfiguredMaxToolCalls(),
          maxRunMs: getConfiguredMaxRunMs(),
          streamIdleTimeoutMs: getConfiguredStreamIdleTimeoutMs(),
          toolResultTokenBudget: getConfiguredToolResultTokenBudget()
        });
        return;
      }
      case 'saveApiSettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('apiKey', message.apiKey, vscode.ConfigurationTarget.Global);
        await config.update('baseUrl', message.baseUrl, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(this.t('apiSettingsSaved'));
        return;
      }
      case 'saveAgentBudgetSettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('maxTokens', normalizeIntegerInRange(message.maxTokens, 0, MAX_GENERATION_TOKENS, DEFAULT_MAX_TOKENS), vscode.ConfigurationTarget.Global);
        await config.update('maxToolIterations', normalizeIntegerInRange(message.maxToolIterations, 0, MAX_TOOL_ITERATIONS, DEFAULT_MAX_TOOL_ITERATIONS), vscode.ConfigurationTarget.Global);
        await config.update('maxToolCalls', normalizeIntegerInRange(message.maxToolCalls, 0, MAX_TOOL_CALLS, DEFAULT_MAX_TOOL_CALLS), vscode.ConfigurationTarget.Global);
        await config.update('maxRunMs', normalizeIntegerInRange(message.maxRunMs, 0, MAX_RUN_MS, DEFAULT_MAX_RUN_MS), vscode.ConfigurationTarget.Global);
        await config.update('streamIdleTimeoutMs', normalizeIntegerInRange(message.streamIdleTimeoutMs, 0, MAX_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS), vscode.ConfigurationTarget.Global);
        await config.update('toolResultTokenBudget', normalizeIntegerInRange(message.toolResultTokenBudget, 0, MAX_TOOL_RESULT_TOKEN_BUDGET, DEFAULT_TOOL_RESULT_TOKEN_BUDGET), vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(this.t('agentBudgetSettingsSaved'));
        return;
      }
      case 'setLanguage': {
        const language = normalizeKeepseekLanguage(message.language);
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('language', language, vscode.ConfigurationTarget.Global);
        this.language = language;
        await this.sessionStore.relocalizeEmptySessionTitles(language);
        this.postState();
        vscode.window.showInformationMessage(
          this.t('languageSaved', { language: getKeepseekLanguageName(language, language) })
        );
        return;
      }
      case 'addCurrentFile':
        await this.addCurrentFileToContext();
        return;
      case 'pickWorkspaceFiles':
        await this.pickWorkspaceFilesToContext();
        return;
      case 'pickExternalFiles':
        await this.pickExternalFilesToContext();
        return;
      case 'pickExternalFileReferences':
        await this.pickExternalFileReferencesToInput();
        return;
      case 'insertDroppedFileReferences':
        await this.insertDroppedFileReferencesToInput(message.files);
        return;
      case 'requestReferenceResources':
        await this.postReferenceResources(message.requestId);
        return;
      case 'readPath':
        await this.readPathToContext(message.path);
        return;
      case 'openFileReference':
        await openFileReference({
          path: message.path,
          startLine: message.startLine,
          endLine: message.endLine,
          startColumn: message.startColumn,
          endColumn: message.endColumn,
          language: this.language
        });
        return;
      case 'openDirectoryReference':
        await this.openDirectoryReference(message.path);
        return;
      case 'removeContextFile':
        this.fileContext.remove(message.uri);
        this.postState();
        return;
      case 'clearContext':
        this.fileContext.clear();
        this.postState();
        return;
      case 'applyDraftEdit':
        if (await this.draftEdits.apply(message.id)) {
          this.postState();
        }
        return;
      case 'discardDraftEdit':
        this.draftEdits.delete(message.id);
        this.postState();
        return;
      case 'applyAllDraftEdits':
        if (await this.draftEdits.applyAll()) {
          this.postState();
        }
        return;
      case 'discardAllDraftEdits':
        this.draftEdits.clear();
        this.postState();
        return;
    }
  }

  private get messages(): ChatMessage[] {
    return this.sessionStore.messages;
  }

  private async createNewSession(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    this.draftEdits.clear();
    await this.sessionStore.createNewSession(this.language);
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async selectSession(sessionId: string): Promise<void> {
    if (this.isBusy || sessionId === this.sessionStore.activeSessionId) {
      return;
    }

    const session = await this.sessionStore.selectSession(sessionId);
    if (!session) {
      return;
    }

    this.draftEdits.clear();
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async readPathToContext(inputPath: string): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.addPath(inputPath);
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedFiles', { count: files.length }));
      }
    });
  }

  private async postReferenceResources(requestId: string): Promise<void> {
    try {
      this.postToWebview({
        type: 'referenceResources',
        requestId,
        resources: await getWorkspaceReferenceResources()
      });
    } catch (error) {
      this.postToWebview({
        type: 'referenceResources',
        requestId,
        resources: [],
        error: getErrorMessage(error)
      });
    }
  }

  private async openDirectoryReference(inputPath: string): Promise<void> {
    try {
      if (!inputPath.trim()) {
        throw new Error(this.t('directoryReferenceNoPath'));
      }

      const uri = resolveFileReferenceUri(inputPath);
      if (!uri) {
        throw new Error(this.t('directoryReferenceInvalidPath'));
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.Directory) {
        throw new Error(this.t('directoryReferenceInvalidPath'));
      }

      await vscode.commands.executeCommand('revealInExplorer', uri);
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotOpenDirectoryReference', { message: getErrorMessage(error) }));
    }
  }

  private async setSelectedModel(modelId: string): Promise<void> {
    const models = getConfiguredModels();
    if (!models.some((model) => model.id === modelId)) {
      return;
    }
    this.selectedModelId = modelId;
    const config = vscode.workspace.getConfiguration('keepseek');
    await config.update('selectedModelId', modelId, vscode.ConfigurationTarget.Global);
    this.postState();
  }

  private syncConfiguredState(): void {
    const models = getConfiguredModels();
    this.selectedModelId = getConfiguredSelectedModelId(models);
    this.agentSettings = getConfiguredAgentSettings();
    this.language = getConfiguredKeepseekLanguage();
    this.sessionStore.setLanguage(this.language);
  }

  private async setAgentSettings(settings: Partial<AgentSettings>): Promise<void> {
    this.agentSettings = normalizeAgentSettings(settings, this.agentSettings);
    const config = vscode.workspace.getConfiguration('keepseek');
    await Promise.all([
      config.update('thinkingEnabled', this.agentSettings.thinkingEnabled, vscode.ConfigurationTarget.Global),
      config.update('reasoningEffort', this.agentSettings.reasoningEffort, vscode.ConfigurationTarget.Global)
    ]);
    this.postState();
  }

  private async runContextAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.postState();
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
      this.postState();
    }
  }

  private collectAuthorizedExternalReferenceUris(references: PromptReferenceInput[] | undefined): Set<string> {
    const authorized = new Set(this.authorizedExternalReferenceUris);
    if (!references?.length) {
      return authorized;
    }

    for (const reference of references) {
      if (!reference || typeof reference.path !== 'string') {
        continue;
      }
      const uri = resolveFileReferenceUri(reference.path);
      if (!uri || vscode.workspace.getWorkspaceFolder(uri)) {
        continue;
      }
      const key = getFileReferenceAuthorizationKey(uri);
      this.authorizedExternalReferenceUris.add(key);
      authorized.add(key);
    }

    return authorized;
  }

  private authorizeExternalReferenceUri(uri: vscode.Uri): void {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return;
    }
    this.authorizedExternalReferenceUris.add(getFileReferenceAuthorizationKey(uri));
  }

  private async sendPrompt(
    prompt: string,
    modelId: string,
    settings?: Partial<AgentSettings>,
    options?: { replaceMessageId?: string; references?: PromptReferenceInput[] }
  ): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || this.isBusy) {
      return;
    }

    const replaceMessageId = options?.replaceMessageId;
    if (replaceMessageId) {
      const targetIndex = this.sessionStore.getActiveSession().messages.findIndex((message) => message.id === replaceMessageId && message.role === 'user');
      if (targetIndex < 0) {
        return;
      }
    }

    this.agentSettings = normalizeAgentSettings(settings, this.agentSettings);
    const models = getConfiguredModels();
    const model = models.find((item) => item.id === modelId) ?? models[0];
    this.selectedModelId = model.id;

    this.isBusy = true;
    this.postState();

    let assistantMessage: ChatMessage | undefined;
    let liveStateTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleLiveState = () => {
      if (liveStateTimer) {
        return;
      }
      liveStateTimer = setTimeout(() => {
        liveStateTimer = undefined;
        this.postState();
      }, 80);
    };
    const flushLiveState = () => {
      if (liveStateTimer) {
        clearTimeout(liveStateTimer);
        liveStateTimer = undefined;
      }
      this.postState();
    };

    try {
      const authorizedExternalReferenceUris = this.collectAuthorizedExternalReferenceUris(options?.references);
      const expandedPrompt = await expandPromptReferencesInPrompt(trimmedPrompt, {
        authorizedExternalReferenceUris,
        language: this.language
      });
      const activeSession = this.sessionStore.getActiveSession();
      const now = new Date().toISOString();
      const replacementIndex = replaceMessageId
        ? activeSession.messages.findIndex((message) => message.id === replaceMessageId && message.role === 'user')
        : -1;

      if (replaceMessageId) {
        if (replacementIndex < 0) {
          return;
        }
        activeSession.messages.splice(replacementIndex);
        this.draftEdits.clear();
        if (replacementIndex === 0) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
      } else if (!activeSession.messages.length) {
        activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        activeSession.createdAt = now;
      }

      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: trimmedPrompt,
        createdAt: now,
        modelId: model.id
      };
      if (expandedPrompt !== trimmedPrompt) {
        userMessage.expandedContent = expandedPrompt;
      }
      this.messages.push(userMessage);
      activeSession.updatedAt = now;
      this.trimHistory();
      await this.sessionStore.persist();
      this.postState();

      const agentHistory = [...this.messages];
      assistantMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        reasoningContent: '',
        createdAt: new Date().toISOString(),
        modelId: model.id,
        isStreaming: true
      };
      this.messages.push(assistantMessage);
      this.trimHistory();
      this.postState();

      const response = await this.agentRunner.run({
        prompt: expandedPrompt,
        model,
        settings: this.agentSettings,
        contextFiles: this.fileContext.getAll(),
        history: agentHistory,
        language: this.language
      }, {
        onDelta: (event) => {
          if (!assistantMessage) {
            return;
          }
          if (event.type === 'reasoning') {
            assistantMessage.reasoningContent = `${assistantMessage.reasoningContent ?? ''}${event.delta}`;
          } else {
            assistantMessage.content = `${assistantMessage.content}${event.delta}`;
          }
          activeSession.updatedAt = new Date().toISOString();
          scheduleLiveState();
        }
      });

      this.draftEdits.addMany(response.draftEdits);

      if (assistantMessage) {
        assistantMessage.content = response.message;
        assistantMessage.reasoningContent = response.reasoningContent;
        delete assistantMessage.isStreaming;
      }
      this.trimHistory();
    } catch (error) {
      const activeSession = this.sessionStore.getActiveSession();
      if (!activeSession.messages.length) {
        const now = new Date().toISOString();
        activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        activeSession.createdAt = now;
      }
      if (assistantMessage) {
        const errorText = `${this.t('errorPrefix')}: ${getErrorMessage(error)}`;
        const hasPartialOutput = Boolean(assistantMessage.content.trim() || assistantMessage.reasoningContent?.trim());
        assistantMessage.content = hasPartialOutput
          ? [assistantMessage.content.trimEnd(), errorText].filter(Boolean).join('\n\n')
          : errorText;
        delete assistantMessage.isStreaming;
      } else {
        this.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: `${this.t('errorPrefix')}: ${getErrorMessage(error)}`,
          createdAt: new Date().toISOString(),
          modelId: model.id
        });
      }
    } finally {
      this.sessionStore.getActiveSession().updatedAt = new Date().toISOString();
      this.isBusy = false;
      await this.sessionStore.persist();
      flushLiveState();
    }
  }

  private trimHistory(): void {
    this.sessionStore.trimActiveHistory();
  }

  private postState(): void {
    const models = getConfiguredModels();
    if (!this.selectedModelId || !models.some((model) => model.id === this.selectedModelId)) {
      this.selectedModelId = models[0].id;
    }
    const selectedModel = models.find((model) => model.id === this.selectedModelId) ?? models[0];
    const contextFiles = this.fileContext.getAll();

    this.postToWebview({
      type: 'state',
      state: {
        models,
        selectedModelId: this.selectedModelId,
        agentSettings: this.agentSettings,
        messages: getVisibleMessages(this.messages),
        activeSessionId: this.sessionStore.activeSessionId,
        sessionSummaries: this.sessionStore.getSessionSummaries(),
        contextFiles: contextFiles.map(({ content: _content, ...file }) => file),
        contextUsage: createContextUsageEstimate({
          model: selectedModel,
          contextFiles,
          messages: this.messages,
          language: this.language
        }),
        draftEdits: this.draftEdits.toWebviewState(),
        isBusy: this.isBusy,
        maxFileBytes: getConfiguredMaxFileBytes(),
        language: this.language,
        isMac: process.platform === 'darwin'
      }
    });
  }

  private t(key: string, values?: Record<string, string | number>): string {
    return localize(this.language, key, values);
  }

  private postToWebview(message: unknown): void {
    for (const view of this.views) {
      void view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return getHtmlForWebview({
      webview,
      extensionUri: this.extensionUri,
      language: this.language
    });
  }
}

export function activate(context: vscode.ExtensionContext): void {
  ensureKeybindings(context);

  const provider = new KeepseekChatViewProvider(context.extensionUri, context.workspaceState, context.globalStorageUri);

  const webviewProviders: vscode.Disposable[] = [
    vscode.window.registerWebviewViewProvider(KeepseekChatViewProvider.viewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  ];

  context.subscriptions.push(
    ...webviewProviders,
    vscode.commands.registerCommand('keepseek.openChat', () => provider.reveal()),
    vscode.commands.registerCommand('keepseek.addCurrentFileToContext', () => provider.addCurrentFileToContext()),
    vscode.commands.registerCommand('keepseek.pickWorkspaceFilesToContext', () => provider.pickWorkspaceFilesToContext()),
    vscode.commands.registerCommand('keepseek.pickExternalFilesToContext', () => provider.pickExternalFilesToContext()),
    vscode.commands.registerCommand('keepseek.addSelectionToContext', () => provider.insertSelectionToInput()),
    vscode.commands.registerCommand('keepseek.addTerminalSelectionToContext', () => provider.insertTerminalSelectionToInput()),
    vscode.commands.registerCommand('keepseek.addDebugConsoleSelectionToContext', () => provider.insertDebugConsoleSelectionToInput()),
    vscode.commands.registerCommand(
      'keepseek.addExplorerFileToContext',
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.insertExplorerFileToInput(uri, selectedUris)
    ),
    vscode.commands.registerCommand(
      'keepseek.addExplorerDirectoryToContext',
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.insertExplorerDirectoryToInput(uri, selectedUris)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('keepseek')) {
        provider.refreshConfiguration();
      }
    })
  );
}

export function deactivate(): void {}

async function focusView(containerId: string, viewType: string): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${containerId}`);
  await vscode.commands.executeCommand(`${viewType}.focus`);
}
