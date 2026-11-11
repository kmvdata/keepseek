import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isGitReleaseRef, type GitRemoteCommand } from './commandSemantics';
import { assertOperationPath } from './protectedTargets';

const git = promisify(execFile);
const sshUrl = /^(?:ssh:\/\/(?:[\w][\w.-]*@)?[\w][\w.-]*(?::\d{1,5})?\/[\w./~+-]+|(?:[\w][\w.-]*@)?[\w][\w.-]*:[\w./~+-]+)$/u;

export interface GitRemoteScope {
  destination: string;
  protocol: 'ssh' | 'file';
  identity: string;
  matchesPushDestination?: boolean;
}

/** Only static native transports. Git's resolved URL, rather than the model's
 * alias or the presence of a credential, is the permission target. */
export async function inspectGitRemoteScope(input: {
  command: GitRemoteCommand; executable: string; cwd: string; env: NodeJS.ProcessEnv;
  config: ReadonlyArray<readonly [string, string]>;
  metadataOnly?: boolean;
}): Promise<GitRemoteScope> {
  const { command, config } = input;
  const remotePrefix = 'remote.' + command.remote.toLowerCase() + '.';
  for (const [key, value] of config) {
    if (command.kind === 'push' && key === remotePrefix + 'fetch' && !isRemoteTrackingRefspec(value, command.remote)) {
      throw new Error('Git fetch configuration redirects local tracking refs. / Git fetch 配置会重定向本地跟踪引用。');
    }
    const disabled = /^(?:0|false|no|off)$/iu.test(value.trim());
    if (/^url\..*\.(?:insteadof|pushinsteadof)$/u.test(key)
      || /^(?:core\.sshcommand|ssh\.variant|push\.pushoption)$/u.test(key)
      || (!disabled && /^push\.(?:recursesubmodules|gpgsign|followtags|negotiate)$/u.test(key))
      || (key.startsWith(remotePrefix) && (/\.(?:vcs|uploadpack|receivepack|proxy|serveroption)$/u.test(key)
        || key.endsWith('.mirror') && !disabled))) {
      throw new Error('Git transport overrides require separate review. / Git 传输重写或外部程序配置需单独核对。');
    }
  }
  const resolve = async (push: boolean) => {
    const { stdout } = await git(input.executable,
      ['remote', 'get-url', '--all', ...(push ? ['--push'] : []), '--', command.remote],
      { cwd: input.cwd, env: input.env, timeout: 3000, maxBuffer: 8192, windowsHide: true });
    return stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  };
  const destinations = await resolve(command.kind === 'push');
  if (destinations.length !== 1 || !destinations[0] || destinations[0].startsWith('-') || /[\p{Cc}]/u.test(destinations[0])) {
    throw new Error('Git requires exactly one configured destination for this operation. / 本操作需要唯一配置的 Git 目的地。');
  }
  const [destination] = destinations;
  let matchesPushDestination: boolean | undefined;
  if (command.kind === 'query') {
    const push = config.some(([key]) => key === remotePrefix + 'pushurl') ? await resolve(true).catch(() => []) : destinations;
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
    return { destination, protocol: 'file', identity: `${info.dev}:${info.ino}:${configIdentity}`, matchesPushDestination };
  }
  if (sshUrl.test(destination) && !destination.includes('..') && !destination.startsWith('file:')
    && (!destination.includes('://') || destination.startsWith('ssh://'))) {
    return { destination, protocol: 'ssh', identity: destination, matchesPushDestination };
  }
  throw new Error('Only direct SSH and canonical local Git transports are supported. / 当前支持直连 SSH 和真实路径的本地 Git 传输。');
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
  for (const ref of pushRefs) {
    for (const target of [ref, 'logs/' + ref]) {
      for (let current = target; current !== '.'; current = path.posix.dirname(current)) {
        if ((await inspect(current))?.isSymbolicLink()) {
          throw new Error('Local Git destination reference storage is redirected. / 本地 Git 目的地的引用存储已重定向。');
        }
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
    .some(hook => hook && (!hook.isFile() || (hook.mode & 0o111) !== 0))) {
    throw new Error('Local Git destination has an executable receive hook. / 本地 Git 目的地含可执行接收 hook。');
  }
  if (configIdentityOf(await lstat(path.join(destination, 'config'))) !== configIdentity) {
    throw new Error('Local Git destination config changed during inspection. / 核实时本地 Git 目的地配置已变化。');
  }
  return configIdentity;
}
