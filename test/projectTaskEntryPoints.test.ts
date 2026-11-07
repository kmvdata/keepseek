import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import * as vscodeStub from './stubs/vscode';
import { ProjectAssistantHost } from '../src/provider/projectAssistantHost';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SharedProjectSources } from '../src/context/sharedProjectSources';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import type { TaskDefaultsSnapshot } from '../src/tasks/projectTasks';
import type { WebviewMessage } from '../src/provider/webviewMessages';

type Transport = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null };

test('actual Host stamped legacy sendPrompt commits to the target inbox and cannot fall through a view-selected legacy Runner', async t => {
  const f = await fixture(t);
  await f.send({ type: 'projectTaskCreate', requestId: 'legacy-a', prompt: 'ENTRY_INITIAL_A', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  await f.send({ type: 'projectTaskCreate', requestId: 'legacy-b', prompt: 'ENTRY_INITIAL_B', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const [a, b] = f.host.tasks.list();
  await f.send({ type: 'projectTaskView', taskCardId: b.taskCardId, viewGeneration: 1 });
  const previousCalls = f.workers.length;
  assert.equal(await f.send({ type: 'sendPrompt', taskCardId: a.taskCardId, sessionId: a.sessionId,
    requestId: 'stamped-legacy-a', prompt: 'ENTRY_STAMPED_TARGET_A', sourceId: 'ignored-view-source', modelId: 'ignored-view-model' }), true);
  const accepted = f.posts.find(post => post.type === 'submissionResult' && post.requestId === 'stamped-legacy-a');
  assert.equal(accepted?.status, 'accepted');
  const input = f.host.tasks.findInputByRequestId('stamped-legacy-a');
  assert.ok(input); assert.equal(input.taskCardId, a.taskCardId); assert.equal(input.sessionId, a.sessionId);
  assert.notEqual(input.rootTaskId, a.rootTaskId);
  await f.host.tasks.whenIdle();
  assert.equal(f.workers.length, previousCalls + 1);
  assert.equal(f.workers.at(-1)?.body.model, 'entry-model');
  assert.equal(f.workers.at(-1)?.url, 'https://entry-fixture.invalid/v1/chat/completions');
  const aSession = await f.load(a.sessionId), bSession = await f.load(b.sessionId);
  assert.ok(aSession?.messages.some(message => message.id === input.inputId && message.content === 'ENTRY_STAMPED_TARGET_A'));
  assert.ok(!bSession?.messages.some(message => message.content === 'ENTRY_STAMPED_TARGET_A'));
  assert.equal(f.host.selectedTaskId, b.taskCardId, 'targeting A does not select it or repurpose B');
  await f.assertEveryWorkerInputTracked();
  const beforeUnstamped = f.workers.length;
  assert.equal(await f.send({ type: 'sendPrompt', sessionId: b.sessionId, requestId: 'unstamped-old-client',
    prompt: 'MUST_NOT_BYPASS_TASK_INBOX', sourceId: 'fixture', modelId: 'entry-model' }), true);
  assert.equal(f.host.tasks.findInputByRequestId('unstamped-old-client'), undefined);
  assert.equal(f.workers.length, beforeUnstamped, 'old unstamped mutation never escapes to another execution entry point');
  assert.equal(f.posts.find(post => post.type === 'submissionResult' && post.requestId === 'unstamped-old-client')?.status, 'rejected',
    'legacy submission receives a visible terminal rejection so its draft stays editable');
  assert.equal(f.routerCalls(), 0);
});

test('actual Host editUserPrompt persists its truncation target and a new root before actual same-session Runner execution', async t => {
  const f = await fixture(t);
  await f.send({ type: 'projectTaskCreate', requestId: 'edit-origin', prompt: 'ENTRY_RETAINED_FIRST_TURN', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const original = f.host.tasks.list()[0];
  await f.send({ type: 'sendPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'edit-second', prompt: 'ENTRY_OLD_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' });
  await f.host.tasks.whenIdle();
  const before = await f.load(original.sessionId);
  assert.ok(before);
  const users = before.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 2);
  const retained = { user: providerBytes(users[0]), assistant: before.messages[1].content,
    rounds: structuredClone(before.messages[1].toolRounds), replay: structuredClone(before.messages[1].providerReplay) };
  const oldRoot = users[1].userTask!.id;
  const oldSecondAnswer = before.messages.at(-1)!.id;
  assert.equal(await f.send({ type: 'editUserPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'durable-edit', messageId: users[1].id, prompt: 'ENTRY_EDITED_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' }), true);
  const input = f.host.tasks.findInputByRequestId('durable-edit');
  assert.ok(input); assert.equal(input.replaceMessageId, users[1].id); assert.notEqual(input.rootTaskId, oldRoot);
  assert.equal(input.sessionId, original.sessionId);
  assert.ok(f.posts.some(post => post.type === 'submissionResult' && post.requestId === 'durable-edit' && post.status === 'accepted'));
  await f.host.tasks.whenIdle();
  assert.equal(f.host.tasks.get(original.taskCardId)?.state, 'completed', f.host.tasks.get(original.taskCardId)?.error);
  const after = await f.load(original.sessionId);
  assert.ok(after);
  const afterUsers = after.messages.filter(message => message.role === 'user');
  assert.deepEqual(afterUsers.map(message => message.id), [users[0].id, input.inputId]);
  assert.equal(afterUsers[1].userTask?.id, input.rootTaskId);
  assert.ok(!after.messages.some(message => message.id === oldSecondAnswer));
  assert.deepEqual({ user: providerBytes(afterUsers[0]), assistant: after.messages[1].content,
    rounds: after.messages[1].toolRounds, replay: after.messages[1].providerReplay }, retained);
  const lastRequestUsers = requestUsers(f.workers.at(-1)!.body);
  assert.equal(lastRequestUsers.at(-1)?.content, providerBytes(afterUsers[1]));
  assert.ok(!lastRequestUsers.some(message => String(message.content).includes('ENTRY_OLD_SECOND_TURN')));
  const calls = f.workers.length;
  await f.send({ type: 'editUserPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'durable-edit', messageId: users[1].id, prompt: 'ENTRY_EDITED_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' });
  await f.host.tasks.whenIdle();
  assert.equal(f.workers.length, calls, 'a duplicate legacy edit ACK never truncates or sends again');
  assert.equal(f.host.tasks.inputs(original.taskCardId).filter(item => item.requestId === 'durable-edit').length, 1);
  assert.equal(f.routerCalls(), 0);
});

test('actual Host legacy abortPrompt stops its card and continueAgentTask re-enters durable recovery with the same root and segment', async t => {
  const f = await fixture(t);
  let aborted = false;
  f.workerReply = transport => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException('Controlled user cancellation', 'AbortError')); };
    if (transport.signal?.aborted) abort(); else transport.signal?.addEventListener('abort', abort, { once: true });
  });
  await f.send({ type: 'projectTaskCreate', requestId: 'abort-origin', prompt: 'ENTRY_ABORT_THEN_CONTINUE', draftRevision: 1 });
  await until(() => f.workers.length === 1, 'first real Worker request');
  const running = f.host.tasks.list()[0];
  const frozenRequest = JSON.stringify(f.workers[0].body);
  assert.equal(await f.send({ type: 'abortPrompt', taskCardId: running.taskCardId, sessionId: running.sessionId }), true);
  await f.host.tasks.whenIdle();
  assert.equal(aborted, true);
  const stopped = f.host.tasks.get(running.taskCardId)!;
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.rootTaskId, running.rootTaskId);
  assert.equal(f.workers.length, 1);
  const interrupted = await f.load(stopped.sessionId);
  const answer = interrupted?.messages.find(message => message.role === 'assistant');
  assert.ok(answer);
  f.workerReply = () => textReply('Resumed using the saved execution checkpoint.');
  assert.equal(await f.send({ type: 'continueAgentTask', taskCardId: stopped.taskCardId, sessionId: stopped.sessionId, messageId: answer.id }), true);
  await f.host.tasks.whenIdle();
  const resumed = f.host.tasks.get(stopped.taskCardId)!;
  assert.equal(resumed.state, 'completed', resumed.error);
  assert.equal(resumed.rootTaskId, stopped.rootTaskId); assert.equal(resumed.segmentId, stopped.segmentId);
  assert.ok(resumed.generation > stopped.generation);
  assert.equal(f.workers.length, 2);
  assert.equal(JSON.stringify(f.workers[1].body), frozenRequest, 'exact recovery reuses the original actual transport bytes');
  const after = await f.load(stopped.sessionId);
  const realUsers = after!.messages.filter(message => message.role === 'user');
  assert.equal(realUsers.length, 1, 'Continue does not synthesize another user message');
  assert.equal(realUsers[0].userTask?.id, stopped.rootTaskId);
  assert.ok(f.host.tasks.inputs(stopped.taskCardId).every(input => input.rootTaskId === stopped.rootTaskId));
  assert.equal(f.routerCalls(), 0);
});

test('actual Host shutdown retains a draft-save failure while aborting the active transport and reusing one rejected shutdown promise', async t => {
  const f = await fixture(t);
  let aborted = false;
  f.workerReply = transport => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException('Host shutdown cancelled this request', 'AbortError')); };
    if (transport.signal?.aborted) abort(); else transport.signal?.addEventListener('abort', abort, { once: true });
  });
  await f.send({ type: 'projectTaskCreate', requestId: 'shutdown-save-failure', prompt: 'ENTRY_SHUTDOWN_ACTIVE_TRANSPORT', draftRevision: 1 });
  await until(() => f.workers.length === 1, 'active actual Worker transport before shutdown');
  const card = f.host.tasks.list()[0];
  const calls = f.transports.length;
  const failure = new Error('Injected task draft persistence failure');
  let draftWrites = 0;
  const internals = f.host as unknown as { persistDrafts(): Promise<void> };
  const originalPersistDrafts = internals.persistDrafts;
  internals.persistDrafts = async () => { draftWrites += 1; throw failure; };
  f.expectDisposeFailure(failure);
  try {
    const firstShutdown = f.host.dispose();
    const secondShutdown = f.host.dispose();
    assert.equal(secondShutdown, firstShutdown, 'duplicate shutdown joins the original operation');
    await assert.rejects(firstShutdown, error => error instanceof AggregateError && error.errors.includes(failure));
    assert.equal(aborted, true, 'draft persistence failure must not strand a live transport');
    assert.equal(f.host.tasks.activeCount, 0);
    assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'interrupted');
    assert.equal(f.host.tasks.get(card.taskCardId)?.rootTaskId, card.rootTaskId);
    assert.equal(f.transports.length, calls, 'closing never creates another Worker or Provider request');
    assert.equal(draftWrites, 1);
    const repeated = f.host.dispose();
    assert.equal(repeated, firstShutdown);
    await assert.rejects(repeated, error => error instanceof AggregateError && error.errors.includes(failure));
    assert.equal(draftWrites, 1, 'the retained failure does not silently retry or erase the failed write');
  } finally { internals.persistDrafts = originalPersistDrafts; }
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-project-entry-'));
  const projectPath = join(directory, 'workspace'), storagePath = join(directory, 'storage'), codexPath = join(directory, 'codex');
  await Promise.all([mkdir(projectPath), mkdir(storagePath), mkdir(codexPath)]);
  const project = vscode.Uri.file(projectPath), storageUri = vscode.Uri.file(storagePath);
  const previousFolders = vscodeStub.workspace.workspaceFolders;
  const previousWindow = { ...vscodeStub.window };
  const previousStatusBarFactory = (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousFetch = globalThis.fetch;
  process.env.CODEX_HOME = codexPath;
  vscodeStub.workspace.workspaceFolders = [{ uri: project as never, name: 'Entry fixture' }];
  Object.assign(vscodeStub, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscodeStub.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const owner = await ProjectExecutionOwner.acquire({ projectUri: project, lockRoot: join(directory, 'locks') });
  assert.equal(owner.isOwner, true, owner.reason);
  const storage = new GlobalSessionStorage(storageUri);
  const store = new ChatSessionStore(storage, 'en', { key: 'entry-fixture', name: 'Entry fixture', folderUris: [project.toString()] });
  await store.initialize();
  await new ModelSourceStore(storageUri).createSource({ id: 'fixture', name: 'Entry controlled source', provider: 'openai-compatible',
    apiKey: 'controlled-test-key', baseUrl: 'https://entry-fixture.invalid/v1', models: [{ id: 'entry-model', contextWindowTokens: 64000, maxOutputTokens: 2000 }] });
  const defaults: TaskDefaultsSnapshot = { sourceId: 'fixture', modelId: 'entry-model', wireModel: 'entry-model',
    endpoint: 'https://entry-fixture.invalid/v1', protocol: 'openai-compatible', rootUri: project.toString(), cwdUri: project.toString(),
    approvalMode: 'ask', executionMode: 'normal', skillIds: [], configuration: { settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' } } };
  const sources = new SharedProjectSources();
  const posts: Array<Record<string, unknown>> = [], workers: Transport[] = [], transports: Transport[] = [];
  let workerReply: (transport: Transport) => Response | Promise<Response> = () => textReply('Controlled Worker answer.');
  globalThis.fetch = (async (url, init) => {
    assert.equal(typeof init?.body, 'string', 'every fixture request must be an inspectable actual Provider payload');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const transport = { url: String(url), body, signal: init?.signal };
    transports.push(transport);
    if (body.tools) { workers.push(transport); return workerReply(transport); }
    return textReply('{"decision":"defer","title":null}');
  }) as typeof fetch;
  const host = new ProjectAssistantHost({ owner, resources: new ProjectResourceCoordinator(owner.projectId), admission: new ProjectRequestAdmission(), sources,
    windowId: 'entry-fixture', extensionUri: storageUri, storageUri, sessionStore: store,
    skillState: { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    extensionInfo: { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    defaults: () => structuredClone(defaults), publish: value => posts.push(value as Record<string, unknown>) });
  await host.initialize();
  let expectedDisposeFailure: Error | undefined;
  t.after(async () => {
    try {
      await host.dispose().catch(error => {
        if (!expectedDisposeFailure || !(error instanceof AggregateError) || !error.errors.includes(expectedDisposeFailure)) throw error;
      });
      await storage.flush(); await owner.dispose(); sources.dispose();
    }
    finally {
      globalThis.fetch = previousFetch; vscodeStub.workspace.workspaceFolders = previousFolders; Object.assign(vscodeStub.window, previousWindow);
      if (previousStatusBarFactory === undefined) delete (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
      if (previousAlignment === undefined) delete (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
      else Object.assign(vscodeStub, { StatusBarAlignment: previousAlignment });
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      await rm(directory, { recursive: true, force: true });
    }
  });
  const load = async (sessionId: string) => {
    const scope = await store.findSessionScope(sessionId); assert.ok(scope);
    return (await store.createWorkspaceScope(scope)).loadSessionById(sessionId);
  };
  return { host, posts, workers, transports, load,
    expectDisposeFailure: (error: Error) => { expectedDisposeFailure = error; },
    get workerReply() { return workerReply; }, set workerReply(value: (transport: Transport) => Response | Promise<Response>) { workerReply = value; },
    send: (message: Record<string, unknown>) => host.handleMessage({ projectId: owner.projectId, ...message } as unknown as WebviewMessage),
    routerCalls: () => transports.filter(item => String(JSON.stringify(item.body.tools)).includes('keepseek_tasks_create')).length,
    assertEveryWorkerInputTracked: async () => {
      const sessions = await Promise.all(host.tasks.list().map(card => load(card.sessionId)));
      const inputs = sessions.flatMap(session => session?.messages.filter(message => message.role === 'user').map(providerBytes) ?? []);
      for (const transport of workers) assert.ok(inputs.includes(String(requestUsers(transport.body).at(-1)?.content)), 'actual Worker transport must point to a real durable task input');
    }
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function requestUsers(body: Record<string, unknown>): Array<{ role: string; content: unknown }> {
  return (body.messages as Array<{ role: string; content: unknown }>).filter(message => message.role === 'user');
}
function providerBytes(message: { content: string; expandedContent?: string; providerContent?: string }): string {
  return (message.providerContent ?? message.expandedContent ?? message.content).trim();
}
function textReply(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}
