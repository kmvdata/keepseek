import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangeCheckpoint, DraftEdit } from '../shared/types';
import { getConfiguredPatchSettings } from '../shared/config';
import { getDraftEditFullText } from './draftEdit';
import { applyTextPatchToBytes, renderPatchReview } from './textPatch';
import { ChangeArtifactStore } from './changeArtifactStore';
import { getConfiguredKeepseekLanguage, localize } from '../shared/i18n';
import { hashBytes } from './textPatch';
import { IMAGE_MAX_BYTES, validateImageBytes, verifyImageContainer } from '../images/imageValidation';
import { isValidBinaryImageDraft } from './binaryImageDraft';
import { BinaryImageDraftError } from './binaryImageErrors';

const DRAFT_DIFF_SCHEME = 'keepseek-draft';
const IMAGE_REVIEW_PROJECTION_QUOTA = 128 * 1024 * 1024;

export class DraftDiffService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;
  private readonly artifactStore?: ChangeArtifactStore;
  private readonly imagePreviewRoot?: vscode.Uri;
  private readonly imagePanels = new Set<vscode.WebviewPanel>();
  private imagePreviewCleanup: Promise<void> = Promise.resolve();
  private imagePreviewQueue: Promise<void> = Promise.resolve();
  private disposed = false;

  public constructor(globalStorageUri?: vscode.Uri) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DRAFT_DIFF_SCHEME, this);
    this.artifactStore = globalStorageUri ? new ChangeArtifactStore(globalStorageUri) : undefined;
    this.imagePreviewRoot = globalStorageUri ? vscode.Uri.joinPath(globalStorageUri, 'image-change-previews') : undefined;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  public async openDiff(edit: DraftEdit, checkpoint?: ChangeCheckpoint): Promise<void> {
    if (this.disposed) throw edit.kind === 'binary_image_v1' ? new BinaryImageDraftError('imageWriteFailed') : new Error('Draft preview service is disposed.');
    if (edit.kind === 'binary_image_v1') {
      const operation = this.imagePreviewQueue.then(async () => await this.openImagePreview(edit, checkpoint)).catch((error: unknown) => {
        throw error instanceof BinaryImageDraftError ? error : new BinaryImageDraftError('imageWriteFailed', error instanceof Error ? error.message : undefined);
      });
      this.imagePreviewQueue = operation.catch(() => undefined);
      await operation;
      return;
    }
    if (edit.kind === 'text_patch_v1') {
      await this.openPatchDiff(edit, checkpoint);
      return;
    }
    const originalText = checkpoint?.originalExists
      ? await this.readCheckpointOriginalText(checkpoint)
      : checkpoint
        ? ''
        : await this.readCurrentText(vscode.Uri.parse(edit.uri));
    const proposedText = edit.action === 'delete' || edit.kind === 'move_v1'
      ? ''
      : getDraftEditFullText(edit)
        ?? (edit.kind === 'full_text_v1' && edit.contentBlobHash && this.artifactStore
          ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(await this.artifactStore.getBlob(edit.contentBlobHash))
          : '');
    await this.openVirtualDiff(edit.label, originalText, proposedText);
  }

  private async openImagePreview(edit: Extract<DraftEdit, { kind: 'binary_image_v1' }>, checkpoint?: ChangeCheckpoint): Promise<void> {
    if (!this.artifactStore || !this.imagePreviewRoot) throw new BinaryImageDraftError('imageWriteFailed');
    if (!isValidBinaryImageDraft(edit)) throw new BinaryImageDraftError('imageWriteInvalidMetadata');
    const proposed = await this.artifactStore.getBlob(edit.contentBlobHash);
    const metadata = validateImageBytes(proposed, edit.mimeType);
    await verifyImageContainer(proposed, metadata);
    if (hashBytes(proposed) !== edit.result.sha256 || proposed.byteLength !== edit.result.sizeBytes
      || metadata.width !== edit.width || metadata.height !== edit.height) {
      throw new BinaryImageDraftError('imageWriteInvalidImage');
    }
    const language = getConfiguredKeepseekLanguage();
    const t = (key: string) => localize(language, key);
    let previous: { bytes: Uint8Array; extension: string } | undefined;
    let beforeReason = t('binaryImageNoBefore');
    if (edit.action === 'modify') {
      const limit = getConfiguredPatchSettings().maxBackupBytes;
      let original: Uint8Array | undefined;
      if (checkpoint?.originalBlobHash) {
        try { original = await this.artifactStore.getBlob(checkpoint.originalBlobHash); }
        catch { beforeReason = t('binaryImageBeforeUnavailable'); }
      } else {
        // A changed file must not silently become the image the user is asked
        // to approve. Bound the read even before Apply's hard preflight runs.
        const target = vscode.Uri.parse(edit.uri);
        const stat = await vscode.workspace.fs.stat(target);
        if (stat.type !== vscode.FileType.File || stat.size > limit || stat.size !== edit.base?.sizeBytes) {
          throw new BinaryImageDraftError('imageWriteConflict');
        }
        original = await vscode.workspace.fs.readFile(target);
      }
      if (original && (original.byteLength > limit || original.byteLength !== edit.base?.sizeBytes || hashBytes(original) !== edit.base?.sha256)) {
        throw new BinaryImageDraftError('imageWriteConflict');
      }
      try {
        if (original) {
          const previousMetadata = validateImageBytes(original, undefined, Math.min(limit, IMAGE_MAX_BYTES));
          await verifyImageContainer(original, previousMetadata);
          previous = { bytes: original, extension: previousMetadata.mime === 'image/png' ? 'png' : previousMetadata.mime === 'image/jpeg' ? 'jpg' : 'webp' };
        }
      } catch {
        beforeReason = t('binaryImageBeforeUnavailable');
      }
    }
    // Keep at most one image review projection per service; closing it revokes
    // the sole resource root and releases both copies before another is made.
    for (const existing of this.imagePanels) existing.dispose();
    await this.imagePreviewCleanup;
    if (this.disposed) throw new BinaryImageDraftError('imageWriteFailed');
    await this.assertImagePreviewQuota(proposed.byteLength + (previous?.bytes.byteLength ?? 0));
    const root = vscode.Uri.joinPath(this.imagePreviewRoot, randomUUID());
    const extension = edit.mimeType === 'image/png' ? 'png' : edit.mimeType === 'image/jpeg' ? 'jpg' : 'webp';
    const after = vscode.Uri.joinPath(root, `proposed.${extension}`);
    const before = previous ? vscode.Uri.joinPath(root, `previous.${previous.extension}`) : undefined;
    let panel: vscode.WebviewPanel;
    try {
      await vscode.workspace.fs.createDirectory(root);
      await vscode.workspace.fs.writeFile(after, proposed);
      if (hashBytes(await vscode.workspace.fs.readFile(after)) !== edit.result.sha256) throw new BinaryImageDraftError('imageWriteInvalidImage');
      if (before && previous) await vscode.workspace.fs.writeFile(before, previous.bytes);
      if (before && previous && hashBytes(await vscode.workspace.fs.readFile(before)) !== hashBytes(previous.bytes)) throw new BinaryImageDraftError('imageWriteInvalidImage');
      panel = vscode.window.createWebviewPanel('keepseek.imageChangePreview', t('binaryImagePreviewTitle'), vscode.ViewColumn.Active, {
        enableScripts: false, localResourceRoots: [root]
      });
    } catch (error) {
      await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }).then(undefined, () => undefined);
      throw error;
    }
    this.imagePanels.add(panel);
    panel.onDidDispose(() => {
      this.imagePanels.delete(panel);
      this.imagePreviewCleanup = this.imagePreviewCleanup.then(async () => {
        await vscode.workspace.fs.delete(root, { recursive: true, useTrash: false }).then(undefined, () => undefined);
      });
    });
    const escape = (value: string) => value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
    const afterUri = escape(panel.webview.asWebviewUri(after).toString());
    const beforeImage = before
      ? `<img src="${escape(panel.webview.asWebviewUri(before).toString())}" alt="${escape(t('binaryImageBefore'))}">`
      : `<p>${escape(beforeReason)}</p>`;
    panel.webview.html = `<!DOCTYPE html><html lang="${language === 'zh-CN' ? 'zh-CN' : 'en'}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src 'unsafe-inline';"><style>body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px}img{max-width:100%;height:auto;object-fit:contain;max-height:70vh}section{margin:20px 0}code{overflow-wrap:anywhere}details{margin-top:20px}</style></head><body><h1>${escape(t('binaryImagePreviewTitle'))}</h1><p><code>${escape(edit.uri)}</code></p><p>${metadata.width} × ${metadata.height} · ${proposed.byteLength} bytes · ${escape(edit.mimeType)}</p><p>${escape(t('binaryImageVisualReview'))}</p><section><h2>${escape(t('binaryImageAfter'))}</h2><img src="${afterUri}" alt="${escape(edit.reason || t('binaryImageAfter'))}"></section><section><h2>${escape(t('binaryImageBefore'))}</h2>${beforeImage}</section><details><summary>SHA-256</summary><code>${escape(edit.result.sha256)}</code></details></body></html>`;
  }

  private async assertImagePreviewQuota(additionalBytes: number): Promise<void> {
    if (!this.imagePreviewRoot) throw new BinaryImageDraftError('imageWriteFailed');
    let directories: Array<[string, vscode.FileType]>;
    try { directories = await vscode.workspace.fs.readDirectory(this.imagePreviewRoot); }
    catch (error) {
      if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'FileNotFound'].includes(String(error.code))) return;
      throw error;
    }
    let total = additionalBytes;
    for (const [name, type] of directories) {
      // Crash leftovers remain private and count toward a fixed quota. Never
      // delete another live host's projections or follow unexpected links.
      if (type !== vscode.FileType.Directory) throw new BinaryImageDraftError('imageWriteFailed', 'Unexpected image preview storage entry.');
      const directory = vscode.Uri.joinPath(this.imagePreviewRoot, name);
      for (const [fileName, fileType] of await vscode.workspace.fs.readDirectory(directory)) {
        if (fileType !== vscode.FileType.File) throw new BinaryImageDraftError('imageWriteFailed', 'Unexpected nested image preview storage entry.');
        total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(directory, fileName))).size;
        if (total > IMAGE_REVIEW_PROJECTION_QUOTA) throw new BinaryImageDraftError('imageWritePreviewQuota');
      }
    }
  }

  private async openPatchDiff(edit: Extract<DraftEdit, { kind: 'text_patch_v1' }>, checkpoint?: ChangeCheckpoint): Promise<void> {
    const maxDiffBytes = getConfiguredPatchSettings().maxDiffBytes;
    if (Math.max(edit.patch.base.sizeBytes, edit.patch.result.sizeBytes) > maxDiffBytes) {
      const review = [
        `${edit.label} — KeepSeek hunk-only review`,
        `base sha256 ${edit.patch.base.sha256} (${edit.patch.base.sizeBytes} bytes)`,
        `result sha256 ${edit.patch.result.sha256} (${edit.patch.result.sizeBytes} bytes)`,
        '',
        renderPatchReview(edit.patch)
      ].join('\n');
      await this.openVirtualDiff(edit.label, '', review);
      return;
    }
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(edit.uri));
    let before: Uint8Array;
    let after: Uint8Array;
    if (checkpoint?.state === 'applied' && checkpoint.inversePatch) {
      after = bytes;
      before = applyTextPatchToBytes(bytes, checkpoint.inversePatch);
    } else {
      before = bytes;
      after = applyTextPatchToBytes(bytes, edit.patch);
    }
    await this.openVirtualDiff(edit.label, new TextDecoder('utf-8', { ignoreBOM: true }).decode(before),
      new TextDecoder('utf-8', { ignoreBOM: true }).decode(after));
  }

  private async openVirtualDiff(label: string, originalText: string, proposedText: string): Promise<void> {
    const key = randomUUID();
    const left = this.createVirtualUri(key, 'before', label);
    const right = this.createVirtualUri(key, 'after', label);
    this.contents.set(left.toString(), originalText);
    this.contents.set(right.toString(), proposedText);
    try {
      await withTimeout(vscode.commands.executeCommand(
        'vscode.diff',
        left,
        right,
        `${label} — KeepSeek ChangeSet`,
        { preview: true }
      ), 10_000);
    } catch {
      // A diff renderer failure is never an Apply authorization. Keep the
      // canonical proposal available as a plain read-only review document.
      const document = await vscode.workspace.openTextDocument(right);
      await vscode.window.showTextDocument(document, { preview: true });
    }
  }

  public dispose(): void {
    this.disposed = true;
    for (const panel of this.imagePanels) panel.dispose();
    this.imagePanels.clear();
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

  private async readCheckpointOriginalText(checkpoint: ChangeCheckpoint): Promise<string> {
    if (checkpoint.originalText !== undefined) return checkpoint.originalText;
    if (!checkpoint.originalBlobHash || !this.artifactStore) return '';
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await this.artifactStore.getBlob(checkpoint.originalBlobHash)
    );
  }
}

async function withTimeout<T>(operation: Thenable<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Diff preview timed out.')), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
