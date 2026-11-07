import './registerVscodeStub';
import '../src/agent/providerRequestProjection';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from './stubs/vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { SubagentScheduler } from '../src/agent/subagents/scheduler';
import { createSubagentHostContext } from '../src/agent/subagents/contextCapsule';
import { createStableWorkspaceContext, createWorkspaceScopeRoots } from '../src/agent/subagents/pathScope';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator, runProjectExecution, withProjectMutationPhase } from '../src/tasks/projectResources';
import { ProjectRequestAdmission, withoutProjectChildSlot } from '../src/tasks/requestAdmission';
import type { AgentRequest } from '../src/shared/types';

function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) { if (Date.now() >= deadline) throw new Error('Child fixture boundary was not reached.'); await new Promise<void>((resolve) => setTimeout(resolve, 5)); }
}
const scope = (name: string) => ({ sessionId: name, rootTaskId: `root-${name}`, segmentId: `segment-${name}`, runtimeId: `runtime-${name}` });

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-children-'));
  const project = path.join(base, 'project');
  await mkdir(path.join(project, '.git'), { recursive: true });
  const owner = await ProjectExecutionOwner.acquire({ projectUri: project, lockRoot: path.join(base, 'owners') });
  const previous = { folders: vscode.workspace.workspaceFolders, trusted: vscode.workspace.isTrusted, fetch: globalThis.fetch };
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'project' }];
  vscode.workspace.isTrusted = true;
  const admission = new ProjectRequestAdmission({ sourceConcurrency: 8, requestConcurrency: 8 });
  const resources = new ProjectResourceCoordinator(owner.projectId);
  const storage = vscode.Uri.file(path.join(base, 'storage')) as never;
  const requests: string[] = [];
  const answer = async (_url: unknown, init?: RequestInit): Promise<Response> => {
    const serialized = String(init?.body);
    requests.push(serialized);
    const body = JSON.parse(serialized) as { messages: Array<{ role: string; content?: string }> };
    const binding = body.messages.filter((message) => message.role === 'user').map((message) => message.content ?? '').join('\n');
    const taskHash = /taskHash: ([a-f0-9]{64})/u.exec(binding)?.[1];
    assert.ok(taskHash, 'real child projection contains its deterministic task binding');
    const content = JSON.stringify({ taskHash, status: 'complete', summary: 'The controlled child transport returned its bound task result.',
      evidence: [{ claim: 'The fixture reached the real child Provider transport.' }], uncertainties: [] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const runtime = (name: string) => new SubagentRuntime({ globalStorageUri: storage, workspaceKey: name, sourceStore: new ModelSourceStore(storage) });
  const request = (name: string): AgentRequest => ({
    prompt: 'Investigate the bounded fixture task.', model: { id: 'fixture-main', sourceId: 'fixture-source', provider: 'openai-compatible', label: 'Fixture',
      contextWindowTokens: 64_000, maxOutputTokens: 2_000 }, settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    history: [], contextFiles: [], language: 'en', sessionId: name, requestProtocolVersion: 15,
    sourceConfig: { sourceId: 'fixture-source', provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', supportsBilling: false }
  });
  return { owner, admission, resources, requests, answer, runtime, request,
    cleanup: async () => { globalThis.fetch = previous.fetch; vscode.workspace.workspaceFolders = previous.folders; vscode.workspace.isTrusted = previous.trusted;
      if (owner.isOwner) await owner.dispose(); await rm(base, { recursive: true, force: true }); } };
}

describe('shared project logical child admission', () => {
  it('caps two actual SubagentRuntimes together before their real child requests start', async () => {
    const f = await fixture();
    const release = deferred();
    let pending: Promise<unknown>[] = [];
    try {
      if (!f.owner.isOwner && process.platform === 'win32') return;
      let arrived = 0;
      let peak = 0;
      globalThis.fetch = async (url, init) => { arrived += 1; peak = Math.max(peak, arrived); await release.promise; const answer = await f.answer(url, init); arrived -= 1; return answer; };
      const a = f.runtime('worker-a');
      const b = f.runtime('worker-b');
      const tasks = [a, b].map((runtime, index) => runProjectExecution({ ...f, scope: scope(`worker-${index}`) }, () => runtime.delegateParallel({
        tasks: Array.from({ length: 3 }, (_, child) => ({ task: `Inspect fixture worker ${index} bounded branch ${child}.`, profile: 'research' }))
      }, { parentRequest: f.request(`worker-${index}`), parentRunId: `worker-run-${index}`, language: 'en' })));
      pending = tasks;
      await waitFor(() => arrived === 3 && f.admission.snapshot().children.rootWaiting === 3);
      assert.equal(f.admission.snapshot().children.rootActive, 3);
      assert.equal(peak, 3, 'physical source capacity=8 must not hide duplicated logical quotas');
      release.resolve();
      const results = await Promise.all(tasks);
      assert.equal(f.requests.length, 6);
      assert.ok(results.every((result) => JSON.parse(result.content).ok === true));
      assert.equal(a.getProgressStates().filter((state) => state.status === 'completed').length, 3);
      assert.equal(b.getProgressStates().filter((state) => state.status === 'completed').length, 3);
      assert.equal(f.admission.snapshot().children.rootActive, 0);
      assert.equal(f.admission.snapshot().requests, 0);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.cleanup(); }
  });

  it('releases three saturated parents while actual nested children use the reserved project slot', async () => {
    const f = await fixture();
    const releaseNested = deferred();
    let pending: Promise<unknown>[] = [];
    try {
      if (!f.owner.isOwner && process.platform === 'win32') return;
      const runtime = f.runtime('nested-worker');
      const scheduler = new SubagentScheduler();
      let started = 0;
      globalThis.fetch = async (url, init) => { started += 1; await releaseNested.promise; return f.answer(url, init); };
      const base = f.request('nested-parent-session');
      const host = createSubagentHostContext(base, createStableWorkspaceContext(createWorkspaceScopeRoots()), true);
      const parents = [0, 1, 2].map((index) => runProjectExecution({ ...f, scope: scope(`parent-${index}`) }, () => scheduler.run({ depth: 1, proposal: false, language: 'en' }, async () => {
        const request: AgentRequest = { ...base, subagentHostContext: structuredClone(host), subagentContext: { id: `parent-${index}`, treeId: `tree-${index}`,
          parentSessionId: base.sessionId!, parentRunId: `root-${index}`, rootRunId: `root-${index}`, depth: 1, profile: 'research', lane: 'research-read' } };
        return runtime.delegateTask({ task: `Inspect nested branch ${index}.`, profile: 'research' }, { parentRequest: request, parentRunId: `parent-run-${index}`, language: 'en' });
      })));
      pending = parents;
      await waitFor(() => started > 0);
      await waitFor(() => f.admission.snapshot().children.nestedWaiting === 2);
      assert.equal(f.admission.snapshot().children.rootActive, 0, 'waiting parents must return their same-kind slots');
      assert.equal(f.admission.snapshot().children.nestedActive, 1);
      let unrelatedRan = false;
      await runProjectExecution({ ...f, scope: scope('unrelated') }, () => new SubagentScheduler().run({ depth: 1, proposal: false, language: 'en' }, async () => { unrelatedRan = true; }));
      assert.equal(unrelatedRan, true);
      releaseNested.resolve();
      const results = await Promise.all(parents);
      assert.equal(started, 3);
      assert.ok(results.every((result) => JSON.parse(result.content).ok === true));
      assert.equal(f.admission.snapshot().children.rootActive + f.admission.snapshot().children.nestedActive, 0);
    } finally { releaseNested.resolve(); await Promise.allSettled(pending); await f.cleanup(); }
  });

  it('cancels a suspended parent without leaked slots and rejects child waits under a mutation lease', async () => {
    const f = await fixture();
    try {
      if (!f.owner.isOwner && process.platform === 'win32') return;
      const scheduler = new SubagentScheduler();
      const controller = new AbortController();
      const nestedReady = deferred();
      const running = runProjectExecution({ ...f, signal: controller.signal, scope: scope('cancelled') }, () => scheduler.run({ depth: 1, proposal: false, language: 'en', signal: controller.signal }, () =>
        withoutProjectChildSlot(() => scheduler.run({ depth: 2, proposal: false, language: 'en', signal: controller.signal }, async () => {
          nestedReady.resolve();
          await new Promise<void>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('cancelled fixture')), { once: true }));
        }))));
      await nestedReady.promise;
      assert.equal(f.admission.snapshot().children.rootActive, 0);
      controller.abort();
      await assert.rejects(() => running, /stopped|cancelled/u);
      assert.equal(f.admission.snapshot().children.rootActive + f.admission.snapshot().children.nestedActive, 0);
      await runProjectExecution({ ...f, scope: scope('mutation') }, () => withProjectMutationPhase(async () => {
        await assert.rejects(() => scheduler.run({ depth: 1, proposal: false, language: 'en' }, async () => {}), /mutation lease/u);
        await assert.rejects(() => withoutProjectChildSlot(async () => {}), /mutation lease/u);
      }));
    } finally { await f.cleanup(); }
  });

  it('shares the proposal subset across independent Worker schedulers', async () => {
    const f = await fixture();
    const release = deferred();
    let pending: Promise<unknown>[] = [];
    try {
      if (!f.owner.isOwner && process.platform === 'win32') return;
      const schedulers = [new SubagentScheduler(), new SubagentScheduler()];
      let entered = 0;
      pending = [0, 1, 2].map((index) => runProjectExecution({ ...f, scope: scope(`proposal-${index}`) }, () => schedulers[index % 2].run({
        depth: 1, proposal: true, language: 'en'
      }, async () => { entered += 1; await release.promise; })));
      await waitFor(() => f.admission.snapshot().children.proposalWaiting === 1);
      assert.equal(entered, 2);
      assert.equal(f.admission.snapshot().children.proposalActive, 2);
      release.resolve();
      await Promise.all(pending);
      assert.equal(entered, 3);
      assert.equal(f.admission.snapshot().children.proposalActive + f.admission.snapshot().children.rootActive, 0);
    } finally { release.resolve(); await Promise.allSettled(pending); await f.cleanup(); }
  });
});
