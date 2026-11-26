import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { hashAttachmentBytes } from './attachmentStore';
import type { ImageMimeType } from './imageHeader';

/**
 * Derived, disposable previews of stored image attachments.
 *
 * The content-addressed blob stays the only source of truth: a preview is a
 * byte-identical copy under the extension's own storage, materialized on demand
 * and rebuilt whenever it is missing. It exists so a Webview can point
 * `img.src` at a real file through `asWebviewUri` without a second encoding
 * pass, and so `vscode.open` opens the image instead of a `.image` blob.
 *
 * Session deletion reclaims the whole preview directory; blobs are never
 * touched here because the existing reference GC owns them.
 */
export const PREVIEW_ROOT_SEGMENTS = ['attachments', 'v1', 'preview'] as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const PREVIEW_EXTENSIONS: Record<ImageMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

export type AttachmentPreviewStoreErrorCode =
  | 'invalid_session_id'
  | 'invalid_hash'
  | 'unsupported_mime_type'
  | 'empty_bytes'
  | 'hash_mismatch';

export class AttachmentPreviewStoreError extends Error {
  public constructor(message: string, public readonly code: AttachmentPreviewStoreErrorCode) {
    super(message);
    this.name = 'AttachmentPreviewStoreError';
  }
}

export interface AttachmentPreviewInput {
  sessionId: string;
  sha256: string;
  mimeType: ImageMimeType;
  /** The stored blob bytes; the preview is a verbatim copy of them. */
  bytes: Uint8Array;
}

export class AttachmentPreviewStore {
  public readonly previewRoot: vscode.Uri;
  private readonly globalStorageUri: vscode.Uri;

  public constructor(globalStorageUri: vscode.Uri) {
    this.globalStorageUri = globalStorageUri;
    this.previewRoot = vscode.Uri.joinPath(globalStorageUri, ...PREVIEW_ROOT_SEGMENTS);
  }

  /** Idempotent: one session and one hash always name the same preview file. */
  public fileUri(sessionId: string, sha256: string, mimeType: ImageMimeType): vscode.Uri {
    const extension = PREVIEW_EXTENSIONS[mimeType];
    if (!extension) {
      throw new AttachmentPreviewStoreError('Unsupported preview image type.', 'unsupported_mime_type');
    }
    return vscode.Uri.joinPath(this.sessionDirectory(sessionId), `${this.assertHash(sha256)}.${extension}`);
  }

  /**
   * Materializes the bytes once. An existing preview wins without a rewrite, so
   * repeated clicks never churn the directory.
   */
  public async ensure(input: AttachmentPreviewInput): Promise<vscode.Uri> {
    const target = this.fileUri(input.sessionId, input.sha256, input.mimeType);
    if (!input.bytes?.byteLength) {
      throw new AttachmentPreviewStoreError('Attachment preview bytes are empty.', 'empty_bytes');
    }
    if (hashAttachmentBytes(input.bytes) !== input.sha256) {
      throw new AttachmentPreviewStoreError('Attachment preview bytes do not match their hash.', 'hash_mismatch');
    }
    if (await exists(target)) {
      return target;
    }
    const directory = this.sessionDirectory(input.sessionId);
    await vscode.workspace.fs.createDirectory(directory);
    const temporary = vscode.Uri.joinPath(directory, `.keepseek-${randomUUID()}.tmp`);
    try {
      await vscode.workspace.fs.writeFile(temporary, input.bytes);
      const readBack = await vscode.workspace.fs.readFile(temporary);
      if (hashAttachmentBytes(readBack) !== input.sha256 || readBack.byteLength !== input.bytes.byteLength) {
        throw new AttachmentPreviewStoreError('Attachment preview verification failed.', 'hash_mismatch');
      }
      try {
        await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
      } catch (error) {
        // A concurrent materialization already produced identical bytes.
        if (!await exists(target)) throw error;
      }
      return target;
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false }))
        .then(() => undefined, () => undefined);
    }
  }

  /** Best effort and idempotent: cleanup must never fail a deletion flow. */
  public async deleteSession(sessionId: string): Promise<void> {
    if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(this.sessionDirectory(sessionId), { recursive: true, useTrash: false });
    } catch { /* nothing to reclaim */ }
  }

  public async hasSession(sessionId: string): Promise<boolean> {
    if (!SESSION_ID_PATTERN.test(String(sessionId || ''))) {
      return false;
    }
    try {
      return (await vscode.workspace.fs.stat(this.sessionDirectory(sessionId))).type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  /**
   * The only way to name a directory. An invalid id is refused instead of being
   * escaped or sanitized, and the joined path is re-checked so a preview can
   * never be written outside `previewRoot`.
   */
  private sessionDirectory(sessionId: string): vscode.Uri {
    const normalized = typeof sessionId === 'string' ? sessionId : '';
    if (!SESSION_ID_PATTERN.test(normalized)) {
      throw new AttachmentPreviewStoreError('Invalid preview session id.', 'invalid_session_id');
    }
    const directory = vscode.Uri.joinPath(this.previewRoot, normalized);
    if (!directory.path.startsWith(`${this.previewRoot.path}/`)) {
      throw new AttachmentPreviewStoreError('Preview path escaped its root.', 'invalid_session_id');
    }
    return directory;
  }

  private assertHash(sha256: string): string {
    const normalized = typeof sha256 === 'string' ? sha256 : '';
    if (!SHA256_PATTERN.test(normalized)) {
      throw new AttachmentPreviewStoreError('Invalid attachment hash.', 'invalid_hash');
    }
    return normalized;
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}