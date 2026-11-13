import { KEEPSEEK_CONFIGURATION_NAMESPACE } from '../shared/identity';
import { realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { MAX_APPROVAL_TARGETS } from '../approvals/approvalReviewTypes';
import { isGitReleaseRef, type GitRemoteCommand } from '../approvals/authorization/commandSemantics';
import { resolveExecutable, type CommandScope } from '../approvals/authorization/commandScope';
import { inspectLocalGitScope } from '../approvals/authorization/localGitScope';
import { resolveSelectedProjectRoot } from '../approvals/authorization/pathScope';
import { createControlledEnvironment } from './executionEnvironment';
import { inspectGitObjectDirectory } from './gitTransportEnvironment';
import { taskNamesGitRef, type GitReleaseIntent, type TaskGitPushDestination } from './gitTaskIntent';

export interface GitReleaseGrant {
  repository: string;
  destination: string;
  read: string[];
  push: string[];
  rewrite?: string[];
  credentialEnvironment?: string;
  credentialUsername?: string;
}

export interface GitRemoteLaunch {
  executable: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  destination: string;
  destinationHash: string;
  gitRemote: GitRemoteCommand;
  fingerprint: string;
  args: string[];
  sourceRefs: ReadonlyArray<{ ref: string; object: string }>;
  authorization: 'task' | 'configured' | 'one_shot';
  gitObjectDirectory?: string;
  gitObjectIdentity?: string;
}

const credentialIdentityKey = randomBytes(32);

function isRefPrefix(value: string): boolean {
  return /^refs\/(?:heads|tags)\/.+\*$/u.test(value) && isGitReleaseRef(value.slice(0, -1) + 'x');
}

function isGrant(value: unknown): value is GitReleaseGrant {
  if (!value || typeof value !== 'object') return false;
  const { repository, destination, read, push, rewrite, credentialEnvironment, credentialUsername } = value as Partial<GitReleaseGrant>;
  return typeof repository === 'string' && path.isAbsolute(repository)
    && typeof destination === 'string' && Boolean(destination)
    && Array.isArray(read) && read.every(ref => typeof ref === 'string' && (isGitReleaseRef(ref) || ['refs/heads/*', 'refs/tags/*'].includes(ref)))
    && Array.isArray(push) && push.every(ref => typeof ref === 'string' && (isGitReleaseRef(ref) || isRefPrefix(ref)))
    && (rewrite === undefined || Array.isArray(rewrite) && rewrite.every(ref => typeof ref === 'string'
      && ref.startsWith('refs/heads/') && isGitReleaseRef(ref)))
    && (credentialEnvironment === undefined || typeof credentialEnvironment === 'string' && /^[A-Z_][A-Z0-9_]{0,127}$/u.test(credentialEnvironment))
    && (credentialUsername === undefined || typeof credentialUsername === 'string' && /^[a-zA-Z0-9._@+-]{1,128}$/u.test(credentialUsername));
}

function configuredGrants(): GitReleaseGrant[] {
  const setting = vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE).inspect?.<unknown>('gitReleaseGrants')?.globalValue;
  return Array.isArray(setting) ? setting.filter(isGrant) : [];
}

/** Capture the task's configured destination before the primary model can
 * propose changes. This reads local metadata without credentials or network. */
export async function snapshotProjectGitPushDestination(projectUri: string | undefined,
  intent: GitReleaseIntent): Promise<TaskGitPushDestination | undefined> {
  if (!vscode.workspace.isTrusted || !intent.push) return undefined;
  try {
    const root = await resolveSelectedProjectRoot(projectUri);
    if (!root) return undefined;
    const env = createControlledEnvironment([]);
    const git = await resolveExecutable('git', root, env);
    if (!git?.trusted) return undefined;
    const scope = await inspectLocalGitScope({ executable: git.path, cwd: root, roots: [root], cwdChanges: [],
      subcommand: 'push', remoteMetadataOnly: true, remoteTargetOnly: true, env,
      remote: { kind: 'push', currentBranch: true, remote: intent.remoteDestination ?? intent.remoteAlias ?? '', refs: [] } });
    if ('reason' in scope || !scope.remote || !vscode.workspace.isTrusted) return undefined;
    return { repository: scope.repository, destination: scope.remote.destination, remote: scope.remote.command.remote };
  } catch { return undefined; }
}

/** Ignore repository/workspace settings. The publisher scope is user-owned
 * and machine-local. A grant always binds the real repository and endpoint. */
export async function authorizeGitRemote(scope: CommandScope, proposed: GitRemoteCommand,
  intent: GitReleaseIntent, branchRef?: string | null, oneShot?: GitReleaseGrant,
  taskDestination?: TaskGitPushDestination): Promise<GitRemoteLaunch | undefined> {
  const target = scope.gitRemote;
  const repository = scope.paths.find(item => item.role === 'repository' && !item.external);
  if (!target || !repository || !scope.executable || !scope.gitCwd || scope.uncertain || scope.externalUris.length) {
    throw new Error(scope.reasons.join(' · ') || 'Git transport launch could not be verified. / 无法核实 Git 传输的启动范围。');
  }
  const repositoryPath = vscode.Uri.parse(repository.uri).fsPath;
  const command = target.command;
  if (command.kind !== proposed.kind || proposed.remote && command.remote !== proposed.remote
    || !(proposed.kind === 'push' && (proposed.currentBranch || proposed.shortRef))
      && JSON.stringify(command.refs) !== JSON.stringify(proposed.refs)) {
    throw new Error('The verified Git operation differs from the command proposal. / 已核验 Git 操作与命令草稿不一致。');
  }
  const configured = configuredGrants();
  const grants = oneShot ? [oneShot] : configured;
  const refs = command.kind === 'query' && !command.refs.length ? ['refs/' + command.namespace + '/*'] : command.refs;
  // Exact authorization displays the repository and destination alongside the refs.
  const maxRefs = MAX_APPROVAL_TARGETS - 2;
  if (refs.length > maxRefs) throw new Error(`Git transport approval supports at most ${maxRefs} refs per operation. / Git 传输审批每次操作最多支持 ${maxRefs} 个引用。`);
  const taskBranch = branchRef ?? scope.gitBranchRef;
  const taskAllowsPush = (ref: string) => {
    const exact = intent.pushTargets;
    if (exact) {
      const name = ref.split('/').slice(2).join('/');
      return exact.shortRefs.has(name) || (ref.startsWith('refs/tags/') ? exact.tags.has(name)
        : exact.branches.has(name) || exact.currentBranch && ref === taskBranch);
    }
    return ref.startsWith('refs/tags/') ? taskNamesGitRef(intent, ref)
      : intent.branch && (intent.currentBranch && ref === taskBranch || taskNamesGitRef(intent, ref));
  };
  const readAllowed = (grant: GitReleaseGrant, ref: string) => grant.read.includes(ref)
    || (!ref.endsWith('/*') && grant.read.includes(ref.slice(0, ref.indexOf('/', 5) + 1) + '*'));
  const pushAllowed = (grant: GitReleaseGrant, ref: string) => grant.push.some(value =>
    value === ref || (isRefPrefix(value) && ref.startsWith(value.slice(0, -1))));
  const lease = command.kind === 'push' ? command.lease : undefined;
  const captured = taskDestination?.repository === repositoryPath ? taskDestination : undefined;
  const taskAliasMatches = !intent.remoteAlias || intent.remoteAlias === command.remote
    || intent.remoteAlias === captured?.remote && captured.destination === target.destination;
  const exactTaskDestination = intent.remoteDestination ?? captured?.destination;
  const matchesRequestedDestination = taskAliasMatches && (!exactTaskDestination || exactTaskDestination === target.destination);
  if (command.kind === 'push') {
    if (intent.pushProhibited || lease && intent.rewriteProhibited) {
      throw new Error('The current task prohibits this Git push. / 当前任务明确禁止此 Git 推送。');
    }
    if (!matchesRequestedDestination || taskDestination && !captured) {
      throw new Error('The Git push differs from the task destination. / Git 推送目的地与当前任务不一致。');
    }
    if (intent.pushTargets && !refs.every(taskAllowsPush)) {
      throw new Error('The Git push includes a ref outside the current task. / Git 推送包含当前任务范围以外的引用。');
    }
    if (intent.requestedLease && (lease?.ref !== intent.requestedLease.ref || lease.expected !== intent.requestedLease.expected)) {
      throw new Error('The Git push differs from the task lease. / Git 推送的租约与当前任务不一致。');
    }
  }
  if (!oneShot && (command.kind === 'query'
    ? !intent.query || !taskAliasMatches || intent.remoteDestination && intent.remoteDestination !== target.destination
    : !intent.push)) return undefined;
  const taskAuthorized = !oneShot && exactTaskDestination === target.destination && (command.kind === 'query'
    || refs.every(taskAllowsPush) && (!lease || intent.rewrite === true));
  const coversRefs = (grant: GitReleaseGrant) => grant.repository === repositoryPath
    && refs.every(ref => readAllowed(grant, ref) && (command.kind === 'query' || pushAllowed(grant, ref)))
    && (!lease || grant === oneShot || intent.rewrite || grant.rewrite?.includes(lease.ref));
  const destinations = new Set(grants.filter(coversRefs).map(grant => grant.destination));
  if (!taskAuthorized && (!destinations.has(target.destination) || !oneShot && !intent.remoteAlias && destinations.size > 1)) return undefined;
  const authorization = oneShot ? 'one_shot' : taskAuthorized ? 'task' : 'configured';

  const env: NodeJS.ProcessEnv = { ...scope.environment, GIT_ALLOW_PROTOCOL: target.protocol, GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_CONFIG_NOSYSTEM: '1', LC_ALL: 'C' };
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
  } else if (target.protocol === 'https') {
    const configurations = new Map(configured.filter(grant => grant.destination === target.destination
      && coversRefs(grant) && grant.credentialEnvironment).map(grant => [
      JSON.stringify([grant.credentialEnvironment, grant.credentialUsername ?? 'x-access-token']), grant
    ]));
    if (configurations.size > 1) {
      throw new Error('More than one HTTPS Git credential is configured for this exact destination. / 当前 Git 目的地配置了多个 HTTPS 凭据。');
    }
    const credential = [...configurations.values()][0];
    const settings: Array<[string, string]> = [['http.followRedirects', 'false'], ['http.sslVerify', 'true']];
    if (credential?.credentialEnvironment) {
      const token = process.env[credential.credentialEnvironment];
      if (!token || token.length > 8_192 || /[\p{Cc}]/u.test(token)) {
        throw new Error('The configured HTTPS Git credential is unavailable. / 配置的 HTTPS Git 凭据不可用。');
      }
      const name = credential.credentialUsername ?? 'x-access-token';
      const value = Buffer.from(name + ':' + token).toString('base64');
      settings.push([`http.${target.destination}.extraHeader`, 'Authorization: Basic ' + value]);
      transportIdentity = createHmac('sha256', credentialIdentityKey).update(JSON.stringify([credential.credentialEnvironment, name, token])).digest('hex');
    }
    env.GIT_CONFIG_COUNT = String(settings.length);
    settings.forEach(([key, value], index) => {
      env['GIT_CONFIG_KEY_' + index] = key;
      env['GIT_CONFIG_VALUE_' + index] = value;
    });
  } else {
    Object.assign(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'receive.autogc', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'maintenance.auto', GIT_CONFIG_VALUE_1: 'false' });
  }
  const objects = command.kind === 'push' ? await inspectGitObjectDirectory(repositoryPath) : undefined;
  const args = ['--no-pager', '--no-optional-locks', '--no-replace-objects'];
  if (command.kind === 'query') {
    args.push('ls-remote', ...(command.namespace === 'tags' ? ['--tags'] : command.namespace === 'heads' ? ['--heads'] : []),
      '--', target.destination, ...command.refs);
  } else {
    args.push('push', ...(command.atomic ? ['--atomic'] : []),
      ...(lease ? [`--force-with-lease=${lease.ref}:${lease.expected}`] : []), '--', target.destination,
      ...target.sourceRefs.map(({ object, ref }) => `${object}:${ref}`));
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([scope.fingerprint, target, transportIdentity, objects, args, authorization])).digest('hex');
  return { executable: scope.executable, cwd: vscode.Uri.parse(scope.gitCwd).fsPath, env, args, authorization,
    gitRemote: command, sourceRefs: target.sourceRefs, destination: target.destination,
    gitObjectDirectory: objects?.directory, gitObjectIdentity: objects?.identity,
    destinationHash: createHash('sha256').update(JSON.stringify([target.destination, target.protocol, target.identity])).digest('hex'), fingerprint };
}
