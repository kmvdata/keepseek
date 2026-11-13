import * as vscode from 'vscode';
import type { ApprovalMode, DraftEdit, DraftRun } from '../../shared/types';
import { hashApprovalValue, hashDraftEditAction } from '../approvalReviewHash';
import { inspectDraftRunScope, type CommandRemoteInspection, type CommandScope } from './commandScope';
import { ExactOperationGrants, type OperationIdentity } from './exactOperationGrants';
import { checkDraftRunApprovalIdentity, getDraftRunLaunchRefusal } from './executionBoundary';
import { analyzeCommand } from './commandSemantics';
import { assertCleanDraftEditTarget, inspectDraftEditTarget } from './editTargets';
import { isPathInside, resolveSelectedProjectRoot } from './pathScope';

interface RunAuthorizationRefusal {
  code: 'external_authorization_required' | 'insufficient_launch_evidence' | 'hard_blocked';
  reason: string;
}

export function draftRunIdentity(run: DraftRun): OperationIdentity {
  return { sessionId: run.sessionId, runId: run.agentRunId, targetId: run.id, kind: 'command', actionHash: run.specHash };
}

/** Inspect the exact operation before either approver and again before execution.
 * The scope alone can describe missing consent, never grant it. */
export async function inspectAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, mode?: ApprovalMode,
  remoteScope: CommandRemoteInspection = false, selectedProjectUri?: string) {
  checkDraftRunApprovalIdentity(run);
  const scope = await inspectDraftRunScope(run, remoteScope, undefined, mode === 'delegate', selectedProjectUri, mode);
  return evaluateAutomaticRunAuthorization(run, grants, mode, remoteScope, scope);
}

/** A scope snapshot belongs to one preflight phase. Callers must inspect again
 * after crossing a model, user, audit consumption or dispatch boundary. */
export function evaluateAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, mode: ApprovalMode | undefined,
  remoteScope: CommandRemoteInspection, scope: CommandScope): {
  allowed: boolean;
  reviewable: boolean;
  requiresExactGrant: boolean;
  requiresNetworkGrant: boolean;
  refusal?: RunAuthorizationRefusal;
  scope: CommandScope;
  scopeUris: Set<string>;
  authorizedUris: Set<string>;
  reason: string;
} {
  checkDraftRunApprovalIdentity(run);
  const reason = [...scope.externalUris.map(uri => `External path / 外部路径: ${uri}`), ...scope.reasons].join('; ');
  const semantics = scope.semantics ?? analyzeCommand(run.spec);
  const scopeUris = new Set(scope.externalUris);
  if (run.spec.externalCwd && scope.externalUris.length) scopeUris.add(run.spec.cwdUri);
  const requiresNetworkGrant = mode === 'delegate' && needsExactNetworkGrant(run, semantics, remoteScope);
  const requiresExactGrant = scopeUris.size > 0 || requiresNetworkGrant;
  const grantMissing = requiresExactGrant && !grants.matches(draftRunIdentity(run), scope);
  const launchRefusal = getDraftRunLaunchRefusal(scope);
  const ineligible = launchRefusal ? { code: 'insufficient_launch_evidence' as const, reason: launchRefusal }
    : mode === 'delegate' ? inspectDelegatedRunEligibility(run, scope, semantics, reason) : undefined;
  const refusal = ineligible ?? (grantMissing ? {
    code: 'external_authorization_required' as const,
    reason: reason || 'An exact external operation grant is required. / 此操作需要事先精确授权外部目标。'
  } : undefined);
  return { allowed: !refusal, reviewable: !ineligible, requiresExactGrant, requiresNetworkGrant, refusal, scope, scopeUris,
    authorizedUris: refusal ? new Set() : scopeUris, reason };
}

function needsExactNetworkGrant(run: DraftRun, semantics: ReturnType<typeof analyzeCommand>, remoteScope: CommandRemoteInspection): boolean {
  if (remoteScope && semantics.gitRemote) return false; // The Git transport/ref boundary has its own exact grant.
  const subcommand = semantics.arguments.find(argument => argument.role === 'subcommand')?.value;
  const loopbackProbe = semantics.program === 'curl' && ['-q', '--disable'].includes(run.spec.args[0])
    && run.spec.args.slice(1, -1).every(arg => /^(?:-[fsS]+|--fail|--silent|--show-error)$/u.test(arg))
    && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?$/iu.test(run.spec.args.at(-1) ?? '');
  return semantics.effects.includes('publish_or_deploy')
    || (!semantics.projectPackageScript && !semantics.projectScript
      && /^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program) && run.spec.args.includes('publish'))
    || (semantics.program === 'git' && ['push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'submodule'].includes(subcommand ?? ''))
    || (!loopbackProbe && (Boolean(semantics.networkTargets?.length)
      || semantics.effects.includes('network') && !semantics.effects.includes('package_install')));
}

function inspectDelegatedRunEligibility(run: DraftRun, scope: CommandScope, semantics: ReturnType<typeof analyzeCommand>,
  reason: string): RunAuthorizationRefusal | undefined {
  const git = semantics.program === 'git' && semantics.arguments.find(argument => argument.role === 'subcommand');
  if (git && ['push', 'ls-remote'].includes(git.value) && !semantics.gitRemote) {
    return { code: 'hard_blocked',
      reason: 'Controlled Git transport needs one verified destination and bounded refs. For a rewrite, provide a single explicit --force-with-lease=<ref>:<expected>. / 受控 Git 传输需要唯一可核验的目的地和明确的引用范围。改写时请为单个分支提供 --force-with-lease=<ref>:<expected>。' };
  }
  const packageGlobal = !semantics.projectPackageScript && !semantics.projectScript && /^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program)
    && run.spec.args.some(arg => /^(?:-[a-z]*g[a-z]*|--global|--location=global)(?:=|$)/u.test(arg) || arg === 'global');
  if (packageGlobal) return { code: 'hard_blocked',
    reason: 'A global package installation is outside the project. / 全局软件包安装超出当前工程范围。' };
  if (semantics.gitRemote) {
    if (!scope.verifiedLauncher || !scope.gitCwd || !scope.gitRemote || scope.uncertain) return { code: 'insufficient_launch_evidence',
      reason: reason || 'The exact Git transport could not be verified. / 无法核实 Git 实际传输范围。' };
    return undefined;
  }
  if (!run.spec.restricted && !scope.projectExecution) return { code: 'insufficient_launch_evidence',
    reason: scope.projectExecutionUnavailable ?? 'The project execution boundary is missing. / 缺少工程执行边界。' };
  if (scope.projectExecution?.kind === 'host' && git) {
    const exactStatusPager = semantics.gitReplan?.code === 'git_status_pager_override';
    if (scope.diagnostics.some(item => ['external_helper', 'unsupported_pathspec'].includes(item.code)
      || item.code === 'git_configuration' && !exactStatusPager)) {
      return { code: 'hard_blocked', reason: reason
        || 'This Git command needs an isolated execution profile. / 此 Git 命令需要隔离执行环境。' };
    }
    const readsRepository = semantics.gitLocalQuery || ['show', 'diff', 'log', 'status', 'ls-files'].includes(git.value);
    const noIndex = git.value === 'diff' && semantics.arguments.some(item => item.role === 'option' && item.value === '--no-index');
    if (readsRepository && !noIndex && !scope.gitCwd) return { code: 'insufficient_launch_evidence', reason: reason
      || 'The exact Git repository could not be verified. / 无法核实 Git 仓库。' };
  }
  if (scope.projectExecution && scope.projectExecution.kind !== 'host'
    && (needsExactNetworkGrant(run, semantics, false) || semantics.effects.includes('package_install') && semantics.networkTargets?.length)) {
    return { code: 'insufficient_launch_evidence',
      reason: 'This project command has no network access in its execution profile. Use a verified remote operation for publishing. / 当前执行环境中的工程命令没有网络权限。发布操作请使用可核实的远端操作。' };
  }
  return undefined;
}

export async function assertAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, fingerprint: string,
  mode?: ApprovalMode, remoteScope: CommandRemoteInspection = false, selectedProjectUri?: string): Promise<void> {
  const decision = await inspectAutomaticRunAuthorization(run, grants, mode, remoteScope, selectedProjectUri);
  if (!decision.allowed || decision.scope.fingerprint !== fingerprint) {
    throw new Error('Command scope or launch identity changed. Nothing executed. / 命令范围或启动身份已变化，尚未执行。');
  }
}

/** Edit scope consent uses the existing exact URI contract. Canonical paths,
 * symlinks, base hashes and dirty editors remain enforced by SafeFileEditor. */
export async function inspectAutomaticEditAuthorization(input: { sessionId: string; runId: string; edit: DraftEdit; skillScaffold?: boolean },
  grants: ExactOperationGrants, selectedProjectUri?: string) {
  if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
  const { edit } = input;
  const identity: OperationIdentity = { sessionId: input.sessionId, runId: input.runId,
    targetId: edit.id, kind: 'edit', actionHash: hashDraftEditAction(edit) };
  const source = vscode.Uri.parse(edit.uri);
  const scaffold = input.skillScaffold === true && edit.kind === 'full_text_v1' && edit.action === 'create'
    && !!vscode.workspace.getWorkspaceFolder(source);
  const targets = [{ value: edit.uri, uri: source, create: edit.action === 'create', scaffold },
    ...(edit.kind === 'move_v1' ? [{ value: edit.targetUri, uri: vscode.Uri.parse(edit.targetUri), create: true, scaffold: false }] : [])];
  const resolved = await Promise.all(targets.map(async ({ value, uri, create, scaffold: allowScaffold }) => {
    const metadata = await inspectDraftEditTarget(uri, create, allowScaffold);
    assertCleanDraftEditTarget(uri, 'DraftEdit targets a dirty editor. Nothing executed. / 草稿编辑涉及未保存的编辑器，尚未执行。', metadata.canonical);
    if (create && metadata.fileIdentity) throw new Error('DraftEdit creation target already exists. / 草稿编辑的创建目标已存在。');
    return { ...metadata, uri: value, local: uri.scheme === 'file' };
  }));
  const selectedRoot = await resolveSelectedProjectRoot(selectedProjectUri);
  if (selectedProjectUri && !selectedRoot) throw new Error('Selected project scope is unavailable. / 无法核实选定的项目范围。');
  if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
  const inSelectedProject = (target: typeof resolved[number]) => target.local && Boolean(target.root && selectedRoot
    && isPathInside(selectedRoot, target.canonical));
  const externalUris = resolved.filter(target => !target.root || (selectedProjectUri && !inSelectedProject(target))).map(target => target.uri);
  const scope = { externalUris, fingerprint: hashApprovalValue({ selectedRoot, targets: resolved }) };
  const canonicalTargets = resolved.map(target => target.local ? vscode.Uri.file(target.canonical).toString() : target.uri);
  return { identity, scope, canonicalTargets, verifiedProjectOperation: resolved.every(inSelectedProject),
    allowed: !scope.externalUris.length || grants.matches(identity, scope) };
}
