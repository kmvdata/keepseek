import type { MessageAttachment } from '../shared/types';
import { readImageHeader, sniffImageMimeType, type ImageMimeType } from './imageHeader';
import { AttachmentStoreError, type AttachmentStore } from './attachmentStore';

/**
 * Host-side admission for user image attachments.
 *
 * The webview transcode is untrusted: everything that reaches this module is
 * re-validated against magic bytes, declared mime type, geometry and size. A
 * rejection never produces a blob, so the store cannot be used as an oracle for
 * unsupported content.
 */
export const IMAGE_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const;

/** One image may be at most 32 MiB. */
export const MAX_IMAGE_ATTACHMENT_BYTES = 32 * 1024 * 1024;
/** One request may carry strictly less than 48 MiB of image bytes. */
export const MAX_REQUEST_ATTACHMENT_BYTES = 48 * 1024 * 1024;
/** Kept in sync with `MAX_MESSAGE_ATTACHMENTS` in `sessions/chatSessionStore.ts`. */
export const MAX_MESSAGE_ATTACHMENTS = 8;

export type ImageIntakeRejectionCode =
  | 'empty_image'
  | 'unsupported_mime_type'
  | 'unsupported_format'
  | 'mime_type_mismatch'
  | 'image_too_large'
  | 'request_too_large'
  | 'invalid_dimensions'
  | 'dimension_mismatch'
  | 'too_many_images'
  | 'store_quota_exceeded'
  | 'store_write_failed';

export interface PromptImagePayload {
  /** One-shot bridge payload from the webview; crossed exactly once. */
  dataUrl?: string;
  /** Direct bytes, used by tests and by any future non-bridge intake path. */
  bytes?: Uint8Array;
  declaredMimeType?: string;
  reportedWidth?: number;
  reportedHeight?: number;
  originalBytes?: number;
  originalWidth?: number;
  originalHeight?: number;
  sourceName?: string;
}

export interface InspectedImagePayload {
  bytes: Uint8Array;
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

export type ImageInspection =
  | { ok: true; image: InspectedImagePayload }
  | { ok: false; code: ImageIntakeRejectionCode };

export interface ImageIntakeRejection {
  index: number;
  code: ImageIntakeRejectionCode;
  sourceName?: string;
}

export interface ImageIntakeResult {
  attachments: MessageAttachment[];
  rejected: ImageIntakeRejection[];
  storedHashes: string[];
}

export interface IntakeUserImagesInput {
  images: readonly PromptImagePayload[];
  store: AttachmentStore;
  createdAt: string;
  maxImageBytes?: number;
  maxRequestBytes?: number;
  maxImages?: number;
}

const DATA_URL_PATTERN = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;

export function isSupportedImageMimeType(value: string): value is ImageMimeType {
  return (IMAGE_ATTACHMENT_MIME_TYPES as readonly string[]).includes(value);
}

export function parseImageDataUrl(dataUrl: string): { declaredMimeType: string; base64: string } | undefined {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  return match ? { declaredMimeType: match[1].toLowerCase(), base64: match[2] } : undefined;
}

export function decodeImageDataUrl(dataUrl: string): { declaredMimeType: string; bytes: Uint8Array } | undefined {
  const parsed = parseImageDataUrl(dataUrl);
  return parsed ? { declaredMimeType: parsed.declaredMimeType, bytes: decodeBase64Payload(parsed.base64) } : undefined;
}

/** Pure validation. Never touches the store, so a rejection cannot write bytes. */
export function inspectImagePayload(
  payload: PromptImagePayload,
  options: { maxImageBytes?: number } = {}
): ImageInspection {
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_ATTACHMENT_BYTES;
  let declaredMimeType = (payload.declaredMimeType ?? '').trim().toLowerCase();
  let bytes: Uint8Array;
  if (payload.bytes) {
    bytes = payload.bytes;
  } else if (payload.dataUrl) {
    const parsed = parseImageDataUrl(payload.dataUrl);
    if (!parsed) {
      return { ok: false, code: 'unsupported_format' };
    }
    declaredMimeType = declaredMimeType || parsed.declaredMimeType;
    if (estimateBase64Bytes(parsed.base64) > maxImageBytes) {
      return { ok: false, code: 'image_too_large' };
    }
    bytes = decodeBase64Payload(parsed.base64);
  } else {
    return { ok: false, code: 'empty_image' };
  }
  if (bytes.byteLength === 0) {
    return { ok: false, code: 'empty_image' };
  }
  if (!isSupportedImageMimeType(declaredMimeType)) {
    return { ok: false, code: 'unsupported_mime_type' };
  }
  const sniffed = sniffImageMimeType(bytes);
  if (!sniffed) {
    return { ok: false, code: 'unsupported_format' };
  }
  if (sniffed !== declaredMimeType) {
    return { ok: false, code: 'mime_type_mismatch' };
  }
  if (bytes.byteLength > maxImageBytes) {
    return { ok: false, code: 'image_too_large' };
  }
  const header = readImageHeader(bytes);
  if (!header) {
    return { ok: false, code: 'invalid_dimensions' };
  }
  if (payload.reportedWidth !== undefined && payload.reportedWidth !== header.width) {
    return { ok: false, code: 'dimension_mismatch' };
  }
  if (payload.reportedHeight !== undefined && payload.reportedHeight !== header.height) {
    return { ok: false, code: 'dimension_mismatch' };
  }
  return { ok: true, image: { bytes, mimeType: sniffed, width: header.width, height: header.height } };
}

/**
 * Validates, stores and describes user images. Message-visible data is only the
 * sha256, geometry and provenance; nothing here returns base64.
 */
export async function intakeUserImages(input: IntakeUserImagesInput): Promise<ImageIntakeResult> {
  const maxRequestBytes = input.maxRequestBytes ?? MAX_REQUEST_ATTACHMENT_BYTES;
  const maxImages = input.maxImages ?? MAX_MESSAGE_ATTACHMENTS;
  const attachments: MessageAttachment[] = [];
  const rejected: ImageIntakeRejection[] = [];
  const storedHashes: string[] = [];
  let totalBytes = 0;
  for (let index = 0; index < input.images.length; index += 1) {
    const payload = input.images[index];
    if (!payload) continue;
    const sourceName = normalizeSourceName(payload.sourceName);
    const rejection = (code: ImageIntakeRejectionCode): void => {
      rejected.push({ index, code, ...(sourceName ? { sourceName } : {}) });
    };
    const inspection = inspectImagePayload(payload, { maxImageBytes: input.maxImageBytes });
    if (!inspection.ok) {
      rejection(inspection.code);
      continue;
    }
    if (attachments.length >= maxImages) {
      rejection('too_many_images');
      continue;
    }
    if (totalBytes + inspection.image.bytes.byteLength > maxRequestBytes) {
      rejection('request_too_large');
      continue;
    }
    let sha256: string;
    try {
      sha256 = await input.store.putBlob(inspection.image.bytes);
    } catch (error) {
      rejection(error instanceof AttachmentStoreError && error.code === 'quota_exceeded'
        ? 'store_quota_exceeded'
        : 'store_write_failed');
      continue;
    }
    totalBytes += inspection.image.bytes.byteLength;
    storedHashes.push(sha256);
    const originalBytes = normalizeCount(payload.originalBytes);
    const originalWidth = normalizeCount(payload.originalWidth);
    const originalHeight = normalizeCount(payload.originalHeight);
    attachments.push({
      id: `image-${sha256.slice(0, 16)}-${index}`,
      kind: 'image',
      scope: 'user',
      sha256,
      mimeType: inspection.image.mimeType,
      bytes: inspection.image.bytes.byteLength,
      width: inspection.image.width,
      height: inspection.image.height,
      ...(originalBytes === undefined ? {} : { originalBytes }),
      ...(originalWidth === undefined ? {} : { originalWidth }),
      ...(originalHeight === undefined ? {} : { originalHeight }),
      ...(sourceName ? { sourceName } : {}),
      createdAt: input.createdAt
    });
  }
  return { attachments, rejected, storedHashes };
}

function decodeBase64Payload(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64.replace(/\s+/gu, ''), 'base64'));
}

function estimateBase64Bytes(base64: string): number {
  const compact = base64.replace(/\s+/gu, '');
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function normalizeSourceName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 260) : undefined;
}

function normalizeCount(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
