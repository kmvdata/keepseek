import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { Uri as VscodeUri } from 'vscode';
import { AttachmentStore } from '../src/attachments/attachmentStore';
import {
  COMPOSER_IMAGE_STAGING_ROOT_SEGMENTS,
  ComposerImageStagingError,
  ComposerImageStagingStore
} from '../src/attachments/composerImageStaging';
import {
  DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE,
  DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE,
  resolveImageAttachmentMaxEdge
} from '../src/attachments/imageLimits';
import { MAX_MESSAGE_ATTACHMENTS } from '../src/attachments/imageIntake';
import { Uri } from './stubs/vscode';

const CREATED_AT = '2026-02-01T00:00:00.000Z';
const RESOLVED_AT = '2026-02-02T00:00:00.000Z';
const SESSION_ID = 'session-1';
const roots: string[] = [];

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-image-staging-'));
  roots.push(root);
  return root;
}

function stagingFor(root: string): { store: AttachmentStore; staging: ComposerImageStagingStore } {
  const store = new AttachmentStore(Uri.file(root) as unknown as VscodeUri);
  return { store, staging: new ComposerImageStagingStore(Uri.file(root) as unknown as VscodeUri, { store }) };
}

function stagingDir(root: string, sessionId = SESSION_ID): string {
  return path.join(root, ...COMPOSER_IMAGE_STAGING_ROOT_SEGMENTS, sessionId);
}

function blobDir(root: string): string {
  return path.join(root, 'attachments', 'v1', 'blobs');
}

async function listOrEmpty(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
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

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('a staged image is copied into the session directory and resolved by id', async () => {
  const root = await newRoot();
  const { store, staging } = stagingFor(root);
  const bytes = pngBytes(1024, 512);
  const staged = await staging.stage({
    sessionId: SESSION_ID,
    createdAt: CREATED_AT,
    image: {
      bytes,
      declaredMimeType: 'image/png',
      originalBytes: 4096,
      originalWidth: 2048,
      originalHeight: 1024,
      sourceName: 'drop.png'
    }
  });

  assert.equal(staged.sha256, sha256Of(bytes), 'the copy is content addressed');
  assert.deepEqual(await listOrEmpty(stagingDir(root)), [`${staged.stagedId}.json`], 'one manifest per staged image');
  const manifest = await readFile(path.join(stagingDir(root), `${staged.stagedId}.json`), 'utf8');
  assert.equal(
    manifest.includes(Buffer.from(bytes).toString('base64')),
    false,
    'the manifest references the hash and never repeats the bytes'
  );
  assert.equal((await readdir(blobDir(root))).length, 1, 'the bytes live once in the content-addressed store');

  const attachments = await staging.resolveAttachments(SESSION_ID, [staged.stagedId], RESOLVED_AT);
  assert.deepEqual(attachments.map((attachment) => ({
    kind: attachment.kind,
    scope: attachment.scope,
    sha256: attachment.sha256,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
    width: attachment.width,
    height: attachment.height,
    originalBytes: attachment.originalBytes,
    originalWidth: attachment.originalWidth,
    sourceName: attachment.sourceName,
    createdAt: attachment.createdAt
  })), [{
    kind: 'image',
    scope: 'user',
    sha256: staged.sha256,
    mimeType: 'image/png',
    bytes: bytes.byteLength,
    width: 1024,
    height: 512,
    originalBytes: 4096,
    originalWidth: 2048,
    sourceName: 'drop.png',
    createdAt: RESOLVED_AT
  }]);
  assert.equal(await store.hasBlob(staged.sha256), true);
});

test('a staged id only resolves inside the session that staged it', async () => {
  const root = await newRoot();
  const { staging } = stagingFor(root);
  const staged = await staging.stage({
    sessionId: SESSION_ID,
    image: { bytes: pngBytes(64, 64), declaredMimeType: 'image/png' }
  });

  assert.deepEqual(
    await staging.resolveAttachments('session-2', [staged.stagedId], RESOLVED_AT),
    [],
    'another conversation can never resolve this image'
  );
  assert.deepEqual(await staging.resolveAttachments(SESSION_ID, ['../escape'], RESOLVED_AT), [], 'a traversal id is ignored');
  await assert.rejects(
    () => staging.stage({ sessionId: '../escape', image: { bytes: pngBytes(8, 8), declaredMimeType: 'image/png' } }),
    (error: unknown) => error instanceof ComposerImageStagingError && error.code === 'store_write_failed'
  );
  assert.deepEqual(await listOrEmpty(path.join(root, ...COMPOSER_IMAGE_STAGING_ROOT_SEGMENTS)), [SESSION_ID]);
});

test('a staged image lives with its session, not with the source file', async () => {
  const root = await newRoot();
  const { store, staging } = stagingFor(root);
  const staged = await staging.stage({
    sessionId: SESSION_ID,
    image: { bytes: pngBytes(256, 256), declaredMimeType: 'image/png' }
  });

  // The manifest is a persisted sha256 reference: the attachment GC protects the
  // blob even when the caller passes no referenced hashes of its own.
  const kept = await store.garbageCollect(new Set(), { minimumAgeMs: 0 });
  assert.deepEqual({ removed: kept.removed, aborted: kept.aborted }, { removed: 0, aborted: false });
  assert.equal(await store.hasBlob(staged.sha256), true);

  assert.equal(await staging.deleteSession(SESSION_ID), true);
  assert.equal(await staging.hasSession(SESSION_ID), false);
  const swept = await store.garbageCollect(new Set(), { minimumAgeMs: 0 });
  assert.deepEqual({ removed: swept.removed, aborted: swept.aborted }, { removed: 1, aborted: false });
  assert.equal(await store.hasBlob(staged.sha256), false, 'the session copy is reclaimed with the session');
});

test('a rejected payload writes no blob and no manifest', async () => {
  const root = await newRoot();
  const { staging } = stagingFor(root);
  await assert.rejects(
    () => staging.stage({ sessionId: SESSION_ID, image: { bytes: Uint8Array.from([1, 2, 3]), declaredMimeType: 'image/png' } }),
    (error: unknown) => error instanceof ComposerImageStagingError && error.code === 'unsupported_format'
  );
  await assert.rejects(
    () => staging.stage({ sessionId: SESSION_ID, image: { bytes: pngBytes(8, 8), declaredMimeType: 'image/jpeg' } }),
    (error: unknown) => error instanceof ComposerImageStagingError && error.code === 'mime_type_mismatch'
  );
  assert.deepEqual(await listOrEmpty(blobDir(root)), [], 'a rejected image never reaches the store');
  assert.equal(await staging.hasSession(SESSION_ID), false);
});

test('resolving caps at the message attachment limit', async () => {
  const root = await newRoot();
  const { staging } = stagingFor(root);
  const stagedIds: string[] = [];
  for (let index = 0; index < MAX_MESSAGE_ATTACHMENTS + 1; index += 1) {
    const staged = await staging.stage({
      sessionId: SESSION_ID,
      image: { bytes: pngBytes(16, 16, index + 1), declaredMimeType: 'image/png' }
    });
    stagedIds.push(staged.stagedId);
  }
  const attachments = await staging.resolveAttachments(SESSION_ID, [...stagedIds, 'not-a-staged-id'], RESOLVED_AT);
  assert.equal(attachments.length, MAX_MESSAGE_ATTACHMENTS);
  assert.equal(new Set(attachments.map((attachment) => attachment.sha256)).size, MAX_MESSAGE_ATTACHMENTS);
});

test('the composer crops to the long edge its lane really recognises', () => {
  assert.equal(DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE, 1568);
  assert.equal(DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE, 1302, '31 cells of 42 px is the measured native grid');
  assert.equal(resolveImageAttachmentMaxEdge(), DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE);
  assert.equal(
    resolveImageAttachmentMaxEdge({ provider: 'deepseek', modelId: 'deepseek-v4.1-flash-1017' }),
    DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE
  );
  assert.equal(
    resolveImageAttachmentMaxEdge({ provider: 'DeepSeek', modelId: 'deepseek-v4.1-flash' }),
    DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE
  );
  assert.equal(resolveImageAttachmentMaxEdge({ provider: 'deepseek', modelId: 'deepseek-v3.2' }), DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE);
  assert.equal(
    resolveImageAttachmentMaxEdge({ provider: 'anthropic-compatible', modelId: 'deepseek-v4.1-flash-1017' }),
    DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE,
    'an unmeasured lane keeps the default long edge'
  );
});