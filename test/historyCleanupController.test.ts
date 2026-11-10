import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { createHistoryCleanupController } from '../src/provider/historyCleanupController';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { SessionAssociatedDataCleanup } from '../src/sessions/sessionAssociatedDataCleanup';
import { ToolEvidenceStore } from '../src/agent/evidence/store';

function session(id: string, workspaceKey: string) {
  const value = createEmptySession('en', { key: workspaceKey, name: workspaceKey, folderUris: [] });
  value.id = id;
  value.messages = [{ id: 'message-' + id, role: 'user', content: ' stable request\n bytes ', createdAt: value.createdAt }];
  return value;
}
test('real cleanup controller fully reclaims a current target and rejects stale snapshots without rewriting another session', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-controller-cleanup-'));
  const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
  const storage = new GlobalSessionStorage(uri);
  t.after(async () => { await storage.flush(); await rm(directory, { recursive: true, force: true }); });
  const workspaceKey = 'workspace:controller-current';
  const target = session('controller-target', workspaceKey), survivor = session('controller-survivor', workspaceKey);
  const scope = { key: workspaceKey, name: 'Current', folderUris: [] };
  const stale = { activeSessionId: survivor.id, sessions: [target, survivor] };
  await storage.saveWorkspace(scope, stale); await storage.flush();
  const evidence = new ToolEvidenceStore(uri);
  const intent = (sessionId: string) => ({ sessionId, taskId: 'synthetic-task', toolCallId: 'synthetic-call',
    toolName: 'synthetic-read', argumentsHash: 'synthetic-hash', effectKind: 'read' as const });
  const ownedEvidence = await evidence.complete(await evidence.ensureIntent(intent(target.id)), 'owned synthetic evidence');
  const retainedEvidence = await evidence.complete(await evidence.ensureIntent(intent(survivor.id)), 'retained evidence bytes');
  const approvals = { version: 1, records: [{ reviewId: 'owned-review', sessionId: target.id }, { reviewId: 'retained-review', sessionId: survivor.id, rationale: 'unchanged' }] };
  await writeFile(join(directory, 'approval-reviews.json'), JSON.stringify(approvals));
  const removed: string[] = [];
  const controller = createHistoryCleanupController(uri, workspaceKey, new SessionAssociatedDataCleanup(uri), {
    currentSessionId: () => survivor.id, currentWorkspaceKey: () => workspaceKey,
    protectedReason: entry => entry.id === survivor.id ? 'session_in_use' : undefined,
    settle: async () => {}, removed: async entry => { removed.push(entry.id); }
  });
  const originalRead = vscode.workspace.fs.readFile;
  let previewBodyReads = 0;
  vscode.workspace.fs.readFile = async resource => {
    if (/\/sessions\//u.test(resource.fsPath)) previewBodyReads++;
    return originalRead(resource);
  };
  let preview;
  try { preview = await controller.preview('preview-local', 'view', { scope: 'current', mode: 'all' }, workspaceKey); }
  finally { vscode.workspace.fs.readFile = originalRead; }
  assert.equal(previewBodyReads, 0);
  assert.equal(preview.candidateCount, 1); assert.equal(preview.protectedCount, 1);
  const result = await controller.request('clear-local', 'view', preview.previewToken, async () => true);
  assert.equal(result.status, 'completed'); assert.equal(result.fullyDeleted, 1);
  assert.equal(result.removedPendingCleanup, 0);
  assert.deepEqual(removed, [target.id]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'approval-reviews.json'), 'utf8')).records, [approvals.records[1]]);
  assert.equal(await evidence.findByRef(ownedEvidence.evidenceRef, target.id, 'synthetic-task'), undefined);
  assert.equal(await evidence.readContent(retainedEvidence), 'retained evidence bytes');
  assert.equal((await storage.deletionAuthority.readRecord(target.id))?.phase, 'reclaimed');
  await storage.saveWorkspace(scope, structuredClone(stale)); await storage.flush();
  const fresh = new GlobalSessionStorage(uri);
  assert.equal(await fresh.loadSession(workspaceKey, target.id), undefined);
  assert.deepEqual((await fresh.listWorkspaceSessionSummaries(workspaceKey)).map(item => item.id), [survivor.id]);
  const retained = await fresh.loadSession(workspaceKey, survivor.id);
  assert.deepEqual(JSON.parse(JSON.stringify(retained?.messages)), survivor.messages);
  assert.equal(retained?.contextInstructions, survivor.contextInstructions);
  await fresh.flush();
});

test('real all-project cleanup fully reclaims an unopened project while retaining the current project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-controller-foreign-'));
  const uri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
  const storage = new GlobalSessionStorage(uri);
  t.after(async () => { await storage.flush(); await rm(directory, { recursive: true, force: true }); });
  const current = 'workspace:controller-visible', foreign = 'workspace:controller-unopened';
  const survivor = session('foreign-test-survivor', current), target = session('foreign-test-target', foreign);
  await storage.saveWorkspace({ key: current, name: 'Visible', folderUris: [] }, { activeSessionId: survivor.id, sessions: [survivor] });
  await storage.saveWorkspace({ key: foreign, name: 'Unopened', folderUris: [] }, { activeSessionId: target.id, sessions: [target] });
  await storage.flush();
  const controller = createHistoryCleanupController(uri, current, new SessionAssociatedDataCleanup(uri), {
    currentSessionId: () => survivor.id, currentWorkspaceKey: () => current,
    protectedReason: entry => entry.id === survivor.id ? 'session_in_use' : undefined,
    settle: async () => {}, removed: async () => {}
  });
  const preview = await controller.preview('preview-foreign', 'view', { scope: 'all', mode: 'all' }, current);
  assert.equal(preview.candidateCount, 1); assert.equal(preview.protectedCount, 1);
  const result = await controller.request('clear-foreign', 'view', preview.previewToken, async () => true);
  assert.equal(result.status, 'completed'); assert.equal(result.fullyDeleted, 1);
  assert.equal(result.removedPendingCleanup, 0);
  assert.equal((await storage.deletionAuthority.readRecord(target.id))?.phase, 'reclaimed');
  assert.equal(await storage.loadSession(foreign, target.id), undefined);
  assert.equal((await storage.loadSession(current, survivor.id))?.id, survivor.id);

});
