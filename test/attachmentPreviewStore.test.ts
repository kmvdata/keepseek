import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import type { Uri as VscodeUri } from 'vscode';
import { AttachmentStore } from '../src/attachments/attachmentStore';
import { AttachmentPreviewStore } from '../src/attachments/attachmentPreviewStore';
import { Uri } from './stubs/vscode';

const SESSION_ID = 'session-1';
const SINCE = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-previews-'));
  roots.push(root);
  return root;
}

function previewStore(root: string): AttachmentPreviewStore {
  return new AttachmentPreviewStore(Uri.file(root) as unknown as VscodeUri);
}

function previewDir(root: string, sessionId = SESSION_ID): string {
  return path.join(root, 'attachments', 'v1', 'preview', sessionId);
}

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >>> 24) & 0xff;
  bytes[17] = (width >>> 16) & 0xff;
  bytes[18] = (width >>> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >>> 24) & 0xff;
  bytes[21] = (height >>> 16) & 0xff;
  bytes[22] = (height >>> 8) & 0xff;
  bytes[23] = height & 0xff;
  return bytes;
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

test('a preview is a byte-identical copy of the stored blob', async () => {
  const root = await newRoot();
  const bytes = pngBytes(640, 480);
  const sha256 = await new AttachmentStore(Uri.file(root) as unknown as VscodeUri).putBlob(bytes);
  const uri = await previewStore(root).ensure({ sessionId: SESSION_ID, sha256, mimeType: 'image/png', bytes });
  assert.equal(uri.fsPath, path.join(previewDir(root), `${sha256}.png`));
  assert.deepEqual(Buffer.from(await readFile(uri.fsPath)), Buffer.from(bytes));
  assert.deepEqual((await readdir(previewDir(root))), [`${sha256}.png`], 'no temporary file is left behind');
  assert.equal(await previewStore(root).hasSession(SESSION_ID), true);
});

test('the preview extension follows the stored mime type', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  const cases: Array<['image/png' | 'image/jpeg' | 'image/webp' | 'image/gif', string]> = [
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif']
  ];
  for (const [mimeType, extension] of cases) {
    const bytes = pngBytes(1, 1);
    const uri = store.fileUri(SESSION_ID, 'a'.repeat(64), mimeType);
    assert.equal(path.extname(uri.fsPath), `.${extension}`, mimeType);
  }
});

test('an existing preview is reused instead of rewritten', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  const bytes = pngBytes(8, 8);
  const sha256 = sha256Of(bytes);
  const first = await store.ensure({ sessionId: SESSION_ID, sha256, mimeType: 'image/png', bytes });
  // A rewrite would overwrite this marker; a reuse leaves it in place.
  await writeFile(first.fsPath, Buffer.from('marker'));
  const second = await store.ensure({ sessionId: SESSION_ID, sha256, mimeType: 'image/png', bytes });
  assert.equal(second.fsPath, first.fsPath);
  assert.equal(Buffer.from(await readFile(second.fsPath)).toString(), 'marker');
});

test('deleting a session reclaims only that session directory', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  const bytes = pngBytes(4, 4);
  const sha256 = sha256Of(bytes);
  await store.ensure({ sessionId: SESSION_ID, sha256, mimeType: 'image/png', bytes });
  await store.ensure({ sessionId: 'session-2', sha256, mimeType: 'image/png', bytes });

  await store.deleteSession(SESSION_ID);
  assert.equal(await store.hasSession(SESSION_ID), false);
  assert.equal(await store.hasSession('session-2'), true, 'another conversation keeps its preview');
  await assert.rejects(() => access(previewDir(root)), 'the directory is gone');

  await store.deleteSession(SESSION_ID);
  assert.equal(await store.hasSession(SESSION_ID), false, 'deleting twice is not an error');
});

test('an invalid session id or hash is refused instead of guessed', () => {
  const store = previewStore('/tmp/keepseek-preview-guard');
  const hash = 'a'.repeat(64);
  for (const sessionId of ['../escape', 'a/b', '', '.hidden', 'x'.repeat(257)]) {
    assert.throws(
      () => store.fileUri(sessionId, hash, 'image/png'),
      (error: { code?: string }) => error.code === 'invalid_session_id',
      sessionId
    );
  }
  for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), '', 'z'.repeat(64)]) {
    assert.throws(
      () => store.fileUri(SESSION_ID, sha256, 'image/png'),
      (error: { code?: string }) => error.code === 'invalid_hash',
      sha256
    );
  }
});

test('a preview path can never leave the preview root', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  for (const sessionId of ['../escape', 'a/../../escape', 'nested/sub']) {
    assert.throws(
      () => store.fileUri(sessionId, 'a'.repeat(64), 'image/png'),
      (error: { code?: string }) => error.code === 'invalid_session_id'
    );
  }
  await assert.rejects(() => access(path.join(root, 'attachments', 'v1', 'escape')));
  assert.throws(
    () => store.fileUri(SESSION_ID, 'a'.repeat(64), 'image/svg+xml' as never),
    (error: { code?: string }) => error.code === 'unsupported_mime_type'
  );
});

test('empty or mismatched bytes are refused and leave nothing behind', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  const bytes = pngBytes(2, 2);
  await assert.rejects(
    () => store.ensure({ sessionId: SESSION_ID, sha256: sha256Of(new Uint8Array()), mimeType: 'image/png', bytes: new Uint8Array() }),
    (error: { code?: string }) => error.code === 'empty_bytes' || error.code === 'invalid_hash'
  );
  await assert.rejects(
    () => store.ensure({ sessionId: SESSION_ID, sha256: 'b'.repeat(64), mimeType: 'image/png', bytes }),
    (error: { code?: string }) => error.code === 'hash_mismatch'
  );
  assert.equal(await store.hasSession(SESSION_ID), false);
});

test('a missing source blob leaves no preview behind', async () => {
  const root = await newRoot();
  const store = previewStore(root);
  const missingHash = 'c'.repeat(64);
  await assert.rejects(() => new AttachmentStore(Uri.file(root) as unknown as VscodeUri).getBlob(missingHash));
  assert.equal(await store.hasSession(SESSION_ID), false);
  await assert.rejects(() => access(previewDir(root)));
});
