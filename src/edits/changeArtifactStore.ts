import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredPatchSettings } from '../shared/config';
import { hashBytes } from './textPatch';

export class ChangeArtifactStore {
  private readonly globalStorageUri: vscode.Uri;
  private readonly root: vscode.Uri;
  private readonly blobRoot: vscode.Uri;

  public constructor(globalStorageUri: vscode.Uri) {
    this.globalStorageUri = globalStorageUri;
    this.root = vscode.Uri.joinPath(globalStorageUri, 'change-artifacts', 'v1');
    this.blobRoot = vscode.Uri.joinPath(this.root, 'blobs');
  }

  public async putBlob(bytes: Uint8Array): Promise<string> {
    const settings = getConfiguredPatchSettings();
    if (bytes.byteLength > settings.maxBackupBytes) {
      throw new Error(`Rollback backup exceeds the configured ${settings.maxBackupBytes}-byte limit.`);
    }
    const hash = hashBytes(bytes);
    const target = this.blobUri(hash);
    const existing = await this.readBlobIfPresent(hash);
    if (existing) {
      if (existing.byteLength !== bytes.byteLength || hashBytes(existing) !== hash) {
        throw new Error('Content-addressed rollback blob is corrupt.');
      }
      return hash;
    }
    const usage = await this.getUsageBytes();
    if (usage + bytes.byteLength > settings.blobStoreQuotaBytes) {
      throw new Error('Rollback blob store quota exceeded; no workspace mutation occurred.');
    }
    const temporary = vscode.Uri.joinPath(this.blobRoot, `.keepseek-${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(this.blobRoot);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      const readBack = await vscode.workspace.fs.readFile(temporary);
      if (hashBytes(readBack) !== hash || readBack.byteLength !== bytes.byteLength) {
        throw new Error('Rollback blob verification failed.');
      }
      try {
        await vscode.workspace.fs.rename(temporary, target, { overwrite: false });
      } catch (error) {
        const raced = await this.readBlobIfPresent(hash);
        if (!raced || hashBytes(raced) !== hash) throw error;
      }
      return hash;
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).then(() => undefined, () => undefined);
    }
  }

  public async getBlob(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid rollback blob hash.');
    const bytes = await vscode.workspace.fs.readFile(this.blobUri(hash));
    if (hashBytes(bytes) !== hash) throw new Error('Rollback blob hash verification failed.');
    return bytes;
  }

  public async garbageCollect(
    referencedHashes: ReadonlySet<string>,
    options: { minimumAgeMs?: number } = {}
  ): Promise<{ removed: number; retainedBytes: number }> {
    const protectedHashes = new Set(referencedHashes);
    // Persisted Agent/ChangeSet/session checkpoints may all own a blob. Scan
    // every JSON root before sweeping; any unreadable directory/file aborts
    // deletion so GC can never guess that a still-referenced blob is orphaned.
    if (!await this.collectPersistedReferences(this.globalStorageUri, protectedHashes, 0)) {
      return { removed: 0, retainedBytes: await this.getUsageBytes() };
    }
    let removed = 0;
    let retainedBytes = 0;
    for (const [name, type] of await this.listBlobs()) {
      if (type !== vscode.FileType.File || !/^([a-f0-9]{64})\.blob$/u.test(name)) continue;
      const hash = name.slice(0, 64);
      const uri = vscode.Uri.joinPath(this.blobRoot, name);
      let stat: vscode.FileStat | undefined;
      try { stat = await vscode.workspace.fs.stat(uri); } catch { /* diagnosed on read */ }
      const tooNew = stat && Date.now() - stat.mtime < (options.minimumAgeMs ?? 24 * 60 * 60 * 1_000);
      if (protectedHashes.has(hash) || tooNew) {
        retainedBytes += stat?.size ?? 0;
        continue;
      }
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
        removed += 1;
      } catch { /* best-effort GC never removes a referenced blob */ }
    }
    return { removed, retainedBytes };
  }

  public async getUsageBytes(): Promise<number> {
    let total = 0;
    for (const [name, type] of await this.listBlobs()) {
      if (type !== vscode.FileType.File || !/^[a-f0-9]{64}\.blob$/u.test(name)) continue;
      try { total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.blobRoot, name))).size; } catch { /* best effort */ }
    }
    return total;
  }

  private blobUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.blobRoot, `${hash}.blob`);
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

  private async collectPersistedReferences(uri: vscode.Uri, hashes: Set<string>, depth: number): Promise<boolean> {
    if (depth > 12) return false;
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return depth === 0 ? !(await exists(uri)) : false;
    }
    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(uri, name);
      if (type === vscode.FileType.Directory) {
        if (child.toString() === this.blobRoot.toString()) continue;
        if (!await this.collectPersistedReferences(child, hashes, depth + 1)) return false;
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

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
