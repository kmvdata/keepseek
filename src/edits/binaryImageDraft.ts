import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { BinaryImageDraftEditV1, FileContentIdentity } from '../shared/types';
import { getConfiguredPatchSettings } from '../shared/config';
import { ChangeArtifactStore } from './changeArtifactStore';
import { hashBytes } from './textPatch';
import { validateImageBytes, verifyImageContainer } from '../images/imageValidation';
import { BinaryImageDraftError } from './binaryImageErrors';

/** The host supplies metadata from the image guard, never from the Webview. */
export async function prepareBinaryImageDraft(input: {
  id?: string;
  uri: string;
  label: string;
  reason: string;
  bytes: Uint8Array;
  mimeType: BinaryImageDraftEditV1['mimeType'];
  width: number;
  height: number;
  assetId: string;
  assetHash: string;
  baseBytes?: Uint8Array;
}, artifactStore: ChangeArtifactStore): Promise<BinaryImageDraftEditV1> {
  if (vscode.Uri.parse(input.uri).scheme !== 'file') throw new BinaryImageDraftError('imageWriteUnsupportedTarget');
  const limit = getConfiguredPatchSettings().maxBackupBytes;
  if (input.bytes.byteLength > limit || (input.baseBytes?.byteLength ?? 0) > limit) {
    throw new BinaryImageDraftError('imageWriteTooLarge');
  }
  const result = identity(input.bytes);
  if (result.sha256 !== input.assetHash) throw new BinaryImageDraftError('imageWriteInvalidImage', 'Image asset hash does not match the proposed bytes.');
  try {
    const metadata = validateImageBytes(input.bytes, input.mimeType);
    await verifyImageContainer(input.bytes, metadata);
    if (metadata.width !== input.width || metadata.height !== input.height) throw new Error('Image dimensions do not match the proposed bytes.');
  } catch (error) { throw new BinaryImageDraftError('imageWriteInvalidImage', error instanceof Error ? error.message : undefined); }
  const draft: BinaryImageDraftEditV1 = {
    id: input.id ?? randomUUID(), uri: input.uri, label: input.label, reason: input.reason,
    kind: 'binary_image_v1', action: input.baseBytes === undefined ? 'create' : 'modify',
    base: input.baseBytes === undefined ? undefined : identity(input.baseBytes), result,
    contentBlobHash: result.sha256, assetId: input.assetId, assetHash: input.assetHash,
    mimeType: input.mimeType, width: input.width, height: input.height
  };
  if (!isValidBinaryImageDraft(draft)) throw new BinaryImageDraftError('imageWriteInvalidMetadata');
  try { await artifactStore.putBlob(input.bytes); }
  catch (error) { throw new BinaryImageDraftError('imageWriteFailed', error instanceof Error ? error.message : undefined); }
  return draft;
}

/** Strict compatibility reader: malformed new records never become legacy text edits. */
export function isValidBinaryImageDraft(value: unknown): value is BinaryImageDraftEditV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  const result = draft.result as FileContentIdentity | undefined;
  return draft.kind === 'binary_image_v1'
    && typeof draft.id === 'string' && Boolean(draft.id)
    && typeof draft.uri === 'string' && Boolean(draft.uri)
    && typeof draft.label === 'string' && typeof draft.reason === 'string'
    && (draft.action === 'create' ? draft.base === undefined : draft.action === 'modify' && isIdentity(draft.base))
    && isIdentity(result) && result!.sizeBytes > 0
    && draft.contentBlobHash === result!.sha256 && draft.assetHash === result!.sha256
    && typeof draft.assetId === 'string' && Boolean(draft.assetId) && draft.assetId.length <= 256
    && ['image/png', 'image/jpeg', 'image/webp'].includes(String(draft.mimeType))
    && Number.isSafeInteger(draft.width) && Number(draft.width) > 0 && Number(draft.width) <= 16384
    && Number.isSafeInteger(draft.height) && Number(draft.height) > 0 && Number(draft.height) <= 16384
    && Number(draft.width) * Number(draft.height) <= 40_000_000;
}

function identity(bytes: Uint8Array): FileContentIdentity {
  return { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength };
}

function isIdentity(value: unknown): value is FileContentIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as FileContentIdentity;
  return /^[a-f0-9]{64}$/u.test(identity.sha256) && Number.isSafeInteger(identity.sizeBytes) && identity.sizeBytes >= 0;
}
