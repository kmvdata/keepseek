import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Content-addressed store for user image attachment bytes.
 *
 * Bytes live only here. A `ChatMessage.attachments[]` entry carries the sha256,
 * geometry and provenance, so no session JSON, evidence record, trace or
 * webview snapshot ever holds base64. The layout and the atomic write mirror
 * `edits/changeArtifactStore.ts`: temporary file, read-back hash verification,
 * rename, then best-effort cleanup of the temporary file.
 */
export const ATTACHMENT_STORE_QUOTA_BYTES = 512 * 1024 * 1024;
export const ATTACHMENT_MAX_BLOB_BYTES = 32 * 1024 * 1024;
export const ATTACHMENT_GC_MINIMUM_AGE_MS = 24 * 60 * 60 * 1_000;

export type AttachmentStoreErrorCode =
  | 'blob_too_large'
  | 'quota_exceeded'
  | 'invalid_hash'
  | 'hash_mismatch'
  | 'corrupt_blob';

export class AttachmentStoreError extends Error {
  public constructor(message: string, public readonly code: AttachmentStoreErrorCode) {
    super(message);
    this.name = 'AttachmentStoreError';
  }
}

export interface AttachmentStoreOptions {
  quotaBytes?: number;
  maxBlobBytes?: number;
}

export interface AttachmentGcResult {
  removed: number;
  retainedBytes: number;
  /** True when the reference scan could not be completed; nothing was deleted. */
  aborted: boolean;
}

export class AttachmentStore {
  private readonly globalStorageUri: vscode.Uri;
  private readonly root: vscode.Uri;
  private readonly blobRoot: vscode.Uri;
  private readonly quotaBytes: number;
  private readonly maxBlobBytes: number;

  public constructor(globalStorageUri: vscode.Uri, options: AttachmentStoreOptions = {}) {
    this.globalStorageUri = globalStorageUri;
    this.root = vscode.Uri.joinPath(globalStorageUri, 'attachments', 'v1');
    this.blobRoot = vscode.Uri.joinPath(this.root, 'blobs');
    this.quotaBytes = options.quotaBytes ?? ATTACHMENT_STORE_QUOTA_BYTES;
    this.maxBlobBytes = options.maxBlobBytes ?? ATTACHMENT_MAX_BLOB_BYTES;
  }

  /** Idempotent: identical bytes always map to the same hash and one blob. */
  public async putBlob(bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength === 0) {
      throw new AttachmentStoreError('Attachment blob is empty.', 'corrupt_blob');
    }
    if (bytes.byteLength > this.maxBlobBytes) {
      throw new AttachmentStoreError(
        `Attachment blob exceeds the ${this.maxBlobBytes}-byte limit.`,
        'blob_too_large'
      );
    }
    const hash = hashAttachmentBytes(bytes);
    const existing = await this.readBlobIfPresent(hash);
    if (existing) {
      if (existing.byteLength !== bytes.byteLength || hashAttachmentBytes(existing) !== hash) {
        throw new AttachmentStoreError('Content-addressed attachment blob is corrupt.', 'corrupt_blob');
      }
      return hash;
    }
    // Quota is advisory across processes: the host serializes attachment writes
    // through the project write lease, so usage cannot be raced by this extension.
    const usage = await this.getUsageBytes();
    if (usage + bytes.byteLength > this.quotaBytes) {
      throw new AttachmentStoreError('Attachment store quota exceeded; no blob was written.', 'quota_exceeded');
    }
    const temporary = vscode.Uri.joinPath(this.blobRoot, `.keepseek-${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(this.blobRoot);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      const readBack = await vscode.workspace.fs.readFile(temporary);
      if (hashAttachmentBytes(readBack) !== hash || readBack.byteLength !== bytes.byteLength) {
        throw new AttachmentStoreError('Attachment blob verification failed.', 'hash_mismatch');
      }
      try {
        await vscode.workspace.fs.rename(temporary, this.blobUri(hash), { overwrite: false });
      } catch (error) {
        const raced = await this.readBlobIfPresent(hash);
        if (!raced || hashAttachmentBytes(raced) !== hash) throw error;
      }
      return hash;
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false }))
        .then(() => undefined, () => undefined);
    }
  }

  public async getBlob(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) {
      throw new AttachmentStoreError('Invalid attachment blob hash.', 'invalid_hash');
    }
    const bytes = await vscode.workspace.fs.readFile(this.blobUri(hash));
    if (hashAttachmentBytes(bytes) !== hash) {
      throw new AttachmentStoreError('Attachment blob hash verification failed.', 'hash_mismatch');
    }
    return bytes;
  }

  public async hasBlob(hash: string): Promise<boolean> {
    return Boolean(await this.readBlobIfPresent(hash));
  }

  public async getUsageBytes(): Promise<number> {
    let total = 0;
    for (const [name, type] of await this.listBlobs()) {
      if (type !== vscode.FileType.File || !isBlobName(name)) continue;
      try {
        total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.blobRoot, name))).size;
      } catch { /* best effort usage accounting */ }
    }
    return total;
  }

  /**
   * Sweeps unreferenced blobs. The caller must persist the sha256 references
   * (session message bodies) before calling this; the scan itself re-collects
   * every 64-hex token from the persisted JSON roots so a blob that is still
   * referenced by any store is never deleted. An unreadable directory or file
   * aborts the whole sweep — GC never guesses that a live blob is an orphan.
   */
  public async garbageCollect(
    referencedHashes: ReadonlySet<string>,
    options: { minimumAgeMs?: number; shouldAbort?: () => boolean } = {}
  ): Promise<AttachmentGcResult> {
    const protectedHashes = new Set(referencedHashes);
    if (options.shouldAbort?.()) {
      return { removed: 0, retainedBytes: 0, aborted: true };
    }
    if (!await this.collectPersistedReferences(this.globalStorageUri, protectedHashes, 0, options.shouldAbort)) {
      return { removed: 0, retainedBytes: await this.getUsageBytes(), aborted: true };
    }
    let removed = 0;
    let retainedBytes = 0;
    for (const [name, type] of await this.listBlobs()) {
      if (options.shouldAbort?.()) {
        return { removed, retainedBytes, aborted: true };
      }
      if (type !== vscode.FileType.File || !isBlobName(name)) continue;
      const hash = name.slice(0, 64);
      const uri = vscode.Uri.joinPath(this.blobRoot, name);
      let stat: vscode.FileStat | undefined;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { /* diagnosed on read */ }
      const tooNew = stat && Date.now() - stat.mtime < (options.minimumAgeMs ?? ATTACHMENT_GC_MINIMUM_AGE_MS);
      if (protectedHashes.has(hash) || tooNew) {
        retainedBytes += stat?.size ?? 0;
        continue;
      }
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
        removed += 1;
      } catch { /* best-effort GC never removes a referenced blob */ }
    }
    return { removed, retainedBytes, aborted: false };
  }

  private blobUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.blobRoot, `${hash}.image`);
  }

  private async readBlobIfPresent(hash: string): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(this.blobUri(hash));
    } catch {
      return undefined;
    }
  }

  private async listBlobs(): Promise<Array<[string, vscode.FileType]>> {
    try {
      return await vscode.workspace.fs.readDirectory(this.blobRoot);
    } catch {
      return [];
    }
  }

  private async collectPersistedReferences(
    uri: vscode.Uri,
    hashes: Set<string>,
    depth: number,
    shouldAbort?: () => boolean
  ): Promise<boolean> {
    if (depth > 12 || shouldAbort?.()) return false;
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return depth === 0 ? !(await exists(uri)) : false;
    }
    for (const [name, type] of entries) {
      if (shouldAbort?.()) return false;
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        if (child.toString() === this.blobRoot.toString()) continue;
        if (!await this.collectPersistedReferences(child, hashes, depth + 1, shouldAbort)) return false;
        continue;
      }
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(child));
      } catch {
        return false;
      }
      for (const match of content.matchAll(/\b[a-f0-9]{64}\b/gu)) hashes.add(match[0]);
    }
    return true;
  }
}

export function hashAttachmentBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isBlobName(name: string): boolean {
  return /^[a-f0-9]{64}\.image$/u.test(name);
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
