import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readdir, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from './stubs/vscode';
import { ToolEvidenceStore } from '../src/agent/evidence/store';
import { SubagentStore } from '../src/agent/subagents/store';
import { InteractionTraceLogService, InteractionTraceCleanup } from '../src/agent/logging/interactionTrace';
import { SessionDeletionAuthority } from '../src/sessions/sessionDeletionAuthority';
import type { StoredSubagentMetadata } from '../src/agent/subagents/types';

async function deleted(authority: SessionDeletionAuthority, sessionId: string) {
  await authority.withSessionGate('workspace', sessionId, () => authority.commitDeletion({
    version: 1, workspaceKey: 'workspace', sessionId, operationId: 'synthetic-cleanup',
    confirmedAt: new Date().toISOString(), phase: 'committed'
  }));
}

const metadata = (parentSessionId: string): StoredSubagentMetadata => ({
  version: 1, id: 'sa_test', parentSessionId, treeId: 'tree', parentRunId: 'run', rootRunId: 'run',
  depth: 1, profile: 'research', lane: 'research-read', task: 'Synthetic inspection', status: 'completed',
  sourceId: 'source', modelId: 'model', provider: 'deepseek', sourceConfigHash: 'source-hash',
  systemPromptHash: 'system-hash', toolSchemaHash: 'tools-hash', profileHash: 'profile-hash',
  projectInstructionsHash: 'project-hash', authorizationContextHash: 'auth-hash', workspaceContextHash: 'workspace-hash',
  normalizedTaskHash: 'task-hash', resultStatus: 'complete',
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z'
});

test('durable deletion rejects evidence cached reads and all late writers after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-evidence-cleanup-'));
  try {
    const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
    const authority = new SessionDeletionAuthority(uri), store = new ToolEvidenceStore(uri);
    const intent = { sessionId: 'session', taskId: 'task', toolCallId: 'call', toolName: 'synthetic_read',
      argumentsHash: 'hash', effectKind: 'read' as const };
    const record = await store.complete(await store.ensureIntent(intent), 'synthetic evidence');
    const retained = await store.complete(await store.ensureIntent({ ...intent, sessionId: 'retained' }), 'keep evidence');
    await deleted(authority, 'session');
    assert.equal(await store.findByRef(record.evidenceRef, 'session', 'task'), undefined);
    await assert.rejects(store.readContent(record), /deleted/iu);
    await assert.rejects(store.saveEpochSnapshot('session', 'task', 1, {}));
    await assert.rejects(store.markDelivered(record));
    await assert.rejects(new ToolEvidenceStore(uri).ensureIntent(intent));
    await store.deleteSessionEvidence('session');
    await store.deleteSessionEvidence('session');
    assert.equal(await new ToolEvidenceStore(uri).findByRef(record.evidenceRef, 'session', 'task'), undefined);
    assert.equal(await store.readContent(retained), 'keep evidence');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('durable deletion removes child private storage and rejects result/activity/diagnostic callbacks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-child-cleanup-'));
  try {
    const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
    const authority = new SessionDeletionAuthority(uri), store = new SubagentStore(uri, 'workspace');
    const own = metadata('session'), other = metadata('retained');
    const transcript = { version: 1 as const, metadataId: own.id, contextInstructions: '', messages: [], result: 'Synthetic result' };
    await store.save(own, transcript);
    await store.save(other, transcript);
    assert.ok(await store.read('session', own.id));
    await deleted(authority, 'session');
    assert.equal(await store.read('session', own.id), undefined);
    assert.equal((await store.readSummaries('session')).activities.length, 0);
    await assert.rejects(store.save(own, transcript));
    await assert.rejects(store.saveDiagnostic({ parentSessionId: 'session', subagentId: own.id, parentRunId: 'run',
      kind: 'interrupted', reasonCode: 'synthetic', summary: 'Synthetic diagnostic' }));
    await store.deleteSession('session');
    await store.deleteSession('session');
    await assert.rejects(new SubagentStore(uri, 'workspace').save(own, transcript));
    assert.ok(await store.read('retained', own.id));
    const roots = await readdir(join(directory, 'chat-sessions', 'v1', 'subagents'));
    assert.equal(roots.length, 1);
    assert.deepEqual(await readdir(join(directory, 'chat-sessions', 'v1', 'subagents', roots[0]!)), ['retained']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('associated reclaim refuses a symlink into another managed or external directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-evidence-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'keepseek-evidence-link-target-'));
  try {
    const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
    await mkdir(join(directory, 'chat-sessions'), { recursive: true });
    await writeFile(join(outside, 'sentinel'), 'keep');
    await symlink(outside, join(directory, 'chat-sessions', 'v1'), 'dir');
    await assert.rejects(new ToolEvidenceStore(uri).deleteSessionEvidence('session'), /symbolic.link/iu);
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
    await assert.rejects(new SubagentStore(uri, 'workspace').deleteSession('session'), /symbolic.link/iu);
    assert.equal(await readFile(join(outside, 'sentinel'), 'utf8'), 'keep');
  } finally { await rm(directory, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test('owned trace and performance bytes are reclaimed without touching another session or inferring legacy ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-owned-trace-cleanup-'));
  const original = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({ ...original(), get<T>(key: string, fallback: T): T {
    return (key === 'trace.enabled' ? true : fallback) as T;
  } });
  try {
    const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
    const service = new InteractionTraceLogService(uri);
    const own = service.createRunTrace(undefined, { sessionId: 'session' });
    const retained = service.createRunTrace(undefined, { sessionId: 'retained' });
    const legacy = service.createRunTrace();
    own.record({ type: 'run_start' }); retained.record({ type: 'run_start' }); legacy.record({ type: 'run_start' });
    await own.flush(); await retained.flush(); await legacy.flush();
    const ownPath = vscode.Uri.parse(own.logUri!).fsPath;
    const retainedPath = vscode.Uri.parse(retained.logUri!).fsPath;
    assert.match(await readFile(ownPath, 'utf8'), /run_start/);
    await deleted(new SessionDeletionAuthority(uri), 'session');
    const recycler = new InteractionTraceCleanup(uri);
    assert.equal((await recycler.cleanup('session')).unverifiedLegacySources, 1);
    await assert.rejects(readFile(ownPath), { code: 'ENOENT' });
    await assert.rejects(readFile(ownPath + '.perf-0.jsonl'), { code: 'ENOENT' });
    assert.match(await readFile(retainedPath, 'utf8'), /run_start/);
    own.record({ type: 'run_end' }); await own.flush();
    await service.appendRunEvent({ runId: own.runId, uri: own.logUri! }, { type: 'external_update' });
    const restarted = new InteractionTraceLogService(uri);
    await restarted.appendRunEvent({ runId: own.runId, uri: own.logUri! }, { type: 'external_update' });
    await assert.rejects(readFile(ownPath), { code: 'ENOENT' });
    await assert.rejects(readFile(ownPath + '.perf-0.jsonl'), { code: 'ENOENT' });
    await own.close?.(); await retained.close?.(); await legacy.close?.();
  } finally { vscode.workspace.getConfiguration = original; await rm(directory, { recursive: true, force: true }); }
});
