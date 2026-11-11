import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredPatchSettings } from '../shared/config';
import { formatBytes } from '../shared/format';
import { decodeRollbackSafeUtf8Text } from '../shared/safeTextSnapshot';
import { findSensitiveEvidence } from '../approvals/approvalPolicy';
import { assertOperationPath } from '../approvals/authorization/protectedTargets';
import { assertCleanDraftEditTarget, findDraftEditTargetTabs, inspectDraftEditTarget } from '../approvals/authorization/editTargets';
import { fileIdentity } from '../approvals/authorization/projectLaunchIdentity';
import { shouldSkipTextUri } from '../shared/textFileGuards';
import type { ChangeCheckpoint, DraftEdit, FileContentIdentity, TextPatchV1 } from '../shared/types';
import { ChangeArtifactStore } from './changeArtifactStore';
import { getDraftEditBase, getDraftEditFullText, getDraftEditKind, getDraftEditResult } from './draftEdit';
import { applyTextPatchToBytes, createInverseTextPatch, hashBytes, validateCanonicalTextPatch } from './textPatch';

type Translator = (key: string, values?: Record<string, string | number>) => string;

interface FileSnapshot {
  exists: boolean;
  bytes?: Uint8Array;
  text?: string;
  byteIdentity?: FileContentIdentity;
}

export interface ChangeCheckpointJournal {
  persist(checkpoint: ChangeCheckpoint): Promise<void>;
}

export class SafeFileEditError extends Error {
  public constructor(message: string, public readonly checkpoint?: ChangeCheckpoint) {
    super(message);
    this.name = 'SafeFileEditError';
  }
}

export interface DelegatedEditApproval {
  authorizedUri: string;
  authorizedUris?: readonly string[];
  isAuthorized: () => boolean;
  source?: 'model_reviewer' | 'delegated_approver' | 'user_click';
  verifyScope?: () => Promise<void>;
  skillScaffold?: boolean;
}

export interface DraftEditPreflight {
  /** Empty for patch-native edits; reviewer content comes from canonical hunks. */
  originalText: string;
  originalTextHash?: string;
  originalSize?: number;
}

export class SafeFileEditor {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  private artifactStore?: ChangeArtifactStore;

  public constructor(private readonly t: Translator = (key) => key) {}

  public configureArtifactStore(store: ChangeArtifactStore): void {
    this.artifactStore = store;
  }

  /** Validate the immutable proposed output without reading the target. */
  public async preflightDraftEditOutput(edit: DraftEdit, scanSensitive = false): Promise<void> {
    await this.assertSafeDraftOutput(edit, scanSensitive);
  }

  /** Deterministic hard checks used before a model review. No write occurs. */
  public async preflightDraftEdit(edit: DraftEdit, approval?: DelegatedEditApproval): Promise<DraftEditPreflight> {
    const uri = vscode.Uri.parse(edit.uri);
    await this.assertCommonPreconditions(uri, edit, approval);
    if (edit.kind === 'text_patch_v1') {
      const current = await this.readIdentity(uri, edit.patch.base.sizeBytes, true);
      this.assertByteIdentity(edit.patch.base, current, edit.label);
      return { originalText: '', originalTextHash: edit.patch.base.sha256, originalSize: edit.patch.base.sizeBytes };
    }
    const snapshot = await this.readSnapshotForEdit(uri, edit);
    this.assertActionMatchesSnapshot(edit, snapshot);
    this.assertBaselineMatches(edit, snapshot);
    return {
      originalText: snapshot.text ?? '',
      originalTextHash: getDraftEditBase(edit)?.sha256 ?? snapshot.byteIdentity?.sha256,
      originalSize: snapshot.byteIdentity?.sizeBytes
    };
  }

  public async applyDraftEdit(
    edit: DraftEdit,
    changeSetId = 'standalone',
    approval?: DelegatedEditApproval,
    journal?: ChangeCheckpointJournal
  ): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(edit.uri);
    let checkpoint: ChangeCheckpoint | undefined;
    let mutationStarted = false;
    try {
      await approval?.verifyScope?.();
      await this.assertCommonPreconditions(uri, edit, approval);
      const snapshot = edit.kind === 'text_patch_v1'
        ? await this.readPatchSnapshot(uri, edit)
        : await this.readSnapshotForEdit(uri, edit);
      this.assertActionMatchesSnapshot(edit, snapshot);
      this.assertBaselineMatches(edit, snapshot);
      checkpoint = await this.createPreparedCheckpoint(edit, changeSetId, snapshot, approval);
      await journal?.persist(checkpoint);

      this.checkApproval(edit, approval);
      this.assertNoDirtyOpenEditor(uri, edit.label);
      checkpoint.state = 'applying';
      checkpoint.operation = 'apply';
      checkpoint.applyingAt = new Date().toISOString();
      await journal?.persist(checkpoint);
      if (await this.classifyCheckpoint(checkpoint) !== 'base') {
        throw new Error(this.t('cannotApplyChangedDraftTarget', { label: edit.label }));
      }
      await this.assertCommonPreconditions(uri, edit, approval);
      await approval?.verifyScope?.();
      this.checkApproval(edit, approval);
      mutationStarted = true;

      await this.applyMutation(edit, uri);
      await this.verifyApplied(edit, checkpoint);

      checkpoint.state = 'applied';
      checkpoint.appliedAt = new Date().toISOString();
      await journal?.persist(checkpoint);
      return checkpoint;
    } catch (error) {
      if (checkpoint) {
        checkpoint.state = mutationStarted ? 'uncertain' : 'interrupted';
        await journal?.persist(checkpoint).catch(() => undefined);
      }
      throw new SafeFileEditError(error instanceof Error ? error.message : String(error), checkpoint);
    }
  }

  public async revertCheckpoint(checkpoint: ChangeCheckpoint, journal?: ChangeCheckpointJournal, skillScaffold = false): Promise<ChangeCheckpoint> {
    const uri = vscode.Uri.parse(checkpoint.uri);
    await this.assertCheckpointTarget(uri, checkpoint, skillScaffold && !checkpoint.originalExists);
    const state = await this.classifyCheckpoint(checkpoint);
    if (state !== 'result') throw new Error(this.t('cannotRevertChangedAgentFile', { label: checkpoint.label }));

    checkpoint.state = 'applying';
    checkpoint.operation = 'revert';
    checkpoint.applyingAt = new Date().toISOString();
    await journal?.persist(checkpoint);
    try {
      if (checkpoint.draftKind === 'text_patch_v1' && checkpoint.inversePatch) {
        await this.writePatchedFile(uri, checkpoint.inversePatch);
      } else if (checkpoint.draftKind === 'move_v1' && checkpoint.targetUri) {
        await this.moveUri(vscode.Uri.parse(checkpoint.targetUri), uri);
      } else if (checkpoint.originalExists) {
        const original = checkpoint.originalBlobHash && this.artifactStore
          ? await this.artifactStore.getBlob(checkpoint.originalBlobHash)
          : typeof checkpoint.originalText === 'string' ? this.encoder.encode(checkpoint.originalText)
            : (() => { throw new Error('The rollback content is unavailable.'); })();
        if (original.byteLength !== checkpoint.originalSizeBytes || hashBytes(original) !== checkpoint.originalTextHash) {
          throw new Error('The rollback content does not match its saved byte identity.');
        }
        const expectedResult = checkpoint.appliedExists
          && checkpoint.appliedTextHash && checkpoint.appliedSizeBytes !== undefined
          ? { sha256: checkpoint.appliedTextHash, sizeBytes: checkpoint.appliedSizeBytes }
          : undefined;
        await this.writeBytes(uri, original, true, expectedResult, !checkpoint.appliedExists);
      } else if ((await this.readIdentity(uri)).exists) {
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        await this.closeOpenTabs(uri);
      }
      const reverted = await this.classifyCheckpoint(checkpoint);
      if (reverted !== 'base') throw new Error('Revert read-back hash verification failed.');
      checkpoint.state = 'reverted';
      checkpoint.revertedAt = new Date().toISOString();
      await journal?.persist(checkpoint);
      return checkpoint;
    } catch (error) {
      checkpoint.state = 'uncertain';
      await journal?.persist(checkpoint).catch(() => undefined);
      throw new SafeFileEditError(error instanceof Error ? error.message : String(error), checkpoint);
    }
  }

  /** Reconcile prepared/applying journals after restart without replaying a mutation. */
  public async classifyCheckpoint(checkpoint: ChangeCheckpoint): Promise<'base' | 'result' | 'unknown'> {
    if (checkpoint.version !== 2 || checkpoint.hashMode !== 'utf8_bytes'
      || !['full_text_v1', 'text_patch_v1', 'delete_v1', 'move_v1'].includes(checkpoint.draftKind)
      || checkpoint.originalExists && !validCheckpointIdentity(checkpoint.originalTextHash, checkpoint.originalSizeBytes)
      || (checkpoint.appliedExists || checkpoint.draftKind === 'move_v1')
        && !validCheckpointIdentity(checkpoint.appliedTextHash, checkpoint.appliedSizeBytes)) return 'unknown';
    const source = vscode.Uri.parse(checkpoint.uri);
    if (checkpoint.draftKind === 'move_v1' && checkpoint.targetUri) {
      const target = vscode.Uri.parse(checkpoint.targetUri);
      const [sourceState, targetState] = await Promise.all([this.readIdentity(source), this.readIdentity(target)]);
      if (sourceState.exists && sourceState.identity?.sha256 === checkpoint.originalTextHash
        && sourceState.identity?.sizeBytes === checkpoint.originalSizeBytes && !targetState.exists) return 'base';
      if (!sourceState.exists && targetState.exists && targetState.identity?.sha256 === checkpoint.appliedTextHash
        && targetState.identity?.sizeBytes === checkpoint.appliedSizeBytes) return 'result';
      return 'unknown';
    }
    const current = await this.readIdentity(source);
    if (!checkpoint.appliedExists && !current.exists) return 'result';
    if (!checkpoint.originalExists && !current.exists) return 'base';
    if (current.exists) {
      const currentHash = current.identity?.sha256;
      const currentSize = current.identity?.sizeBytes;
      if (checkpoint.appliedExists && currentHash === checkpoint.appliedTextHash
        && checkpoint.appliedSizeBytes === currentSize) return 'result';
      if (checkpoint.originalExists && currentHash === checkpoint.originalTextHash
        && checkpoint.originalSizeBytes === currentSize) return 'base';
    }
    return 'unknown';
  }

  public async matchesAppliedFileIdentity(uri: vscode.Uri, expected: FileContentIdentity, observedStat: string): Promise<boolean> {
    if (uri.scheme !== 'file') return false;
    const current = await hashLocalFile(uri.fsPath, { stat: observedStat, sizeBytes: expected.sizeBytes });
    return current.sha256 === expected.sha256 && current.sizeBytes === expected.sizeBytes;
  }

  private async assertCommonPreconditions(uri: vscode.Uri, edit: DraftEdit, approval?: DelegatedEditApproval): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
    this.checkApproval(edit, approval);
    const skillScaffold = approval?.skillScaffold === true && edit.kind === 'full_text_v1'
      && edit.action === 'create' && !!vscode.workspace.getWorkspaceFolder(uri);
    this.assertWorkspaceTarget(uri, edit.label, approval?.authorizedUri, skillScaffold);
    if (edit.kind === 'move_v1') {
      const target = vscode.Uri.parse(edit.targetUri);
      this.assertWorkspaceTarget(target, edit.label, approval?.authorizedUris?.includes(target.toString()) ? target.toString() : undefined);
      const metadata = await inspectDraftEditTarget(target, true);
      this.assertNoDirtyOpenEditor(target, edit.label, metadata.canonical);
      const exists = target.scheme === 'file' ? !!metadata.fileIdentity : (await this.readIdentity(target)).exists;
      if (exists) throw new Error(this.t('cannotApplyCreatedFileExists', { label: edit.label }));
    }
    const metadata = await inspectDraftEditTarget(uri, edit.action === 'create', skillScaffold);
    this.assertNoDirtyOpenEditor(uri, edit.label, metadata.canonical);
    await this.assertSafeDraftOutput(edit);
  }

  private async assertCheckpointTarget(uri: vscode.Uri, checkpoint: ChangeCheckpoint, skillScaffold: boolean): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error('DraftEdit revert requires a trusted workspace.');
    this.assertWorkspaceTarget(uri, checkpoint.label, checkpoint.authorizedExternalUri, skillScaffold);
    const source = await inspectDraftEditTarget(uri, true, skillScaffold);
    this.assertNoDirtyOpenEditor(uri, checkpoint.label, source.canonical);
    if (checkpoint.targetUri) {
      const target = vscode.Uri.parse(checkpoint.targetUri);
      this.assertWorkspaceTarget(target, checkpoint.label, checkpoint.authorizedExternalUri);
      const metadata = await inspectDraftEditTarget(target, true);
      this.assertNoDirtyOpenEditor(target, checkpoint.label, metadata.canonical);
    }
  }

  private checkApproval(edit: DraftEdit, approval?: DelegatedEditApproval): void {
    if (approval && (!vscode.workspace.isTrusted || approval.authorizedUri !== edit.uri || !approval.isAuthorized())) {
      throw new Error('Delegated file approval was cancelled or revoked.');
    }
  }

  private async readPatchSnapshot(uri: vscode.Uri, edit: Extract<DraftEdit, { kind: 'text_patch_v1' }>): Promise<FileSnapshot> {
    const current = await this.readIdentity(uri, edit.patch.base.sizeBytes, true);
    return { exists: current.exists, byteIdentity: current.identity };
  }

  private async readSnapshotForEdit(uri: vscode.Uri, edit: DraftEdit): Promise<FileSnapshot> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type !== vscode.FileType.File) throw new Error(this.t('draftTargetNotFile', { label: edit.label }));
      // Full replacements use the rollback-backup quota; maxFileBytes only
      // limits model/context reads.
      const limit = getConfiguredPatchSettings().maxBackupBytes;
      if (stat.size > limit) {
        throw new Error(this.t(edit.action === 'delete' ? 'cannotDeleteOversizedFile' : 'cannotWriteOversizedFile', { label: edit.label, limit: formatBytes(limit) }));
      }
      if (edit.action === 'delete' && shouldSkipTextUri(uri)) throw new Error(this.t('cannotDeleteUnreadableFile', { label: edit.label }));
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > limit) throw new Error(this.t('cannotWriteOversizedFile', { label: edit.label, limit: formatBytes(limit) }));
      const text = decodeRollbackSafeUtf8Text(bytes);
      if (text === undefined) throw new Error(this.t(edit.action === 'delete' ? 'cannotDeleteUnreadableFile' : 'cannotWriteUnreadableFile', { label: edit.label }));
      return {
        exists: true,
        bytes,
        text,
        byteIdentity: { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength }
      };
    } catch (error) {
      if (isFileNotFoundError(error)) return { exists: false };
      throw error;
    }
  }

  private assertActionMatchesSnapshot(edit: DraftEdit, snapshot: FileSnapshot): void {
    if (edit.action === 'create' && snapshot.exists) throw new Error(this.t('cannotApplyCreatedFileExists', { label: edit.label }));
    if (edit.action !== 'create' && !snapshot.exists) throw new Error(this.t('cannotApplyMissingDraftTarget', { label: edit.label }));
  }

  private assertBaselineMatches(edit: DraftEdit, snapshot: FileSnapshot): void {
    const base = getDraftEditBase(edit);
    if (!base) return;
    const actualHash = snapshot.byteIdentity?.sha256;
    const sizeChanged = base.sizeBytes >= 0 && base.sizeBytes !== snapshot.byteIdentity?.sizeBytes;
    const hashChanged = Boolean(base.sha256) && base.sha256 !== actualHash;
    if (sizeChanged || hashChanged) {
      throw new Error(this.t(edit.action === 'delete' ? 'cannotApplyChangedDeleteTarget' : 'cannotApplyChangedDraftTarget', { label: edit.label }));
    }
  }

  private async assertSafeDraftOutput(edit: DraftEdit, scanSensitive = false): Promise<void> {
    if (edit.kind === 'text_patch_v1') {
      validateCanonicalTextPatch(edit.patch, configuredTextPatchLimits());
      if (edit.patch.targetUri !== edit.uri) throw new Error('Patch target URI does not match its DraftEdit.');
      if (scanSensitive && edit.patch.hunks.some(hunk => findSensitiveEvidence(hunk.oldText) || findSensitiveEvidence(hunk.newText))) {
        throw new Error('The proposed edit contains suspected credential material. / 草稿编辑包含疑似凭据材料。');
      }
      return;
    }
    if (edit.kind === 'move_v1') {
      if (edit.sourceUri !== edit.uri || edit.targetUri === edit.uri) throw new Error('DraftEdit move endpoints do not match the proposed operation.');
      return;
    }
    if (edit.action === 'delete') return;
    const bytes = await this.resolveDraftOutputBytes(edit);
    const text = decodeRollbackSafeUtf8Text(bytes);
    if (text === undefined) throw new Error(this.t('cannotWriteUnreadableFile', { label: edit.label }));
    const limit = getConfiguredPatchSettings().maxBackupBytes;
    if (bytes.byteLength > limit) throw new Error(this.t('cannotWriteOversizedFile', { label: edit.label, limit: formatBytes(limit) }));
    const result = getDraftEditResult(edit);
    if (result && (result.sizeBytes !== bytes.byteLength || result.sha256 !== hashBytes(bytes))) {
      throw new Error('Full-text DraftEdit result hash does not match its content.');
    }
    if (scanSensitive && findSensitiveEvidence(text)) {
      throw new Error('The proposed edit contains suspected credential material. / 草稿编辑包含疑似凭据材料。');
    }
  }

  private async createPreparedCheckpoint(
    edit: DraftEdit,
    changeSetId: string,
    original: FileSnapshot,
    approval?: DelegatedEditApproval
  ): Promise<ChangeCheckpoint> {
    const now = new Date().toISOString();
    const kind = getDraftEditKind(edit);
    const result = getDraftEditResult(edit);
    let originalBlobHash: string | undefined;
    let originalText = original.text;
    if (original.exists && kind !== 'text_patch_v1' && kind !== 'move_v1' && original.bytes && this.artifactStore) {
      originalBlobHash = await this.artifactStore.putBlob(original.bytes);
      originalText = undefined;
    }
    return {
      version: 2,
      authorizedExternalUri: approval && !vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(edit.uri)) ? edit.uri : undefined,
      id: randomUUID(), changeSetId, editId: edit.id, uri: edit.uri,
      targetUri: edit.kind === 'move_v1' ? edit.targetUri : undefined,
      label: edit.label, action: edit.action, draftKind: kind, state: 'prepared', operation: 'apply',
      originalExists: original.exists, originalText,
      originalTextHash: original.byteIdentity?.sha256,
      originalSizeBytes: original.byteIdentity?.sizeBytes, originalBlobHash,
      hashMode: 'utf8_bytes',
      appliedExists: edit.action !== 'delete' && edit.kind !== 'move_v1',
      appliedTextHash: edit.kind === 'move_v1' ? edit.base.sha256 : result?.sha256,
      appliedSizeBytes: edit.kind === 'move_v1' ? edit.base.sizeBytes : result?.sizeBytes,
      inversePatch: edit.kind === 'text_patch_v1' ? createInverseTextPatch(edit.patch) : undefined,
      createdAt: now, preparedAt: now
    };
  }

  private async applyMutation(edit: DraftEdit, uri: vscode.Uri): Promise<void> {
    if (edit.action === 'delete') {
      await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
      await this.closeOpenTabs(uri);
      return;
    }
    if (edit.kind === 'move_v1') {
      await this.moveUri(uri, vscode.Uri.parse(edit.targetUri));
      await this.closeOpenTabs(uri);
      return;
    }
    if (edit.kind === 'text_patch_v1') {
      await this.writePatchedFile(uri, edit.patch);
      return;
    }
    await this.writeBytes(
      uri,
      await this.resolveDraftOutputBytes(edit),
      edit.action === 'create',
      getDraftEditBase(edit),
      edit.action === 'create'
    );
  }

  private async resolveDraftOutputBytes(edit: DraftEdit): Promise<Uint8Array> {
    if (edit.kind === 'full_text_v1' && edit.contentBlobHash) {
      if (!this.artifactStore) throw new Error('Content-addressed DraftEdit blob store is unavailable.');
      const bytes = await this.artifactStore.getBlob(edit.contentBlobHash);
      if (bytes.byteLength !== edit.result.sizeBytes || hashBytes(bytes) !== edit.result.sha256) {
        throw new Error('Content-addressed DraftEdit blob does not match its result identity.');
      }
      return bytes;
    }
    return this.encoder.encode(getDraftEditFullText(edit) ?? '');
  }

  private async verifyApplied(edit: DraftEdit, checkpoint: ChangeCheckpoint): Promise<void> {
    if (edit.action === 'delete') {
      if ((await this.readIdentity(vscode.Uri.parse(edit.uri))).exists) throw new Error('Delete verification failed: target still exists.');
      return;
    }
    if (edit.kind === 'move_v1') {
      if (await this.classifyCheckpoint(checkpoint) !== 'result') throw new Error('Move verification failed.');
      return;
    }
    const actual = await this.readIdentity(vscode.Uri.parse(edit.uri));
    const expected = getDraftEditResult(edit);
    if (!actual.exists || !expected || actual.identity?.sha256 !== expected.sha256 || actual.identity.sizeBytes !== expected.sizeBytes) {
      throw new Error('Write read-back hash verification failed.');
    }
  }

  private async writePatchedFile(uri: vscode.Uri, patch: TextPatchV1): Promise<void> {
    if (uri.scheme === 'file') {
      await this.writeLocalPatchAtomic(uri.fsPath, patch);
      await this.refreshActiveTextTab(uri);
      return;
    }
    const limit = getConfiguredPatchSettings().maxProviderBufferBytes;
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.size > limit) throw new Error(`Non-file patch target exceeds the configured ${formatBytes(limit)} fallback buffer.`);
    const current = await vscode.workspace.fs.readFile(uri);
    if (current.byteLength > limit) throw new Error(`Non-file patch target exceeds the configured ${formatBytes(limit)} fallback buffer.`);
    await vscode.workspace.fs.writeFile(uri, applyTextPatchToBytes(current, patch));
    await this.refreshActiveTextTab(uri);
  }

  private async writeLocalPatchAtomic(targetPath: string, patch: TextPatchV1): Promise<void> {
    validateCanonicalTextPatch(patch, configuredTextPatchLimits());
    const current = await hashLocalFile(targetPath);
    this.assertByteIdentity(patch.base, { exists: true, identity: current }, targetPath);
    const source = await fs.open(targetPath, 'r');
    const metadata = await source.stat();
    const temporaryPath = path.join(path.dirname(targetPath), `.keepseek-${randomUUID()}.tmp`);
    let temporary: fs.FileHandle | undefined;
    try {
      temporary = await fs.open(temporaryPath, 'wx', metadata.mode);
      const resultHash = createHash('sha256');
      let outputSize = 0;
      let cursor = 0;
      for (const hunk of patch.hunks) {
        outputSize += await copyFileRange(source, temporary, cursor, hunk.startByte, resultHash);
        const old = Buffer.alloc(hunk.oldSizeBytes);
        if (old.byteLength) await readExactly(source, old, hunk.startByte);
        if (hashBytes(old) !== hunk.oldSha256) throw new Error('Patch source hunk changed during apply.');
        const replacement = Buffer.from(this.encoder.encode(hunk.newText));
        await writeAll(temporary, replacement);
        resultHash.update(replacement);
        outputSize += replacement.byteLength;
        cursor = hunk.endByte;
      }
      outputSize += await copyFileRange(source, temporary, cursor, metadata.size, resultHash);
      await temporary.sync();
      if (outputSize !== patch.result.sizeBytes || resultHash.digest('hex') !== patch.result.sha256) {
        throw new Error('Generated patch result failed hash verification before replacement.');
      }
      await temporary.chmod(metadata.mode);
      await temporary.close();
      temporary = undefined;
      const beforeRename = await hashLocalFile(targetPath);
      if (beforeRename.sha256 !== patch.base.sha256 || beforeRename.sizeBytes !== patch.base.sizeBytes) {
        throw new Error('Patch base changed immediately before atomic replacement.');
      }
      await fs.rename(temporaryPath, targetPath);
      await fsyncDirectory(path.dirname(targetPath));
    } finally {
      await temporary?.close().catch(() => undefined);
      await source.close().catch(() => undefined);
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async writeBytes(
    uri: vscode.Uri,
    bytes: Uint8Array,
    createParent: boolean,
    expectedBase?: FileContentIdentity,
    mustNotExist = false
  ): Promise<void> {
    if (uri.scheme === 'file') {
      if (createParent) await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
      const mode = await fs.stat(uri.fsPath).then((stat) => stat.mode).catch(() => 0o600);
      const temporaryPath = path.join(path.dirname(uri.fsPath), `.keepseek-${randomUUID()}.tmp`);
      const handle = await fs.open(temporaryPath, 'wx', mode);
      try {
        await writeAll(handle, bytes);
        await handle.sync();
        await handle.chmod(mode);
      } finally {
        await handle.close();
      }
      try {
        if (mustNotExist) {
          await fs.link(temporaryPath, uri.fsPath);
          await fs.unlink(temporaryPath);
        } else {
          if (expectedBase) {
            const current = await hashLocalFile(uri.fsPath);
            if (current.sha256 !== expectedBase.sha256 || current.sizeBytes !== expectedBase.sizeBytes) {
              throw new Error('Full-text DraftEdit base changed immediately before atomic replacement.');
            }
          }
          await fs.rename(temporaryPath, uri.fsPath);
        }
        await fsyncDirectory(path.dirname(uri.fsPath));
      } finally {
        await fs.unlink(temporaryPath).catch(() => undefined);
      }
      await this.refreshActiveTextTab(uri);
      return;
    }
    if (createParent) await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, bytes);
    await this.refreshActiveTextTab(uri);
  }

  private async moveUri(source: vscode.Uri, target: vscode.Uri): Promise<void> {
    if (source.scheme === 'file' && target.scheme === 'file') {
      await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
      await fs.copyFile(source.fsPath, target.fsPath, fsConstants.COPYFILE_EXCL);
      // Windows fsync needs write access; POSIX permits a read-only handle and
      // must still support moving files whose copied mode is read-only.
      const targetHandle = await fs.open(target.fsPath, process.platform === 'win32' ? 'r+' : 'r');
      try { await targetHandle.sync(); } finally { await targetHandle.close(); }
      await fs.unlink(source.fsPath);
      await Promise.all([fsyncDirectory(path.dirname(source.fsPath)), fsyncDirectory(path.dirname(target.fsPath))]);
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, '..'));
    await vscode.workspace.fs.rename(source, target, { overwrite: false });
  }

  private assertByteIdentity(expected: FileContentIdentity, current: { exists: boolean; identity?: FileContentIdentity }, label: string): void {
    if (!current.exists || !current.identity || current.identity.sha256 !== expected.sha256 || current.identity.sizeBytes !== expected.sizeBytes) {
      throw new Error(this.t('cannotApplyChangedDraftTarget', { label }));
    }
  }

  private async readIdentity(uri: vscode.Uri, expectedSize?: number, patchTarget = false): Promise<{ exists: boolean; identity?: FileContentIdentity }> {
    try {
      if (uri.scheme === 'file') return { exists: true, identity: await hashLocalFile(uri.fsPath) };
      const stat = await vscode.workspace.fs.stat(uri);
      const limit = getConfiguredPatchSettings().maxProviderBufferBytes;
      if (patchTarget && (stat.size > limit || (expectedSize !== undefined && expectedSize > limit))) {
        throw new Error(`Non-file patch target exceeds the configured ${formatBytes(limit)} fallback buffer.`);
      }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (patchTarget && bytes.byteLength > limit) throw new Error(`Non-file patch target exceeds the configured ${formatBytes(limit)} fallback buffer.`);
      return { exists: true, identity: { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength } };
    } catch (error) {
      if (isFileNotFoundError(error)) return { exists: false };
      throw error;
    }
  }


  private assertNoDirtyOpenEditor(uri: vscode.Uri, label: string, canonical?: string): void {
    assertCleanDraftEditTarget(uri, this.t('cannotApplyDirtyDraftEdit', { label }), canonical);
  }

  private assertWorkspaceTarget(uri: vscode.Uri, label: string, authorizedUri?: string, skillScaffold = false): void {
    assertOperationPath(uri.fsPath, true, skillScaffold);
    if (authorizedUri === uri.toString() && vscode.workspace.isTrusted) return;
    if (vscode.workspace.getWorkspaceFolder(uri)) return;
    throw new Error(this.t('cannotApplyOutsideWorkspace', { label }));
  }

  private findOpenTextTabs(uri: vscode.Uri): vscode.Tab[] {
    return this.findOpenTabs(uri).filter((tab) => tab.input instanceof vscode.TabInputText);
  }

  private async refreshActiveTextTab(uri: vscode.Uri): Promise<void> {
    if (!this.findOpenTextTabs(uri).some((tab) => tab.isActive)) return;
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }

  private async closeOpenTabs(uri: vscode.Uri): Promise<void> {
    const tabs = this.findOpenTabs(uri);
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  private findOpenTabs(uri: vscode.Uri): vscode.Tab[] {
    return findDraftEditTargetTabs(target => target.toString() === uri.toString());
  }
}

async function hashLocalFile(filePath: string, observed?: { stat: string; sizeBytes: number }): Promise<FileContentIdentity> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const buffer = Buffer.allocUnsafe(256 * 1024);
  const changed = () => new Error('Applied file changed during read-back. / 已落盘文件在核验期间发生变化。');
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error('DraftEdit target is not a regular file.');
    if (observed && fileIdentity(before) !== observed.stat) throw changed();
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (!bytesRead) break;
      sizeBytes += bytesRead;
      if (observed && sizeBytes > observed.sizeBytes) throw changed();
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (observed && (fileIdentity(await handle.stat()) !== observed.stat
      || fileIdentity(await fs.lstat(filePath)) !== observed.stat
      || path.relative(filePath, await fs.realpath(filePath)) !== '')) throw changed();
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

async function copyFileRange(
  source: fs.FileHandle,
  target: fs.FileHandle,
  start: number,
  end: number,
  hash: ReturnType<typeof createHash>
): Promise<number> {
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let position = start;
  while (position < end) {
    const requested = Math.min(buffer.byteLength, end - position);
    const { bytesRead } = await source.read(buffer, 0, requested, position);
    if (!bytesRead) throw new Error('Patch source ended while streaming unchanged bytes.');
    const chunk = buffer.subarray(0, bytesRead);
    await writeAll(target, chunk);
    hash.update(chunk);
    position += bytesRead;
  }
  return end - start;
}

async function readExactly(handle: fs.FileHandle, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.read(buffer, offset, buffer.byteLength - offset, position + offset);
    if (!result.bytesRead) throw new Error('Patch source ended inside a hunk.');
    offset += result.bytesRead;
  }
}

async function writeAll(handle: fs.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (!result.bytesWritten) throw new Error('Patch temporary file write made no progress.');
    offset += result.bytesWritten;
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r').catch(() => undefined);
  if (!handle) return;
  try { await handle.sync(); } catch { /* Some platforms do not fsync directories. */ }
  finally { await handle.close(); }
}

function configuredTextPatchLimits() {
  const settings = getConfiguredPatchSettings();
  return {
    maxPatchBytes: settings.maxPayloadBytes,
    maxHunks: settings.maxHunks,
    maxChangedBytes: settings.maxChangedBytes,
    maxInlineBytes: settings.maxInlineBytes
  };
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) return error.code === 'FileNotFound';
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'ENOENT' || code === 'FileNotFound';
}

function validCheckpointIdentity(hash: string | undefined, sizeBytes: number | undefined): boolean {
  return typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash) && Number.isSafeInteger(sizeBytes) && Number(sizeBytes) >= 0;
}
