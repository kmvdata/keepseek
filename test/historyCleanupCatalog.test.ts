import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import { selectHistoryCleanupTargets } from '../src/sessions/sessionHistoryCleanup';

const summary = (id: string, workspaceKey: string) => ({ id, workspaceKey, title: 'Synthetic',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 1 });
async function putIndex(root: string, workspaceKey: string, value: unknown) {
  const path = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspaceKey), 'index.json');
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}
function usable(entries: Parameters<typeof selectHistoryCleanupTargets>[0], scope: 'current' | 'all' = 'all') {
  return selectHistoryCleanupTargets(entries, { scope, mode: 'all' }, Date.now(), 'workspace:healthy');
}

test('healthy catalog reads each index once with zero preview writes or body reads', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-once-'));
  const a = 'workspace:healthy', b = 'workspace:other';
  await putIndex(root, a, { version: 2, workspaceKey: a, sessions: [summary('a', a)] });
  await putIndex(root, b, { version: 2, workspaceKey: b, sessions: [summary('b', b)] });
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalRead = vscode.workspace.fs.readFile, originalWrite = vscode.workspace.fs.writeFile;
  let writes = 0, bodies = 0;
  const reads = new Map<string, number>();
  vscode.workspace.fs.readFile = async uri => {
    if (uri.path.endsWith('/index.json')) reads.set(uri.path, (reads.get(uri.path) ?? 0) + 1);
    if (uri.path.includes('/sessions/')) bodies++;
    return originalRead(uri);
  };
  vscode.workspace.fs.writeFile = async (...args) => { writes++; return originalWrite(...args); };
  t.after(() => { vscode.workspace.fs.readFile = originalRead; vscode.workspace.fs.writeFile = originalWrite; });
  const result = await new GlobalSessionStorage(vscode.Uri.file(root) as never).readHistoryCleanupCatalog();
  assert.equal(result.ownershipComplete, true);
  assert.equal(result.entries.length, 2);
  assert.equal(usable(result.entries).targets.length, 2);
  assert.deepEqual([...reads.values()], [1, 1]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(writes, 0); assert.equal(bodies, 0);
});

for (const scope of ['current', 'all'] as const) test(`a damaged foreign index yields typed ${scope} preview limitations without granting ambiguous deletion`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-damaged-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = 'workspace:healthy', b = 'workspace:broken';
  const target = summary('healthy', a);
  await putIndex(root, a, { version: 2, workspaceKey: a, sessions: [target] });
  const brokenPath = await putIndex(root, b, '{broken');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const result = await storage.readHistoryCleanupCatalog(scope === 'current' ? a : undefined);
  assert.equal(result.ownershipComplete, false);
  assert.ok(result.diagnostics.some(item => item.code === 'corrupt_index' && item.workspaceHash === getWorkspaceHash(b)));
  assert.equal(result.entries[0].unknownReason, 'workspace_ownership_unverified');
  assert.equal(usable(result.entries, scope).targets.length, 0);
  assert.equal(await storage.revalidateHistoryCleanupTarget(result.entries[0]), false);
  assert.deepEqual(await storage.deletionAuthority.listPending(), []);
  assert.equal(await readFile(brokenPath, 'utf8'), '{broken', 'preview must not repair or overwrite damaged storage');
});

test('permission failure is a per-workspace diagnostic and cannot authorize a healthy-looking target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-permission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = 'workspace:healthy', b = 'workspace:denied';
  await putIndex(root, a, { version: 2, workspaceKey: a, sessions: [summary('a', a)] });
  const denied = await putIndex(root, b, { version: 2, workspaceKey: b, sessions: [summary('b', b)] });
  const original = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async uri => {
    if (uri.fsPath === denied) throw Object.assign(new Error('private path must not surface'), { code: 'EACCES' });
    return original(uri);
  };
  t.after(() => { vscode.workspace.fs.readFile = original; });
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const result = await storage.readHistoryCleanupCatalog();
  assert.ok(result.diagnostics.some(item => item.code === 'permission_denied' && item.retryable === false));
  assert.equal(JSON.stringify(result.diagnostics).includes('private path'), false);
  assert.ok(result.unknown > 0); assert.equal(usable(result.entries).targets.length, 0);
  assert.deepEqual(await storage.deletionAuthority.listPending(), []);
});

test('invalid workspace identity remains unknown and a later index change blocks final admission', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-identity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = 'workspace:healthy', b = 'workspace:other';
  await putIndex(root, a, { version: 2, workspaceKey: a, sessions: [summary('a', a)] });
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const before = await storage.readHistoryCleanupCatalog(a);
  assert.equal(before.ownershipComplete, true); assert.equal(usable(before.entries).targets.length, 1);
  await putIndex(root, b, { version: 2, workspaceKey: 'workspace:wrong-hash', sessions: [summary('hidden', b)] });
  assert.equal(await storage.revalidateHistoryCleanupTarget(before.entries[0]), false);
  const after = await storage.readHistoryCleanupCatalog(a);
  assert.ok(after.diagnostics.some(item => item.code === 'corrupt_index'));
  assert.equal(usable(after.entries).targets.length, 0);
  assert.deepEqual(await storage.deletionAuthority.listPending(), []);
});

test('a completely unreadable storage directory raises a typed storage error rather than an empty result', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = vscode.workspace.fs.readDirectory;
  vscode.workspace.fs.readDirectory = async uri => {
    if (uri.path.endsWith('/v2/workspaces')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(uri);
  };
  t.after(() => { vscode.workspace.fs.readDirectory = original; });
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  await assert.rejects(storage.readHistoryCleanupCatalog(), error => !!error && typeof error === 'object'
    && 'code' in error && error.code === 'permission_denied');
});

test('a fresh native-style FileNotFound storage has an empty readonly preview without creating cleanup directories', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-catalog-new-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const originalRead = vscode.workspace.fs.readFile, originalList = vscode.workspace.fs.readDirectory;
  const originalWrite = vscode.workspace.fs.writeFile;
  let writes = 0;
  const missing = () => Object.assign(new Error('missing synthetic storage'), { code: 'FileNotFound' });
  vscode.workspace.fs.readFile = async () => { throw missing(); };
  vscode.workspace.fs.readDirectory = async () => { throw missing(); };
  vscode.workspace.fs.writeFile = async (...args) => { writes++; return originalWrite(...args); };
  t.after(() => { vscode.workspace.fs.readFile = originalRead; vscode.workspace.fs.readDirectory = originalList; vscode.workspace.fs.writeFile = originalWrite; });
  const result = await new GlobalSessionStorage(vscode.Uri.file(root) as never).readHistoryCleanupCatalog('workspace:new');
  assert.equal(result.ownershipComplete, true);
  assert.equal(result.entries.length, 0); assert.equal(result.unknown, 0);
  assert.deepEqual(result.diagnostics, []); assert.equal(writes, 0);
});

test('unsupported storage is explicitly classified before reading any native path', async t => {
  const original = vscode.workspace.fs.readFile;
  let reads = 0;
  vscode.workspace.fs.readFile = async (...args) => { reads++; return original(...args); };
  t.after(() => { vscode.workspace.fs.readFile = original; });
  const uri = vscode.Uri.parse('vscode-remote://synthetic/storage');
  await assert.rejects(new GlobalSessionStorage(uri as never).readHistoryCleanupCatalog(), error => !!error && typeof error === 'object'
    && 'code' in error && error.code === 'unsupported_storage');
  assert.equal(reads, 0);
});
