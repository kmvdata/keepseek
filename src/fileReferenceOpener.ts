import * as vscode from 'vscode';
import { clampColumn, clampLine, resolveFileReferenceUri } from './fileReference';
import { getErrorMessage } from './errors';
import { localize, type KeepseekLanguage } from './i18n';

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
    if (stat.type === vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', uri);
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);

    if (input.startLine <= 0) {
      await vscode.window.showTextDocument(document, { preview: true });
      return;
    }

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
  } catch (error) {
    vscode.window.showErrorMessage(localize(input.language, 'cannotOpenFileReference', { message: getErrorMessage(error) }));
  }
}
