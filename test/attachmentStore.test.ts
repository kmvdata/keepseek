import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { Uri as VscodeUri } from 'vscode';
import {
  ATTACHMENT_MAX_BLOB_BYTES,
  ATTACHMENT_STORE_QUOTA_BYTES,
  AttachmentStore
} from '../src/attachments/attachmentStore';
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_REQUEST_ATTACHMENT_BYTES,
  intakeUserImages
} from '../src/attachments/imageIntake';
import { Uri } from './stubs/vscode';

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-attachments-'));
  roots.push(root);
  return root;
}

function storeFor(root: string, options: { quotaBytes?: number; maxBlobBytes?: number } = {}): AttachmentStore {
  return new AttachmentStore(Uri.file(root) as unknown as VscodeUri, options);
}

function blobDir(root: string): string {
  return path.join(root, 'attachments', 'v1', 'blobs');
}

async function blobNames(root: string): Promise<string[]> {
  try {
    return (await readdir(blobDir(root))).sort();
  } catch {
    return [];
  }
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function pngBytes(width: number, height: number, paddingBytes = 0): Uint8Array {
  const bytes = new Uint8Array(33 + paddingBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  for (let index = 33; index < bytes.length; index += 1) {
    bytes[index] = index % 251;
  }
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >>> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >>> 8) & 0xff;
  return bytes;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('putBlob dedupes identical bytes under the content hash', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const bytes = pngBytes(8, 8);
  const first = await store.putBlob(bytes);
  const second = await store.putBlob(Uint8Array.from(bytes));
  assert.equal(first, sha256Of(bytes), 'the blob name is the sha256 of the bytes');
  assert.equal(second, first, 'identical bytes map to one hash');
  assert.deepEqual(await blobNames(root), [`${first}.image`], 'one file serves both writes');
  assert.deepEqual(Buffer.from(await store.getBlob(first)), Buffer.from(bytes));
});

test('getBlob refuses a tampered blob', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const hash = await store.putBlob(pngBytes(4, 4));
  await writeFile(path.join(blobDir(root), `${hash}.image`), Buffer.from('not-the-original-image'));
  await assert.rejects(
    () => store.getBlob(hash),
    (error: { code?: string }) => error.code === 'hash_mismatch'
  );
  await assert.rejects(
    () => store.getBlob('not-a-hash'),
    (error: { code?: string }) => error.code === 'invalid_hash'
  );
});

test('quota rejection writes nothing', async () => {
  const root = await newRoot();
  const store = storeFor(root, { quotaBytes: 100 });
  const stored = await store.putBlob(pngBytes(2, 2, 30));
  const before = await store.getUsageBytes();
  await assert.rejects(
    () => store.putBlob(pngBytes(3, 3, 80)),
    (error: { code?: string }) => error.code === 'quota_exceeded'
  );
  assert.equal(await store.getUsageBytes(), before, 'the rejected blob never reaches the store');
  assert.deepEqual(await blobNames(root), [`${stored}.image`]);
});

test('garbage collection keeps references, removes orphans and aborts on an unreadable reference scan', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const kept = await store.putBlob(pngBytes(5, 5));
  const orphan = await store.putBlob(pngBytes(6, 6));
  const collected = await store.garbageCollect(new Set([kept]), { minimumAgeMs: 0 });
  assert.deepEqual(
    { removed: collected.removed, aborted: collected.aborted },
    { removed: 1, aborted: false }
  );
  assert.deepEqual(await blobNames(root), [`${kept}.image`], 'the referenced blob survives');
  await assert.rejects(() => store.getBlob(orphan));

  const brokenRoot = await newRoot();
  const brokenStore = storeFor(brokenRoot);
  const survivor = await brokenStore.putBlob(pngBytes(7, 7));
  await mkdir(path.join(brokenRoot, 'sessions'), { recursive: true });
  await writeFile(path.join(brokenRoot, 'sessions', 'broken.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
  const aborted = await brokenStore.garbageCollect(new Set(), { minimumAgeMs: 0 });
  assert.equal(aborted.aborted, true, 'an unreadable reference root aborts the sweep');
  assert.equal(aborted.removed, 0);
  assert.deepEqual(await blobNames(brokenRoot), [`${survivor}.image`], 'nothing is swept when the scan is incomplete');
});

test('image intake accepts a valid PNG and records geometry plus provenance', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const bytes = pngBytes(640, 480);
  const result = await intakeUserImages({
    store,
    createdAt: CREATED_AT,
    images: [{
      bytes,
      declaredMimeType: 'image/png',
      reportedWidth: 640,
      reportedHeight: 480,
      originalBytes: 4096,
      originalWidth: 1280,
      originalHeight: 960,
      sourceName: 'paste.png'
    }]
  });
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.attachments.map((attachment) => ({
    kind: attachment.kind,
    scope: attachment.scope,
    sha256: attachment.sha256,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    originalWidth: attachment.originalWidth,
    sourceName: attachment.sourceName,
    createdAt: attachment.createdAt
  })), [{
    kind: 'image',
    scope: 'user',
    sha256: sha256Of(bytes),
    mimeType: 'image/png',
    bytes: bytes.byteLength,
    width: 640,
    height: 480,
    originalWidth: 1280,
    sourceName: 'paste.png',
    createdAt: CREATED_AT
  }]);
  assert.deepEqual(result.storedHashes, [sha256Of(bytes)]);
  assert.deepEqual(await blobNames(root), [`${sha256Of(bytes)}.image`]);
});

test('image intake rejects bad payloads without writing their bytes', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const result = await intakeUserImages({
    store,
    createdAt: CREATED_AT,
    maxImageBytes: 200,
    maxRequestBytes: 100,
    images: [
      { bytes: pngBytes(4, 4), declaredMimeType: 'image/svg+xml' },
      { bytes: pngBytes(4, 4), declaredMimeType: 'image/jpeg' },
      { bytes: Uint8Array.from({ length: 40 }, (_value, index) => index + 1), declaredMimeType: 'image/png' },
      // 233 bytes: over the per-image limit only, so it never reaches the
      // cumulative check below.
      { bytes: pngBytes(4, 4, 200), declaredMimeType: 'image/png' },
      { bytes: gifBytes(4, 4), declaredMimeType: 'image/gif', reportedWidth: 5 },
      { declaredMimeType: 'image/png' },
      { bytes: pngBytes(4, 4), declaredMimeType: 'image/png' },
      // 153 bytes: within the per-image limit, but 33 + 153 > 100 exceeds the
      // request budget, which is the only way `request_too_large` can fire.
      { bytes: pngBytes(4, 5, 120), declaredMimeType: 'image/png' }
    ]
  });
  assert.deepEqual(result.rejected.map((entry) => entry.code), [
    'unsupported_mime_type',
    'mime_type_mismatch',
    'unsupported_format',
    'image_too_large',
    'dimension_mismatch',
    'empty_image',
    'request_too_large'
  ]);
  assert.deepEqual(result.attachments.map((attachment) => attachment.width), [4], 'only the last, in-budget image is stored');
  assert.deepEqual(await blobNames(root), [`${sha256Of(pngBytes(4, 4))}.image`], 'rejected payloads leave no blob');
});

test('admission limits match the documented contract', () => {
  assert.equal(MAX_IMAGE_ATTACHMENT_BYTES, 32 * 1024 * 1024);
  assert.equal(MAX_REQUEST_ATTACHMENT_BYTES, 48 * 1024 * 1024);
  assert.equal(ATTACHMENT_MAX_BLOB_BYTES, MAX_IMAGE_ATTACHMENT_BYTES);
  assert.equal(ATTACHMENT_STORE_QUOTA_BYTES, 512 * 1024 * 1024);
  assert.equal(MAX_MESSAGE_ATTACHMENTS, 8);
});

test('an over-long payload is rejected before it is decoded', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const bytes = pngBytes(4, 4, 2000);
  const dataUrl = `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
  const result = await intakeUserImages({
    store,
    createdAt: CREATED_AT,
    maxImageBytes: 64,
    images: [{ dataUrl }]
  });
  assert.deepEqual(result.rejected.map((entry) => entry.code), ['image_too_large']);
  assert.deepEqual(await blobNames(root), [], 'a rejected payload produces no blob');
});

test('a data url payload is decoded once and stored by hash', async () => {
  const root = await newRoot();
  const store = storeFor(root);
  const bytes = pngBytes(10, 20);
  const result = await intakeUserImages({
    store,
    createdAt: CREATED_AT,
    images: [{ dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`, reportedWidth: 10, reportedHeight: 20 }]
  });
  assert.deepEqual(result.attachments.map((attachment) => [attachment.width, attachment.height]), [[10, 20]]);
  assert.deepEqual(Buffer.from(await readFile(path.join(blobDir(root), `${sha256Of(bytes)}.image`))), Buffer.from(bytes));
});
