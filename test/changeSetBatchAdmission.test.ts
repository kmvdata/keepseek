import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { ChangeSetStore, deleteStoredChangeSetsForSession } from '../src/edits/changeSetStore';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { SessionDeletionAuthority } from '../src/sessions/sessionDeletionAuthority';
import * as vscode from './stubs/vscode';

interface Harness {
  root: string;
  store: ChangeSetStore;
  sessionId: string;
  workspaceUri: vscode.Uri;
  dispose(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-batch-lease-'));
  const uri = vscode.Uri.file(root);
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [{ uri, name: 'batch', index: 0 }];
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', { key: 'workspace:batch-lease', name: 'Batch', folderUris: [uri.toString()] });
  await sessionStore.initialize().catch(() => undefined);
  const translate = (key: string, values?: Record<string, unknown>) => `${key} ${JSON.stringify(values ?? {})}`;
  const store = new ChangeSetStore(new SafeFileEditor(translate), new DraftDiffService(uri as never),
    sessionStore, uri as never, translate);
  await store.initialize();
  return {
    root,
    store,
    sessionId: sessionStore.getActiveSession().id,
    workspaceUri: uri,
    async dispose() {
      (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = previousFolders;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

function modifyEdit(uri: vscode.Uri, index: number) {
  return createFullTextDraftEdit({
    id: `edit-${index}`,
    uri: vscode.Uri.joinPath(uri, `${index}.txt`).toString(),
    label: `${index}.txt`,
    action: 'modify' as const,
    content: `replacement ${index}\n`,
    reason: `regression fixture ${index}`
  });
}

test('a batch apply never registers a cross-process session use lease', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const edits = [];
  for (let index = 0; index < 3; index += 1) {
    await writeFile(path.join(h.root, `${index}.txt`), `original ${index}\n`, 'utf8');
    edits.push(modifyEdit(h.workspaceUri, index));
  }
  const original = SessionDeletionAuthority.prototype.acquireUse;
  const requested: Array<{ workspaceKey: string; sessionId: string }> = [];
  SessionDeletionAuthority.prototype.acquireUse = async function acquireUse(workspaceKey: string, sessionId: string) {
    requested.push({ workspaceKey, sessionId });
    return await original.call(this, workspaceKey, sessionId);
  };
  t.after(() => { SessionDeletionAuthority.prototype.acquireUse = original; });

  const set = h.store.addDraftEdits({ runId: 'run-1', sessionId: h.sessionId, messageId: 'message-1', edits })!;
  await h.store.applyAll(set.id);

  assert.deepEqual(requested, [], 'an apply batch must not hold a session use lease: ' + JSON.stringify(requested));
  assert.deepEqual(h.store.toWebviewState(h.sessionId).flatMap(state => state.files.map(file => file.status)),
    ['applied', 'applied', 'applied']);
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await readFile(path.join(h.root, `${index}.txt`), 'utf8'), `replacement ${index}\n`);
  }
});

test('no use record protects the session while its edit is being applied', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  await writeFile(path.join(h.root, 'one.txt'), 'original\n', 'utf8');
  const edit = createFullTextDraftEdit({
    id: 'edit-one',
    uri: vscode.Uri.joinPath(h.workspaceUri, 'one.txt').toString(),
    label: 'one.txt',
    action: 'modify' as const,
    content: 'replacement\n',
    reason: 'regression fixture'
  });
  const set = h.store.addDraftEdits({ runId: 'run-1', sessionId: h.sessionId, messageId: 'message-1', edits: [edit] })!;
  const originalApply = SafeFileEditor.prototype.applyDraftEdit;
  const seen: boolean[] = [];
  SafeFileEditor.prototype.applyDraftEdit = async function applyDraftEdit(
    this: SafeFileEditor, ...args: Parameters<SafeFileEditor['applyDraftEdit']>
  ) {
    seen.push(await new SessionDeletionAuthority(vscode.Uri.file(h.root) as never).inspectUse('associated-edits', h.sessionId));
    return await originalApply.apply(this, args);
  };
  t.after(() => { SafeFileEditor.prototype.applyDraftEdit = originalApply; });

  await h.store.applyAll(set.id);

  assert.deepEqual(h.store.toWebviewState(h.sessionId).flatMap(state => state.files.map(file => file.status)), ['applied']);
  assert.equal(seen.length > 0, true, 'the fixture must observe the apply path');
  assert.deepEqual([...new Set(seen)], [false], 'no use record may protect the session during apply');
});

test('recycling a deleted session removes its ChangeSet index entries and shards', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const directory = path.join(h.root, 'change-sets', 'v4');
  const changeSetId = 'a'.repeat(32);
  await mkdir(path.join(directory, 'runtime'), { recursive: true });
  await mkdir(path.join(directory, 'checkpoints'), { recursive: true });
  const updatedAt = new Date().toISOString();
  const pending = { id: changeSetId, sessionId: h.sessionId, runId: 'run-1', messageId: 'message-1', fileCount: 1,
    operationSummary: '', status: 'pending', createdAt: updatedAt, updatedAt,
    files: [{ id: 'edit-pending', uri: vscode.Uri.joinPath(h.workspaceUri, 'pending.txt').toString(), label: 'pending.txt',
      kind: 'full_text_v1', action: 'create', reason: 'fixture', status: 'pending',
      result: { sha256: 'b'.repeat(64), sizeBytes: 1 } }] };
  await writeFile(path.join(directory, 'runtime', `${changeSetId}.json`), JSON.stringify({ version: 4, changeSet: pending }), 'utf8');
  await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 4, entries: [{ id: changeSetId, sessionId: h.sessionId,
    kind: 'runtime', storageFile: `runtime/${changeSetId}.json`, checkpointIds: [], updatedAt }] }), 'utf8');

  await new SessionDeletionAuthority(vscode.Uri.file(h.root) as never).commitDeletion({ version: 1,
    workspaceKey: 'workspace:batch-lease', sessionId: h.sessionId, operationId: 'op-1', confirmedAt: new Date().toISOString(), phase: 'committed' });
  await deleteStoredChangeSetsForSession(vscode.Uri.file(h.root) as never, h.sessionId);

  const index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')) as { entries: Array<{ sessionId?: string }> };
  assert.deepEqual(index.entries.filter(entry => entry.sessionId === h.sessionId), [],
    'the deleted session must not keep ChangeSet index entries');
});