import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import { QUARANTINE_RETENTION_MS, SessionQuarantine } from '../src/sessions/sessionQuarantine';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/quarantine';
const scope = { key: SCOPE_KEY, name: 'q', folderUris: [SCOPE_KEY] };

async function seed(root: string): Promise<{ sessionId: string; indexUri: string }> {
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages.push({ id: 'message-1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as never);
  await store.persist();
  await storage.flush();
  return { sessionId: session.id, indexUri: path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'index.json') };
}

async function quarantineFiles(root: string): Promise<string[]> {
  const directory = path.join(root, 'session-quarantine', 'v1');
  try {
    const batches = await readdir(directory, { recursive: true });
    return batches.filter(name => name.endsWith('.json')).map(name => path.join(directory, name));
  } catch { return []; }
}

/** A corrupted store file must never be deleted on the load path: the bytes are
 * moved aside, the window still loads, and the rest of history survives. */
test('a corrupt workspace index is quarantined and startup still opens a session', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-quarantine-index-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const { indexUri } = await seed(root);
  await writeFile(indexUri, '{"version":2,"workspaces":', 'utf8');

  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize({ fresh: true });
  assert.equal(store.getActiveSession().messages.length, 0, 'a blank conversation is available');

  const moved = await quarantineFiles(root);
  assert.equal(moved.length, 1, 'the corrupted file is moved aside exactly once');
  assert.match(await readFile(moved[0], 'utf8'), /"version":2/, 'the original bytes are preserved');
  await assert.rejects(readFile(indexUri, 'utf8'), 'the corrupt file no longer shadows the live path');
});

/** An unreadable file is not a corrupt one. A permission failure must leave the
 * file in place, because the data on disk may be perfectly intact. */
test('an unreadable store file is never quarantined', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-quarantine-unreadable-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await seed(root);
  const original = vscode.workspace.fs.readFile;
  (vscode.workspace.fs as unknown as { readFile: unknown }).readFile = async (uri: vscode.Uri) => {
    if (String(uri.fsPath).endsWith('index.json')) {
      throw Object.assign(new Error(`EACCES: permission denied, open '${uri.fsPath}'`), { code: 'EACCES' });
    }
    return original(uri);
  };
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    await new ChatSessionStore(storage, 'en', scope).initialize({ fresh: true });
    assert.deepEqual(await quarantineFiles(root), [], 'an I/O failure must not consume the file');
  } finally { (vscode.workspace.fs as unknown as { readFile: unknown }).readFile = original; }
});

/** Quarantined bytes are kept, but not forever. */
test('quarantine batches older than the retention window are removed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-quarantine-sweep-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-05-20T00:00:00.000Z');
  const aged = path.join(root, 'session-quarantine', 'v1', '2026-05-01T00-00-00-000Z', 'index.json');
  const recent = path.join(root, 'session-quarantine', 'v1', '2026-05-19T00-00-00-000Z', 'index.json');
  await mkdir(path.dirname(aged), { recursive: true });
  await mkdir(path.dirname(recent), { recursive: true });
  await writeFile(aged, '{"old":true}', 'utf8');
  await writeFile(recent, '{"new":true}', 'utf8');

  const removed = await new SessionQuarantine(vscode.Uri.file(root) as never, QUARANTINE_RETENTION_MS, () => now).sweepExpired();
  assert.equal(removed, 1, 'only the aged batch is removed');
  await assert.rejects(readFile(aged, 'utf8'), 'the 19-day-old batch is gone');
  assert.match(await readFile(recent, 'utf8'), /"new":true/, 'a batch one day old is retained');
  assert.ok(now - Date.parse('2026-05-01T00:00:00.000Z') > day, 'sanity: the aged batch really is older than a week');
});

/** Quarantine never writes outside the storage root. */
test('quarantine refuses a path outside the storage root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-quarantine-escape-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const outside = path.join(root, '..', 'keepseek-quarantine-escape-target.json');
  const authority = new SessionQuarantine(vscode.Uri.file(path.join(root, 'store')) as never);
  assert.equal(await authority.quarantine(vscode.Uri.file(outside) as never, 'test'), undefined);
});