import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRunner } from './agentRunner';
import { FileContextStore } from './fileContext';
import { SafeFileEditor } from './safeFileEditor';
import { ChatMessage, DraftEdit, KeepseekModel } from './types';
import { getScript } from './webview/script';
import { getStyles } from './webview/styles';
import { getTemplate } from './webview/template';

const PRIMARY_CONTAINER_ID = 'keepseek';
const PRIMARY_VIEW_TYPE = 'keepseek.chatView';
const SECONDARY_CONTAINER_ID = 'keepseek-secondary';
const SECONDARY_VIEW_TYPE = 'keepseek.chatSecondaryView';
const MIN_SECONDARY_SIDEBAR_VERSION = { major: 1, minor: 106 };
const DOES_NOT_SUPPORT_SECONDARY_SIDEBAR_CONTEXT = 'keepseek.doesNotSupportSecondarySidebar';
const FILE_REFERENCE_PATTERN = /<([^<>\n]+)>/gu;
const FILE_REFERENCE_LINE_PATTERN = /^(?<path>.+)#L(?<startLine>\d+)(?:-L(?<endLine>\d+))?$/u;
const SKIPPED_REFERENCE_EXTENSIONS = new Set([
  '.3gp',
  '.7z',
  '.aac',
  '.ai',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.dylib',
  '.eot',
  '.exe',
  '.fig',
  '.flac',
  '.flv',
  '.gif',
  '.gz',
  '.heic',
  '.heif',
  '.icns',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.sketch',
  '.so',
  '.svg',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.wmv',
  '.woff',
  '.woff2',
  '.xz',
  '.zip'
]);

interface PromptFileReference {
  matchStart: number;
  matchEnd: number;
  replacementStart: number;
  target: string;
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
}

interface ExpandedFileReference {
  heading: string;
  content: string;
  languageId: string;
}

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string; modelId: string }
  | { type: 'addCurrentFile' }
  | { type: 'pickWorkspaceFiles' }
  | { type: 'pickExternalFiles' }
  | { type: 'readPath'; path: string }
  | { type: 'openFileReference'; path: string; startLine: number; endLine: number }
  | { type: 'removeContextFile'; uri: string }
  | { type: 'clearContext' }
  | { type: 'applyDraftEdit'; id: string }
  | { type: 'discardDraftEdit'; id: string };

class KeepseekChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly primaryViewType = PRIMARY_VIEW_TYPE;
  public static readonly secondaryViewType = SECONDARY_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner = new AgentRunner();
  private readonly safeFileEditor = new SafeFileEditor();
  private readonly messages: ChatMessage[] = [];
  private readonly draftEdits = new Map<string, DraftEdit>();
  private readonly views = new Set<vscode.WebviewView>();
  private selectedModelId = '';
  private isBusy = false;

  public constructor(private readonly extensionUri: vscode.Uri) {}

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
    const path = editor.document.uri.fsPath;

    await this.reveal();
    this.postToWebview({ type: 'insertFileReference', path, startLine, endLine });
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
        await this.sendPrompt(message.prompt, message.modelId);
        return;
      case 'addCurrentFile':
        await this.addCurrentFileToContext();
        return;
      case 'pickWorkspaceFiles':
        await this.pickWorkspaceFilesToContext();
        return;
      case 'pickExternalFiles':
        await this.pickExternalFilesToContext();
        return;
      case 'readPath':
        await this.readPathToContext(message.path);
        return;
      case 'openFileReference':
        await this.openFileReference(message.path, message.startLine, message.endLine);
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

  private async readPathToContext(inputPath: string): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.addPath(inputPath);
      if (files.length) {
        vscode.window.showInformationMessage(`KeepSeek added ${files.length} file(s).`);
      }
    });
  }

  private async openFileReference(rawPath: string, rawStartLine: number, rawEndLine: number): Promise<void> {
    try {
      const trimmedPath = rawPath.trim();
      if (!trimmedPath) {
        throw new Error('File reference has no path.');
      }

      const uri = trimmedPath.toLowerCase().startsWith('file:')
        ? vscode.Uri.parse(trimmedPath)
        : vscode.Uri.file(trimmedPath);
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
      const start = new vscode.Position(startLine - 1, 0);
      const end = new vscode.Position(endLine - 1, document.lineAt(endLine - 1).range.end.character);

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

  private async sendPrompt(prompt: string, modelId: string): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || this.isBusy) {
      return;
    }

    const models = getConfiguredModels();
    const model = models.find((item) => item.id === modelId) ?? models[0];
    this.selectedModelId = model.id;
    const expandedPrompt = await expandFileReferencesInPrompt(trimmedPrompt);

    this.messages.push({
      id: randomUUID(),
      role: 'user',
      content: expandedPrompt,
      createdAt: new Date().toISOString(),
      modelId: model.id
    });
    this.trimHistory();

    this.isBusy = true;
    this.postState();

    try {
      const response = await this.agentRunner.run({
        prompt: expandedPrompt,
        model,
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
        createdAt: new Date().toISOString(),
        modelId: model.id
      });
      this.trimHistory();
    } catch (error) {
      this.messages.push({
        id: randomUUID(),
        role: 'assistant',
        content: `Error: ${getErrorMessage(error)}`,
        createdAt: new Date().toISOString(),
        modelId: model.id
      });
    } finally {
      this.isBusy = false;
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
        messages: this.messages,
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

  const provider = new KeepseekChatViewProvider(context.extensionUri);
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

function clampLine(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function getExplorerFileUris(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const sourceUris = selectedUris?.length ? selectedUris : uri ? [uri] : [];
  const seen = new Set<string>();
  const fileUris: vscode.Uri[] = [];

  for (const sourceUri of sourceUris) {
    if (!(sourceUri instanceof vscode.Uri)) {
      continue;
    }

    const key = sourceUri.toString();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    fileUris.push(sourceUri);
  }

  return fileUris;
}

async function expandFileReferencesInPrompt(prompt: string): Promise<string> {
  const references = findPromptFileReferences(prompt);
  if (!references.length) {
    return prompt;
  }

  let expandedPrompt = '';
  let cursor = 0;

  for (const reference of references) {
    if (reference.replacementStart < cursor) {
      continue;
    }

    const expandedReference = await expandPromptFileReference(prompt, reference);
    if (!expandedReference) {
      continue;
    }

    expandedPrompt += prompt.slice(cursor, reference.replacementStart);
    expandedPrompt += withPromptBlockBoundaries(prompt, reference.replacementStart, reference.matchEnd, expandedReference);
    cursor = reference.matchEnd;
  }

  return expandedPrompt + prompt.slice(cursor);
}

function findPromptFileReferences(prompt: string): PromptFileReference[] {
  const references: PromptFileReference[] = [];

  for (const match of prompt.matchAll(FILE_REFERENCE_PATTERN)) {
    const target = match[1]?.trim();
    const matchStart = match.index;
    if (!target || matchStart === undefined) {
      continue;
    }

    const parsed = parseFileReferenceTarget(target);
    if (!parsed) {
      continue;
    }

    const matchEnd = matchStart + match[0].length;
    references.push({
      matchStart,
      matchEnd,
      replacementStart: getFileReferenceReplacementStart(prompt, matchStart, parsed.uri, parsed.startLine, parsed.endLine),
      target,
      uri: parsed.uri,
      startLine: parsed.startLine,
      endLine: parsed.endLine
    });
  }

  return references;
}

function parseFileReferenceTarget(target: string): { uri: vscode.Uri; startLine: number; endLine: number } | undefined {
  const lineMatch = FILE_REFERENCE_LINE_PATTERN.exec(target);
  const referencePath = lineMatch?.groups?.path ?? target;
  const uri = resolveReferenceUri(referencePath);
  if (!uri) {
    return undefined;
  }

  const startLine = Number(lineMatch?.groups?.startLine ?? 0);
  const parsedEndLine = Number(lineMatch?.groups?.endLine ?? startLine);
  const endLine = startLine > 0 ? Math.max(startLine, parsedEndLine) : 0;

  return { uri, startLine, endLine };
}

function resolveReferenceUri(referencePath: string): vscode.Uri | undefined {
  const trimmedPath = referencePath.trim();
  if (!trimmedPath) {
    return undefined;
  }

  try {
    if (/^file:/iu.test(trimmedPath) || /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmedPath)) {
      return vscode.Uri.parse(trimmedPath);
    }
  } catch {
    return undefined;
  }

  const expandedPath = trimmedPath.replace(/^~(?=$|[/\\])/, os.homedir());
  if (path.isAbsolute(expandedPath)) {
    return vscode.Uri.file(expandedPath);
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspaceRoot) {
    return vscode.Uri.joinPath(workspaceRoot, ...expandedPath.split(/[\\/]+/).filter(Boolean));
  }

  return vscode.Uri.file(path.resolve(expandedPath));
}

function getFileReferenceReplacementStart(
  prompt: string,
  matchStart: number,
  uri: vscode.Uri,
  startLine: number,
  endLine: number
): number {
  const fileName = getUriFileName(uri);
  const prefix = prompt.slice(0, matchStart);
  const labels = startLine > 0 ? [`${fileName} (${formatReferenceLineLabel(startLine, endLine)}) `] : [];
  labels.push(`${fileName} (全文) `, `${fileName} `);

  for (const label of labels) {
    if (prefix.endsWith(label)) {
      return matchStart - label.length;
    }
  }

  return matchStart;
}

async function expandPromptFileReference(
  prompt: string,
  reference: PromptFileReference
): Promise<string | undefined> {
  if (shouldSkipReferenceUri(reference.uri)) {
    return undefined;
  }

  try {
    const stat = await vscode.workspace.fs.stat(reference.uri);
    if (stat.type !== vscode.FileType.File) {
      return undefined;
    }

    if (reference.startLine <= 0 && stat.size > getReferenceExpansionMaxBytes()) {
      return undefined;
    }

    const document = await vscode.workspace.openTextDocument(reference.uri);
    const content = getReferenceDocumentText(document, reference.startLine, reference.endLine);
    if (!isReadableTextContent(content) || exceedsReferenceExpansionLimit(content)) {
      return undefined;
    }

    return formatExpandedFileReference({
      heading: prompt.slice(reference.replacementStart, reference.matchEnd).trim(),
      content,
      languageId: getMarkdownFenceLanguage(document)
    });
  } catch {
    return undefined;
  }
}

function getReferenceDocumentText(document: vscode.TextDocument, rawStartLine: number, rawEndLine: number): string {
  if (rawStartLine <= 0) {
    return document.getText();
  }

  const startLine = clampLine(rawStartLine, 1, document.lineCount);
  const endLine = clampLine(rawEndLine, startLine, document.lineCount);
  const start = new vscode.Position(startLine - 1, 0);
  const end = new vscode.Position(endLine - 1, document.lineAt(endLine - 1).range.end.character);
  return document.getText(new vscode.Range(start, end));
}

function shouldSkipReferenceUri(uri: vscode.Uri): boolean {
  return SKIPPED_REFERENCE_EXTENSIONS.has(path.extname(uri.fsPath || uri.path).toLowerCase());
}

function getMarkdownFenceLanguage(document: vscode.TextDocument): string {
  const languageById: Record<string, string> = {
    bat: 'batch',
    javascriptreact: 'jsx',
    plaintext: 'text',
    shellscript: 'bash',
    typescriptreact: 'tsx'
  };
  const language = languageById[document.languageId] ?? document.languageId;
  return language.replace(/[^\w+.-]/gu, '') || 'text';
}

function formatExpandedFileReference(reference: ExpandedFileReference): string {
  const content = reference.content.replace(/\r\n?/gu, '\n');
  const fence = getMarkdownFence(content);
  const fencedContent = content.endsWith('\n') ? content : `${content}\n`;
  return `${reference.heading}\n${fence}${reference.languageId}\n${fencedContent}${fence}`;
}

function getMarkdownFence(content: string): string {
  const runs = content.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function withPromptBlockBoundaries(prompt: string, start: number, end: number, block: string): string {
  const needsLeadingBreak = start > 0 && !isLineBreak(prompt.charAt(start - 1));
  const needsTrailingBreak = end < prompt.length && !isLineBreak(prompt.charAt(end));
  return `${needsLeadingBreak ? '\n' : ''}${block}${needsTrailingBreak ? '\n' : ''}`;
}

function isLineBreak(value: string): boolean {
  return value === '\n' || value === '\r';
}

function isReadableTextContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  if (!sample) {
    return true;
  }

  let suspiciousCharacters = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0 || code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)) {
      suspiciousCharacters += 1;
    }
  }

  return suspiciousCharacters / sample.length < 0.03;
}

function exceedsReferenceExpansionLimit(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > getReferenceExpansionMaxBytes();
}

function getReferenceExpansionMaxBytes(): number {
  return vscode.workspace.getConfiguration('keepseek').get('maxFileBytes', 200_000);
}

function getUriFileName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath || uri.path) || uri.fsPath || uri.path || 'file';
}

function formatReferenceLineLabel(startLine: number, endLine: number): string {
  if (startLine === endLine) {
    return `第${startLine}行`;
  }
  return `第${startLine}-${endLine}行`;
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
      id: 'keepseek-default',
      label: 'KeepSeek Default',
      provider: 'custom'
    }
  ];
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
