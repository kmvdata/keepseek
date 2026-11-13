import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isGitReleaseRef, isGitRemoteAlias, type GitRemoteCommand } from './commandSemantics';
import { assertOperationPath } from './protectedTargets';

const git = promisify(execFile);
const sshUrl = /^(?:ssh:\/\/(?:[\w][\w.-]*@)?[\w][\w.-]*(?::\d{1,5})?\/[\w./~+-]+|(?:[\w][\w.-]*@)?[\w][\w.-]*:[\w./~+-]+)$/u;

export interface GitRemoteScope {
  destination: string;
  protocol: 'ssh' | 'https' | 'file';
  identity: string;
  command: GitRemoteCommand;
  sourceRefs: ReadonlyArray<{ ref: string; object: string }>;
  matchesPushDestination?: boolean;
}

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

type GitProbe = (args: string[]) => Promise<string>;

/** Resolve only a single current branch. A matching or wildcard push still
 * needs an exact source and destination proposal before any network use. */
async function resolveCurrentBranchPush(command: Extract<GitRemoteCommand, { kind: 'push' }>,
  config: ReadonlyArray<readonly [string, string]>, probe: GitProbe, targetOnly = false): Promise<typeof command> {
  const invalid = 'Git push does not resolve to one current branch. Specify the exact remote and ref. / Git 推送未解析到唯一当前分支。请指定确切远端和引用。';
  const ref = (await probe(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim();
  if (!targetOnly && (!ref.startsWith('refs/heads/') || !isGitReleaseRef(ref))) throw new Error(invalid);
  const settings = new Map(config);
  const branch = 'branch.' + ref.slice('refs/heads/'.length).toLowerCase() + '.';
  const remotes = [...new Set(config.flatMap(([key]) => {
    const alias = /^remote\.([\w][\w.-]*)\.url$/u.exec(key)?.[1];
    return alias ? [alias] : [];
  }))];
  const defaultRemote = remotes.length === 1 ? remotes[0] : 'origin';
  const fetchRemote = settings.get(branch + 'remote') ?? defaultRemote;
  const remote = command.remote || settings.get(branch + 'pushremote') || settings.get('remote.pushdefault') || fetchRemote;
  if (!command.remote && !isGitRemoteAlias(remote)) throw new Error(invalid);
  if (targetOnly) return { kind: 'push', remote, refs: [] };
  const configuredRefs = config.filter(([key]) => key === 'remote.' + remote.toLowerCase() + '.push').map(([, value]) => value);
  if (configuredRefs.length) {
    if (configuredRefs.length !== 1 || ![ref, ref + ':' + ref].includes(configuredRefs[0])) throw new Error(invalid);
  } else {
    const mode = settings.get('push.default') ?? 'simple';
    const upstream = config.filter(([key]) => key === branch + 'merge').map(([, value]) => value);
    const sameUpstream = remote === fetchRemote && upstream.length === 1 && upstream[0] === ref;
    if (mode !== 'current' && !(mode === 'simple' && (remote !== fetchRemote || sameUpstream))
      && !(['upstream', 'tracking'].includes(mode) && sameUpstream)) throw new Error(invalid);
  }
  return { kind: 'push', remote, refs: [ref], ...(command.atomic && { atomic: true }) };
}

async function resolveShortPushRef(command: Extract<GitRemoteCommand, { kind: 'push' }>, probe: GitProbe): Promise<typeof command> {
  const short = command.shortRef!;
  const candidates = short === 'HEAD' ? [(await probe(['symbolic-ref', '--quiet', 'HEAD']).catch(() => '')).trim()]
    : ['refs/heads/' + short, 'refs/tags/' + short];
  const output = await probe(['for-each-ref', '--format=%(refname)', '--', ...candidates]);
  const refs = output.trimEnd().split(/\r?\n/u).filter(ref => candidates.includes(ref) && isGitReleaseRef(ref));
  if (refs.length !== 1) {
    throw new Error('The Git push ref is missing or ambiguous. Use its full ref name. / Git 推送引用缺失或有歧义。请使用引用全名。');
  }
  return { kind: 'push', remote: command.remote, refs, ...(command.atomic && { atomic: true }) };
}

async function snapshotPushSources(command: GitRemoteCommand, probe: GitProbe): Promise<GitRemoteScope['sourceRefs']> {
  if (command.kind !== 'push') return [];
  const output = await probe(['for-each-ref', '--format=%(refname)%00%(objectname)', '--', ...command.refs]);
  const sources = new Map<string, string>();
  for (const line of output.trimEnd().split(/\r?\n/u)) {
    const [ref, object, extra] = line.split('\0');
    if (!command.refs.includes(ref)) continue;
    if (extra !== undefined || !objectId.test(object) || sources.has(ref)) {
      throw new Error('Git push source identity is invalid. / Git 推送来源身份无效。');
    }
    sources.set(ref, object);
  }
  return command.refs.map(ref => {
    const object = sources.get(ref);
    if (!object) throw new Error('Git push source ref is missing. / Git 推送来源引用不存在。');
    return { ref, object };
  });
}

/** Only static native transports. Git's resolved URL, rather than the model's
 * alias or the presence of a credential, is the permission target. */
export async function inspectGitRemoteScope(input: {
  command: GitRemoteCommand; executable: string; cwd: string; env: NodeJS.ProcessEnv;
  config: ReadonlyArray<readonly [string, string]>;
  metadataOnly?: boolean;
  targetOnly?: boolean;
}): Promise<GitRemoteScope> {
  const { config } = input;
  const probe: GitProbe = async args => {
    const { stdout } = await git(input.executable, ['--no-pager', '--no-optional-locks', ...args],
      { cwd: input.cwd, env: { ...input.env, GIT_NO_LAZY_FETCH: '1' }, timeout: 3000, maxBuffer: 32 * 1024, windowsHide: true });
    return stdout;
  };
  let command = input.command;
  if (command.kind === 'push' && command.currentBranch) {
    command = await resolveCurrentBranchPush(command, config, probe, input.targetOnly);
  } else if (command.kind === 'push' && command.shortRef) {
    command = await resolveShortPushRef(command, probe);
  }
  const namedRemote = isGitRemoteAlias(command.remote);
  const remotePrefix = namedRemote ? 'remote.' + command.remote.toLowerCase() + '.' : undefined;
  for (const [key, value] of config) {
    if (command.kind === 'push' && remotePrefix && key === remotePrefix + 'fetch' && !isRemoteTrackingRefspec(value, command.remote)) {
      throw new Error('Git fetch configuration redirects local tracking refs. / Git fetch 配置会重定向本地跟踪引用。');
    }
    const disabled = /^(?:0|false|no|off)$/iu.test(value.trim());
    if (/^(?:core\.sshcommand|ssh\.variant|push\.pushoption)$/u.test(key)
      || (!disabled && /^push\.(?:recursesubmodules|gpgsign|followtags|negotiate)$/u.test(key))
      || (remotePrefix && key.startsWith(remotePrefix) && (/\.(?:vcs|uploadpack|receivepack|proxy|serveroption)$/u.test(key)
        || key.endsWith('.mirror') && !disabled))) {
      throw new Error('Git transport overrides require separate review. / Git 传输重写或外部程序配置需单独核对。');
    }
  }
  const resolve = async (push: boolean) => {
    if (!namedRemote) return [command.remote];
    const stdout = await probe(['remote', 'get-url', '--all', ...(push ? ['--push'] : []), '--', command.remote]);
    return stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  };
  const destinations = await resolve(command.kind === 'push');
  if (destinations.length !== 1 || !destinations[0] || destinations[0].startsWith('-') || /[\p{Cc}]/u.test(destinations[0])) {
    throw new Error('Git requires exactly one configured destination for this operation. / 本操作需要唯一配置的 Git 目的地。');
  }
  const [destination] = destinations;
  const sourceRefs = input.targetOnly ? [] : await snapshotPushSources(command, probe);
  let matchesPushDestination: boolean | undefined;
  if (command.kind === 'query') {
    const push = await resolve(true).catch(() => []);
    matchesPushDestination = push.length === 1 && push[0] === destination;
  }
  if (path.isAbsolute(destination) && !destination.startsWith('//') && !destination.startsWith('\\\\')) {
    assertOperationPath(destination, command.kind === 'push');
    const canonical = await realpath(destination);
    const info = await lstat(canonical);
    if (canonical !== destination || !info.isDirectory()) {
      throw new Error('The local Git destination must be a canonical bare repository path. / 本地 Git 目的地必须是裸仓库的真实绝对路径。');
    }
    const configIdentity = await checkLocalBareDestination(canonical, input.executable, input.env,
      command.kind === 'push' ? command.refs : [], input.metadataOnly);
    return { destination, protocol: 'file', identity: `${info.dev}:${info.ino}:${configIdentity}`, command, sourceRefs, matchesPushDestination };
  }
  if (sshUrl.test(destination) && !destination.includes('..') && !destination.startsWith('file:')
    && (!destination.includes('://') || destination.startsWith('ssh://'))) {
    return { destination, protocol: 'ssh', identity: destination, command, sourceRefs, matchesPushDestination };
  }
  if (isCanonicalHttpsDestination(destination)) {
    return { destination, protocol: 'https', identity: destination, command, sourceRefs, matchesPushDestination };
  }
  throw new Error('Git transport requires a canonical HTTPS URL, direct SSH URL, or canonical local path. / Git 传输需要规范 HTTPS URL、直连 SSH URL 或真实本地路径。');
}

function isCanonicalHttpsDestination(destination: string): boolean {
  if (!/^https:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?(?:\/[a-zA-Z0-9._~-]+)+\/?$/u.test(destination)
    || destination.split('/').some(segment => segment === '.' || segment === '..')) return false;
  try { return new URL(destination).href === destination; } catch { return false; }
}

function isRemoteTrackingRefspec(value: string, remote: string): boolean {
  const [source, target, ...extra] = value.replace(/^\+/u, '').split(':');
  if (extra.length || !source.startsWith('refs/heads/') || target !== 'refs/remotes/' + remote + '/' + source.slice('refs/heads/'.length)) return false;
  return source === 'refs/heads/*' || isGitReleaseRef(source);
}

async function checkLocalBareDestination(destination: string, executable: string, env: NodeJS.ProcessEnv,
  pushRefs: readonly string[], metadataOnly = false): Promise<string> {
  const entries = await Promise.all(['HEAD', 'config', 'objects', 'refs', 'hooks'].map(name => lstat(path.join(destination, name))));
  const [head, configFile, ...directories] = entries;
  if (!head.isFile() || !configFile.isFile() || directories.some(entry => !entry.isDirectory())) {
    throw new Error('Local Git destination metadata is redirected or incomplete. / 本地 Git 目的地的元数据已重定向或不完整。');
  }
  const configIdentityOf = (info: typeof configFile) => `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  const configIdentity = configIdentityOf(configFile);
  const inspect = (name: string) => lstat(path.join(destination, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return undefined;
  });
  const redirected = () => new Error('Local Git destination storage is redirected. / 本地 Git 目的地的存储已重定向。');
  const check = async (name: string, directory: boolean) => {
    const entry = await inspect(name);
    if (entry && (directory ? !entry.isDirectory() : !entry.isFile() || entry.nlink !== 1)) throw redirected();
    return entry;
  };
  await Promise.all(['objects/info', 'objects/pack', 'logs', 'reftable'].map(name => check(name, true)));
  await Promise.all(['packed-refs', 'shallow', 'logs/HEAD'].map(name => check(name, false)));
  const knownIndexDirectories = new Set(['objects/info/commit-graphs', 'objects/pack/multi-pack-index.d']);
  for (const directory of ['objects', 'objects/info', 'objects/pack', 'reftable']) {
    if (!await check(directory, true)) continue;
    const entries = await readdir(path.join(destination, directory), { withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink()
      || directory === 'objects' && /^[a-f0-9]{2}$/u.test(entry.name) && !entry.isDirectory())) throw redirected();
    if (directory === 'objects') continue;
    await Promise.all(entries.map(async entry => {
      const name = directory + '/' + entry.name;
      if (!knownIndexDirectories.has(name)) return check(name, false);
      await check(name, true);
      const indexes = await readdir(path.join(destination, name));
      return Promise.all(indexes.map(index => check(name + '/' + index, false)));
    }));
  }
  for (const ref of pushRefs) {
    for (const target of [ref, 'logs/' + ref]) {
      await check(target, false);
      for (let current = path.posix.dirname(target); current !== '.'; current = path.posix.dirname(current)) {
        await check(current, true);
      }
    }
  }
  if ((await Promise.all(['commondir', 'objects/info/alternates', 'objects/info/http-alternates'].map(inspect))).some(Boolean)) {
    throw new Error('Local Git destination configuration or object storage is unverified. / 无法核实本地 Git 目的地配置或对象存储。');
  }
  if (metadataOnly) return configIdentity;
  const { stdout } = await git(executable, ['--git-dir', destination, 'config', '--no-includes', '--null', '--list'],
    { cwd: destination, env, timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true });
  const settings = stdout.split('\0');
  if (settings.pop() !== '') throw new Error('Local Git destination config is invalid. / 本地 Git 目的地配置无效。');
  const effective = new Map(settings.map(entry => {
    const index = entry.indexOf('\n');
    return index < 0 ? [entry.toLowerCase(), ''] : [entry.slice(0, index).toLowerCase(), entry.slice(index + 1)];
  }));
  if (effective.get('core.bare')?.toLowerCase() !== 'true' || [...effective.keys()].some(key =>
    /^include(?:if)?\.|^remote\..*\.promisor$|^(?:core\.worktree|extensions\.(?:worktreeconfig|partialclone)|receive\.procreceiverefs|gc\.recentobjectshook)$/u.test(key))) {
    throw new Error('Local Git destination configuration or object storage is unverified. / 无法核实本地 Git 目的地配置或对象存储。');
  }
  const hooksPath = effective.get('core.hookspath');
  if (hooksPath !== undefined && hooksPath !== 'hooks' && hooksPath !== '/dev/null') {
    throw new Error('Local Git destination uses an unsupported hook directory. / 本地 Git 目的地使用不受支持的 hook 目录。');
  }
  const hookNames = ['pre-receive', 'update', 'post-receive', 'post-update', 'proc-receive', 'push-to-checkout', 'reference-transaction', 'pre-auto-gc'];
  if (hooksPath !== '/dev/null' && (await Promise.all(hookNames.map(name => inspect('hooks/' + name))))
    .some(hook => hook && (!hook.isFile() || process.platform === 'win32' || (hook.mode & 0o111) !== 0))) {
    throw new Error('Local Git destination has an executable receive hook. / 本地 Git 目的地含可执行接收 hook。');
  }
  if (configIdentityOf(await lstat(path.join(destination, 'config'))) !== configIdentity) {
    throw new Error('Local Git destination config changed during inspection. / 核实时本地 Git 目的地配置已变化。');
  }
  return configIdentity;
}
