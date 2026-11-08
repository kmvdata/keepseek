import './registerVscodeStub';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { inspectValidationRecoveryMetadata } from '../src/agent/tools/validationTools';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-legacy-diagnostics-'));
  const uri = vscode.Uri.file(directory);
  const sessions = new ChatSessionStore(new GlobalSessionStorage(uri), 'en');
  sessions.initializeFreshBoot();
  const diff = new DraftDiffService();
  return { directory, uri, drafts: new DraftRunStore(uri),
    changes: new ChangeSetStore(new SafeFileEditor(), diff, sessions, uri, key => key),
    cleanup: async () => { diff.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('explicit legacy metadata diagnostics preserve exact aggregates and never expose command output or checkpoint text', async () => {
  const f = await fixture();
  try {
    const draftBytes = JSON.stringify({ version: 1, draftRuns: [
      { id: 'old-running', status: 'running', startedAt: '2026-11-07T00:00:00Z', spec: { args: ['PRIVATE-ARGV'], cwdUri: 'file:///PRIVATE-ROOT' }, outputHead: 'PRIVATE-OUTPUT' },
      { id: 'old-unknown', status: 'failed', executionPhase: 'result_unknown', outputTail: 'PRIVATE-OUTPUT' },
      { id: 'done', status: 'done', executionStarted: true }
    ] });
    const changeBytes = JSON.stringify({ version: 2, changeSets: [{ id: 'set-old', files: [{ newText: 'PRIVATE-BODY' }] }],
      checkpoints: [{ id: 'cp-prepared', state: 'prepared', originalText: 'PRIVATE-BODY', uri: 'file:///PRIVATE-ROOT' },
        { id: 'cp-unknown', state: 'uncertain', originalText: 'PRIVATE-BODY' }] });
    await writeFile(path.join(f.directory, 'draft-runs.json'), draftBytes);
    await writeFile(path.join(f.directory, 'change-sets.json'), changeBytes);
    const before = (await readdir(f.directory)).sort();
    const drafts = await f.drafts.inspectPersistedMetadata();
    const changes = await f.changes.inspectPersistedMetadata();
    assert.equal(drafts.records, 3); assert.equal(drafts.unsettled, 1); assert.equal(drafts.unknown, 1);
    assert.equal(changes.records, 1); assert.equal(changes.unsettled, 2); assert.equal(changes.unknown, 1);
    assert.equal(drafts.settlementProof, false); assert.equal(changes.settlementProof, false);
    assert.doesNotMatch(JSON.stringify({ drafts, changes }), /PRIVATE-|old-running|cp-unknown/u);
    assert.equal(await readFile(path.join(f.directory, 'draft-runs.json'), 'utf8'), draftBytes);
    assert.equal(await readFile(path.join(f.directory, 'change-sets.json'), 'utf8'), changeBytes);
    assert.deepEqual((await readdir(f.directory)).sort(), before, 'diagnostics create no migration/index/receipt files');
    assert.equal(f.drafts.get('old-running'), undefined, 'diagnostics do not initialize or repair the execution store');
  } finally { await f.cleanup(); }
});

test('explicit diagnostics read independent lanes and checkpoint metadata without migrating V3/V4 indexes', async () => {
  const f = await fixture();
  try {
    const lane = path.join(f.directory, 'draft-runs', 'sessions');
    const checkpoints = path.join(f.directory, 'change-sets', 'v4', 'checkpoints');
    await mkdir(lane, { recursive: true }); await mkdir(checkpoints, { recursive: true });
    const laneFile = path.join(lane, 'a'.repeat(32) + '.json');
    await writeFile(laneFile, JSON.stringify({ version: 1, sessionId: 's', draftRuns: [{ id: 'lane-run', status: 'approved' }] }));
    const index = path.join(f.directory, 'change-sets', 'v4', 'index.json');
    const indexBytes = JSON.stringify({ version: 4, entries: [{ id: 'set-v4', kind: 'runtime', checkpointIds: ['checkpoint'] }] });
    await writeFile(index, indexBytes);
    const checkpointFile = path.join(checkpoints, createHash('sha256').update('checkpoint').digest('hex').slice(0, 32) + '.json');
    await writeFile(checkpointFile, JSON.stringify({ version: 4, checkpoint: { id: 'checkpoint', state: 'applying', originalText: 'NOT-EXPOSED' } }));
    const [drafts, changes] = await Promise.all([f.drafts.inspectPersistedMetadata(), f.changes.inspectPersistedMetadata()]);
    assert.equal(drafts.records, 1); assert.equal(drafts.unsettled, 1);
    assert.equal(changes.records, 1); assert.equal(changes.states.checkpoint_applying, 1);
    assert.equal(await readFile(index, 'utf8'), indexBytes);
    assert.doesNotMatch(JSON.stringify({ drafts, changes }), /NOT-EXPOSED|lane-run/u);
  } finally { await f.cleanup(); }
});

test('metadata bounds and unreadable formats are explicit partial results, never settlement proof', async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.directory, 'draft-runs.json'), '{');
    assert.equal((await f.drafts.inspectPersistedMetadata()).availability, 'partial');
    await writeFile(path.join(f.directory, 'draft-runs.json'), JSON.stringify({ version: 1, draftRuns: [], outputHead: 'x'.repeat(100) }));
    const bounded = await f.drafts.inspectPersistedMetadata({ maxFileBytes: 16 });
    assert.equal(bounded.truncated, true); assert.equal(bounded.filesRead, 0); assert.equal(bounded.settlementProof, false);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(() => f.drafts.inspectPersistedMetadata({ signal: cancelled.signal }), { name: 'AbortError' });
    const validation = inspectValidationRecoveryMetadata([], true);
    assert.equal(validation.availability, 'unavailable'); assert.equal(validation.settlementProof, false);
    const journal = inspectValidationRecoveryMetadata([{ kind: 'validation', state: 'dispatched', processState: 'running' }], false);
    assert.equal(journal.records, 1); assert.equal(journal.unsettled, 1);
  } finally { await f.cleanup(); }
});

test('disposing during initial owner readiness is shared, drains acquisition and never republishes owned', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-owner-dispose-initial-'));
  try {
    const acquisition = ProjectExecutionOwner.startAcquire({ projectUri: directory, lockRoot: path.join(directory, 'locks') });
    const observed: string[] = [];
    acquisition.owner.onDidChange(state => observed.push(state.status));
    const first = acquisition.owner.dispose(), second = acquisition.owner.dispose();
    assert.equal(first, second);
    await first; await acquisition.ready;
    assert.equal(acquisition.owner.isOwner, false); assert.equal(acquisition.owner.canWriteStorage, false);
    assert.equal(observed.includes('owned'), false);
    const successor = await ProjectExecutionOwner.acquire({ projectUri: directory, lockRoot: path.join(directory, 'locks') });
    assert.equal(successor.isOwner, true, successor.reason); await successor.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('disposing while durable owner recovery is paused waits for that check before releasing its kernel fence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-owner-dispose-check-'));
  const locks = path.join(directory, 'locks');
  try {
    const initial = await ProjectExecutionOwner.acquire({ projectUri: directory, lockRoot: locks });
    const lock = path.join(locks, `${initial.projectId}.lock`);
    const saved = JSON.parse(await readFile(lock, 'utf8')) as Record<string, unknown>;
    await initial.dispose();
    saved.version = 1; saved.processId = 2147483647; saved.acquiredAt = new Date(Date.now() - 10_000).toISOString();
    await writeFile(lock, JSON.stringify(saved));
    const observed = await ProjectExecutionOwner.acquire({ projectUri: directory, lockRoot: locks,
      bootIdentityProbe: async () => `${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000001` });
    assert.equal(observed.isOwner, false); await observed.dispose();
    let reached!: () => void, release!: (bootIdentity: string) => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const boot = new Promise<string>(resolve => { release = resolve; });
    const acquisition = ProjectExecutionOwner.startAcquire({ projectUri: directory, lockRoot: locks,
      bootIdentityProbe: () => { reached(); return boot; } });
    const published: string[] = []; acquisition.owner.onDidChange(state => published.push(state.status));
    await paused;
    let stopped = false;
    const first = acquisition.owner.dispose(), second = acquisition.owner.dispose();
    assert.equal(first, second); void first.then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(stopped, false, 'shutdown retains exclusion while the pending check may write durable metadata');
    release(`${process.platform}:${os.hostname()}:00000000-0000-4000-8000-000000000002`); await first; await acquisition.ready;
    assert.equal(acquisition.owner.isOwner, false); assert.equal(published.includes('owned'), false);
    const successor = await ProjectExecutionOwner.acquire({ projectUri: directory, lockRoot: locks });
    assert.equal(successor.isOwner, true, successor.reason); await successor.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
