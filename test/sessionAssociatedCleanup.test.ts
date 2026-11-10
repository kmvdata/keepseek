import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { UsageLedgerStore } from '../src/agent/usageLedgerStore';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { deleteStoredChangeSetsForSession } from '../src/edits/changeSetStore';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import type { DraftRunSpec } from '../src/shared/types';
import { analyzeDraftRunEffects } from '../src/approvals/authorization';
import { SessionDeletionAuthority } from '../src/sessions/sessionDeletionAuthority';

async function fixture(work: (directory: string, uri: import('vscode').Uri) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-associated-cleanup-'));
  try { await work(directory, vscode.Uri.file(directory) as unknown as import('vscode').Uri); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function tombstone(uri: import('vscode').Uri, id: string) {
  const authority = new SessionDeletionAuthority(uri);
  await authority.withSessionGate('workspace', id, () => authority.commitDeletion({ version: 1,
    workspaceKey: 'workspace', sessionId: id, operationId: 'synthetic', confirmedAt: new Date().toISOString(), phase: 'committed' }));
}

test('unloaded approval and command records are removed without replacing another project record', async () => fixture(async (directory, uri) => {
  const approvals = { version: 1, records: [{ reviewId: 'deleted', sessionId: 'delete' }, { reviewId: 'retained', sessionId: 'retain', rationale: 'untouched' }] };
  const commands = { version: 1, draftRuns: [{ id: 'deleted', sessionId: 'delete' }, { id: 'retained', sessionId: 'retain', output: 'untouched' }],
    batchDisplays: [{ operationId: 'deleted', sessionId: 'delete' }, { operationId: 'retained', sessionId: 'retain' }] };
  await writeFile(join(directory, 'approval-reviews.json'), JSON.stringify(approvals));
  await writeFile(join(directory, 'draft-runs.json'), JSON.stringify(commands));
  await tombstone(uri, 'delete');
  await new ApprovalReviewStore(uri).deleteSession('delete');
  // An unloaded store may flush an empty resident snapshot. It must preserve the
  // valid disk record from another project; test command deletion with a store
  // that has no scheduled proposals so it never normalizes the retained record.
  const runs = new DraftRunStore(uri);
  await runs.deleteSession('delete');
  runs.dispose();
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'approval-reviews.json'), 'utf8')).records, [approvals.records[1]]);
  const stored = JSON.parse(await readFile(join(directory, 'draft-runs.json'), 'utf8'));
  assert.ok(stored.draftRuns.every((record: { sessionId: string }) => record.sessionId !== 'delete'));
  assert.ok(stored.batchDisplays.every((record: { sessionId: string }) => record.sessionId !== 'delete'));
}));

test('unloaded ChangeSet V4, V3 and legacy owners are reclaimed; shared checkpoints remain', async () => fixture(async (directory, uri) => {
  const file = (id: string) => createHash('sha256').update(id).digest('hex') + '.json';
  // Match the Store filename authority, whose current format truncates hashes.
  const actualFile = (id: string) => file(id).slice(0, 32) + '.json';
  for (const version of [4, 3]) {
    const root = join(directory, 'change-sets', `v${version}`);
    await mkdir(join(root, 'runtime'), { recursive: true });
    await mkdir(join(root, 'checkpoints'), { recursive: true });
    const entries = [
      { id: 'delete-change', sessionId: 'delete', kind: 'runtime', storageFile: `runtime/${actualFile('delete-change')}`, checkpointIds: ['shared', 'owned'], updatedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'retained-change', sessionId: 'retain', kind: 'runtime', storageFile: `runtime/${actualFile('retained-change')}`, checkpointIds: ['shared'], updatedAt: '2026-01-01T00:00:00.000Z' }
    ];
    await writeFile(join(root, 'index.json'), JSON.stringify({ version, entries }));
    await writeFile(join(root, 'runtime', actualFile('delete-change')), JSON.stringify({ version, changeSet: { id: 'delete-change', sessionId: 'delete', files: [{ checkpointId: 'owned' }, { checkpointId: 'shared' }] } }));
    await writeFile(join(root, 'runtime', actualFile('retained-change')), JSON.stringify({ version, changeSet: { id: 'retained-change', sessionId: 'retain', files: [] } }));
    for (const id of ['shared', 'owned']) await writeFile(join(root, 'checkpoints', actualFile(id)), JSON.stringify({ checkpoint: { id, changeSetId: 'delete-change' } }));
  }
  await writeFile(join(directory, 'change-sets.json'), JSON.stringify({ version: 2,
    changeSets: [{ id: 'deleted-legacy', sessionId: 'delete' }, { id: 'keep-legacy', sessionId: 'retain' }],
    history: [], checkpoints: [{ changeSetId: 'deleted-legacy' }, { changeSetId: 'keep-legacy' }] }));
  await tombstone(uri, 'delete');
  await deleteStoredChangeSetsForSession(uri, 'delete');
  await deleteStoredChangeSetsForSession(uri, 'delete');
  for (const version of [4, 3]) {
    const root = join(directory, 'change-sets', `v${version}`);
    assert.equal(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')).entries.length, 1);
    await assert.rejects(readFile(join(root, 'runtime', actualFile('delete-change'))), { code: 'ENOENT' });
    assert.ok(await readFile(join(root, 'checkpoints', actualFile('shared'))));
    await assert.rejects(readFile(join(root, 'checkpoints', actualFile('owned'))), { code: 'ENOENT' });
  }
  const legacy = JSON.parse(await readFile(join(directory, 'change-sets.json'), 'utf8'));
  assert.deepEqual(legacy.changeSets.map((value: { id: string }) => value.id), ['keep-legacy']);
  assert.deepEqual(legacy.checkpoints, [{ changeSetId: 'keep-legacy' }]);
}));

test('a stale command proposal cannot execute or repersist after durable deletion', async () => fixture(async (directory, uri) => {
  let executions = 0;
  const store = new DraftRunStore(uri, { execute: async () => { executions++; return { exitCode: 0 }; }, cancel: () => {}, dispose: () => {} } as never);
  const spec: DraftRunSpec = { executable: 'git', args: ['status'], cwdUri: vscode.Uri.file(directory).toString(), cwdLabel: 'Synthetic directory', externalCwd: true, env: [], timeoutMs: 1_000, reason: 'Synthetic read' };
  const proposal = { id: 'synthetic', createdAt: new Date().toISOString(), spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) };
  store.addProposals({ proposals: [proposal], agentRunId: 'run', sessionId: 'delete' });
  await store.flush();
  await tombstone(uri, 'delete');
  await store.deleteSession('delete');
  assert.equal(await store.approveAndRun(proposal.id, new Set()), undefined);
  await store.flush();
  assert.equal(executions, 0);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'draft-runs.json'), 'utf8')).draftRuns, []);
  store.dispose();
}));

test('usage ledger deletion propagates permission failures instead of claiming physical success', async () => fixture(async (_directory, uri) => {
  const original = vscode.workspace.fs.delete;
  vscode.workspace.fs.delete = async (target, options) => {
    if (target.toString().includes('/usage-ledger/')) throw Object.assign(new Error('Synthetic permission failure'), { code: 'EACCES' });
    return original(target, options);
  };
  try { await assert.rejects(new UsageLedgerStore(uri).deleteSession('delete'), { code: 'EACCES' }); }
  finally { vscode.workspace.fs.delete = original; }
}));

test('blank-history proof checks owned records without reading a legacy checkpoint body', async () => fixture(async (directory, uri) => {
  const { SessionAssociatedDataCleanup } = await import('../src/sessions/sessionAssociatedDataCleanup.js');
  const { ToolEvidenceStore } = await import('../src/agent/evidence/store.js');
  const associated = new SessionAssociatedDataCleanup(uri);
  assert.equal(await associated.hasSessionHistory('blank', 'workspace'), false);
  await new ToolEvidenceStore(uri).ensureIntent({ sessionId: 'owned', taskId: 'task', toolCallId: 'call', toolName: 'synthetic', argumentsHash: 'hash', effectKind: 'read' });
  assert.equal(await associated.hasSessionHistory('owned', 'workspace'), true);
  await writeFile(join(directory, 'change-sets.json'), JSON.stringify({ version: 2, checkpoints: [{ privateCheckpoint: 'must not be hydrated' }] }));
  const originalRead = vscode.workspace.fs.readFile;
  let checkpointReads = 0;
  vscode.workspace.fs.readFile = async target => {
    if (target.fsPath === join(directory, 'change-sets.json')) checkpointReads++;
    return originalRead(target);
  };
  try { await assert.rejects(associated.hasSessionHistory('blank', 'workspace'), /checkpoint hydration/); }
  finally { vscode.workspace.fs.readFile = originalRead; }
  assert.equal(checkpointReads, 0);
}));

test('one trace batch recycler sees owners created after its first metadata scan', async () => fixture(async (directory, uri) => {
  const { withOwnedTraceWrite } = await import('../src/agent/logging/performanceTrace.js');
  const { InteractionTraceCleanup } = await import('../src/agent/logging/interactionTrace.js');
  const logs = join(directory, 'interaction-logs', '2026-11-10');
  await mkdir(logs, { recursive: true });
  const write = async (sessionId: string) => {
    const base = vscode.Uri.file(join(logs, `run-20261110-${sessionId}.jsonl`)) as unknown as import('vscode').Uri;
    await withOwnedTraceWrite(base, sessionId, { root: uri, sessionId }, () => writeFile(base.fsPath, 'synthetic trace'));
    return base;
  };
  const first = await write('first');
  await tombstone(uri, 'first');
  const recycler = new InteractionTraceCleanup(uri);
  await recycler.cleanup('first');
  await assert.rejects(readFile(first.fsPath), { code: 'ENOENT' });
  const second = await write('second');
  await tombstone(uri, 'second');
  await recycler.cleanup('second');
  await assert.rejects(readFile(second.fsPath), { code: 'ENOENT' });
}));

test('ChangeSet physical cleanup rejects an index collision and preserves the actual owner', async () => fixture(async (directory, uri) => {
  const root = join(directory, 'change-sets', 'v4');
  await mkdir(join(root, 'runtime'), { recursive: true });
  const file = createHash('sha256').update('collision').digest('hex').slice(0, 32) + '.json';
  const index = { version: 4, customUnrelatedMetadata: 'preserve', entries: [{ id: 'collision', sessionId: 'delete', kind: 'runtime',
    storageFile: `runtime/${file}`, checkpointIds: [], updatedAt: '2026-01-01T00:00:00.000Z' }] };
  const actual = { version: 4, changeSet: { id: 'collision', sessionId: 'retain', files: [] } };
  await writeFile(join(root, 'index.json'), JSON.stringify(index));
  await writeFile(join(root, 'runtime', file), JSON.stringify(actual));
  await assert.rejects(deleteStoredChangeSetsForSession(uri, 'delete'), /owner identity changed/);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'runtime', file), 'utf8')), actual);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')), index);
}));

test('ChangeSet physical cleanup reports a permission failure during orphan enumeration', async () => fixture(async (directory, uri) => {
  const original = vscode.workspace.fs.readDirectory;
  vscode.workspace.fs.readDirectory = async target => {
    if (target.fsPath === join(directory, 'change-sets', 'v4', 'runtime')) throw Object.assign(new Error('Synthetic permission failure'), { code: 'EACCES' });
    return original(target);
  };
  try { await assert.rejects(deleteStoredChangeSetsForSession(uri, 'delete'), { code: 'EACCES' }); }
  finally { vscode.workspace.fs.readDirectory = original; }
}));
