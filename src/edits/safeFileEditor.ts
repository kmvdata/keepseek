import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredWorkspaceReadMaxBytes } from '../shared/config';
import { formatBytes } from '../shared/format';
import { decodeRollbackSafeUtf8Text } from '../shared/safeTextSnapshot';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
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
  requireSafeTextFor?: 'write' | 'delete';
}

export interface DelegatedEditApproval {
  authorizedUri: string;
  isAuthorized: () => boolean;
  source?: 'model_reviewer' | 'delegated_approver';
}

export interface DraftEditPreflight {
  originalText: string;
  originalTextHash?: string;
  originalSize?: number;
}

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public constructor(
    private readonly t: Translator = (key) => key
  ) {}

  /** Deterministic hard checks used before a model review. No write occurs. */
  public async preflightDraftEdit(edit: DraftEdit, approval?: DelegatedEditApproval): Promise<DraftEditPreflight> {
    const uri = vscode.Uri.parse(edit.uri);
    if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
    if (approval && (approval.authorizedUri !== edit.uri || !approval.isAuthorized())) {
      throw new Error('Delegated file approval was cancelled or revoked.');
    }
    this.assertWorkspaceTarget(uri, edit.label, approval?.authorizedUri);
    this.assertNoDirtyOpenEditor(uri, edit.label);
    this.assertSafeDraftOutput(uri, edit);
    const original = await this.readSnapshot(uri, {
      label: edit.label,
      requireSafeTextFor: edit.action === 'delete' ? 'delete' : 'write'
    });
    this.assertActionMatchesSnapshot(edit, original);
    this.assertDeleteBaselineMatches(edit, original);
    return {
      originalText: original.text ?? '',
      originalTextHash: original.hash,
      originalSize: original.sizeBytes
    };
  }

  public async applyDraftEdit(edit: DraftEdit, changeSetId = 'legacy', approval?: DelegatedEditApproval): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(edit.uri);
    const checkApproval = () => {
      if (approval && (!vscode.workspace.isTrusted || approval.authorizedUri !== edit.uri || !approval.isAuthorized())) {
        throw new Error('Delegated file approval was cancelled or revoked.');
      }
    };
    checkApproval();
    if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
    this.assertWorkspaceTarget(uri, edit.label, approval?.authorizedUri);
    this.assertNoDirtyOpenEditor(uri, edit.label);
    this.assertSafeDraftOutput(uri, edit);
    const original = await this.readSnapshot(uri, {
      label: edit.label,
      requireSafeTextFor: edit.action === 'delete' ? 'delete' : 'write'
    });
    this.assertActionMatchesSnapshot(edit, original);
    this.assertDeleteBaselineMatches(edit, original);

    const checkpoint: ChangeCheckpoint = {
      authorizedExternalUri: approval && !vscode.workspace.getWorkspaceFolder(uri) ? uri.toString() : undefined,
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

    checkApproval();
    this.assertNoDirtyOpenEditor(uri, edit.label);
    if (edit.action === 'delete') {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      await this.closeOpenTabs(uri);
      return checkpoint;
    }

    await this.writeTextFile(uri, edit.newText, edit.action === 'create', checkApproval);
    return checkpoint;
  }

  public async revertCheckpoint(checkpoint: ChangeCheckpoint): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(checkpoint.uri);
    this.assertWorkspaceTarget(uri, checkpoint.label, checkpoint.authorizedExternalUri);
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

  private assertWorkspaceTarget(uri: vscode.Uri, label: string, authorizedUri?: string): void {
    if (authorizedUri === uri.toString() && uri.scheme === 'file' && vscode.workspace.isTrusted) return;
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

    throw new Error(this.t(edit.action === 'delete' ? 'cannotApplyChangedDeleteTarget' : 'cannotApplyChangedDraftTarget', { label: edit.label }));
  }

  private assertSafeDraftOutput(uri: vscode.Uri, edit: DraftEdit): void {
    if (edit.action === 'delete') return;
    const sizeBytes = this.encoder.encode(edit.newText).byteLength;
    const maxBytes = getConfiguredWorkspaceReadMaxBytes();
    // The context reader skips some valid text formats (for example SVG) for
    // prompt-economy reasons. SafeFileEditor only needs the bytes to be a
    // bounded, rollback-safe text snapshot, so do not apply that extension
    // deny-list to writes.
    if (!isReadableTextContent(edit.newText)) {
      throw new Error(this.t('cannotWriteUnreadableFile', { label: edit.label }));
    }
    if (sizeBytes > maxBytes) {
      throw new Error(this.t('cannotWriteOversizedFile', { label: edit.label, limit: formatBytes(maxBytes) }));
    }
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
      if (options.requireSafeTextFor) {
        this.assertSafeTextFileMetadata(uri, label, stat.size, options.requireSafeTextFor);
      }
      if (options.readContent === false) {
        return {
          exists: true,
          sizeBytes: stat.size
        };
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (options.requireSafeTextFor) {
        // Re-check the bytes actually read so a target swapped after stat cannot
        // bypass the rollback snapshot limit.
        this.assertSafeTextFileMetadata(uri, label, bytes.byteLength, options.requireSafeTextFor);
      }
      const text = options.requireSafeTextFor
        ? this.decodeSafeText(bytes, label, options.requireSafeTextFor)
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

  private assertSafeTextFileMetadata(uri: vscode.Uri, label: string, sizeBytes: number, operation: 'write' | 'delete'): void {
    if (operation === 'delete' && shouldSkipTextUri(uri)) {
      throw new Error(this.t(operation === 'delete' ? 'cannotDeleteUnreadableFile' : 'cannotWriteUnreadableFile', { label }));
    }
    const maxBytes = getConfiguredWorkspaceReadMaxBytes();
    if (sizeBytes > maxBytes) {
      throw new Error(this.t(operation === 'delete' ? 'cannotDeleteOversizedFile' : 'cannotWriteOversizedFile', {
        label,
        limit: formatBytes(maxBytes)
      }));
    }
  }

  private decodeSafeText(bytes: Uint8Array, label: string, operation: 'write' | 'delete'): string {
    const text = decodeRollbackSafeUtf8Text(bytes);
    if (text !== undefined) {
      return text;
    }
    throw new Error(this.t(operation === 'delete' ? 'cannotDeleteUnreadableFile' : 'cannotWriteUnreadableFile', { label }));
  }

  private async writeTextFile(uri: vscode.Uri, text: string, createParent: boolean, checkApproval?: () => void): Promise<void> {
    const hasActiveTextTab = this.findOpenTextTabs(uri).some((tab) => tab.isActive);
    if (createParent) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    }
    checkApproval?.();
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
