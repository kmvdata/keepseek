import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { hashDraftEditAction } from '../src/approvals/approvalReviewHash';
import { ChangeArtifactStore } from '../src/edits/changeArtifactStore';
import { createChangeSet } from '../src/edits/changeSet';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { SafeFileEditError, SafeFileEditor } from '../src/edits/safeFileEditor';
import {
  applyTextPatchToBytes,
  createInverseTextPatch,
  parseKeepseekPatch,
  prepareTextPatch,
  TextPatchError,
  type TextPatchEditInput,
  type TextPatchLimits
} from '../src/edits/textPatch';
import type { ChangeCheckpoint, ChangeSet, ChatSession, MoveDraftEditV1, TextPatchDraftEditV1 } from '../src/shared/types';
import * as vscode from './stubs/vscode';

const LIMITS: TextPatchLimits = {
  maxPatchBytes: 1_048_576,
  maxHunks: 256,
  maxChangedBytes: 2_097_152,
  maxInlineBytes: 65_536
};

test('patches and reverts a 266KB+ local file without storing full before/after text', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-large-patch-');
  const target = path.join(root, 'large.ts');
  const original = `${'const untouched = 1;\n'.repeat(14_000)}const needle = 1;\n`;
  assert.ok(Buffer.byteLength(original) > 266_000);
  await fs.writeFile(target, original, 'utf8');
  const edit = patchEdit(target, original, [{ search: 'const needle = 1;', replace: 'const needle = 2;' }]);

  assert.equal('newText' in edit, false);
  assert.ok(Buffer.byteLength(JSON.stringify(edit), 'utf8') < 4_000);
  const editor = new SafeFileEditor();
  const checkpoint = await editor.applyDraftEdit(edit, 'large-change');
  assert.match(await fs.readFile(target, 'utf8'), /needle = 2/u);
  assert.equal(checkpoint.originalText, undefined);
  assert.ok(checkpoint.inversePatch);

  const restartedCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as ChangeCheckpoint;
  await new SafeFileEditor().revertCheckpoint(restartedCheckpoint);
  assert.deepEqual(await fs.readFile(target), Buffer.from(original));
});

test('requires the exact base before Apply and exact result before Revert', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-conflict-');
  const target = path.join(root, 'target.ts');
  await fs.writeFile(target, 'alpha\nbeta\n', 'utf8');
  const editor = new SafeFileEditor((key) => key);
  const edit = patchEdit(target, 'alpha\nbeta\n', [{ search: 'beta', replace: 'bravo' }]);
  await fs.writeFile(target, 'alpha\nchanged\n', 'utf8');
  await assert.rejects(editor.applyDraftEdit(edit), /cannotApplyChangedDraftTarget/u);

  await fs.writeFile(target, 'alpha\nbeta\n', 'utf8');
  const checkpoint = await editor.applyDraftEdit(edit);
  await fs.appendFile(target, '// external\n');
  await assert.rejects(editor.revertCheckpoint(checkpoint), /cannotRevertChangedAgentFile/u);
});

test('prepared journal failure occurs before mutation and result identity tampering never reports success', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-journal-');
  const target = path.join(root, 'target.ts');
  const original = 'before\n';
  await fs.writeFile(target, original, 'utf8');
  const editor = new SafeFileEditor();
  const edit = patchEdit(target, original, [{ search: 'before', replace: 'after' }]);
  await assert.rejects(editor.applyDraftEdit(edit, 'set', undefined, {
    persist: async () => { throw new Error('simulated checkpoint storage failure'); }
  }), /checkpoint storage failure/u);
  assert.equal(await fs.readFile(target, 'utf8'), original);

  const tampered = structuredClone(edit);
  tampered.patch.result.sha256 = '0'.repeat(64);
  await assert.rejects(editor.applyDraftEdit(tampered), /canonical hash|result/u);
  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('classifies interrupted prepared/applying checkpoints as base, result, or unknown without replay', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-classify-');
  const target = path.join(root, 'target.ts');
  const original = 'one\ntwo\n';
  await fs.writeFile(target, original, 'utf8');
  const edit = patchEdit(target, original, [{ search: 'two', replace: 'three' }]);
  let applying: ChangeCheckpoint | undefined;
  const checkpoint = await new SafeFileEditor().applyDraftEdit(edit, 'set', undefined, {
    persist: async (value) => {
      if (value.state === 'applying') applying = structuredClone(value);
    }
  });
  assert.ok(applying);
  const editor = new SafeFileEditor();
  assert.equal(await editor.classifyCheckpoint(checkpoint), 'result');
  await fs.writeFile(target, original, 'utf8');
  assert.equal(await editor.classifyCheckpoint(applying!), 'base');
  await fs.writeFile(target, 'unknown\n', 'utf8');
  assert.equal(await editor.classifyCheckpoint(applying!), 'unknown');
});

test('preserves exact UTF-8 bytes across LF, CRLF, mixed EOL, BOM, no-final-newline, Unicode, and emoji', () => {
  const cases = [
    { base: 'a\nb\n', search: 'b', replace: 'β' },
    { base: 'a\r\nb\r\n', search: 'b', replace: '中' },
    { base: 'a\r\nb\nc', search: 'b', replace: '🙂' },
    { base: '\ufeffalpha\n', search: 'alpha', replace: 'omega' },
    { base: 'no final newline', search: 'final', replace: '末尾' },
    { base: 'const face = "🙂";\n', search: '🙂', replace: '🚀' }
  ];
  for (const item of cases) {
    const base = new TextEncoder().encode(item.base);
    const patch = prepareTextPatch({
      targetUri: 'file:///workspace/example.txt', baseBytes: base,
      edits: [{ search: item.search, replace: item.replace }], limits: LIMITS
    });
    const result = applyTextPatchToBytes(base, patch);
    const reverted = applyTextPatchToBytes(result, createInverseTextPatch(patch));
    assert.deepEqual(Buffer.from(reverted), Buffer.from(base));
  }
  const bomOnly = new TextEncoder().encode('\ufeffbody');
  const bomInsertion = prepareTextPatch({
    targetUri: 'file:///bom.txt', baseBytes: bomOnly,
    edits: [{ insertAt: 'start', replace: 'prefix-' }], limits: LIMITS
  });
  assert.deepEqual(
    Buffer.from(applyTextPatchToBytes(bomOnly, bomInsertion)),
    Buffer.from(new TextEncoder().encode('\ufeffprefix-body'))
  );
});

test('rejects missing, ambiguous, overlapping, binary, and oversized hunks while supporting empty/head/tail insertion', () => {
  const base = new TextEncoder().encode('same\nsame\nend');
  assertPatchError(base, [{ search: 'missing', replace: 'x' }], 'missing_match');
  assertPatchError(base, [{ search: 'same', replace: 'x' }], 'ambiguous_match');
  assertPatchError(base, [
    { startLine: 1, endLine: 2, replace: 'x' },
    { startLine: 2, endLine: 3, replace: 'y' }
  ], 'overlapping_hunks');
  assert.throws(() => prepareTextPatch({
    targetUri: 'file:///binary', baseBytes: Uint8Array.from([0, 1, 2]), edits: [{ insertAt: 'end', replace: 'x' }], limits: LIMITS
  }), (error: unknown) => error instanceof TextPatchError && error.code === 'binary_text');
  assertPatchError(new TextEncoder().encode('x'.repeat(70_000)), [{ search: 'x'.repeat(70_000), replace: 'y' }], 'patch_limit');

  const insertionBase = new TextEncoder().encode('middle');
  const insertion = prepareTextPatch({
    targetUri: 'file:///insert', baseBytes: insertionBase,
    edits: [{ insertAt: 'start', replace: '[' }, { insertAt: 'end', replace: ']' }], limits: LIMITS
  });
  assert.equal(new TextDecoder().decode(applyTextPatchToBytes(insertionBase, insertion)), '[middle]');
});

test('strict multi-file grammar rejects traversal, absolute paths, unknown fields, and duplicate targets', () => {
  const parse = (operations: unknown[]) => parseKeepseekPatch(JSON.stringify({ version: 'keepseek_patch_v1', operations }), LIMITS);
  assert.throws(() => parse([{ action: 'delete', path: '../escape' }]), /relative|travers/u);
  assert.throws(() => parse([{ action: 'delete', path: '/absolute' }]), /relative/u);
  assert.throws(() => parse([{ action: 'delete', path: 'a.ts', extra: true }]), /unknown/u);
  assert.throws(() => parse([{ action: 'delete', path: 'a.ts' }, { action: 'add', path: 'a.ts', content: 'x' }]), /more than once/u);
});

test('rejects symbolic-link targets that cross the workspace boundary', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-symlink-');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-patch-outside-'));
  t.after(async () => { await fs.rm(outsideRoot, { recursive: true, force: true }); });
  const outside = path.join(outsideRoot, 'outside.ts');
  const link = path.join(root, 'linked.ts');
  await fs.writeFile(outside, 'outside\n', 'utf8');
  await fs.symlink(outside, link);
  const edit = patchEdit(link, 'outside\n', [{ search: 'outside', replace: 'changed' }]);
  await assert.rejects(new SafeFileEditor().applyDraftEdit(edit), /symbolic link/u);
  assert.equal(await fs.readFile(outside, 'utf8'), 'outside\n');
});

test('uses bounded workspace.fs fallback for a non-file provider and verifies read-back bytes', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-provider-');
  void root;
  const uri = vscode.Uri.parse('mem:/target.ts');
  let bytes = new TextEncoder().encode('before\n');
  let writeMode: 'normal' | 'partial' | 'fail' | 'readback-fail' = 'normal';
  let failReads = false;
  const originalStat = vscode.workspace.fs.stat;
  const originalRead = vscode.workspace.fs.readFile;
  const originalWrite = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.stat = async (candidate) => candidate.toString() === uri.toString()
    ? { type: vscode.FileType.File, size: bytes.byteLength, mtime: Date.now(), ctime: Date.now() }
    : await originalStat(candidate);
  vscode.workspace.fs.readFile = async (candidate) => {
    if (candidate.toString() !== uri.toString()) return await originalRead(candidate);
    if (failReads) throw new Error('simulated read-back failure');
    return bytes;
  };
  vscode.workspace.fs.writeFile = async (candidate, content) => {
    if (candidate.toString() !== uri.toString()) return await originalWrite(candidate, content);
    if (writeMode === 'fail') throw new Error('simulated provider write failure');
    bytes = writeMode === 'partial' ? new TextEncoder().encode('part') : Uint8Array.from(content);
    if (writeMode === 'readback-fail') failReads = true;
  };
  t.after(() => {
    vscode.workspace.fs.stat = originalStat;
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.fs.writeFile = originalWrite;
  });
  const patch = prepareTextPatch({
    targetUri: uri.toString(), baseBytes: bytes, edits: [{ search: 'before', replace: 'after' }], limits: LIMITS
  });
  const edit: TextPatchDraftEditV1 = {
    id: 'mem-edit', uri: uri.toString(), label: 'target.ts', kind: 'text_patch_v1', action: 'modify', reason: 'provider fallback', patch
  };
  const approval = { authorizedUri: edit.uri, isAuthorized: () => true };
  const checkpoint = await new SafeFileEditor().applyDraftEdit(edit, 'set', approval);
  assert.equal(new TextDecoder().decode(bytes), 'after\n');
  await new SafeFileEditor().revertCheckpoint({ ...checkpoint, authorizedExternalUri: edit.uri });
  assert.equal(new TextDecoder().decode(bytes), 'before\n');

  for (const mode of ['partial', 'fail', 'readback-fail'] as const) {
    bytes = new TextEncoder().encode('before\n');
    writeMode = mode;
    failReads = false;
    let failure: unknown;
    try {
      await new SafeFileEditor().applyDraftEdit(edit, `failure-${mode}`, approval);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof SafeFileEditError);
    assert.equal(failure.checkpoint?.state, 'uncertain');
    failReads = false;
    if (mode === 'fail') assert.equal(new TextDecoder().decode(bytes), 'before\n');
    if (mode === 'partial') assert.equal(new TextDecoder().decode(bytes), 'part');
    if (mode === 'readback-fail') assert.equal(new TextDecoder().decode(bytes), 'after\n');
  }

  writeMode = 'normal';
  failReads = false;
  vscode.workspace.fs.stat = async (candidate) => candidate.toString() === uri.toString()
    ? { type: vscode.FileType.File, size: 16_777_217, mtime: Date.now(), ctime: Date.now() }
    : await originalStat(candidate);
  await assert.rejects(new SafeFileEditor().applyDraftEdit(edit, 'oversized-provider', approval), /fallback buffer/u);
});

test('patch Apply rejects dirty tabs and preserves target bytes', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-dirty-tab-');
  const target = path.join(root, 'target.ts');
  const original = 'before\n';
  await fs.writeFile(target, original);
  const edit = patchEdit(target, original, [{ search: 'before', replace: 'after' }]);
  vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputText(vscode.Uri.file(target)), isDirty: true }] }];
  await assert.rejects(new SafeFileEditor((key) => key).applyDraftEdit(edit), /cannotApplyDirtyDraftEdit/u);
  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('action hashes bind every canonical patch field and blob storage deduplicates with safe GC', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-hash-');
  const target = path.join(root, 'target.ts');
  const edit = patchEdit(target, 'a\n', [{ search: 'a', replace: 'b' }]);
  const originalHash = hashDraftEditAction(edit);
  const validChange = patchEdit(target, 'a\n', [{ search: 'a', replace: 'c' }]);
  assert.notEqual(hashDraftEditAction(validChange), originalHash);
  const changed = structuredClone(edit);
  changed.patch.hunks[0].newText = 'c';
  assert.throws(() => hashDraftEditAction(changed), /canonical hash/u);
  assert.throws(() => applyTextPatchToBytes(new TextEncoder().encode('a\n'), changed.patch), /canonical hash/u);

  const artifacts = new ChangeArtifactStore(vscode.Uri.file(path.join(root, '.global')) as never);
  const content = new TextEncoder().encode('deduplicated rollback bytes');
  const first = await artifacts.putBlob(content);
  const usage = await artifacts.getUsageBytes();
  const second = await artifacts.putBlob(content);
  assert.equal(first, second);
  assert.equal(await artifacts.getUsageBytes(), usage);
  const restartedArtifacts = new ChangeArtifactStore(vscode.Uri.file(path.join(root, '.global')) as never);
  assert.deepEqual(Buffer.from(await restartedArtifacts.getBlob(first)), Buffer.from(content));
  await artifacts.garbageCollect(new Set([first]), { minimumAgeMs: 0 });
  assert.deepEqual(Buffer.from(await artifacts.getBlob(first)), Buffer.from(content));
  const persistedReference = path.join(root, '.global', 'owner.json');
  await fs.writeFile(persistedReference, JSON.stringify({ contentBlobHash: first }));
  assert.equal((await artifacts.garbageCollect(new Set(), { minimumAgeMs: 0 })).removed, 0);
  await fs.rm(persistedReference);
  const result = await artifacts.garbageCollect(new Set(), { minimumAgeMs: 0 });
  assert.equal(result.removed, 1);
  await assert.rejects(artifacts.getBlob(first));
});

test('ChangeSet rejects mutation of a versioned DraftEdit under a stable id', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-immutable-');
  const target = path.join(root, 'target.ts');
  const first = patchEdit(target, 'a\n', [{ search: 'a', replace: 'b' }]);
  const changed = patchEdit(target, 'a\n', [{ search: 'a', replace: 'c' }]);
  changed.id = first.id;
  const fixture = createRealStore(path.join(root, '.global'));
  await fixture.store.initialize();
  fixture.store.addDraftEdits({ runId: 'same-run', sessionId: 'session-1', messageId: 'same-message', edits: [first] });
  assert.throws(() => fixture.store.addDraftEdits({
    runId: 'same-run', sessionId: 'session-1', messageId: 'same-message', edits: [changed]
  }), /payload changed|new DraftEdit id/u);
  await fixture.store.flush();
});

test('large patch diffs use hunk-only review while normal files retain vscode.diff', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-diff-');
  const target = path.join(root, 'large.ts');
  const original = `${'x\n'.repeat(2_100_000)}needle\n`;
  await fs.writeFile(target, original, 'utf8');
  const edit = patchEdit(target, original, [{ search: 'needle', replace: 'changed' }]);
  let diffArgs: unknown[] = [];
  vscode.setCommandHandler('vscode.diff', (...args) => { diffArgs = args; });
  const service = new DraftDiffService();
  t.after(() => service.dispose());
  await service.openDiff(edit);
  const right = diffArgs[1] as vscode.Uri;
  assert.match(service.provideTextDocumentContent(right as never), /hunk-only review/u);
  assert.match(service.provideTextDocumentContent(right as never), /result sha256/u);

  const smallTarget = path.join(root, 'small.ts');
  await fs.writeFile(smallTarget, 'needle\n', 'utf8');
  const smallEdit = patchEdit(smallTarget, 'needle\n', [{ search: 'needle', replace: 'changed' }]);
  await service.openDiff(smallEdit);
  const smallRight = diffArgs[1] as vscode.Uri;
  assert.equal(service.provideTextDocumentContent(smallRight as never), 'changed\n');
});

test('Diff falls back to a readable review document and resolves blob-backed before content', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-diff-fallback-');
  const target = path.join(root, 'full.ts');
  const storage = vscode.Uri.file(path.join(root, '.global'));
  const before = new TextEncoder().encode('before\n');
  const artifacts = new ChangeArtifactStore(storage as never);
  const originalBlobHash = await artifacts.putBlob(before);
  const edit = {
    id: 'full-diff', uri: vscode.Uri.file(target).toString(), label: 'full.ts', kind: 'full_text_v1' as const,
    action: 'modify' as const, reason: 'full replacement', content: 'after\n',
    base: { sha256: createHash('sha256').update(before).digest('hex'), sizeBytes: before.byteLength },
    result: { sha256: createHash('sha256').update('after\n').digest('hex'), sizeBytes: 6 },
    encoding: { name: 'utf-8' as const, bom: 'none' as const, eol: 'lf' as const, finalEol: true }
  };
  const checkpoint: ChangeCheckpoint = {
    version: 2, id: 'full-diff-cp', changeSetId: 'set', editId: edit.id, uri: edit.uri, label: edit.label,
    action: 'modify', draftKind: 'full_text_v1', state: 'applied', originalExists: true,
    originalTextHash: edit.base.sha256, originalSizeBytes: before.byteLength, originalBlobHash,
    appliedExists: true, appliedTextHash: edit.result.sha256, appliedSizeBytes: edit.result.sizeBytes,
    createdAt: '2026-09-14T00:00:00.000Z'
  };
  let shown = '';
  const originalShow = vscode.window.showTextDocument;
  vscode.window.showTextDocument = async (document) => {
    shown = document.getText();
    return document;
  };
  vscode.setCommandHandler('vscode.diff', () => { throw new Error('simulated diff renderer failure'); });
  t.after(() => { vscode.window.showTextDocument = originalShow; });
  const service = new DraftDiffService(storage as never);
  t.after(() => service.dispose());
  await service.openDiff(edit, checkpoint);
  assert.equal(shown, 'after\n');
  const contents = (service as unknown as { contents: Map<string, string> }).contents;
  assert.equal([...contents.values()].includes('before\n'), true);
});

test('explicit move payload applies and reverts without overwriting its target', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-move-');
  const source = path.join(root, 'source.ts');
  const target = path.join(root, 'target.ts');
  const bytes = new TextEncoder().encode('move me\n');
  await fs.writeFile(source, bytes);
  const edit: MoveDraftEditV1 = {
    id: 'move-edit', uri: vscode.Uri.file(source).toString(), sourceUri: vscode.Uri.file(source).toString(),
    targetUri: vscode.Uri.file(target).toString(), label: 'source.ts', kind: 'move_v1', action: 'move',
    reason: 'rename explicitly', base: { sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.byteLength }
  };
  const editor = new SafeFileEditor();
  const checkpoint = await editor.applyDraftEdit(edit, 'move-set');
  await assert.rejects(fs.stat(source), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(target), Buffer.from(bytes));
  await editor.revertCheckpoint(JSON.parse(JSON.stringify(checkpoint)) as ChangeCheckpoint);
  assert.deepEqual(await fs.readFile(source), Buffer.from(bytes));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });

  await fs.writeFile(target, 'occupied\n');
  await assert.rejects(editor.applyDraftEdit(edit, 'move-conflict'), /cannotApplyCreatedFileExists/u);
  assert.deepEqual(await fs.readFile(source), Buffer.from(bytes));
  assert.equal(await fs.readFile(target, 'utf8'), 'occupied\n');
});

test('persists inverse patches across restart and reverts without full-file snapshots', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-restart-');
  const target = path.join(root, 'target.ts');
  const storage = path.join(root, '.global');
  const original = `${'unchanged\n'.repeat(30_000)}needle\n`;
  await fs.writeFile(target, original, 'utf8');
  const edit = patchEdit(target, original, [{ search: 'needle', replace: 'changed' }]);
  const first = createRealStore(storage);
  await first.store.initialize();
  const changeSet = first.store.addDraftEdits({
    runId: 'restart-run', sessionId: 'session-1', messageId: 'message-1', edits: [edit]
  });
  assert.ok(changeSet);
  assert.deepEqual((await first.store.applyEdit(edit.id))?.appliedEditIds, [edit.id]);
  await first.store.flush();

  const stored = await readRuntimeRecord(storage, changeSet.id);
  const serialized = JSON.stringify(stored);
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 10_000);
  const storedCheckpoint = await readStoredCheckpoint(storage, (stored.changeSet as ChangeSet).files[0].checkpointId ?? '');
  assert.equal(storedCheckpoint.originalText, undefined);
  assert.ok(storedCheckpoint.inversePatch);

  const restarted = createRealStore(storage);
  await restarted.store.initialize();
  assert.deepEqual((await restarted.store.revertEdit(edit.id))?.revertedEditIds, [edit.id]);
  await restarted.store.flush();
  assert.deepEqual(await fs.readFile(target), Buffer.from(original));
});

test('restart reconciliation covers prepared, applying-before-replace, written-before-marker, and unknown states without replay', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-reconcile-');
  const storage = path.join(root, '.global');
  const files = ['prepared-base.ts', 'applying-base.ts', 'written-before-marker.ts', 'unknown.ts'];
  const edits = files.map((name) => patchEdit(path.join(root, name), 'before\n', [{ search: 'before', replace: 'after' }]));
  await fs.writeFile(path.join(root, files[0]), 'before\n');
  await fs.writeFile(path.join(root, files[1]), 'before\n');
  await fs.writeFile(path.join(root, files[2]), 'after\n');
  await fs.writeFile(path.join(root, files[3]), 'external\n');
  const changeSet = createChangeSet({
    runId: 'crash-run', sessionId: 'session-1', messageId: 'message-1', edits
  });
  assert.ok(changeSet);
  const checkpoints = edits.map((edit, index): ChangeCheckpoint => ({
    version: 2,
    id: `crash-checkpoint-${index}`,
    changeSetId: changeSet.id,
    editId: edit.id,
    uri: edit.uri,
    label: edit.label,
    action: 'modify',
    draftKind: 'text_patch_v1',
    state: index === 0 ? 'prepared' : 'applying',
    operation: 'apply',
    originalExists: true,
    originalTextHash: edit.patch.base.sha256,
    originalSizeBytes: edit.patch.base.sizeBytes,
    appliedExists: true,
    appliedTextHash: edit.patch.result.sha256,
    appliedSizeBytes: edit.patch.result.sizeBytes,
    inversePatch: createInverseTextPatch(edit.patch),
    createdAt: '2026-09-14T00:00:00.000Z'
  }));
  changeSet.files.forEach((file, index) => {
    file.status = index === 0 ? 'prepared' : 'applying';
    file.checkpointId = checkpoints[index].id;
  });
  changeSet.status = 'uncertain';
  await writeV4Storage(storage, changeSet, checkpoints);

  const restarted = createRealStore(storage);
  await restarted.store.initialize();
  assert.deepEqual(restarted.store.toWebviewState('session-1')[0]?.files.map((file) => file.status), [
    'pending', 'pending', 'applied', 'uncertain'
  ]);
  assert.equal(await fs.readFile(path.join(root, files[0]), 'utf8'), 'before\n');
  assert.equal(await fs.readFile(path.join(root, files[1]), 'utf8'), 'before\n');
  assert.equal(await fs.readFile(path.join(root, files[2]), 'utf8'), 'after\n');
  assert.equal(await fs.readFile(path.join(root, files[3]), 'utf8'), 'external\n');
});

test('migrates v3 legacy pending and revertible ChangeSets without reusing patch hashes', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-patch-v3-');
  const storage = path.join(root, '.global');
  const pendingPath = path.join(root, 'pending.ts');
  const appliedPath = path.join(root, 'applied.ts');
  await fs.writeFile(pendingPath, 'old pending\n');
  await fs.writeFile(appliedPath, 'new applied\n');
  const legacyHash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const pending = createChangeSet({
    runId: 'v3-pending', sessionId: 'session-1', messageId: 'message-pending', edits: [{
      id: 'legacy-pending', uri: vscode.Uri.file(pendingPath).toString(), label: 'pending.ts', action: 'modify',
      newText: 'new pending\n', reason: 'legacy pending', expectedOriginalTextHash: legacyHash('old pending\n'),
      expectedOriginalSize: Buffer.byteLength('old pending\n')
    }]
  });
  const applied = createChangeSet({
    runId: 'v3-applied', sessionId: 'session-1', messageId: 'message-applied', edits: [{
      id: 'legacy-applied', uri: vscode.Uri.file(appliedPath).toString(), label: 'applied.ts', action: 'modify',
      newText: 'new applied\n', reason: 'legacy applied', expectedOriginalTextHash: legacyHash('old applied\n'),
      expectedOriginalSize: Buffer.byteLength('old applied\n')
    }]
  });
  assert.ok(pending && applied);
  const legacyCheckpoint: ChangeCheckpoint = {
    id: 'legacy-checkpoint', changeSetId: applied.id, editId: 'legacy-applied', uri: vscode.Uri.file(appliedPath).toString(),
    label: 'applied.ts', action: 'modify', originalExists: true, originalText: 'old applied\n',
    originalTextHash: legacyHash('old applied\n'), appliedExists: true, appliedTextHash: legacyHash('new applied\n'),
    createdAt: '2026-09-14T00:00:00.000Z', appliedAt: '2026-09-14T00:00:01.000Z'
  };
  applied.files[0].status = 'applied';
  applied.files[0].checkpointId = legacyCheckpoint.id;
  applied.status = 'applied';
  await writeV3Storage(storage, [pending, applied], [legacyCheckpoint]);

  const migrated = createRealStore(storage);
  await migrated.store.initialize();
  const migratedState = migrated.store.toWebviewState('session-1');
  assert.equal(migratedState.find((item) => item.id === pending.id)?.status, 'pending');
  assert.equal(migratedState.find((item) => item.id === applied.id)?.status, 'applied');
  assert.deepEqual((await migrated.store.applyEdit('legacy-pending'))?.appliedEditIds, ['legacy-pending']);
  assert.deepEqual((await migrated.store.revertEdit('legacy-applied'))?.revertedEditIds, ['legacy-applied']);
  await migrated.store.flush();
  assert.equal(await fs.readFile(pendingPath, 'utf8'), 'new pending\n');
  assert.equal(await fs.readFile(appliedPath, 'utf8'), 'old applied\n');
  assert.equal((JSON.parse(await fs.readFile(path.join(storage, 'change-sets', 'v4', 'index.json'), 'utf8')) as { version: number }).version, 4);
});

function patchEdit(target: string, baseText: string, edits: TextPatchEditInput[]): TextPatchDraftEditV1 {
  const uri = vscode.Uri.file(target).toString();
  return {
    id: `patch-${path.basename(target)}`,
    uri,
    label: path.basename(target),
    kind: 'text_patch_v1',
    action: 'modify',
    reason: 'test patch',
    patch: prepareTextPatch({ targetUri: uri, baseBytes: new TextEncoder().encode(baseText), edits, limits: LIMITS })
  };
}

function assertPatchError(baseBytes: Uint8Array, edits: TextPatchEditInput[], code: TextPatchError['code']): void {
  assert.throws(() => prepareTextPatch({ targetUri: 'file:///test', baseBytes, edits, limits: LIMITS }),
    (error: unknown) => error instanceof TextPatchError && error.code === code);
}

function createRealStore(storagePath: string) {
  const session = {
    id: 'session-1', messages: [], updatedAt: '2026-09-14T00:00:00.000Z'
  } as unknown as ChatSession;
  const sessionStore = {
    activeSessionId: 'session-1',
    getActiveSession: () => session,
    async persist() { return undefined; }
  };
  const diff = { async openDiff() { return undefined; } };
  return {
    store: new ChangeSetStore(
      new SafeFileEditor(), diff as never, sessionStore as never,
      vscode.Uri.file(storagePath) as never, (key) => key
    ),
    session
  };
}

async function readRuntimeRecord(storagePath: string, changeSetId: string): Promise<{ changeSet: unknown }> {
  const index = JSON.parse(await fs.readFile(path.join(storagePath, 'change-sets', 'v4', 'index.json'), 'utf8')) as {
    entries: Array<{ id: string; storageFile: string }>;
  };
  const entry = index.entries.find((candidate) => candidate.id === changeSetId);
  assert.ok(entry);
  return JSON.parse(await fs.readFile(path.join(storagePath, 'change-sets', 'v4', entry.storageFile), 'utf8')) as { changeSet: unknown };
}

async function readStoredCheckpoint(storagePath: string, checkpointId: string): Promise<ChangeCheckpoint> {
  const record = JSON.parse(await fs.readFile(
    path.join(storagePath, 'change-sets', 'v4', 'checkpoints', storageFileName(checkpointId)), 'utf8'
  )) as { checkpoint: ChangeCheckpoint };
  return record.checkpoint;
}

async function writeV4Storage(storagePath: string, changeSet: ChangeSet, checkpoints: ChangeCheckpoint[]): Promise<void> {
  const root = path.join(storagePath, 'change-sets', 'v4');
  await Promise.all(['runtime', 'history', 'checkpoints'].map((name) => fs.mkdir(path.join(root, name), { recursive: true })));
  const storageFile = `runtime/${storageFileName(changeSet.id)}`;
  await fs.writeFile(path.join(root, storageFile), JSON.stringify({ version: 4, changeSet }));
  await Promise.all(checkpoints.map((checkpoint) => fs.writeFile(
    path.join(root, 'checkpoints', storageFileName(checkpoint.id)), JSON.stringify({ version: 4, checkpoint })
  )));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({
    version: 4,
    entries: [{
      id: changeSet.id, sessionId: changeSet.sessionId, kind: 'runtime', storageFile,
      checkpointIds: checkpoints.map((checkpoint) => checkpoint.id), updatedAt: changeSet.updatedAt
    }]
  }));
}

async function writeV3Storage(storagePath: string, changeSets: ChangeSet[], checkpoints: ChangeCheckpoint[]): Promise<void> {
  const root = path.join(storagePath, 'change-sets', 'v3');
  await Promise.all(['runtime', 'history', 'checkpoints'].map((name) => fs.mkdir(path.join(root, name), { recursive: true })));
  const entries = [];
  for (const changeSet of changeSets) {
    const storageFile = `runtime/${storageFileName(changeSet.id)}`;
    await fs.writeFile(path.join(root, storageFile), JSON.stringify({ version: 3, changeSet }));
    entries.push({
      id: changeSet.id, sessionId: changeSet.sessionId, kind: 'runtime', storageFile,
      checkpointIds: changeSet.files.map((file) => file.checkpointId).filter(Boolean), updatedAt: changeSet.updatedAt
    });
  }
  await Promise.all(checkpoints.map((checkpoint) => fs.writeFile(
    path.join(root, 'checkpoints', storageFileName(checkpoint.id)), JSON.stringify({ version: 3, checkpoint })
  )));
  await fs.writeFile(path.join(root, 'index.json'), JSON.stringify({ version: 3, entries }));
}

function storageFileName(id: string): string {
  return `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`;
}

async function configureWorkspace(
  t: { after(callback: () => void | Promise<void>): void },
  prefix: string
): Promise<string> {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const previousTextDocuments = vscode.workspace.textDocuments;
  const previousTabGroups = vscode.window.tabGroups.all;
  const previousTrusted = vscode.workspace.isTrusted;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  vscode.workspace.textDocuments = [];
  vscode.window.tabGroups.all = [];
  vscode.workspace.isTrusted = true;
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    vscode.workspace.textDocuments = previousTextDocuments;
    vscode.window.tabGroups.all = previousTabGroups;
    vscode.workspace.isTrusted = previousTrusted;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
