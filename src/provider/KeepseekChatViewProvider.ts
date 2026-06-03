import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getExplorerFileUris, getFileReferenceAuthorizationKey, resolveFileReferenceUri } from '../context/references/fileReference';
import { AgentRunAbortedError, AgentRunner } from '../agent/runner';
import { HistoryCompressor } from '../agent/historyCompressor';
import { createProtectedContextMeta } from '../agent/historyProjection';
import { FileContextStore } from '../context/fileContextStore';
import { SafeFileEditor } from '../edits/safeFileEditor';
import {
  AgentActivityInput,
  AgentActivityState,
  AgentSettings,
  ChatMessage,
  ChatSession,
  ContextUsageEstimate,
  KeepseekModel,
  WorkspaceSummary
} from '../shared/types';
import { getConfiguredKeepseekLanguage, getKeepseekLanguageName, localize, normalizeKeepseekLanguage } from '../shared/i18n';
import { ChatSessionStore, createSessionTitle, getCurrentWorkspaceSessionScope, getVisibleMessages } from '../sessions/chatSessionStore';
import {
  addInputTokensToContextUsage,
  createDisplayedSessionContextUsageEstimate,
  finalizeSessionContextUsageEstimate,
  pickLargerContextUsageEstimate,
  toSessionContextUsageEstimate
} from '../agent/contextUsage';
import { DraftEditStore } from '../edits/draftEditStore';
import { openFileReference } from '../context/references/fileReferenceOpener';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_HISTORY_RETENTION_DAYS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_RUN_MS,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_TOOL_ITERATIONS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_TOOL_RESULT_TOKEN_BUDGET,
  getConfiguredAgentSettings,
  getConfiguredDebugMode,
  getConfiguredHistoryRetentionDays,
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
  MAX_HISTORY_RETENTION_DAYS,
  MAX_RUN_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  MAX_TOOL_CALLS,
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_RESULT_TOKEN_BUDGET,
  MIN_HISTORY_RETENTION_DAYS,
  normalizeAgentSettings,
  normalizeIntegerInRange
} from '../shared/config';
import { getErrorMessage } from '../shared/errors';
import { formatBytes } from '../shared/format';
import { expandPromptReferencesInPrompt } from '../context/references/promptReferences';
import { getWorkspaceReferenceResources } from '../context/references/referenceResources';
import { getHtmlForWebview } from '../webview/html';
import { focusView } from './focusView';
import type { DroppedFileReferenceInput, PromptReferenceInput, WebviewMessage } from './webviewMessages';
import { InteractionTraceLogService } from '../agent/logging/interactionTrace';
import {
  copySelectionTextWithClipboardRestore,
  createTextReferenceFileName,
  getDocumentSelectionTextReferenceSource,
  getTextReferenceDocumentName,
  sanitizeDroppedFileName,
  sanitizeTextReferenceFileName,
  TEXT_REFERENCE_STORAGE_DIR,
  type TextReferenceSource
} from '../context/textReferences';

const CHAT_CONTAINER_ID = 'keepseek';
const CHAT_VIEW_TYPE = 'keepseek.chatView';
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class KeepseekChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner: AgentRunner;
  private readonly historyCompressor = new HistoryCompressor();
  private readonly traceLogService: InteractionTraceLogService;
  private readonly draftEdits: DraftEditStore;
  private readonly sessionTraceLogUris = new Map<string, string>();
  private readonly authorizedExternalReferenceUris = new Set<string>();
  private readonly views = new Set<vscode.WebviewView>();
  private selectedModelId = getConfiguredSelectedModelId();
  private agentSettings = getConfiguredAgentSettings();
  private language = getConfiguredKeepseekLanguage();
  private isBusy = false;
  private currentRunAbortController: AbortController | undefined;
  private liveContextUsage: ContextUsageEstimate | undefined;
  private agentActivitySequence = 0;
  private agentActivity: AgentActivityState = {
    base: 'idle',
    phase: 'idle',
    updatedAt: new Date().toISOString(),
    sequence: 0
  };
  private readonly sessionCleanupTimer: ReturnType<typeof setInterval>;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: ChatSessionStore,
    private readonly globalStorageUri: vscode.Uri
  ) {
    this.traceLogService = new InteractionTraceLogService(this.globalStorageUri);
    this.agentRunner = new AgentRunner(undefined, this.traceLogService);
    this.draftEdits = new DraftEditStore(
      new SafeFileEditor((key, values) => this.t(key, values)),
      this.sessionStore,
      (key, values) => this.t(key, values)
    );
    void this.cleanupExpiredSessions({ post: false });
    this.sessionCleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, SESSION_CLEANUP_INTERVAL_MS);
  }

  public dispose(): void {
    clearInterval(this.sessionCleanupTimer);
  }

  public refreshConfiguration(): void {
    this.syncConfiguredState();
    void this.cleanupExpiredSessions();
    this.postState();
  }

  public async refreshWorkspaceScope(): Promise<void> {
    if (!(await this.sessionStore.setWorkspaceScope(getCurrentWorkspaceSessionScope()))) {
      return;
    }

    this.clearSessionTransientState();
    await this.sessionStore.persist();
    await this.cleanupExpiredSessions({ post: false });
    this.postToWebview({ type: 'sessionChanged' });
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
        await this.cleanupExpiredSessions({ post: false });
        this.postState();
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt, message.modelId, message.settings, { references: message.references });
        return;
      case 'editUserPrompt':
        await this.sendPrompt(message.prompt, message.modelId, message.settings, { replaceMessageId: message.messageId, references: message.references });
        return;
      case 'abortPrompt':
        this.abortPrompt();
        return;
      case 'newSession':
        await this.createNewSession();
        return;
      case 'selectSession':
        await this.selectSession(message.sessionId);
        return;
      case 'toggleSessionFavorite':
        if (await this.sessionStore.toggleSessionFavorite(message.sessionId)) {
          this.postState();
        }
        return;
      case 'renameSession':
        if (await this.sessionStore.renameSession(message.sessionId, message.title)) {
          this.postState();
        }
        return;
      case 'deleteSessions':
        await this.deleteSessions(message.sessionIds);
        return;
      case 'listOtherWorkspaces':
        await this.postOtherWorkspaces();
        return;
      case 'loadOtherWorkspaceSessions':
        await this.postOtherWorkspaceSessions(message.workspaceKey);
        return;
      case 'copyOtherWorkspaceSession':
        await this.copyOtherWorkspaceSession(message.workspaceKey, message.sessionId);
        return;
      case 'deleteOtherWorkspaceSessions':
        await this.deleteOtherWorkspaceSessions(message.workspaceKey, message.sessionIds);
        return;
      case 'deleteOtherWorkspace':
        await this.deleteOtherWorkspace(message.workspaceKey);
        return;
      case 'setSelectedModel':
        await this.setSelectedModel(message.modelId);
        return;
      case 'setAgentSettings':
        await this.setAgentSettings(message.settings);
        return;
      case 'setDebugMode':
        await this.setDebugMode(message.enabled);
        return;
      case 'openCurrentSessionLog':
        await this.openCurrentSessionLog();
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
      case 'openHistorySettings': {
        this.postToWebview({
          type: 'showHistorySettingsDialog',
          historyRetentionDays: getConfiguredHistoryRetentionDays()
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
      case 'saveHistorySettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        const historyRetentionDays = normalizeIntegerInRange(
          message.historyRetentionDays,
          MIN_HISTORY_RETENTION_DAYS,
          MAX_HISTORY_RETENTION_DAYS,
          DEFAULT_HISTORY_RETENTION_DAYS
        );
        await config.update('historyRetentionDays', historyRetentionDays, vscode.ConfigurationTarget.Global);
        await this.cleanupExpiredSessions({ post: false });
        this.postState();
        vscode.window.showInformationMessage(this.t('historySettingsSaved'));
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
      case 'estimatePromptContextUsage':
        await this.postPromptContextUsageEstimate(message);
        return;
      case 'requestReferenceResources':
        await this.postReferenceResources(message.requestId);
        return;
      case 'requestClipboardText':
        await this.postClipboardText(message.requestId);
        return;
      case 'writeClipboardText':
        await this.writeClipboardText(message.text);
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

  private clearSessionTransientState(): void {
    this.draftEdits.clear();
    this.fileContext.clear();
    this.authorizedExternalReferenceUris.clear();
    this.liveContextUsage = undefined;
  }

  private updateActiveSessionContextUsage(usage: ContextUsageEstimate | undefined): void {
    if (!usage) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    activeSession.contextUsage = pickLargerContextUsageEstimate(
      activeSession.contextUsage,
      finalizeSessionContextUsageEstimate(usage)
    );
  }

  private createCurrentSessionContextUsage(model = this.getSelectedModel()): ContextUsageEstimate {
    return createDisplayedSessionContextUsageEstimate({
      model,
      contextFiles: this.fileContext.getAll(),
      messages: this.messages,
      contextCompression: this.sessionStore.getActiveSession().contextCompression,
      language: this.language
    });
  }

  private getSelectedModel(): ReturnType<typeof getConfiguredModels>[number] {
    const models = getConfiguredModels();
    if (!this.selectedModelId || !models.some((model) => model.id === this.selectedModelId)) {
      this.selectedModelId = models[0].id;
    }
    return models.find((model) => model.id === this.selectedModelId) ?? models[0];
  }

  private async createNewSession(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    this.clearSessionTransientState();
    await this.sessionStore.createNewSession(this.language);
    await this.cleanupExpiredSessions({ post: false });
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async selectSession(sessionId: string): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const wasActiveSession = sessionId === this.sessionStore.activeSessionId;
    const session = await this.sessionStore.selectSession(sessionId);
    if (!session) {
      return;
    }

    if (!wasActiveSession) {
      this.clearSessionTransientState();
      this.postToWebview({ type: 'sessionChanged' });
    }
    this.postState();
  }

  private async copyOtherWorkspaceSession(workspaceKey: string, sessionId: string): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const session = await this.sessionStore.copyOtherWorkspaceSession(workspaceKey, sessionId);
    if (!session) {
      return;
    }

    this.clearSessionTransientState();
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async deleteSessions(sessionIds: string[]): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const uniqueSessionIds = Array.from(new Set(sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim())));
    if (!uniqueSessionIds.length) {
      return;
    }

    const confirmAction = this.t('deleteSessionsConfirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      this.t('deleteSessionsConfirm', { count: uniqueSessionIds.length }),
      { modal: true },
      confirmAction
    );
    if (confirmed !== confirmAction) {
      return;
    }

    const result = await this.sessionStore.deleteSessions(uniqueSessionIds);
    if (!result.deletedCount) {
      return;
    }

    if (result.activeSessionChanged) {
      this.clearSessionTransientState();
      this.postToWebview({ type: 'sessionChanged' });
    }
    this.postState();
  }

  private async postOtherWorkspaces(): Promise<void> {
    try {
      this.postToWebview({
        type: 'otherWorkspaces',
        workspaces: await this.getOtherWorkspaceSummaries()
      });
    } catch (error) {
      this.postToWebview({
        type: 'otherWorkspaces',
        workspaces: [],
        error: getErrorMessage(error)
      });
    }
  }

  private async postOtherWorkspaceSessions(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    try {
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: await this.sessionStore.getOtherWorkspaceSessionSummaries(normalizedWorkspaceKey)
      });
    } catch (error) {
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: getErrorMessage(error)
      });
    }
  }

  private async deleteOtherWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    const uniqueSessionIds = Array.from(new Set(sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim())));
    if (!uniqueSessionIds.length) {
      return;
    }

    const confirmAction = this.t('deleteSessionsConfirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      this.t('deleteSessionsConfirm', { count: uniqueSessionIds.length }),
      { modal: true },
      confirmAction
    );
    if (confirmed !== confirmAction) {
      return;
    }

    try {
      await this.sessionStore.deleteOtherWorkspaceSessions(normalizedWorkspaceKey, uniqueSessionIds);
      await this.postOtherWorkspaceSessions(normalizedWorkspaceKey);
      await this.postOtherWorkspaces();
    } catch (error) {
      const message = getErrorMessage(error);
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: message
      });
      vscode.window.showErrorMessage(`${this.t('errorPrefix')}: ${message}`);
    }
  }

  private async deleteOtherWorkspace(workspaceKey: string): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    try {
      const summary = (await this.getOtherWorkspaceSummaries())
        .find((workspace) => workspace.workspaceKey === normalizedWorkspaceKey);
      if (!summary) {
        this.postToWebview({ type: 'otherWorkspaceDeleted', workspaceKey: normalizedWorkspaceKey });
        await this.postOtherWorkspaces();
        return;
      }

      const confirmAction = this.t('sessionDeleteWorkspaceConfirmAction');
      const confirmed = await vscode.window.showWarningMessage(
        this.t('sessionDeleteWorkspaceConfirm', {
          name: summary.workspaceName || normalizedWorkspaceKey,
          count: summary.sessionCount
        }),
        { modal: true },
        confirmAction
      );
      if (confirmed !== confirmAction) {
        return;
      }

      await this.sessionStore.deleteOtherWorkspace(normalizedWorkspaceKey);
      this.postToWebview({ type: 'otherWorkspaceDeleted', workspaceKey: normalizedWorkspaceKey });
      await this.postOtherWorkspaces();
    } catch (error) {
      const message = getErrorMessage(error);
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: message
      });
      vscode.window.showErrorMessage(`${this.t('errorPrefix')}: ${message}`);
    }
  }

  private async getOtherWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return (await this.sessionStore.getAllWorkspaceSummaries())
      .filter((workspace) => workspace.workspaceKey !== this.sessionStore.workspaceKey)
      .sort((a, b) => getWorkspaceSummaryTimestamp(b) - getWorkspaceSummaryTimestamp(a));
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

  private async postPromptContextUsageEstimate(message: Extract<WebviewMessage, { type: 'estimatePromptContextUsage' }>): Promise<void> {
    const activeSessionId = this.sessionStore.activeSessionId;
    if (message.activeSessionId && message.activeSessionId !== activeSessionId) {
      return;
    }

    const prompt = message.prompt.trim();
    const models = getConfiguredModels();
    const model = models.find((item) => item.id === message.modelId) ?? models[0];
    const authorizedExternalReferenceUris = this.collectAuthorizedExternalReferenceUris(message.references);
    const expandedPrompt = prompt
      ? await expandPromptReferencesInPrompt(prompt, {
          authorizedExternalReferenceUris,
          language: this.language
        })
      : '';

    if (activeSessionId !== this.sessionStore.activeSessionId) {
      return;
    }

    const promptContextUsage = createDisplayedSessionContextUsageEstimate({
      model,
      contextFiles: this.fileContext.getAll(),
      messages: this.messages,
      contextCompression: this.sessionStore.getActiveSession().contextCompression,
      language: this.language,
      prompt: expandedPrompt
    });
    const storedContextUsage = this.sessionStore.getActiveSession().contextUsage;
    const contextUsage = storedContextUsage
      ? pickLargerContextUsageEstimate(
          addInputTokensToContextUsage(storedContextUsage, promptContextUsage.breakdown.inputTokensEstimate),
          promptContextUsage
        ) ?? promptContextUsage
      : promptContextUsage;

    this.postToWebview({
      type: 'promptContextUsageEstimate',
      requestId: message.requestId,
      activeSessionId,
      prompt: message.prompt,
      contextUsage
    });
  }

  private async postClipboardText(requestId: string): Promise<void> {
    try {
      this.postToWebview({
        type: 'clipboardText',
        requestId,
        text: await vscode.env.clipboard.readText()
      });
    } catch (error) {
      this.postToWebview({
        type: 'clipboardText',
        requestId,
        text: '',
        error: getErrorMessage(error)
      });
    }
  }

  private async writeClipboardText(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch {
      // Clipboard writes are best-effort for shortcut compatibility.
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

  private async setDebugMode(enabled: boolean): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const debugMode = enabled === true;
    const config = vscode.workspace.getConfiguration('keepseek');
    await config.update('trace.enabled', debugMode, vscode.ConfigurationTarget.Global);
    this.postState();
    vscode.window.showInformationMessage(this.t(debugMode ? 'debugModeEnabled' : 'debugModeDisabled'));
  }

  private async openCurrentSessionLog(): Promise<void> {
    if (!getConfiguredDebugMode()) {
      vscode.window.showWarningMessage(this.t('debugModeRequiredForLogs'));
      this.postState();
      return;
    }

    const activeSession = this.sessionStore.getActiveSession();
    const logUriText = activeSession.lastTraceLogUri?.trim()
      || this.sessionTraceLogUris.get(activeSession.id)?.trim();
    if (!logUriText) {
      vscode.window.showWarningMessage(this.t('currentSessionLogUnavailable'));
      this.postState();
      return;
    }

    try {
      const logUri = vscode.Uri.parse(logUriText);
      const stat = await vscode.workspace.fs.stat(logUri);
      if (stat.type !== vscode.FileType.File) {
        throw new Error(this.t('currentSessionLogInvalid'));
      }

      const document = await vscode.workspace.openTextDocument(logUri);
      activeSession.lastTraceLogUri = logUriText;
      this.sessionTraceLogUris.set(activeSession.id, logUriText);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      activeSession.lastTraceLogUri = undefined;
      this.sessionTraceLogUris.delete(activeSession.id);
      await this.sessionStore.persist();
      this.postState();
      vscode.window.showErrorMessage(this.t('cannotOpenCurrentSessionLog', { message: getErrorMessage(error) }));
    }
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

  private setAgentActivity(
    activity: AgentActivityInput,
    options: { post?: boolean; schedulePost?: () => void } = {}
  ): boolean {
    const normalizedActivity: AgentActivityInput = {
      base: activity.base,
      phase: activity.phase,
      toolName: activity.toolName?.trim() || undefined,
      detail: activity.detail?.trim() || undefined
    };
    if (
      this.agentActivity.base === normalizedActivity.base &&
      this.agentActivity.phase === normalizedActivity.phase &&
      this.agentActivity.toolName === normalizedActivity.toolName &&
      this.agentActivity.detail === normalizedActivity.detail
    ) {
      return false;
    }

    this.agentActivitySequence += 1;
    this.agentActivity = {
      ...normalizedActivity,
      updatedAt: new Date().toISOString(),
      sequence: this.agentActivitySequence
    };

    if (options.post === false) {
      return true;
    }
    if (options.schedulePost) {
      options.schedulePost();
    } else {
      this.postState();
    }
    return true;
  }

  private abortPrompt(): void {
    if (!this.isBusy || !this.currentRunAbortController || this.currentRunAbortController.signal.aborted) {
      return;
    }
    this.currentRunAbortController.abort();
    this.setAgentActivity({
      base: 'waiting',
      phase: 'finalizing'
    });
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

    const abortController = new AbortController();
    this.currentRunAbortController = abortController;
    this.isBusy = true;
    this.liveContextUsage = undefined;
    this.setAgentActivity({
      base: 'thinking',
      phase: 'preparing'
    });

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
      this.setAgentActivity({
        base: 'thinking',
        phase: 'expanding_references'
      });
      const expandedPrompt = await expandPromptReferencesInPrompt(trimmedPrompt, {
        authorizedExternalReferenceUris,
        language: this.language
      });
      if (abortController.signal.aborted) {
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }
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
        activeSession.contextUsage = undefined;
        activeSession.contextCompression = undefined;
        this.draftEdits.clear();
        if (replacementIndex === 0 && !activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
      } else if (!activeSession.messages.length) {
        if (!activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
        activeSession.createdAt = now;
      }

      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: trimmedPrompt,
        createdAt: now,
        modelId: model.id,
        contextMeta: activeSession.messages.some((message) => message.role === 'user')
          ? undefined
          : createProtectedContextMeta('first_user_request')
      };
      if (expandedPrompt !== trimmedPrompt) {
        userMessage.expandedContent = expandedPrompt;
      }
      activeSession.lastTraceLogUri = undefined;
      this.sessionTraceLogUris.delete(activeSession.id);
      this.messages.push(userMessage);
      activeSession.updatedAt = now;
      this.postState();
      await this.refreshContextCompressionBeforeRun(activeSession, expandedPrompt, model, abortController.signal);
      this.trimHistory();
      await this.sessionStore.persist();
      if (abortController.signal.aborted) {
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }
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
      this.setAgentActivity({
        base: 'thinking',
        phase: 'requesting_model'
      }, { post: false });
      this.postState();

      const response = await this.agentRunner.run({
        prompt: expandedPrompt,
        model,
        settings: this.agentSettings,
        contextFiles: this.fileContext.getAll(),
        history: agentHistory,
        contextCompression: activeSession.contextCompression,
        language: this.language,
        signal: abortController.signal
      }, {
        onStatus: (activity) => {
          this.setAgentActivity(activity);
        },
        onDelta: (event) => {
          if (!assistantMessage) {
            return;
          }
          if (event.type === 'reasoning') {
            this.setAgentActivity({
              base: 'thinking',
              phase: 'reasoning'
            }, { schedulePost: scheduleLiveState });
            assistantMessage.reasoningContent = `${assistantMessage.reasoningContent ?? ''}${event.delta}`;
          } else {
            this.setAgentActivity({
              base: 'thinking',
              phase: 'generating'
            }, { schedulePost: scheduleLiveState });
            assistantMessage.content = `${assistantMessage.content}${event.delta}`;
          }
          activeSession.updatedAt = new Date().toISOString();
          scheduleLiveState();
        },
        onUsageEstimate: (usage) => {
          this.liveContextUsage = toSessionContextUsageEstimate(usage);
          this.updateActiveSessionContextUsage(this.liveContextUsage);
          scheduleLiveState();
        },
        onTraceLog: (traceLog) => {
          activeSession.lastTraceLogUri = traceLog.uri;
          this.sessionTraceLogUris.set(activeSession.id, traceLog.uri);
          activeSession.updatedAt = new Date().toISOString();
          scheduleLiveState();
        }
      });

      this.setAgentActivity({
        base: 'thinking',
        phase: 'finalizing'
      }, { post: false });
      const traceLogUri = response.traceLog?.uri ?? this.traceLogService.getLastRunTraceLogUri();
      if (traceLogUri) {
        activeSession.lastTraceLogUri = traceLogUri;
        this.sessionTraceLogUris.set(activeSession.id, traceLogUri);
      }
      this.draftEdits.addMany(response.draftEdits);

      if (assistantMessage) {
        assistantMessage.content = response.message;
        assistantMessage.reasoningContent = response.reasoningContent;
        if (response.draftEdits.length) {
          assistantMessage.contextMeta = createProtectedContextMeta('draft_edit_result');
        }
        delete assistantMessage.isStreaming;
      }
      this.trimHistory();
      this.updateActiveSessionContextUsage(this.createCurrentSessionContextUsage(model));
      this.setAgentActivity({
        base: 'complete',
        phase: 'finalizing'
      }, { post: false });
    } catch (error) {
      if (error instanceof AgentRunAbortedError || abortController.signal.aborted) {
        if (assistantMessage) {
          const hasPartialOutput = Boolean(assistantMessage.content.trim() || assistantMessage.reasoningContent?.trim());
          const assistantMessageId = assistantMessage.id;
          delete assistantMessage.isStreaming;
          if (!hasPartialOutput) {
            const assistantIndex = this.messages.findIndex((message) => message.id === assistantMessageId);
            if (assistantIndex >= 0) {
              this.messages.splice(assistantIndex, 1);
            }
            assistantMessage = undefined;
          }
        }
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }

      const activeSession = this.sessionStore.getActiveSession();
      if (!activeSession.messages.length) {
        const now = new Date().toISOString();
        if (!activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
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
      this.updateActiveSessionContextUsage(this.createCurrentSessionContextUsage(model));
      this.setAgentActivity({
        base: 'error',
        phase: 'failed'
      }, { post: false });
    } finally {
      if (this.currentRunAbortController === abortController) {
        this.currentRunAbortController = undefined;
      }
      this.updateActiveSessionContextUsage(this.liveContextUsage);
      this.liveContextUsage = undefined;
      this.sessionStore.getActiveSession().updatedAt = new Date().toISOString();
      this.isBusy = false;
      await this.sessionStore.persist();
      flushLiveState();
      this.setAgentActivity({
        base: 'idle',
        phase: 'idle'
      }, { post: false });
      this.postState();
    }
  }

  private trimHistory(): void {
    this.sessionStore.trimActiveHistory();
  }

  private async refreshContextCompressionBeforeRun(
    activeSession: ChatSession,
    prompt: string,
    model: KeepseekModel,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const result = await this.historyCompressor.refresh({
        session: activeSession,
        prompt,
        model,
        contextFiles: this.fileContext.getAll(),
        language: this.language,
        signal
      });
      if (!result.changed) {
        return;
      }

      activeSession.contextCompression = result.state;
      activeSession.contextUsage = undefined;
      activeSession.updatedAt = new Date().toISOString();
    } catch {
      // Context compression is best-effort and must never block the normal request path.
    }
  }

  private async cleanupExpiredSessions(options: { post?: boolean } = {}): Promise<void> {
    const changed = await this.sessionStore.cleanupExpiredSessions();
    if (changed && options.post !== false) {
      this.postState();
    }
  }

  private postState(): void {
    const models = getConfiguredModels();
    if (!this.selectedModelId || !models.some((model) => model.id === this.selectedModelId)) {
      this.selectedModelId = models[0].id;
    }
    const selectedModel = models.find((model) => model.id === this.selectedModelId) ?? models[0];
    const contextFiles = this.fileContext.getAll();
    const activeSession = this.sessionStore.getActiveSession();
    const computedContextUsage = createDisplayedSessionContextUsageEstimate({
      model: selectedModel,
      contextFiles,
      messages: this.messages,
      contextCompression: activeSession.contextCompression,
      language: this.language
    });
    const contextUsage = pickLargerContextUsageEstimate(
      pickLargerContextUsageEstimate(activeSession.contextUsage, computedContextUsage),
      this.isBusy ? this.liveContextUsage : undefined
    ) ?? computedContextUsage;

    this.postToWebview({
      type: 'state',
      state: {
        models,
        selectedModelId: this.selectedModelId,
        agentSettings: this.agentSettings,
        messages: getVisibleMessages(this.messages),
        activeSessionId: this.sessionStore.activeSessionId,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath || folder.uri.toString()),
        sessionSummaries: this.sessionStore.getSessionSummaries(),
        contextFiles: contextFiles.map(({ content: _content, ...file }) => file),
        contextUsage,
        contextUsageSessionId: this.sessionStore.activeSessionId,
        draftEdits: this.draftEdits.toWebviewState(),
        isBusy: this.isBusy,
        agentActivity: this.agentActivity,
        maxFileBytes: getConfiguredMaxFileBytes(),
        historyRetentionDays: getConfiguredHistoryRetentionDays(),
        debugMode: getConfiguredDebugMode(),
        hasCurrentSessionLog: Boolean(
          activeSession.lastTraceLogUri?.trim()
          || this.sessionTraceLogUris.get(activeSession.id)?.trim()
        ),
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

function getWorkspaceSummaryTimestamp(workspace: WorkspaceSummary): number {
  const timestamp = Date.parse(workspace.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
