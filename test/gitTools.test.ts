import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { GitToolService } from '../src/agent/tools/gitTools';
import type { WorkspaceToolAdapter } from '../src/agent/tools/workspaceTools';
import * as vscode from './stubs/vscode';

test('Git helpers use the controlled read-only fallback without committing or pushing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-git-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'keepseek-test@example.invalid']);
  await runGit(root, ['config', 'user.name', 'KeepSeek Test']);
  await fs.writeFile(path.join(root, 'README.md'), '# Before\n');
  await runGit(root, ['add', 'README.md']);
  await runGit(root, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(root, 'README.md'), '# After\n\nSafe Git helper test.\n');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'git-test' }];

  const service = new GitToolService(createWorkspaceAdapter(root));
  const status = JSON.parse(await service.getStatus({}, 'en'));
  const branch = JSON.parse(await service.getCurrentBranch({}, 'en'));
  const diff = JSON.parse(await service.getDiff({}, 'en'));
  const patch = JSON.parse(await service.createPatch({}, 'en'));
  const suggestion = JSON.parse(await service.suggestCommitMessage({}, 'en'));

  assert.equal(status.ok, true);
  assert.equal(status.providerAvailable, false);
  assert.equal(status.fallback, true);
  assert.equal(status.count, 1);
  assert.equal(branch.branch.name, 'main');
  assert.equal(diff.summary.fileCount, 1);
  assert.equal(diff.truncated, false);
  assert.match(diff.diff, /Safe Git helper test/u);
  assert.equal(patch.writtenToDisk, false);
  assert.match(patch.patch, /^diff --git/mu);
  assert.match(suggestion.suggestion, /^docs/u);

  const log = await runGit(root, ['log', '--oneline']);
  assert.equal(log.trim().split(/\r?\n/u).length, 1);
});

function createWorkspaceAdapter(root: string): WorkspaceToolAdapter {
  return {
    resolveTargetUri(targetPath: string) { return vscode.Uri.file(path.join(root, targetPath)); },
    getLabel(uri: import('vscode').Uri) { return path.relative(root, uri.fsPath); }
  } as unknown as WorkspaceToolAdapter;
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message)));
        return;
      }
      resolve(String(stdout));
    });
  });
}
