import { lstat, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import { canonicalPath, isPathInside } from './pathScope';
import { assertOperationPath } from './protectedTargets';

/** Local metadata only. External provider-backed URIs are never accessed here. */
export async function inspectDraftEditTarget(uri: vscode.Uri, allowMissing: boolean, skillScaffold = false) {
  assertOperationPath(uri.fsPath, true, skillScaffold);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const identity = { uri: uri.toString(), root: folder?.uri.toString() };
  if (uri.scheme !== 'file') {
    assertOperationPath(uri.path, true, skillScaffold);
    return { ...identity, canonical: uri.path, fileIdentity: undefined };
  }
  const info = await lstat(uri.fsPath).catch((error: NodeJS.ErrnoException) => {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (info?.isSymbolicLink()) throw new Error('DraftEdit targets cannot be symbolic links.');
  if (info && !info.isFile()) throw new Error('DraftEdit target is not a regular file. / 草稿编辑目标不是普通文件。');
  const canonical = await canonicalPath(uri.fsPath);
  assertOperationPath(canonical, true, skillScaffold);
  if (folder && !isPathInside(await realpath(folder.uri.fsPath), canonical)) {
    throw new Error('DraftEdit target escapes the workspace through a symbolic link.');
  }
  return { ...identity, canonical, fileIdentity: info && [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs] };
}

export function assertCleanDraftEditTarget(uri: vscode.Uri, message: string, canonical?: string): void {
  const matches = (target: vscode.Uri) => target.toString() === uri.toString()
    || (uri.scheme === 'file' && target.scheme === 'file' && target.fsPath === canonical);
  if (vscode.workspace.textDocuments.some(document => document.isDirty && matches(document.uri))
    || findDraftEditTargetTabs(matches).some(tab => tab.isDirty)) throw new Error(message);
}

export function findDraftEditTargetTabs(matches: (uri: vscode.Uri) => boolean): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs.filter(tab => {
    const input = tab.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
      return matches(input.uri);
    }
    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
      return matches(input.original) || matches(input.modified);
    }
    return false;
  }));
}
