import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/case';

interface StartupHost {
  initializeAfterWebviewReady(): Promise<void>;
  commandSettingsReadiness: Record<string, string>;
  getStartupState(): { phase: string };
  interactionSnapshot(revision: number): { failure?: string };
  dispose(): void;
}

interface Harness {
  host: StartupHost;
  storage: GlobalSessionStorage;
  posts: Array<Record<string, unknown>>;
  dispose(): Promise<void>;
}

async function withHost<T>(work: () => Promise<T>): Promise<T> {
  const previousWindow = { ...vscode.window };
  const previousIsTrusted = vscode.workspace.isTrusted;
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousWarn = console.warn;
  const previousError = console.error;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  console.warn = () => undefined;
  console.error = () => undefined;
  try { return await work(); } finally {
    Object.assign(vscode.window, previousWindow);
    Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: previousIsTrusted });
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    console.warn = previousWarn; console.error = previousError;
  }
}

/** Exactly what extension.ts does: the already-started store initialization
 * Promise is handed to the provider. */
async function startProvider(root: string): Promise<Harness> {
  const uri = vscode.Uri.file(root);
  const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize({ fresh: true });
  await initialization.catch(() => undefined);
  const provider = new KeepseekChatViewProvider(
    uri as never,
    sessionStore,
    uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  const host = provider as unknown as StartupHost & { views?: Set<unknown> };
  const posts: Array<Record<string, unknown>> = [];
  host.views?.add({ webview: { postMessage(message: Record<string, unknown>) { posts.push(message); return Promise.resolve(true); } } });
  return {
    host, storage, posts,
    async dispose() {
      (provider as unknown as { dispose(): void }).dispose();
      await storage.flush().catch(() => undefined);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

async function seedActiveSession(root: string): Promise<string> {
  const uri = vscode.Uri.file(root);
  const storage = new GlobalSessionStorage(uri as never);
  const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages.push({ id: 'message-1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as never);
  session.title = 'Existing conversation';
  await store.persist();
  await storage.flush();
  return session.id;
}

/** A lease whose owning process is gone: what a crash or a killed extension
 * host leaves behind between restarts. */
async function writeStaleUseRecord(root: string, sessionId: string): Promise<void> {
  const directory = path.join(root, 'session-deletions', 'v1', 'uses', createHash('sha256').update(sessionId).digest('hex'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'stale-0000.json'), JSON.stringify({
    version: 1, pid: 0x7ffffff, token: 'stale-0000', workspaceKey: SCOPE_KEY, sessionId
  }));
}

function sessionShardPath(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'sessions', `${hash}.json`);
}

test('startup succeeds when recovery only probes storage paths that do not exist', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-missing-'));
  const sessionId = await seedActiveSession(root);
  await writeStaleUseRecord(root, sessionId);
  await withHost(async () => {
    const h = await startProvider(root);
    t.after(() => h.dispose());
    await h.host.initializeAfterWebviewReady();
    assert.equal(h.host.commandSettingsReadiness.executionMode, 'ready', 'session loading must not fail');
    assert.notEqual(h.host.interactionSnapshot(1).failure, 'Session loading failed. Reload the window to retry.');
    assert.notEqual(h.host.getStartupState().phase, 'startup-error');
  });
});

test('history cleanup removes the shard it reports as removed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-cleanup-shard-'));
  const sessionId = await seedActiveSession(root);
  await withHost(async () => {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const catalog = await storage.readHistoryCleanupCatalog(SCOPE_KEY);
    const target = catalog.entries.find(entry => entry.id === sessionId);
    assert.ok(target, 'the seeded session is in the cleanup catalog');
    const result = await storage.deleteHistoryCleanupTarget(target, 'operation-1');
    assert.equal(result.status, 'removedPendingCleanup', 'cleanup must commit: ' + JSON.stringify(result));
    await assert.rejects(readFile(sessionShardPath(root, sessionId)), 'the deleted shard must be gone');
  });
});

test('reading a workspace index never rewrites it', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-index-read-'));
  await seedActiveSession(root);
  // A committed tombstone whose record the reader may not parse must drop only
  // that session; filtering is a read and must not rewrite the index.
  const deletions = path.join(root, 'session-deletions', 'v1', 'deleted');
  await mkdir(deletions, { recursive: true });
  const ghost = 'ghost-session-id';
  await writeFile(path.join(deletions, `${createHash('sha256').update(ghost).digest('hex')}.json`), JSON.stringify({
    version: 1, workspaceKey: SCOPE_KEY, sessionId: ghost, operationId: 'op', confirmedAt: new Date().toISOString(), phase: 'committed'
  }));
  const indexUri = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'index.json');
  const before = await readFile(indexUri, 'utf8');
  await withHost(async () => {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    await storage.loadWorkspaceSessions(SCOPE_KEY);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(await readFile(indexUri, 'utf8'), before, 'listing history must not rewrite the index');
});