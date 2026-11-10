import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, mkdir, writeFile, symlink, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { once } from 'node:events';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { SessionDeletionAuthority } from '../src/sessions/sessionDeletionAuthority';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import type { ChatSession } from '../src/shared/types';

function child(root: string, action: string, events = ''): ChildProcess {
  return fork(path.join(__dirname, 'fixtures', 'historyCleanupProcess.js'), [root, action, 'workspace:cleanup', 'fixture-session', events],
    { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
}
async function ready(process: ChildProcess): Promise<void> {
  const [message] = await once(process, 'message');
  assert.equal(message, 'ready');
}
const session = (): ChatSession => ({ id: 'fixture-session', workspaceKey: 'workspace:cleanup', workspaceName: 'Fixture', workspaceFolders: [],
  title: 'Fixture', isFavorite: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z',
  messages: [{ id: 'message', role: 'user', content: 'unchanged bytes', createdAt: '2026-01-01T00:00:00.000Z' }] });

test('deletion authority serializes truly separate processes and protects a live session use', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-process-'));
  const children: ChildProcess[] = [];
  try {
    const events = path.join(root, 'events');
    const a = child(root, 'gate', events); children.push(a); await ready(a);
    const b = child(root, 'gate', events); children.push(b);
    await Promise.all([once(a, 'exit'), once(b, 'exit')]);
    const lines = (await readFile(events, 'utf8')).trim().split('\n');
    assert.deepEqual(lines.map(line => line.split(':')[0]), ['start', 'end', 'start', 'end']);
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never), value = session();
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    const held = child(root, 'lease'); children.push(held); await ready(held);
    const catalog = await storage.readHistoryCleanupCatalog(value.workspaceKey);
    assert.equal(catalog.entries[0].protectedReason, 'session_in_use');
    assert.equal((await storage.deleteHistoryCleanupTarget(catalog.entries[0], 'op')).status, 'protected');
    held.send('release'); await once(held, 'exit');
    const target = (await storage.readHistoryCleanupCatalog(value.workspaceKey)).entries[0];
    assert.equal((await storage.deleteHistoryCleanupTarget(target, 'op')).status, 'removedPendingCleanup');
    assert.deepEqual(await storage.loadWorkspaceSessions(value.workspaceKey), []);
    await assert.rejects(new SessionDeletionAuthority(vscode.Uri.file(root) as never).acquireUse(value.workspaceKey, value.id), /deleted/);
  } finally { for (const process of children) if (process.exitCode === null) process.kill(); await rm(root, { recursive: true, force: true }); }
});

test('late snapshot from a second process and index/orphan repair cannot resurrect committed deletion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-late-'));
  let stale: ChildProcess | undefined;
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never), value = session();
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    stale = child(root, 'snapshot'); await ready(stale);
    const target = (await storage.readHistoryCleanupCatalog(value.workspaceKey)).entries[0];
    const result = await storage.deleteHistoryCleanupTarget(target, 'op-late');
    assert.equal(result.status, 'removedPendingCleanup');
    stale.send('save'); await once(stale, 'exit');
    assert.deepEqual(await storage.listWorkspaceSessionSummaries(value.workspaceKey), []);
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    assert.deepEqual(await storage.loadWorkspaceSessions(value.workspaceKey), []);
    assert.equal(await storage.recoverHistoryCleanupTarget(target, 'unconfirmed-operation'), undefined);
    assert.equal((await storage.recoverHistoryCleanupTarget(target, 'op-late'))?.status, 'removedPendingCleanup');
  } finally { if (stale?.exitCode === null) stale.kill(); await rm(root, { recursive: true, force: true }); }
});

test('cleanup preview reads raw summaries and rejects normalized epoch dates and damaged paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-summary-'));
  try {
    const workspaceKey = 'workspace:cleanup';
    const directory = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspaceKey));
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 2, workspaceKey, sessions: [
      { id: 'epoch', createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z', messageCount: 1 },
      { id: 'bad', storageFile: '../../escape', messageCount: 1 }
    ] }));
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const result = await storage.readHistoryCleanupCatalog(workspaceKey);
    assert.equal(result.entries[0].updatedAtTrusted, false);
    assert.equal(result.unknown, 1);
    assert.deepEqual((await new SessionDeletionAuthority(vscode.Uri.file(root) as never).listPending()), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deletion failure before durable intent preserves history and failure after it remains pending across restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-fault-'));
  const originalRename = vscode.workspace.fs.rename;
  const originalDelete = vscode.workspace.fs.delete;
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never), value = session();
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    const target = (await storage.readHistoryCleanupCatalog(value.workspaceKey)).entries[0];
    vscode.workspace.fs.rename = async (from, to, options) => {
      if (to.path.includes('/session-deletions/v1/deleted/')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalRename(from, to, options);
    };
    assert.equal((await storage.deleteHistoryCleanupTarget(target, 'fault')).status, 'failedBeforeCommit');
    assert.equal((await storage.loadWorkspaceSessions(value.workspaceKey)).length, 1);
    vscode.workspace.fs.rename = originalRename;
    vscode.workspace.fs.delete = async (uri, options) => {
      if (/\/sessions\/[a-f0-9]{32}\.json$/u.test(uri.path)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return originalDelete(uri, options);
    };
    assert.equal((await storage.deleteHistoryCleanupTarget(target, 'fault')).status, 'removedPendingCleanup');
    assert.deepEqual(await storage.loadWorkspaceSessions(value.workspaceKey), []);
    vscode.workspace.fs.delete = originalDelete;
    const restarted = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    assert.equal((await restarted.recoverHistoryCleanupTarget(target, 'fault'))?.status, 'removedPendingCleanup');
    assert.deepEqual(await restarted.listWorkspaceSessionSummaries(value.workspaceKey), []);
  } finally { vscode.workspace.fs.rename = originalRename; vscode.workspace.fs.delete = originalDelete; await rm(root, { recursive: true, force: true }); }
});

test('a dead process use is not protected, while malformed ownership remains protected', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-death-'));
  let holder: ChildProcess | undefined;
  try {
    const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
    holder = child(root, 'lease'); await ready(holder);
    assert.equal(await authority.inspectUse('workspace:cleanup', 'fixture-session'), true);
    holder.kill(); await once(holder, 'exit');
    assert.equal(await authority.inspectUse('workspace:cleanup', 'fixture-session'), false);
    const crypto = await import('node:crypto');
    const directory = path.join(root, 'session-deletions', 'v1', 'uses', crypto.createHash('sha256').update('fixture-session').digest('hex'));
    await writeFile(path.join(directory, 'damaged.json'), '{broken');
    assert.equal(await authority.inspectUse('workspace:cleanup', 'fixture-session'), true);
  } finally { if (holder?.exitCode === null && holder.signalCode === null) holder.kill(); await rm(root, { recursive: true, force: true }); }
});

test('duplicate IDs across workspace indexes are unknown even in current-project scope', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-collision-'));
  try {
    for (const workspaceKey of ['workspace:cleanup', 'workspace:other']) {
      const directory = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspaceKey));
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 2, workspaceKey, sessions: [
        { id: 'duplicate', workspaceKey, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', messageCount: 1 }
      ] }));
    }
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const { entries } = await storage.readHistoryCleanupCatalog('workspace:cleanup');
    assert.equal(entries[0].unknownReason, 'duplicate_session_identity');
    assert.equal(await storage.revalidateHistoryCleanupTarget(entries[0]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current deletion has no inaccessible compatibility source and remains removed after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-current-'));
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never), value = session();
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    const target = (await storage.readHistoryCleanupCatalog(value.workspaceKey)).entries[0];
    const result = await storage.deleteHistoryCleanupTarget(target, 'current-op');
    assert.equal(result.status, 'removedPendingCleanup');
    const restarted = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    assert.equal(await restarted.loadSession(value.workspaceKey, value.id), undefined);
    assert.deepEqual(await restarted.listWorkspaceSessionSummaries(value.workspaceKey), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unreadable cleanup index reports an explicit diagnostic and never authorizes removal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-read-denied-'));
  const original = vscode.workspace.fs.readFile;
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never), value = session();
    await storage.saveWorkspace({ key: value.workspaceKey, name: 'Fixture', folderUris: [] }, { activeSessionId: value.id, sessions: [value] });
    vscode.workspace.fs.readFile = async uri => {
      if (uri.path.endsWith('/index.json')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return original(uri);
    };
    const catalog = await storage.readHistoryCleanupCatalog(value.workspaceKey);
    assert.ok(catalog.diagnostics.some(issue => issue.code === 'permission_denied'));
    assert.ok(catalog.unknown > 0);
    assert.equal(catalog.entries.filter(entry => !entry.unknownReason && !entry.protectedReason).length, 0);
    assert.deepEqual(await storage.deletionAuthority.listPending(), []);
  } finally { vscode.workspace.fs.readFile = original; await rm(root, { recursive: true, force: true }); }
});


test('deletion authority refuses a symlinked journal parent without writing outside storage', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-symlink-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-external-'));
  try {
    await mkdir(path.join(root, 'session-deletions', 'v1'), { recursive: true });
    await symlink(outside, path.join(root, 'session-deletions', 'v1', 'deleted'), 'dir');
    const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
    await assert.rejects(authority.isDeleted('workspace:cleanup', 'fixture-session'), /Symbolic-link/);
    await assert.rejects(authority.withSessionGate('workspace:cleanup', 'fixture-session', () => authority.commitDeletion({
      version: 1, workspaceKey: 'workspace:cleanup', sessionId: 'fixture-session', operationId: 'untrusted-link',
      confirmedAt: new Date().toISOString(), phase: 'committed'
    })), /Symbolic-link/);
    assert.deepEqual(await readdir(outside), []);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
