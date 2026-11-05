import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { isGitReleaseRef, type GitRemoteCommand } from '../approvals/authorization/commandSemantics';
import { resolveExecutable, type CommandScope } from '../approvals/authorization/commandScope';
import type { GitReleaseIntent } from './gitTaskIntent';
import { taskNamesGitRef } from './gitTaskIntent';

export interface GitReleaseGrant {
  repository: string;
  destination: string;
  read: string[];
  push: string[];
}

export interface GitRemoteLaunch {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  destination: string;
  destinationHash: string;
  gitRemote: GitRemoteCommand;
  fingerprint: string;
}

function isTagPrefix(value: string): boolean {
  return value.startsWith('refs/tags/') && value.length > 'refs/tags/*'.length && value.endsWith('*') && isGitReleaseRef(value.slice(0, -1) + 'x');
}

function isGrant(value: unknown): value is GitReleaseGrant {
  if (!value || typeof value !== 'object') return false;
  const { repository, destination, read, push } = value as Partial<GitReleaseGrant>;
  return typeof repository === 'string' && path.isAbsolute(repository)
    && typeof destination === 'string' && Boolean(destination)
    && Array.isArray(read) && read.every(ref => typeof ref === 'string' && (isGitReleaseRef(ref) || ['refs/heads/*', 'refs/tags/*'].includes(ref)))
    && Array.isArray(push) && push.every(ref => typeof ref === 'string' && (isGitReleaseRef(ref) || isTagPrefix(ref)));
}

function configuredGrants(): GitReleaseGrant[] {
  const setting = vscode.workspace.getConfiguration('keepseek').inspect?.<unknown>('gitReleaseGrants')?.globalValue;
  return Array.isArray(setting) ? setting.filter(isGrant) : [];
}

export function hasGitReleaseGrants(): boolean {
  return configuredGrants().length > 0;
}

/** Ignore repository/workspace settings. The publisher scope is user-owned
 * and machine-local. A grant always binds the real repository and endpoint. */
export async function authorizeGitRemote(scope: CommandScope, command: GitRemoteCommand,
  intent: GitReleaseIntent, branchRef?: string | null, oneShot?: GitReleaseGrant): Promise<GitRemoteLaunch | undefined> {
  const target = scope.gitRemote;
  const repository = scope.paths.find(item => item.role === 'repository' && !item.external);
  if (!target || !repository || !scope.executable || !scope.gitCwd || scope.uncertain || scope.externalUris.length) {
    throw new Error(scope.reasons.join(' · ') || 'Git transport launch could not be verified. / 无法核实 Git 传输的启动范围。');
  }
  const repositoryPath = vscode.Uri.parse(repository.uri).fsPath;
  const grants = oneShot ? [oneShot] : configuredGrants();
  const refs = command.kind === 'query' && !command.refs.length ? ['refs/' + command.namespace + '/*'] : command.refs;
  const taskAllowsPush = (ref: string) => ref.startsWith('refs/tags/')
    ? taskNamesGitRef(intent, ref)
    : intent.branch && ((intent.currentBranch && ref === (branchRef ?? scope.gitBranchRef)) || taskNamesGitRef(intent, ref));
  const readAllowed = (grant: GitReleaseGrant, ref: string) => grant.read.includes(ref)
    || (!ref.endsWith('/*') && grant.read.includes(ref.slice(0, ref.indexOf('/', 5) + 1) + '*'));
  if (!oneShot && (intent.remoteAlias && intent.remoteAlias !== command.remote
    || (command.kind === 'query' ? !intent.query : !intent.push || !refs.every(taskAllowsPush)))) return undefined;
  const pushAllowed = (grant: GitReleaseGrant, ref: string) => grant.push.some(value =>
    value === ref || (isTagPrefix(value) && ref.startsWith(value.slice(0, -1))));
  const destinations = new Set(grants.filter(grant => grant.repository === repositoryPath
    && refs.every(ref => readAllowed(grant, ref) && (command.kind === 'query' || pushAllowed(grant, ref)))).map(grant => grant.destination));
  if (!destinations.has(target.destination) || !intent.remoteAlias && destinations.size > 1) return undefined;

  const env: NodeJS.ProcessEnv = { ...scope.environment, GIT_ALLOW_PROTOCOL: target.protocol, GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
  // Resolve Git's native helpers from installed locations, never a workspace PATH shim.
  env.PATH = [path.dirname(scope.executable), ...(process.platform === 'win32' ? [] : ['/usr/bin', '/bin'])].join(path.delimiter);
  let transportIdentity: unknown;
  if (target.protocol === 'ssh') {
    if (process.platform === 'win32') {
      throw new Error('Controlled SSH is unavailable on this extension host. / 此扩展宿主暂不支持受控 SSH。');
    }
    const ssh = await resolveExecutable('/usr/bin/ssh', repositoryPath, env);
    if (!ssh?.trusted) throw new Error('The system SSH launcher is unavailable. / 系统 SSH 启动程序不可用。');
    const socket = process.env.SSH_AUTH_SOCK;
    const resolved = socket && path.isAbsolute(socket) ? await realpath(socket).catch(() => undefined) : undefined;
    const info = resolved ? await stat(resolved).catch(() => undefined) : undefined;
    if (resolved && info?.isSocket() && info.uid === process.getuid?.()) Object.assign(env, { SSH_AUTH_SOCK: resolved });
    // Ignore user and system SSH routing directives (ProxyCommand, HostName,
    // includes). Default keys, known hosts and the validated agent still work.
    Object.assign(env, {
      GIT_SSH_VARIANT: 'ssh',
      GIT_SSH_COMMAND: '/usr/bin/ssh -F /dev/null -oBatchMode=yes -oStrictHostKeyChecking=yes -oClearAllForwardings=yes'
    });
    transportIdentity = [ssh.identity, resolved, info?.dev, info?.ino];
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([scope.fingerprint, target, transportIdentity, refs])).digest('hex');
  return { executable: scope.executable, cwd: vscode.Uri.parse(scope.cwd).fsPath, env,
    gitRemote: command, destination: target.destination, destinationHash: createHash('sha256').update(JSON.stringify([target.destination, target.protocol, target.identity])).digest('hex'), fingerprint };
}
