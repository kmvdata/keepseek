import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredWorkspaceReadMaxBytes, getConfiguredWorkspaceToolFileLimit } from '../../shared/config';
import { formatBytes } from '../../shared/format';
import { isReadableTextContent, shouldSkipTextUri } from '../../shared/textFileGuards';
import type { KeepseekLanguage } from '../../shared/i18n';
import { getWorkspaceResourcePath, listWorkspaceDirectoryEntries } from '../../workspace/workspaceDirectory';

const WORKSPACE_TOOL_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';

export interface WorkspaceToolAdapter {
  listWorkspaceFiles(language: KeepseekLanguage): Promise<string>;
  listWorkspaceDirectory(rawPath: string, recursive: boolean, maxFiles: number | undefined, language: KeepseekLanguage): Promise<string>;
  readWorkspaceFile(rawPath: string, language: KeepseekLanguage): Promise<string>;
  resolveTargetUri(targetPath: string): vscode.Uri;
  getLabel(uri: vscode.Uri): string;
}

export class WorkspaceToolService implements WorkspaceToolAdapter {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async listWorkspaceFiles(language: KeepseekLanguage): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return JSON.stringify({
        ok: false,
        error: language === 'en'
          ? 'Open a workspace before listing project files.'
          : '请先打开一个工作区，再列出工程文件。'
      });
    }

    const includeWorkspaceFolder = folders.length > 1;
    const maxFiles = getConfiguredWorkspaceToolFileLimit();
    const files: Array<{
      path: string;
      label: string;
      workspaceFolder: string;
      sizeBytes: number;
      size: string;
      extension: string;
    }> = [];
    let truncated = false;

    for (const folder of folders) {
      const remaining = maxFiles - files.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        WORKSPACE_TOOL_GLOB_EXCLUDE,
        remaining
      );
      if (uris.length >= remaining) {
        truncated = true;
      }

      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File) {
            continue;
          }

          const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
          files.push({
            path: relativePath,
            label: path.basename(uri.fsPath || uri.path) || relativePath,
            workspaceFolder: folder.name,
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
            extension: path.extname(uri.fsPath || uri.path).toLowerCase()
          });
        } catch {
          // Skip files that disappeared or cannot be statted while listing.
        }
      }
    }

    files.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));

    return JSON.stringify({
      ok: true,
      files,
      count: files.length,
      limit: maxFiles,
      truncated,
      excluded: ['.git', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out'],
      workspaceFolders: folders.map((folder) => ({
        name: folder.name,
        uri: folder.uri.toString()
      }))
    });
  }

  public async listWorkspaceDirectory(rawPath: string, recursive: boolean, maxFiles: number | undefined, language: KeepseekLanguage): Promise<string> {
    const uri = this.resolveWorkspacePathUri(rawPath);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.Directory) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en' ? 'The requested path is not a directory.' : '请求的路径不是目录。'
      });
    }

    const configuredLimit = getConfiguredWorkspaceToolFileLimit();
    const requestedLimit = normalizeDirectoryListLimit(maxFiles, 100);
    const limit = Math.min(configuredLimit, requestedLimit);
    const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const listing = await listWorkspaceDirectoryEntries(uri, {
      recursive,
      maxEntries: limit,
      maxDepth: 8,
      includeWorkspaceFolder
    });

    return JSON.stringify({
      ok: true,
      path: getWorkspaceResourcePath(uri, includeWorkspaceFolder),
      uri: uri.toString(),
      recursive,
      entries: listing.entries,
      count: listing.entries.length,
      limit,
      truncated: listing.truncated,
      excluded: ['.git', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out']
    });
  }

  public async readWorkspaceFile(rawPath: string, language: KeepseekLanguage): Promise<string> {
    const uri = this.resolveWorkspacePathUri(rawPath);

    if (shouldSkipTextUri(uri)) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en'
          ? 'This file type is not read as text by KeepSeek.'
          : 'KeepSeek 不会把这种文件类型作为文本读取。'
      });
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en' ? 'The requested path is not a regular file.' : '请求的路径不是普通文件。'
      });
    }

    const maxBytes = getConfiguredWorkspaceReadMaxBytes();
    if (stat.size > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: stat.size,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `File is larger than the read limit (${formatBytes(maxBytes)}).`
          : `文件超过读取上限（${formatBytes(maxBytes)}）。`
      });
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = this.decodeWorkspaceText(bytes, uri, language);
    const encodedSize = new TextEncoder().encode(content).byteLength;
    if (encodedSize > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: encodedSize,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `Decoded text is larger than the read limit (${formatBytes(maxBytes)}).`
          : `解码后的文本超过读取上限（${formatBytes(maxBytes)}）。`
      });
    }

    const languageId = await this.detectLanguageId(uri);
    return JSON.stringify({
      ok: true,
      path: this.getLabel(uri),
      uri: uri.toString(),
      languageId,
      sizeBytes: encodedSize,
      size: formatBytes(encodedSize),
      content
    });
  }

  public resolveTargetUri(targetPath: string): vscode.Uri {
    if (/^file:/iu.test(targetPath)) {
      return vscode.Uri.parse(targetPath);
    }

    if (path.isAbsolute(targetPath)) {
      return vscode.Uri.file(targetPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return vscode.Uri.file(path.resolve(targetPath));
    }

    return vscode.Uri.joinPath(workspaceRoot, ...targetPath.split(/[\\/]+/).filter(Boolean));
  }

  public getLabel(uri: vscode.Uri): string {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }

  private resolveWorkspacePathUri(rawPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      throw new Error('Open a workspace before reading project files.');
    }

    const uri = this.resolveWorkspaceFileUriCandidate(rawPath, folders);
    if (!this.isUriInsideWorkspace(uri)) {
      throw new Error('The requested file must be inside the currently open workspace.');
    }
    return uri;
  }

  private resolveWorkspaceFileUriCandidate(rawPath: string, folders: readonly vscode.WorkspaceFolder[]): vscode.Uri {
    if (/^file:/iu.test(rawPath) || /^[a-z][a-z\d+.-]*:\/\//iu.test(rawPath)) {
      return vscode.Uri.parse(rawPath);
    }

    if (path.isAbsolute(rawPath)) {
      return vscode.Uri.file(rawPath);
    }

    const normalizedPath = rawPath.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (!normalizedPath || normalizedPath.includes('\0')) {
      throw new Error('Workspace file path cannot be empty.');
    }

    if (folders.length > 1) {
      for (const folder of folders) {
        const folderPrefix = `${folder.name}/`;
        if (normalizedPath === folder.name || normalizedPath.startsWith(folderPrefix)) {
          const pathWithinFolder = normalizedPath === folder.name
            ? ''
            : normalizedPath.slice(folderPrefix.length);
          return vscode.Uri.joinPath(folder.uri, ...pathWithinFolder.split('/').filter(Boolean));
        }
      }
    }

    return vscode.Uri.joinPath(folders[0].uri, ...normalizedPath.split('/').filter(Boolean));
  }

  private isUriInsideWorkspace(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return false;
    }

    if (uri.scheme === 'file' && folder.uri.scheme === 'file') {
      const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
      return relativePath === '' || (Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    return true;
  }

  private decodeWorkspaceText(bytes: Uint8Array, uri: vscode.Uri, language: KeepseekLanguage): string {
    const prefix = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (prefix.includes(0)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} appears to be binary and was not read.`
        : `${this.getLabel(uri)} 看起来是二进制文件，已跳过读取。`);
    }

    const content = this.decoder.decode(bytes);
    if (!isReadableTextContent(content)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} does not look like readable text.`
        : `${this.getLabel(uri)} 看起来不是可读文本。`);
    }
    return content;
  }

  private async detectLanguageId(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.languageId;
    } catch {
      return 'plaintext';
    }
  }
}

function normalizeDirectoryListLimit(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), 1), 2000);
}
