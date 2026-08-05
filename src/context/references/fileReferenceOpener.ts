import * as vscode from 'vscode';
import { clampColumn, clampLine, resolveFileReferenceUri } from './fileReference';
import { getErrorMessage } from '../../shared/errors';
import { localize, type KeepseekLanguage } from '../../shared/i18n';

export async function openFileReference(input: {
  path: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  language: KeepseekLanguage;
}): Promise<void> {
  try {
    const trimmedPath = input.path.trim();
    if (!trimmedPath) {
      throw new Error(localize(input.language, 'fileReferenceNoPath'));
    }

    const uri = resolveFileReferenceUri(trimmedPath);
    if (!uri) {
      throw new Error(localize(input.language, 'fileReferenceInvalidPath'));
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.Directory) !== 0) {
      if (!(await openDirectoryReferenceUri(uri))) {
        throw new Error(localize(input.language, 'fileReferenceInvalidPath'));
      }
      return;
    }

    if (input.startLine <= 0) {
      await openInVisualStudioCodeOrReveal(uri, async () => {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      });
      return;
    }

    await openInVisualStudioCodeOrReveal(uri, async () => {
      const document = await vscode.workspace.openTextDocument(uri);
      const startLine = clampLine(input.startLine, 1, document.lineCount);
      const endLine = clampLine(input.endLine, startLine, document.lineCount);
      const startLineMaxCol = document.lineAt(startLine - 1).range.end.character;
      const endLineMaxCol = document.lineAt(endLine - 1).range.end.character;
      const startCol = input.startColumn > 0 ? clampColumn(input.startColumn - 1, startLineMaxCol) : 0;
      const endCol = input.endColumn > 0 ? clampColumn(input.endColumn - 1, endLineMaxCol) : endLineMaxCol;
      const start = new vscode.Position(startLine - 1, startCol);
      const end = new vscode.Position(endLine - 1, endCol);

      await vscode.window.showTextDocument(document, {
        preview: true,
        selection: new vscode.Range(start, end)
      });
    });
  } catch (error) {
    vscode.window.showErrorMessage(localize(input.language, 'cannotOpenFileReference', { message: getErrorMessage(error) }));
  }
}

export async function revealReferenceInOperatingSystem(uri: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') {
    return false;
  }
  await vscode.commands.executeCommand('revealFileInOS', uri);
  return true;
}

export async function openDirectoryReferenceUri(uri: vscode.Uri): Promise<boolean> {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    try {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return true;
    } catch (error) {
      if (!(await revealReferenceInOperatingSystem(uri))) {
        throw error;
      }
      return true;
    }
  }

  return await revealReferenceInOperatingSystem(uri);
}

async function openInVisualStudioCodeOrReveal(uri: vscode.Uri, open: () => Promise<void>): Promise<void> {
  try {
    await open();
  } catch (error) {
    if (!(await revealReferenceInOperatingSystem(uri))) {
      throw error;
    }
  }
}
