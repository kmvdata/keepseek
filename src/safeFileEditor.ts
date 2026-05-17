import * as vscode from 'vscode';
import { DraftEdit } from './types';

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();

  public async applyDraftEdit(edit: DraftEdit): Promise<boolean> {
    const uri = vscode.Uri.parse(edit.uri);
    const exists = await this.exists(uri);
    const action = exists ? '修改' : '创建';
    const choice = await vscode.window.showWarningMessage(
      `KeepSeek 请求${action}文件：${edit.label}\n\n原因：${edit.reason}\n\n请确认是否允许写入。`,
      { modal: true },
      '允许写入'
    );

    if (choice !== '允许写入') {
      return false;
    }

    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(edit.newText));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    return true;
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }
}
