import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangeCheckpoint, DraftEdit } from '../shared/types';

const DRAFT_DIFF_SCHEME = 'keepseek-draft';

export class DraftDiffService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  public constructor() {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DRAFT_DIFF_SCHEME, this);
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  public async openDiff(edit: DraftEdit, checkpoint?: ChangeCheckpoint): Promise<void> {
    const originalText = checkpoint?.originalExists
      ? checkpoint.originalText ?? ''
      : checkpoint
        ? ''
        : await this.readCurrentText(vscode.Uri.parse(edit.uri));
    const proposedText = edit.action === 'delete' ? '' : edit.newText;
    const key = randomUUID();
    const left = this.createVirtualUri(key, 'before', edit.label);
    const right = this.createVirtualUri(key, 'after', edit.label);
    this.contents.set(left.toString(), originalText);
    this.contents.set(right.toString(), proposedText);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${edit.label} — KeepSeek ChangeSet`,
      { preview: true }
    );
  }

  public dispose(): void {
    this.contents.clear();
    this.registration.dispose();
  }

  private createVirtualUri(key: string, side: 'before' | 'after', label: string): vscode.Uri {
    const safeLabel = label.replace(/[/?#]/gu, '-');
    return vscode.Uri.parse(`${DRAFT_DIFF_SCHEME}:/${key}/${side}/${encodeURIComponent(safeLabel)}`);
  }

  private async readCurrentText(uri: vscode.Uri): Promise<string> {
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
    if (openDocument) {
      return openDocument.getText();
    }
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return '';
    }
  }
}
