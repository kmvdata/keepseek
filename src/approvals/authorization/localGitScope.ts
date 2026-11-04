import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isPathInside, joinUnresolvedPath } from './pathScope';

const readGit = promisify(execFile);
const hooks = ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit', 'post-index-change', 'reference-transaction', 'pre-auto-gc'];
const metadataEntries = ['HEAD', 'index', 'config', 'config.worktree', 'objects', 'objects/info', 'refs', 'logs', 'packed-refs', 'reftable'];
const redirectedEntries = ['commondir', 'gitdir', 'objects/info/alternates', 'objects/info/http-alternates', 'modules'];

type GitScopeResult = { fingerprint: string; repository: string } | { reason: string; externalPath?: string };

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
  noSigning: boolean;
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
      || await inspectEntry(path.join(repository, '.gitmodules'))) {
      return { reason: 'Git metadata, object storage or submodules require separate review. / Git 元数据、对象存储或子模块需要单独核对。' };
    }

    const head = entries[0];
    if (!head?.isFile() || head.size > 4096) return { reason: 'Git HEAD could not be verified. / 无法核实 Git HEAD。' };
    const headText = (await readFile(path.join(metadata, 'HEAD'), 'utf8')).trim();
    let headRefIdentity: ReturnType<typeof entryIdentity>;
    if (headText.startsWith('ref: ')) {
      const ref = headText.slice(5);
      const target = path.resolve(metadata, ref);
      if (!ref.startsWith('refs/') || !isPathInside(path.join(metadata, 'refs'), target)
        || await hasSymlinkBelow(metadata, target)) {
        return { reason: 'Git HEAD points to redirected references. / Git HEAD 指向重定向引用。' };
      }
      headRefIdentity = entryIdentity(await inspectEntry(target));
    }

    const { stdout } = await readGit(input.executable, ['config', '--null', '--show-origin', '--no-includes', '--list'], {
      cwd, env: input.env, timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true
    });
    const fields = stdout.split('\0');
    if (fields.pop() !== '' || fields.length % 2) throw new Error('Malformed Git config response.');
    const effective = new Map<string, string>();
    for (let index = 1; index < fields.length; index += 2) {
      const field = fields[index];
      const separator = field.indexOf('\n');
      const key = (separator < 0 ? field : field.slice(0, separator)).toLowerCase();
      effective.set(key, separator < 0 ? '' : field.slice(separator + 1));
    }
    for (const [key, value] of effective) {
      if (/^include(?:if)?\./u.test(key) || key === 'core.worktree'
        || /^extensions\.(?:partialclone|worktreeconfig)$/u.test(key) || /^remote\..*\.promisor$/u.test(key)
        || /^submodule\./u.test(key) || /^filter\..*\.(?:clean|process)$/u.test(key)
        || /^(?:diff\.external|diff\..*\.(?:command|textconv)|pretty\..*|gc\.recentobjectshook)$/u.test(key)
        || (key === 'format.pretty' && /%G/u.test(value))
        || (key === 'log.showsignature' && !isDisabled(value))
        || (key === 'core.fsmonitor' && !isDisabled(value))
        || (input.subcommand === 'commit' && !input.noSigning && key === 'commit.gpgsign' && !isDisabled(value))
        || /^maintenance\..*\.enabled$/u.test(key) && !isDisabled(value)) {
        return { reason: `Git configuration requires separate review: ${key}. / Git 配置需要单独核对：${key}。` };
      }
    }

    const hooksPath = effective.get('core.hookspath');
    let hookIdentities: unknown[] = [];
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
      hookIdentities = await Promise.all(hooks.map(async name => {
        const file = path.join(resolved, name);
        const hook = await inspectEntry(file);
        if (!hook) return null;
        if (!hook.isFile() || hook.nlink !== 1) throw new Error('Git hook is not a regular repository file.');
        return [name, hook.dev, hook.ino, hook.mode, hook.size, hook.mtimeMs, hook.ctimeMs];
      }));
    }
    const directory = await stat(metadata);
    const fingerprint = createHash('sha256').update(JSON.stringify([
      repository, metadata, directory.dev, directory.ino, headText, headRefIdentity,
      entryIdentity(entries[1]), entryIdentity(entries[8]), stdout, hooksPath, hookIdentities
    ])).digest('hex');
    return { fingerprint, repository };
  } catch {
    return { reason: 'Git repository settings could not be verified. / 无法核实 Git 仓库设置。' };
  }
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
