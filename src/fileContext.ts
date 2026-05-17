import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ContextFile } from './types';

const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.vscode-test',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
]);

const WORKSPACE_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';

interface ContextLimits {
  maxFileBytes: number;
  maxContextFiles: number;
}

export class FileContextStore {
  private readonly files = new Map<string, ContextFile>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public getAll(): ContextFile[] {
    return Array.from(this.files.values());
  }

  public clear(): void {
    this.files.clear();
  }

  public remove(uri: string): void {
    this.files.delete(uri);
  }

  public async addCurrentEditor(): Promise<ContextFile> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No active editor found.');
    }

    const document = editor.document;
    const content = document.getText();
    this.ensureTextWithinLimit(content, document.uri);

    const contextFile = this.createContextFile(document.uri, content, document.languageId);
    this.files.set(contextFile.uri, contextFile);
    return contextFile;
  }

  public async pickWorkspaceFiles(): Promise<ContextFile[]> {
    if (!vscode.workspace.workspaceFolders?.length) {
      throw new Error('Open a workspace before picking workspace files.');
    }

    const uris = await vscode.workspace.findFiles('**/*', WORKSPACE_GLOB_EXCLUDE, 1000);
    const items = uris.map((uri) => ({
      label: vscode.workspace.asRelativePath(uri, false),
      description: uri.fsPath,
      uri
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      matchOnDescription: true,
      placeHolder: 'Select files to add to KeepSeek context'
    });

    if (!picked?.length) {
      return [];
    }

    const added: ContextFile[] = [];
    for (const item of picked) {
      added.push(await this.addUri(item.uri));
    }
    return added;
  }

  public async pickExternalFiles(): Promise<ContextFile[]> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: 'Add to KeepSeek Context'
    });

    if (!picked?.length) {
      return [];
    }

    const added: ContextFile[] = [];
    for (const uri of picked) {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        added.push(...(await this.addDirectory(uri)));
      } else {
        added.push(await this.addUri(uri));
      }
    }
    return added;
  }

  public async addPath(rawPath: string): Promise<ContextFile[]> {
    const uri = this.resolveInputPath(rawPath);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type === vscode.FileType.Directory) {
      return this.addDirectory(uri);
    }
    return [await this.addUri(uri)];
  }

  public async addUri(uri: vscode.Uri): Promise<ContextFile> {
    this.ensureContextHasRoom();

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(`${uri.fsPath} is not a regular file.`);
    }

    const limits = this.getLimits();
    if (stat.size > limits.maxFileBytes) {
      throw new Error(`${this.getLabel(uri)} is larger than ${formatBytes(limits.maxFileBytes)}.`);
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = this.decodeText(bytes, uri);
    const languageId = await this.detectLanguageId(uri);
    const contextFile = this.createContextFile(uri, content, languageId);
    this.files.set(contextFile.uri, contextFile);
    return contextFile;
  }

  private async addDirectory(uri: vscode.Uri, depth = 0): Promise<ContextFile[]> {
    if (depth > 8) {
      return [];
    }

    const added: ContextFile[] = [];
    const entries = await vscode.workspace.fs.readDirectory(uri);
    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, fileType] of entries) {
      if (this.files.size >= this.getLimits().maxContextFiles) {
        break;
      }
      if (SKIPPED_DIRECTORY_NAMES.has(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(uri, name);
      try {
        if (fileType === vscode.FileType.Directory) {
          added.push(...(await this.addDirectory(childUri, depth + 1)));
        } else if (fileType === vscode.FileType.File) {
          added.push(await this.addUri(childUri));
        }
      } catch {
        // Skip unreadable, binary, or oversized files during directory import.
      }
    }

    return added;
  }

  private createContextFile(uri: vscode.Uri, content: string, languageId: string): ContextFile {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    return {
      id: uri.toString(),
      uri: uri.toString(),
      label: this.getLabel(uri),
      fsPath: uri.fsPath,
      languageId,
      content,
      sizeBytes: new TextEncoder().encode(content).byteLength,
      source: workspaceFolder ? 'workspace' : 'external'
    };
  }

  private async detectLanguageId(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.languageId;
    } catch {
      return 'plaintext';
    }
  }

  private decodeText(bytes: Uint8Array, uri: vscode.Uri): string {
    const prefix = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (prefix.includes(0)) {
      throw new Error(`${this.getLabel(uri)} appears to be a binary file.`);
    }
    return this.decoder.decode(bytes);
  }

  private ensureTextWithinLimit(content: string, uri: vscode.Uri): void {
    const limits = this.getLimits();
    const size = new TextEncoder().encode(content).byteLength;
    if (size > limits.maxFileBytes) {
      throw new Error(`${this.getLabel(uri)} is larger than ${formatBytes(limits.maxFileBytes)}.`);
    }
  }

  private ensureContextHasRoom(): void {
    const limits = this.getLimits();
    if (this.files.size >= limits.maxContextFiles) {
      throw new Error(`Context already contains ${limits.maxContextFiles} files.`);
    }
  }

  private resolveInputPath(rawPath: string): vscode.Uri {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new Error('Enter a file or folder path.');
    }

    const expanded = trimmed.replace(/^~(?=$|[/\\])/, os.homedir());
    if (path.isAbsolute(expanded)) {
      return vscode.Uri.file(expanded);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return vscode.Uri.file(path.resolve(expanded));
    }

    return vscode.Uri.joinPath(workspaceRoot, ...expanded.split(/[\\/]+/).filter(Boolean));
  }

  private getLabel(uri: vscode.Uri): string {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }

  private getLimits(): ContextLimits {
    const config = vscode.workspace.getConfiguration('keepseek');
    return {
      maxFileBytes: config.get('maxFileBytes', 200_000),
      maxContextFiles: config.get('maxContextFiles', 32)
    };
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
