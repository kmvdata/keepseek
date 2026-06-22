import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import {
  expandFileReferencesInPrompt,
  getFileReferenceAuthorizationKey
} from '../src/context/references/fileReference';

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
