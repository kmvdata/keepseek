import './registerVscodeStub';
import '../src/agent/providerRequestProjection';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator, runProjectExecution, withProjectMutationPhase, assertProjectMutationLease, type ProjectExecutionScope } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import * as vscode from './stubs/vscode';

const execute = promisify(execFile);
const ownerModule = require.resolve('../src/tasks/projectOwner');
const scope = (name: string): ProjectExecutionScope => ({ sessionId: name, rootTaskId: `root-${name}`, segmentId: `segment-${name}`, runtimeId: `runtime-${name}` });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Fixture did not reach its expected boundary.');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-coordination-'));
  const project = path.join(base, 'project');
  const locks = path.join(base, 'locks');
  await mkdir(path.join(project, '.git'), { recursive: true });
  return { base, project, locks, cleanup: () => rm(base, { recursive: true, force: true }) };
}

describe('physical project execution ownership', () => {
  it('refuses a second live process, symlink aliases and different workspace roots', async () => {
    const f = await fixture();
    let owner: ProjectExecutionOwner | undefined;
    try {
      const nested = path.join(f.project, 'nested');
      const alias = path.join(f.base, 'alias');
      await mkdir(nested);
      await symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
      owner = await ProjectExecutionOwner.acquire({ projectUri: pathToFileURL(nested).toString(), lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') { assert.match(owner.reason!, /filesystem/u); return; }
      assert.equal(owner.isOwner, true);
      const competing = await execute(process.execPath, ['-e', `
        const {ProjectExecutionOwner}=require(process.argv[1]);
        ProjectExecutionOwner.acquire({projectUri:process.argv[2],lockRoot:process.argv[3]})
          .then(o=>{console.log(JSON.stringify({owned:o.isOwner,id:o.projectId,reason:o.reason}));process.exit(0)})
          .catch(e=>{console.error(e);process.exit(1)});
      `, ownerModule, pathToFileURL(alias).toString(), f.locks]);
      const state = JSON.parse(competing.stdout) as { owned: boolean; id: string; reason: string };
      assert.equal(state.owned, false);
      assert.equal(state.id, owner.projectId);
      assert.match(state.reason, /Another window/u);
      const sibling = path.join(f.project, 'sibling');
      await mkdir(sibling);
      const siblingView = await ProjectExecutionOwner.acquire({ projectUri: sibling, lockRoot: f.locks });
      assert.equal(siblingView.isOwner, false);
      assert.equal(siblingView.projectId, owner.projectId);
      await owner.verify();
      await owner.dispose();
      const successor = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(successor.isOwner, true);
      await successor.dispose();
    } finally { if (owner?.isOwner) await owner.dispose(); await f.cleanup(); }
  });

  it('atomically elects only one of two actual processes and never steals an exited owner', async () => {
    const f = await fixture();
    try {
      const script = `const {ProjectExecutionOwner}=require(process.argv[1]);
        ProjectExecutionOwner.acquire({projectUri:process.argv[2],lockRoot:process.argv[3]})
          .then(o=>console.log(JSON.stringify({owned:o.isOwner,reason:o.reason})))
          .catch(e=>{console.error(e);process.exitCode=1});`;
      const results = await Promise.all([1, 2].map(() => execute(process.execPath, ['-e', script, ownerModule, f.project, f.locks])));
      const states = results.map((result) => JSON.parse(result.stdout) as { owned: boolean });
      if (process.platform === 'win32') { assert.equal(states.filter((state) => state.owned).length, 0); return; }
      assert.equal(states.filter((state) => state.owned).length, 1);
      const later = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(later.isOwner, false);
      assert.match(later.reason!, /inspect detached operations/u);
    } finally { await f.cleanup(); }
  });

  it('fails closed on unreadable owner records, unsupported authorities and lock replacement', async () => {
    const f = await fixture();
    try {
      const remote = await ProjectExecutionOwner.acquire({ projectUri: 'vscode-remote://ssh-remote+host/project', lockRoot: f.locks });
      assert.equal(remote.isOwner, false);
      const owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      await writeFile(path.join(f.locks, `${owner.projectId}.lock`), '{');
      await assert.rejects(() => owner.verify());
      assert.equal(owner.isOwner, false);
      const contender = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(contender.isOwner, false);
      assert.match(contender.reason!, /incomplete|unreadable/u);
    } finally { await f.cleanup(); }
  });

  it('retains ownership while operations are active and after unknown settlement', async () => {
    const f = await fixture();
    try {
      const owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      const release = owner.beginOperation();
      await assert.rejects(() => owner.dispose(), /not settled/u);
      release();
      owner.markUncertainOperation('fixture-unknown');
      await assert.rejects(() => owner.dispose(), /unknown side effects/u);
      const contender = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(contender.isOwner, false);
    } finally { await f.cleanup(); }
  });

  it('invalidates the old owner when its physical root is renamed or replaced', async () => {
    for (const replace of [false, true]) {
      const f = await fixture();
      let replacement: ProjectExecutionOwner | undefined;
      try {
        const owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
        if (!owner.isOwner && process.platform === 'win32') return;
        const frozenId = owner.projectId;
        const moved = path.join(f.base, 'moved');
        await rename(f.project, moved);
        if (replace) {
          await mkdir(path.join(f.project, '.git'), { recursive: true });
          replacement = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
          assert.equal(replacement.isOwner, true);
          assert.notEqual(replacement.projectId, frozenId);
        }
        await assert.rejects(() => owner.verify());
        assert.equal(owner.isOwner, false);
        assert.equal(owner.projectId, frozenId, 'scope invalidation does not rewrite persisted project identity');
        const aliasOfOldRoot = await ProjectExecutionOwner.acquire({ projectUri: moved, lockRoot: f.locks });
        assert.equal(aliasOfOldRoot.isOwner, false, 'old physical root retains its existing lock for inspection');
        assert.equal(aliasOfOldRoot.projectId, frozenId);
      } finally { if (replacement?.isOwner) await replacement.dispose(); await f.cleanup(); }
    }
  });

  it('invalidates removed/replaced Git markers and newly introduced ancestor grouping', async () => {
    for (const change of ['remove', 'replace', 'ancestor'] as const) {
      const f = await fixture();
      try {
        if (change === 'ancestor') await rm(path.join(f.project, '.git'), { recursive: true });
        const nested = path.join(f.project, 'nested');
        await mkdir(nested);
        const owner = await ProjectExecutionOwner.acquire({ projectUri: change === 'ancestor' ? f.project : nested, lockRoot: f.locks });
        if (!owner.isOwner && process.platform === 'win32') return;
        if (change === 'ancestor') await mkdir(path.join(f.base, '.git'));
        else {
          await rename(path.join(f.project, '.git'), path.join(f.base, 'old-git-marker'));
          if (change === 'replace') await mkdir(path.join(f.project, '.git'));
        }
        await assert.rejects(() => owner.verify(), /Physical project root or Git scope changed/u);
        assert.equal(owner.isOwner, false);
      } finally { await f.cleanup(); }
    }
  });

  it('invalidates a selected symlink retargeted to another physical project', async () => {
    const f = await fixture();
    try {
      const alias = path.join(f.base, 'alias');
      const other = path.join(f.base, 'other');
      await mkdir(path.join(other, '.git'), { recursive: true });
      await symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const owner = await ProjectExecutionOwner.acquire({ projectUri: alias, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      await unlink(alias);
      await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => owner.verify(), /Physical project root or Git scope changed/u);
      assert.equal(owner.isOwner, false);
    } finally { await f.cleanup(); }
  });
});

describe('project modification and validation phases', () => {
  it('serializes two workers, validates reentrant ownership and invalidates old baselines', async () => {
    const resources = new ProjectResourceCoordinator('project');
    const a = await resources.acquire(scope('a'));
    const start = deferred();
    const order: string[] = [];
    const b = resources.withLease(scope('b'), async (lease) => { order.push('b'); lease.recordMutation(); start.resolve(); });
    await tick();
    assert.deepEqual(order, []);
    const nested = await resources.acquire(scope('a'), { token: a.token });
    assert.equal(nested.token, a.token);
    await assert.rejects(() => resources.acquire(scope('b'), { token: a.token }), /another task/u);
    a.recordMutation();
    const validation = a.validationStamp('baseline-a');
    assert.equal(resources.isValidationCurrent(validation), true);
    a.release();
    await tick();
    assert.equal(resources.waitingCount, 1);
    nested.release();
    await start.promise;
    await b;
    assert.deepEqual(order, ['b']);
    assert.equal(resources.isValidationCurrent(validation), false);
    assert.throws(() => a.assertValid());
  });

  it('removes cancelled queue entries and refuses new actions from an invalidated segment', async () => {
    const resources = new ProjectResourceCoordinator('project');
    const lease = await resources.acquire(scope('a'));
    const cancelled = new AbortController();
    const waiting = resources.acquire(scope('b'), { signal: cancelled.signal });
    cancelled.abort();
    await assert.rejects(() => waiting, { name: 'AbortError' });
    assert.equal(resources.waitingCount, 0);
    resources.invalidate(scope('a'));
    assert.throws(() => lease.assertValid(), /stale/u);
    await assert.rejects(() => resources.acquire(scope('a'), { token: lease.token }), /invalidated/u);
    lease.release();
    await assert.rejects(() => resources.acquire(scope('a')), /invalidated/u);
    const next = await resources.acquire(scope('b'));
    next.release();
  });

  it('propagates actual project scope through asynchronous nested service phases', async () => {
    const f = await fixture();
    let owner: ProjectExecutionOwner | undefined;
    try {
      owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      const resources = new ProjectResourceCoordinator(owner.projectId);
      await runProjectExecution({ owner, resources, scope: scope('a') }, async () => {
        await withProjectMutationPhase(async (outer) => {
          await tick();
          await assertProjectMutationLease();
          await withProjectMutationPhase(async (inner) => {
            assert.equal(inner!.token, outer!.token);
            inner!.recordMutation();
          });
        });
      });
      assert.equal(resources.activeScope, undefined);
      await owner.dispose();
    } finally { if (owner?.isOwner) await owner.dispose(); await f.cleanup(); }
  });

  it('serializes real SafeFileEditor writes and rejects a second worker old baseline', async () => {
    const f = await fixture();
    const priorFolders = vscode.workspace.workspaceFolders;
    const priorTrust = vscode.workspace.isTrusted;
    let owner: ProjectExecutionOwner | undefined;
    const finish = deferred();
    try {
      owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(f.project), name: 'project' }];
      vscode.workspace.isTrusted = true;
      const resources = new ProjectResourceCoordinator(owner.projectId);
      const target = path.join(f.project, 'target.txt');
      await writeFile(target, 'original');
      const oldHash = createHash('sha256').update('original').digest('hex');
      const edit = (name: string) => ({ id: name, uri: vscode.Uri.file(target).toString(), label: 'target.txt',
        action: 'modify' as const, newText: name, reason: 'Fixture update', expectedOriginalTextHash: oldHash, expectedOriginalSize: 8 });
      const start = deferred();
      const a = runProjectExecution({ owner, resources, scope: scope('a') }, () => new SafeFileEditor().applyDraftEdit(edit('a'), 'set-a', undefined, {
        persist: async (checkpoint) => { if (checkpoint.state === 'prepared') { start.resolve(); await finish.promise; } }
      }));
      await start.promise;
      const b = runProjectExecution({ owner, resources, scope: scope('b') }, () => new SafeFileEditor().applyDraftEdit(edit('b'), 'set-b'));
      await waitFor(() => resources.waitingCount === 1);
      assert.equal(resources.waitingCount, 1);
      finish.resolve();
      await a;
      await assert.rejects(() => b, /cannotApplyChangedDraftTarget/u);
      assert.equal(await readFile(target, 'utf8'), 'a');
      assert.equal(resources.activeScope, undefined);
      await owner.dispose();
    } finally {
      finish.resolve();
      vscode.workspace.workspaceFolders = priorFolders; vscode.workspace.isTrusted = priorTrust;
      if (owner?.isOwner) await owner.dispose(); await f.cleanup();
    }
  });

  it('blocks queued and new mutation phases after an unknown side effect', async () => {
    const resources = new ProjectResourceCoordinator('project');
    const active = await resources.acquire(scope('a'));
    const queued = resources.acquire(scope('b'));
    resources.blockUncertain('unknown-command');
    await assert.rejects(() => queued, /unknown side effects/u);
    active.release();
    await assert.rejects(() => resources.acquire(scope('c')), /unknown side effects/u);
    assert.equal(resources.activeScope, undefined);
  });
});

describe('project source and logical-root admission', () => {
  it('keeps parent root slots separate from child source requests and releases on failures', async () => {
    const admission = new ProjectRequestAdmission({ rootConcurrency: 2, sourceConcurrency: 1, requestConcurrency: 2 });
    const a = await admission.acquireRoot();
    const b = await admission.acquireRoot();
    let rootEntered = false;
    const c = admission.acquireRoot().then((permit) => { rootEntered = true; permit.release(); });
    let active = 0;
    let peak = 0;
    await Promise.all(['worker', 'child', 'reviewer'].map((role) => admission.withRequest({ sourceKey: 'source', role: role as 'worker' | 'child' | 'reviewer' }, async () => {
      active += 1; peak = Math.max(peak, active); await tick(); active -= 1;
    })));
    assert.equal(peak, 1);
    assert.equal(rootEntered, false);
    await assert.rejects(() => admission.withRequest({ sourceKey: 'source', role: 'router' }, async () => { throw new Error('transport'); }), /transport/u);
    assert.equal(admission.snapshot().requests, 0);
    a.release(); await c; b.release();
    assert.equal(admission.snapshot().roots, 0);
  });

  it('holds actual transport admission until SSE body completion and preserves serialized bytes', async () => {
    const f = await fixture();
    let owner: ProjectExecutionOwner | undefined;
    const firstReceived = deferred();
    const releaseFirst = deferred();
    const captured: string[] = [];
    const priorFetch = globalThis.fetch;
    try {
      owner = await ProjectExecutionOwner.acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      globalThis.fetch = async (_url, init) => {
        captured.push(String(init?.body));
        const first = captured.length === 1;
        return new Response(new ReadableStream<Uint8Array>({ start: (controller) => {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"fixture"},"finish_reason":null}]}\n\n'));
          const complete = () => {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n'));
            controller.close();
          };
          if (first) { firstReceived.resolve(); void releaseFirst.promise.then(complete); } else complete();
        } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      const admission = new ProjectRequestAdmission({ sourceConcurrency: 1 });
      const context = { owner, resources: new ProjectResourceCoordinator(owner.projectId), scope: scope('a'), admission };
      const client = new OpenAICompatibleClient({ displayName: 'Fixture' });
      const body = { model: 'fixture', messages: [{ role: 'user' as const, content: 'stable bytes' }], stream: true as const };
      const serializedBody = JSON.stringify(body);
      const config = { apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid/v1', streamIdleTimeoutMs: 0, maxRequestRetries: 0, requestRetryBaseMs: 0 };
      const first = runProjectExecution(context, () => client.createModelResponse(config, { body, serializedBody, language: 'en' }));
      await firstReceived.promise;
      const second = runProjectExecution({ ...context, scope: scope('b'), requestRole: 'child' }, () => client.createModelResponse(config, { body, serializedBody, language: 'en' }));
      await waitFor(() => Object.values(admission.snapshot().sources).some((source) => source.waiting === 1));
      assert.equal(captured.length, 1);
      releaseFirst.resolve();
      const results = await Promise.all([first, second]);
      assert.ok(results.every((result) => result.ok && result.attemptCount === 1));
      assert.deepEqual(captured, [serializedBody, serializedBody]);
      assert.equal(admission.snapshot().requests, 0);
      await owner.dispose();
    } finally {
      releaseFirst.resolve();
      globalThis.fetch = priorFetch;
      if (owner?.isOwner) await owner.dispose(); await f.cleanup();
    }
  });
});
