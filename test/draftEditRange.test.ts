import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentRunner } from '../src/agent/runner';
import { DsmlToolParser } from '../src/agent/deepseek/dsmlToolParser';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME
} from '../src/agent/protocol';
import { DraftEdit } from '../src/shared/types';
import { applyTextPatchToBytes } from '../src/edits/textPatch';
import * as vscode from './stubs/vscode';

type DraftEditInvoker = {
  createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[], language: 'en' | 'zh-CN'): Promise<string>;
  createIncrementalDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[], language: 'en' | 'zh-CN'): Promise<string>;
  createPatchDraftEdits(args: Record<string, unknown>, draftEdits: DraftEdit[], language: 'en' | 'zh-CN'): Promise<string>;
};

test('parses full-width DSML draft edit calls with range aliases', () => {
  const parsed = new DsmlToolParser().parse([
    '<｜｜DSML｜｜tool_calls>',
    '<｜｜DSML｜｜invoke name="keepseek_create_draft_edit">',
    '<｜｜DSML｜｜parameter name="targetPath" string="true">src/sample.ts</｜｜DSML｜｜parameter>',
    '<｜｜DSML｜｜parameter name="newContent" string="true">replacement</｜｜DSML｜｜parameter>',
    '<｜｜DSML｜｜parameter name="reason" string="true">range update</｜｜DSML｜｜parameter>',
    '<｜｜DSML｜｜parameter name="replaceRange" string="true">2-3</｜｜DSML｜｜parameter>',
    '</｜｜DSML｜｜invoke>',
    '</｜｜DSML｜｜tool_calls>'
  ].join('\n'));

  assert.equal(parsed?.content, '');
  assert.equal(parsed?.toolCalls.length, 1);
  assert.equal(parsed?.toolCalls[0].function.name, CREATE_DRAFT_EDIT_TOOL_NAME);
  assert.deepEqual(JSON.parse(parsed?.toolCalls[0].function.arguments ?? '{}'), {
    targetPath: 'src/sample.ts',
    newContent: 'replacement',
    reason: 'range update',
    replaceRange: '2-3'
  });
});

test('creates a patch-native DraftEdit from targetPath/newContent/replaceRange aliases', async (t) => {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-draft-edit-'));
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    await fs.rm(root, { recursive: true, force: true });
  });

  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  const targetPath = path.join(root, 'src', 'sample.ts');
  const originalContent = 'one\ntwo\nthree\nfour\n';
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, originalContent, 'utf8');

  const draftEdits: DraftEdit[] = [];
  const result = await (new AgentRunner() as unknown as DraftEditInvoker).createDraftEdit({
    targetPath,
    newContent: 'deux\ntrois',
    reason: 'replace middle lines',
    replaceRange: '2-3'
  }, draftEdits, 'en');

  const parsedResult = JSON.parse(result) as { ok?: boolean; message?: string };
  assert.equal(parsedResult.ok, true);
  assert.match(parsedResult.message ?? '', /one pending ChangeSet/u);
  assert.equal(draftEdits.length, 1);
  assert.equal(draftEdits[0].label, 'src/sample.ts');
  assert.equal(draftEdits[0].kind, 'text_patch_v1');
  assert.equal(draftEdits[0].kind === 'text_patch_v1'
    ? new TextDecoder().decode(applyTextPatchToBytes(new TextEncoder().encode(originalContent), draftEdits[0].patch))
    : '', 'one\ndeux\ntrois\nfour\n');
  assert.equal(await fs.readFile(targetPath, 'utf8'), originalContent);
});

test('combines multiple exact incremental edits into one canonical patch DraftEdit', async (t) => {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-incremental-edit-'));
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    await fs.rm(root, { recursive: true, force: true });
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  const targetPath = path.join(root, 'src', 'large.ts');
  const originalContent = ['const alpha = 1;', 'const untouched = 2;', 'const omega = 3;', ''].join('\n');
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, originalContent, 'utf8');

  const draftEdits: DraftEdit[] = [];
  const runner = new AgentRunner() as unknown as DraftEditInvoker;
  const result = await runner.createIncrementalDraftEdit({
    path: targetPath,
    reason: 'small exact changes',
    edits: [
      { search: 'const alpha = 1;', replace: 'const alpha = 10;' },
      { replaceRange: '3', replace: 'const omega = 30;' }
    ]
  }, draftEdits, 'en');

  const parsedResult = JSON.parse(result) as { ok?: boolean; message?: string; draftEdit?: { editCount?: number } };
  assert.equal(parsedResult.ok, true);
  assert.equal(parsedResult.draftEdit?.editCount, 2);
  assert.match(parsedResult.message ?? '', /one ChangeSet/u);
  assert.equal(draftEdits.length, 1);
  assert.equal(draftEdits[0].kind, 'text_patch_v1');
  assert.equal(draftEdits[0].kind === 'text_patch_v1'
    ? new TextDecoder().decode(applyTextPatchToBytes(new TextEncoder().encode(originalContent), draftEdits[0].patch))
    : '', ['const alpha = 10;', 'const untouched = 2;', 'const omega = 30;', ''].join('\n'));
  assert.equal(await fs.readFile(targetPath, 'utf8'), originalContent);
  assert.equal(CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME, 'keepseek_create_incremental_draft_edit');
});

test('v9 patch grammar stages Add/Update/Delete/Move as independent DraftEdits without workspace mutation', async (t) => {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-multi-patch-'));
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    await fs.rm(root, { recursive: true, force: true });
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  await Promise.all([
    fs.writeFile(path.join(root, 'update.ts'), 'const value = 1;\n'),
    fs.writeFile(path.join(root, 'delete.ts'), 'delete me\n'),
    fs.writeFile(path.join(root, 'move.ts'), 'move me\n')
  ]);
  const wirePatch = JSON.stringify({
    version: 'keepseek_patch_v1',
    operations: [
      { action: 'update', path: 'update.ts', edits: [{ search: 'value = 1', replace: 'value = 2' }] },
      { action: 'add', path: 'add.ts', content: 'new file\n' },
      { action: 'delete', path: 'delete.ts' },
      { action: 'move', path: 'move.ts', to: 'moved.ts' }
    ]
  });
  const edits: DraftEdit[] = [];
  const rawResult = await (new AgentRunner() as unknown as DraftEditInvoker).createPatchDraftEdits({
    patch: wirePatch,
    reason: 'One coherent multi-file change.'
  }, edits, 'en');
  const result = JSON.parse(rawResult) as { draftEditIds?: string[]; files?: unknown[] };

  assert.equal(APPLY_PATCH_TOOL_NAME, 'keepseek_apply_patch');
  assert.equal(result.draftEditIds?.length, 4);
  assert.equal(result.files?.length, 4);
  assert.deepEqual(edits.map((edit) => edit.kind), ['text_patch_v1', 'full_text_v1', 'delete_v1', 'move_v1']);
  assert.equal(await fs.readFile(path.join(root, 'update.ts'), 'utf8'), 'const value = 1;\n');
  assert.equal(await fs.readFile(path.join(root, 'delete.ts'), 'utf8'), 'delete me\n');
  assert.equal(await fs.readFile(path.join(root, 'move.ts'), 'utf8'), 'move me\n');
  await assert.rejects(fs.stat(path.join(root, 'add.ts')));
  await assert.rejects(fs.stat(path.join(root, 'moved.ts')));
});

test('incremental edit refuses ambiguous search targets instead of guessing', async (t) => {
  const previousWorkspaceFolders = vscode.workspace.workspaceFolders;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-ambiguous-edit-'));
  t.after(async () => {
    vscode.workspace.workspaceFolders = previousWorkspaceFolders;
    await fs.rm(root, { recursive: true, force: true });
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek-test' }];
  const targetPath = path.join(root, 'duplicate.ts');
  await fs.writeFile(targetPath, 'same\nsame\n', 'utf8');
  const draftEdits: DraftEdit[] = [];
  const runner = new AgentRunner() as unknown as DraftEditInvoker;

  await assert.rejects(
    runner.createIncrementalDraftEdit({
      path: targetPath,
      reason: 'ambiguous',
      edits: [{ search: 'same', replace: 'changed' }]
    }, draftEdits, 'en'),
    /ambiguous/iu
  );
  assert.equal(draftEdits.length, 0);
});
