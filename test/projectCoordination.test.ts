import './registerVscodeStub';
import '../src/agent/providerRequestProjection';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it, type TestContext } from 'node:test';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ProjectExecutionOwner, type ProjectOwnerOptions } from '../src/tasks/projectOwner';
import { LocalKernelMutex } from '../src/tasks/localKernelMutex';
import { configureProcessIdentityTestProbe } from '../src/tasks/projectOperationJournal';
import { ProjectResourceCoordinator, runProjectExecution, withProjectMutationPhase, assertProjectMutationLease, type ProjectExecutionScope } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import * as vscode from './stubs/vscode';

const testOwners = new Set<ProjectExecutionOwner>();
async function acquire(options: ProjectOwnerOptions): Promise<ProjectExecutionOwner> {
  const owner = await ProjectExecutionOwner.acquire(options); testOwners.add(owner); return owner;
}
async function nativeBackend(t: TestContext): Promise<boolean> {
  try { const lease = await LocalKernelMutex.acquireNative(`native-test-${process.pid}`); await lease?.release(); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') { t.skip('Managed environment denies native local socket bind; process-lock contract remains unverified here.'); return false; } throw error; }
}
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
  return { base, project, locks, cleanup: async () => { for (const owner of testOwners) { if (owner.canonicalRoot.startsWith(base)) { await owner.dispose(); testOwners.delete(owner); } } await rm(base, { recursive: true, force: true }); } };
}

describe('physical project execution ownership', () => {
  it('refuses a second live process, symlink aliases and different workspace roots', async (t) => {
    if (!await nativeBackend(t)) return;
    const f = await fixture();
    let owner: ProjectExecutionOwner | undefined;
    try {
      const nested = path.join(f.project, 'nested');
      const alias = path.join(f.base, 'alias');
      await mkdir(nested);
      await symlink(f.project, alias, process.platform === 'win32' ? 'junction' : 'dir');
      owner = await acquire({ projectUri: pathToFileURL(nested).toString(), lockRoot: f.locks, mutexBackend: 'native' });
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
      const siblingView = await acquire({ projectUri: sibling, lockRoot: f.locks, mutexBackend: 'native' });
      assert.equal(siblingView.isOwner, false);
      assert.equal(siblingView.projectId, owner.projectId);
      await owner.verify();
      await owner.dispose();
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks, mutexBackend: 'native' });
      assert.equal(successor.isOwner, true);
      await successor.dispose();
    } finally { if (owner?.isOwner) await owner.dispose(); await f.cleanup(); }
  });

  it('atomically elects only one of two actual processes and recovers an exited clean owner', async (t) => {
    if (!await nativeBackend(t)) return;
    const f = await fixture();
    try {
      const script = `const {ProjectExecutionOwner}=require(process.argv[1]);
        ProjectExecutionOwner.acquire({projectUri:process.argv[2],lockRoot:process.argv[3]})
          .then(o=>{console.log(JSON.stringify({owned:o.isOwner,reason:o.reason}));setTimeout(()=>{},350)})
          .catch(e=>{console.error(e);process.exitCode=1});`;
      const results = await Promise.all([1, 2].map(() => execute(process.execPath, ['-e', script, ownerModule, f.project, f.locks])));
      const states = results.map((result) => JSON.parse(result.stdout) as { owned: boolean });
      assert.equal(states.filter((state) => state.owned).length, 1);
      const later = await acquire({ projectUri: f.project, lockRoot: f.locks, mutexBackend: 'native' });
      assert.equal(later.isOwner, true);
      await later.dispose();
    } finally { await f.cleanup(); }
  });

  it('recovers after SIGKILL and elects only one of two simultaneous native recoverers', async (t) => {
    if (!await nativeBackend(t)) return;
    const f = await fixture();
    const script = `const {ProjectExecutionOwner}=require(process.argv[1]);
      ProjectExecutionOwner.acquire({projectUri:process.argv[2],lockRoot:process.argv[3]})
        .then(o=>{console.log(JSON.stringify({owned:o.isOwner}));setInterval(()=>{},1000)})
        .catch(e=>{console.error(e);process.exit(1)});`;
    const child = spawn(process.execPath, ['-e', script, ownerModule, f.project, f.locks], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const first = await new Promise<{ owned: boolean }>((resolve, reject) => {
        let output = ''; child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('\n')) resolve(JSON.parse(output.trim())); });
        child.once('error', reject); child.once('exit', () => { if (!output.includes('\n')) reject(new Error('Owner fixture exited before ready.')); });
      });
      assert.equal(first.owned, true);
      const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL'); await exited;
      const compete = `const {ProjectExecutionOwner}=require(process.argv[1]);
        ProjectExecutionOwner.acquire({projectUri:process.argv[2],lockRoot:process.argv[3]})
          .then(o=>{console.log(JSON.stringify({owned:o.isOwner}));setTimeout(()=>{},350)});`;
      const results = await Promise.all([1, 2].map(() => execute(process.execPath, ['-e', compete, ownerModule, f.project, f.locks])));
      assert.equal(results.filter(result => (JSON.parse(result.stdout) as { owned: boolean }).owned).length, 1);
    } finally { child.kill('SIGKILL'); await f.cleanup(); }
  });

  it('fails closed on unreadable owner records, unsupported authorities and lock replacement', async () => {
    const f = await fixture();
    try {
      const remote = await acquire({ projectUri: 'vscode-remote://ssh-remote+host/project', lockRoot: f.locks });
      assert.equal(remote.isOwner, false);
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      await writeFile(path.join(f.locks, `${owner.projectId}.lock`), '{');
      await assert.rejects(() => owner.verify());
      assert.equal(owner.isOwner, false);
      const contender = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(contender.isOwner, false);
      assert.equal(contender.state.status, 'owned_elsewhere', 'invalidated metadata does not release the continuous exclusion fence');
      await owner.dispose();
      await contender.retryAcquire();
      assert.match(contender.reason!, /incomplete|unreadable/u);
    } finally { await f.cleanup(); }
  });

  it('retains the mutex while operations are active and preserves unknown settlement across shutdown', async () => {
    const f = await fixture();
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      const release = owner.beginOperation();
      await assert.rejects(() => owner.dispose(), /not settled/u);
      release();
      owner.markUncertainOperation('fixture-unknown');
      await owner.dispose();
      const contender = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(contender.isOwner, false);
      assert.equal(contender.state.reasonCode, 'operation_unsettled');
    } finally { await f.cleanup(); }
  });

  it('invalidates the old owner when its physical root is renamed or replaced', async () => {
    for (const replace of [false, true]) {
      const f = await fixture();
      let replacement: ProjectExecutionOwner | undefined;
      try {
        const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
        if (!owner.isOwner && process.platform === 'win32') return;
        const frozenId = owner.projectId;
        const moved = path.join(f.base, 'moved');
        await rename(f.project, moved);
        if (replace) {
          await mkdir(path.join(f.project, '.git'), { recursive: true });
          replacement = await acquire({ projectUri: f.project, lockRoot: f.locks });
          assert.equal(replacement.isOwner, false, 'same path with a new inode still overlaps the live predecessor scope');
          assert.equal(replacement.state.reasonCode, 'overlapping_project_scope');
          assert.notEqual(replacement.projectId, frozenId);
        }
        await assert.rejects(() => owner.verify());
        assert.equal(owner.isOwner, false);
        assert.equal(owner.projectId, frozenId, 'scope invalidation does not rewrite persisted project identity');
        const aliasOfOldRoot = await acquire({ projectUri: moved, lockRoot: f.locks });
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
        const owner = await acquire({ projectUri: change === 'ancestor' ? f.project : nested, lockRoot: f.locks });
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
      const owner = await acquire({ projectUri: alias, lockRoot: f.locks });
      if (!owner.isOwner && process.platform === 'win32') return;
      await unlink(alias);
      await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await assert.rejects(() => owner.verify(), /Physical project root or Git scope changed/u);
      assert.equal(owner.isOwner, false);
    } finally { await f.cleanup(); }
  });

  it('fences an ancestor Git regrouping while the old child scope is running work', async () => {
    const f = await fixture();
    try {
      await rm(path.join(f.project, '.git'), { recursive: true });
      const old = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const release = old.beginOperation();
      await mkdir(path.join(f.base, '.git'));
      const grouped = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.notEqual(grouped.projectId, old.projectId);
      assert.equal(grouped.isOwner, false); assert.equal(grouped.state.reasonCode, 'overlapping_project_scope');
      await assert.rejects(() => old.verify(), /scope changed/u);
      await assert.rejects(() => old.dispose(), /not settled/u);
      release(); await old.dispose();
      await grouped.retryAcquire();
      assert.equal(grouped.isOwner, true);
    } finally { await f.cleanup(); }
  });

  it('keeps an overlapping crashed scope isolated until its recorded process group ends', async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    try {
      await rm(path.join(f.project, '.git'), { recursive: true });
      const old = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const operation = await old.beginDurableOperation({ id: 'old-scope-command', kind: 'command', gated: true });
      await operation.dispatched({ pid: child.pid, processGroup: process.platform === 'win32' ? undefined : child.pid });
      await old.dispose();
      await mkdir(path.join(f.base, '.git'));
      const grouped = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(grouped.isOwner, false); assert.equal(grouped.state.reasonCode, 'overlapping_project_scope');
      const exit = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await exit;
      await grouped.retryAcquire();
      assert.equal(grouped.isOwner, true);
    } finally { child.kill('SIGKILL'); await f.cleanup(); }
  });

  it('updates an existing observer after a clean owner shutdown without dispatching work', async () => {
    const f = await fixture();
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const observer = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const observed: string[] = [];
      const stop = observer.onDidChange(state => observed.push(state.status));
      assert.equal(observer.isOwner, false);
      const revision = observer.state.revision;
      await owner.dispose(); await owner.dispose();
      await Promise.all([observer.retryAcquire(), observer.retryAcquire()]);
      assert.equal(observer.isOwner, true); assert.equal(observer.canWriteStorage, true);
      assert.ok(observer.state.revision > revision); assert.ok(observed.includes('recovering')); assert.equal(observed.at(-1), 'owned');
      assert.deepEqual((await observer.diagnostics()).operations, []);
      stop();
    } finally { await f.cleanup(); }
  });

  it('recovers a gated pre-dispatch intent and preserves an in-process Apply unknown receipt', async () => {
    const f = await fixture();
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      await owner.beginDurableOperation({ id: 'never-granted', kind: 'command', gated: true });
      const apply = await owner.beginDurableOperation({ id: 'apply-interrupted', kind: 'apply', targetUri: pathToFileURL(path.join(f.project, 'a.txt')).toString(), baseHash: 'base', resultHash: 'result' });
      await apply.dispatched({});
      await owner.dispose();
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(successor.isOwner, true);
      const operations = (await successor.diagnostics()).operations;
      assert.equal(operations.find(operation => operation.id === 'never-granted')?.state, 'not_dispatched');
      assert.equal(operations.find(operation => operation.id === 'apply-interrupted')?.state, 'result_unknown');
      assert.equal(operations.find(operation => operation.id === 'apply-interrupted')?.processState, 'ended');
    } finally { await f.cleanup(); }
  });

  it('keeps first legacy observations isolated and recovers only after a stable boot-session change', async () => {
    for (const bootEvidence of ['missing', 'same-boot', 'rebooted', 'wrong-host'] as const) {
      const f = await fixture();
      try {
        const initial = await acquire({ projectUri: f.project, lockRoot: f.locks });
        const lock = path.join(f.locks, `${initial.projectId}.lock`);
        const record = JSON.parse(await readFile(lock, 'utf8')) as Record<string, unknown>;
        await initial.dispose();
        record.version = 1; record.processId = 2147483647;
        record.acquiredAt = new Date(Date.now() - 10_000).toISOString();
        if (bootEvidence === 'wrong-host') record.hostname = 'different-host';
        await writeFile(lock, JSON.stringify(record));
        let bootId = `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000001`;
        const recovered = await acquire({ projectUri: f.project, lockRoot: f.locks,
          bootIdentityProbe: async () => bootEvidence === 'missing' ? undefined : bootId });
        assert.equal(recovered.isOwner, false, 'a first observation never proves that old descendants exited');
        if (bootEvidence === 'rebooted') bootId = `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000002`;
        await recovered.retryAcquire();
        assert.equal(recovered.isOwner, bootEvidence === 'rebooted');
        if (bootEvidence === 'rebooted') {
          assert.equal((JSON.parse(await readFile(lock, 'utf8')) as { version: number }).version, 2);
        } else assert.match(recovered.reason!, bootEvidence === 'wrong-host' ? /different scope or host/u : bootEvidence === 'missing' ? /identity is unavailable/u : /restart the computer/u);
      } finally { await f.cleanup(); }
    }
  });

  it('never lets apparent clock/boot changes override live or unverifiable legacy PID isolation', async () => {
    for (const probe of ['live', 'denied'] as const) {
      const f = await fixture(); const originalKill = process.kill;
      try {
        const initial = await acquire({ projectUri: f.project, lockRoot: f.locks });
        const lock = path.join(f.locks, `${initial.projectId}.lock`);
        const record = JSON.parse(await readFile(lock, 'utf8')) as Record<string, unknown>;
        await initial.dispose();
        record.version = 1; record.processId = process.pid; record.acquiredAt = '1970-01-01T00:00:00Z';
        const original = JSON.stringify(record); await writeFile(lock, original);
        if (probe === 'denied') process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
          if (pid === process.pid && signal === 0) { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }
          return originalKill(pid, signal);
        }) as typeof process.kill;
        let bootChecks = 0;
        const blocked = await acquire({ projectUri: f.project, lockRoot: f.locks, bootIdentityProbe: async () => { bootChecks++; return `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000004`; } });
        assert.equal(blocked.isOwner, false); assert.equal(blocked.state.reasonCode, 'legacy_owner_live_or_unverifiable');
        assert.equal(bootChecks, 0, 'legacy PID guard precedes even a claimed different boot identity');
        assert.equal(await readFile(lock, 'utf8'), original);
      } finally { process.kill = originalKill; await f.cleanup(); }
    }
  });

  it('proves a journal reboot only from a changed stored stable boot identity, never old timestamps', async () => {
    for (const storedIdentity of [false, true]) {
      const f = await fixture();
      try {
        const original = await acquire({ projectUri: f.project, lockRoot: f.locks,
          bootIdentityProbe: async () => storedIdentity ? `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000001` : undefined });
        await original.beginDurableOperation({ id: 'unknown-dispatch', kind: 'command' });
        await original.dispose();
        const journal = path.join(f.locks, `${original.projectId}.operations.json`);
        const saved = JSON.parse(await readFile(journal, 'utf8')) as { operations: Array<{ createdAt: string }> };
        saved.operations[0].createdAt = '1970-01-01T00:00:00Z'; await writeFile(journal, JSON.stringify(saved));
        const successor = await acquire({ projectUri: f.project, lockRoot: f.locks,
          bootIdentityProbe: async () => `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000002` });
        assert.equal(successor.isOwner, storedIdentity, 'missing boot identity cannot be replaced with timestamp inference');
        if (!storedIdentity) assert.equal(successor.state.reasonCode, 'operation_unsettled');
      } finally { await f.cleanup(); }
    }
  });

  it('binds damaged-lock reboot observations to exact bytes so changed records require a new observation', async () => {
    const f = await fixture();
    try {
      const original = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const lock = path.join(f.locks, `${original.projectId}.lock`); await original.dispose();
      await writeFile(lock, '{first-corrupt');
      let bootId = `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000001`;
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks, bootIdentityProbe: async () => bootId });
      assert.equal(successor.isOwner, false);
      bootId = `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000002`;
      await writeFile(lock, '{different-corrupt'); await successor.retryAcquire();
      assert.equal(successor.isOwner, false, 'different lock bytes cannot reuse the older boot observation');
      bootId = `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000003`; await successor.retryAcquire();
      assert.equal(successor.isOwner, true);
    } finally { await f.cleanup(); }
  });

  it('rejects malformed or foreign journal boot identities instead of treating them as reboot proof', async () => {
    for (const bootIdentity of [123, '', 'other-platform:other-host:boot', `${process.platform}:${os.hostname()}:malformed-boot`]) {
      const f = await fixture();
      try {
        const original = await acquire({ projectUri: f.project, lockRoot: f.locks });
        await original.beginDurableOperation({ id: 'unknown', kind: 'command' }); await original.dispose();
        const journal = path.join(f.locks, `${original.projectId}.operations.json`);
        const saved = JSON.parse(await readFile(journal, 'utf8')) as { operations: Array<{ bootIdentity?: unknown }> };
        saved.operations[0].bootIdentity = bootIdentity; await writeFile(journal, JSON.stringify(saved));
        const successor = await acquire({ projectUri: f.project, lockRoot: f.locks,
          bootIdentityProbe: async () => `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000002` });
        assert.equal(successor.isOwner, false); assert.equal(successor.state.status, 'error');
      } finally { await f.cleanup(); }
    }
  });

  it('keeps a live detached process group isolated and permits new work after verified termination', async () => {
    const f = await fixture();
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: process.platform !== 'win32', stdio: 'ignore' });
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const operation = await owner.beginDurableOperation({ id: 'detached', kind: 'command', gated: true });
      await operation.dispatched({ pid: child.pid, processGroup: process.platform === 'win32' ? undefined : child.pid });
      await owner.dispose();
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(successor.isOwner, false); assert.equal(successor.state.reasonCode, 'operation_unsettled');
      const exit = new Promise<void>(resolve => child.once('close', () => resolve()));
      child.kill('SIGKILL'); await exit;
      await successor.retryAcquire();
      assert.equal(successor.isOwner, true);
      const record = (await successor.diagnostics()).operations.find(item => item.id === 'detached');
      assert.equal(record?.state, 'result_unknown'); assert.equal(record?.processState, 'ended');
    } finally { child.kill('SIGKILL'); await f.cleanup(); }
  });

  it('uses controlled PID-reuse identity evidence and blocks denied liveness probes', async () => {
    const f = await fixture();
    const originalKill = process.kill;
    configureProcessIdentityTestProbe(async pid => pid === process.pid ? 'current-process-identity' : undefined);
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const operation = await owner.beginDurableOperation({ id: 'reused-pid', kind: 'command', gated: true });
      await operation.dispatched({ pid: process.pid, processIdentity: 'previous-process-start-identity' });
      await owner.dispose();
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(successor.isOwner, true);
      assert.equal((await successor.diagnostics()).operations.find(item => item.id === 'reused-pid')?.processState, 'ended');
      const unknown = await successor.beginDurableOperation({ id: 'denied-probe', kind: 'command', gated: true });
      await unknown.dispatched({ pid: process.pid }); await successor.dispose();
      process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === process.pid && signal === 0) { const error = new Error('denied') as NodeJS.ErrnoException; error.code = 'EPERM'; throw error; }
        return originalKill(pid, signal);
      }) as typeof process.kill;
      const denied = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(denied.isOwner, false); assert.equal(denied.state.reasonCode, 'operation_unsettled');
    } finally { process.kill = originalKill; configureProcessIdentityTestProbe(); await f.cleanup(); }
  });

  it('bounds startup journal receipts while durable archived identifiers still reject replay', async () => {
    const f = await fixture();
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      for (let index = 0; index < 67; index += 1) {
        const operation = await owner.beginDurableOperation({ id: `receipt-${index}`, kind: 'command', gated: true });
        await operation.settle('not_dispatched');
      }
      assert.equal((await owner.diagnostics()).operations.length, 64);
      await assert.rejects(() => owner.beginDurableOperation({ id: 'receipt-0', kind: 'command', gated: true }), /archived operation identifier/u);
      await owner.dispose();
      const successor = await acquire({ projectUri: f.project, lockRoot: f.locks });
      assert.equal(successor.isOwner, true);
      assert.equal((await successor.diagnostics()).operations.length, 64);
      await assert.rejects(() => successor.beginDurableOperation({ id: 'receipt-0', kind: 'command', gated: true }), /archived operation identifier/u);
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
      owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
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
      owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
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

  it('reconciles resource isolation only after the owner journal reaches a drained generation', async () => {
    const f = await fixture();
    try {
      const owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
      const resources = new ProjectResourceCoordinator(owner.projectId);
      const active = await resources.acquire(scope('a'));
      assert.throws(() => resources.reconcileOwnerRecovery(owner), /settled resource boundary/u);
      active.release(); resources.blockUncertain('old-result');
      const revision = resources.resourceRevision;
      resources.reconcileOwnerRecovery(owner);
      assert.ok(resources.resourceRevision > revision);
      const next = await resources.acquire(scope('b')); next.release();
      assert.throws(() => new ProjectResourceCoordinator('other').reconcileOwnerRecovery(owner), /settled resource boundary/u);
    } finally { await f.cleanup(); }
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
      owner = await acquire({ projectUri: f.project, lockRoot: f.locks });
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
