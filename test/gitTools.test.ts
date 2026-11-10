import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { GitToolService } from '../src/agent/tools/gitTools';
import type { WorkspaceToolAdapter } from '../src/agent/tools/workspaceTools';
import * as vscode from './stubs/vscode';

const gitVerificationSkip = process.platform === 'win32' ? 'Windows native Git executable verification is unavailable.' : false;

test('Git helpers use the controlled read-only CLI without committing or pushing', { skip: gitVerificationSkip }, async (t) => {
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
  assert.equal(status.source, 'git_cli');
  assert.equal('providerAvailable' in status, false);
  assert.equal('fallback' in status, false);
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

test('Git helpers read the live index, worktree and full HEAD without consulting cached VS Code state', { skip: gitVerificationSkip }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-git-api-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => {
    vscode.workspace.workspaceFolders = [];
    vscode.clearExtensions();
  });
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'keepseek-test@example.invalid']);
  await runGit(root, ['config', 'user.name', 'KeepSeek Test']);
  const renamedFrom = '旧文件 name.py';
  const renamedTo = '新文件 name.py';
  const untracked = process.platform === 'win32' ? '未跟踪 file.py' : '未跟踪\nfile.py';
  await fs.writeFile(path.join(root, 'README.md'), '# Before\n');
  await fs.writeFile(path.join(root, renamedFrom), 'rename contents\n');
  await fs.writeFile(path.join(root, 'delete me.py'), 'deleted contents\n');
  await fs.writeFile(path.join(root, 'unchanged.txt'), 'unchanged\n');
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-m', 'initial']);
  const initialHead = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

  let apiCalls = 0;
  vscode.setExtension('vscode.git', {
    isActive: true,
    exports: { enabled: true, getAPI: () => {
      apiCalls += 1;
      return { repositories: [{ rootUri: vscode.Uri.file(root), state: { HEAD: { commit: initialHead } } }] };
    } }
  });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'git-test' }];
  const service = new GitToolService(createWorkspaceAdapter(root));

  assert.equal(JSON.parse(await service.getStatus({}, 'en')).count, 0);
  await fs.writeFile(path.join(root, 'README.md'), '# Index\n');
  await runGit(root, ['mv', renamedFrom, renamedTo]);
  await fs.unlink(path.join(root, 'delete me.py'));
  await runGit(root, ['add', '--all']);
  await fs.writeFile(path.join(root, 'README.md'), '# Worktree\n');
  await fs.writeFile(path.join(root, untracked), 'untracked\n');
  const changedTime = new Date(Date.now() - 10_000);
  await fs.utimes(path.join(root, 'unchanged.txt'), changedTime, changedTime);

  const indexPath = path.join(root, '.git', 'index');
  const indexBefore = await fs.readFile(indexPath);
  const { mtimeMs } = await fs.stat(indexPath);
  const status = JSON.parse(await service.getStatus({}, 'en'));
  const staged = JSON.parse(await service.getDiff({ staged: true }, 'en'));
  const diff = JSON.parse(await service.getDiff({}, 'en'));
  const suggestion = JSON.parse(await service.suggestCommitMessage({}, 'zh-CN'));

  assert.equal(status.ok, true);
  assert.equal(status.branch.commit, initialHead);
  assert.equal(status.count, 4);
  assert.deepEqual(status.changes, [
    { path: 'README.md', status: 'MM', indexStatus: 'M', worktreeStatus: 'M', groups: ['staged', 'working_tree'] },
    { path: 'delete me.py', status: 'D ', indexStatus: 'D', groups: ['staged'] },
    { path: renamedTo, originalPath: renamedFrom, status: 'R ', indexStatus: 'R', groups: ['staged'] },
    { path: untracked, status: '??', groups: ['untracked'] }
  ]);
  const porcelain = await runGit(root, ['--no-pager', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--find-renames', '--untracked-files=all']);
  assert.equal(porcelain, `MM README.md\0D  delete me.py\0R  ${renamedTo}\0${renamedFrom}\0?? ${untracked}\0`);
  assert.deepEqual(staged.summary.files, ['README.md', 'delete me.py', renamedTo]);
  assert.match(staged.diff, /^\+# Index$/mu);
  assert.doesNotMatch(staged.diff, /^\+# Worktree$/mu);
  assert.deepEqual(diff.summary.files, ['README.md']);
  assert.match(diff.diff, /^-# Index\n\+# Worktree$/mu);
  assert.equal(suggestion.staged, true);
  assert.deepEqual(suggestion.basedOn, staged.summary);
  assert.deepEqual(await fs.readFile(indexPath), indexBefore);
  assert.equal((await fs.stat(indexPath)).mtimeMs, mtimeMs);

  await runGit(root, ['commit', '-m', '提交暂存内容']);
  const branch = JSON.parse(await service.getCurrentBranch({}, 'en'));
  assert.equal(branch.branch.commit, (await runGit(root, ['rev-parse', 'HEAD'])).trim());
  assert.notEqual(branch.branch.commit, initialHead);
  assert.equal(apiCalls, 0);
});

test('Git queries select an explicit workspace and use literal subdirectory pathspecs', { skip: gitVerificationSkip }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-git-scope-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  await runGit(root, ['init', '-b', 'main']);
  const child = path.join(root, 'scope');
  await fs.mkdir(child);
  await fs.writeFile(path.join(child, '[x].txt'), 'literal path\n');
  await fs.writeFile(path.join(child, 'x.txt'), 'different path\n');
  await fs.writeFile(path.join(root, 'outside.txt'), 'outside scope\n');
  await runGit(root, ['add', '--all']);
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(root), name: 'repo' },
    { uri: vscode.Uri.file(child), name: 'child' }
  ];
  const service = new GitToolService(createWorkspaceAdapter(root));

  assert.equal(JSON.parse(await service.getStatus({}, 'en')).ok, false);
  const status = JSON.parse(await service.getStatus({ workspaceFolder: child }, 'en'));
  assert.equal(status.repositoryRoot, await fs.realpath(root));
  assert.equal(status.workspaceRoot, await fs.realpath(child));
  assert.deepEqual(status.branch, { name: 'main', unborn: true, detached: false });
  assert.deepEqual(status.changes.map((change: { path: string }) => change.path), ['scope/[x].txt', 'scope/x.txt']);
  const diff = JSON.parse(await service.getDiff({ workspaceFolder: 'child', staged: true, path: '[x].txt' }, 'en'));
  assert.deepEqual(diff.summary.files, ['scope/[x].txt']);
  assert.match(diff.diff, /literal path/u);
  const outside = JSON.parse(await service.getDiff({ workspaceFolder: 'child', path: '../outside.txt' }, 'en'));
  assert.equal(outside.ok, false);

  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(child), name: 'child' }];
  const external = JSON.parse(await service.getStatus({}, 'en'));
  assert.equal(external.ok, false);
  assert.match(external.error, /above the workspace/u);
});

test('Git queries ignore ambient repository overrides and refuse unchecked helpers', { skip: gitVerificationSkip }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-git-override-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  await runGit(root, ['init', '-b', 'main']);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'repo' }];
  const service = new GitToolService(createWorkspaceAdapter(root));

  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(root, 'nonexistent-metadata');
  try {
    assert.equal(JSON.parse(await service.getStatus({}, 'en')).ok, true);
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previousGitDir;
  }

  const shim = path.join(root, 'git');
  await fs.writeFile(shim, '#!/bin/sh\nprintf started > "$0.started"\n', { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = previousPath === undefined ? root : `${root}${path.delimiter}${previousPath}`;
  try {
    const unverified = JSON.parse(await service.getStatus({}, 'en'));
    assert.equal(unverified.ok, false);
    assert.match(unverified.error, /executable could not be verified/u);
    await assert.rejects(fs.access(`${shim}.started`), { code: 'ENOENT' });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  await runGit(root, ['config', 'core.fsmonitor', path.join(root, 'external-monitor')]);
  const status = JSON.parse(await service.getStatus({}, 'zh-CN'));
  assert.equal(status.ok, false);
  assert.match(status.error, /core\.fsmonitor/u);
  const diff = JSON.parse(await service.getDiff({}, 'en'));
  assert.equal(diff.ok, false);
  assert.match(diff.error, /core\.fsmonitor/u);
});

test('Git queries report a merge conflict and label the available worktree comparison', { skip: gitVerificationSkip }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-git-conflict-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.email', 'keepseek-test@example.invalid']);
  await runGit(root, ['config', 'user.name', 'KeepSeek Test']);
  const file = path.join(root, 'conflict.txt');
  await fs.writeFile(file, 'base\n');
  await runGit(root, ['add', '--all']);
  await runGit(root, ['commit', '-m', 'base']);
  await runGit(root, ['checkout', '-b', 'side']);
  await fs.writeFile(file, 'side\n');
  await runGit(root, ['commit', '-am', 'side']);
  await runGit(root, ['checkout', 'main']);
  await fs.writeFile(file, 'main\n');
  await runGit(root, ['commit', '-am', 'main']);
  await assert.rejects(runGit(root, ['merge', 'side']));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'repo' }];

  const service = new GitToolService(createWorkspaceAdapter(root));
  const status = JSON.parse(await service.getStatus({}, 'en'));
  assert.deepEqual(status.changes, [{ path: 'conflict.txt', status: 'UU', indexStatus: 'U', worktreeStatus: 'U', groups: ['merge'] }]);
  const diff = JSON.parse(await service.getDiff({}, 'en'));
  assert.equal(diff.conflictBaseline, 'ours');
  assert.deepEqual(diff.summary.files, ['conflict.txt']);
  assert.match(diff.diff, /<<<<<<< HEAD/u);
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
