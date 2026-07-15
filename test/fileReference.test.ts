import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { expandPromptReferencesInPrompt } from '../src/context/references/promptReferences';
import {
  expandFileReferencesInPrompt,
  getExplorerFileUris,
  getFileReferenceAuthorizationKey
} from '../src/context/references/fileReference';

type MutableWorkspaceStub = {
  workspaceFolders: Array<{ uri: vscode.Uri; name?: string }>;
};

test('expands authorized terminal text reference when serialized after inline prompt text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-text-reference-'));
  const filePath = path.join(directory, 'terminal-selection-bun.log');
  await writeFile(filePath, 'bun build failed\nsrc/App.vue:12:3 error\n', 'utf8');

  const uri = vscode.Uri.file(filePath);
  const prompt = `在工程中修复下方前端 bug：[${filePath}]\n<${uri.toString()}>`;

  const expanded = await expandFileReferencesInPrompt(prompt, {
    authorizedExternalReferenceUris: [getFileReferenceAuthorizationKey(uri)],
    language: 'zh-CN'
  });

  assert.match(expanded, /bun build failed/u);
  assert.match(expanded, /src\/App\.vue:12:3 error/u);
  assert.match(expanded, /```log/u);
});

test('keeps unauthorized external text reference unexpanded', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-text-reference-'));
  const filePath = path.join(directory, 'terminal-selection-bun.log');
  await writeFile(filePath, 'hidden external content\n', 'utf8');

  const uri = vscode.Uri.file(filePath);
  const prompt = `请看这个日志：\n<${uri.toString()}>`;

  const expanded = await expandFileReferencesInPrompt(prompt, {
    authorizedExternalReferenceUris: [],
    language: 'zh-CN'
  });

  assert.equal(expanded, prompt);
});

test('expands only the selected workspace line and column range', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-line-reference-'));
  const filePath = path.join(workspacePath, 'sample.txt');
  await writeFile(filePath, 'first\nabcdef\nthird\n', 'utf8');

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  const prompt = `sample.txt (L2#C2-L2#C4)\n<${filePath}#L2C2-L2C4>`;
  const expanded = await expandFileReferencesInPrompt(prompt, { language: 'zh-CN' });

  assert.match(expanded, /\nbc\n/u);
  assert.doesNotMatch(expanded, /abcdef/u);
});

test('expands a workspace directory as a limited manifest instead of full contents', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-directory-reference-'));
  const directoryPath = path.join(workspacePath, 'src');
  await mkdir(path.join(directoryPath, 'nested'), { recursive: true });
  await writeFile(path.join(directoryPath, 'index.ts'), 'export const secret = "not expanded";\n', 'utf8');

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  const prompt = `src/ <keepseek-dir:${directoryPath}>`;
  const expanded = await expandPromptReferencesInPrompt(prompt, { language: 'zh-CN' });

  assert.match(expanded, /目录条目/u);
  assert.match(expanded, /index\.ts/u);
  assert.match(expanded, /nested\//u);
  assert.doesNotMatch(expanded, /not expanded/u);
});

test('deduplicates Explorer multi-selection while preserving selection order', () => {
  const first = vscode.Uri.file('/workspace/first.ts');
  const second = vscode.Uri.file('/workspace/second.ts');

  assert.deepEqual(
    getExplorerFileUris(first, [first, second, first]).map((uri) => uri.toString()),
    [first.toString(), second.toString()]
  );
});
