import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clampColumn, clampLine, expandFileReferencesInPrompt, getExplorerFileUris, getFileReferenceAuthorizationKey, getUriFileName, resolveFileReferenceUri } from './fileReference';
import { AGENT_HISTORY_MESSAGE_LIMIT, AgentRunner } from './agentRunner';
import { FileContextStore, formatBytes } from './fileContext';
import { SafeFileEditor } from './safeFileEditor';
import { AgentSettings, ChatMessage, ChatSession, ChatSessionSummary, ContextFile, ContextUsageEstimate, DraftEdit, KeepseekModel, ReferenceResource } from './types';
import { getScript } from './webview/script';
import { getStyles } from './webview/styles';
import { getTemplate } from './webview/template';
import { getConfiguredKeepseekLanguage, getKeepseekLanguageName, localize, normalizeKeepseekLanguage, type KeepseekLanguage } from './i18n';

const CHAT_CONTAINER_ID = 'keepseek';
const CHAT_VIEW_TYPE = 'keepseek.chatView';
const SESSION_STORAGE_KEY = 'keepseek.chatSessions';
const SESSION_STORAGE_VERSION = 1;
const MAX_STORED_SESSIONS = 50;
const REFERENCE_RESOURCE_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';
const TEXT_REFERENCE_STORAGE_DIR = 'text-references';
const CLIPBOARD_COPY_SETTLE_MS = 50;
const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_048_576;

interface PromptReferenceInput {
  path: string;
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

type TextReferenceSource = 'terminal' | 'debugConsole' | 'output';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[] }
  | { type: 'editUserPrompt'; messageId: string; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[] }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'setSelectedModel'; modelId: string }
  | { type: 'setAgentSettings'; settings: Partial<AgentSettings> }
  | { type: 'openSettings' }
  | { type: 'saveSettings'; apiKey: string; baseUrl: string }
  | { type: 'setLanguage'; language: KeepseekLanguage }
  | { type: 'addCurrentFile' }
  | { type: 'pickWorkspaceFiles' }
  | { type: 'pickExternalFiles' }
  | { type: 'pickExternalFileReferences' }
  | { type: 'insertDroppedFileReferences'; files: DroppedFileReferenceInput[] }
  | { type: 'requestReferenceResources'; requestId: string }
  | { type: 'readPath'; path: string }
  | { type: 'openFileReference'; path: string; startLine: number; endLine: number; startColumn: number; endColumn: number }
  | { type: 'removeContextFile'; uri: string }
  | { type: 'clearContext' }
  | { type: 'applyDraftEdit'; id: string }
  | { type: 'discardDraftEdit'; id: string };

interface StoredSessionState {
  version: number;
  activeSessionId: string;
  sessions: ChatSession[];
}

class KeepseekChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner = new AgentRunner();
  private readonly safeFileEditor = new SafeFileEditor();
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private readonly draftEdits = new Map<string, DraftEdit>();
  private readonly authorizedExternalReferenceUris = new Set<string>();
  private readonly views = new Set<vscode.WebviewView>();
  private selectedModelId = '';
  private agentSettings = getConfiguredAgentSettings();
  private language = getConfiguredKeepseekLanguage();
  private isBusy = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStorage: vscode.Memento,
    private readonly globalStorageUri: vscode.Uri
  ) {
    this.loadSessions();
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
        this.language = getConfiguredKeepseekLanguage();
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
        this.setSelectedModel(message.modelId);
        return;
      case 'setAgentSettings':
        await this.setAgentSettings(message.settings);
        return;
      case 'openSettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        this.postToWebview({
          type: 'showSettingsDialog',
          apiKey: config.get<string>('apiKey', ''),
          baseUrl: config.get<string>('baseUrl', 'https://api.deepseek.com')
        });
        return;
      }
      case 'saveSettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('apiKey', message.apiKey, vscode.ConfigurationTarget.Global);
        await config.update('baseUrl', message.baseUrl, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(this.t('apiSettingsSaved'));
        return;
      }
      case 'setLanguage': {
        const language = normalizeKeepseekLanguage(message.language);
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('language', language, vscode.ConfigurationTarget.Global);
        this.language = language;
        await this.relocalizeEmptySessionTitles(language);
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
        await this.openFileReference(message.path, message.startLine, message.endLine, message.startColumn, message.endColumn);
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
        await this.applyDraftEdit(message.id);
        return;
      case 'discardDraftEdit':
        this.draftEdits.delete(message.id);
        this.postState();
        return;
    }
  }

  private get messages(): ChatMessage[] {
    return this.getActiveSession().messages;
  }

  private loadSessions(): void {
    const stored = this.sessionStorage.get<StoredSessionState>(SESSION_STORAGE_KEY);
    const sessions = normalizeStoredSessions(stored);
    const activeSessionId = typeof stored?.activeSessionId === 'string' ? stored.activeSessionId : '';

    this.sessions = sessions.length ? sessions : [createEmptySession(this.language)];
    this.activeSessionId = this.sessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : this.sessions[0].id;
    this.compactSessions();
  }

  private getActiveSession(): ChatSession {
    const existing = this.sessions.find((session) => session.id === this.activeSessionId);
    if (existing) {
      return existing;
    }

    const fallback = this.sessions[0] ?? createEmptySession(this.language);
    if (!this.sessions.length) {
      this.sessions.push(fallback);
    }
    this.activeSessionId = fallback.id;
    return fallback;
  }

  private async createNewSession(): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const session = createEmptySession(this.language);
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    this.draftEdits.clear();
    await this.persistSessions();
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async selectSession(sessionId: string): Promise<void> {
    if (this.isBusy || sessionId === this.activeSessionId) {
      return;
    }

    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return;
    }

    session.updatedAt = new Date().toISOString();
    this.activeSessionId = session.id;
    this.draftEdits.clear();
    await this.persistSessions();
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async persistSessions(): Promise<void> {
    this.compactSessions();
    await this.sessionStorage.update(SESSION_STORAGE_KEY, {
      version: SESSION_STORAGE_VERSION,
      activeSessionId: this.activeSessionId,
      sessions: this.sessions
    } satisfies StoredSessionState);
  }

  private async relocalizeEmptySessionTitles(language: KeepseekLanguage): Promise<void> {
    const defaultTitles = new Set([
      localize('zh-CN', 'defaultSessionTitle'),
      localize('en', 'defaultSessionTitle')
    ]);
    let changed = false;
    for (const session of this.sessions) {
      if (!session.messages.length && defaultTitles.has(session.title)) {
        session.title = localize(language, 'defaultSessionTitle');
        changed = true;
      }
    }
    if (changed) {
      await this.persistSessions();
    }
  }

  private compactSessions(): void {
    const activeSession = this.getActiveSession();
    this.sessions = this.sessions
      .filter((session) => session.id === activeSession.id || session.messages.length > 0)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    if (!this.sessions.some((session) => session.id === activeSession.id)) {
      this.sessions.unshift(activeSession);
    }

    if (this.sessions.length > MAX_STORED_SESSIONS) {
      const activeIndex = this.sessions.findIndex((session) => session.id === activeSession.id);
      this.sessions = this.sessions.slice(0, MAX_STORED_SESSIONS);
      if (activeIndex >= MAX_STORED_SESSIONS) {
        this.sessions[MAX_STORED_SESSIONS - 1] = activeSession;
      }
    }

    this.activeSessionId = activeSession.id;
  }

  private getSessionSummaries(): ChatSessionSummary[] {
    return this.sessions.map((session) => ({
      id: session.id,
      title: session.title || this.t('defaultSessionTitle'),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    }));
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

  private setSelectedModel(modelId: string): void {
    const models = getConfiguredModels();
    if (!models.some((model) => model.id === modelId)) {
      return;
    }
    this.selectedModelId = modelId;
    this.postState();
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

  private async openFileReference(rawPath: string, rawStartLine: number, rawEndLine: number, rawStartColumn: number, rawEndColumn: number): Promise<void> {
    try {
      const trimmedPath = rawPath.trim();
      if (!trimmedPath) {
        throw new Error(this.t('fileReferenceNoPath'));
      }

      const uri = resolveFileReferenceUri(trimmedPath);
      if (!uri) {
        throw new Error(this.t('fileReferenceInvalidPath'));
      }
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      }

      const document = await vscode.workspace.openTextDocument(uri);

      if (rawStartLine <= 0) {
        await vscode.window.showTextDocument(document, { preview: true });
        return;
      }

      const startLine = clampLine(rawStartLine, 1, document.lineCount);
      const endLine = clampLine(rawEndLine, startLine, document.lineCount);
      const startLineMaxCol = document.lineAt(startLine - 1).range.end.character;
      const endLineMaxCol = document.lineAt(endLine - 1).range.end.character;
      const startCol = rawStartColumn > 0 ? clampColumn(rawStartColumn - 1, startLineMaxCol) : 0;
      const endCol = rawEndColumn > 0 ? clampColumn(rawEndColumn - 1, endLineMaxCol) : endLineMaxCol;
      const start = new vscode.Position(startLine - 1, startCol);
      const end = new vscode.Position(endLine - 1, endCol);

      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(start, end)
      });
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotOpenFileReference', { message: getErrorMessage(error) }));
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
      const targetIndex = this.getActiveSession().messages.findIndex((message) => message.id === replaceMessageId && message.role === 'user');
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
      const expandedPrompt = await expandFileReferencesInPrompt(trimmedPrompt, {
        authorizedExternalReferenceUris,
        language: this.language
      });
      const activeSession = this.getActiveSession();
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
      await this.persistSessions();
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

      for (const draftEdit of response.draftEdits) {
        this.draftEdits.set(draftEdit.id, draftEdit);
      }

      if (assistantMessage) {
        assistantMessage.content = response.message;
        assistantMessage.reasoningContent = response.reasoningContent;
        delete assistantMessage.isStreaming;
      }
      this.trimHistory();
    } catch (error) {
      const activeSession = this.getActiveSession();
      if (!activeSession.messages.length) {
        const now = new Date().toISOString();
        activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        activeSession.createdAt = now;
      }
      if (assistantMessage) {
        assistantMessage.content = `${this.t('errorPrefix')}: ${getErrorMessage(error)}`;
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
      this.getActiveSession().updatedAt = new Date().toISOString();
      this.isBusy = false;
      await this.persistSessions();
      flushLiveState();
    }
  }

  private async applyDraftEdit(id: string): Promise<void> {
    const edit = this.draftEdits.get(id);
    if (!edit) {
      return;
    }

    try {
      const applied = await this.safeFileEditor.applyDraftEdit(edit);
      if (applied) {
        this.draftEdits.delete(id);
        this.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: this.t('wroteFile', { label: edit.label }),
          createdAt: new Date().toISOString()
        });
        this.getActiveSession().updatedAt = new Date().toISOString();
        await this.persistSessions();
      }
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    } finally {
      this.postState();
    }
  }

  private trimHistory(): void {
    const maxMessages = 80;
    if (this.messages.length > maxMessages) {
      this.messages.splice(0, this.messages.length - maxMessages);
    }
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
        activeSessionId: this.activeSessionId,
        sessionSummaries: this.getSessionSummaries(),
        contextFiles: contextFiles.map(({ content: _content, ...file }) => file),
        contextUsage: createContextUsageEstimate({
          model: selectedModel,
          contextFiles,
          messages: this.messages,
          language: this.language
        }),
        draftEdits: Array.from(this.draftEdits.values()).map(({ newText: _newText, ...edit }) => edit),
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
    const nonce = getNonce();
    const keepseekLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'keepseek.svg'));
    return `<!DOCTYPE html>
<html lang="${this.language === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KeepSeek</title>
  <style>
${getStyles()}
  </style>
</head>
<body ondragover="event.preventDefault();event.dataTransfer.dropEffect='copy';return false;" ondrop="event.preventDefault();return false;">
${getTemplate()}
  <script nonce="${nonce}">
window.keepseekLogoUri = ${JSON.stringify(String(keepseekLogoUri))};
${getScript()}
  </script>
</body>
</html>`;
  }
}

function ensureKeybindings(context: vscode.ExtensionContext): void {
  try {
    const storageDir = path.dirname(context.globalStorageUri.fsPath);
    const userDir = path.dirname(storageDir);
    const keybindingsPath = path.join(userDir, 'keybindings.json');

    const contextKey = process.platform === 'darwin' ? 'cmd+l' : 'ctrl+shift+l';
    const bindings = [
      {
        key: contextKey,
        command: 'keepseek.addSelectionToContext',
        when: 'editorHasSelection && editorTextFocus && !inDebugRepl'
      },
      {
        key: contextKey,
        command: 'keepseek.addExplorerFileToContext',
        when: 'explorerViewletFocus && !explorerResourceIsFolder'
      },
      {
        key: contextKey,
        command: 'keepseek.addTerminalSelectionToContext',
        when: 'terminalFocus && terminalTextSelectedInFocused'
      },
      {
        key: contextKey,
        command: 'keepseek.addDebugConsoleSelectionToContext',
        when: 'inDebugRepl'
      }
    ];
    const keepseekCommands = new Set(bindings.map((binding) => binding.command));

    let keybindings: Array<Record<string, unknown>> = [];
    if (fs.existsSync(keybindingsPath)) {
      try {
        const raw = fs.readFileSync(keybindingsPath, 'utf-8');
        const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        keybindings = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      } catch {
        keybindings = [];
      }
    }

    if (process.platform !== 'darwin') {
      keybindings = keybindings.filter((entry) => !(
        typeof entry.command === 'string' &&
        keepseekCommands.has(entry.command) &&
        entry.key === 'ctrl+l'
      ));
    }

    const missingBindings = bindings.filter((binding) => !keybindings.some(
      (entry) => entry.command === binding.command && entry.key === binding.key
    ));

    if (!missingBindings.length) {
      return;
    }

    for (const binding of missingBindings) {
      keybindings.push({
        key: binding.key,
        command: binding.command,
        when: binding.when
      });
    }

    fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
    fs.writeFileSync(keybindingsPath, JSON.stringify(keybindings, null, 2) + '\n', 'utf-8');
  } catch {
    // Silently ignore — the package.json keybinding contribution is the primary mechanism
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
    )
  );
}

export function deactivate(): void {}

async function focusView(containerId: string, viewType: string): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${containerId}`);
  await vscode.commands.executeCommand(`${viewType}.focus`);
}

function createEmptySession(language: KeepseekLanguage = getConfiguredKeepseekLanguage()): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: localize(language, 'defaultSessionTitle'),
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function createSessionTitle(prompt: string, language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return localize(language, 'defaultSessionTitle');
  }
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function getDocumentSelectionTextReferenceSource(document: vscode.TextDocument): TextReferenceSource | undefined {
  if (document.uri.scheme === 'output') {
    return 'output';
  }
  if (document.uri.scheme === 'debug') {
    return 'debugConsole';
  }
  return undefined;
}

async function copySelectionTextWithClipboardRestore(copyCommand: string): Promise<string> {
  const previousClipboard = await vscode.env.clipboard.readText();
  const sentinel = `__KEEPSEEK_SELECTION_${randomUUID()}__`;

  try {
    await vscode.env.clipboard.writeText(sentinel);
    await vscode.commands.executeCommand(copyCommand);
    await delay(CLIPBOARD_COPY_SETTLE_MS);
    const copiedText = await vscode.env.clipboard.readText();
    return copiedText === sentinel ? '' : copiedText;
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function createTextReferenceFileName(prefix: string, name?: string): string {
  const cleanPrefix = sanitizeTextReferenceFileNameSegment(prefix) || 'selection';
  const cleanName = sanitizeTextReferenceFileNameSegment(name);
  return cleanName ? `${cleanPrefix}-${cleanName}.log` : `${cleanPrefix}.log`;
}

function getTextReferenceDocumentName(document: vscode.TextDocument): string {
  const uriPath = document.uri.path || document.uri.toString();
  return uriPath.split('/').filter(Boolean).pop() ?? '';
}

function sanitizeTextReferenceFileName(name: string): string {
  const trimmed = name.trim() || 'selection.log';
  const baseName = trimmed.split(/[\\/]+/u).pop() || 'selection.log';
  const withoutControlCharacters = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 ? '-' : character;
  }).join('');
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]+/gu, '-')
    .replace(/^\.+$/u, 'selection.log')
    .slice(0, 160);
  return sanitized || 'selection.log';
}

function sanitizeTextReferenceFileNameSegment(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 80);
}

function normalizeStoredSessions(value: unknown): ChatSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return [];
  }

  const language = getConfiguredKeepseekLanguage();
  const sessions: ChatSession[] = [];
  const seen = new Set<string>();

  for (const item of value.sessions) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) {
      continue;
    }

    const messages = Array.isArray(item.messages)
      ? item.messages.map(normalizeStoredMessage).filter((message): message is ChatMessage => Boolean(message))
      : [];
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : createTitleFromMessages(messages, language);

    sessions.push({
      id: item.id,
      title,
      messages,
      createdAt,
      updatedAt
    });
    seen.add(item.id);
  }

  return sessions;
}

function normalizeStoredMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }

  const role = value.role === 'user' || value.role === 'assistant' || value.role === 'system'
    ? value.role
    : undefined;
  if (!role) {
    return undefined;
  }

  return {
    id: value.id,
    role,
    content: value.content,
    expandedContent: typeof value.expandedContent === 'string' ? value.expandedContent : undefined,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
    reasoningContent: typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined
  };
}

function getVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ expandedContent: _expandedContent, ...message }) => message);
}

function createContextUsageEstimate(input: {
  model: KeepseekModel;
  contextFiles: ContextFile[];
  messages: ChatMessage[];
  language: KeepseekLanguage;
}): ContextUsageEstimate {
  const maxTokensEstimate = getConfiguredContextWindowTokens(input.model);
  const systemTokensEstimate = estimateChatMessageTokens('system', getSystemPromptEstimateText(input.language));
  const contextFileTokensEstimate = estimateContextFileTokens(input.contextFiles, input.language);
  const historyTokensEstimate = input.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-AGENT_HISTORY_MESSAGE_LIMIT)
    .reduce((total, message) => {
      const content = getMessageContentForUsage(message);
      return content ? total + estimateChatMessageTokens(message.role, content) : total;
    }, 0);
  return normalizeContextUsageEstimate({
    maxTokensEstimate,
    systemTokensEstimate,
    contextFileTokensEstimate,
    historyTokensEstimate,
    inputTokensEstimate: 0
  });
}

function normalizeContextUsageEstimate(input: {
  maxTokensEstimate: number;
  systemTokensEstimate: number;
  contextFileTokensEstimate: number;
  historyTokensEstimate: number;
  inputTokensEstimate: number;
}): ContextUsageEstimate {
  const maxTokensEstimate = Math.max(1, Math.floor(input.maxTokensEstimate));
  const systemTokensEstimate = Math.max(0, Math.floor(input.systemTokensEstimate));
  const contextFileTokensEstimate = Math.max(0, Math.floor(input.contextFileTokensEstimate));
  const historyTokensEstimate = Math.max(0, Math.floor(input.historyTokensEstimate));
  const inputTokensEstimate = Math.max(0, Math.floor(input.inputTokensEstimate));
  const usedTokensEstimate = systemTokensEstimate + contextFileTokensEstimate + historyTokensEstimate + inputTokensEstimate;
  const remainingTokensEstimate = Math.max(0, maxTokensEstimate - usedTokensEstimate);
  const usedPercent = Math.min(100, (usedTokensEstimate / maxTokensEstimate) * 100);

  return {
    usedTokensEstimate,
    maxTokensEstimate,
    remainingTokensEstimate,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    breakdown: {
      systemTokensEstimate,
      contextFileTokensEstimate,
      historyTokensEstimate,
      inputTokensEstimate
    }
  };
}

function estimateContextFileTokens(contextFiles: ContextFile[], language: KeepseekLanguage): number {
  if (!contextFiles.length) {
    return 0;
  }

  const intro = language === 'en'
    ? 'These are the context files the user added to KeepSeek. Prefer using them when answering:'
    : '以下是用户加入 KeepSeek 的上下文文件。回答时优先参考这些内容：';
  let total = estimateTokenCount(intro);

  for (const file of contextFiles) {
    total += estimateTokenCount([
      language === 'en' ? 'Context file:' : '上下文文件：',
      file.label,
      file.languageId,
      formatBytes(file.sizeBytes),
      'Path:',
      file.fsPath,
      file.content
    ].join('\n')) + 8;
  }

  return total;
}

function estimateChatMessageTokens(role: ChatMessage['role'], content: string): number {
  return estimateTokenCount(`${role}\n${content}`) + 4;
}

function getMessageContentForUsage(message: ChatMessage): string {
  return (message.expandedContent ?? message.content).trim();
}

function estimateTokenCount(value: string): number {
  let estimate = 0;
  for (const character of String(value || '')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) {
      estimate += 0.3;
    } else if (isCjkCodePoint(codePoint)) {
      estimate += 0.6;
    } else {
      estimate += 0.6;
    }
  }
  return Math.ceil(estimate);
}

function isCjkCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x3400 && codePoint <= 0x9fff)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0x20000 && codePoint <= 0x2a6df)
    || (codePoint >= 0x2a700 && codePoint <= 0x2ebef);
}

function getSystemPromptEstimateText(language: KeepseekLanguage): string {
  return language === 'en'
    ? [
        'You are KeepSeek, a coding agent running in the VS Code sidebar.',
        'Communicate with the user in English unless the user explicitly asks for another language.',
        'You can analyze code, explain approaches, suggest changes, and call tools to create pending edits when files need to change.',
        'Important safety rule: tools only create DraftEdit pending changes and never write to disk directly. Do not claim files were written unless the user later applies the change.',
        'When the user asks to modify or create files, prefer calling keepseek_create_draft_edit with the target path, complete new file content, and a short reason.',
        'If information is missing, state the gap. If you can reasonably proceed, provide an actionable result.'
      ].join('\n')
    : [
        '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
        '你需要用中文和用户沟通，除非用户明确要求其它语言。',
        '你可以根据用户的问题分析代码、解释方案、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
        '重要安全规则：工具只会创建 DraftEdit 待确认修改，不会直接写入磁盘；不要声称已经写入文件，除非用户之后手动确认。',
        '当用户要求修改或创建文件时，优先调用 keepseek_create_draft_edit，并传入目标路径、完整的新文件内容和简短原因。',
        '如果信息不足，先说明缺口；如果可以合理推进，就直接给出可执行结果。'
      ].join('\n');
}

function createTitleFromMessages(messages: ChatMessage[], language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return firstUserMessage ? createSessionTitle(firstUserMessage.content, language) : localize(language, 'defaultSessionTitle');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getConfiguredModels(): KeepseekModel[] {
  const configured = vscode.workspace.getConfiguration('keepseek').get<KeepseekModel[]>('models', []);
  const models = configured.filter((model) => model?.id && model.label);
  if (models.length) {
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      provider: model.provider ?? 'custom',
      contextWindowTokens: normalizePositiveInteger(model.contextWindowTokens)
    }));
  }

  return [
    {
      id: 'deepseek-v4-flash',
      label: 'DeepSeek-V4-Flash',
      provider: 'deepseek'
    },
    {
      id: 'deepseek-v4-pro',
      label: 'DeepSeek-V4-Pro',
      provider: 'deepseek'
    }
  ];
}

function getConfiguredAgentSettings(): AgentSettings {
  const config = vscode.workspace.getConfiguration('keepseek');
  return normalizeAgentSettings({
    thinkingEnabled: config.get<boolean>('thinkingEnabled', true),
    reasoningEffort: config.get<AgentSettings['reasoningEffort']>('reasoningEffort', 'high')
  });
}

function getConfiguredMaxFileBytes(): number {
  return vscode.workspace.getConfiguration('keepseek').get('maxFileBytes', 200_000);
}

function getConfiguredContextWindowTokens(model?: KeepseekModel): number {
  const modelLimit = normalizePositiveInteger(model?.contextWindowTokens);
  if (modelLimit) {
    return modelLimit;
  }

  const configuredLimit = vscode.workspace
    .getConfiguration('keepseek')
    .get<number>('contextWindowTokens', DEFAULT_CONTEXT_WINDOW_TOKENS);
  return normalizePositiveInteger(configuredLimit) ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    return undefined;
  }
  return Math.floor(number);
}

function sanitizeDroppedFileName(name: string): string {
  const rawName = typeof name === 'string' && name.trim() ? name.trim() : 'dropped-file';
  const baseName = rawName.split(/[\\/]+/u).pop() || 'dropped-file';
  const invalidCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const safeCharacters = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || invalidCharacters.has(character) ? '_' : character;
  }).join('');
  const sanitized = safeCharacters.replace(/^\.+$/u, 'dropped-file').slice(0, 160);
  return sanitized || 'dropped-file';
}

async function getWorkspaceReferenceResources(): Promise<ReferenceResource[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return [];
  }

  const includeWorkspaceFolder = folders.length > 1;
  const resources: ReferenceResource[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      REFERENCE_RESOURCE_GLOB_EXCLUDE
    );

    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
      resources.push({
        uri: key,
        path: uri.scheme === 'file' ? uri.fsPath : key,
        label: getUriFileName(uri),
        description: relativePath,
        workspaceFolder: folder.name,
        kind: 'file'
      });
    }
  }

  resources.sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    if (labelOrder !== 0) {
      return labelOrder;
    }
    return left.description.localeCompare(right.description, undefined, { sensitivity: 'base' });
  });

  return resources;
}

function normalizeAgentSettings(settings: Partial<AgentSettings> | undefined, fallback?: AgentSettings): AgentSettings {
  return {
    thinkingEnabled: typeof settings?.thinkingEnabled === 'boolean'
      ? settings.thinkingEnabled
      : fallback?.thinkingEnabled ?? true,
    reasoningEffort: settings?.reasoningEffort === 'max'
      ? 'max'
      : settings?.reasoningEffort === 'high'
        ? 'high'
        : fallback?.reasoningEffort ?? 'high'
  };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
