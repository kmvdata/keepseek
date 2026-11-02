import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { open, readFile, unlink, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { withStorageCoordinator, writeBytesAtomic, writeJsonAtomic } from '../shared/atomicStorage';
import { ImageAssetError, IMAGE_MAX_BYTES, IMAGE_MAX_DIMENSION, IMAGE_MAX_PIXELS, validateImageBytes, verifyImageContainer, type ImageMetadata } from './imageValidation';

export interface ImageAssetScope { workspaceId: string; sessionId: string; }
export interface ImageAssetRef extends ImageMetadata {
  assetId: string;
  hash: string;
  fileName: string;
  source: 'import' | 'generated';
}
export interface ImageAssetRecord extends ImageAssetRef {
  version: 1;
  workspaceId: string;
  sessionId: string;
  createdAt: number;
  jobId?: string;
  parentAssetId?: string;
}
export interface ImageAssetPutOptions {
  source: 'import' | 'generated';
  fileName?: string;
  jobId?: string;
  parentAssetId?: string;
  mime?: string;
}

const DEFAULT_QUOTA = 512 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;

/** Conservative ownership store: bytes are shared by content hash, all reads
 * require a scope-owned record. There is deliberately no automatic deletion. */
export class ImageAssetStore {
  private readonly root: vscode.Uri;
  private readonly blobRoot: vscode.Uri;
  private readonly quotaBytes: number;
  private readonly maxImageBytes: number;
  private readonly projections = new Map<string, { blobIdentity: string; previewIdentity: string }>();

  public constructor(globalStorageUri: vscode.Uri, options: { quotaBytes?: number; maxImageBytes?: number } = {}) {
    this.root = vscode.Uri.joinPath(globalStorageUri, 'image-assets', 'v1');
    this.blobRoot = vscode.Uri.joinPath(this.root, 'blobs');
    this.quotaBytes = options.quotaBytes ?? DEFAULT_QUOTA;
    this.maxImageBytes = Math.min(options.maxImageBytes ?? IMAGE_MAX_BYTES, IMAGE_MAX_BYTES);
  }

  public async put(scope: ImageAssetScope, bytes: Uint8Array, options: ImageAssetPutOptions): Promise<ImageAssetRef> {
    validateScope(scope);
    if (bytes.byteLength > this.maxImageBytes) throw new ImageAssetError('image_too_large', 'Image byte limit exceeded.');
    // Caller-owned buffers may be reused while asynchronous decode/storage waits.
    bytes = Uint8Array.from(bytes);
    if (!['import', 'generated'].includes(options.source)) throw new ImageAssetError('image_invalid', 'Invalid image source.');
    const metadata = validateImageBytes(bytes, options.mime, this.maxImageBytes);
    await verifyImageContainer(bytes, metadata);
    const hash = hashBytes(bytes);
    const assetId = hashBytes(Buffer.from(JSON.stringify([scope.workspaceId, scope.sessionId, hash])));
    return this.mutate(async () => {
      const existing = await this.readBlobIfPresent(hash);
      if (existing) {
        if (hashBytes(existing) !== hash || existing.byteLength !== bytes.byteLength) throw new ImageAssetError('asset_corrupt', 'Image blob failed hash verification.');
      } else {
        if (await this.getUsageBytes() + bytes.byteLength > this.quotaBytes) throw new ImageAssetError('asset_quota', 'Image storage quota exceeded. Existing images are retained.');
        await writeBytesAtomic(this.blobUri(hash), bytes, { durable: true });
        const verified = await vscode.workspace.fs.readFile(this.blobUri(hash));
        if (hashBytes(verified) !== hash || verified.byteLength !== bytes.byteLength) throw new ImageAssetError('asset_corrupt', 'Image write verification failed.');
      }
      const previous = await this.readRecordIfPresent(scope, assetId);
      if (previous) {
        validateRecord(previous, scope, assetId);
        if (options.jobId) await this.writeJobLink(scope, options.jobId, assetId);
        return publicRef(previous);
      }
      const record: ImageAssetRecord = {
        version: 1, ...scope, ...metadata, assetId, hash,
        fileName: sanitizeFileName(options.fileName ?? `image.${extension(metadata.mime)}`),
        source: options.source, createdAt: Date.now(),
        ...(options.jobId ? { jobId: checkedLabel(options.jobId) } : {}),
        ...(options.parentAssetId ? { parentAssetId: checkedHash(options.parentAssetId) } : {})
      };
      if (record.parentAssetId) await this.getMetadata(scope, record.parentAssetId);
      await writeJsonAtomic(this.recordUri(scope, assetId), record, { durable: true });
      if (options.jobId) await this.writeJobLink(scope, options.jobId, assetId);
      return publicRef(record);
    });
  }

  public async get(scope: ImageAssetScope, assetId: string): Promise<{ asset: ImageAssetRef; bytes: Uint8Array }> {
    const asset = await this.getMetadata(scope, assetId);
    let bytes: Uint8Array;
    try {
      const uri = this.blobUri(asset.hash);
      if ((await vscode.workspace.fs.stat(uri)).size !== asset.byteLength) throw new ImageAssetError('asset_corrupt', 'Image bytes failed hash verification.');
      bytes = await vscode.workspace.fs.readFile(uri);
    }
    catch (error) { if (isMissing(error)) throw new ImageAssetError('asset_missing', 'Image bytes are missing.'); throw error; }
    if (bytes.byteLength !== asset.byteLength || hashBytes(bytes) !== asset.hash) throw new ImageAssetError('asset_corrupt', 'Image bytes failed hash verification.');
    const metadata = validateImageBytes(bytes, asset.mime, this.maxImageBytes);
    if (metadata.width !== asset.width || metadata.height !== asset.height) throw new ImageAssetError('asset_corrupt', 'Image dimensions differ from saved metadata.');
    return { asset, bytes };
  }

  public async findByJob(scope: ImageAssetScope, jobId: string): Promise<ImageAssetRef | undefined> {
    validateScope(scope); checkedLabel(jobId);
    const bytes = await readFileIfPresent(this.jobLinkUri(scope, jobId), 8192);
    if (!bytes) return undefined;
    if (bytes.byteLength > 8192) throw new ImageAssetError('asset_corrupt', 'Image association is oversized.');
    let value: { version?: unknown; workspaceId?: unknown; sessionId?: unknown; jobId?: unknown; assetId?: unknown };
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ImageAssetError('asset_corrupt', 'Image association is invalid.'); }
    if (!value || value.version !== 1 || value.workspaceId !== scope.workspaceId || value.sessionId !== scope.sessionId || value.jobId !== jobId || typeof value.assetId !== 'string') throw new ImageAssetError('asset_forbidden', 'Image association owner mismatch.');
    return (await this.get(scope, value.assetId)).asset;
  }

  public async getMetadata(scope: ImageAssetScope, assetId: string): Promise<ImageAssetRef> {
    validateScope(scope); checkedHash(assetId);
    const record = await this.readRecordIfPresent(scope, assetId);
    if (!record) throw new ImageAssetError('asset_forbidden', 'Image is missing or belongs to another session.');
    validateRecord(record, scope, assetId);
    return publicRef(record);
  }

  /** The only Webview root to expose is this exact session projection directory.
   * No credential/job/blob/other-session root is included. Each file is verified
   * before projection; the original input bytes remain the execution authority. */
  public async createProjection(scope: ImageAssetScope, assetIds: readonly string[]): Promise<{
    rootUri: vscode.Uri; assets: Array<{ asset: ImageAssetRef; uri: vscode.Uri }>;
  }> {
    validateScope(scope);
    if (assetIds.length > 200) throw new ImageAssetError('image_too_large', 'Too many image previews requested.');
    const rootUri = this.getProjectionRoot(scope);
    const projected: Array<{ asset: ImageAssetRef; uri: vscode.Uri }> = [];
    for (const assetId of new Set(assetIds)) {
      const metadata = await this.getMetadata(scope, assetId);
      const uri = vscode.Uri.joinPath(rootUri, `${metadata.assetId}.${extension(metadata.mime)}`);
      const cacheKey = uri.toString();
      const cached = this.projections.get(cacheKey);
      if (cached) {
        try {
          const [blobIdentity, previewIdentity] = await Promise.all([fileIdentity(this.blobUri(metadata.hash)), fileIdentity(uri)]);
          if (blobIdentity === cached.blobIdentity && previewIdentity === cached.previewIdentity) { projected.push({ asset: metadata, uri }); continue; }
        } catch { /* a missing or changed file must be verified again */ }
      }
      const initialBlobIdentity = await fileIdentity(this.blobUri(metadata.hash));
      const { asset, bytes } = await this.get(scope, assetId);
      const verifiedBlobIdentity = await fileIdentity(this.blobUri(asset.hash));
      if (verifiedBlobIdentity !== initialBlobIdentity) throw new ImageAssetError('asset_corrupt', 'Image changed during projection verification.');
      await this.mutate(async () => {
        const existing = await readFileIfPresent(uri);
        if (!existing || hashBytes(existing) !== asset.hash) {
          const priorSize = existing?.byteLength ?? 0;
          if (await this.getUsageBytes() - priorSize + bytes.byteLength > this.quotaBytes) throw new ImageAssetError('asset_quota', 'Image storage and preview quota exceeded.');
          // A projection is an independent copy: native editors or external
          // preview changes must never mutate the content-addressed original.
          await writeBytesAtomic(uri, bytes);
          const saved = await readFileIfPresent(uri);
          if (!saved || hashBytes(saved) !== asset.hash) throw new ImageAssetError('asset_corrupt', 'Image projection verification failed.');
        }
      });
      const [blobIdentity, previewIdentity] = await Promise.all([fileIdentity(this.blobUri(asset.hash)), fileIdentity(uri)]);
      if (blobIdentity !== verifiedBlobIdentity) throw new ImageAssetError('asset_corrupt', 'Image changed during projection verification.');
      this.projections.set(cacheKey, { blobIdentity, previewIdentity });
      projected.push({ asset, uri });
    }
    return { rootUri, assets: projected };
  }

  public getProjectionRoot(scope: ImageAssetScope): vscode.Uri {
    validateScope(scope);
    return vscode.Uri.joinPath(this.scopeRoot(scope), 'preview');
  }

  public async getUsageBytes(): Promise<number> {
    let entries: Array<[string, vscode.FileType]>;
    try { entries = await vscode.workspace.fs.readDirectory(this.blobRoot); }
    catch (error) { if (isMissing(error)) return this.getProjectionUsageBytes(); throw error; }
    let total = 0;
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !/^[a-f0-9]{64}\.blob$/u.test(name)) continue;
      total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.blobRoot, name))).size;
    }
    return total + await this.getProjectionUsageBytes();
  }

  private async mutate<T>(work: () => Promise<T>): Promise<T> {
    return withStorageCoordinator(this.root, async () => {
      if (this.root.scheme !== 'file') throw new ImageAssetError('asset_storage_scheme', 'Image storage requires a file-backed Extension Host.');
      await vscode.workspace.fs.createDirectory(this.root);
      const lockPath = vscode.Uri.joinPath(this.root, 'assets.lock').fsPath;
      let lock;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (!hasCode(error, 'EEXIST')) throw error;
          const recoveryPath = lockPath + '.recovery';
          let recovery;
          try { recovery = await open(recoveryPath, 'wx', 0o600); }
          catch { throw new ImageAssetError('asset_busy', 'Image storage is being updated by another host.'); }
          try {
            let dead = false;
            try {
              const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { hostname?: unknown; pid?: unknown };
              if (owner.hostname === hostname() && typeof owner.pid === 'number' && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
                try { process.kill(owner.pid, 0); } catch (probe) { dead = hasCode(probe, 'ESRCH'); }
              }
            } catch { /* incomplete or foreign owner stays fail-closed */ }
            if (!dead) throw new ImageAssetError('asset_busy', 'Image storage is locked by another host or an unconfirmed owner.');
            await unlink(lockPath);
          } finally { await recovery.close(); await unlink(recoveryPath); }
        }
      }
      if (!lock) throw new ImageAssetError('asset_busy', 'Image storage is being updated by another host.');
      try {
        await lock.writeFile(JSON.stringify({ hostname: hostname(), pid: process.pid }));
        return await work();
      } finally { await lock.close(); await unlink(lockPath); }
    });
  }

  private async writeJobLink(scope: ImageAssetScope, jobId: string, assetId: string): Promise<void> {
    await writeJsonAtomic(this.jobLinkUri(scope, jobId), { version: 1, ...scope, jobId: checkedLabel(jobId), assetId }, { durable: true });
  }
  private jobLinkUri(scope: ImageAssetScope, jobId: string): vscode.Uri { return vscode.Uri.joinPath(this.scopeRoot(scope), 'jobs', `${hashBytes(Buffer.from(checkedLabel(jobId)))}.json`); }
  private async getProjectionUsageBytes(): Promise<number> {
    let total = 0;
    const walk = async (uri: vscode.Uri, depth: number): Promise<void> => {
      if (depth > 3) throw new ImageAssetError('asset_corrupt', 'Unexpected image projection directory.');
      let entries: Array<[string, vscode.FileType]>;
      try { entries = await vscode.workspace.fs.readDirectory(uri); } catch (error) { if (isMissing(error)) return; throw error; }
      for (const [name, type] of entries) {
        if (type === vscode.FileType.Directory && (depth === 0 || name === 'preview')) await walk(vscode.Uri.joinPath(uri, name), depth + 1);
        else if (type === vscode.FileType.File && depth === 2) total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, name))).size;
      }
    };
    await walk(vscode.Uri.joinPath(this.root, 'scopes'), 0);
    return total;
  }
  private blobUri(hash: string): vscode.Uri { return vscode.Uri.joinPath(this.blobRoot, `${checkedHash(hash)}.blob`); }
  private scopeRoot(scope: ImageAssetScope): vscode.Uri {
    return vscode.Uri.joinPath(this.root, 'scopes', hashBytes(Buffer.from(JSON.stringify([scope.workspaceId, scope.sessionId]))));
  }
  private recordUri(scope: ImageAssetScope, assetId: string): vscode.Uri { return vscode.Uri.joinPath(this.scopeRoot(scope), 'refs', `${checkedHash(assetId)}.json`); }
  private async readRecordIfPresent(scope: ImageAssetScope, assetId: string): Promise<ImageAssetRecord | undefined> {
    const bytes = await readFileIfPresent(this.recordUri(scope, assetId), 8192);
    if (!bytes) return undefined;
    if (bytes.byteLength > 8192) throw new ImageAssetError('asset_corrupt', 'Image ownership record is oversized.');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as ImageAssetRecord; }
    catch { throw new ImageAssetError('asset_corrupt', 'Image ownership record is invalid.'); }
  }
  private async readBlobIfPresent(hash: string): Promise<Uint8Array | undefined> { return readFileIfPresent(this.blobUri(hash)); }
}

function validateRecord(record: ImageAssetRecord, scope: ImageAssetScope, assetId: string): void {
  if (!record || record.version !== 1 || record.workspaceId !== scope.workspaceId || record.sessionId !== scope.sessionId || record.assetId !== assetId) throw new ImageAssetError('asset_forbidden', 'Image ownership verification failed.');
  if (!HASH.test(record.hash) || !['image/png','image/jpeg','image/webp'].includes(record.mime) || !Number.isSafeInteger(record.byteLength) || record.byteLength < 1 || record.byteLength > IMAGE_MAX_BYTES || !Number.isSafeInteger(record.width) || !Number.isSafeInteger(record.height) || record.width < 1 || record.height < 1 || record.width > IMAGE_MAX_DIMENSION || record.height > IMAGE_MAX_DIMENSION || record.width * record.height > IMAGE_MAX_PIXELS || typeof record.fileName !== 'string' || record.fileName.length > 255 || !['import','generated'].includes(record.source)) throw new ImageAssetError('asset_corrupt', 'Image metadata is invalid.');
  if (record.assetId !== hashBytes(Buffer.from(JSON.stringify([scope.workspaceId, scope.sessionId, record.hash])))) throw new ImageAssetError('asset_corrupt', 'Image identity verification failed.');
}
function publicRef(record: ImageAssetRecord): ImageAssetRef {
  return { assetId: record.assetId, hash: record.hash, mime: record.mime, byteLength: record.byteLength, width: record.width, height: record.height, fileName: record.fileName, source: record.source };
}
function validateScope(scope: ImageAssetScope): void {
  if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId || scope.workspaceId.length > 4096 || typeof scope.sessionId !== 'string' || !scope.sessionId || scope.sessionId.length > 256) throw new ImageAssetError('asset_forbidden', 'Invalid image owner scope.');
}
function checkedHash(value: string): string { if (typeof value !== 'string' || !HASH.test(value)) throw new ImageAssetError('asset_forbidden', 'Invalid image reference.'); return value; }
function checkedLabel(value: string): string { if (!value || value.length > 256 || [...value].some((char) => char.charCodeAt(0) < 32)) throw new ImageAssetError('image_invalid', 'Invalid image association.'); return value; }
function sanitizeFileName(value: string): string { return [...value].map((char) => char.charCodeAt(0) < 32 || char === '/' || char === '\\' ? '_' : char).join('').slice(0, 255) || 'image'; }
function extension(mime: string): string { return mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp'; }
function hashBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && ['ENOENT','FileNotFound'].includes(String(error.code)); }
async function readFileIfPresent(uri: vscode.Uri, maxBytes = IMAGE_MAX_BYTES): Promise<Uint8Array | undefined> {
  try {
    if ((await vscode.workspace.fs.stat(uri)).size > maxBytes) throw new ImageAssetError('asset_corrupt', 'Stored image resource exceeds its size bound.');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) throw new ImageAssetError('asset_corrupt', 'Stored image resource exceeds its size bound.');
    return bytes;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }

/** ctime and inode catch same-size replacement even if an editor preserves mtime.
 * No image bytes are reread on unchanged high-frequency progress projections. */
async function fileIdentity(uri: vscode.Uri): Promise<string> {
  if (uri.scheme !== 'file') throw new ImageAssetError('asset_storage_scheme', 'Image storage requires a file-backed Extension Host.');
  const value = await stat(uri.fsPath, { bigint: true });
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
}
