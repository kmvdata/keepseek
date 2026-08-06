import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { AgentRunner } from '../src/agent/runner';
import { DEFAULT_MAX_FILE_BYTES } from '../src/shared/config';
import type { DraftEdit } from '../src/shared/types';
import * as vscode from './stubs/vscode';

type DeleteDraftInvoker = {
  createDeleteDraftEdit(
    args: Record<string, unknown>,
    draftEdits: DraftEdit[],
    language: 'en' | 'zh-CN'
  ): Promise<string>;
  createDraftEdit(
    args: Record<string, unknown>,
    draftEdits: DraftEdit[],
    language: 'en' | 'zh-CN'
  ): Promise<string>;
};

test('prepares a baseline-guarded delete DraftEdit without deleting the file', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-delete-draft-');
  const targetPath = path.join(root, 'src', 'obsolete.ts');
  const originalText = 'export const obsolete = true;\n';
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, originalText, 'utf8');
  const draftEdits: DraftEdit[] = [];

  const rawResult = await invoke().createDeleteDraftEdit({
    path: 'src/obsolete.ts',
    reason: 'No longer referenced'
  }, draftEdits, 'en');
  const result = JSON.parse(rawResult) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(draftEdits.length, 1);
  assert.equal(draftEdits[0]?.action, 'delete');
  assert.equal(draftEdits[0]?.newText, '');
  assert.equal(draftEdits[0]?.expectedOriginalSize, Buffer.byteLength(originalText));
  assert.equal(draftEdits[0]?.expectedOriginalTextHash, hashText(originalText));
  assert.equal(await fs.readFile(targetPath, 'utf8'), originalText);
});

test('rejects missing, directory, outside-workspace, binary, and oversized delete targets', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-delete-invalid-');
  const directoryPath = path.join(root, 'directory');
  const binaryPath = path.join(root, 'binary.txt');
  const oversizedPath = path.join(root, 'oversized.txt');
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(binaryPath, Uint8Array.from([...Buffer.from('safe prefix'), 0xff]));
  await fs.writeFile(oversizedPath, 'x'.repeat(DEFAULT_MAX_FILE_BYTES + 1), 'utf8');

  const missing = JSON.parse(await invoke().createDeleteDraftEdit({
    path: 'missing.ts',
    reason: 'Missing'
  }, [], 'en')) as Record<string, unknown>;
  const directory = JSON.parse(await invoke().createDeleteDraftEdit({
    path: directoryPath,
    reason: 'Directory'
  }, [], 'en')) as Record<string, unknown>;
  const binary = JSON.parse(await invoke().createDeleteDraftEdit({
    path: binaryPath,
    reason: 'Binary'
  }, [], 'en')) as Record<string, unknown>;
  const oversized = JSON.parse(await invoke().createDeleteDraftEdit({
    path: oversizedPath,
    reason: 'Oversized'
  }, [], 'en')) as Record<string, unknown>;

  assert.equal(missing.errorType, 'delete_target_missing');
  assert.equal(directory.errorType, 'delete_target_not_file');
  assert.equal(binary.errorType, 'delete_target_unreadable');
  assert.equal(oversized.errorType, 'delete_target_oversized');
  await assert.rejects(
    invoke().createDeleteDraftEdit({
      path: path.join(root, '..', 'outside.ts'),
      reason: 'Outside'
    }, [], 'en'),
    /inside the currently open workspace/u
  );
  assert.equal((await fs.stat(binaryPath)).isFile(), true);
  assert.equal((await fs.stat(oversizedPath)).isFile(), true);
});

test('rejects create/delete conflicts for the same URI in either order', async (t) => {
  const root = await configureWorkspace(t, 'keepseek-delete-conflict-');
  await fs.writeFile(path.join(root, 'first.ts'), 'first\n', 'utf8');
  await fs.writeFile(path.join(root, 'second.ts'), 'second\n', 'utf8');
  const runner = invoke();

  const createThenDelete: DraftEdit[] = [];
  await runner.createDraftEdit({
    path: 'first.ts',
    content: 'changed first\n',
    reason: 'Modify first'
  }, createThenDelete, 'en');
  const deleteConflict = JSON.parse(await runner.createDeleteDraftEdit({
    path: 'first.ts',
    reason: 'Delete first'
  }, createThenDelete, 'en')) as Record<string, unknown>;

  const deleteThenCreate: DraftEdit[] = [];
  await runner.createDeleteDraftEdit({
    path: 'second.ts',
    reason: 'Delete second'
  }, deleteThenCreate, 'en');
  const createConflict = JSON.parse(await runner.createDraftEdit({
    path: 'second.ts',
    content: 'changed second\n',
    reason: 'Modify second'
  }, deleteThenCreate, 'en')) as Record<string, unknown>;

  assert.equal(deleteConflict.errorType, 'draft_edit_conflict');
  assert.equal(createConflict.errorType, 'draft_edit_conflict');
  assert.equal(createThenDelete.length, 1);
  assert.equal(deleteThenCreate.length, 1);
});

test('resolves a root-qualified delete path in a multi-root workspace', async (t) => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-delete-first-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-delete-second-'));
  const previousFolders = vscode.workspace.workspaceFolders;
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(firstRoot), name: 'first' },
    { uri: vscode.Uri.file(secondRoot), name: 'second' }
  ];
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousFolders;
    await fs.rm(firstRoot, { recursive: true, force: true });
    await fs.rm(secondRoot, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(secondRoot, 'target.ts'), 'target\n', 'utf8');
  const draftEdits: DraftEdit[] = [];

  const result = JSON.parse(await invoke().createDeleteDraftEdit({
    path: 'second/target.ts',
    reason: 'Remove second-root target'
  }, draftEdits, 'en')) as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(draftEdits[0]?.label, 'second/target.ts');
  assert.equal(vscode.Uri.parse(draftEdits[0]?.uri ?? '').fsPath, path.join(secondRoot, 'target.ts'));
});

function invoke(): DeleteDraftInvoker {
  return new AgentRunner() as unknown as DeleteDraftInvoker;
}

async function configureWorkspace(t: TestContext, prefix: string): Promise<string> {
  const previousFolders = vscode.workspace.workspaceFolders;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousFolders;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
