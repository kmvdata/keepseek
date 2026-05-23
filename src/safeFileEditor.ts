import * as vscode from 'vscode';
import { DraftEdit } from './types';

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();

  public async applyDraftEdit(edit: DraftEdit): Promise<boolean> {
    const uri = vscode.Uri.parse(edit.uri);
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(edit.newText));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
  }
}
