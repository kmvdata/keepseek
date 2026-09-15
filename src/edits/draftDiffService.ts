import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChangeCheckpoint, DraftEdit } from '../shared/types';
import { getConfiguredPatchSettings } from '../shared/config';
import { getDraftEditFullText } from './draftEdit';
import { applyTextPatchToBytes, renderPatchReview } from './textPatch';
import { ChangeArtifactStore } from './changeArtifactStore';

const DRAFT_DIFF_SCHEME = 'keepseek-draft';

export class DraftDiffService implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly registration: vscode.Disposable;
  private readonly artifactStore?: ChangeArtifactStore;

  public constructor(globalStorageUri?: vscode.Uri) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(DRAFT_DIFF_SCHEME, this);
    this.artifactStore = globalStorageUri ? new ChangeArtifactStore(globalStorageUri) : undefined;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  public async openDiff(edit: DraftEdit, checkpoint?: ChangeCheckpoint): Promise<void> {
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
