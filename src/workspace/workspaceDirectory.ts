import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatBytes } from '../shared/format';

export const SKIPPED_WORKSPACE_DIRECTORY_NAMES = new Set([
  '.git',
  '.vscode-test',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out'
]);

export const WORKSPACE_DIRECTORY_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';

export type WorkspaceDirectoryEntryKind = 'file' | 'directory';

export interface WorkspaceDirectoryEntry {
  path: string;
  label: string;
  uri: string;
  kind: WorkspaceDirectoryEntryKind;
  workspaceFolder: string;
  sizeBytes?: number;
  size?: string;
  extension?: string;
}

export interface WorkspaceDirectoryListing {
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
}

export interface ListWorkspaceDirectoryEntriesOptions {
  recursive?: boolean;
  maxEntries: number;
  maxDepth?: number;
  includeWorkspaceFolder?: boolean;
}

export async function listWorkspaceDirectoryEntries(
  rootUri: vscode.Uri,
  options: ListWorkspaceDirectoryEntriesOptions
): Promise<WorkspaceDirectoryListing> {
  const entries: WorkspaceDirectoryEntry[] = [];
  const visitedDirectories = new Set<string>();
  const maxEntries = Math.max(1, Math.floor(options.maxEntries));
  const maxDepth = Math.max(0, Math.floor(options.maxDepth ?? 8));
  let truncated = false;

  const visit = async (directoryUri: vscode.Uri, depth: number): Promise<void> => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }

    const directoryKey = directoryUri.toString();
    if (visitedDirectories.has(directoryKey)) {
      return;
    }
    visitedDirectories.add(directoryKey);

    const children = await vscode.workspace.fs.readDirectory(directoryUri);
    children.sort(([leftName, leftType], [rightName, rightType]) => {
      const leftIsDirectory = isDirectoryFileType(leftType);
      const rightIsDirectory = isDirectoryFileType(rightType);
      if (leftIsDirectory !== rightIsDirectory) {
        return leftIsDirectory ? -1 : 1;
      }
      return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
    });

    for (const [name, fileType] of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const childUri = vscode.Uri.joinPath(directoryUri, name);
      if (isDirectoryFileType(fileType)) {
        if (SKIPPED_WORKSPACE_DIRECTORY_NAMES.has(name)) {
          continue;
        }

        entries.push(createDirectoryEntry(childUri, options.includeWorkspaceFolder ?? false));
        if (options.recursive && depth < maxDepth) {
          await visit(childUri, depth + 1);
        }
        continue;
      }

      if (!isFileFileType(fileType)) {
        continue;
      }

      try {
        const stat = await vscode.workspace.fs.stat(childUri);
        entries.push(createFileEntry(childUri, stat.size, options.includeWorkspaceFolder ?? false));
      } catch {
        // Skip files that disappear or cannot be statted while listing.
      }
    }
  };

  await visit(rootUri, 0);
  return { entries, truncated };
}

export function getWorkspaceResourcePath(uri: vscode.Uri, includeWorkspaceFolder = false): string {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    return vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
  }
  return uri.fsPath || uri.toString();
}

export function getWorkspaceDirectoryName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath || uri.path) || uri.fsPath || uri.path || 'directory';
}

export function isDirectoryFileType(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.Directory) === vscode.FileType.Directory;
}

export function isFileFileType(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.File) === vscode.FileType.File;
}

function createDirectoryEntry(uri: vscode.Uri, includeWorkspaceFolder: boolean): WorkspaceDirectoryEntry {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = getWorkspaceResourcePath(uri, includeWorkspaceFolder);
  return {
    path: relativePath,
    label: getWorkspaceDirectoryName(uri),
    uri: uri.toString(),
    kind: 'directory',
    workspaceFolder: workspaceFolder?.name ?? ''
  };
}

function createFileEntry(uri: vscode.Uri, sizeBytes: number, includeWorkspaceFolder: boolean): WorkspaceDirectoryEntry {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  const relativePath = getWorkspaceResourcePath(uri, includeWorkspaceFolder);
  return {
    path: relativePath,
    label: path.basename(uri.fsPath || uri.path) || relativePath,
    uri: uri.toString(),
    kind: 'file',
    workspaceFolder: workspaceFolder?.name ?? '',
    sizeBytes,
    size: formatBytes(sizeBytes),
    extension: path.extname(uri.fsPath || uri.path).toLowerCase()
  };
}
