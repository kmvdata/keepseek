import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import type { MessageAttachment } from '../shared/types';
import { AttachmentStore, AttachmentStoreError } from './attachmentStore';
import type { ImageMimeType } from './imageHeader';
import {
  MAX_MESSAGE_ATTACHMENTS,
  inspectImagePayload,
  isSupportedImageMimeType,
  type ImageIntakeRejectionCode,
  type PromptImagePayload
} from './imageIntake';

/**
 * Session-scoped staging for images that entered the composer.
 *
 * A dropped or picked image is copied here the moment it becomes a thumbnail, so
 * its lifetime stops depending on the source file: the bytes survive the original
 * being moved, edited or deleted. The staging directory belongs to exactly one
 * session and is reclaimed with it, like the session's own record.
 *
 * Staging never duplicates bytes. It writes one manifest per staged image into
 * the session directory and puts the bytes in the content-addressed
 * `AttachmentStore`; the manifest is a persisted sha256 reference, and that is
 * what keeps the blob out of the attachment GC's reach while the session lives.
 *
 * Only identity, geometry and provenance live in the manifest — never bytes, so
 * no snapshot, trace or session record can carry base64.
 */
export const COMPOSER_IMAGE_STAGING_VERSION = 1;
export const COMPOSER_IMAGE_STAGING_ROOT_SEGMENTS = ['attachments', 'v1', 'staging'] as const;

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const STAGED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export class ComposerImageStagingError extends Error {
  public constructor(message: string, public readonly code: ImageIntakeRejectionCode) {
    super(message);
    this.name = 'ComposerImageStagingError';
  }
}

export interface StagedComposerImage {
  version: number;
  stagedId: string;
  sessionId: string;
  sha256: string;
  mimeType: ImageMimeType;
  bytes: number;
  width: number;
  height: number;
  originalBytes?: number;
  originalWidth?: number;
  originalHeight?: number;
  sourceName?: string;
  createdAt: string;
}

export interface StageComposerImageInput {
  sessionId: string;
  image: PromptImagePayload;
  createdAt?: string;
}

export interface ComposerImageStagingOptions {
  store?: AttachmentStore;
}

export class ComposerImageStagingStore {
  public readonly root: vscode.Uri;
  private readonly store: AttachmentStore;

  public constructor(globalStorageUri: vscode.Uri, options: ComposerImageStagingOptions = {}) {
    this.root = vscode.Uri.joinPath(globalStorageUri, ...COMPOSER_IMAGE_STAGING_ROOT_SEGMENTS);
    this.store = options.store ?? new AttachmentStore(globalStorageUri);
  }

  /**
   * Copies one composer image into the session directory.
   *
   * The payload is the untrusted bridge value: magic bytes, mime type, geometry
   * and size are re-validated here before any blob or manifest is written, so a
   * rejection leaves nothing behind.
   */
  public async stage(input: StageComposerImageInput): Promise<StagedComposerImage> {
    const sessionId = this.assertSessionId(input.sessionId);
    const inspection = inspectImagePayload(input.image);
    if (!inspection.ok) {
      throw new ComposerImageStagingError(`Image rejected: ${inspection.code}.`, inspection.code);
    }
    let sha256: string;
    try {
      sha256 = await this.store.putBlob(inspection.image.bytes);
    } catch (error) {
      throw new ComposerImageStagingError('The image bytes could not be stored.', storeRejectionCode(error));
    }
    const originalBytes = normalizeCount(input.image.originalBytes);
    const originalWidth = normalizeCount(input.image.originalWidth);
    const originalHeight = normalizeCount(input.image.originalHeight);
    const sourceName = normalizeSourceName(input.image.sourceName);
    const staged: StagedComposerImage = {
      version: COMPOSER_IMAGE_STAGING_VERSION,
      stagedId: randomUUID(),
      sessionId,
      sha256,
      mimeType: inspection.image.mimeType,
      bytes: inspection.image.bytes.byteLength,
      width: inspection.image.width,
      height: inspection.image.height,
      ...(originalBytes === undefined ? {} : { originalBytes }),
      ...(originalWidth === undefined ? {} : { originalWidth }),
      ...(originalHeight === undefined ? {} : { originalHeight }),
      ...(sourceName === undefined ? {} : { sourceName }),
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    try {
      await writeJsonAtomic(this.manifestUri(sessionId, staged.stagedId), staged);
    } catch {
      throw new ComposerImageStagingError('The staged image record could not be written.', 'store_write_failed');
    }
    return staged;
  }

  /**
   * Rebuilds message attachments from staged ids.
   *
   * An id is only honored inside its own session, so a staged id can never pull
   * bytes into a conversation that never received the image; a manifest whose
   * blob is gone is skipped instead of failing the submission.
   */
  public async resolveAttachments(
    sessionId: string,
    stagedIds: readonly string[],
    createdAt: string
  ): Promise<MessageAttachment[]> {
    const normalizedSession = this.assertSessionId(sessionId);
    const wanted: string[] = [];
    const seen = new Set<string>();
    for (const raw of stagedIds) {
      const stagedId = typeof raw === 'string' ? raw.trim() : '';
      if (!STAGED_ID_PATTERN.test(stagedId) || seen.has(stagedId)) continue;
      if (wanted.length >= MAX_MESSAGE_ATTACHMENTS) break;
      seen.add(stagedId);
      wanted.push(stagedId);
    }
    const attachments: MessageAttachment[] = [];
    for (const stagedId of wanted) {
      const staged = await this.readManifest(normalizedSession, stagedId);
      if (!staged) continue;
      if (!await this.store.hasBlob(staged.sha256)) continue;
      attachments.push({
        id: `image-${staged.sha256.slice(0, 16)}-${attachments.length}`,
        kind: 'image',
        scope: 'user',
        sha256: staged.sha256,
        mimeType: staged.mimeType,
        bytes: staged.bytes,
        width: staged.width,
        height: staged.height,
        ...(staged.originalBytes === undefined ? {} : { originalBytes: staged.originalBytes }),
        ...(staged.originalWidth === undefined ? {} : { originalWidth: staged.originalWidth }),
        ...(staged.originalHeight === undefined ? {} : { originalHeight: staged.originalHeight }),
        ...(staged.sourceName === undefined ? {} : { sourceName: staged.sourceName }),
        createdAt
      });
    }
    return attachments;
  }

  /** Best effort and idempotent: a deletion flow never fails on cleanup. */
  public async deleteSession(sessionId: string): Promise<boolean> {
    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!SESSION_ID_PATTERN.test(normalized)) return false;
    try {
      await vscode.workspace.fs.delete(this.sessionDirectory(normalized), { recursive: true, useTrash: false });
      return true;
    } catch {
      return false;
    }
  }

  public async hasSession(sessionId: string): Promise<boolean> {
    const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!SESSION_ID_PATTERN.test(normalized)) return false;
    try {
      return (await vscode.workspace.fs.stat(this.sessionDirectory(normalized))).type === vscode.FileType.Directory;
    } catch {
      return false;
    }
  }

  private async readManifest(sessionId: string, stagedId: string): Promise<StagedComposerImage | undefined> {
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(
        await vscode.workspace.fs.readFile(this.manifestUri(sessionId, stagedId))
      );
    } catch {
      return undefined;
    }
    try {
      return normalizeStagedRecord(JSON.parse(content), sessionId, stagedId);
    } catch {
      return undefined;
    }
  }

  private manifestUri(sessionId: string, stagedId: string): vscode.Uri {
    if (!STAGED_ID_PATTERN.test(stagedId)) {
      throw new ComposerImageStagingError('Invalid staged image id.', 'store_write_failed');
    }
    return vscode.Uri.joinPath(this.sessionDirectory(sessionId), `${stagedId}.json`);
  }

  /** The only way to name a directory: an invalid id is refused instead of
   * escaped or sanitized, and the joined path is re-checked. */
  private sessionDirectory(sessionId: string): vscode.Uri {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new ComposerImageStagingError('Invalid staging session id.', 'store_write_failed');
    }
    const directory = vscode.Uri.joinPath(this.root, sessionId);
    if (!directory.path.startsWith(`${this.root.path}/`)) {
      throw new ComposerImageStagingError('Staging path escaped its root.', 'store_write_failed');
    }
    return directory;
  }

  private assertSessionId(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!SESSION_ID_PATTERN.test(normalized)) {
      throw new ComposerImageStagingError('Invalid staging session id.', 'store_write_failed');
    }
    return normalized;
  }
}

function normalizeStagedRecord(
  value: unknown,
  sessionId: string,
  stagedId: string
): StagedComposerImage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.version !== COMPOSER_IMAGE_STAGING_VERSION) return undefined;
  if (record.sessionId !== sessionId || record.stagedId !== stagedId) return undefined;
  const sha256 = typeof record.sha256 === 'string' ? record.sha256 : '';
  if (!SHA256_PATTERN.test(sha256)) return undefined;
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (!isSupportedImageMimeType(mimeType)) return undefined;
  const bytes = normalizeCount(record.bytes);
  const width = normalizeCount(record.width);
  const height = normalizeCount(record.height);
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt.trim() : '';
  if (bytes === undefined || width === undefined || height === undefined || !createdAt) return undefined;
  const originalBytes = normalizeCount(record.originalBytes);
  const originalWidth = normalizeCount(record.originalWidth);
  const originalHeight = normalizeCount(record.originalHeight);
  const sourceName = normalizeSourceName(typeof record.sourceName === 'string' ? record.sourceName : undefined);
  return {
    version: COMPOSER_IMAGE_STAGING_VERSION,
    stagedId,
    sessionId,
    sha256,
    mimeType,
    bytes,
    width,
    height,
    ...(originalBytes === undefined ? {} : { originalBytes }),
    ...(originalWidth === undefined ? {} : { originalWidth }),
    ...(originalHeight === undefined ? {} : { originalHeight }),
    ...(sourceName === undefined ? {} : { sourceName }),
    createdAt
  };
}

function storeRejectionCode(error: unknown): ImageIntakeRejectionCode {
  if (error instanceof AttachmentStoreError) {
    if (error.code === 'quota_exceeded') return 'store_quota_exceeded';
    if (error.code === 'blob_too_large') return 'image_too_large';
  }
  return 'store_write_failed';
}

function normalizeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizeSourceName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 260) : undefined;
}