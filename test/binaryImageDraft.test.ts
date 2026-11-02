import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { hashDraftEditAction } from '../src/approvals/approvalReviewHash';
import { createDraftEditReviewRequest } from '../src/approvals/approvalReviewSurface';
import { prepareBinaryImageDraft } from '../src/edits/binaryImageDraft';
import { ChangeArtifactStore } from '../src/edits/changeArtifactStore';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { assertBinaryImageWorkspaceTarget, SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { BinaryImageDraftError } from '../src/edits/binaryImageErrors';
import { localize } from '../src/shared/i18n';
import type { BinaryImageDraftEditV1, ChangeCheckpoint, ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('binary image drafts create and replace exact raster bytes and revert after restart without text snapshots', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'assets', 'result.png');
  const bytes = png(255);
  const draft = await prepareBinaryImageDraft(input(target, bytes), fixture.artifacts);
  assert.equal(draft.action, 'create');
  assert.equal('content' in draft || 'newText' in draft || 'bytes' in draft, false);
  const applied = await fixture.editor.applyDraftEdit(draft, 'image-set');
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal(await fixture.editor.classifyCheckpoint(applied), 'result');
  const replacement = png(32);
  const replace = await prepareBinaryImageDraft({ ...input(target, replacement), baseBytes: bytes }, fixture.artifacts);
  const replaced = await fixture.editor.applyDraftEdit(replace, 'replace-set');
  assert.equal(replaced.originalText, undefined);
  assert.equal(replaced.originalBlobHash, draft.result.sha256);
  assert.equal(JSON.stringify(replaced).includes(bytes.toString('base64')), false);
  const recovered = JSON.parse(JSON.stringify(replaced)) as ChangeCheckpoint;
  const restarted = new SafeFileEditor();
  restarted.configureArtifactStore(fixture.artifacts);
  await restarted.revertCheckpoint(recovered);
  assert.deepEqual(await fs.readFile(target), bytes);
  await restarted.revertCheckpoint(applied);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('binary Apply rejects baseline conflicts, dirty custom editors, revoked authorization and non-file schemes', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'image.png');
  const original = png(10), result = png(20), changed = png(30);
  await fs.writeFile(target, original);
  const draft = await prepareBinaryImageDraft({ ...input(target, result), baseBytes: original }, fixture.artifacts);
  await fs.writeFile(target, changed);
  await assert.rejects(fixture.editor.applyDraftEdit(draft), /cannotApplyChangedDraftTarget/u);
  assert.deepEqual(await fs.readFile(target), changed);
  await fs.writeFile(target, original);
  vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputCustom(vscode.Uri.file(target)), isDirty: true }] }];
  await assert.rejects(fixture.editor.applyDraftEdit(draft), /cannotApplyDirtyDraftEdit/u);
  vscode.window.tabGroups.all = [];
  await assert.rejects(fixture.editor.applyDraftEdit(draft, 'set', { authorizedUri: draft.uri, isAuthorized: () => false }), code('imageWriteCancelled'));
  for (const source of ['model_reviewer', 'delegated_approver'] as const) {
    await assert.rejects(fixture.editor.applyDraftEdit(draft, 'set', { authorizedUri: draft.uri, isAuthorized: () => true, source }), code('imageWriteVisualConfirmation'));
  }
  await assert.rejects(fixture.editor.applyDraftEdit({ ...draft, uri: 'memfs:/image.png' }), code('imageWriteUnsupportedTarget'));
  assert.deepEqual(await fs.readFile(target), original);
});

test('binary replacement rechecks cancellation immediately before atomic replacement', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'race.png');
  const original = png(42), result = png(43);
  await fs.writeFile(target, original);
  const draft = await prepareBinaryImageDraft({ ...input(target, result), baseBytes: original }, fixture.artifacts);
  let authorizationChecks = 0;
  await assert.rejects(fixture.editor.applyDraftEdit(draft, 'set', {
    authorizedUri: draft.uri, isAuthorized: () => ++authorizationChecks < 4
  }), code('imageWriteCancelled'));
  assert.deepEqual(await fs.readFile(target), original);
  assert.equal(authorizationChecks, 4);
});

test('binary drafts require exact external URI authorization and preserve external Revert', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'outside.png');
  await fs.mkdir(path.join(fixture.root, 'workspace'));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(path.join(fixture.root, 'workspace')), name: 'workspace' }];
  const draft = await prepareBinaryImageDraft(input(target, png(100)), fixture.artifacts);
  await assert.rejects(fixture.editor.applyDraftEdit(draft), /cannotApplyOutsideWorkspace/u);
  const checkpoint = await fixture.editor.applyDraftEdit(draft, 'set', { authorizedUri: draft.uri, isAuthorized: () => true });
  assert.equal(checkpoint.authorizedExternalUri, draft.uri);
  await fixture.editor.revertCheckpoint(checkpoint);
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('binary preflight verifies raster MIME, metadata, artifact hash and extension before mutation', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'safe.png');
  const bytes = png(0);
  const draft = await prepareBinaryImageDraft(input(target, bytes), fixture.artifacts);
  await assert.rejects(prepareBinaryImageDraft({ ...input(target, bytes), assetHash: '0'.repeat(64) }, fixture.artifacts), code('imageWriteInvalidImage'));
  await assert.rejects(prepareBinaryImageDraft({ ...input(target, bytes), width: 2 }, fixture.artifacts), code('imageWriteInvalidImage'));
  await assert.rejects(prepareBinaryImageDraft({ ...input(target, bytes), mimeType: 'image/jpeg' }, fixture.artifacts), code('imageWriteInvalidImage'));
  await assert.rejects(fixture.editor.preflightDraftEdit({ ...draft, uri: vscode.Uri.file(path.join(fixture.root, 'unsafe.ts')).toString() }), code('imageWriteExtensionMismatch'));
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  const forged = { ...draft, result: { sha256: hash(corrupt), sizeBytes: corrupt.length }, assetHash: hash(corrupt), contentBlobHash: hash(corrupt) };
  await fixture.artifacts.putBlob(corrupt);
  await assert.rejects(fixture.editor.preflightDraftEdit(forged), code('imageWriteInvalidImage'));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
});

test('binary prepared journal failure does not write and unknown read-back failure is not replayed', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'image.png');
  const draft = await prepareBinaryImageDraft(input(target, png(15)), fixture.artifacts);
  await assert.rejects(fixture.editor.applyDraftEdit(draft, 'set', undefined, { persist: async () => { throw new Error('journal unavailable'); } }), code('imageWriteFailed'));
  await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  let interrupted: ChangeCheckpoint | undefined;
  const originalVerify = (fixture.editor as unknown as { verifyApplied: (...args: unknown[]) => Promise<void> }).verifyApplied;
  (fixture.editor as unknown as { verifyApplied: (...args: unknown[]) => Promise<void> }).verifyApplied = async () => { throw new Error('read-back unavailable'); };
  try {
    await assert.rejects(fixture.editor.applyDraftEdit(draft, 'set', undefined, { persist: async (value) => { interrupted = structuredClone(value); } }), code('imageWriteFailed'));
  } finally {
    (fixture.editor as unknown as { verifyApplied: (...args: unknown[]) => Promise<void> }).verifyApplied = originalVerify;
  }
  assert.equal(interrupted?.state, 'uncertain');
  assert.equal(await fixture.editor.classifyCheckpoint(interrupted!), 'result');
  assert.deepEqual(await fs.readFile(target), png(15));
  await fs.writeFile(target, png(70));
  assert.equal(await fixture.editor.classifyCheckpoint(interrupted!), 'unknown');
});

test('binary image action approval binds full metadata and describes text review limits', async (t) => {
  const fixture = await setup(t);
  const draft = await prepareBinaryImageDraft(input(path.join(fixture.root, 'image.png'), png(90)), fixture.artifacts);
  const actionHash = hashDraftEditAction(draft);
  const variants: BinaryImageDraftEditV1[] = [
    { ...draft, uri: 'file:///different.png' }, { ...draft, width: 2 }, { ...draft, assetId: 'different' },
    { ...draft, assetHash: '0'.repeat(64) }, { ...draft, mimeType: 'image/jpeg' },
    { ...draft, action: 'modify', base: { sha256: '1'.repeat(64), sizeBytes: 100 } }
  ];
  for (const variant of variants) assert.notEqual(hashDraftEditAction(variant), actionHash);
  const review = createDraftEditReviewRequest({ sessionId: 'session', agentRunId: 'run', edit: draft, originalText: '', history: [], language: 'en' });
  assert.ok(review.staticRiskAnalysis.includes('image_content_not_reviewed'));
  assert.ok(review.staticRiskAnalysis.includes('user_visual_confirmation_required'));
  assert.equal(review.exactAction.kind, 'draft_edit_apply');
  if (review.exactAction.kind === 'draft_edit_apply') assert.match(review.exactAction.proposedChange.content, /image_pixels_not_reviewed/u);
});

test('binary ChangeSet persists metadata, rejects duplicate Apply, survives restart and Discard retains the original asset', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'result.png');
  const draft = await prepareBinaryImageDraft(input(target, png(110)), fixture.artifacts);
  const first = storeFixture(fixture.storage);
  await first.store.initialize();
  const set = first.store.addDraftEdits({ runId: 'image-job', sessionId: 'session-1', edits: [draft] });
  assert.ok(set);
  await first.store.flush();
  const view = first.store.toWebviewState('session-1');
  assert.equal(view[0].files[0].imageSummary?.sizeBytes, draft.result.sizeBytes);
  assert.equal('contentBlobHash' in view[0].files[0], false);
  first.switchSession('other-session');
  await assert.rejects(first.store.openDiff(draft.id), code('imageWriteOtherSession'));
  await assert.rejects(first.store.openEditFile(draft.id), code('imageWriteOtherSession'));
  first.switchSession('session-1');
  const applied = await first.store.applyEdit(draft.id);
  assert.deepEqual(applied?.appliedEditIds, [draft.id]);
  assert.equal(await first.store.applyEdit(draft.id), undefined);
  assert.equal(first.session.messages.length, 0);
  await first.store.flush();
  const restarted = storeFixture(fixture.storage);
  await restarted.store.initialize();
  assert.deepEqual((await restarted.store.revertEdit(draft.id))?.revertedEditIds, [draft.id]);
  assert.equal(restarted.session.messages.length, 0);
  await restarted.store.flush();
  const second = await prepareBinaryImageDraft(input(target, png(110)), fixture.artifacts);
  restarted.store.addDraftEdits({ runId: 'image-job-2', sessionId: 'session-1', edits: [second] });
  assert.equal(restarted.store.discardEdit(second.id), true);
  assert.deepEqual(await fixture.artifacts.getBlob(draft.result.sha256), png(110));
  await restarted.store.flush();
});

test('nonwriting image target checks reject symlink escapes, external paths and dirty editors before file reads', async (t) => {
  const fixture = await setup(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-image-outside-'));
  const originalRead = vscode.workspace.fs.readFile;
  let reads = 0;
  vscode.workspace.fs.readFile = async (uri) => { reads++; return await originalRead(uri); };
  t.after(async () => { vscode.workspace.fs.readFile = originalRead; await fs.rm(outside, { recursive: true, force: true }); });
  await assertBinaryImageWorkspaceTarget(vscode.Uri.file(path.join(fixture.root, 'new', 'image.png')) as never);
  await assert.rejects(assertBinaryImageWorkspaceTarget(vscode.Uri.file(path.join(outside, 'image.png')) as never), code('imageWriteUnsupportedTarget'));
  await fs.symlink(outside, path.join(fixture.root, 'linked'), 'dir');
  await assert.rejects(assertBinaryImageWorkspaceTarget(vscode.Uri.file(path.join(fixture.root, 'linked', 'missing.png')) as never), code('imageWriteUnsupportedTarget'));
  const target = path.join(fixture.root, 'image.png');
  await fs.writeFile(target, png(1));
  await fs.symlink(target, path.join(fixture.root, 'alias.png'));
  await assert.rejects(assertBinaryImageWorkspaceTarget(vscode.Uri.file(path.join(fixture.root, 'alias.png')) as never), code('imageWriteUnsupportedTarget'));
  vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputCustom(vscode.Uri.file(target)), isDirty: true }] }];
  await assert.rejects(assertBinaryImageWorkspaceTarget(vscode.Uri.file(target) as never), {
    message: localize('zh-CN', 'cannotApplyDirtyDraftEdit', { label: vscode.Uri.file(target).path })
  });
  vscode.workspace.isTrusted = false;
  await assert.rejects(assertBinaryImageWorkspaceTarget(vscode.Uri.file(target) as never), code('imageWriteUnsupportedTarget'));
  assert.equal(reads, 0);
});

test('image write errors localize public messages while keeping technical diagnostics separate', () => {
  const originalConfiguration = vscode.workspace.getConfiguration;
  let language: 'en' | 'zh-CN' = 'en';
  vscode.workspace.getConfiguration = () => ({
    get<T>(key: string, fallback: T): T { return key === 'language' ? language as T : fallback; },
    update: async () => undefined
  });
  try {
    const english = new BinaryImageDraftError('imageWriteInvalidImage', 'dimensions mismatch');
    language = 'zh-CN';
    const chinese = new BinaryImageDraftError('imageWriteInvalidImage', 'dimensions mismatch');
    assert.match(english.message, /Image bytes/u);
    assert.match(chinese.message, /图片/u);
    assert.notEqual(chinese.message, english.message);
    assert.equal(chinese.detail, 'dimensions mismatch');
    assert.equal(chinese.message.includes('dimensions mismatch'), false);
    assert.equal(chinese.code, english.code);
  } finally { vscode.workspace.getConfiguration = originalConfiguration; }
});

test('image review projects only selected before/after bytes into an isolated no-script resource root', async (t) => {
  const fixture = await setup(t);
  const target = path.join(fixture.root, 'review.png');
  const original = png(80), result = png(90);
  await fs.writeFile(target, original);
  const draft = await prepareBinaryImageDraft({ ...input(target, result), reason: '<script>alert(1)</script>', baseBytes: original }, fixture.artifacts);
  const mutableWindow = vscode.window as unknown as { createWebviewPanel?: (...args: unknown[]) => unknown };
  const oldCreate = mutableWindow.createWebviewPanel;
  let options: { enableScripts: boolean; localResourceRoots: Array<{ fsPath: string }> } | undefined;
  let disposeCallback: (() => void) | undefined;
  let disposedCount = 0;
  const panels: Array<{ webview: { html: string }; dispose: () => void }> = [];
  mutableWindow.createWebviewPanel = (_type, _title, _column, opts) => {
    options = opts as typeof options;
    let closed = false;
    const panel = { webview: { html: '', cspSource: 'vscode-webview:', asWebviewUri: (uri: unknown) => uri },
      onDidDispose: (callback: () => void) => { disposeCallback = callback; }, dispose: () => {
        if (!closed) { closed = true; disposedCount++; disposeCallback?.(); }
      } };
    panels.push(panel);
    return panel;
  };
  const diff = new DraftDiffService(vscode.Uri.file(fixture.storage) as never);
  try {
    await diff.openDiff(draft);
    assert.equal(options?.enableScripts, false);
    assert.equal(options?.localResourceRoots.length, 1);
    const root = options!.localResourceRoots[0].fsPath;
    assert.ok(root.startsWith(path.join(fixture.storage, 'image-change-previews')));
    assert.notEqual(root, fixture.storage);
    assert.deepEqual(await fs.readFile(path.join(root, 'previous.png')), original);
    assert.deepEqual(await fs.readFile(path.join(root, 'proposed.png')), result);
    assert.match(panels[0].webview.html, /default-src 'none'/u);
    assert.equal(panels[0].webview.html.includes('<script>'), false);
    assert.equal(panels[0].webview.html.includes(result.toString('base64')), false);
    await fs.writeFile(target, png(240));
    await assert.rejects(diff.openDiff(draft), code('imageWriteConflict'));
    assert.equal(panels.length, 1);
    await fs.writeFile(target, original);
    await Promise.all([diff.openDiff(draft), diff.openDiff(draft)]);
    assert.equal(panels.length, 3);
    assert.equal(disposedCount, 2);
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
    const leftover = path.join(fixture.storage, 'image-change-previews', 'crash-leftover');
    await fs.mkdir(leftover);
    const large = await fs.open(path.join(leftover, 'old.png'), 'w');
    try { await large.truncate(128 * 1024 * 1024); } finally { await large.close(); }
    await assert.rejects(diff.openDiff(draft), code('imageWritePreviewQuota'));
    assert.equal(panels.length, 3);
    assert.equal((await fs.stat(path.join(leftover, 'old.png'))).size, 128 * 1024 * 1024);
  } finally {
    diff.dispose();
    if (oldCreate) mutableWindow.createWebviewPanel = oldCreate;
    else delete mutableWindow.createWebviewPanel;
  }
});

function input(target: string, bytes: Buffer) {
  return { uri: vscode.Uri.file(target).toString(), label: path.basename(target), reason: 'Project background', bytes,
    mimeType: 'image/png' as const, width: 1, height: 1, assetId: 'asset-1', assetHash: hash(bytes) };
}
function hash(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function code(expected: string) { return (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === expected; }
function storeFixture(storage: string) {
  const session = { id: 'session-1', messages: [], updatedAt: '2026-11-02T00:00:00.000Z' } as unknown as ChatSession;
  const host = { activeSessionId: session.id, getActiveSession: () => session, persist: async () => undefined };
  return { session, store: new ChangeSetStore(new SafeFileEditor(), { openDiff: async () => undefined } as never,
    host as never, vscode.Uri.file(storage) as never, (key) => key), switchSession: (id: string) => { host.activeSessionId = id; } };
}
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const previous = { folders: vscode.workspace.workspaceFolders, trusted: vscode.workspace.isTrusted,
    documents: vscode.workspace.textDocuments, tabs: vscode.window.tabGroups.all };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-binary-image-'));
  const storage = path.join(root, '.storage');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'workspace' }];
  vscode.workspace.isTrusted = true; vscode.workspace.textDocuments = []; vscode.window.tabGroups.all = [];
  const artifacts = new ChangeArtifactStore(vscode.Uri.file(storage) as never), editor = new SafeFileEditor();
  editor.configureArtifactStore(artifacts);
  t.after(async () => {
    vscode.workspace.workspaceFolders = previous.folders; vscode.workspace.isTrusted = previous.trusted;
    vscode.workspace.textDocuments = previous.documents; vscode.window.tabGroups.all = previous.tabs;
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, storage, artifacts, editor };
}

/** Tiny valid PNG fixture with deterministic distinct pixels. */
function png(channel: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = 0xffffffff;
    for (const byte of body) {
      c ^= byte;
      for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0,channel,0,0,255]))), chunk('IEND', Buffer.alloc(0))]);
}
