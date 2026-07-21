import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import {
  hashContent,
  ProjectInstructionsResolver
} from '../src/agent/projectInstructions';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('automatically loads only the workspace-root AGENTS.md', async () => {
  const root = await createRoot('keepseek-project-instructions-');
  const rootContent = '# Root rules\n\nUse DraftEdit.';
  await writeFile(path.join(root, 'AGENTS.md'), rootContent, 'utf8');
  await mkdir(path.join(root, '.agents', 'skills', 'nested'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'nested', 'AGENTS.md'), '# Skill-only rules', 'utf8');

  const result = await new ProjectInstructionsResolver().resolve({
    workspaceFolders: [folder(root, 'one')],
    workspaceTrusted: true,
    budgetTokens: 1_000
  });

  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0]?.content, rootContent);
  assert.equal(result.instructions[0]?.contentHash, hashContent(rootContent));
  assert.doesNotMatch(result.instructions[0]?.content ?? '', /Skill-only/u);
});

test('loads one root AGENTS.md from every workspace folder in deterministic order', async () => {
  const first = await createRoot('keepseek-project-instructions-first-');
  const second = await createRoot('keepseek-project-instructions-second-');
  await writeFile(path.join(first, 'AGENTS.md'), 'First workspace rule.', 'utf8');
  await writeFile(path.join(second, 'AGENTS.md'), 'Second workspace rule.', 'utf8');

  const result = await new ProjectInstructionsResolver().resolve({
    workspaceFolders: [folder(first, 'first'), folder(second, 'second')],
    workspaceTrusted: true,
    budgetTokens: 1_000
  });

  assert.deepEqual(result.instructions.map((item) => item.workspaceFolder), ['first', 'second']);
  assert.deepEqual(result.instructions.map((item) => item.content), ['First workspace rule.', 'Second workspace rule.']);
});

test('enforces a shared project-instruction token budget and records truncation without raw trace content', async () => {
  const root = await createRoot('keepseek-project-instructions-budget-');
  const content = Array.from({ length: 300 }, (_, index) => `Rule ${index}: preserve the safety boundary.`).join('\n');
  await writeFile(path.join(root, 'AGENTS.md'), content, 'utf8');

  const result = await new ProjectInstructionsResolver().resolve({
    workspaceFolders: [folder(root, 'budget')],
    workspaceTrusted: true,
    budgetTokens: 80
  });

  assert.equal(result.instructions.length, 1);
  assert.equal(result.instructions[0]?.truncated, true);
  assert.ok((result.instructions[0]?.tokenEstimate ?? Infinity) <= 80);
  assert.equal(result.instructions[0]?.contentHash, hashContent(content));
  assert.ok((result.instructions[0]?.characterCount ?? 0) < content.length);
});

test('does not load project instructions from an untrusted workspace', async () => {
  const root = await createRoot('keepseek-project-instructions-untrusted-');
  await writeFile(path.join(root, 'AGENTS.md'), 'Do something unsafe.', 'utf8');

  const result = await new ProjectInstructionsResolver().resolve({
    workspaceFolders: [folder(root, 'untrusted')],
    workspaceTrusted: false,
    budgetTokens: 1_000
  });

  assert.deepEqual(result.instructions, []);
  assert.equal(result.discarded[0]?.reason, 'workspace_untrusted');
});

async function createRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function folder(root: string, name: string): vscode.WorkspaceFolder {
  return { uri: vscode.Uri.file(root), name, index: 0 };
}
