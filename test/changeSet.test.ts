import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { createChangeSet } from '../src/edits/changeSet';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import type { ChangeCheckpoint, ChangeSetFile, ChatMessage, ChatSession } from '../src/shared/types';

test('creates one structured ChangeSet for multiple draft edits', () => {
  const changeSet = createChangeSet({
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    edits: [
      {
        id: 'edit-1',
        uri: 'file:///workspace/a.ts',
        label: 'a.ts',
        action: 'modify',
        newText: 'export const a = 1;\n',
        reason: 'Update A'
      },
      {
        id: 'edit-2',
        uri: 'file:///workspace/b.ts',
        label: 'b.ts',
        action: 'create',
        newText: 'export const b = 2;\n',
        reason: 'Add B'
      }
    ]
  });

  assert.ok(changeSet);
  assert.equal(changeSet.fileCount, 2);
  assert.equal(changeSet.sessionId, 'session-1');
  assert.equal(changeSet.messageId, 'message-1');
  assert.deepEqual(changeSet.files.map((file) => file.status), ['pending', 'pending']);
  assert.match(changeSet.operationSummary, /Update A/u);
});

test('history truncation detaches all file states and rejects stale actions while retaining execution facts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-truncation-'));
  const fixture = createStoreFixture(root);
  const statuses: ChangeSetFile['status'][] = ['pending', 'apply_failed', 'interrupted', 'applied', 'revert_failed', 'uncertain', 'discarded', 'reverted'];
  const removed = statuses.map((status, index) => {
    const changeSet = createChangeSet({ runId: `removed-segment-${index}`, sessionId: 'session-1', messageId: 'removed-assistant',
      edits: [draft(`removed-${index}`, `removed-${index}.ts`)] })!;
    changeSet.files[0].status = status;
    changeSet.files[0].error = `original ${status}`;
    fixture.store.add(changeSet);
    return changeSet;
  });
  const retained = fixture.store.addDraftEdits({ runId: 'removed-segment-0', sessionId: 'session-1', messageId: 'retained-assistant',
    edits: [draft('retained-edit', 'retained.ts')] })!;
  const other = fixture.store.addDraftEdits({ runId: 'removed-segment', sessionId: 'other-session', messageId: 'removed-assistant',
    edits: [draft('other-edit', 'other.ts')] })!;
  const skill = fixture.store.addDraftEdits({ runId: 'skill-dialog', sessionId: 'session-1', messageId: 'skill-origin',
    edits: [draft('skill-edit', 'skill.ts')] })!;
  const scope = { id: 'truncation-1', sessionId: 'session-1', removedMessageIds: ['removed-assistant'],
    removedSegmentIds: statuses.map((_, index) => `removed-segment-${index}`), retainedMessageIds: ['retained-assistant'] };
  assert.equal(fixture.store.invalidateHistory(scope).length, removed.length * 2);
  assert.equal(fixture.store.invalidateHistory(scope).length, removed.length * 2);
  assert.deepEqual(fixture.store.toWebviewState('session-1').map(set => set.id).sort(), [retained.id, skill.id].sort());
  assert.equal(fixture.store.toWebviewState('other-session')[0]?.id, other.id);
  assert.equal(fixture.store.getPendingEdit('retained-edit')?.edit.id, 'retained-edit');
  for (const changeSet of removed) {
    const id = changeSet.files[0].id;
    assert.equal(fixture.store.getPendingEdit(id), undefined);
    assert.equal(await fixture.store.applyEdit(id), undefined);
    assert.equal(await fixture.store.applyAll(changeSet.id), undefined);
    assert.equal(await fixture.store.revertEdit(id), undefined);
    assert.equal(await fixture.store.revertAll(changeSet.id), undefined);
    assert.equal(fixture.store.discardEdit(id), false);
    assert.equal(fixture.store.discardAll(changeSet.id), false);
    assert.deepEqual(fixture.store.getChangeSetEditUris(changeSet.id), []);
    await assert.rejects(fixture.store.preflightEdit(id), /not found/u);
  }
  await fixture.store.flush();
  const stored = await readStoredChangeSets(root);
  for (let index = 0; index < removed.length; index += 1) {
    const persisted = stored.find(set => set.id === removed[index].id)!;
    assert.equal(persisted.historyInvalidationId, scope.id);
    assert.equal(persisted.files[0].status, statuses[index]);
    assert.equal(persisted.files[0].error, `original ${statuses[index]}`);
  }
  const restarted = createStoreFixture(root);
  await restarted.store.initialize();
  assert.deepEqual(restarted.store.toWebviewState('session-1').map(set => set.id).sort(), [retained.id, skill.id].sort());
  assert.equal(await restarted.store.applyEdit('removed-0'), undefined);
});

test('history truncation rejects late DraftEdits and uses exact segments only without a retained origin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-truncation-late-'));
  const fixture = createStoreFixture(root);
  const originless = fixture.store.addDraftEdits({ runId: 'removed-segment', sessionId: 'session-1',
    edits: [draft('legacy-edit', 'legacy.ts')] })!;
  const scope = { id: 'truncation-late', sessionId: 'session-1', removedMessageIds: ['removed-assistant'],
    removedSegmentIds: ['removed-segment'], retainedMessageIds: ['retained-assistant'] };
  assert.deepEqual(fixture.store.invalidateHistory(scope), [originless.id, 'legacy-edit']);
  assert.equal(fixture.store.addDraftEdits({ runId: 'removed-segment', sessionId: 'session-1', messageId: 'removed-assistant',
    edits: [draft('late-edit', 'late.ts')] }), undefined);
  assert.equal(fixture.store.hasPendingForSession('session-1'), false);
  assert.deepEqual(fixture.store.toWebviewState('session-1'), []);
  assert.equal(await fixture.store.applyEdit('late-edit'), undefined);
  await fixture.store.flush();
  const persisted = await readStoredChangeSets(root);
  assert.equal(persisted.find(set => set.files[0]?.id === 'late-edit')?.historyInvalidationId, scope.id);
});

test('history truncation waits for an active file operation before invalidating any records', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-truncation-busy-'));
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const fixture = createStoreFixture(root);
  const internals = fixture.store as unknown as { safeFileEditor: { applyDraftEdit(file: ChangeSetFile, changeSetId: string): Promise<ChangeCheckpoint> } };
  const apply = internals.safeFileEditor.applyDraftEdit.bind(internals.safeFileEditor);
  internals.safeFileEditor.applyDraftEdit = async (file, changeSetId) => { await wait; return apply(file, changeSetId); };
  const set = fixture.store.addDraftEdits({ runId: 'busy-segment', sessionId: 'session-1', messageId: 'busy-assistant',
    edits: [draft('busy-edit', 'busy.ts')] })!;
  const operation = fixture.store.applyEdit('busy-edit');
  assert.equal(fixture.store.hasActiveOperations('session-1'), true);
  const scope = { id: 'truncation-busy', sessionId: 'session-1', removedMessageIds: ['busy-assistant'],
    removedSegmentIds: ['busy-segment'], retainedMessageIds: [] };
  assert.throws(() => fixture.store.invalidateHistory(scope), /still running/u);
  assert.equal(fixture.store.toWebviewState('session-1')[0]?.id, set.id);
  release();
  assert.deepEqual((await operation)?.appliedEditIds, ['busy-edit']);
  assert.equal(fixture.store.hasActiveOperations('session-1'), false);
  assert.deepEqual(fixture.store.invalidateHistory(scope), [set.id, 'busy-edit']);
  await fixture.store.flush();
  assert.equal((await readStoredChangeSets(root)).find(stored => stored.id === set.id)?.files[0].status, 'applied');
});

test('legacy orphan quarantine uses full host history and preserves audit until origin is verifiable', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-orphan-'));
  const fixture = createStoreFixture(root);
  const orphan = fixture.store.addDraftEdits({ runId: 'missing-segment', sessionId: 'session-1', messageId: 'missing-origin',
    edits: [draft('orphan-edit', 'orphan.ts')] })!;
  const paged = fixture.store.addDraftEdits({ runId: 'page-segment', sessionId: 'session-1', messageId: 'earlier-page-origin',
    edits: [draft('paged-edit', 'paged.ts')] })!;
  const segment = fixture.store.addDraftEdits({ runId: 'verified-segment', sessionId: 'session-1', messageId: 'legacy-no-longer-linked',
    edits: [draft('segment-edit', 'segment.ts')] })!;
  const skill = fixture.store.addDraftEdits({ runId: 'skill-dialog', sessionId: 'session-1', messageId: 'skill:create',
    edits: [draft('dialog-edit', 'dialog.ts')] })!;
  const fullMessages = [{ id: 'earlier-page-origin', role: 'assistant', content: '', createdAt: '',
    runCheckpointArchive: { summary: { taskId: 'verified-segment' } } } as ChatMessage];
  fixture.store.reconcileHistoryOrigins('session-1', fullMessages);
  assert.deepEqual(fixture.store.toWebviewState('session-1').map(set => set.id).sort(), [paged.id, segment.id, skill.id].sort());
  assert.equal(await fixture.store.applyEdit('orphan-edit'), undefined);
  await fixture.store.flush();
  let persisted = (await readStoredChangeSets(root)).find(set => set.id === orphan.id)!;
  assert.equal(persisted.historyOriginUnverified, true);
  assert.equal(persisted.files[0].status, 'pending');
  const restarted = createStoreFixture(root);
  await restarted.store.initialize();
  assert.equal(await restarted.store.applyEdit('orphan-edit'), undefined);
  restarted.store.reconcileHistoryOrigins('session-1', [...fullMessages,
    { id: 'missing-origin', role: 'assistant', content: '', createdAt: '' } as ChatMessage]);
  assert.equal(restarted.store.getPendingEdit('orphan-edit')?.edit.id, 'orphan-edit');
  await restarted.store.flush();
  persisted = (await readStoredChangeSets(root)).find(set => set.id === orphan.id)!;
  assert.equal(persisted.historyOriginUnverified, undefined);
});

test('truncation persistence failure is observable and idempotent recovery keeps journals and real files', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-truncation-write-failure-'));
  const fixture = createStoreFixture(root);
  const set = fixture.store.addDraftEdits({ runId: 'failure-segment', sessionId: 'session-1', messageId: 'failure-origin',
    edits: [draft('failure-edit', 'failure.ts')] })!;
  await fixture.store.applyEdit('failure-edit');
  await fixture.store.flush();
  const realFile = path.join(root, 'already-applied.ts');
  await writeFile(realFile, 'already applied content');
  const originalRename = vscode.workspace.fs.rename;
  let fail = true;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (fail && target.fsPath.startsWith(root) && target.fsPath.includes('/change-sets/v4/runtime/')) {
      throw new Error('simulated truncation shard failure');
    }
    await originalRename(source, target, options);
  };
  t.after(() => { vscode.workspace.fs.rename = originalRename; });
  const scope = { id: 'truncation-failure', sessionId: 'session-1', removedMessageIds: ['failure-origin'],
    removedSegmentIds: ['failure-segment'], retainedMessageIds: [] };
  fixture.store.invalidateHistory(scope);
  await assert.rejects(fixture.store.flush(), /simulated truncation shard failure/u);
  assert.equal(await fixture.store.revertEdit('failure-edit'), undefined);
  fail = false;
  assert.deepEqual(fixture.store.invalidateHistory(scope), [set.id, 'failure-edit']);
  await fixture.store.flush();
  // Recovery replays the durable host intent before exposing or executing old
  // Store state; reapplying membership is safe after a partial multi-file write.
  const restarted = createStoreFixture(root);
  await restarted.store.initialize();
  restarted.store.invalidateHistory(scope);
  await restarted.store.flush();
  assert.deepEqual(restarted.store.toWebviewState('session-1'), []);
  const persisted = (await readStoredChangeSets(root)).find(stored => stored.id === set.id)!;
  assert.equal(persisted.historyInvalidationId, scope.id);
  assert.equal(persisted.files[0].status, 'applied');
  assert.equal(persisted.files[0].checkpointId, 'checkpoint-failure-edit');
  const index = JSON.parse(await readFile(path.join(root, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
    entries: Array<{ id: string; checkpointIds: string[] }>;
  };
  assert.deepEqual(index.entries.find(entry => entry.id === set.id)?.checkpointIds, ['checkpoint-failure-edit']);
  assert.equal(await readFile(realFile, 'utf8'), 'already applied content');
});

test('merges cumulative checkpoint DraftEdits and the final response into one ChangeSet', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-checkpoint-merge-'));
  const fixture = createStoreFixture(root);
  const scope = {
    runId: 'run-checkpoint',
    sessionId: 'session-1',
    messageId: 'assistant-checkpoint'
  };
  const editA = draft('a', 'a.ts');
  const editB = draft('b', 'b.ts');
  const editC = draft('c', 'c.ts');

  const first = fixture.store.addDraftEdits({ ...scope, edits: [editA] });
  const second = fixture.store.addDraftEdits({ ...scope, edits: [editA, editB] });
  const third = fixture.store.addDraftEdits({ ...scope, edits: [editA, editB, editC] });
  assert.ok(first && second && third);
  assert.equal(second.id, first.id);
  assert.equal(third.id, first.id);

  const finalResponse = createChangeSet({
    ...scope,
    edits: [editA, editB, editC],
    operationSummary: 'Final grouped change'
  });
  assert.ok(finalResponse);
  const registeredFinal = fixture.store.add(finalResponse);
  assert.equal(registeredFinal?.id, first.id);

  const state = fixture.store.toWebviewState('session-1');
  assert.equal(state.length, 1);
  assert.equal(state[0]?.fileCount, 3);
  assert.equal(state[0]?.operationSummary, 'Final grouped change');
  assert.deepEqual(state[0]?.files.map((file) => file.id), ['a', 'b', 'c']);

  const result = await fixture.store.applyAll(first.id);
  assert.equal(result?.attempted, 3);
  assert.deepEqual(result?.appliedEditIds, ['a', 'b', 'c']);
});

test('consolidates previously persisted split ChangeSets for one Agent run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-stored-merge-'));
  const scope = {
    runId: 'run-stored',
    sessionId: 'session-1',
    messageId: 'assistant-stored'
  };
  const first = createChangeSet({ ...scope, edits: [draft('a', 'a.ts')] });
  const second = createChangeSet({ ...scope, edits: [draft('b', 'b.ts')] });
  assert.ok(first && second);
  second.createdAt = new Date(Date.parse(first.createdAt) + 1_000).toISOString();
  second.updatedAt = second.createdAt;
  await writeFile(path.join(root, 'change-sets.json'), JSON.stringify({
    version: 2,
    changeSets: [second, first],
    history: [],
    checkpoints: []
  }));

  const fixture = createStoreFixture(root);
  await fixture.store.initialize();
  const state = fixture.store.toWebviewState('session-1');
  assert.equal(state.length, 1);
  assert.equal(state[0]?.id, first.id);
  assert.equal(state[0]?.fileCount, 2);
  assert.deepEqual(state[0]?.files.map((file) => file.id), ['a', 'b']);

  await fixture.store.flush();
  const persisted = JSON.parse(await readFile(path.join(root, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
    entries?: Array<{ kind?: string }>;
  };
  assert.equal(persisted.entries?.filter((entry) => entry.kind === 'runtime').length, 1);
  await assert.rejects(readFile(path.join(root, 'change-sets.json'), 'utf8'));
});

test('keeps multiple rounds associated with their assistant message and omits newText from Webview state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-association-'));
  const fixture = createStoreFixture(root);
  const first = fixture.store.addDraftEdits({
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    edits: [draft('a', 'a.ts')]
  });
  const second = fixture.store.addDraftEdits({
    runId: 'run-2',
    sessionId: 'session-1',
    messageId: 'assistant-2',
    edits: [draft('b', 'b.ts')]
  });
  fixture.store.addDraftEdits({
    runId: 'run-other',
    sessionId: 'session-2',
    messageId: 'assistant-other',
    edits: [draft('other', 'other.ts')]
  });

  const state = fixture.store.toWebviewState('session-1');
  assert.deepEqual(state.map((changeSet) => changeSet.messageId), ['assistant-1', 'assistant-2']);
  assert.deepEqual(state.map((changeSet) => changeSet.files[0]?.label), ['a.ts', 'b.ts']);
  assert.ok(!('newText' in (state[0]?.files[0] ?? {})));

  fixture.store.discardAll(first?.id ?? '');
  const updated = fixture.store.toWebviewState('session-1');
  assert.equal(updated[0]?.id, first?.id);
  assert.equal(updated[0]?.messageId, 'assistant-1');
  assert.equal(updated[0]?.status, 'discarded');
  assert.equal(updated[1]?.id, second?.id);
});

test('keeps delete baselines internal and exposes only pending delete targets for confirmation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-delete-targets-'));
  const fixture = createStoreFixture(root);
  const changeSet = fixture.store.addDraftEdits({
    runId: 'run-delete',
    sessionId: 'session-1',
    messageId: 'assistant-delete',
    edits: [
      {
        id: 'delete-a',
        uri: 'file:///workspace/a.ts',
        label: 'a.ts',
        action: 'delete',
        newText: '',
        reason: 'Remove A',
        expectedOriginalTextHash: 'private-hash',
        expectedOriginalSize: 42
      },
      draft('modify-b', 'b.ts')
    ]
  });
  assert.ok(changeSet);

  assert.deepEqual(fixture.store.getPendingDeleteTargetsForEdit('delete-a'), [{
    id: 'delete-a',
    uri: 'file:///workspace/a.ts',
    label: 'a.ts'
  }]);
  assert.deepEqual(fixture.store.getPendingDeleteTargetsForChangeSet(changeSet.id), [{
    id: 'delete-a',
    uri: 'file:///workspace/a.ts',
    label: 'a.ts'
  }]);

  const webviewFile = fixture.store.toWebviewState('session-1')[0]?.files[0];
  assert.ok(webviewFile);
  assert.equal(webviewFile.action, 'delete');
  assert.ok(!('newText' in webviewFile));
  assert.ok(!('expectedOriginalTextHash' in webviewFile));
  assert.ok(!('expectedOriginalSize' in webviewFile));

  fixture.store.discardEdit('delete-a');
  assert.deepEqual(fixture.store.getPendingDeleteTargetsForEdit('delete-a'), []);
  assert.deepEqual(fixture.store.getPendingDeleteTargetsForChangeSet(changeSet.id), []);
});

test('reports mixed apply results per file and preserves retryable failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-partial-'));
  const fixture = createStoreFixture(root, 'b.ts');
  const changeSet = fixture.store.addDraftEdits({
    runId: 'run-partial',
    sessionId: 'session-1',
    messageId: 'assistant-partial',
    edits: [draft('a', 'a.ts'), draft('b', 'b.ts')]
  });
  assert.ok(changeSet);

  const result = await fixture.store.applyAll(changeSet.id);
  assert.deepEqual(result?.appliedEditIds, ['a']);
  assert.equal(result?.failed[0]?.editId, 'b');
  const state = fixture.store.toWebviewState('session-1')[0];
  assert.equal(state?.status, 'partially_failed');
  assert.deepEqual(state?.files.map((file) => file.status), ['applied', 'apply_failed']);
  assert.match(state?.files[1]?.error ?? '', /failed b\.ts/u);
});

test('supersedes sibling drafts from the same file baseline after one is applied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-superseded-'));
  const fixture = createStoreFixture(root);
  const base = { sha256: 'same-base-sha', sizeBytes: 12 };
  const acceptedEdit = versionedDraft('accepted', 'shared.ts', base, 'accepted result\n');
  const staleEdit = versionedDraft('stale', 'shared.ts', base, 'stale alternative\n');
  const accepted = fixture.store.addDraftEdits({
    runId: 'accepted-run', sessionId: 'session-1', messageId: 'accepted-message', edits: [acceptedEdit]
  });
  const stale = fixture.store.addDraftEdits({
    runId: 'stale-run', sessionId: 'session-1', messageId: 'stale-message', edits: [staleEdit]
  });
  assert.ok(accepted && stale);

  assert.deepEqual((await fixture.store.applyEdit(acceptedEdit.id))?.appliedEditIds, [acceptedEdit.id]);
  const state = fixture.store.toWebviewState('session-1');
  const staleState = state.find((changeSet) => changeSet.id === stale.id);
  assert.equal(staleState?.status, 'superseded');
  assert.equal(staleState?.files[0]?.status, 'superseded');
  assert.equal(staleState?.files[0]?.error, 'changeFileSupersededReason');
  assert.equal(await fixture.store.applyEdit(staleEdit.id), undefined);
  assert.equal(fixture.store.hasPendingForSession('session-1'), false);

  const sequentialEdit = versionedDraft(
    'sequential',
    'shared.ts',
    acceptedEdit.result,
    'sequential result\n'
  );
  const sequential = fixture.store.addDraftEdits({
    runId: 'sequential-run', sessionId: 'session-1', messageId: 'sequential-message', edits: [sequentialEdit]
  });
  assert.equal(sequential?.files[0]?.status, 'pending');
  assert.equal(fixture.store.hasPendingForSession('session-1'), true);
});

test('reconciles already-persisted sibling drafts as superseded on startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-superseded-restart-'));
  const base = { sha256: 'persisted-base-sha', sizeBytes: 14 };
  const accepted = createChangeSet({
    runId: 'accepted-run', sessionId: 'session-1', messageId: 'accepted-message',
    edits: [versionedDraft('accepted', 'shared.ts', base, 'accepted result\n')]
  });
  const stale = createChangeSet({
    runId: 'stale-run', sessionId: 'session-1', messageId: 'stale-message',
    edits: [versionedDraft('stale', 'shared.ts', base, 'stale alternative\n')]
  });
  assert.ok(accepted && stale);
  accepted.files[0].status = 'applied';
  accepted.status = 'applied';
  await writeFile(path.join(root, 'change-sets.json'), JSON.stringify({
    version: 2,
    changeSets: [accepted, stale],
    history: [],
    checkpoints: []
  }));

  const fixture = createStoreFixture(root);
  await fixture.store.initialize();
  const staleState = fixture.store.toWebviewState('session-1').find((changeSet) => changeSet.id === stale.id);
  assert.equal(staleState?.status, 'superseded');
  assert.equal(staleState?.files[0]?.status, 'superseded');
  assert.equal(fixture.store.hasPendingForSession('session-1'), false);
});

test('journal Apply I/O stays constant with large history and does not run GC before mutation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-journal-hot-path-'));
  let writeCount = 0;
  let historyWriteCount = 0;
  let directoryScanCount = 0;
  let writesBeforeMutation = 0;
  let scansBeforeMutation = 0;
  const originalWriteFile = vscode.workspace.fs.writeFile;
  const originalReadDirectory = vscode.workspace.fs.readDirectory;
  const now = '2026-09-20T00:00:00.000Z';
  const safeFileEditor = {
    async applyDraftEdit(
      file: ChangeSetFile,
      changeSetId: string,
      _approval: unknown,
      journal: { persist(checkpoint: ChangeCheckpoint): Promise<void> }
    ): Promise<ChangeCheckpoint> {
      const checkpoint: ChangeCheckpoint = {
        version: 2, id: `checkpoint-${file.id}`, changeSetId, editId: file.id, uri: file.uri,
        label: file.label, action: file.action, draftKind: 'legacy_full_text_v0', state: 'prepared',
        operation: 'apply', originalExists: true, appliedExists: true, createdAt: now
      };
      await journal.persist(checkpoint);
      const checkpointFile = `${createHash('sha256').update(checkpoint.id).digest('hex').slice(0, 32)}.json`;
      const runtimeFile = `${createHash('sha256').update(changeSetId).digest('hex').slice(0, 32)}.json`;
      const durablePrepared = JSON.parse(await readFile(
        path.join(root, 'change-sets', 'v4', 'checkpoints', checkpointFile), 'utf8'
      )) as { checkpoint?: ChangeCheckpoint };
      const durablePreparedOwner = JSON.parse(await readFile(
        path.join(root, 'change-sets', 'v4', 'runtime', runtimeFile), 'utf8'
      )) as { changeSet?: { files?: ChangeSetFile[] } };
      assert.equal(durablePrepared.checkpoint?.state, 'prepared');
      assert.equal(durablePreparedOwner.changeSet?.files?.find((item) => item.id === file.id)?.status, 'prepared');
      checkpoint.state = 'applying';
      await journal.persist(checkpoint);
      const durableApplying = JSON.parse(await readFile(
        path.join(root, 'change-sets', 'v4', 'checkpoints', checkpointFile), 'utf8'
      )) as { checkpoint?: ChangeCheckpoint };
      assert.equal(durableApplying.checkpoint?.state, 'applying');
      writesBeforeMutation = writeCount;
      scansBeforeMutation = directoryScanCount;
      checkpoint.state = 'applied';
      checkpoint.appliedAt = now;
      await journal.persist(checkpoint);
      return checkpoint;
    }
  };
  const activeSession = { id: 'session-1', messages: [], updatedAt: now } as unknown as ChatSession;
  const store = new ChangeSetStore(
    safeFileEditor as never,
    { async openDiff() { return undefined; } } as never,
    { activeSessionId: 'session-1', getActiveSession: () => activeSession, async persist() { return undefined; } } as never,
    vscode.Uri.file(root),
    (key) => key
  );
  for (let index = 0; index < 150; index += 1) {
    const historical = store.addDraftEdits({
      runId: `history-run-${index}`, sessionId: 'session-1', messageId: `history-message-${index}`,
      edits: [draft(`history-${index}`, `history-${index}.ts`)]
    });
    assert.ok(historical);
    store.discardAll(historical.id);
  }
  await store.flush();
  const target = store.addDraftEdits({
    runId: 'hot-run', sessionId: 'session-1', messageId: 'hot-message', edits: [draft('hot-edit', 'hot.ts')]
  });
  assert.ok(target);
  await store.flush();
  vscode.workspace.fs.writeFile = async (uri, content) => {
    if (uri.fsPath.startsWith(root + path.sep)) {
      writeCount += 1;
      if (uri.fsPath.includes(`${path.sep}history${path.sep}`)) historyWriteCount += 1;
    }
    await originalWriteFile(uri, content);
  };
  vscode.workspace.fs.readDirectory = async (uri) => {
    if (uri.fsPath === root || uri.fsPath.startsWith(root + path.sep)) directoryScanCount += 1;
    return await originalReadDirectory(uri);
  };
  try {
    assert.deepEqual((await store.applyEdit('hot-edit'))?.appliedEditIds, ['hot-edit']);
  } finally {
    vscode.workspace.fs.writeFile = originalWriteFile;
    vscode.workspace.fs.readDirectory = originalReadDirectory;
  }
  assert.ok(writesBeforeMutation <= 5, `expected bounded prepared/applying writes, saw ${writesBeforeMutation}`);
  assert.equal(historyWriteCount, 0, 'journal stages must not rewrite history shards');
  assert.equal(scansBeforeMutation, 0, 'artifact GC must not scan directories before workspace mutation');
});

test('overlapping single and batch Apply never execute the same DraftEdit twice', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-apply-lock-'));
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const calls: string[] = [];
  const now = '2026-09-20T00:00:00.000Z';
  const safeFileEditor = {
    async applyDraftEdit(file: ChangeSetFile, changeSetId: string): Promise<ChangeCheckpoint> {
      calls.push(file.id);
      if (file.id === 'locked-a') {
        firstStarted();
        await firstGate;
      }
      return {
        id: `checkpoint-${file.id}`, changeSetId, editId: file.id, uri: file.uri, label: file.label,
        action: file.action, originalExists: true, appliedExists: true, createdAt: now, appliedAt: now
      };
    }
  };
  const activeSession = { id: 'session-1', messages: [], updatedAt: now } as unknown as ChatSession;
  const store = new ChangeSetStore(
    safeFileEditor as never,
    { async openDiff() { return undefined; } } as never,
    { activeSessionId: 'session-1', getActiveSession: () => activeSession, async persist() { return undefined; } } as never,
    vscode.Uri.file(root), (key) => key
  );
  const changeSet = store.addDraftEdits({
    runId: 'lock-run', sessionId: 'session-1', messageId: 'lock-message',
    edits: [draft('locked-a', 'a.ts'), draft('locked-b', 'b.ts')]
  });
  assert.ok(changeSet);
  const progress: string[] = [];
  const batch = store.applyAll(changeSet.id, {
    onProgress: (update) => progress.push(`${update.editId}:${update.status}`)
  });
  await started;
  const overlapping = await store.applyEdit('locked-b');
  assert.equal(overlapping?.appliedEditIds.length, 0);
  assert.match(overlapping?.failed[0]?.error ?? '', /already being applied/u);
  releaseFirst();
  assert.deepEqual((await batch)?.appliedEditIds, ['locked-a', 'locked-b']);
  assert.deepEqual(calls, ['locked-a', 'locked-b']);
  assert.deepEqual(progress, ['locked-a:applied', 'locked-b:applied']);
});

test('opens a pending edit file that exists inside the workspace', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-open-file-'));
  const targetPath = path.join(root, 'open.ts');
  await writeFile(targetPath, 'export const open = true;\n', 'utf8');
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as { workspaceFolders: typeof vscode.workspace.workspaceFolders }).workspaceFolders = [
    { uri: vscode.Uri.file(root), name: 'keepseek-test', index: 0 }
  ];
  t.after(() => {
    (vscode.workspace as { workspaceFolders: typeof vscode.workspace.workspaceFolders }).workspaceFolders = previousWorkspaceFolders;
  });
  const fixture = createStoreFixture(root);
  const changeSet = fixture.store.addDraftEdits({
    runId: 'run-open',
    sessionId: 'session-1',
    messageId: 'assistant-open',
    edits: [{
      id: 'open-a',
      uri: vscode.Uri.file(targetPath).toString(),
      label: 'open.ts',
      action: 'modify',
      newText: 'export const open = true;\n',
      reason: 'Open A'
    }]
  });
  assert.ok(changeSet);
  assert.equal(await fixture.store.openEditFile('open-a'), true);

  fixture.store.addDraftEdits({
    runId: 'run-open-missing',
    sessionId: 'session-1',
    edits: [{
      id: 'missing-a',
      uri: vscode.Uri.file(path.join(root, 'missing.ts')).toString(),
      label: 'missing.ts',
      action: 'create',
      newText: '// pending\n',
      reason: 'Missing A'
    }]
  });
  await assert.rejects(fixture.store.openEditFile('missing-a'), /draftEditFileNotFound/u);

  fixture.store.addDraftEdits({
    runId: 'run-open-outside',
    sessionId: 'session-1',
    edits: [draft('outside-a', 'outside.ts')]
  });
  await assert.rejects(fixture.store.openEditFile('outside-a'), /cannotOpenDraftEditOutsideWorkspace/u);
  assert.equal(await fixture.store.openEditFile('unknown-edit'), false);
});

test('persists discarded and reverted terminal history without source text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-history-'));
  const fixture = createStoreFixture(root);
  const discarded = fixture.store.addDraftEdits({
    runId: 'run-discarded',
    sessionId: 'session-1',
    messageId: 'assistant-discarded',
    edits: [draft('discarded', 'discarded.ts')]
  });
  const reverted = fixture.store.addDraftEdits({
    runId: 'run-reverted',
    sessionId: 'session-1',
    messageId: 'assistant-reverted',
    edits: [draft('reverted', 'reverted.ts')]
  });
  assert.ok(discarded && reverted);

  fixture.store.discardAll(discarded.id);
  await fixture.store.applyAll(reverted.id);
  await waitForStoredRuntimeChangeSet(root, reverted.id);

  const afterApply = createStoreFixture(root);
  await afterApply.store.initialize();
  const appliedState = afterApply.store.toWebviewState('session-1');
  assert.deepEqual(appliedState.map((changeSet) => changeSet.status).sort(), ['applied', 'discarded']);
  await afterApply.store.revertAll(reverted.id);
  await afterApply.store.flush();

  const persisted = await waitForStoredHistory(root, 2);
  assert.equal(persisted.version, 4);
  assert.ok(!JSON.stringify(persisted.history).includes('"newText"'));

  const reloaded = createStoreFixture(root);
  await reloaded.store.initialize();
  const state = reloaded.store.toWebviewState('session-1');
  assert.deepEqual(state.map((changeSet) => changeSet.status).sort(), ['discarded', 'reverted']);
  assert.deepEqual(state.map((changeSet) => changeSet.messageId).sort(), ['assistant-discarded', 'assistant-reverted']);
  assert.ok(state.every((changeSet) => changeSet.files.every((file) => !('newText' in file))));
});

test('loads legacy pending ChangeSets without messageId as unlinked instead of inferring a round', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-legacy-'));
  const legacy = createChangeSet({
    runId: 'run-legacy',
    sessionId: 'session-1',
    edits: [draft('legacy', 'legacy.ts')]
  });
  assert.ok(legacy);
  const stored = { ...legacy } as Partial<typeof legacy>;
  delete stored.messageId;
  await writeFile(path.join(root, 'change-sets.json'), JSON.stringify({
    version: 1,
    changeSets: [stored],
    checkpoints: []
  }));

  const fixture = createStoreFixture(root);
  await fixture.store.initialize();
  const state = fixture.store.toWebviewState('session-1');
  assert.equal(state.length, 1);
  assert.equal(state[0]?.messageId, '');
  assert.equal(state[0]?.status, 'pending');
});

test('sharded ChangeSets load only the active session and remain inoperable until an old session is loaded', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-lazy-'));
  const fixture = createStoreFixture(root);
  const current = fixture.store.addDraftEdits({
    runId: 'current-run', sessionId: 'session-1', messageId: 'current-message', edits: [draft('current', 'current.ts')]
  });
  const older = fixture.store.addDraftEdits({
    runId: 'older-run', sessionId: 'session-2', messageId: 'older-message', edits: [draft('older', 'older.ts')]
  });
  assert.ok(current && older);
  await fixture.store.flush();

  const restarted = createStoreFixture(root).store;
  await restarted.initialize();
  assert.equal(restarted.toWebviewState('session-1').length, 1);
  assert.equal(restarted.toWebviewState('session-2').length, 0);
  assert.equal(await restarted.applyAll(older.id), undefined);
  await restarted.loadSession('session-2');
  assert.equal(restarted.toWebviewState('session-2').length, 1);
  assert.ok(await restarted.applyAll(older.id));
});

test('runtime records recover checkpoint links when an older index commit is observed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-index-race-'));
  const fixture = createStoreFixture(root);
  const changeSet = fixture.store.addDraftEdits({
    runId: 'race-run', sessionId: 'session-1', messageId: 'race-message', edits: [draft('race', 'race.ts')]
  });
  assert.ok(changeSet);
  await fixture.store.applyAll(changeSet.id);
  await fixture.store.flush();
  const indexPath = path.join(root, 'change-sets', 'v4', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8')) as { entries: Array<{ checkpointIds: string[] }> };
  for (const entry of index.entries) entry.checkpointIds = [];
  await writeFile(indexPath, JSON.stringify(index));

  const restarted = createStoreFixture(root).store;
  await restarted.initialize();
  const result = await restarted.revertAll(changeSet.id);
  assert.deepEqual(result?.revertedEditIds, ['race']);
});

test('failed ChangeSet migration keeps the monolith readable in memory', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-migration-fallback-'));
  const pending = createChangeSet({
    runId: 'legacy-run', sessionId: 'session-1', messageId: 'legacy-message', edits: [draft('legacy-fallback', 'fallback.ts')]
  });
  assert.ok(pending);
  const monolithPath = path.join(root, 'change-sets.json');
  await writeFile(monolithPath, JSON.stringify({ version: 2, changeSets: [pending], history: [], checkpoints: [] }));
  const originalRename = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (target.fsPath.endsWith('/change-sets/v4/index.json')) throw new Error('simulated index failure');
    await originalRename(source, target, options);
  };
  t.after(() => { vscode.workspace.fs.rename = originalRename; });
  const fixture = createStoreFixture(root);
  await fixture.store.initialize();
  assert.equal(fixture.store.toWebviewState('session-1')[0]?.id, pending.id);
  assert.equal(JSON.parse(await readFile(monolithPath, 'utf8')).changeSets.length, 1);
});

function draft(id: string, label: string) {
  return {
    id,
    uri: `file:///workspace/${label}`,
    label,
    action: 'modify' as const,
    newText: `source for ${label}`,
    reason: `Update ${label}`
  };
}

async function readStoredChangeSets(root: string): Promise<Array<{ id: string; historyInvalidationId?: string; historyOriginUnverified?: boolean; files: ChangeSetFile[] }>> {
  const index = JSON.parse(await readFile(path.join(root, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
    entries: Array<{ storageFile: string }>;
  };
  return Promise.all(index.entries.map(async entry => {
    const stored = JSON.parse(await readFile(path.join(root, 'change-sets', 'v4', entry.storageFile), 'utf8')) as {
      changeSet: { id: string; historyInvalidationId?: string; historyOriginUnverified?: boolean; files: ChangeSetFile[] };
    };
    return stored.changeSet;
  }));
}

function versionedDraft(
  id: string,
  label: string,
  base: { sha256: string; sizeBytes: number },
  content: string
) {
  return createFullTextDraftEdit({
    id,
    uri: `file:///workspace/${label}`,
    label,
    action: 'modify',
    content,
    reason: `Update ${label}`,
    base
  });
}

function createStoreFixture(root: string, failLabel?: string) {
  const now = '2026-07-21T00:00:00.000Z';
  const messages: ChatMessage[] = [];
  const activeSession = {
    id: 'session-1',
    messages,
    updatedAt: now
  } as ChatSession;
  const safeFileEditor = {
    async applyDraftEdit(file: ChangeSetFile, changeSetId: string): Promise<ChangeCheckpoint> {
      if (file.label === failLabel) throw new Error(`failed ${file.label}`);
      return {
        id: `checkpoint-${file.id}`,
        changeSetId,
        editId: file.id,
        uri: file.uri,
        label: file.label,
        action: file.action,
        originalExists: true,
        appliedExists: true,
        createdAt: now,
        appliedAt: now
      };
    },
    async revertCheckpoint(checkpoint: ChangeCheckpoint): Promise<ChangeCheckpoint> {
      return { ...checkpoint, revertedAt: now };
    }
  };
  const sessionStore = {
    getActiveSession: () => activeSession,
    async persist() { return undefined; }
  };
  const diffService = { async openDiff() { return undefined; } };
  return {
    store: new ChangeSetStore(
      safeFileEditor as never,
      diffService as never,
      sessionStore as never,
      vscode.Uri.file(root),
      (key) => key
    ),
    activeSession
  };
}

async function waitForStoredHistory(
  storageRoot: string,
  count: number
): Promise<{ version?: number; history?: unknown[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const index = JSON.parse(await readFile(path.join(storageRoot, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
        version?: number;
        entries?: Array<{ kind?: string; storageFile?: string }>;
      };
      const historyEntries = (index.entries ?? []).filter((entry) => entry.kind === 'history' && entry.storageFile);
      if (historyEntries.length >= count) {
        const history = await Promise.all(historyEntries.map(async (entry) => {
          const record = JSON.parse(await readFile(path.join(storageRoot, 'change-sets', 'v4', entry.storageFile!), 'utf8')) as { changeSet?: unknown };
          return record.changeSet;
        }));
        return { version: index.version, history };
      }
    } catch {
      // Persistence is queued; retry until the terminal snapshots have been written.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for compact ChangeSet history.');
}

async function waitForStoredRuntimeChangeSet(storageRoot: string, changeSetId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const index = JSON.parse(await readFile(path.join(storageRoot, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
        entries?: Array<{ id?: string; kind?: string; storageFile?: string }>;
      };
      const entry = index.entries?.find((candidate) => candidate.id === changeSetId && candidate.kind === 'runtime');
      if (entry?.storageFile) {
        const record = JSON.parse(await readFile(path.join(storageRoot, 'change-sets', 'v4', entry.storageFile), 'utf8')) as {
          changeSet?: { status?: string };
        };
        if (record.changeSet?.status === 'applied') return;
      }
    } catch {
      // Persistence is queued; retry until the applied runtime state is durable.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for applied ChangeSet runtime state.');
}
