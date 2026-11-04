import { canonicalPath } from './pathScope';
import { assertOperationPath } from './protectedTargets';
import { hashApprovalValue } from '../approvalReviewHash';
import * as vscode from 'vscode';
import type { DraftEdit, DraftRun } from '../../shared/types';
import { hashDraftEditAction } from '../approvalReviewHash';
import { inspectDraftRunScope, type CommandScope } from './commandScope';
import { ExactOperationGrants, type OperationIdentity } from './exactOperationGrants';
import { checkDraftRunApprovalIdentity } from './executionBoundary';

export function draftRunIdentity(run: DraftRun): OperationIdentity {
  return { sessionId: run.sessionId, runId: run.agentRunId, targetId: run.id, kind: 'command', actionHash: run.specHash };
}

/** Shared by delegate/model_review, before review and immediately before execution.
 * Mode determines the later approver; it never changes these scope requirements. */
export async function inspectAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants): Promise<{
  allowed: boolean;
  route: 'host_policy' | 'model_review' | 'user_click';
  scope: CommandScope;
  authorizedUris: Set<string>;
  reason: string;
}> {
  checkDraftRunApprovalIdentity(run);
  const scope = await inspectDraftRunScope(run);
  checkDraftRunApprovalIdentity(run);
  const allowed = scope.externalUris.length === 0 || grants.matches(draftRunIdentity(run), scope);
  const authorizedUris = new Set(allowed ? scope.externalUris : []);
  // Preserve exact legacy cwd spelling only after its canonical scope is granted.
  if (allowed && run.spec.externalCwd && scope.externalUris.length) authorizedUris.add(run.spec.cwdUri);
  const reviewableUncertainty = scope.uncertain && scope.diagnostics.every(item => item.code === 'environment_override')
    && run.spec.env.every(({ name }) => ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM'].includes(name));
  const route = scope.uncertain && !reviewableUncertainty ? 'user_click'
    : scope.externalUris.length || reviewableUncertainty ? 'model_review' : 'host_policy';
  return { allowed, route, scope, authorizedUris,
    reason: [...scope.externalUris.map(uri => `External path / 外部路径: ${uri}`), ...scope.reasons].join('; ') };
}

export async function assertAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants, fingerprint: string): Promise<void> {
  const decision = await inspectAutomaticRunAuthorization(run, grants);
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
