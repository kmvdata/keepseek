import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { clampColumn, clampLine, expandFileReferencesInPrompt, getExplorerFileUris, getUriFileName, resolveFileReferenceUri } from './fileReference';
import { AgentRunner } from './agentRunner';
import { FileContextStore } from './fileContext';
import { SafeFileEditor } from './safeFileEditor';
import { AgentSettings, ChatMessage, ChatSession, ChatSessionSummary, DraftEdit, KeepseekModel, ReferenceResource } from './types';
import { getScript } from './webview/script';
import { getStyles } from './webview/styles';
import { getTemplate } from './webview/template';

const PRIMARY_CONTAINER_ID = 'keepseek';
const PRIMARY_VIEW_TYPE = 'keepseek.chatView';
const SECONDARY_CONTAINER_ID = 'keepseek-secondary';
const SECONDARY_VIEW_TYPE = 'keepseek.chatSecondaryView';
const MIN_SECONDARY_SIDEBAR_VERSION = { major: 1, minor: 106 };
const DOES_NOT_SUPPORT_SECONDARY_SIDEBAR_CONTEXT = 'keepseek.doesNotSupportSecondarySidebar';
const SESSION_STORAGE_KEY = 'keepseek.chatSessions';
const SESSION_STORAGE_VERSION = 1;
const MAX_STORED_SESSIONS = 50;
const DEFAULT_SESSION_TITLE = '新会话';
const REFERENCE_RESOURCE_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string; modelId: string; settings?: Partial<AgentSettings> }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'setSelectedModel'; modelId: string }
  | { type: 'setAgentSettings'; settings: Partial<AgentSettings> }
  | { type: 'openSettings'; query: string }
  | { type: 'saveSettings'; apiKey: string; baseUrl: string }
  | { type: 'addCurrentFile' }
  | { type: 'pickWorkspaceFiles' }
  | { type: 'pickExternalFiles' }
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
  public static readonly primaryViewType = PRIMARY_VIEW_TYPE;
  public static readonly secondaryViewType = SECONDARY_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner = new AgentRunner();
  private readonly safeFileEditor = new SafeFileEditor();
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private readonly draftEdits = new Map<string, DraftEdit>();
  private readonly views = new Set<vscode.WebviewView>();
  private selectedModelId = '';
  private agentSettings = getConfiguredAgentSettings();
  private isBusy = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStorage: vscode.Memento
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
    const target = supportsSecondarySidebar(vscode.version)
      ? {
          containerId: SECONDARY_CONTAINER_ID,
          viewType: SECONDARY_VIEW_TYPE
        }
      : {
          containerId: PRIMARY_CONTAINER_ID,
          viewType: PRIMARY_VIEW_TYPE
        };

    try {
      await focusView(target.containerId, target.viewType);
    } catch {
      await focusView(PRIMARY_CONTAINER_ID, PRIMARY_VIEW_TYPE);
    }
  }

  public async addCurrentFileToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const file = await this.fileContext.addCurrentEditor();
      vscode.window.showInformationMessage(`KeepSeek added ${file.label}.`);
    });
  }

  public async pickWorkspaceFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickWorkspaceFiles();
      if (files.length) {
        vscode.window.showInformationMessage(`KeepSeek added ${files.length} workspace file(s).`);
      }
    });
  }

  public async insertSelectionToInput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const startColumn = editor.selection.start.character + 1;
    const endColumn = editor.selection.end.character + 1;
    const path = editor.document.uri.fsPath;

    await this.reveal();
    this.postToWebview({ type: 'insertFileReference', path, startLine, endLine, startColumn, endColumn });
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
      vscode.window.showWarningMessage('Choose a file to add to KeepSeek context.');
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
        vscode.window.showWarningMessage('KeepSeek can only insert file references from the Explorer.');
        return;
      }

      await this.reveal();
      for (const file of files) {
        this.postToWebview({
          type: 'insertFileReference',
          path: file.fsPath,
          startLine: 0,
          endLine: 0
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(`KeepSeek cannot add file reference: ${getErrorMessage(error)}`);
    }
  }

  public async pickExternalFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickExternalFiles();
      if (files.length) {
        vscode.window.showInformationMessage(`KeepSeek added ${files.length} external file(s).`);
      }
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postState();
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt, message.modelId, message.settings);
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
        vscode.window.showInformationMessage('DeepSeek API 设置已保存。');
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

    this.sessions = sessions.length ? sessions : [createEmptySession()];
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

    const fallback = this.sessions[0] ?? createEmptySession();
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

    const session = createEmptySession();
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
      title: session.title || DEFAULT_SESSION_TITLE,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    }));
  }

  private async readPathToContext(inputPath: string): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.addPath(inputPath);
      if (files.length) {
        vscode.window.showInformationMessage(`KeepSeek added ${files.length} file(s).`);
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
        throw new Error('File reference has no path.');
      }

      const uri = resolveFileReferenceUri(trimmedPath);
      if (!uri) {
        throw new Error('File reference path is not valid.');
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
      vscode.window.showErrorMessage(`KeepSeek cannot open file reference: ${getErrorMessage(error)}`);
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

  private async sendPrompt(prompt: string, modelId: string, settings?: Partial<AgentSettings>): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || this.isBusy) {
      return;
    }

    this.agentSettings = normalizeAgentSettings(settings, this.agentSettings);
    const models = getConfiguredModels();
    const model = models.find((item) => item.id === modelId) ?? models[0];
    this.selectedModelId = model.id;

    this.isBusy = true;
    this.postState();

    try {
      const expandedPrompt = await expandFileReferencesInPrompt(trimmedPrompt);
      const activeSession = this.getActiveSession();
      const now = new Date().toISOString();

      if (!activeSession.messages.length) {
        activeSession.title = createSessionTitle(trimmedPrompt);
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

      const response = await this.agentRunner.run({
        prompt: expandedPrompt,
        model,
        settings: this.agentSettings,
        contextFiles: this.fileContext.getAll(),
        history: this.messages
      });

      for (const draftEdit of response.draftEdits) {
        this.draftEdits.set(draftEdit.id, draftEdit);
      }

      this.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: response.message,
        reasoningContent: response.reasoningContent,
        createdAt: new Date().toISOString(),
        modelId: model.id
      });
      this.trimHistory();
    } catch (error) {
      const activeSession = this.getActiveSession();
      if (!activeSession.messages.length) {
        const now = new Date().toISOString();
        activeSession.title = createSessionTitle(trimmedPrompt);
        activeSession.createdAt = now;
      }
      this.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: `Error: ${getErrorMessage(error)}`,
        createdAt: new Date().toISOString(),
        modelId: model.id
      });
    } finally {
      this.getActiveSession().updatedAt = new Date().toISOString();
      this.isBusy = false;
      await this.persistSessions();
      this.postState();
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
          content: `已写入 ${edit.label}。`,
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

    this.postToWebview({
      type: 'state',
      state: {
        models,
        selectedModelId: this.selectedModelId,
        agentSettings: this.agentSettings,
        messages: getVisibleMessages(this.messages),
        activeSessionId: this.activeSessionId,
        sessionSummaries: this.getSessionSummaries(),
        contextFiles: this.fileContext.getAll().map(({ content: _content, ...file }) => file),
        draftEdits: Array.from(this.draftEdits.values()).map(({ newText: _newText, ...edit }) => edit),
        isBusy: this.isBusy
      }
    });
  }

  private postToWebview(message: unknown): void {
    for (const view of this.views) {
      void view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="zh-CN">
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

    const key = process.platform === 'darwin' ? 'cmd+l' : 'ctrl+l';
    const selectionCommand = 'keepseek.addSelectionToContext';
    const explorerCommand = 'keepseek.addExplorerFileToContext';

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

    const hasSelection = keybindings.some(
      (entry) => entry.command === selectionCommand && entry.key === key
    );
    const hasExplorer = keybindings.some(
      (entry) => entry.command === explorerCommand && entry.key === key
    );

    if (hasSelection && hasExplorer) {
      return;
    }

    // Remove any existing bindings for our key that aren't ours
    keybindings = keybindings.filter((entry) => {
      if (entry.key !== key) {
        return true;
      }
      if (entry.command === selectionCommand || entry.command === explorerCommand) {
        return true;
      }
      return false;
    });

    if (!hasSelection) {
      keybindings.push({
        key,
        command: selectionCommand,
        when: 'editorHasSelection && editorTextFocus'
      });
    }

    if (!hasExplorer) {
      keybindings.push({
        key,
        command: explorerCommand,
        when: 'explorerViewletFocus && !explorerResourceIsFolder'
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

  const provider = new KeepseekChatViewProvider(context.extensionUri, context.workspaceState);
  const doesNotSupportSecondarySidebar = !supportsSecondarySidebar(vscode.version);
  void vscode.commands.executeCommand(
    'setContext',
    DOES_NOT_SUPPORT_SECONDARY_SIDEBAR_CONTEXT,
    doesNotSupportSecondarySidebar
  );

  const webviewProviders: vscode.Disposable[] = [
    vscode.window.registerWebviewViewProvider(KeepseekChatViewProvider.primaryViewType, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  ];

  if (!doesNotSupportSecondarySidebar) {
    webviewProviders.push(
      vscode.window.registerWebviewViewProvider(KeepseekChatViewProvider.secondaryViewType, provider, {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      })
    );
  }

  context.subscriptions.push(
    ...webviewProviders,
    vscode.commands.registerCommand('keepseek.openChat', () => provider.reveal()),
    vscode.commands.registerCommand('keepseek.addCurrentFileToContext', () => provider.addCurrentFileToContext()),
    vscode.commands.registerCommand('keepseek.pickWorkspaceFilesToContext', () => provider.pickWorkspaceFilesToContext()),
    vscode.commands.registerCommand('keepseek.pickExternalFilesToContext', () => provider.pickExternalFilesToContext()),
    vscode.commands.registerCommand('keepseek.addSelectionToContext', () => provider.insertSelectionToInput()),
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

function supportsSecondarySidebar(version: string): boolean {
  const parsed = parseMajorMinorVersion(version);
  if (!parsed) {
    return false;
  }
  if (parsed.major !== MIN_SECONDARY_SIDEBAR_VERSION.major) {
    return parsed.major > MIN_SECONDARY_SIDEBAR_VERSION.major;
  }
  return parsed.minor >= MIN_SECONDARY_SIDEBAR_VERSION.minor;
}

function parseMajorMinorVersion(version: string): { major: number; minor: number } | undefined {
  const match = /^(?<major>\d+)\.(?<minor>\d+)/u.exec(version);
  if (!match?.groups) {
    return undefined;
  }

  return {
    major: Number(match.groups.major),
    minor: Number(match.groups.minor)
  };
}

function createEmptySession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: DEFAULT_SESSION_TITLE,
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

function createSessionTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return DEFAULT_SESSION_TITLE;
  }
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function normalizeStoredSessions(value: unknown): ChatSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return [];
  }

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
      : createTitleFromMessages(messages);

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

function createTitleFromMessages(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return firstUserMessage ? createSessionTitle(firstUserMessage.content) : DEFAULT_SESSION_TITLE;
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
      provider: model.provider ?? 'custom'
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
