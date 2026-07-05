import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentRunner } from '../src/agent/runner';
import { DsmlToolParser } from '../src/agent/deepseek/dsmlToolParser';
import { CREATE_DRAFT_EDIT_TOOL_NAME } from '../src/agent/protocol';
import { DraftEdit } from '../src/shared/types';
import * as vscode from './stubs/vscode';

type DraftEditInvoker = {
  createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[], language: 'en' | 'zh-CN'): Promise<string>;
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

test('creates a full-file DraftEdit from targetPath/newContent/replaceRange aliases', async (t) => {
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

  assert.equal(JSON.parse(result).ok, true);
  assert.equal(draftEdits.length, 1);
  assert.equal(draftEdits[0].label, 'src/sample.ts');
  assert.equal(draftEdits[0].newText, 'one\ndeux\ntrois\nfour\n');
  assert.equal(await fs.readFile(targetPath, 'utf8'), originalContent);
});
