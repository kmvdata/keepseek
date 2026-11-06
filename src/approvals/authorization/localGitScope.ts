import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { canonicalPath, isPathInside, joinUnresolvedPath } from './pathScope';
import { isGitProjectSkillPath, isProtectedOperationPath } from './protectedTargets';
import { redactSensitiveReviewText } from '../approvalPolicy';

import type { GitRemoteCommand } from './commandSemantics';
import { inspectGitRemoteScope, type GitRemoteScope } from './gitRemoteScope';

const readGit = promisify(execFile);
const hooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction', 'pre-auto-gc'];
const metadataEntries = ['HEAD', 'index', 'config', 'config.worktree', 'objects', 'objects/info', 'refs', 'logs', 'packed-refs', 'reftable', 'objects/pack'];
const redirectedEntries = ['commondir', 'gitdir', 'objects/info/alternates', 'objects/info/http-alternates', 'modules', 'info/grafts'];
const inProgressEntries = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const maxWorkingTreeBytes = 32 * 1024 * 1024;

type GitScopeResult = { fingerprint: string; repository: string; cwd: string; branchRef?: string; remote?: GitRemoteScope; revisionPaths?: string[] }
  | { reason: string; externalPath?: string; binding?: string; hardBlocked?: boolean };

async function inspectEntry(file: string) {
  return await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return undefined;
  });
}

/** Inspect the same repository and config used by the immutable DraftRun.
 * No Git configuration values leave this service except in the scope hash. */
export async function inspectLocalGitScope(input: {
  executable: string;
  cwd: string;
  roots: readonly string[];
  cwdChanges: readonly string[];
  subcommand: string;
  env: NodeJS.ProcessEnv;
  noOptionalLocks?: boolean;
  noIndexRefresh?: boolean;
  commitAll?: boolean;
  addPathspecs?: readonly string[];
  addTracksOnly?: boolean;
  /** Bare log operands can mean either revisions or paths. Only concrete
   * worktree/index matches become path candidates; refs are never invented files. */
  ambiguousRevisionOperands?: readonly string[];
  remote?: GitRemoteCommand;
  refMutation?: { name: string; action: 'create' | 'delete' | 'force' };
}): Promise<GitScopeResult> {
  try {
    const cwd = await realpath(joinUnresolvedPath(input.cwd, ...input.cwdChanges.filter(Boolean)));
    const root = input.roots.filter(candidate => isPathInside(candidate, cwd)).sort((a, b) => b.length - a.length)[0];
    if (!root) return { reason: 'Git cwd is outside the workspace. / Git 工作目录位于工作区外。' };
    let repository = cwd;
    let metadata = path.join(repository, '.git');
    let entry = await inspectEntry(metadata);
    while (!entry && repository !== root) {
      repository = path.dirname(repository);
      metadata = path.join(repository, '.git');
      entry = await inspectEntry(metadata);
    }
    if (!entry) {
      for (let parent = repository; parent !== path.dirname(parent);) {
        parent = path.dirname(parent);
        if (await inspectEntry(path.join(parent, '.git'))) {
          return { reason: 'Git discovers a repository above the workspace. / Git 会使用工作区上层的仓库。', externalPath: parent };
        }
      }
      return { reason: 'No Git repository was found inside this workspace. / 当前工作区内未找到 Git 仓库。' };
    }
    if (!entry.isDirectory()) {
      const pointer = entry.isSymbolicLink() ? await realpath(metadata)
        : entry.isFile() && entry.size <= 4096
          ? /^gitdir: (.+)$/mu.exec(await readFile(metadata, 'utf8'))?.[1]?.trim() : undefined;
      const target = pointer && await realpath(path.resolve(repository, pointer)).catch(() => undefined);
      return { reason: 'Git uses redirected metadata or a linked worktree. / Git 使用重定向元数据或链接工作树。',
        externalPath: target && !isPathInside(root, target) ? target : undefined };
    }

    const entries = await Promise.all(metadataEntries.map(name => inspectEntry(path.join(metadata, name))));
    if (entries.some(item => item && (!item.isFile() && !item.isDirectory()))
      || (await Promise.all(redirectedEntries.map(name => inspectEntry(path.join(metadata, name))))).some(Boolean)
      || (await readdir(path.join(metadata, 'objects'), { withFileTypes: true })).some(item => item.isSymbolicLink())
      || (await readdir(metadata, { withFileTypes: true })).some(item => item.name.startsWith('sharedindex.') && item.isSymbolicLink())
      || await inspectEntry(path.join(repository, '.gitmodules'))) {
      return { reason: 'Git metadata, object storage or submodules require separate review. / Git 元数据、对象存储或子模块需要单独核对。' };
    }

    const head = entries[0];
    if (!head?.isFile() || head.size > 4096) return { reason: 'Git HEAD could not be verified. / 无法核实 Git HEAD。' };
    const headText = (await readFile(path.join(metadata, 'HEAD'), 'utf8')).trim();
    let headRefIdentity: ReturnType<typeof entryIdentity>;
    const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
    if (headText.startsWith('ref: ')) {
      const ref = headText.slice(5);
      const target = path.resolve(metadata, ref);
      if (!ref.startsWith('refs/') || !isPathInside(path.join(metadata, 'refs'), target)
        || await hasSymlinkBelow(metadata, target)
        || await hasSymlinkBelow(metadata, path.join(metadata, 'logs', ref))) {
        return { reason: 'Git HEAD points to redirected references. / Git HEAD 指向重定向引用。' };
      }
      const headRef = await inspectEntry(target);
      if (headRef && (!headRef.isFile() || headRef.size > 4096
        || !objectId.test((await readFile(target, 'utf8')).trim()))) {
        return { reason: 'Git HEAD refers to an unverified branch ref. / Git HEAD 指向无法核实的分支引用。' };
      }
      headRefIdentity = entryIdentity(headRef);
    } else if (!objectId.test(headText)) {
      return { reason: 'Git HEAD could not be verified. / 无法核实 Git HEAD。' };
    }
    if (await hasSymlinkBelow(metadata, path.join(metadata, 'logs', 'HEAD'))) {
      return { reason: 'Git uses redirected HEAD logs. / Git 使用重定向的 HEAD 日志。' };
    }

    const { stdout } = await readGit(input.executable, ['--git-dir', metadata, '--work-tree', repository,
      'config', '--null', '--show-origin', '--no-includes', '--list'], {
      cwd, env: input.env, timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true
    });
    const fields = stdout.split('\0');
    if (fields.pop() !== '' || fields.length % 2) throw new Error('Malformed Git config response.');
    const configEntries: Array<[string, string]> = [];
    for (let index = 1; index < fields.length; index += 2) {
      const field = fields[index];
      const separator = field.indexOf('\n');
      const key = (separator < 0 ? field : field.slice(0, separator)).toLowerCase();
      configEntries.push([key, separator < 0 ? '' : field.slice(separator + 1)]);
    }
    const effective = new Map(configEntries);
    for (const [key, value] of effective) {
      if (key === 'core.worktree') {
        const target = await canonicalPath(joinUnresolvedPath(metadata, value));
        return { reason: 'Git uses a configured worktree. / Git 使用配置指定的工作树。',
          externalPath: isPathInside(root, target) ? undefined : target };
      }
      if (/^include(?:if)?\./u.test(key)
        || /^extensions\.(?:partialclone|worktreeconfig)$/u.test(key) || /^remote\..*\.promisor$/u.test(key)
        || /^submodule\./u.test(key) || /^filter\..*\.(?:clean|process)$/u.test(key)
        || /^(?:diff\.external|diff\..*\.(?:command|textconv)|pretty\..*|gc\.recentobjectshook)$/u.test(key)
        || (key === 'format.pretty' && /%G/u.test(value))
        || (key === 'log.showsignature' && !isDisabled(value))
        || (key === 'core.fsmonitor' && !isDisabled(value))
        || (key === 'core.splitindex' && !isDisabled(value))
        || (input.subcommand === 'commit' && key === 'commit.gpgsign' && !isDisabled(value))
        || (input.subcommand === 'tag' && input.refMutation && /^(?:tag\.gpgsign|tag\.forcesignannotated)$/u.test(key) && !isDisabled(value))
        || /^maintenance\..*\.enabled$/u.test(key) && !isDisabled(value)) {
        return { reason: `Git configuration requires separate review: ${key}. / Git 配置需要单独核对：${key}。` };
      }
    }
    const { stdout: discovered } = await readGit(input.executable, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], {
      cwd, env: input.env, timeout: 3000, maxBuffer: 32 * 1024, windowsHide: true
    });
    const [foundRepository, foundMetadata, remainder] = discovered.trimEnd().split(/\r?\n/u);
    if (remainder !== undefined || !foundRepository || !foundMetadata
      || await realpath(foundRepository) !== repository || await realpath(foundMetadata) !== metadata) {
      return { reason: 'Git discovery does not match the inspected repository. / Git 实际发现的仓库与已核对的仓库不一致。' };
    }

    const hooksPath = effective.get('core.hookspath');
    let hookIdentities: unknown[] = [];
    let executableHook: string | undefined;
    if (hooksPath !== '/dev/null') {
      if (hooksPath !== undefined && (!hooksPath || /^(?:~|%\(prefix\))/u.test(hooksPath))) {
        return { reason: 'Git uses hooks outside the verified repository. / 无法核实 Git hooks 位于当前仓库内。' };
      }
      const directory = hooksPath ? path.resolve(repository, hooksPath) : path.join(metadata, 'hooks');
      const resolved = await realpath(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return directory;
      });
      if (!isPathInside(repository, resolved) || !isPathInside(repository, directory)) {
        return { reason: 'Git uses hooks outside the verified repository. / Git 使用仓库外的 hooks。',
          externalPath: resolved };
      }
      const mayRefreshIndex = (input.subcommand === 'status' && !input.noOptionalLocks)
        || (input.subcommand === 'diff' && !input.noIndexRefresh && !isDisabled(effective.get('diff.autorefreshindex') ?? ''));
      const relevantHooks = input.subcommand === 'commit' ? hooks
        : input.remote?.kind === 'push' ? ['pre-push']
        : input.refMutation ? ['reference-transaction']
        : input.subcommand === 'add' || mayRefreshIndex ? ['post-index-change'] : [];
      const hookFacts = await Promise.all(relevantHooks.map(async name => {
        const file = path.join(resolved, name);
        const hook = await inspectEntry(file);
        if (!hook) return null;
        if (!hook.isFile() || hook.nlink !== 1) throw new Error('Git hook is not a regular repository file.');
        return [name, hook.dev, hook.ino, hook.mode, hook.size, hook.mtimeMs, hook.ctimeMs] as const;
      }));
      hookIdentities = hookFacts;
      executableHook = hookFacts.find(hook => hook && (hook[3] & 0o111))?.[0];
    }

    // Run only fixed, read-only probes after configuration and metadata checks.
    const readSnapshot = async (args: string[], workingDirectory = repository): Promise<string> => {
      const { stdout: bytes } = await readGit(input.executable, ['--no-pager', '--no-optional-locks', ...args], {
        cwd: workingDirectory, env: { ...input.env, GIT_NO_LAZY_FETCH: '1' },
        timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'buffer'
      });
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
    const indexEntries = await readSnapshot(['ls-files', '--stage', '-z']);
    if (/(?:^|\0)160000 [a-f0-9]+ [0-3]\t/u.test(indexEntries)) {
      return { reason: 'Git index contains a nested repository or submodule. / Git 索引包含嵌套仓库或子模块。' };
    }
    const revisionPaths: string[] = [];
    if (input.ambiguousRevisionOperands?.length) {
      const trackedPaths = indexEntries.split('\0').filter(Boolean).map(record => record.slice(record.indexOf('\t') + 1));
      for (const operand of input.ambiguousRevisionOperands) {
        const target = joinUnresolvedPath(cwd, operand);
        const relative = path.relative(repository, target).split(path.sep).join('/');
        if (await inspectEntry(target) || trackedPaths.some(file => file === relative || file.startsWith(relative + '/'))) {
          revisionPaths.push(target);
        }
      }
    }
    const replacements = await inspectEntry(path.join(metadata, 'refs', 'replace'));
    if (replacements?.isSymbolicLink() || ((entries[8] || replacements)
      && await readSnapshot(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/replace']))) {
      return { reason: 'Git uses replacement references. / Git 使用对象替换引用。' };
    }
    // Loose non-HEAD branches and tags can change without changing HEAD, the
    // packed-refs file or the top refs directory. Bind their resolved objects
    // too so an old query predicate cannot authorize a write after a ref moves.
    // The fixed probe shares readSnapshot's finite output/timeout limits.
    const localRefs = await readSnapshot(['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)']);

    const committing = input.subcommand === 'commit';
    const staging = input.subcommand === 'add';
    let referenceIdentity;
    if (input.refMutation) {
      const ref = path.join('refs', input.subcommand === 'tag' ? 'tags' : 'heads', input.refMutation.name);
      const target = path.join(metadata, ref);
      if (await hasSymlinkBelow(metadata, target) || await hasSymlinkBelow(metadata, path.join(metadata, 'logs', ref))) {
        return { reason: 'Git reference storage is redirected. / Git 引用存储已重定向。', hardBlocked: true };
      }
      referenceIdentity = entryIdentity(await inspectEntry(target));
    }
    let pushRefSnapshot: string | undefined;
    if (input.remote?.kind === 'push') {
      for (const ref of input.remote.refs) {
        const target = path.join(metadata, ref);
        const loose = await inspectEntry(target);
        const tracking = ref.startsWith('refs/heads/') ? path.join('refs', 'remotes', input.remote.remote, ref.slice('refs/heads/'.length)) : undefined;
        if (await hasSymlinkBelow(metadata, target)
          || (tracking && (await hasSymlinkBelow(metadata, path.join(metadata, tracking))
            || await hasSymlinkBelow(metadata, path.join(metadata, 'logs', tracking)))) || (loose && (!loose.isFile() || loose.size > 4096
          || !objectId.test((await readFile(target, 'utf8')).trim())))) {
          return { reason: 'A local push ref uses unverified reference storage. / 待推送本地引用的存储无法核实。', hardBlocked: true };
        }
      }
      pushRefSnapshot = await readSnapshot(['for-each-ref', '--format=%(refname)%00%(objectname)', '--', ...input.remote.refs]);
    }
    const operationMarkers = committing
      ? await Promise.all(inProgressEntries.map(async name => entryIdentity(await inspectEntry(path.join(metadata, name)))))
      : [];
    let mutationStatus: string | undefined;
    let workingTree: string | undefined;
    let scopeReason: string | undefined;
    if (committing || staging) {
      const pathspecs = staging ? input.addPathspecs ?? [] : [];
      const output = await readSnapshot(['status', '--porcelain=v1', '-z', '--no-renames',
        staging && !input.addTracksOnly ? '--untracked-files=all' : '--untracked-files=no',
        '--', ...pathspecs], pathspecs.length ? cwd : repository);
      const candidates = parseMutationStatus(output).filter(item => staging ? item.worktree !== ' '
        : item.index !== ' ' || (input.commitAll && item.worktree !== ' '));
      mutationStatus = JSON.stringify(candidates);
      const protectedFile = candidates.find(({ file }) => {
        const target = path.join(repository, file);
        return isProtectedOperationPath(target, false, isGitProjectSkillPath(repository, target));
      });
      if (protectedFile) {
        const label = redactSensitiveReviewText(JSON.stringify(protectedFile.file), 300);
        return { reason: `Git would include a protected file ${label}. Nothing executed. / Git 会纳入受保护的文件 ${label}，原命令未启动。`, hardBlocked: true };
      }
      if (staging && candidates.some(item => item.index === '?' && item.file.endsWith('/'))) {
        scopeReason = 'Git would stage a nested repository. / Git 会暂存嵌套仓库。';
      } else if (committing && operationMarkers.some(Boolean)) {
        return { reason: 'A Git merge, rebase or sequenced operation is in progress. / Git 正在进行合并、变基或其他序列操作。', hardBlocked: true };
      } else if (committing && candidates.some(item => !isPathInside(cwd, path.join(repository, item.file)))) {
        return { reason: 'Git commit would include changes outside its working directory. / Git 提交会纳入当前工作目录外的改动。', hardBlocked: true };
      } else if (staging || (committing && input.commitAll)) {
        workingTree = await fingerprintWorkingTree(repository, candidates.filter(item => item.worktree !== ' ').map(item => item.file));
      }
    }
    let remote: GitRemoteScope | undefined;
    if (input.remote && !executableHook) {
      try { remote = await inspectGitRemoteScope({ command: input.remote, executable: input.executable, cwd, env: input.env, config: configEntries }); }
      catch (error) {
        // execFile errors can embed configuration values. Only return our own diagnostics.
        return { reason: error instanceof Error && !('code' in error) ? error.message
          : 'Git could not resolve the configured destination. / Git 无法解析配置的目的地。', hardBlocked: true };
      }
    }
    const directory = await stat(metadata);
    const fingerprint = createHash('sha256').update(JSON.stringify([
      repository, metadata, directory.dev, directory.ino, headText, headRefIdentity,
      entryIdentity(entries[1]), entryIdentity(entries[8]), stdout, hooksPath, hookIdentities,
      operationMarkers, mutationStatus, workingTree, referenceIdentity, pushRefSnapshot, localRefs, remote
    ])).digest('hex');
    if (scopeReason) return { reason: scopeReason, binding: fingerprint };
    if (executableHook) return {
      reason: `Git can execute a repository hook: ${executableHook}. / Git 可能执行仓库 hook：${executableHook}。`,
      binding: fingerprint
    };
    return { fingerprint, repository, cwd, remote, ...(revisionPaths.length ? { revisionPaths } : {}),
      branchRef: headText.startsWith('ref: refs/heads/') ? headText.slice(5) : undefined };
  } catch {
    return { reason: 'Git repository settings could not be verified. / 无法核实 Git 仓库设置。' };
  }
}

function parseMutationStatus(output: string): Array<{ index: string; worktree: string; file: string }> {
  const records = output.split('\0');
  if (records.pop() !== '') throw new Error('Incomplete Git status response.');
  return records.map(record => {
    const file = record.slice(3);
    if (record[2] !== ' ' || !file || path.isAbsolute(file)
      || file.split('/').some(component => component === '.' || component === '..')) {
      throw new Error('Invalid Git status path.');
    }
    return { index: record[0], worktree: record[1], file };
  });
}

/** Snapshot the tracked disk contents that -a can add. Index identity alone
 * cannot detect a second edit to a file already marked modified. */
async function fingerprintWorkingTree(repository: string, files: readonly string[]): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(64 * 1024);
  let totalBytes = 0;
  for (const file of files) {
    const target = path.join(repository, file);
    const item = await inspectEntry(target);
    hash.update(JSON.stringify([file, entryIdentity(item)]));
    if (!item) continue; // Git will stage the deletion.
    if (await realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('Git working tree path was redirected.');
    if (item.isSymbolicLink()) {
      hash.update(await readlink(target, { encoding: 'buffer' }));
      continue;
    }
    if (!item.isFile() || item.nlink !== 1) throw new Error('Git working tree entry is not a regular file.');
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (JSON.stringify(entryIdentity(await handle.stat())) !== JSON.stringify(entryIdentity(item))) {
        throw new Error('Git working tree entry changed while it was checked.');
      }
      if (totalBytes + item.size > maxWorkingTreeBytes) throw new Error('Git working tree snapshot exceeds its byte limit.');
      for (let offset = 0; offset < item.size;) {
        const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, item.size - offset), offset);
        if (!bytesRead) throw new Error('Git working tree entry changed while it was checked.');
        offset += bytesRead;
        totalBytes += bytesRead;
        hash.update(chunk.subarray(0, bytesRead));
      }
      if (JSON.stringify(entryIdentity(await handle.stat())) !== JSON.stringify(entryIdentity(item))) {
        throw new Error('Git working tree entry changed while it was checked.');
      }
    } finally {
      await handle.close();
    }
  }
  return hash.digest('hex');
}

async function hasSymlinkBelow(root: string, target: string): Promise<boolean> {
  for (let cursor = target; cursor !== root; cursor = path.dirname(cursor)) {
    if ((await inspectEntry(cursor))?.isSymbolicLink()) return true;
  }
  return false;
}

function entryIdentity(entry: Awaited<ReturnType<typeof inspectEntry>>) {
  return entry && [entry.dev, entry.ino, entry.mode, entry.size, entry.mtimeMs, entry.ctimeMs];
}

function isDisabled(value: string): boolean {
  return /^(?:false|no|off|0)$/iu.test(value.trim());
}
