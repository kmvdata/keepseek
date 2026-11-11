import * as vscode from 'vscode';
import type { ApprovalMode, DraftEdit, DraftRun } from '../../shared/types';
import { hashApprovalValue, hashDraftEditAction } from '../approvalReviewHash';
import { inspectDraftRunScope, type CommandRemoteInspection, type CommandScope } from './commandScope';
import { ExactOperationGrants, type OperationIdentity } from './exactOperationGrants';
import { checkDraftRunApprovalIdentity } from './executionBoundary';
import { analyzeCommand } from './commandSemantics';
import { assertCleanDraftEditTarget, inspectDraftEditTarget } from './editTargets';

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
  remoteScope: CommandRemoteInspection = false): Promise<{
  allowed: boolean;
  reviewable: boolean;
  requiresExactGrant: boolean;
  requiresNetworkGrant: boolean;
  refusal?: RunAuthorizationRefusal;
  scope: CommandScope;
  scopeUris: Set<string>;
  authorizedUris: Set<string>;
  reason: string;
}> {
  checkDraftRunApprovalIdentity(run);
  const scope = await inspectDraftRunScope(run, remoteScope, undefined, mode === 'delegate');
  checkDraftRunApprovalIdentity(run);
  const reason = [...scope.externalUris.map(uri => `External path / 外部路径: ${uri}`), ...scope.reasons].join('; ');
  const semantics = analyzeCommand(run.spec);
  const scopeUris = new Set(scope.externalUris);
  if (run.spec.externalCwd && scope.externalUris.length) scopeUris.add(run.spec.cwdUri);
  const requiresNetworkGrant = mode === 'delegate' && needsExactNetworkGrant(run, semantics, remoteScope);
  const requiresExactGrant = scopeUris.size > 0 || requiresNetworkGrant;
  const grantMissing = requiresExactGrant && !grants.matches(draftRunIdentity(run), scope);
  const ineligible = mode === 'delegate' ? inspectDelegatedRunEligibility(run, scope, semantics, reason) : undefined;
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
    || (/^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program) && run.spec.args.includes('publish'))
    || (semantics.program === 'git' && ['push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'submodule'].includes(subcommand ?? ''))
    || (semantics.effects.includes('network') && !semantics.effects.includes('package_install') && !loopbackProbe);
}

function inspectDelegatedRunEligibility(run: DraftRun, scope: CommandScope, semantics: ReturnType<typeof analyzeCommand>,
  reason: string): RunAuthorizationRefusal | undefined {
  const git = semantics.program === 'git' && semantics.arguments.find(argument => argument.role === 'subcommand');
  if (git && ['push', 'ls-remote'].includes(git.value) && !semantics.gitRemote) {
    return { code: 'hard_blocked',
      reason: 'Automatic Git release requires a bounded ref query or an explicit, non-forced push. / 自动 Git 发布要求范围明确的引用查询，或显式且非强制的引用推送。' };
  }
  const packageGlobal = /^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program)
    && run.spec.args.some(arg => /^(?:-[a-z]*g[a-z]*|--global|--location=global)(?:=|$)/u.test(arg) || arg === 'global');
  const pagerCorrection = semantics.gitReplan?.code === 'git_status_pager_override';
  const gitUnbounded = git && !pagerCorrection && (scope.diagnostics.some(item =>
    ['git_configuration', 'external_helper', 'unsupported_pathspec'].includes(item.code)
    || (item.code === 'unsupported_option' && !/^(?:--graph|--all|--first-parent|--no-merges|--merges)$/u.test(item.detail)))
    || (semantics.effects.includes('git_mutation') && !semantics.gitReplan
      && scope.diagnostics.some(item => item.code !== 'git_ref_mutation')));
  if (packageGlobal || gitUnbounded) return { code: 'hard_blocked',
    reason: reason || 'The command would use an unverified repository, configuration or system target. / 命令涉及未经核实的仓库、配置或系统目标。' };
  const gitUnverified = git && (!scope.verifiedLauncher || !scope.gitCwd) && !pagerCorrection;
  const hasIncompleteLaunch = !scope.boundLauncher
    || scope.diagnostics.some(item => ['foreign_path', 'path_resolution'].includes(item.code)
      || (item.code === 'missing_option_value' && !semantics.gitReplan))
    || run.spec.env.some(({ name }) => !/^(?:LANG|LC_ALL|LC_CTYPE|TERM|COLORTERM|CI|NO_COLOR|NODE_ENV|PYTHONDONTWRITEBYTECODE)$/u.test(name));
  if (gitUnverified || hasIncompleteLaunch) return { code: 'insufficient_launch_evidence',
    reason: reason || 'The exact launch cannot be verified. / 无法核实实际启动配置。' };
  return undefined;
}

export async function assertAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, fingerprint: string,
  mode?: ApprovalMode, remoteScope = false): Promise<void> {
  const decision = await inspectAutomaticRunAuthorization(run, grants, mode, remoteScope);
  if (!decision.allowed || decision.scope.fingerprint !== fingerprint) {
    throw new Error('Command scope or launch identity changed. Nothing executed. / 命令范围或启动身份已变化，尚未执行。');
  }
}

/** Edit scope consent uses the existing exact URI contract. Canonical paths,
 * symlinks, base hashes and dirty editors remain enforced by SafeFileEditor. */
export async function inspectAutomaticEditAuthorization(input: { sessionId: string; runId: string; edit: DraftEdit; skillScaffold?: boolean }, grants: ExactOperationGrants) {
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
    return { ...metadata, uri: value };
  }));
  if (!vscode.workspace.isTrusted) throw new Error('DraftEdit requires a trusted workspace.');
  const scope = { externalUris: resolved.filter(target => !target.root).map(target => target.uri), fingerprint: hashApprovalValue(resolved) };
  return { identity, scope, allowed: !scope.externalUris.length || grants.matches(identity, scope) };
}
