import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { missing } from '../src/sessions/sessionDeletionAuthority';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/case';
const TOMBSTONE = '/Users/kermit/Library/Application Support/com.kmvdata.keepseek/session-deletions/v1/deleted/f19cf1a64fc75cb61867393e350252bf90e7e727248833406408ebf1a5027c97.json';

/** Every wrapping shape VS Code and node use for a vanished path. `missing()`
 * must answer "absent" for all of them: startup probes a tombstone for each
 * listed session, and an unrecognized wrapper used to fail the whole history
 * load, which locked the composer on the reported build. */
test('every vanished-path shape is classified as an absent record', () => {
  const bare = `ENOENT: no such file or directory, stat '${TOMBSTONE}'`;
  const vscodeGeneric = `cannot be found (Error: ${bare})`;
  const shapes: unknown[] = [
    Object.assign(new Error(bare), { code: 'ENOENT' }),
    // The node FileSystemProvider rethrows the raw node error without `code`.
    new Error(bare),
    new Error(vscodeGeneric),
    Object.assign(new Error(vscodeGeneric), { code: 'Unknown', name: 'EntryNotFound (FileSystemError)' }),
    // VS Code's current wrapper names the entry and carries the node error as cause.
    Object.assign(new Error(`EntryNotFound (FileSystemError): ${TOMBSTONE}`), { cause: new Error(bare) }),
    Object.assign(new Error('EntryNotFound (FileSystemError)'), { name: 'EntryNotFound (FileSystemError)', cause: { code: 'ENOENT', message: bare } }),
    // The shape that actually shipped the bug: code FileNotFound, the node ENOENT
    // text only in `message`, and no `cause`/`errno`. The early return in the
    // FileNotFound branch classified it as an unreadable record, so one absent
    // tombstone aborted startup recovery with "ENOENT: no such file or
    // directory, stat '...deleted/<hash>.json'".
    Object.assign(new Error(bare), { code: 'FileNotFound', name: 'FileSystemError' })
  ];
  for (const shape of shapes) assert.equal(missing(shape), true, `absent must stay absent: ${String((shape as Error).message)}`);
});

/** An unreadable record is not a vanished one: losing that distinction would let
 * a permission failure silently authorize work on deleted history. */
test('unreadable records are never classified as absent', () => {
  const shapes: unknown[] = [
    Object.assign(new Error(`EACCES: permission denied, stat '${TOMBSTONE}'`), { code: 'EACCES' }),
    Object.assign(new Error(`cannot open (Error: EPERM: operation not permitted, stat '${TOMBSTONE}')`),
      { code: 'Unknown', name: 'NoPermissions (FileSystemError)' }),
    Object.assign(new Error(`EntryNotFound (FileSystemError): ${TOMBSTONE}`), { cause: new Error('EIO: i/o error') }),
    // FileNotFound is not a licence to assume absence: without the ENOENT marker
    // it stays an unreadable record.
    Object.assign(new Error(`cannot stat (FileSystemError): sharing violation`), { code: 'FileNotFound', name: 'FileSystemError' }),
    new Error('access denied while reading the record')
  ];
  for (const shape of shapes) assert.equal(missing(shape), false, `unreadable must stay an error: ${String((shape as Error).message)}`);
});

/** The exact reported state: one unrelated tombstone in the shared deleted
 * directory and no record for the probed sessions. Startup must load. */
test('startup loads history when no tombstone exists for the probed sessions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-missing-tombstone-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages.push({ id: 'message-1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as never);
  await store.persist();
  await storage.flush();

  // The worker's stat for an absent tombstone: a FileSystemError-shaped message
  // with the node error nested as cause and no machine-readable code.
  const worker = vscode.workspace.fs as unknown as { stat: (uri: vscode.Uri) => Promise<unknown> };
  const originalStat = worker.stat;
  worker.stat = async (uri: vscode.Uri) => {
    if (String(uri.path).includes('/session-deletions/')) {
      const bare = `ENOENT: no such file or directory, stat '${uri.path}'`;
      const error = new Error(`cannot be found (Error: ${bare})`);
      (error as { name?: string; code?: string }).name = 'EntryNotFound (FileSystemError)';
      (error as { code?: string }).code = 'Unknown';
      throw error;
    }
    return originalStat.call(worker, uri);
  };
  try {
    const nextStorage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const nextStore = new ChatSessionStore(nextStorage, 'en', scope);
    await nextStore.initialize({ fresh: true });
    assert.ok(nextStore.getSessionSummaries().some(summary => summary.id === session.id),
      'an absent tombstone keeps history listed instead of failing the load');
    assert.equal(nextStore.getActiveSession().messages.length, 0, 'startup still opens a blank conversation');
  } finally { worker.stat = originalStat; }
});