import { analyzeCommandCapability, type CommandCapabilityDiagnostic } from './commandCapability';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { DraftRun, DraftRunSpec } from '../../shared/types';
import { hashDraftRunSpec } from '../../runs/draftRunProposal';
import { getFileReferenceAuthorizationKey } from '../../context/references/fileReference';
import { findCanonicalWorkspaceFolder } from './pathScope';
import { inspectGitCommandReplan, type GitCommandReplan } from './commandSemantics';

export class CommandCapabilityError extends Error {
  public constructor(public readonly diagnostic: CommandCapabilityDiagnostic) {
    super(diagnostic.reason);
    this.name = 'CommandCapabilityError';
  }
}

export class InvalidGitCommitError extends Error {
  public constructor(public readonly diagnosis: GitCommandReplan) {
    super(diagnosis.message);
    this.name = 'InvalidGitCommitError';
  }
}

export function assertValidGitCommitArguments(spec: DraftRunSpec): void {
  const diagnosis = inspectGitCommandReplan(spec);
  if (diagnosis && diagnosis.code !== 'git_status_pager_override') throw new InvalidGitCommitError(diagnosis);
}

export async function validateDraftRunBeforeApproval(
  draftRun: DraftRun,
  authorizedExternalReferenceUris: ReadonlySet<string>
): Promise<void> {
  checkDraftRunApprovalBoundary(draftRun, authorizedExternalReferenceUris);
  const cwdUri = vscode.Uri.parse(draftRun.spec.cwdUri);
  const stat = await vscode.workspace.fs.stat(cwdUri);
  if (stat.type !== vscode.FileType.Directory || cwdUri.scheme !== 'file') {
    throw new Error('DraftRun working directory is no longer an executable local directory.');
  }
  const canonicalCwd = await realpath(cwdUri.fsPath);
  if (!await findCanonicalWorkspaceFolder(canonicalCwd) && !authorizedExternalReferenceUris.has(vscode.Uri.file(canonicalCwd).toString())
    && !authorizedExternalReferenceUris.has(cwdUri.toString())) {
    throw new Error(`Authorize the exact external working directory before running this DraftRun: ${cwdUri.toString()}`);
  }
  checkDraftRunApprovalBoundary(draftRun, authorizedExternalReferenceUris);
  const diagnosis = analyzeCommandCapability(draftRun.spec).diagnostics.find(item => item.blocking);
  if (diagnosis) throw new CommandCapabilityError(diagnosis);
}

export function checkDraftRunApprovalIdentity(draftRun: DraftRun, expectedSpecHash?: string): void {
  if (!vscode.workspace.isTrusted) {
    throw new Error('DraftRun is disabled because the workspace is not trusted.');
  }
  if (hashDraftRunSpec(draftRun.spec) !== draftRun.specHash || (expectedSpecHash !== undefined && expectedSpecHash !== draftRun.specHash)) {
    throw new Error('DraftRun command changed after review and cannot be executed.');
  }
  const cwdUri = vscode.Uri.parse(draftRun.spec.cwdUri);
  if (cwdUri.scheme !== 'file') throw new Error('DraftRun requires a local working directory.');
}

export function checkDraftRunApprovalBoundary(draftRun: DraftRun, authorizedExternalReferenceUris: ReadonlySet<string>, expectedSpecHash?: string): void {
  checkDraftRunApprovalIdentity(draftRun, expectedSpecHash);
  const cwdUri = vscode.Uri.parse(draftRun.spec.cwdUri);
  if (draftRun.spec.externalCwd
    && !authorizedExternalReferenceUris.has(getFileReferenceAuthorizationKey(cwdUri))) {
    throw new Error(`Authorize the exact external working directory before running this DraftRun: ${draftRun.spec.cwdLabel}`);
  }
}

