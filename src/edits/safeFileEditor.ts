import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredWorkspaceReadMaxBytes } from '../shared/config';
import { formatBytes } from '../shared/format';
import { decodeRollbackSafeUtf8Text } from '../shared/safeTextSnapshot';
import { shouldSkipTextUri } from '../shared/textFileGuards';
import type { ChangeCheckpoint, DraftEdit } from '../shared/types';

type Translator = (key: string, values?: Record<string, string | number>) => string;

interface FileSnapshot {
  exists: boolean;
  text?: string;
  hash?: string;
  sizeBytes?: number;
}

interface SnapshotReadOptions {
  label?: string;
  readContent?: boolean;
  requireSafeDeleteText?: boolean;
}

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public constructor(
    private readonly t: Translator = (key) => key
  ) {}

  public async applyDraftEdit(edit: DraftEdit, changeSetId = 'legacy'): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(edit.uri);
    this.assertWorkspaceTarget(uri, edit.label);
    this.assertNoDirtyOpenEditor(uri, edit.label);
    const original = await this.readSnapshot(uri, {
      label: edit.label,
      requireSafeDeleteText: edit.action === 'delete'
    });
    this.assertActionMatchesSnapshot(edit, original);
    if (edit.action === 'delete') {
      this.assertDeleteBaselineMatches(edit, original);
    }

    const checkpoint: ChangeCheckpoint = {
      id: randomUUID(),
      changeSetId,
      editId: edit.id,
      uri: edit.uri,
      label: edit.label,
      action: edit.action,
      originalExists: original.exists,
      originalText: original.text,
      originalTextHash: original.hash,
      appliedExists: edit.action !== 'delete',
      appliedTextHash: edit.action === 'delete' ? undefined : hashText(edit.newText),
      createdAt: new Date().toISOString(),
      appliedAt: new Date().toISOString()
    };

    if (edit.action === 'delete') {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      await this.closeOpenTabs(uri);
      return checkpoint;
    }

    await this.writeTextFile(uri, edit.newText, edit.action === 'create');
    return checkpoint;
  }

  public async revertCheckpoint(checkpoint: ChangeCheckpoint): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(checkpoint.uri);
    this.assertWorkspaceTarget(uri, checkpoint.label);
    this.assertNoDirtyOpenEditor(uri, checkpoint.label);
    const current = await this.readSnapshot(uri, {
      label: checkpoint.label,
      readContent: checkpoint.appliedExists
    });
    this.assertSnapshotMatchesAppliedChange(checkpoint, current);

    if (checkpoint.originalExists) {
      await this.writeTextFile(uri, checkpoint.originalText ?? '', !current.exists);
    } else if (current.exists) {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      await this.closeOpenTabs(uri);
    }

    return {
      ...checkpoint,
      revertedAt: new Date().toISOString()
    };
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

  private assertWorkspaceTarget(uri: vscode.Uri, label: string): void {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return;
    }
    throw new Error(this.t('cannotApplyOutsideWorkspace', { label }));
  }

  private assertActionMatchesSnapshot(edit: DraftEdit, snapshot: FileSnapshot): void {
    if (edit.action === 'create' && snapshot.exists) {
      throw new Error(this.t('cannotApplyCreatedFileExists', { label: edit.label }));
    }
    if ((edit.action === 'modify' || edit.action === 'delete' || edit.action === 'move') && !snapshot.exists) {
      throw new Error(this.t('cannotApplyMissingDraftTarget', { label: edit.label }));
    }
  }

  private assertDeleteBaselineMatches(edit: DraftEdit, snapshot: FileSnapshot): void {
    const sizeChanged = edit.expectedOriginalSize !== undefined
      && edit.expectedOriginalSize !== snapshot.sizeBytes;
    const textChanged = edit.expectedOriginalTextHash !== undefined
      && edit.expectedOriginalTextHash !== snapshot.hash;
    if (!sizeChanged && !textChanged) {
      return;
    }

    throw new Error(this.t('cannotApplyChangedDeleteTarget', { label: edit.label }));
  }

  private assertSnapshotMatchesAppliedChange(checkpoint: ChangeCheckpoint, current: FileSnapshot): void {
    if (checkpoint.appliedExists !== current.exists) {
      throw new Error(this.t('cannotRevertChangedAgentFile', { label: checkpoint.label }));
    }
    if (checkpoint.appliedExists && checkpoint.appliedTextHash !== current.hash) {
      throw new Error(this.t('cannotRevertChangedAgentFile', { label: checkpoint.label }));
    }
  }

  private async readSnapshot(uri: vscode.Uri, options: SnapshotReadOptions = {}): Promise<FileSnapshot> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const label = options.label ?? (uri.fsPath || uri.toString());
      if (stat.type !== vscode.FileType.File) {
        throw new Error(this.t('draftTargetNotFile', { label }));
      }
      if (options.requireSafeDeleteText) {
        this.assertSafeDeleteFileMetadata(uri, label, stat.size);
      }
      if (options.readContent === false) {
        return {
          exists: true,
          sizeBytes: stat.size
        };
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (options.requireSafeDeleteText) {
        // Re-check the bytes actually read so a target swapped after stat cannot
        // bypass the rollback snapshot limit.
        this.assertSafeDeleteFileMetadata(uri, label, bytes.byteLength);
      }
      const text = options.requireSafeDeleteText
        ? this.decodeSafeDeleteText(bytes, label)
        : this.decoder.decode(bytes);
      return {
        exists: true,
        text,
        hash: hashText(text),
        sizeBytes: bytes.byteLength
      };
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return { exists: false };
      }
      throw error;
    }
  }

  private assertSafeDeleteFileMetadata(uri: vscode.Uri, label: string, sizeBytes: number): void {
    if (shouldSkipTextUri(uri)) {
      throw new Error(this.t('cannotDeleteUnreadableFile', { label }));
    }
    const maxBytes = getConfiguredWorkspaceReadMaxBytes();
    if (sizeBytes > maxBytes) {
      throw new Error(this.t('cannotDeleteOversizedFile', {
        label,
        limit: formatBytes(maxBytes)
      }));
    }
  }

  private decodeSafeDeleteText(bytes: Uint8Array, label: string): string {
    const text = decodeRollbackSafeUtf8Text(bytes);
    if (text !== undefined) {
      return text;
    }
    throw new Error(this.t('cannotDeleteUnreadableFile', { label }));
  }

  private async writeTextFile(uri: vscode.Uri, text: string, createParent: boolean): Promise<void> {
    const hasActiveTextTab = this.findOpenTextTabs(uri).some((tab) => tab.isActive);
    if (createParent) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    }
    await vscode.workspace.fs.writeFile(uri, this.encoder.encode(text));
    if (hasActiveTextTab) {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }

  private findOpenTextTabs(uri: vscode.Uri): vscode.Tab[] {
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputText && this.isSameUri(tab.input.uri, uri)) {
          tabs.push(tab);
        }
      }
    }
    return tabs;
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === 'FileNotFound';
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'ENOENT' || code === 'FileNotFound';
}
