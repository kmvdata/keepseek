import { canonicalPath } from './pathScope';
import { assertOperationPath } from './protectedTargets';
import { hashApprovalValue } from '../approvalReviewHash';
import * as vscode from 'vscode';
import type { DraftEdit, DraftRun } from '../../shared/types';
import { hashDraftEditAction } from '../approvalReviewHash';
import { inspectDraftRunScope, type CommandScope } from './commandScope';
import { ExactOperationGrants, type OperationIdentity } from './exactOperationGrants';
import { checkDraftRunApprovalIdentity } from './executionBoundary';
import { analyzeCommand } from './commandSemantics';
import type { ApprovalMode } from '../../shared/types';
import type { ApprovalRoute } from '../approvalReviewTypes';

export function draftRunIdentity(run: DraftRun): OperationIdentity {
  return { sessionId: run.sessionId, runId: run.agentRunId, targetId: run.id, kind: 'command', actionHash: run.specHash };
}

/** Shared before approval, before review and immediately before execution.
 * Mode determines the later approver; it never changes these scope requirements. */
export async function inspectAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, mode?: ApprovalMode,
  remoteScope = false): Promise<{
  allowed: boolean;
  route: ApprovalRoute;
  refusal?: { code: 'external_authorization_required' | 'insufficient_launch_evidence' | 'hard_blocked'; reason: string };
  scope: CommandScope;
  authorizedUris: Set<string>;
  reason: string;
}> {
  checkDraftRunApprovalIdentity(run);
  const scope = await inspectDraftRunScope(run, remoteScope);
  checkDraftRunApprovalIdentity(run);
  const allowed = scope.externalUris.length === 0 || grants.matches(draftRunIdentity(run), scope);
  const authorizedUris = new Set(allowed ? scope.externalUris : []);
  // Preserve exact requested cwd spelling only after its canonical scope is granted.
  if (allowed && run.spec.externalCwd && scope.externalUris.length) authorizedUris.add(run.spec.cwdUri);
  const reviewableUncertainty = scope.uncertain && scope.verifiedLauncher && scope.diagnostics.every(item => item.code === 'environment_override')
    && run.spec.env.every(({ name }) => ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'].includes(name));
  const reason = [...scope.externalUris.map(uri => `External path / 外部路径: ${uri}`), ...scope.reasons].join('; ');
  if (mode === 'delegate') {
    const semantics = analyzeCommand(run.spec);
    const git = semantics.program === 'git' && semantics.arguments.find(argument => argument.role === 'subcommand');
    const loopbackProbe = semantics.program === 'curl' && ['-q', '--disable'].includes(run.spec.args[0])
      && run.spec.args.slice(1, -1).every(arg => /^(?:-[fsS]+|--fail|--silent|--show-error)$/u.test(arg))
      && /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?$/iu.test(run.spec.args.at(-1) ?? '');
    const knownRemote = !(remoteScope && semantics.gitRemote) && (semantics.effects.includes('publish_or_deploy')
      || (/^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program) && run.spec.args.includes('publish'))
      || (git && ['push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'submodule'].includes(git.value))
      || (semantics.effects.includes('network') && !semantics.effects.includes('package_install') && !loopbackProbe));
    const packageGlobal = /^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program)
      && run.spec.args.some(arg => /^(?:-[a-z]*g[a-z]*|--global|--location=global)(?:=|$)/u.test(arg) || arg === 'global');
    const pagerCorrection = semantics.gitReplan?.code === 'git_status_pager_override';
    const gitUnverified = git && (!scope.verifiedLauncher || !scope.gitCwd)
      && !pagerCorrection;
    const gitUnbounded = git && !pagerCorrection && (scope.diagnostics.some(item =>
      ['git_configuration', 'external_helper', 'unsupported_pathspec'].includes(item.code)
      || (item.code === 'unsupported_option' && !/^(?:--graph|--all|--first-parent|--no-merges|--merges)$/u.test(item.detail)))
      || (semantics.effects.includes('git_mutation') && !semantics.gitReplan
        && scope.diagnostics.some(item => item.code !== 'git_ref_mutation')));
    const hasIncompleteLaunch = !scope.boundLauncher
      || scope.diagnostics.some(item => ['foreign_path', 'path_resolution'].includes(item.code)
        || (item.code === 'missing_option_value' && !semantics.gitReplan))
      || run.spec.env.some(({ name }) => !/^(?:LANG|LC_ALL|LC_CTYPE|TERM|COLORTERM|CI|NO_COLOR|NODE_ENV|PYTHONDONTWRITEBYTECODE)$/u.test(name));
    const unsupportedRelease = git && ['push', 'ls-remote'].includes(git.value) && !semantics.gitRemote;
    const refusal = unsupportedRelease ? { code: 'hard_blocked' as const,
      reason: 'Automatic Git release requires a bounded ref query or an explicit, non-forced push. / 自动 Git 发布要求范围明确的引用查询，或显式且非强制的引用推送。' }
      : !allowed || knownRemote && !grants.matches(draftRunIdentity(run), scope) ? { code: 'external_authorization_required' as const,
      reason: reason || 'An exact external operation grant is required. / 此操作需要事先精确授权外部目标。' }
      : packageGlobal || gitUnbounded ? { code: 'hard_blocked' as const,
        reason: reason || 'The command would use an unverified repository, configuration or system target. / 命令涉及未经核实的仓库、配置或系统目标。' }
        : gitUnverified || hasIncompleteLaunch ? { code: 'insufficient_launch_evidence' as const,
          reason: reason || 'The exact launch cannot be verified. / 无法核实实际启动配置。' } : undefined;
    return { allowed: !refusal, refusal, route: scope.trustedProjectScript || (!scope.uncertain && !scope.externalUris.length)
      ? 'host_policy' : 'auto_approval_review', scope, authorizedUris, reason };
  }
  const route = scope.trustedProjectScript ? 'host_policy' : scope.uncertain && !reviewableUncertainty ? 'user_click'
    : scope.externalUris.length || reviewableUncertainty ? 'auto_approval_review' : 'host_policy';
  return { allowed, route, scope, authorizedUris,
    reason };
}

export async function assertAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, fingerprint: string, mode?: ApprovalMode): Promise<void> {
  const decision = await inspectAutomaticRunAuthorization(run, grants, mode);
  if (!decision.allowed || decision.scope.fingerprint !== fingerprint) {
    throw new Error('Command scope or launch identity changed. Nothing executed. / 命令范围或启动身份已变化，尚未执行。');
  }
}

/** Edit scope consent uses the existing exact URI contract. Canonical paths,
 * symlinks, base hashes and dirty editors remain enforced by SafeFileEditor. */
export async function inspectAutomaticEditAuthorization(input: { sessionId: string; runId: string; edit: DraftEdit; skillScaffold?: boolean }, grants: ExactOperationGrants) {
  const { edit } = input;
  const identity: OperationIdentity = { sessionId: input.sessionId, runId: input.runId,
    targetId: edit.id, kind: 'edit', actionHash: hashDraftEditAction(edit) };
  const targets = [edit.uri, ...(edit.kind === 'move_v1' ? [edit.targetUri] : [])];
  const resolved = await Promise.all(targets.map(async value => {
    const uri = vscode.Uri.parse(value);
    assertOperationPath(uri.fsPath, true, input.skillScaffold);
    const canonical = uri.scheme === 'file' ? await canonicalPath(uri.fsPath) : uri.path;
    assertOperationPath(canonical, true, input.skillScaffold);
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return { uri: value, canonical, root: folder?.uri.toString() };
  }));
  const scope = { externalUris: resolved.filter(target => !target.root).map(target => target.uri), fingerprint: hashApprovalValue(resolved) };
  return { identity, scope, allowed: !scope.externalUris.length || grants.matches(identity, scope) };
}
