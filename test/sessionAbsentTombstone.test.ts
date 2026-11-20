import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///Users/kermit/Documents/work';
const scope = { key: SCOPE_KEY, name: 'work', folderUris: [SCOPE_KEY] };

/** The exact reported state: the shared `deleted/` directory exists with one
 * unrelated tombstone, and no tombstone exists for the session being probed.
 * The host reports that absent probe as a message-only ENOENT. Session loading
 * must treat it as "not deleted" rather than failing the whole history and
 * locking the composer. */
test('a probed session with no tombstone loads even when the deleted directory already exists', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-absent-tombstone-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  // Seed history the way the reported profile has it.
  const seedStorage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const seed = new ChatSessionStore(seedStorage, 'en', scope);
  await seed.initialize();
  const session = seed.getActiveSession();
  session.messages.push({ id: 'm1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as never);
  await seed.persist();
  await seedStorage.flush();

  // No tombstone exists for that session, but the directory is already there
  // with a single tombstone for some other, unrelated session.
  const deleted = path.join(root, 'session-deletions', 'v1', 'deleted');
  await mkdir(deleted, { recursive: true });
  await writeFile(path.join(deleted, `${createHash('sha256').update('unrelated-session').digest('hex')}.json`), JSON.stringify({
    version: 1, workspaceKey: SCOPE_KEY, sessionId: 'unrelated-session', operationId: 'op',
    confirmedAt: new Date().toISOString(), phase: 'committed'
  }));

  // Every missing probe reports a message-only ENOENT, as the node-backed
  // `file:` provider does (no `code` survives the rethrow).
  const fs = vscode.workspace.fs as unknown as { stat: (uri: vscode.Uri) => Promise<unknown> };
  const originalStat = fs.stat;
  fs.stat = async (uri: vscode.Uri) => {
    try { return await originalStat.call(fs, uri); }
    catch {
      throw new Error(`ENOENT: no such file or directory, stat '${uri.fsPath}'`);
    }
  };
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const store = new ChatSessionStore(storage, 'en', scope);
    await store.initialize({ fresh: true });
    assert.ok(store.getSessionSummaries().some(summary => summary.id === session.id),
      'history is listed instead of the load failing');
  } finally { fs.stat = originalStat; }
});

/** The store keeps working when the layout it must probe does not exist yet. */
test('history probes succeed when no deletion layout exists at all', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-no-layout-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const seedStorage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const seed = new ChatSessionStore(seedStorage, 'en', scope);
  await seed.initialize();
  seed.getActiveSession().messages.push({ id: 'm1', role: 'user', content: 'hi', createdAt: new Date().toISOString() } as never);
  await seed.persist();
  await seedStorage.flush();

  const authority = new GlobalSessionStorage(vscode.Uri.file(root) as never).deletionAuthority;
  assert.equal(await authority.hasRecord('never-deleted'), false);
  assert.equal(await authority.isSessionIdDeleted('never-deleted'), false);
});