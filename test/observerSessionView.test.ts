import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import * as vscodeStub from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import { ChatSessionStore, type SessionViewPageOptions } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import type { ChatMessage } from '../src/shared/types';

type Post = { type?: string; requestId?: string; sessionId?: string; status?: string; reason?: string;
  running?: boolean; outcome?: string;
  revision?: number; state?: { activeSessionId?: string; messages?: ChatMessage[]; hasOlderMessages?: boolean;
    interaction?: { canEdit?: boolean; canSubmit?: boolean; canNavigate?: boolean } } };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('actual read-only Parent Provider pages legacy history 30 to 80 to 120 and ready reuses it without writes or requests', async t => {
  const f = await fixture(t);
  const view = f.store.viewSessionPage.bind(f.store);
  let pageReads = 0;
  f.store.viewSessionPage = async (sessionId, options) => { pageReads++; return view(sessionId, options); };
  await f.send({ type: 'selectSession', sessionId: f.b.id });
  assert.equal(f.lastState().activeSessionId, f.b.id);
  assert.equal(f.lastState().messages?.length, 30);
  await f.send({ type: 'selectSession', sessionId: f.a.id });
  assert.deepEqual(f.lastState().messages?.map(message => message.id), f.a.messages.slice(90).map(message => message.id));
  assert.equal(f.lastState().hasOlderMessages, true);
  await f.send({ type: 'loadOlderMessages' });
  assert.deepEqual(f.lastState().messages?.map(message => message.id), f.a.messages.slice(40).map(message => message.id));
  assert.equal(f.lastState().messages?.length, 80);
  await f.send({ type: 'loadOlderMessages' });
  assert.deepEqual(f.lastState().messages?.map(message => message.id), f.a.messages.map(message => message.id));
  assert.equal(f.lastState().messages?.length, 120);
  assert.equal(new Set(f.lastState().messages?.map(message => message.id)).size, 120);
  assert.equal(f.lastState().hasOlderMessages, false);
  const beforeReady = pageReads;
  await f.send({ type: 'ready' });
  assert.equal(pageReads, beforeReady, 'ready republishes the accumulated view rather than rereading the latest page');
  assert.equal(f.lastState().messages?.length, 120);
  assert.equal(f.lastState().interaction?.canEdit, true);
  assert.equal(f.lastState().interaction?.canSubmit, false);
  assert.equal(f.lastState().interaction?.canNavigate, true);
  await f.send({ type: 'sendPrompt', requestId: 'observer-stale-send', sessionId: f.b.id,
    prompt: 'This old page must receive an explicit rejection.', sourceId: 'unavailable', modelId: 'unavailable' });
  const acknowledgement = f.posts.find(post => post.type === 'submissionResult' && post.requestId === 'observer-stale-send');
  assert.equal(acknowledgement?.status, 'rejected');
  assert.equal(acknowledgement?.sessionId, f.b.id);
  assert.ok(acknowledgement?.reason, 'the rejected old submission retains a visible explanation and its draft');
  await f.send({ type: 'regenerateSessionTitle', requestId: 'observer-stale-title', sessionId: f.b.id });
  const title = f.posts.filter(post => post.type === 'sessionTitleRegeneration' && post.requestId === 'observer-stale-title');
  assert.equal(title.length, 1);
  assert.equal(title[0].sessionId, f.b.id);
  assert.equal(title[0].running, false);
  assert.equal(title[0].outcome, 'unavailable');
  assert.ok(title[0].reason);
  await f.assertReadOnly();
});

test('actual read-only Parent Provider rejects A to B to A late pages and overlapping earlier-page delivery without duplicates', async t => {
  const f = await fixture(t);
  const view = f.store.viewSessionPage.bind(f.store);
  const oldAReady = deferred(), releaseOldA = deferred();
  const earlierReady = deferred(), releaseEarlierOne = deferred(), releaseEarlierTwo = deferred();
  f.cleanup(() => { releaseOldA.resolve(); releaseEarlierOne.resolve(); releaseEarlierTwo.resolve(); });
  let aReads = 0, earlierReads = 0, gateEarlier = false;
  f.store.viewSessionPage = async (sessionId: string, options: SessionViewPageOptions = {}) => {
    const page = await view(sessionId, options);
    if (sessionId === f.a.id && options.before === undefined && ++aReads === 1) {
      oldAReady.resolve(); await releaseOldA.promise;
    } else if (gateEarlier && options.before === 90) {
      const request = ++earlierReads;
      if (request === 2) earlierReady.resolve();
      await (request === 1 ? releaseEarlierOne.promise : releaseEarlierTwo.promise);
    }
    return page;
  };
  const oldA = f.send({ type: 'selectSession', sessionId: f.a.id });
  await oldAReady.promise;
  await f.send({ type: 'selectSession', sessionId: f.b.id });
  await f.send({ type: 'selectSession', sessionId: f.a.id });
  const latestRevision = f.posts.at(-1)?.revision, postCount = f.posts.length;
  releaseOldA.resolve(); await oldA;
  assert.equal(f.posts.length, postCount, 'the first A read cannot publish into the second A generation');
  assert.equal(f.posts.at(-1)?.revision, latestRevision);
  assert.equal(f.lastState().messages?.length, 30);
  gateEarlier = true;
  const one = f.send({ type: 'loadOlderMessages' }), two = f.send({ type: 'loadOlderMessages' });
  await earlierReady.promise;
  releaseEarlierOne.resolve(); await one;
  assert.equal(f.lastState().messages?.length, 80);
  const afterOne = f.posts.length;
  releaseEarlierTwo.resolve(); await two;
  assert.equal(f.posts.length, afterOne, 'the second identical earlier page is rejected after the first applies');
  assert.equal(new Set(f.lastState().messages?.map(message => message.id)).size, 80);
  gateEarlier = false;
  await f.send({ type: 'loadOlderMessages' }); await f.send({ type: 'ready' });
  assert.deepEqual(f.lastState().messages?.map(message => message.id), f.a.messages.map(message => message.id));
  assert.equal(f.lastState().messages?.length, 120);
  await f.assertReadOnly();
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-observer-view-'));
  const projectPath = join(directory, 'project'), dataPath = join(directory, 'storage');
  await Promise.all([mkdir(projectPath), mkdir(dataPath)]);
  const project = vscode.Uri.file(projectPath), data = vscode.Uri.file(dataPath);
  const scope = { key: 'observer-legacy-fixture', name: 'Observer fixture', folderUris: [project.toString()] };
  const seedStorage = new GlobalSessionStorage(data), seed = new ChatSessionStore(seedStorage, 'en', scope);
  await seed.initialize(); await seed.setApprovalMode('delegate');
  const a = seed.getActiveSession(); a.messages = messages('A', 120); a.contextInstructions = 'Exact frozen A context\n  untouched'; await seed.persist();
  const b = await seed.createDetachedSession({ title: 'Old B', approvalMode: 'ask', executionMode: 'plan',
    contextInstructions: 'Exact frozen B context\n untouched', messages: messages('B', 80) });
  await seedStorage.flush();
  const lockRoot = join(directory, 'locks');
  const owner = await ProjectExecutionOwner.acquire({ projectUri: project, lockRoot });
  const observer = await ProjectExecutionOwner.acquire({ projectUri: project, lockRoot });
  assert.equal(owner.isOwner, true); assert.equal(observer.isOwner, false);
  const storage = new GlobalSessionStorage(data); storage.setReadOnly(true);
  const store = new ChatSessionStore(storage, 'en', scope); store.setReadOnly(true); await store.initialize();
  const activeBefore = store.activeSessionId, modeBefore = store.approvalMode, historyBefore = JSON.stringify(store.getActiveSession());
  const diskBefore = await diskSnapshot(dataPath);
  const previousWindow = { ...vscodeStub.window };
  const previousFactory = (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscodeStub, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscodeStub.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const provider = new KeepseekChatViewProvider(data, store, data,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    Promise.resolve(), undefined, { owner: observer, resources: new ProjectResourceCoordinator(observer.projectId), admission: new ProjectRequestAdmission(), windowId: 'read-only-fixture' });
  const posts: Post[] = [];
  // Exercise the exact Parent Webview listener; handleProjectMessage is the
  // separate headless-Worker entry and intentionally performs initialization.
  const host = provider as unknown as {
    views: Set<{ webview: { postMessage(value: Post): Promise<boolean> } }>;
    handleMessage(message: WebviewMessage): Promise<void>; projectAssistant?: unknown;
  };
  host.views.add({ webview: { postMessage(value: Post) { posts.push(value); return Promise.resolve(true); } } });
  const previousFetch = globalThis.fetch;
  let requests = 0, writes = 0;
  globalThis.fetch = async () => { requests++; throw new Error('Read-only session views must never call a Provider.'); };
  const originals = { ...vscodeStub.workspace.fs };
  const isOwn = (uri: { fsPath: string }) => uri.fsPath === dataPath || uri.fsPath.startsWith(dataPath + sep);
  vscodeStub.workspace.fs.writeFile = async (uri, bytes) => { if (isOwn(uri)) writes++; return originals.writeFile(uri, bytes); };
  vscodeStub.workspace.fs.createDirectory = async uri => { if (isOwn(uri)) writes++; return originals.createDirectory(uri); };
  vscodeStub.workspace.fs.rename = async (from, to, options) => { if (isOwn(from) || isOwn(to)) writes++; return originals.rename(from, to, options); };
  vscodeStub.workspace.fs.delete = async (uri, options) => { if (isOwn(uri)) writes++; return originals.delete(uri, options); };
  const cleanups: Array<() => void> = [];
  t.after(async () => {
    cleanups.forEach(cleanup => cleanup()); provider.dispose();
    Object.assign(vscodeStub.workspace.fs, originals); globalThis.fetch = previousFetch;
    Object.assign(vscodeStub.window, previousWindow);
    if (previousFactory === undefined) delete (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
    if (previousAlignment === undefined) delete (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscodeStub, { StatusBarAlignment: previousAlignment });
    await observer.dispose(); await owner.dispose(); await rm(directory, { recursive: true, force: true });
  });
  return { provider, store, a, b, posts, cleanup: (callback: () => void) => cleanups.push(callback),
    send: (message: WebviewMessage) => host.handleMessage(message),
    lastState: () => { const state = posts.filter(post => post.type === 'state' && post.state).at(-1)?.state; assert.ok(state); return state; },
    assertReadOnly: async () => {
      assert.equal(store.activeSessionId, activeBefore); assert.equal(store.approvalMode, modeBefore);
      assert.equal(JSON.stringify(store.getActiveSession()), historyBefore);
      assert.equal(host.projectAssistant, undefined, 'pure observer legacy views do not initialize task ViewState');
      assert.equal(requests, 0); assert.equal(writes, 0);
      assert.deepEqual(await diskSnapshot(dataPath), diskBefore, 'all authoritative session bytes and files remain unchanged');
    }
  };
}

function messages(prefix: string, count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `${prefix} historical message ${index}`, createdAt: new Date(index * 1000).toISOString() }));
}
async function diskSnapshot(directory: string): Promise<Array<[string, string]>> {
  const result: Array<[string, string]> = [];
  const visit = async (current: string) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push([target.slice(directory.length), createHash('sha256').update(await readFile(target)).digest('hex')]);
    }
  };
  await visit(directory); return result.sort(([a], [b]) => a.localeCompare(b));
}
