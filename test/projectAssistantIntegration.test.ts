import './registerVscodeStub';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import * as vscodeStub from './stubs/vscode';
import { ProjectAssistantHost } from '../src/provider/projectAssistantHost';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import type { ProjectTaskCard, ProjectTaskService, TaskDefaultsSnapshot } from '../src/tasks/projectTasks';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import { SharedProjectSources } from '../src/context/sharedProjectSources';
import type { ModelSourceProvider } from '../src/accounts/types';
import { UsageLedgerStore } from '../src/agent/usageLedgerStore';
import type { ChatSession, ProviderUsageLedgerRecord } from '../src/shared/types';

interface PhysicalCapture {
  body: Record<string, unknown>;
  rawBody: string;
  startMs: number;
  endMs?: number;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('actual Host and two independent Provider/Runner containers keep A and B running across views and durable direct input', async t => {
  const f = await fixture(t);
  const aResponse = deferred<Response>(), bResponse = deferred<Response>();
  f.cleanup(() => { aResponse.resolve(textReply('A finished.')); bResponse.resolve(textReply('B finished.')); });
  const bodies: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body); bodies.push(body);
    const bytes = JSON.stringify(body);
    if (body.tools && bytes.includes('INDEPENDENT_TASK_A')) return f.capture(body, aResponse.promise);
    if (body.tools && bytes.includes('INDEPENDENT_TASK_B')) return f.capture(body, bResponse.promise);
    return f.capture(body, titleReply());
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectTaskCreate', requestId: 'create-a', prompt: 'INDEPENDENT_TASK_A', draftRevision: 1 });
  await f.send({ type: 'projectTaskCreate', requestId: 'create-b', prompt: 'INDEPENDENT_TASK_B', draftRevision: 1 });
  await until(() => bodies.filter(body => JSON.stringify(body).includes('INDEPENDENT_TASK_')).length === 2, 'two live actual Worker requests');
  const [a, b] = f.host.tasks.list();
  assert.ok(a && b && a.sessionId !== b.sessionId);
  assert.ok(f.posts.some(post => post.type === 'projectTaskSubmissionResult' && post.requestId === 'create-a' && post.status === 'accepted'));
  assert.ok(f.posts.some(post => post.type === 'projectTaskSubmissionResult' && post.requestId === 'create-b' && post.status === 'accepted'));
  assert.equal(bodies.some(body => JSON.stringify(body).includes('keepseek_tasks_create')), false, 'explicit new tasks never classify through Router');
  const callsBeforeViews = bodies.length;
  await f.send({ type: 'projectTaskView', taskCardId: a.taskCardId, viewGeneration: 1 });
  await f.send({ type: 'projectTaskView', taskCardId: b.taskCardId, viewGeneration: 2 });
  await f.send({ type: 'projectTaskView', mode: 'project', viewGeneration: 3 });
  await f.send({ type: 'projectTaskPrefetch', taskCardId: a.taskCardId });
  await f.send({ type: 'ready' });
  assert.equal(bodies.length, callsBeforeViews, 'view navigation and prefetch issue no model requests');
  assert.equal(f.host.tasks.get(a.taskCardId)?.state, 'running');
  assert.equal(f.host.tasks.get(b.taskCardId)?.state, 'running');
  aResponse.resolve(textReply('A finished.')); bResponse.resolve(textReply('B finished.'));
  await f.host.tasks.whenIdle();
  assert.deepEqual(f.host.tasks.list().map(card => card.state), ['completed', 'completed']);
  const aSession = await f.loadSession(a.sessionId), bSession = await f.loadSession(b.sessionId);
  assert.ok(aSession?.messages.some(message => message.content === 'A finished.'));
  assert.ok(bSession?.messages.some(message => message.content === 'B finished.'));
  assert.ok(!aSession?.messages.some(message => message.content === 'B finished.'));
  assert.ok(!bSession?.messages.some(message => message.content === 'A finished.'));
  assert.notEqual(aSession?.messages.find(message => message.role === 'user')?.userTask?.id,
    bSession?.messages.find(message => message.role === 'user')?.userTask?.id);
  await f.evidence('same-workload-parallel-two-workers', { workers: 2, explicitInputRouterClassificationCalls: 0, viewTriggeredCalls: 0 });
});

test('actual Host sequentially executes the same independent A/B workload for request evidence comparison', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body);
    const a = JSON.stringify(body).includes('INDEPENDENT_TASK_A');
    return f.capture(body, body.tools ? textReply(a ? 'A finished.' : 'B finished.') : titleReply());
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  for (const name of ['A', 'B']) {
    await f.send({ type: 'projectTaskCreate', requestId: `sequential-${name}`, prompt: `INDEPENDENT_TASK_${name}`, draftRevision: 1 });
    await f.host.tasks.whenIdle();
  }
  assert.deepEqual(f.host.tasks.list().map(card => card.state), ['completed', 'completed']);
  assert.equal(f.transports.filter(item => item.body.tools).length, 2);
  assert.equal(f.transports.some(item => String(JSON.stringify(item.body.tools)).includes('keepseek_tasks_create')), false);
  await f.evidence('same-workload-sequential-two-workers', { workers: 1, explicitInputRouterClassificationCalls: 0 });
});

test('actual hot task retains its model and endpoint until an explicit task-scoped model switch', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  const main: Array<{ body: Record<string, unknown>; url: string }> = [];
  globalThis.fetch = (async (url, init) => {
    const body = f.decode(init?.body);
    if (body.tools) main.push({ body, url: String(url) });
    return f.capture(body, body.tools ? textReply(`Completed with ${String(body.model)}.`) : titleReply());
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectTaskCreate', requestId: 'model-original', prompt: 'MODEL_FREEZE_ORIGINAL', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const card = f.host.tasks.list()[0];
  await f.sourceStore.updateSource('fixture', { baseUrl: 'https://changed.fixture.invalid/v1', models: [
    { id: 'fixture-model', contextWindowTokens: 64000, maxOutputTokens: 2000 },
    { id: 'explicit-next-model', contextWindowTokens: 64000, maxOutputTokens: 2000 }
  ] });
  await f.send({ type: 'projectTaskSubmit', taskCardId: card.taskCardId, requestId: 'model-frozen-followup', inputKind: 'followup',
    prompt: 'Continue after the project defaults changed.', draftRevision: 2 });
  await f.host.tasks.whenIdle();
  assert.equal(main.length, 2);
  assert.deepEqual(main.map(request => request.body.model), ['fixture-model', 'fixture-model']);
  assert.ok(main.every(request => request.url.startsWith('https://fixture.invalid/v1/')));
  assert.deepEqual(providerStaticPrefix(main[1].body), providerStaticPrefix(main[0].body));
  assert.deepEqual(providerUserMessages(main[1].body)[0], providerUserMessages(main[0].body)[0]);
  await f.send({ type: 'setSelectedModel', taskCardId: card.taskCardId, sessionId: card.sessionId,
    requestId: 'explicit-task-model-switch', sourceId: 'fixture', modelId: 'explicit-next-model' });
  await until(() => f.host.tasks.get(card.taskCardId)?.snapshot.modelId === 'explicit-next-model', 'explicit model lane snapshot');
  await f.send({ type: 'projectTaskSubmit', taskCardId: card.taskCardId, requestId: 'model-explicit-followup', inputKind: 'followup',
    prompt: 'Continue using the model I explicitly selected.', draftRevision: 3 });
  await f.host.tasks.whenIdle();
  assert.equal(main.length, 3);
  assert.equal(main[2].body.model, 'explicit-next-model');
  assert.ok(main[2].url.startsWith('https://changed.fixture.invalid/v1/'));
  assert.equal(f.host.tasks.get(card.taskCardId)?.sessionId, card.sessionId);
  await f.evidence('hot-worker-frozen-defaults-and-explicit-model-boundary', {
    implicitModelMigrations: 0, frozenFollowupPrefixUnchanged: true, explicitControlledLaneChange: true, directInputRouterClassificationCalls: 0 });
});

test('actual A approval wait releases workspace resources while B completes and task-bound Apply stays with A from B view', async t => {
  const f = await fixture(t);
  const originalFetch = globalThis.fetch;
  let aCalls = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body);
    if (!body.tools) return f.capture(body, titleReply());
    const a = JSON.stringify(body).includes('APPROVAL_TASK_A');
    if (a && ++aCalls === 1) return f.capture(body, toolsReply([
      { id: 'approved-a-proposal', name: 'keepseek_create_draft_edit', args: { path: 'approved-a.txt', content: 'approved A\n', reason: 'Create the exact requested A result.' } },
      { id: 'stale-a-proposal', name: 'keepseek_create_draft_edit', args: { path: 'stale-a.txt', content: 'proposed stale A\n', reason: 'Modify the second A result only against its approved content hash.' } }
    ]));
    return f.capture(body, textReply(a ? 'A has two pending file changes for review.' : 'B independently completed.'));
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  const stalePath = join(f.directory, 'workspace', 'stale-a.txt');
  await writeFile(stalePath, 'Original fixture baseline.\n');
  await f.send({ type: 'projectTaskCreate', requestId: 'ask-a', prompt: 'APPROVAL_TASK_A create approved-a.txt and modify stale-a.txt as pending drafts.', draftRevision: 1 });
  const a = f.host.tasks.list()[0];
  await f.send({ type: 'projectTaskView', taskCardId: a.taskCardId, viewGeneration: 1 });
  await until(() => f.host.tasks.get(a.taskCardId)?.state === 'waiting', 'A waiting for actual Apply approval');
  const states = f.posts.filter(post => post.taskCardId === a.taskCardId && post.state).map(post => post.state as {
    changeSets?: Array<{ files: Array<{ id: string; label: string; status: string }> }>;
  });
  const changes = states.flatMap(state => state.changeSets ?? []).at(-1);
  const approved = changes?.files.find(file => file.label === 'approved-a.txt');
  const stale = changes?.files.find(file => file.label === 'stale-a.txt');
  assert.ok(approved && stale);
  assert.equal(approved.status, 'pending');
  assert.equal((f.host as unknown as { options: { resources: ProjectResourceCoordinator } }).options.resources.activeScope, undefined,
    'no mutation/validation lease is held across a human answer');
  await f.send({ type: 'projectTaskCreate', requestId: 'ask-b', prompt: 'APPROVAL_TASK_B finish a read-only response.', draftRevision: 1 });
  const b = f.host.tasks.list().find(card => card.taskCardId !== a.taskCardId)!;
  await until(() => f.host.tasks.get(b.taskCardId)?.state === 'completed', 'independent B completion while A waits');
  assert.equal(f.host.tasks.get(a.taskCardId)?.state, 'waiting');
  await f.send({ type: 'projectTaskView', taskCardId: b.taskCardId, viewGeneration: 2 });
  const externalContent = 'External process changed the approved content hash.\n';
  await writeFile(stalePath, externalContent);
  await f.send({ type: 'applyDraftEdit', taskCardId: a.taskCardId, sessionId: a.sessionId,
    id: stale.id, requestId: 'stale-a-approval' });
  assert.equal(await readFile(stalePath, 'utf8'), externalContent);
  assert.ok(f.posts.some(post => post.type === 'changeActionFeedback' && post.requestId === 'stale-a-approval'
    && post.phase === 'failed'), 'stale content hash is visibly refused before replacement');
  await f.send({ type: 'applyDraftEdit', taskCardId: a.taskCardId, sessionId: a.sessionId,
    id: approved.id, requestId: 'approve-a-from-b' });
  const approvedPath = join(f.directory, 'workspace', 'approved-a.txt');
  assert.equal(await readFile(approvedPath, 'utf8'), 'approved A\n');
  const appliedIdentity = await stat(approvedPath, { bigint: true });
  await f.send({ type: 'applyDraftEdit', taskCardId: a.taskCardId, sessionId: a.sessionId,
    id: approved.id, requestId: 'repeat-approve-a-from-b' });
  const afterDuplicate = await stat(approvedPath, { bigint: true });
  assert.equal(afterDuplicate.ino, appliedIdentity.ino, 'duplicate approval cannot atomically replace a completed edit');
  assert.equal(afterDuplicate.mtimeNs, appliedIdentity.mtimeNs, 'duplicate approval cannot rewrite a completed edit');
  await until(() => f.host.tasks.activeCount === 0, 'A approval settlement');
  assert.equal(f.host.selectedTaskId, b.taskCardId);
  assert.equal(f.host.tasks.get(b.taskCardId)?.state, 'completed');
  const bSession = await f.loadSession(b.sessionId);
  assert.ok(bSession?.messages.some(message => message.content === 'B independently completed.'));
  assert.ok(!bSession?.messages.some(message => message.content.includes('pending file changes')));
  assert.ok(f.posts.some(post => post.type === 'changeActionFeedback' && post.taskCardId === a.taskCardId
    && post.requestId === 'approve-a-from-b' && post.phase === 'complete'), 'background target gets a bound terminal approval ACK');
  await f.evidence('task-bound-approval-and-stale-baseline-from-other-view', {
    waitingAAllowsBCompletion: true, waitingHoldsWorkspaceLease: false, duplicateApplyWrites: 0,
    staleBaselineOverwrites: 0, approvalTargetRemainsA: true, preexistingBaselineFiles: 1 });
});

test('actual project Router dispatches a durable task handle before Worker completion, and Router failure preserves the Worker', async t => {
  const f = await fixture(t);
  const workerResponse = deferred<Response>(); f.cleanup(() => workerResponse.resolve(textReply('Worker survived.')));
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  let routerRequests = 0, failRouter = false;
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body); bodies.push(body);
    if (String(JSON.stringify(body.tools)).includes('keepseek_tasks_create')) {
      routerRequests++;
      if (failRouter) return f.capture(body, new Response('{"error":{"message":"controlled Router failure"}}', { status: 400 }));
      return f.capture(body, routerRequests === 1 ? toolReply('router-dispatch', 'keepseek_tasks_create', { content: 'ROUTED_WORKER_TASK' })
        : textReply('The task has been queued.'));
    }
    return f.capture(body, body.tools ? workerResponse.promise : titleReply());
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectAssistantSubmit', requestId: 'free-project-input', prompt: 'Please arrange a documentation review.', draftRevision: 1 });
  const routers = (f.host as unknown as { routerTasks: ProjectTaskService }).routerTasks;
  await until(() => routerRequests === 2 && routers.list()[0]?.state === 'completed' && f.host.tasks.list()[0]?.state === 'running', 'Router returned while Worker remains in flight');
  const worker = f.host.tasks.list()[0];
  assert.ok(worker);
  assert.ok(f.posts.some(post => post.type === 'projectTaskSubmissionResult' && post.requestId === 'free-project-input' && post.status === 'accepted'));
  const routerCalls = bodies.filter(body => String(JSON.stringify(body.tools)).includes('keepseek_tasks_create'));
  assert.equal(routerCalls.length, 2);
  assert.ok(routerCalls.every(body => !JSON.stringify(body.tools).includes('keepseek_run_draft')));
  assert.ok(JSON.stringify(routerCalls[1]).includes(worker.taskCardId), 'second actual Router request carries the durable Worker handle');
  const beforeView = bodies.length;
  await f.send({ type: 'projectTaskView', taskCardId: worker.taskCardId, viewGeneration: 10 });
  await f.send({ type: 'projectTaskView', mode: 'project', viewGeneration: 11 });
  assert.equal(bodies.length, beforeView);
  failRouter = true;
  await f.send({ type: 'projectAssistantSubmit', requestId: 'failed-router-input', prompt: 'What is the latest progress?', draftRevision: 2 });
  await until(() => ['failed', 'interrupted'].includes(routers.list()[0]?.state ?? ''), 'failed Router terminal state');
  assert.ok(routers.list()[0]?.error, 'the failed Router input retains a visible recovery explanation');
  assert.equal(f.host.tasks.get(worker.taskCardId)?.state, 'running', 'Router failure does not cancel another runtime');
  const routerCallsBeforeCompletion = routerRequests;
  workerResponse.resolve(textReply('Worker survived.'));
  await f.host.tasks.whenIdle();
  assert.equal(f.host.tasks.get(worker.taskCardId)?.state, 'completed');
  assert.equal(f.host.tasks.events().at(-1)?.content, 'Worker survived.');
  assert.equal(routerRequests, routerCallsBeforeCompletion, 'durable completion publishes a structured result without waking Router');
  await f.evidence('project-router-durable-dispatch-and-isolated-failure', { routerSemanticTurns: 2,
    firstTurnPhysicalCalls: 2, completionTriggeredRouterCalls: 0, workerSurvivesRouterFailure: true });
});

for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
  test(`actual Host durable supplement uses the same root and a new fully paired ${provider} segment`, async t => {
    const f = await fixture(t, provider);
    const original = deferred<Response>(); f.cleanup(() => original.resolve(nativeTextReply(provider, 'Original settled.')));
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      const body = f.decode(init?.body);
      if (!body.tools) return f.capture(body, nativeTextReply(provider, '{"decision":"defer","title":null}'));
      bodies.push(body);
      return f.capture(body, bodies.length === 1 ? original.promise : nativeTextReply(provider, 'Supplement incorporated.'));
    }) as typeof fetch;
    f.afterDispose(() => { globalThis.fetch = originalFetch; });
    await f.send({ type: 'projectTaskCreate', requestId: 'supplement-original', prompt: 'SUPPLEMENT_FIXTURE list workspace files', draftRevision: 1 });
    await until(() => bodies.length === 1, 'original actual Provider request');
    const card = f.host.tasks.list()[0], oldRoot = card.rootTaskId;
    const frozenRequest = JSON.stringify(bodies[0]);
    await f.send({ type: 'projectTaskSubmit', taskCardId: card.taskCardId, requestId: 'supplement-durable',
      rootTaskId: oldRoot, inputKind: 'supplement', prompt: 'REAL_SUPPLEMENT: keep the prior cache prefix.', draftRevision: 2 });
    assert.ok(f.posts.some(post => post.type === 'projectTaskSubmissionResult' && post.requestId === 'supplement-durable' && post.status === 'accepted'));
    assert.equal(bodies.length, 1, 'durable supplement ACK precedes the existing request boundary');
    assert.equal(JSON.stringify(bodies[0]), frozenRequest);
    original.resolve(nativeToolReply(provider, 'prior-native-call', 'keepseek_list_workspace_files', {}));
    await f.host.tasks.whenIdle();
    assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'completed');
    assert.equal(f.host.tasks.get(card.taskCardId)?.rootTaskId, oldRoot);
    assert.equal(bodies.length, 2);
    assert.deepEqual(providerStaticPrefix(bodies[1]), providerStaticPrefix(bodies[0]), 'supplement preserves the frozen system and ordered Worker tool schemas');
    assert.deepEqual(providerUserMessages(bodies[1])[0], providerUserMessages(bodies[0])[0], 'the prior Provider-visible real user bytes remain unchanged');
    const session = await f.loadSession(card.sessionId);
    const users = session!.messages.filter(message => message.role === 'user');
    assert.equal(users.length, 2);
    assert.deepEqual(users.map(message => message.userTask?.id), [oldRoot, oldRoot]);
    assert.deepEqual(users.map(message => message.userTask?.reason), ['user', 'supplement']);
    const answers = session!.messages.filter(message => message.role === 'assistant');
    assert.equal(answers.length, 2);
    const scoped = await f.scopeForSession(card.sessionId);
    const firstCheckpoint = await scoped.getTaskCheckpoint(answers[0].id, session!.id);
    const nextCheckpoint = await scoped.getTaskCheckpoint(answers[1].id, session!.id);
    assert.notEqual(firstCheckpoint?.taskId, nextCheckpoint?.taskId);
    assert.equal(nextCheckpoint?.request.projectTaskIdentity?.rootTaskId, oldRoot);
    assert.ok((nextCheckpoint?.runBudget?.modelRequests ?? 0) >= 2);
    const replay = JSON.stringify(bodies[1]);
    assert.ok(replay.includes('prior-native-call'));
    assert.ok(replay.includes('supplement_pending'), 'undispatched original tools receive paired blocked results');
    assert.ok(replay.indexOf('prior-native-call') < replay.indexOf('REAL_SUPPLEMENT'));
    assert.ok(!JSON.stringify(bodies[0]).includes('REAL_SUPPLEMENT'));
    await f.evidence(`durable-supplement-${provider}`, { directInputRouterClassificationCalls: 0, preservedRoot: true,
      distinctSegments: true, originalNativeCallPairedBeforeRealSupplement: true, staticPrefixAndOriginalUserUnchanged: true });
  });
}

test('actual Host resumes a user-only crash commit once with the original prepared Provider bytes', async t => {
  const f = await fixture(t);
  const reachedCommit = deferred(), releaseOldProcess = deferred();
  const prototype = KeepseekChatViewProvider.prototype as unknown as {
    refreshContextCompressionBeforeRun(...args: unknown[]): Promise<void>;
  };
  const originalBoundary = prototype.refreshContextCompressionBeforeRun;
  let held = false;
  prototype.refreshContextCompressionBeforeRun = async function (...args) {
    if (!held) { held = true; reachedCommit.resolve(); await releaseOldProcess.promise; }
    return originalBoundary.apply(this, args);
  };
  f.cleanup(() => { prototype.refreshContextCompressionBeforeRun = originalBoundary; releaseOldProcess.resolve(); });
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body);
    if (!body.tools) return f.capture(body, titleReply());
    bodies.push(body); return f.capture(body, textReply('Recovered exactly once.'));
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectTaskCreate', requestId: 'crash-gap-input', prompt: 'CRASH_GAP_ORIGINAL_USER_BYTES', draftRevision: 7 });
  await until(() => held, 'durable user-only crash boundary');
  await reachedCommit.promise;
  const card = f.host.tasks.list()[0], input = f.host.tasks.inputs(card.taskCardId)[0];
  assert.equal(input.state, 'incorporated');
  assert.ok(input.preparedContent, 'the final input intent precedes the session commit');
  const session = await f.loadSession(card.sessionId);
  assert.equal(session?.messages.length, 1);
  const savedUser = session!.messages[0];
  assert.equal(savedUser.role, 'user');
  assert.equal(bodies.length, 0, 'the captured crash point precedes every Provider request and assistant');
  await f.storage.flush();
  const snapshotPath = join(f.directory, 'crash-snapshot');
  await cp(f.storageDirectory, snapshotPath, { recursive: true });
  await f.host.tasks.stop(card.taskCardId);
  releaseOldProcess.resolve();
  await f.host.tasks.whenIdle();
  prototype.refreshContextCompressionBeforeRun = originalBoundary;
  await f.restartFrom(snapshotPath);
  assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'interrupted');
  assert.equal(bodies.length, 0, 'restart never automatically starts the saved execution');
  assert.deepEqual((await f.loadSession(card.sessionId))?.messages.map(message => message.id), [savedUser.id]);
  await f.send({ type: 'projectTaskResume', taskCardId: card.taskCardId });
  await f.host.tasks.whenIdle();
  assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'completed');
  assert.equal(bodies.length, 1);
  const recovered = await f.loadSession(card.sessionId);
  const users = recovered!.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].id, savedUser.id);
  assert.equal(users[0].userTask?.id, card.rootTaskId);
  assert.equal(users[0].providerContent, savedUser.providerContent);
  assert.equal(users[0].expandedContent, savedUser.expandedContent);
  const actualUsers = (bodies[0].messages as Array<{ role: string; content: unknown }>).filter(message => message.role === 'user');
  assert.equal(actualUsers.at(-1)?.content, (savedUser.providerContent ?? savedUser.expandedContent ?? savedUser.content).trim());
  assert.equal(f.host.tasks.inputs(card.taskCardId).length, 1);
  assert.equal(f.host.tasks.inputs(card.taskCardId)[0].state, 'settled');
  await f.evidence('user-only-crash-commit-resume', { automaticRestartCalls: 0, durableUserAppends: 1, recoveryWorkerCalls: 1 });
});

test('actual automatic approval continuations bind distinct assistant segments and repeated native call IDs execute independently', async t => {
  const f = await fixture(t);
  f.snapshot.approvalMode = 'delegate';
  await writeFile(join(f.directory, 'workspace', 'package.json'), JSON.stringify({ scripts: { compile: 'node --test verify.cjs' } }));
  await writeFile(join(f.directory, 'workspace', 'verify.cjs'),
    "require('node:fs').appendFileSync('validation-count.txt', 'x'); console.log('fixed-validation-executed');\n");
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => {
    const body = f.decode(init?.body);
    if (!body.tools) {
      const review = JSON.stringify(body).includes('validation_run');
      return f.capture(body, review ? textReply(JSON.stringify({ decision: 'approve', risk: 'low',
        policyRules: ['user_authorized'], reason: 'Run the exact fixed temporary compile validation.', saferAlternative: '' })) : titleReply());
    }
    bodies.push(body);
    return f.capture(body, bodies.length <= 2
      ? toolReply('same-native-call', 'keepseek_run_validation', { script: 'compile' })
      : textReply('Both fixed validations completed.'));
  }) as typeof fetch;
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectTaskCreate', requestId: 'auto-segment-task',
    prompt: 'AUTO_SEGMENT_VALIDATION Run the fixed compile validation twice and report its output.', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const card = f.host.tasks.list()[0];
  assert.equal(card.state, 'completed', card.error);
  assert.equal(bodies.length, 3, 'two automatic approval boundaries plus the final real model request');
  assert.equal(await readFile(join(f.directory, 'workspace', 'validation-count.txt'), 'utf8'), 'xx',
    'same native call ID in a later assistant cannot reuse the earlier completed validation');
  const session = await f.loadSession(card.sessionId);
  const users = session!.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 3);
  assert.ok(users.every(message => message.userTask?.id === card.rootTaskId));
  assert.deepEqual(users.map(message => message.userTask?.reason), ['user', 'approval', 'approval']);
  const answers = session!.messages.filter(message => message.role === 'assistant');
  assert.equal(answers.length, 3);
  const scoped = await f.scopeForSession(card.sessionId);
  const checkpoints = await Promise.all(answers.map(message => scoped.getTaskCheckpoint(message.id, session!.id)));
  assert.ok(checkpoints.every(Boolean));
  assert.equal(new Set(checkpoints.map(checkpoint => checkpoint!.taskId)).size, 3);
  assert.ok(checkpoints.every(checkpoint => checkpoint!.request.projectTaskIdentity?.segmentId === checkpoint!.taskId));
  assert.equal(card.segmentId, checkpoints.at(-1)!.taskId);
  assert.ok((checkpoints.at(-1)!.runBudget?.modelRequests ?? 0) >= 3);
  assert.equal(checkpoints[1]!.state?.validationRunCount, 2, 'same-root validation budget does not reset between assistants');
  assert.ok(checkpoints[1]!.state?.epoch?.evidenceRefs.some(ref => ref.toolCallId === `${checkpoints[0]!.taskId}:same-native-call`));
  assert.ok(checkpoints[1]!.state?.epoch?.evidenceRefs.some(ref => ref.toolCallId === `${checkpoints[1]!.taskId}:same-native-call`));
  assert.deepEqual(providerStaticPrefix(bodies[1]), providerStaticPrefix(bodies[0]));
  await f.evidence('automatic-approval-distinct-assistant-segments', { preservedRoot: true, distinctActualSegments: 3,
    realFixedValidationExecutions: 2, nativeCallIdentityCollisionReuses: 0, physicalWorkerRequests: 3, temporaryWorkspaceFiles: 3 });
});

test('actual task Stop during the durable segment binder cannot dispatch a paid model request', async t => {
  const f = await fixture(t);
  const releaseBinder = deferred();
  let binderEntered = false;
  const service = f.host.tasks as unknown as { options: { driverFactory: (card: ProjectTaskCard) => import('../src/tasks/taskRuntime').TaskExecutionDriver } };
  const originalFactory = service.options.driverFactory;
  service.options.driverFactory = card => {
    const driver = originalFactory(card);
    return { ...driver, execute: context => driver.execute({ ...context, executionSegment: async segmentId => {
      binderEntered = true; await releaseBinder.promise;
      await context.executionSegment?.(segmentId);
    } }) };
  };
  f.cleanup(() => releaseBinder.resolve());
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (_url, init) => { requests++; const body = f.decode(init?.body); return f.capture(body, textReply('Unexpected dispatch.')); };
  f.afterDispose(() => { globalThis.fetch = originalFetch; });
  await f.send({ type: 'projectTaskCreate', requestId: 'stop-at-binder', prompt: 'STOP_BEFORE_SEGMENT_DISPATCH', draftRevision: 1 });
  await until(() => binderEntered, 'durable segment binder before preparation');
  const card = f.host.tasks.list()[0];
  await f.send({ type: 'projectTaskStop', taskCardId: card.taskCardId });
  releaseBinder.resolve();
  await f.host.tasks.whenIdle();
  assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'cancelled');
  assert.equal(requests, 0, 'an already-aborted root signal is preserved before a preparation controller exists');
  assert.equal((await f.loadSession(card.sessionId))?.messages.length, 0);
  assert.equal(f.host.tasks.inputs(card.taskCardId)[0].state, 'cancelled');
});

async function fixture(t: TestContext, provider: ModelSourceProvider = 'openai-compatible') {
  const cleanupCallbacks: Array<() => void> = [], disposedCallbacks: Array<() => void> = [];
  const startedAt = performance.now(), transports: PhysicalCapture[] = [];
  const rawBodies = new WeakMap<Record<string, unknown>, string>();
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-project-host-'));
  const project = join(directory, 'workspace'), data = join(directory, 'storage');
  await Promise.all([mkdir(project), mkdir(data)]);
  const projectUri = vscode.Uri.file(project), storageUri = vscode.Uri.file(data);
  const previousFolders = vscodeStub.workspace.workspaceFolders;
  const previousWindow = { ...vscodeStub.window };
  const previousAlignment = (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousCodexHome = process.env.CODEX_HOME;
  const codexHome = join(directory, 'codex-home'); await mkdir(codexHome);
  process.env.CODEX_HOME = codexHome;
  vscodeStub.workspace.workspaceFolders = [{ uri: projectUri as never, name: 'Temporary project' }];
  Object.assign(vscodeStub, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscodeStub.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const owner = await ProjectExecutionOwner.acquire({ projectUri, lockRoot: join(directory, 'locks') });
  assert.equal(owner.isOwner, true, owner.reason);
  let activeStorageUri = storageUri, storage = new GlobalSessionStorage(storageUri);
  const workspaceScope = { key: 'workspace:project-host', name: 'Temporary project', folderUris: [projectUri.toString()] };
  let store = new ChatSessionStore(storage, 'en', workspaceScope);
  await store.initialize();
  await new ModelSourceStore(storageUri).createSource({ id: 'fixture', name: 'Controlled fixture', provider,
    apiKey: 'test-key', baseUrl: 'https://fixture.invalid/v1', models: [{ id: 'fixture-model', contextWindowTokens: 64000, maxOutputTokens: 2000 }] });
  const snapshot: TaskDefaultsSnapshot = { sourceId: 'fixture', modelId: 'fixture-model', wireModel: 'fixture-model',
    endpoint: 'https://fixture.invalid/v1', protocol: provider, rootUri: projectUri.toString(), cwdUri: projectUri.toString(),
    approvalMode: 'ask', executionMode: 'normal', skillIds: [],
    configuration: { settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' } } };
  const posts: Array<Record<string, unknown>> = [];
  const sources = new SharedProjectSources();
  const createHost = (uri: vscode.Uri) => new ProjectAssistantHost({ owner, resources: new ProjectResourceCoordinator(owner.projectId), admission: new ProjectRequestAdmission(), sources,
    windowId: 'integration', extensionUri: storageUri, storageUri: uri, sessionStore: store,
    skillState: { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    extensionInfo: { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    defaults: () => structuredClone(snapshot), publish: message => posts.push(message as Record<string, unknown>) });
  let host = createHost(storageUri);
  let hostDrained = false;
  await host.initialize();
  t.after(async () => {
    cleanupCallbacks.forEach(work => work());
    if (!hostDrained) await host.dispose();
    await storage.flush(); await owner.dispose(); sources.dispose();
    disposedCallbacks.forEach(work => work());
    vscodeStub.workspace.workspaceFolders = previousFolders;
    Object.assign(vscodeStub.window, previousWindow);
    if (previousAlignment === undefined) delete (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscodeStub, { StatusBarAlignment: previousAlignment });
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  });
  const scopeForSession = async (id: string) => {
    const scope = await store.findSessionScope(id);
    if (!scope) throw new Error('Canonical task session scope missing');
    return store.createWorkspaceScope(scope);
  };
  return { get host() { return host; }, get store() { return store; }, get storage() { return storage; },
    get sourceStore() { return new ModelSourceStore(activeStorageUri); }, posts, snapshot, scopeForSession,
    transports,
    decode: (raw: unknown) => {
      const bytes = String(raw), body = JSON.parse(bytes) as Record<string, unknown>;
      rawBodies.set(body, bytes); return body;
    },
    capture: (body: Record<string, unknown>, response: Response | Promise<Response>) => {
      const capture: PhysicalCapture = { body, rawBody: rawBodies.get(body) ?? JSON.stringify(body), startMs: performance.now() - startedAt };
      transports.push(capture);
      return Promise.resolve(response).then(value => { capture.endMs = performance.now() - startedAt; return value; });
    },
    directory, storageDirectory: data,
    restartFrom: async (path: string) => {
      await host.dispose(); await storage.flush();
      const uri = vscode.Uri.file(path);
      activeStorageUri = uri; storage = new GlobalSessionStorage(uri); store = new ChatSessionStore(storage, 'en', workspaceScope);
      await store.initialize(); host = createHost(uri); hostDrained = false; await host.initialize();
    },
    evidence: async (name: string, assertions: Record<string, unknown>) => {
      if (!process.env.KEEPSEEK_REQUEST_EVIDENCE_PATH) return;
      await host.dispose(); hostDrained = true; await storage.flush();
      const routerTasks = (host as unknown as { routerTasks: ProjectTaskService }).routerTasks;
      const cards = [...host.tasks.list(), ...routerTasks.list()];
      const sessions = await Promise.all(cards.map(async card => ({ card,
        session: await (await scopeForSession(card.sessionId)).loadSessionById(card.sessionId),
        ledger: await new UsageLedgerStore(activeStorageUri).readAll(card.sessionId) })));
      const topLevelFilesAtCapture = (await readdir(project, { withFileTypes: true })).filter(entry => entry.isFile()).length;
      await persistRequestEvidence(name, assertions, transports, sessions, performance.now() - startedAt, topLevelFilesAtCapture);
    },
    loadSession: async (id: string) => (await scopeForSession(id)).loadSessionById(id),
    cleanup: (work: () => void) => cleanupCallbacks.push(work),
    afterDispose: (work: () => void) => disposedCallbacks.push(work),
    send: (message: Record<string, unknown>) => host.handleMessage(message as unknown as WebviewMessage) };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!condition()) { if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}

function textReply(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}
function titleReply(): Response { return textReply('{"decision":"defer","title":null}'); }
function toolReply(id: string, name: string, args: Record<string, unknown>): Response {
  return toolsReply([{ id, name, args }]);
}
function toolsReply(calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index,
    id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}

function nativeTextReply(provider: string, content: string): Response {
  if (provider === 'openai-responses') return responseEvents([{ type: 'response.completed', response: {
    status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
  } }]);
  if (provider === 'anthropic-compatible') return responseEvents([
    { type: 'message_start', message: { usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' }
  ]);
  return textReply(content);
}
function nativeToolReply(provider: string, id: string, name: string, args: Record<string, unknown>): Response {
  if (provider === 'openai-responses') return responseEvents([{ type: 'response.completed', response: {
    status: 'completed', output: [{ type: 'function_call', id: 'native-function', call_id: id, name, arguments: JSON.stringify(args) }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
  } }]);
  if (provider === 'anthropic-compatible') return responseEvents([
    { type: 'message_start', message: { usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' }
  ]);
  return toolReply(id, name, args);
}
function responseEvents(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'Content-Type': 'text/event-stream' } });
}

function providerStaticPrefix(body: Record<string, unknown>) {
  const history = body.messages ?? body.input;
  const messages = Array.isArray(history) ? history as Array<{ role?: string }> : [];
  return { system: body.system ?? body.instructions ?? messages.filter(message => message.role === 'system'), tools: body.tools };
}
function providerUserMessages(body: Record<string, unknown>): unknown[] {
  const messages = body.messages ?? body.input;
  return Array.isArray(messages) ? messages.filter(message => message && typeof message === 'object' && message.role === 'user') : [];
}

async function persistRequestEvidence(name: string, assertions: Record<string, unknown>, transports: PhysicalCapture[],
  sessions: Array<{ card: ProjectTaskCard; session: ChatSession | undefined; ledger: {
    records: ProviderUsageLedgerRecord[]; incomplete: boolean; damagedBucketCount: number;
  } }>, elapsedMs: number, topLevelFilesAtCapture: number): Promise<void> {
  const path = process.env.KEEPSEEK_REQUEST_EVIDENCE_PATH;
  if (!path) return;
  const usedLedgerRecords = new Set<string>();
  const previousByLane = new Map<string, number>();
  const physicalRequests = transports.map((capture, index) => {
    const role = String(JSON.stringify(capture.body.tools)).includes('keepseek_tasks_create') ? 'router' : capture.body.tools ? 'worker' : 'session_title';
    const session = sessions.find(candidate => (candidate.card.snapshot.configuration?.role === 'router') === (role === 'router')
      && candidate.session?.messages.some(message => message.role === 'user'
      && capture.rawBody.includes(JSON.stringify(message.content.trim()).slice(1, -1))));
    const ledger = session?.ledger.records.find(record => {
      const identity = `${session.card.sessionId}:${record.requestId}:${record.attemptIndex}`;
      const recordRole = record.purpose === 'session_title' ? 'session_title' : record.source === 'router' ? 'router' : 'worker';
      return recordRole === role && !usedLedgerRecords.has(identity);
    });
    if (ledger && session) usedLedgerRecords.add(`${session.card.sessionId}:${ledger.requestId}:${ledger.attemptIndex}`);
    const protocol = ledger?.protocol ?? session?.card.snapshot.protocol ?? 'unmatched';
    const lane = `${session?.card.sessionId ?? 'unmatched'}:${protocol}:${ledger?.sourceId ?? 'fixture'}:${ledger?.cacheObservation?.endpointLaneIdentity ?? 'unknown-endpoint'}:${String(capture.body.model)}:${role}`;
    const previousTransportOrdinal = previousByLane.get(lane);
    previousByLane.set(lane, index + 1);
    const prefix = providerStaticPrefix(capture.body);
    const systemBytes = JSON.stringify(prefix.system), toolsBytes = JSON.stringify(prefix.tools ?? []);
    return { transportOrdinal: index + 1, role, taskCardId: session?.card.taskCardId ?? null,
      sessionId: session?.card.sessionId ?? null, sourceId: ledger?.sourceId ?? session?.card.snapshot.sourceId ?? null,
      model: capture.body.model, protocol, physicalAttemptIdentity: ledger ? `${ledger.requestId}:${ledger.attemptIndex}` : null,
      logicalRequestId: ledger?.requestId ?? null, attemptIndex: ledger?.attemptIndex ?? null,
      startMs: capture.startMs, transportResolvedMs: capture.endMs ?? null,
      elapsedUntilTransportResolvedMs: capture.endMs === undefined ? null : capture.endMs - capture.startMs,
      payloadBytes: Buffer.byteLength(capture.rawBody), payloadSha256: sha256(capture.rawBody),
      systemBytes: Buffer.byteLength(systemBytes), systemSha256: sha256(systemBytes),
      orderedToolsBytes: Buffer.byteLength(toolsBytes), orderedToolsSha256: sha256(toolsBytes),
      firstRealUserSha256: sha256(JSON.stringify(providerUserMessages(capture.body)[0] ?? null)),
      previousTransportOrdinalInConversationLane: previousTransportOrdinal ?? null,
      usageLedgerRecord: ledger ?? null,
      actualProviderCharge: null,
      realProviderCacheHitTokens: null };
  });
  const missingLedgerRecords = physicalRequests.filter(request => !request.usageLedgerRecord).map(request => request.transportOrdinal);
  const data = { schemaVersion: 1, capturedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
    nodeVersion: process.version, transport: 'controlled native Provider transport; actual Host/Provider/Runner; no upstream paid request',
    fixture: { initialWorkspaceFiles: 0, isolatedTemporaryWorkspaceAndStorage: true, providerUsage: 'fixed test response counters, not real billing',
      realCacheAndFees: 'pending authorized live Provider acceptance; unknown, not zero', timings: 'actual local controlled-test times; request gates are intentional and are not upstream latency benchmarks' },
    cases: [] as unknown[] };
  try {
    const saved = JSON.parse(await readFile(path, 'utf8')) as { cases?: Array<{ name?: string }> };
    data.cases = saved.cases?.filter(item => item.name !== name) ?? [];
  } catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  data.cases.push({ name, assertions, elapsedMs, topLevelFilesAtCapture,
    requestsByRole: Object.fromEntries(['worker', 'router', 'session_title'].map(role => [role, physicalRequests.filter(request => request.role === role).length])),
    missingLedgerTransportOrdinals: missingLedgerRecords,
    durableLedgersComplete: sessions.every(session => !session.ledger.incomplete && !session.ledger.damagedBucketCount),
    physicalRequests });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  assert.deepEqual(missingLedgerRecords, [], 'every physical controlled transport attempt has a durable request ledger identity');
}

function sha256(bytes: string): string { return createHash('sha256').update(bytes).digest('hex'); }
