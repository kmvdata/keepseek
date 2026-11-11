import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs = require('node:fs/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createRunCheckpoint } from '../src/agent/runCheckpoint';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';
import { writeJsonAtomic } from '../src/shared/atomicStorage';
import * as vscode from './stubs/vscode';

test('durable atomic replacement flushes a writable, non-truncated file before committing the rename', async t => {
  const directory = await temporaryDirectory(t);
  const uri = vscode.Uri.file(join(directory, 'state.json'));
  const previous = { revision: 1 };
  const next = { revision: 2, text: '\ufeff保存检查点\r\n' + 'x'.repeat(10_000) };
  await fs.writeFile(uri.fsPath, JSON.stringify(previous));
  const events = enforceWindowsFileSync(t);
  const rename = vscode.workspace.fs.rename;
  t.mock.method(vscode.workspace.fs, 'rename', async (source: vscode.Uri, target: vscode.Uri, options?: { overwrite?: boolean }) => {
    assert.deepEqual(JSON.parse(await fs.readFile(uri.fsPath, 'utf8')), previous);
    assert.deepEqual(JSON.parse(await fs.readFile(source.fsPath, 'utf8')), next,
      'opening the file for flushing must not truncate its bytes');
    assert.ok(events.includes(`sync:file:${source.fsPath}`));
    assert.ok(events.includes(`close:file:${source.fsPath}`));
    events.push('rename');
    await rename(source, target, options);
  });

  await writeJsonAtomic(uri as never, next, { durable: true });

  assert.deepEqual(JSON.parse(await fs.readFile(uri.fsPath, 'utf8')), next);
  assert.deepEqual(await fs.readdir(directory), ['state.json']);
  const directorySync = events.indexOf(`sync:directory:${directory}`);
  if (process.platform === 'win32') assert.equal(directorySync, -1, 'Windows does not fsync directory handles');
  else assert.ok(directorySync > events.indexOf('rename'), 'POSIX retains the post-rename directory barrier');
});

test('session checkpoint graph saves and reloads under Windows file-flush access rules', async t => {
  const directory = await temporaryDirectory(t);
  const events = enforceWindowsFileSync(t);
  const shard = vscode.Uri.file(join(directory, 'session.json'));
  const session = createEmptySession('en', { key: 'workspace:windows-sync', name: 'Windows sync', folderUris: [] });
  const input = { id: 'user', role: 'user' as const, content: '  Preserve these input bytes\r\n', createdAt: session.createdAt };
  const checkpoint = createRunCheckpoint({
    sessionId: session.id, prompt: input.content,
    model: { id: 'test-model', label: 'Test', provider: 'openai-compatible', sourceId: 'source' },
    settings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], history: [input], language: 'en'
  }, 60_000, 'user', []);
  checkpoint.usedMs = 3210;
  checkpoint.modelRequests = 3;
  checkpoint.usedCostByCurrency = { USD: 0.12 };
  session.messages.push(input, { id: 'assistant', role: 'assistant', content: 'In progress',
    createdAt: session.createdAt, runCheckpoint: checkpoint });

  await new SessionObjectStore(shard as never).save(session);
  const manifest = JSON.parse(await fs.readFile(shard.fsPath, 'utf8'));
  const restored = await new SessionObjectStore(shard as never).load(manifest);

  assert.equal(restored.messages[0].content, input.content);
  assert.deepEqual(restored.messages[1].runCheckpoint, checkpoint);
  assert.ok(events.some(event => event.startsWith('sync:file:') && event.endsWith('.tmp')));
  assert.ok(!(await fs.readdir(join(directory, 'session.json.objects'))).includes('writer.lock'));
});

test('real file fsync EPERM is not ignored: old state survives and a later durable write can retry', async t => {
  const directory = await temporaryDirectory(t);
  const uri = vscode.Uri.file(join(directory, 'state.json'));
  await fs.writeFile(uri.fsPath, JSON.stringify({ revision: 1 }));
  let fail = true;
  enforceWindowsFileSync(t, () => fail);
  const rename = t.mock.method(vscode.workspace.fs, 'rename');

  await assert.rejects(writeJsonAtomic(uri as never, { revision: 2 }, { durable: true }), { code: 'EPERM', syscall: 'fsync' });
  assert.deepEqual(JSON.parse(await fs.readFile(uri.fsPath, 'utf8')), { revision: 1 });
  assert.equal(rename.mock.callCount(), 0, 'a failed durability barrier must never publish the temporary file');
  assert.deepEqual(await fs.readdir(directory), ['state.json']);

  fail = false;
  await writeJsonAtomic(uri as never, { revision: 3 }, { durable: true });
  assert.deepEqual(JSON.parse(await fs.readFile(uri.fsPath, 'utf8')), { revision: 3 });
  assert.equal(rename.mock.callCount(), 1, 'the failed write releases its coordinator');
});

test('file move flushes the copied target with write access and retains a reversible checkpoint', async t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  t.after(() => { Object.defineProperty(process, 'platform', platform); });
  const directory = await temporaryDirectory(t);
  const originalFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'Windows move' }];
  t.after(() => { vscode.workspace.workspaceFolders = originalFolders; });
  const source = vscode.Uri.file(join(directory, 'source.txt'));
  const target = vscode.Uri.file(join(directory, 'nested', 'target.txt'));
  const content = Buffer.from('move exact bytes\r\n中文');
  await fs.writeFile(source.fsPath, content);
  const events = enforceWindowsFileSync(t);
  const editor = new SafeFileEditor(key => key);

  const checkpoint = await editor.applyDraftEdit({
    id: 'move', kind: 'move_v1', action: 'move', label: 'move target', reason: 'Move file',
    uri: source.toString(), sourceUri: source.toString(), targetUri: target.toString(),
    base: { sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength }
  }, 'move-change');
  await assert.rejects(fs.stat(source.fsPath), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(target.fsPath), content);
  assert.ok(events.includes(`sync:file:${target.fsPath}`));
  await editor.revertCheckpoint(checkpoint);
  assert.deepEqual(await fs.readFile(source.fsPath), content);
  await assert.rejects(fs.stat(target.fsPath), { code: 'ENOENT' });
});

test('POSIX can move and revert a read-only file without requiring file write access',
  { skip: process.platform === 'win32' }, async t => {
    const directory = await temporaryDirectory(t);
    const originalFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'Read-only move' }];
    t.after(() => { vscode.workspace.workspaceFolders = originalFolders; });
    const source = vscode.Uri.file(join(directory, 'readonly.txt'));
    const target = vscode.Uri.file(join(directory, 'moved.txt'));
    const content = Buffer.from('read-only content\n');
    await fs.writeFile(source.fsPath, content, { mode: 0o444 });
    const open = fs.open;
    t.mock.method(fs, 'open', async (...[path, flags, mode]: Parameters<typeof fs.open>) => {
      const metadata = await fs.stat(path);
      // O_NOFOLLOW and O_NONBLOCK may accompany a numeric read-only open.
      const writable = typeof flags === 'number'
        ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0
        : flags !== 'r';
      // Enforce POSIX mode semantics even if the test runner has elevated access.
      if (metadata.isFile() && (metadata.mode & 0o222) === 0 && writable) {
        throw Object.assign(new Error('read-only file'), { code: 'EACCES' });
      }
      return open(path, flags, mode);
    });
    const editor = new SafeFileEditor(key => key);
    const checkpoint = await editor.applyDraftEdit({
      id: 'readonly-move', kind: 'move_v1', action: 'move', label: 'read-only file', reason: 'Move file',
      uri: source.toString(), sourceUri: source.toString(), targetUri: target.toString(),
      base: { sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength }
    }, 'readonly-change');
    await assert.rejects(fs.stat(source.fsPath), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(target.fsPath), content);
    assert.equal((await fs.stat(target.fsPath)).mode & 0o777, 0o444);
    await editor.revertCheckpoint(checkpoint);
    assert.deepEqual(await fs.readFile(source.fsPath), content);
    assert.equal((await fs.stat(source.fsPath)).mode & 0o777, 0o444);
    await assert.rejects(fs.stat(target.fsPath), { code: 'ENOENT' });
  });

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'keepseek-windows-fsync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Model FlushFileBuffers' write-access requirement while retaining actual file I/O.
 * File flush errors propagate even when the handle has the correct access. */
function enforceWindowsFileSync(t: TestContext, failFileSync = () => false): string[] {
  const open = fs.open;
  const events: string[] = [];
  t.mock.method(fs, 'open', async (...[path, flags, mode]: Parameters<typeof fs.open>) => {
    const handle = await open(path, flags, mode);
    const directory = (await handle.stat()).isDirectory();
    const kind = directory ? 'directory' : 'file';
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    t.mock.method(handle, 'sync', async () => {
      events.push(`sync:${kind}:${String(path)}`);
      if (!directory && (flags === 'r' || failFileSync())) {
        throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', syscall: 'fsync' });
      }
      await sync();
    });
    t.mock.method(handle, 'close', async () => { events.push(`close:${kind}:${String(path)}`); await close(); });
    return handle;
  });
  return events;
}
