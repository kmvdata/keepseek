import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { ImageAssetStore } from '../src/images/imageAssetStore';
import { IMAGE_MAX_BYTES, validateImageBytes, verifyImageContainer } from '../src/images/imageValidation';
import * as vscode from 'vscode';

const scope = { workspaceId: 'workspace-a', sessionId: 'session-a' };

test('image guards verify MIME, container checksum and dimension limits before decoding', async () => {
  const image = png();
  assert.deepEqual(validateImageBytes(image, 'image/png'), { mime: 'image/png', byteLength: image.length, width: 1, height: 1 });
  await verifyImageContainer(image, validateImageBytes(image));
  assert.throws(() => validateImageBytes(image, 'image/jpeg'), /MIME/u);
  assert.throws(() => validateImageBytes(Buffer.from('<svg></svg>')), /Only PNG/u);
  const corrupt = Buffer.from(image); corrupt[corrupt.length - 1] ^= 1;
  assert.throws(() => validateImageBytes(corrupt), /checksum/u);
  assert.throws(() => validateImageBytes(png(16_385, 1)), /pixel|dimensions/u);
  assert.throws(() => validateImageBytes(png(10_000, 10_000, Buffer.alloc(5))), /pixel/u);
  assert.throws(() => validateImageBytes(new Uint8Array(IMAGE_MAX_BYTES + 1)), /byte limit/u);
  const inflated = png(1, 1, Buffer.alloc(1000));
  await assert.rejects(verifyImageContainer(inflated, validateImageBytes(inflated)), /compressed/u);
});

// Real 2×1 codec fixtures generated from the two-pixel test PNG with sips/cwebp.
// They contain no user data and never enter persisted job/message records.
const CODEC_FIXTURES = [
  { mime: 'image/jpeg', encoded: '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAABAAAAAQAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAQACAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwUDAwMFBgUFBQUGCAYGBgYGCAoICAgICAgKCgoKCgoKCgwMDAwMDA4ODg4ODw8PDw8PDw8PD//bAEMBAgICBAQEBwQEBxALCQsQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEP/dAAQAAf/aAAwDAQACEQMRAD8A7PwZ/wAifoX/AF4Wv/opa6Wua8Gf8ifoX/Xha/8Aopa6Wv4DPqD/2Q==' },
  { mime: 'image/webp', encoded: 'UklGRh4AAABXRUJQVlA4TBEAAAAvAQAAAA+w//Mf8x8VMqL/AQA=' }
] as const;

test('JPEG and WebP imports retain the exact selected codec bytes and dimensions', async (t) => {
  const root = await temp(t);
  const store = new ImageAssetStore(vscode.Uri.file(root));
  for (const fixture of CODEC_FIXTURES) {
    const bytes = Buffer.from(fixture.encoded, 'base64');
    const metadata = validateImageBytes(bytes, fixture.mime);
    assert.equal(metadata.width, 2); assert.equal(metadata.height, 1);
    const asset = await store.put(scope, bytes, { source: 'import', mime: fixture.mime });
    assert.deepEqual(Buffer.from((await store.get(scope, asset.assetId)).bytes), bytes);
    assert.throws(() => validateImageBytes(bytes.subarray(0, bytes.length - 1), fixture.mime), /JPEG|WebP/u);
  }
});

test('image assets persist exact bytes, deduplicate blobs and deny cross-session or workspace reads', async (t) => {
  const root = await temp(t);
  const store = new ImageAssetStore(vscode.Uri.file(root));
  const bytes = png();
  const first = await store.put(scope, bytes, { source: 'generated', jobId: 'job-1', fileName: 'result.png', mime: 'image/png' });
  const second = await store.put(scope, bytes, { source: 'generated', jobId: 'job-2' });
  assert.equal(first.assetId, second.assetId);
  assert.equal(await store.getUsageBytes(), bytes.length);
  assert.deepEqual(Buffer.from((await store.get(scope, first.assetId)).bytes), bytes);
  assert.equal((await store.findByJob(scope, 'job-1'))?.assetId, first.assetId);
  assert.equal((await store.findByJob(scope, 'job-2'))?.assetId, first.assetId);
  assert.equal(await store.findByJob(scope, 'unknown-job'), undefined);
  await assert.rejects(store.get({ ...scope, sessionId: 'other' }, first.assetId), /another session/u);
  await assert.rejects(store.get({ ...scope, workspaceId: 'other' }, first.assetId), /another session/u);
  const other = await store.put({ ...scope, sessionId: 'other' }, bytes, { source: 'import' });
  assert.notEqual(other.assetId, first.assetId);
  assert.equal(await store.getUsageBytes(), bytes.length);
  const restored = new ImageAssetStore(vscode.Uri.file(root));
  assert.deepEqual(await restored.getMetadata(scope, first.assetId), first);
  const metadata = await fs.readFile(path.join(root, 'image-assets', 'v1', 'scopes', hash(JSON.stringify([scope.workspaceId, scope.sessionId])), 'refs', `${first.assetId}.json`), 'utf8');
  const record = JSON.parse(metadata);
  assert.equal(record.workspaceId, scope.workspaceId);
  assert.equal(record.sessionId, scope.sessionId);
  assert.equal(record.hash, hash(bytes));
  assert.deepEqual(Object.keys(record).sort(), ['assetId','byteLength','createdAt','fileName','hash','height','jobId','mime','sessionId','source','version','width','workspaceId'].sort());
  assert.equal('bytes' in record, false);
  assert.equal('base64' in record, false);
});

test('image import snapshots caller bytes before asynchronous persistence', async (t) => {
  const root = await temp(t);
  const store = new ImageAssetStore(vscode.Uri.file(root));
  const bytes = png();
  const expected = Buffer.from(bytes);
  const pending = store.put(scope, bytes, { source: 'import' });
  bytes.fill(0);
  const asset = await pending;
  assert.deepEqual(Buffer.from((await store.get(scope, asset.assetId)).bytes), expected);
});

test('image assets reject corrupt or missing bytes and retain owners under quota failures', async (t) => {
  const root = await temp(t);
  const bytes = png();
  const store = new ImageAssetStore(vscode.Uri.file(root), { quotaBytes: bytes.length });
  const asset = await store.put(scope, bytes, { source: 'import' });
  await assert.rejects(store.put(scope, png(2, 1), { source: 'generated' }), /quota/u);
  assert.equal((await store.getMetadata(scope, asset.assetId)).hash, asset.hash);
  const blobPath = path.join(root, 'image-assets', 'v1', 'blobs', `${asset.hash}.blob`);
  await fs.writeFile(blobPath, 'corrupt');
  await assert.rejects(store.get(scope, asset.assetId), /hash verification/u);
  await fs.unlink(blobPath);
  await assert.rejects(store.get(scope, asset.assetId), /missing/u);
});

test('image asset quota serializes competing imports and fails closed on a live host lock', async (t) => {
  const root = await temp(t);
  const bytes = png();
  const first = new ImageAssetStore(vscode.Uri.file(root), { quotaBytes: bytes.length });
  const second = new ImageAssetStore(vscode.Uri.file(root), { quotaBytes: bytes.length });
  const outcomes = await Promise.allSettled([first.put(scope, bytes, { source: 'import' }), second.put(scope, png(2, 1), { source: 'import' })]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const lockPath = path.join(root, 'image-assets', 'v1', 'assets.lock');
  await fs.writeFile(lockPath, JSON.stringify({ hostname: 'foreign-host', pid: 1 }));
  await assert.rejects(first.put(scope, bytes, { source: 'import' }), /locked|another host/u);
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).hostname, 'foreign-host');
});

test('image previews isolate session roots and cannot mutate the original', async (t) => {
  const root = await temp(t);
  const store = new ImageAssetStore(vscode.Uri.file(root));
  const asset = await store.put(scope, png(), { source: 'generated' });
  const projected = await store.createProjection(scope, [asset.assetId]);
  assert.equal(projected.assets.length, 1);
  assert.equal(projected.rootUri.toString(), store.getProjectionRoot(scope).toString());
  assert.equal(projected.assets[0].uri.fsPath.startsWith(projected.rootUri.fsPath + path.sep), true);
  assert.notEqual(store.getProjectionRoot({ ...scope, sessionId: 'other' }).toString(), projected.rootUri.toString());
  const blob = await fs.stat(path.join(root, 'image-assets', 'v1', 'blobs', `${asset.hash}.blob`));
  const preview = await fs.stat(projected.assets[0].uri.fsPath);
  assert.notEqual(blob.ino, preview.ino);
  assert.equal(await store.getUsageBytes(), asset.byteLength * 2);
  assert.deepEqual(await store.createProjection(scope, [asset.assetId]), projected);
  const original = Buffer.from((await store.get(scope, asset.assetId)).bytes);
  await fs.writeFile(projected.assets[0].uri.fsPath, Buffer.alloc(original.length));
  // Preserved mtime must not disguise a same-size editor write: ctime changes.
  await fs.utimes(projected.assets[0].uri.fsPath, preview.atime, preview.mtime);
  assert.deepEqual(Buffer.from((await store.get(scope, asset.assetId)).bytes), original);
  await store.createProjection(scope, [asset.assetId]);
  assert.deepEqual(await fs.readFile(projected.assets[0].uri.fsPath), original);
  await assert.rejects(store.createProjection({ ...scope, sessionId: 'other' }, [asset.assetId]), /another session/u);
});

async function temp(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-image-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function hash(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function png(width = 1, height = 1, raw?: Buffer): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw ?? Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type: string, body: Buffer): Buffer {
  const output = Buffer.alloc(body.length + 12); output.writeUInt32BE(body.length); output.write(type, 4, 'ascii'); body.copy(output, 8);
  let crc = 0xffffffff;
  for (const byte of output.subarray(4, output.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
}

test('image preview copies share the asset quota and failures keep the result available', async (t) => {
  const root = await temp(t);
  const bytes = png();
  const store = new ImageAssetStore(vscode.Uri.file(root), { quotaBytes: bytes.length });
  const asset = await store.put(scope, bytes, { source: 'generated' });
  await assert.rejects(store.createProjection(scope, [asset.assetId]), /quota/u);
  assert.deepEqual(Buffer.from((await store.get(scope, asset.assetId)).bytes), bytes);
});
