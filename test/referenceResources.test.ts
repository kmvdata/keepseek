import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { getWorkspaceReferenceResources } from '../src/context/references/referenceResources';

type MutableWorkspaceStub = {
  workspaceFolders: Array<{ uri: vscode.Uri; name: string }>;
};

test('omits files and directories explicitly ignored by the workspace .gitignore', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-resources-'));
  await writeWorkspaceFiles(workspacePath, {
    '.gitignore': [
      '.cache/',
      '*.generated.js',
      '!important.generated.js',
      '/root-only.txt',
      'docs/*.tmp'
    ].join('\n'),
    '.cache/result.json': '{}',
    'docs/draft.tmp': 'ignored',
    'docs/readme.md': '# Keep me',
    'important.generated.js': 'export {};',
    'nested/root-only.txt': 'keep me',
    'root-only.txt': 'ignored',
    'src/index.ts': 'export {};',
    'src/output.generated.js': 'ignored'
  });

  const resources = await withWorkspace(workspacePath, getWorkspaceReferenceResources);
  const descriptions = new Set(resources.map((resource) => resource.description));

  assert.ok(descriptions.has('.gitignore'));
  assert.ok(descriptions.has('docs/'));
  assert.ok(descriptions.has('docs/readme.md'));
  assert.ok(descriptions.has('important.generated.js'));
  assert.ok(descriptions.has('nested/root-only.txt'));
  assert.ok(descriptions.has('src/index.ts'));
  assert.ok(!descriptions.has('.cache/'));
  assert.ok(!descriptions.has('.cache/result.json'));
  assert.ok(!descriptions.has('docs/draft.tmp'));
  assert.ok(!descriptions.has('root-only.txt'));
  assert.ok(!descriptions.has('src/output.generated.js'));
});

test('applies nested .gitignore overrides without reopening an ignored parent directory', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-nested-reference-resources-'));
  await writeWorkspaceFiles(workspacePath, {
    '.gitignore': ['*.log', 'cache/'].join('\n'),
    'cache/.gitignore': '!keep.txt',
    'cache/keep.txt': 'still ignored because cache is ignored',
    'packages/app/.gitignore': ['!keep.log', 'private/'].join('\n'),
    'packages/app/drop.log': 'ignored by root',
    'packages/app/keep.log': 'restored by nested rules',
    'packages/app/private/secret.ts': 'ignored by nested rules',
    'packages/app/source.ts': 'export {};'
  });

  const resources = await withWorkspace(workspacePath, getWorkspaceReferenceResources);
  const descriptions = new Set(resources.map((resource) => resource.description));

  assert.ok(descriptions.has('packages/app/keep.log'));
  assert.ok(descriptions.has('packages/app/source.ts'));
  assert.ok(!descriptions.has('cache/'));
  assert.ok(!descriptions.has('cache/keep.txt'));
  assert.ok(!descriptions.has('packages/app/drop.log'));
  assert.ok(!descriptions.has('packages/app/private/'));
  assert.ok(!descriptions.has('packages/app/private/secret.ts'));
});

async function writeWorkspaceFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, 'utf8');
  }
}

async function withWorkspace<T>(workspacePath: string, action: () => Promise<T>): Promise<T> {
  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  const previousFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  try {
    return await action();
  } finally {
    workspace.workspaceFolders = previousFolders;
  }
}
