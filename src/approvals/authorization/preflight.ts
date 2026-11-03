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
  scope: CommandScope;
  authorizedUris: Set<string>;
  reason: string;
}> {
  checkDraftRunApprovalIdentity(run);
  const scope = await inspectDraftRunScope(run);
  checkDraftRunApprovalIdentity(run);
  const allowed = (!scope.uncertain && scope.externalUris.length === 0) || grants.matches(draftRunIdentity(run), scope);
  const authorizedUris = new Set(allowed ? scope.externalUris : []);
  // Preserve exact legacy cwd spelling only after its canonical scope is granted.
  if (allowed && run.spec.externalCwd && scope.externalUris.length) authorizedUris.add(run.spec.cwdUri);
  return { allowed, scope, authorizedUris,
    reason: [...scope.externalUris.map(uri => `External path / 外部路径: ${uri}`), ...scope.reasons].join('; ') };
}

export async function assertAutomaticRunAuthorization(run: DraftRun, grants: ExactOperationGrants): Promise<void> {
  const decision = await inspectAutomaticRunAuthorization(run, grants);
  if (!decision.allowed) throw new Error(decision.reason);
}

/** Edit scope consent uses the existing exact URI contract. Canonical paths,
 * symlinks, base hashes and dirty editors remain enforced by SafeFileEditor. */
export function inspectAutomaticEditAuthorization(input: { sessionId: string; runId: string; edit: DraftEdit }, grants: ExactOperationGrants) {
  const { edit } = input;
  const identity: OperationIdentity = { sessionId: input.sessionId, runId: input.runId,
    targetId: edit.id, kind: 'edit', actionHash: hashDraftEditAction(edit) };
  const scope = { externalUris: [edit.uri, ...(edit.kind === 'move_v1' ? [edit.targetUri] : [])]
    .filter(uri => !vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(uri))) };
  return { identity, scope, allowed: !scope.externalUris.length || grants.matches(identity, scope) };
}
