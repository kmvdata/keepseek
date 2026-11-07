import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ProjectTaskService, type ProjectTaskServiceOptions, type TaskDefaultsSnapshot } from '../src/tasks/projectTasks';
import type { TaskExecutionContext, TaskExecutionDriver } from '../src/tasks/taskRuntime';
import { writeJsonAtomic } from '../src/shared/atomicStorage';
import * as vscode from 'vscode';

const snapshot: TaskDefaultsSnapshot = { modelId: 'model', sourceId: 'source', approvalMode: 'ask', executionMode: 'normal', skillIds: [] };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('test_wait_timeout');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}
async function fixture(overrides: Partial<ProjectTaskServiceOptions> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-tasks-'));
  const options: ProjectTaskServiceOptions = { storageUri: vscode.Uri.file(directory), projectId: 'project-fixture',
    createSession: async () => undefined, driverFactory: () => completeDriver(), ...overrides };
  const service = new ProjectTaskService(options);
  await service.initialize();
  return { service, options, directory, cleanup: async () => { await service.whenIdle(); await rm(directory, { recursive: true, force: true }); } };
}
function completeDriver(seen?: TaskExecutionContext[]): TaskExecutionDriver {
  return { execute: async context => {
    seen?.push(context);
    await context.prepareInput(context.input.preparedContent ?? context.input.content, context.input.messageId ?? context.input.inputId);
    await context.incorporated(context.input.messageId ?? context.input.inputId);
    return { result: context.input.content, resultMessageId: `reply:${context.input.inputId}`, usedMs: 10 };
  } };
}

test('default scheduler runs two distinct Worker drivers; the third is durably queued', async () => {
  const release = gate(); const started: TaskExecutionContext[] = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    started.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    await release.promise; return { result: context.input.content };
  } }) });
  try {
    const cards = await Promise.all(['A', 'B', 'C'].map(content => f.service.createTask({ requestId: content, content, snapshot })));
    await until(() => started.length === 2);
    assert.equal(f.service.activeCount, 2);
    assert.notEqual(started[0].identity.sessionId, started[1].identity.sessionId);
    assert.notEqual(started[0].signal, started[1].signal);
    assert.equal(f.service.inputs(cards[2].card.taskCardId)[0].state, 'durable');
    release.resolve(); await f.service.whenIdle();
    assert.equal(started.length, 3);
    assert.ok(f.service.list().every(card => card.state === 'completed'));
  } finally { release.resolve(); await f.cleanup(); }
});

test('detaching or failing the view observer cannot reject durable inputs or terminate Worker execution', async () => {
  const seen: TaskExecutionContext[] = [];
  const f = await fixture({ onChange: () => { throw new Error('webview detached'); }, driverFactory: () => completeDriver(seen) });
  try {
    const receipt = await f.service.createTask({ requestId: 'detached-view', content: 'continue in host', snapshot }); await f.service.whenIdle();
    assert.equal(seen.length, 1); assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'completed');
    assert.equal(f.service.events()[0].content, 'continue in host');
  } finally { await f.cleanup(); }
});

test('request IDs are durable and identical replay does not create another session or execute twice', async () => {
  let sessions = 0; const seen: TaskExecutionContext[] = [];
  const f = await fixture({ createSession: async () => { sessions += 1; }, driverFactory: () => completeDriver(seen) });
  try {
    const first = await f.service.createTask({ requestId: 'request', content: 'original bytes\n', snapshot });
    await f.service.whenIdle();
    const repeated = await f.service.createTask({ requestId: 'request', content: 'original bytes\n', snapshot });
    await f.service.whenIdle();
    assert.equal(repeated.duplicate, true); assert.equal(first.card.taskCardId, repeated.card.taskCardId);
    assert.equal(sessions, 1); assert.equal(seen.length, 1);
    await assert.rejects(f.service.createTask({ requestId: 'request', content: 'changed', snapshot }), /request_id_conflict/);
    assert.equal(f.service.inputs(first.card.taskCardId)[0].preparedContent, 'original bytes\n');
  } finally { await f.cleanup(); }
});

test('session-creation crash retries deterministic session identity before returning an ACK', async () => {
  const identities: string[] = []; let fail = true;
  const f = await fixture({ createSession: async (_snapshot, id) => { identities.push(id); if (fail) throw new Error('disk unavailable'); } });
  try {
    await assert.rejects(f.service.createTask({ requestId: 'new', content: 'task', snapshot }), /disk unavailable/);
    assert.equal(f.service.list().length, 1); assert.equal(f.service.list()[0].sessionCreated, false);
    fail = false;
    const receipt = await f.service.createTask({ requestId: 'new', content: 'task', snapshot });
    await f.service.whenIdle();
    assert.equal(receipt.duplicate, true); assert.deepEqual(identities, [receipt.card.sessionId, receipt.card.sessionId]);
    assert.equal(f.service.list().length, 1);
  } finally { await f.cleanup(); }
});

test('supplements are ACKed durably during a model request and consumed FIFO only after its boundary', async () => {
  const release = gate(); const started: TaskExecutionContext[] = []; const revoked: string[] = [];
  const f = await fixture({ driverFactory: () => ({
    execute: async context => {
      started.push(context);
      await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
      if (context.input.kind === 'new') await release.promise;
      return { result: context.input.content };
    }, revokePendingActions: identity => { revoked.push(identity.segmentId); }
  }) });
  try {
    const first = await f.service.createTask({ requestId: 'new', content: 'start', snapshot });
    await until(() => started.length === 1);
    const firstSupplement = await f.service.submitInput(first.card.taskCardId, { requestId: 's1', content: 'first', kind: 'supplement', rootTaskId: first.card.rootTaskId });
    await f.service.submitInput(first.card.taskCardId, { requestId: 's2', content: 'second', kind: 'supplement', rootTaskId: first.card.rootTaskId });
    assert.equal(firstSupplement.input.state, 'durable'); assert.equal(started.length, 1); assert.equal(revoked.length, 2);
    const persisted = JSON.parse(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'));
    assert.ok(persisted.inputs.some((input: { requestId: string }) => input.requestId === 's2'));
    release.resolve(); await f.service.whenIdle();
    assert.deepEqual(started.map(context => context.input.content), ['start', 'first', 'second']);
    assert.ok(started.every(context => context.identity.rootTaskId === first.card.rootTaskId));
    assert.equal(new Set(started.map(context => context.identity.segmentId)).size, 3);
    assert.ok(f.service.inputs(first.card.taskCardId).every(input => input.state === 'settled'));
    await assert.rejects(f.service.submitInput(first.card.taskCardId, { requestId: 'late', content: 'late', kind: 'supplement', rootTaskId: first.card.rootTaskId }), /root_expired/);
  } finally { release.resolve(); await f.cleanup(); }
});

test('dedicated Router turns queue FIFO with distinct roots and never interrupt the current semantic round', async () => {
  const release = gate(); const started: TaskExecutionContext[] = []; let revoked = 0;
  const routerSnapshot = { ...snapshot, configuration: { role: 'router' } };
  const f = await fixture({ allowQueuedFollowups: true, maxWorkers: 1, driverFactory: () => ({ execute: async context => {
    started.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    if (context.input.kind === 'new') await release.promise;
    return { result: context.input.content };
  }, revokePendingActions: () => { revoked += 1; } }) });
  try {
    const first = await f.service.createTask({ requestId: 'router-1', content: 'first user round', snapshot: routerSnapshot });
    await until(() => started.length === 1);
    const second = await f.service.submitInput(first.card.taskCardId, { requestId: 'router-2', content: 'second user round', kind: 'followup' });
    const third = await f.service.submitInput(first.card.taskCardId, { requestId: 'router-3', content: 'third user round', kind: 'followup' });
    assert.notEqual(second.input.rootTaskId, first.input.rootTaskId); assert.notEqual(third.input.rootTaskId, second.input.rootTaskId);
    assert.equal(f.service.get(first.card.taskCardId)?.rootTaskId, first.card.rootTaskId); assert.equal(started.length, 1); assert.equal(revoked, 0);
    release.resolve(); await f.service.whenIdle();
    assert.deepEqual(started.map(context => context.input.content), ['first user round', 'second user round', 'third user round']);
    assert.equal(new Set(started.map(context => context.identity.rootTaskId)).size, 3); assert.equal(revoked, 0);
  } finally { release.resolve(); await f.cleanup(); }
});

test('Router error settles its own failed round and advances FIFO without cancelling a dispatched Worker', async () => {
  const workRelease = gate(); const failRound = gate(); const workerContexts: TaskExecutionContext[] = []; const routerRounds: string[] = [];
  const worker = await fixture({ driverFactory: () => ({ execute: async context => {
    workerContexts.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    await workRelease.promise; return { result: 'independent worker result' };
  } }) });
  const router = await fixture({ allowQueuedFollowups: true, settleFailedInputs: true, maxWorkers: 1, driverFactory: () => ({ execute: async context => {
    routerRounds.push(context.input.content); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    if (context.input.kind === 'new') {
      await worker.service.createTask({ requestId: 'dispatch', content: 'worker', snapshot });
      await failRound.promise; throw new Error('router transport failure after durable dispatch');
    }
    return { result: 'next real round completed' };
  } }) });
  try {
    const first = await router.service.createTask({ requestId: 'r1', content: 'dispatch work', snapshot: { ...snapshot, configuration: { role: 'router' } } });
    await until(() => workerContexts.length === 1);
    await router.service.submitInput(first.card.taskCardId, { requestId: 'r2', content: 'next user message', kind: 'followup' });
    failRound.resolve(); await router.service.whenIdle();
    assert.deepEqual(routerRounds, ['dispatch work', 'next user message']);
    assert.deepEqual(router.service.inputs(first.card.taskCardId).map(input => input.state), ['failed', 'settled']);
    assert.equal(workerContexts[0].signal.aborted, false); assert.equal(worker.service.activeCount, 1);
    assert.equal(router.service.get(first.card.taskCardId)?.state, 'completed');
    assert.equal(router.service.get(first.card.taskCardId)?.error, undefined);
    workRelease.resolve(); await worker.service.whenIdle(); assert.equal(worker.service.list()[0].state, 'completed');
  } finally { failRound.resolve(); workRelease.resolve(); await router.cleanup(); await worker.cleanup(); }
});

test('stopping A never cancels B or its controller and settled B followup retains its session', async () => {
  const started: TaskExecutionContext[] = []; const releaseB = gate();
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    started.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    if (context.input.content === 'A') await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    if (context.input.content === 'B') await releaseB.promise;
    return { result: context.input.content };
  } }) });
  try {
    const a = await f.service.createTask({ requestId: 'a', content: 'A', snapshot });
    const b = await f.service.createTask({ requestId: 'b', content: 'B', snapshot });
    await until(() => started.length === 2);
    await f.service.stop(a.card.taskCardId); await f.service.whenIdle(a.card.taskCardId);
    assert.equal(started[1].signal.aborted, false); assert.equal(f.service.get(a.card.taskCardId)?.state, 'cancelled');
    releaseB.resolve(); await f.service.whenIdle();
    const followup = await f.service.submitInput(b.card.taskCardId, { requestId: 'follow', content: 'next', kind: 'followup' });
    await f.service.whenIdle();
    assert.equal(followup.card.sessionId, b.card.sessionId); assert.notEqual(followup.card.rootTaskId, b.card.rootTaskId);
  } finally { releaseB.resolve(); await f.cleanup(); }
});

test('supplementing a waiting approval invalidates it before starting a same-root segment', async () => {
  const started: TaskExecutionContext[] = []; const revoke = gate(); let revocations = 0;
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    started.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    return context.input.kind === 'new' ? { waiting: 'approval', result: 'proposal' } : { result: 'revised' };
  }, revokePendingActions: async () => { revocations += 1; await revoke.promise; } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'approval', content: 'work', snapshot }); await f.service.whenIdle();
    assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'waiting');
    await assert.rejects(f.service.submitInput(receipt.card.taskCardId, { requestId: 'wrong', content: 'follow', kind: 'followup' }), /requires_supplement/);
    const accepted = f.service.submitInput(receipt.card.taskCardId, { requestId: 'revise', content: 'new scope', kind: 'supplement', rootTaskId: receipt.card.rootTaskId });
    await until(() => revocations === 1); assert.equal(started.length, 1);
    revoke.resolve(); await accepted; await f.service.whenIdle();
    assert.equal(started.length, 2); assert.equal(started[1].input.kind, 'supplement');
    assert.equal(started[1].identity.rootTaskId, started[0].identity.rootTaskId);
    assert.notEqual(started[1].identity.segmentId, started[0].identity.segmentId);
    assert.ok(f.service.inputs(receipt.card.taskCardId).every(input => input.state === 'settled'));
  } finally { revoke.resolve(); await f.cleanup(); }
});

test('explicit checkpoint continuation preserves authoritative segment while replacing callback generation', async () => {
  const started: TaskExecutionContext[] = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    started.push(context);
    await context.prepareInput(context.input.preparedContent ?? context.input.content, context.input.messageId ?? context.input.inputId);
    await context.incorporated(context.input.messageId ?? context.input.inputId);
    return started.length === 1 ? { waiting: 'checkpoint', result: 'proposal' } : { result: 'continued' };
  } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'checkpoint', content: 'work', snapshot }); await f.service.whenIdle();
    await f.service.resume(receipt.card.taskCardId); await f.service.whenIdle();
    assert.equal(started.length, 2); assert.equal(started[1].identity.segmentId, started[0].identity.segmentId);
    assert.equal(started[1].identity.generation, started[0].identity.generation + 1);
    assert.equal(started[1].input.inputId, started[0].input.inputId);
    assert.deepEqual(f.service.events().map(event => event.content), ['proposal', 'continued']);
    assert.notEqual(f.service.events()[0].eventId, f.service.events()[1].eventId);
  } finally { await f.cleanup(); }
});

test('a runtime durably binds its actual internal segments; supplement, results and stale callback guards keep the correct owner', async () => {
  const firstRelease = gate(), nextRelease = gate();
  const contexts: TaskExecutionContext[] = []; const revocations: Array<{ segmentId: string; reason: string }> = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    contexts.push(context); await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    assert.ok(context.executionSegment);
    if (context.input.kind === 'new') {
      await context.executionSegment('assistant-first-internal'); await context.waiting('approval'); await context.progress('first internal segment');
      await context.executionSegment('assistant-final-internal'); await context.progress('latest internal segment');
      await firstRelease.promise; return { result: 'original result' };
    }
    await context.executionSegment('assistant-supplement-actual');
    await nextRelease.promise; return { result: 'supplement result' };
  }, revokePendingActions: (identity, reason) => { revocations.push({ segmentId: identity.segmentId, reason }); } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'segments', content: 'original task', snapshot });
    await until(() => f.service.get(receipt.card.taskCardId)?.segmentId === 'assistant-final-internal');
    assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'running'); assert.equal(f.service.get(receipt.card.taskCardId)?.waitingReason, undefined);
    assert.notEqual(contexts[0].identity.segmentId, 'assistant-final-internal', 'initial runtime identity remains immutable');
    await f.service.submitInput(receipt.card.taskCardId, { requestId: 'segments-supplement', content: 'real supplement', kind: 'supplement', rootTaskId: receipt.card.rootTaskId });
    assert.deepEqual(revocations, [{ segmentId: 'assistant-final-internal', reason: 'supplement' }]);
    firstRelease.resolve();
    await until(() => f.service.get(receipt.card.taskCardId)?.segmentId === 'assistant-supplement-actual');
    await assert.rejects(contexts[0].executionSegment!('late-previous-generation'), /identity_expired/);
    await assert.rejects(contexts[0].progress('late previous progress'), /identity_expired/);
    await assert.rejects(contexts[1].executionSegment!('invalid segment with spaces'), /segment_invalid/);
    assert.equal(f.service.get(receipt.card.taskCardId)?.segmentId, 'assistant-supplement-actual');
    nextRelease.resolve(); await f.service.whenIdle();
    assert.equal(f.service.get(receipt.card.taskCardId)?.rootTaskId, receipt.card.rootTaskId);
    assert.deepEqual(contexts.map(context => context.input.content), ['original task', 'real supplement']);
    assert.deepEqual(f.service.events().map(event => event.segmentId), ['assistant-final-internal', 'assistant-supplement-actual']);
    assert.ok(f.service.events().every(event => event.rootTaskId === receipt.card.rootTaskId));
    assert.ok(f.service.events()[0].eventId.startsWith('assistant-final-internal:result:'));
  } finally { firstRelease.resolve(); nextRelease.resolve(); await f.cleanup(); }
});

test('stop winning the durable admission race cannot resurrect a cancelled inbox item or start its driver', async () => {
  let service!: ProjectTaskService; let stop: Promise<void> | undefined; let executions = 0;
  const f = await fixture({ driverFactory: card => {
    stop ??= service.stop(card.taskCardId);
    return { execute: async () => { executions += 1; return { result: 'must never start' }; } };
  } });
  service = f.service;
  try {
    const receipt = await service.createTask({ requestId: 'admission-stop', content: 'queued work', snapshot });
    await until(() => !!stop); await stop; await service.whenIdle();
    assert.equal(executions, 0); assert.equal(service.activeCount, 0);
    assert.equal(service.inputs(receipt.card.taskCardId)[0].state, 'cancelled');
    assert.equal(service.get(receipt.card.taskCardId)?.state, 'cancelled');
  } finally { await f.cleanup(); }
});

test('stopping a live runtime revokes the latest internally bound execution segment', async () => {
  const contexts: TaskExecutionContext[] = []; const revoked: string[] = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    await context.executionSegment!('latest-command-continuation'); contexts.push(context);
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    return {};
  }, revokePendingActions: identity => { revoked.push(identity.segmentId); } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'segment-stop', content: 'work', snapshot }); await until(() => contexts.length === 1);
    await f.service.stop(receipt.card.taskCardId); await f.service.whenIdle();
    assert.deepEqual(revoked, ['latest-command-continuation']);
    assert.equal(f.service.get(receipt.card.taskCardId)?.segmentId, 'latest-command-continuation');
    assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'cancelled');
  } finally { await f.cleanup(); }
});

test('stopping a card after its approval wait releases the model slot still revokes its cached approval queue', async () => {
  const revocations: string[] = []; let executions = 0;
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    executions += 1; await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    return { waiting: 'approval', result: 'pending proposal' };
  }, revokePendingActions: (_identity, reason) => { revocations.push(reason); } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'wait-stop', content: 'work', snapshot }); await f.service.whenIdle();
    assert.equal(f.service.activeCount, 0); assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'waiting');
    await f.service.stop(receipt.card.taskCardId);
    assert.deepEqual(revocations, ['stop']); assert.equal(executions, 1); assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'cancelled');
  } finally { await f.cleanup(); }
});

test('host shutdown lets final persistence settle and leaves an interrupted root for explicit recovery', async () => {
  const started: TaskExecutionContext[] = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId); started.push(context);
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(new Error('host exit')), { once: true }));
    return {};
  } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'shutdown', content: 'work', snapshot }); await until(() => started.length === 1);
    await f.service.dispose();
    const recovered = new ProjectTaskService(f.options); await recovered.initialize();
    assert.equal(recovered.get(receipt.card.taskCardId)?.state, 'interrupted');
    assert.equal(recovered.inputs(receipt.card.taskCardId)[0].state, 'incorporated');
    assert.equal(recovered.activeCount, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test('old session association is metadata only and rejects a second writer identity', async () => {
  let calls = 0;
  const f = await fixture({ createSession: async () => { calls += 1; }, driverFactory: () => { calls += 1; return completeDriver(); } });
  try {
    const card = await f.service.associateSession({ requestId: 'associate', sessionId: 'old-session', title: 'Old', snapshot });
    assert.equal(card.state, 'completed'); assert.equal(calls, 0); assert.deepEqual(f.service.inputs(card.taskCardId), []);
    assert.equal((await f.service.associateSession({ requestId: 'associate-again', sessionId: 'old-session', title: 'Old', snapshot })).taskCardId, card.taskCardId);
    await assert.rejects(f.service.createTask({ requestId: 'duplicate-session', sessionId: 'old-session', content: 'x', snapshot }), /already_associated/);
  } finally { await f.cleanup(); }
});

test('edit-resend target is durable task-scoped metadata and its idempotent request cannot change truncation target', async () => {
  const seen: TaskExecutionContext[] = [];
  const f = await fixture({ driverFactory: () => completeDriver(seen) });
  try {
    const card = await f.service.associateSession({ requestId: 'edit-associate', sessionId: 'existing-session', title: 'History', snapshot });
    const receipt = await f.service.submitInput(card.taskCardId, { requestId: 'edit', content: 'edited real user', kind: 'followup', replaceMessageId: 'old-user-message' });
    await f.service.whenIdle();
    assert.notEqual(receipt.input.rootTaskId, card.rootTaskId); assert.equal(seen[0].input.replaceMessageId, 'old-user-message');
    assert.equal((await f.service.submitInput(card.taskCardId, { requestId: 'edit', content: 'edited real user', kind: 'followup', replaceMessageId: 'old-user-message' })).duplicate, true);
    await assert.rejects(f.service.submitInput(card.taskCardId, { requestId: 'edit', content: 'edited real user', kind: 'followup', replaceMessageId: 'different-user-message' }), /request_id_conflict/);
    const restored = new ProjectTaskService(f.options); await restored.initialize();
    assert.equal(restored.findInputByRequestId('edit')?.replaceMessageId, 'old-user-message');
    await assert.rejects(f.service.createTask({ requestId: 'new-edit', content: 'bad', snapshot, replaceMessageId: 'foreign' }), /existing_session/);
    await assert.rejects(f.service.submitInput(card.taskCardId, { requestId: 'supplement-edit', content: 'bad', kind: 'supplement', replaceMessageId: 'old-user-message', rootTaskId: receipt.input.rootTaskId }), /idle_followup/);
  } finally { await f.cleanup(); }
});

test('explicit host snapshot update preserves card/session/root identity and accounted usage', async () => {
  const f = await fixture();
  try {
    const receipt = await f.service.createTask({ requestId: 'snapshot', content: 'work', snapshot }); await f.service.whenIdle();
    const before = f.service.get(receipt.card.taskCardId)!;
    await f.service.updateSnapshot(before.taskCardId, { ...snapshot, sourceId: 'explicit-new-source', modelId: 'explicit-new-model' });
    const after = f.service.get(before.taskCardId)!;
    assert.deepEqual([after.projectId, after.taskCardId, after.sessionId, after.rootTaskId, after.segmentId, after.usedMs, after.costByCurrency],
      [before.projectId, before.taskCardId, before.sessionId, before.rootTaskId, before.segmentId, before.usedMs, before.costByCurrency]);
    assert.equal(after.snapshot.modelId, 'explicit-new-model'); assert.ok(after.revision > before.revision);
  } finally { await f.cleanup(); }
});

test('dependency cycles reject atomically and completed dependency releases its queued consumer', async () => {
  const f = await fixture();
  try {
    const a = await f.service.associateSession({ requestId: 'aa', sessionId: 'sa', title: 'A', snapshot });
    const b = await f.service.associateSession({ requestId: 'ab', sessionId: 'sb', title: 'B', snapshot });
    await f.service.setDependencies(b.taskCardId, [a.taskCardId]);
    await assert.rejects(f.service.setDependencies(a.taskCardId, [b.taskCardId]), /dependency_cycle/);
    assert.deepEqual(f.service.get(a.taskCardId)?.dependencies, []);
    await f.service.markDependentsStale(a.taskCardId);
    assert.equal(f.service.get(b.taskCardId)?.waitingReason, 'dependency_requires_review');
    await assert.rejects(f.service.delete(a.taskCardId), /has_dependents/);
  } finally { await f.cleanup(); }
});

test('creation captures dependencies atomically before admission and a failed dependency blocks its consumer', async () => {
  const release = gate(); const started: string[] = [];
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    started.push(context.input.content);
    if (context.input.content === 'failed dependency') throw new Error('preparation failed');
    await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    if (context.input.content === 'dependency') await release.promise;
    return { result: context.input.content };
  } }) });
  try {
    const dependency = await f.service.createTask({ requestId: 'dependency', content: 'dependency', snapshot });
    await until(() => started.length === 1);
    const consumer = await f.service.createTask({ requestId: 'consumer', content: 'consumer', snapshot, dependencies: [dependency.card.taskCardId] });
    await until(() => f.service.get(consumer.card.taskCardId)?.state === 'waiting');
    assert.deepEqual(started, ['dependency']); assert.deepEqual(consumer.card.dependencies, [dependency.card.taskCardId]);
    await assert.rejects(f.service.createTask({ requestId: 'invalid-dependency', content: 'bad', snapshot, dependencies: ['foreign-card'] }), /target_missing/);
    release.resolve(); await f.service.whenIdle(); assert.deepEqual(started, ['dependency', 'consumer']);
    assert.equal(f.service.get(consumer.card.taskCardId)?.state, 'completed');
    const failed = await f.service.createTask({ requestId: 'failed-dependency', content: 'failed dependency', snapshot }); await f.service.whenIdle();
    assert.equal(f.service.get(failed.card.taskCardId)?.state, 'failed');
    const blocked = await f.service.createTask({ requestId: 'blocked-consumer', content: 'blocked consumer', snapshot, dependencies: [failed.card.taskCardId] });
    await until(() => f.service.get(blocked.card.taskCardId)?.state === 'waiting');
    assert.ok(!started.includes('blocked consumer'));
    assert.equal(f.service.get(blocked.card.taskCardId)?.waitingReason, `dependency:${failed.card.taskCardId}`);
  } finally { release.resolve(); await f.cleanup(); }
});

test('result events are durable, deduplicated and consumed only by the original real input identity', async () => {
  const f = await fixture();
  try {
    await f.service.createTask({ requestId: 'result', content: 'answer', snapshot }); await f.service.whenIdle();
    const [event] = f.service.events({ unconsumed: true }); assert.equal(event.content, 'answer');
    await f.service.consumeEvents([event.eventId], 'real-router-message');
    await f.service.consumeEvents([event.eventId], 'real-router-message');
    await assert.rejects(f.service.consumeEvents([event.eventId], 'other-message'), /already_consumed/);
    assert.equal(f.service.events({ unconsumed: true }).length, 0);
    const restored = new ProjectTaskService(f.options); await restored.initialize();
    assert.equal(restored.events()[0].consumedByInputId, 'real-router-message');
  } finally { await f.cleanup(); }
});

test('restart exposes interrupted work and unconsumed input without automatically invoking a driver', async () => {
  const f = await fixture({ createSession: async () => { throw new Error('crash after intent'); } });
  try {
    await assert.rejects(f.service.createTask({ requestId: 'crash', content: 'retained input', snapshot }));
    let runs = 0;
    const recovered = new ProjectTaskService({ ...f.options, createSession: async () => undefined, driverFactory: () => { runs += 1; return completeDriver(); } });
    await recovered.initialize();
    assert.equal(runs, 0); assert.equal(recovered.list()[0].state, 'interrupted');
    assert.equal(recovered.inputs(recovered.list()[0].taskCardId)[0].content, 'retained input');
    const duplicate = await recovered.createTask({ requestId: 'crash', content: 'retained input', snapshot });
    assert.equal(duplicate.duplicate, true); await recovered.whenIdle();
    assert.equal(runs, 0); assert.equal(recovered.get(duplicate.card.taskCardId)?.state, 'interrupted');
    await recovered.resume(recovered.list()[0].taskCardId); await recovered.whenIdle(); assert.equal(runs, 1);
  } finally { await f.cleanup(); }
});

test('read-only windows never rewrite interrupted status or accept execution mutations', async () => {
  const f = await fixture({ createSession: async () => { throw new Error('crash'); } });
  try {
    await assert.rejects(f.service.createTask({ requestId: 'crash', content: 'retained input', snapshot }));
    const before = await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8');
    const viewer = new ProjectTaskService(f.options); await viewer.initialize({ readOnly: true });
    assert.equal(viewer.list()[0].state, 'queued');
    await assert.rejects(viewer.createTask({ requestId: 'forbidden', content: 'x', snapshot }), /read_only/);
    assert.equal(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'), before);
  } finally { await f.cleanup(); }
});

test('observer reload follows live owner revisions without recovery writes or dispatching work', async () => {
  const release = gate(); let executions = 0;
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    executions += 1; await context.prepareInput(context.input.content, context.input.inputId); await context.incorporated(context.input.inputId);
    await release.promise; return { result: 'owner result' };
  } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'owner', content: 'work', snapshot });
    await until(() => f.service.get(receipt.card.taskCardId)?.state === 'running');
    const viewer = new ProjectTaskService(f.options); await viewer.initialize({ readOnly: true });
    assert.equal(viewer.get(receipt.card.taskCardId)?.state, 'running');
    assert.equal(viewer.activeCount, 0); assert.equal(await viewer.reload(), false);
    release.resolve(); await f.service.whenIdle();
    const before = await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8');
    assert.equal(await viewer.reload(), true); assert.equal(viewer.get(receipt.card.taskCardId)?.state, 'completed');
    assert.equal(viewer.events()[0].content, 'owner result'); assert.equal(executions, 1);
    assert.equal(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'), before);
    await assert.rejects(f.service.reload(), /requires_read_only/);
  } finally { release.resolve(); await f.cleanup(); }
});

test('unknown/corrupt registry is rejected rather than silently replaced by an empty project', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.directory, 'project-tasks.json'), '{"version":99}', 'utf8');
    await assert.rejects(new ProjectTaskService(f.options).initialize(), /registry_invalid/);
  } finally { await f.cleanup(); }
});

test('prepared input expansion bytes cannot change after a recoverable intent has been saved', async () => {
  const f = await fixture({ driverFactory: () => ({ execute: async context => {
    await context.prepareInput('frozen expanded bytes', context.input.inputId);
    await assert.rejects(context.prepareInput('different expansion', context.input.inputId), /bytes_changed/);
    await context.incorporated(context.input.inputId); return { result: 'done' };
  } }) });
  try {
    const receipt = await f.service.createTask({ requestId: 'expand', content: 'raw', snapshot }); await f.service.whenIdle();
    assert.equal(f.service.inputs(receipt.card.taskCardId)[0].preparedContent, 'frozen expanded bytes');
  } finally { await f.cleanup(); }
});

test('immutable input/result objects precede the v2 manifest and progress does not rewrite payload objects', async () => {
  const writes: Array<{ name: string; kind?: string }> = []; let failManifest = true; let sessions = 0;
  const f = await fixture({
    createSession: async () => { sessions += 1; },
    storageWrite: async (uri, value) => {
      const kind = (value as { kind?: string }).kind;
      writes.push({ name: path.basename(uri.fsPath), kind });
      if (path.basename(uri.fsPath) === 'project-tasks.json' && failManifest) throw new Error('injected_manifest_failure');
      await writeJsonAtomic(uri, value, { durable: true });
    },
    driverFactory: () => ({ execute: async context => {
      await context.prepareInput('frozen-provider-input', context.input.inputId); await context.incorporated(context.input.inputId);
      await context.progress('first phase'); await context.progress('second phase'); return { result: 'durable output' };
    } })
  });
  try {
    await assert.rejects(f.service.createTask({ requestId: 'fault', content: 'raw input', snapshot }), /injected_manifest_failure/);
    assert.equal(sessions, 0); assert.equal(f.service.list().length, 0);
    assert.equal(writes[0].kind, 'input-body'); assert.equal(writes[1].name, 'project-tasks.json');
    await assert.rejects(readFile(path.join(f.directory, 'project-tasks.json')), /ENOENT/);
    failManifest = false;
    const receipt = await f.service.createTask({ requestId: 'fault', content: 'raw input', snapshot }); await f.service.whenIdle();
    const objects = writes.filter(write => write.kind).length;
    await f.service.rename(receipt.card.taskCardId, 'Renamed');
    assert.equal(writes.filter(write => write.kind).length, objects);
    const manifest = JSON.parse(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'));
    assert.equal(manifest.version, 2); assert.equal(manifest.inputs[0].content, undefined);
    assert.ok(manifest.inputs[0].bodyRef.hash); assert.ok(manifest.inputs[0].preparedRef.hash);
    assert.equal(manifest.events[0].content, undefined); assert.ok(manifest.events[0].bodyRef.hash);
    const restored = new ProjectTaskService(f.options); await restored.initialize();
    assert.equal(restored.inputs(receipt.card.taskCardId)[0].content, 'raw input');
    assert.equal(restored.inputs(receipt.card.taskCardId)[0].preparedContent, 'frozen-provider-input');
    assert.equal(restored.events()[0].content, 'durable output');
    assert.equal(restored.findInputByRequestId('fault')?.inputId, receipt.input.inputId);
  } finally { await f.cleanup(); }
});

test('legacy v1 task records migrate to object manifests without changing any saved user/Provider bytes', async () => {
  const f = await fixture();
  try {
    const receipt = await f.service.createTask({ requestId: 'legacy', content: '\n  saved user bytes  \n', snapshot }); await f.service.whenIdle();
    const legacy = { version: 1, projectId: f.options.projectId, revision: 10, cards: f.service.list(), inputs: f.service.inputs(receipt.card.taskCardId), events: f.service.events() };
    legacy.cards[0].inputIds = []; // The list index is reconstructible from durable input identities.
    await writeJsonAtomic(vscode.Uri.file(path.join(f.directory, 'project-tasks.json')), legacy, { durable: true });
    const migrated = new ProjectTaskService(f.options); await migrated.initialize();
    await migrated.rename(receipt.card.taskCardId, 'Metadata change');
    const manifest = JSON.parse(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'));
    assert.equal(manifest.version, 2);
    const restored = new ProjectTaskService(f.options); await restored.initialize();
    assert.deepEqual(restored.get(receipt.card.taskCardId)?.inputIds, legacy.inputs.map(input => input.inputId));
    assert.deepEqual(restored.inputs(receipt.card.taskCardId), legacy.inputs);
    assert.deepEqual(restored.events(), legacy.events);
  } finally { await f.cleanup(); }
});

test('post-rename manifest failure reconciles request identity before a retry and never creates a second Worker session', async () => {
  let failOnce = true; const sessions: string[] = [];
  const f = await fixture({ createSession: async (_snapshot, id) => { sessions.push(id); }, storageWrite: async (uri, value) => {
    await writeJsonAtomic(uri, value, { durable: true });
    if (path.basename(uri.fsPath) === 'project-tasks.json' && failOnce) { failOnce = false; throw new Error('after_rename_failure'); }
  } });
  try {
    await assert.rejects(f.service.createTask({ requestId: 'uncertain-commit', content: 'work', snapshot }), /after_rename_failure/);
    const saved = f.service.findInputByRequestId('uncertain-commit'); assert.ok(saved);
    const retry = await f.service.createTask({ requestId: 'uncertain-commit', content: 'work', snapshot }); await f.service.whenIdle();
    assert.equal(retry.duplicate, true); assert.equal(retry.input.inputId, saved.inputId);
    assert.deepEqual(sessions, [saved.sessionId]); assert.equal(f.service.list().length, 1);
  } finally { await f.cleanup(); }
});

test('failed input preparation remains explicitly resumable without inventing a checkpoint or a new root', async () => {
  let failPreparation = true; const started: TaskExecutionContext[] = [];
  const f = await fixture({ storageWrite: async (uri, value) => {
    if ((value as { kind?: string }).kind === 'prepared-input' && failPreparation) { failPreparation = false; throw new Error('preparation_disk_failure'); }
    await writeJsonAtomic(uri, value, { durable: true });
  }, driverFactory: () => completeDriver(started) });
  try {
    const receipt = await f.service.createTask({ requestId: 'prepare-fault', content: 'real user body', snapshot }); await f.service.whenIdle();
    assert.equal(f.service.inputs(receipt.card.taskCardId)[0].state, 'failed');
    assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'failed');
    await f.service.resume(receipt.card.taskCardId); await f.service.whenIdle();
    assert.equal(started.length, 2); assert.equal(started[1].input.inputId, started[0].input.inputId);
    assert.equal(started[1].identity.rootTaskId, started[0].identity.rootTaskId);
    assert.equal(started[1].input.kind, 'new'); assert.equal(f.service.get(receipt.card.taskCardId)?.state, 'completed');
  } finally { await f.cleanup(); }
});

test('missing or corrupt referenced task objects fail closed instead of resetting accepted inputs', async () => {
  const f = await fixture();
  try {
    const receipt = await f.service.createTask({ requestId: 'corrupt-object', content: 'saved input', snapshot }); await f.service.whenIdle();
    const manifest = JSON.parse(await readFile(path.join(f.directory, 'project-tasks.json'), 'utf8'));
    const hash = manifest.inputs[0].bodyRef.hash as string;
    const objectPath = path.join(f.directory, 'task-objects', hash.slice(0, 2), `${hash}.json`);
    const original = await readFile(objectPath);
    await writeFile(objectPath, '{}');
    await assert.rejects(new ProjectTaskService(f.options).initialize(), /hash_mismatch/);
    await writeFile(objectPath, original); await rm(objectPath);
    await assert.rejects(new ProjectTaskService(f.options).initialize(), /object_missing/);
    assert.equal(f.service.findInputByRequestId('corrupt-object')?.inputId, receipt.input.inputId);
  } finally { await f.cleanup(); }
});

test('persisted malformed identities, counters, accounting, dependencies and snapshots fail closed without guessing a root', async () => {
  const f = await fixture();
  type Manifest = { revision: unknown; cards: Array<Record<string, unknown>>; inputs: Array<Record<string, unknown>>; events: Array<Record<string, unknown>> };
  try {
    const receipt = await f.service.createTask({ requestId: 'validate-metadata', content: 'original real user bytes', snapshot }); await f.service.whenIdle();
    const uri = path.join(f.directory, 'project-tasks.json');
    const baseline = await readFile(uri, 'utf8');
    const mutations: Array<[string, (manifest: Manifest) => void]> = [
      ['string generation', value => { value.cards[0].generation = '1'; }],
      ['unsafe revision', value => { value.cards[0].revision = Number.MAX_SAFE_INTEGER + 1; }],
      ['fractional manifest revision', value => { value.revision = 1.5; }],
      ['nonstring root', value => { value.cards[0].rootTaskId = 42; }],
      ['duplicate input ID', value => { value.inputs.push({ ...value.inputs[0], requestId: 'different-request' }); }],
      ['duplicate event ID', value => { value.events.push({ ...value.events[0] }); }],
      ['negative elapsed time', value => { value.cards[0].usedMs = -1; }],
      ['negative currency cost', value => { value.cards[0].costByCurrency = { USD: -1 }; }],
      ['nonfinite currency cost', value => { value.cards[0].costByCurrency = { USD: Infinity }; }],
      ['unknown dependency', value => { value.cards[0].dependencies = ['foreign-card']; }],
      ['dependency cycle', value => { value.cards[0].dependencies = [value.cards[0].taskCardId]; }],
      ['malformed timestamp', value => { value.cards[0].createdAt = 'invalid-date'; }],
      ['nontitle data', value => { value.cards[0].title = {}; }],
      ['nonrecord configuration', value => { (value.cards[0].snapshot as Record<string, unknown>).configuration = []; }],
      ['foreign event session', value => { value.events[0].sessionId = 'foreign-session'; }],
      ['invalid actual segment', value => { value.events[0].segmentId = 'untrusted segment with spaces'; }]
    ];
    for (const [name, mutate] of mutations) {
      const corrupted = JSON.parse(baseline) as Manifest; mutate(corrupted);
      await writeFile(uri, JSON.stringify(corrupted));
      await assert.rejects(new ProjectTaskService(f.options).initialize(), /task_/, name);
    }
    await writeFile(uri, baseline);
    const restored = new ProjectTaskService(f.options); await restored.initialize();
    assert.equal(restored.get(receipt.card.taskCardId)?.rootTaskId, receipt.card.rootTaskId);
    assert.equal(restored.findInputByRequestId('validate-metadata')?.content, 'original real user bytes');
  } finally { await f.cleanup(); }
});

