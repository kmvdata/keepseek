import * as vscode from 'vscode';
import { DraftEdit } from '../shared/types';

type Translator = (key: string, values?: Record<string, string | number>) => string;

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();

  public constructor(
    private readonly t: Translator = (key) => key
  ) {}

  public async applyDraftEdit(edit: DraftEdit): Promise<boolean> {
    const uri = vscode.Uri.parse(edit.uri);
    this.assertNoDirtyOpenEditor(uri, edit.label);

    if (edit.action === 'delete') {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      await this.closeOpenTabs(uri);
      return true;
    }

    const wasOpen = this.isOpenInEditor(uri);
    if (edit.action === 'create') {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    }
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(edit.newText));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    if (wasOpen) {
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
    return true;
  }

  private assertNoDirtyOpenEditor(uri: vscode.Uri, label: string): void {
    const hasDirtyDocument = vscode.workspace.textDocuments.some(
      (document) => this.isSameUri(document.uri, uri) && document.isDirty
    );
    const hasDirtyTab = this.findOpenTabs(uri).some((tab) => tab.isDirty);
    if (!hasDirtyDocument && !hasDirtyTab) {
      return;
    }

    throw new Error(this.t('cannotApplyDirtyDraftEdit', { label }));
  }

  private isOpenInEditor(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some((document) => this.isSameUri(document.uri, uri))
      || this.findOpenTabs(uri).length > 0;
  }

  private async closeOpenTabs(uri: vscode.Uri): Promise<void> {
    const tabs = this.findOpenTabs(uri);
    if (!tabs.length) {
      return;
    }

    await vscode.window.tabGroups.close(tabs, true);
  }

  private findOpenTabs(uri: vscode.Uri): vscode.Tab[] {
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (this.tabReferencesUri(tab, uri)) {
          tabs.push(tab);
        }
      }
    }
    return tabs;
  }

  private tabReferencesUri(tab: vscode.Tab, uri: vscode.Uri): boolean {
    const input = tab.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
      return this.isSameUri(input.uri, uri);
    }
    if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
      return this.isSameUri(input.original, uri) || this.isSameUri(input.modified, uri);
    }
    return false;
  }

  private isSameUri(left: vscode.Uri, right: vscode.Uri): boolean {
    return left.toString() === right.toString();
  }
}
