import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MAX_FILE_BYTES } from '../src/shared/config';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import type { DraftEdit } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('deletes a bounded UTF-8 text file and restores its exact bytes from the checkpoint', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-safe-delete-');
  const targetPath = path.join(root, 'src', 'remove.ts');
  const originalBytes = Uint8Array.from([
    0xef, 0xbb, 0xbf,
    ...Buffer.from('export const removed = true;\n', 'utf8')
  ]);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, originalBytes);
  const originalText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(originalBytes);
  const editor = new SafeFileEditor((key) => key);

  const checkpoint = await editor.applyDraftEdit(createDeleteEdit(targetPath, originalText, originalBytes.byteLength), 'change-1');

  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
  assert.equal(checkpoint.action, 'delete');
  assert.equal(checkpoint.originalText, originalText);
  assert.equal(checkpoint.appliedExists, false);

  await editor.revertCheckpoint(checkpoint);
  assert.deepEqual(await fs.readFile(targetPath), Buffer.from(originalBytes));
});

test('refuses deletion when the file no longer matches the prepared baseline', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-safe-delete-changed-');
  const targetPath = path.join(root, 'changed.ts');
  const originalText = 'alpha';
  await fs.writeFile(targetPath, originalText, 'utf8');
  const edit = createDeleteEdit(targetPath, originalText, Buffer.byteLength(originalText));
  await fs.writeFile(targetPath, 'bravo', 'utf8');

  await assert.rejects(
    new SafeFileEditor((key) => key).applyDraftEdit(edit),
    /cannotApplyChangedDeleteTarget/u
  );
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'bravo');
});

test('refuses binary, skipped, and oversized deletion targets without removing them', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-safe-delete-guards-');
  const binaryPath = path.join(root, 'binary.bin');
  const skippedPath = path.join(root, 'image.png');
  const oversizedPath = path.join(root, 'oversized.txt');
  await fs.writeFile(binaryPath, Uint8Array.from([0, 1, 2, 3]));
  await fs.writeFile(skippedPath, 'plain text with a skipped extension', 'utf8');
  await fs.writeFile(oversizedPath, 'x'.repeat(DEFAULT_MAX_FILE_BYTES + 1), 'utf8');
  const editor = new SafeFileEditor((key) => key);

  await assert.rejects(editor.applyDraftEdit(createDeleteEdit(binaryPath)), /cannotDeleteUnreadableFile/u);
  await assert.rejects(editor.applyDraftEdit(createDeleteEdit(skippedPath)), /cannotDeleteUnreadableFile/u);
  await assert.rejects(editor.applyDraftEdit(createDeleteEdit(oversizedPath)), /cannotDeleteOversizedFile/u);

  await Promise.all([binaryPath, skippedPath, oversizedPath].map(async (filePath) => {
    assert.equal((await fs.stat(filePath)).isFile(), true);
  }));
});

test('keeps the existing dirty-editor protection for deletion targets', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-safe-delete-dirty-');
  const targetPath = path.join(root, 'dirty.ts');
  await fs.writeFile(targetPath, 'dirty source', 'utf8');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
  document.isDirty = true;

  await assert.rejects(
    new SafeFileEditor((key) => key).applyDraftEdit(createDeleteEdit(targetPath)),
    /cannotApplyDirtyDraftEdit/u
  );
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'dirty source');
});

function createDeleteEdit(targetPath: string, expectedText?: string, expectedSize?: number): DraftEdit {
  return {
    id: `delete-${path.basename(targetPath)}`,
    uri: vscode.Uri.file(targetPath).toString(),
    label: path.basename(targetPath),
    action: 'delete',
    newText: '',
    reason: 'Remove obsolete file',
    expectedOriginalTextHash: expectedText === undefined ? undefined : hashText(expectedText),
    expectedOriginalSize: expectedSize
  };
}

async function configureWorkspace(
  t: { after(callback: () => void | Promise<void>): void },
  prefix: string
): Promise<string> {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const previousTextDocuments = vscode.workspace.textDocuments;
  const previousTabGroups = vscode.window.tabGroups.all;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  vscode.workspace.textDocuments = [];
  vscode.window.tabGroups.all = [];
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    vscode.workspace.textDocuments = previousTextDocuments;
    vscode.window.tabGroups.all = previousTabGroups;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
