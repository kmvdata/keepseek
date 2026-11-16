import type { DraftEditAction, DraftRunEffectAssessment, SafeNpmScript } from '../shared/types';
import { isGitReleaseRef } from './authorization/commandSemantics';

export const MAX_APPROVAL_TARGETS = 32;

export type VerifiedProjectOperation = 'file_change' | 'script_launch' | 'project_process' | 'fixed_validation';
export type ApprovalExecutionIsolation = 'none' | 'seatbelt' | 'bubblewrap' | 'container';
export interface ApprovalContainerRuntime { image: string; command: string }

export type ApprovalBusinessAuthorization =
  | { kind: 'git_push'; authority: 'task' | 'project'; targets: string[]; refs: string[]; sourceCommit?: string }
  | { kind: 'confirmed_action'; authority: 'user_confirmation'; targets: string[]; receiptId: string };

export function normalizeApprovalExecutionIsolation(value: unknown): ApprovalExecutionIsolation | undefined {
  return (['none', 'seatbelt', 'bubblewrap', 'container'] as const).find(kind => kind === value);
}

export function normalizeBusinessAuthorization(value: unknown): ApprovalBusinessAuthorization | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as Partial<ApprovalBusinessAuthorization>;
  const { kind, authority, targets } = candidate;
  if (!Array.isArray(targets) || !targets.length || targets.length > MAX_APPROVAL_TARGETS
    || !targets.every(target => typeof target === 'string' && target.trim().length > 0 && target.length <= 300 && !target.includes('\0'))
    || new Set(targets).size !== targets.length) return undefined;
  if (kind === 'confirmed_action') {
    return authority === 'user_confirmation' && typeof candidate.receiptId === 'string'
      && /^[a-f0-9-]{36}$/u.test(candidate.receiptId) ? { kind, authority, targets: [...targets], receiptId: candidate.receiptId } : undefined;
  }
  if (kind !== 'git_push' || (authority !== 'task' && authority !== 'project')) return undefined;
  const { refs, sourceCommit } = candidate;
  if (!Array.isArray(refs) || !refs.length || refs.length + 1 !== targets.length || new Set(refs).size !== refs.length
    || !refs.every(ref => typeof ref === 'string' && isGitReleaseRef(ref) && targets.includes(ref))
    || (sourceCommit !== undefined && (typeof sourceCommit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceCommit)))) {
    return undefined;
  }
  return { kind, authority, targets: [...targets], refs: [...refs], sourceCommit };
}

export type ApprovalActionKind =
  | 'external_file_access'
  | 'validation_run'
  | 'draft_edit_apply'
  | 'draft_delete_apply'
  | 'draft_run_execute';

export interface BoundedReviewText {
  content: string;
  totalChars: number;
  contentHash: string;
  truncated: boolean;
}

export type ApprovalReviewExactAction =
  | {
      kind: 'external_file_access';
      uri: string;
      access: 'read' | 'write' | 'delete';
      readLimits?: { maxBytes: number; startLine?: number; endLine?: number };
    }
  | {
      kind: 'validation_run';
      script: SafeNpmScript;
      workspaceRootId: string;
      launch?: { cwdUri: string; executable: string; argv: string[]; envNames: string[]; scripts: BoundedReviewText;
        osIsolation?: ApprovalExecutionIsolation; containerRuntime?: ApprovalContainerRuntime };
    }
  | {
      kind: 'draft_edit_apply' | 'draft_delete_apply';
      action: DraftEditAction;
      uri: string;
      sourceUri?: string;
      targetUri?: string;
      canonicalTargets?: string[];
      metadataOnly?: boolean;
      proposedChange: BoundedReviewText;
      payloadVersion?: string;
      canonicalPayloadHash?: string;
      expectedOriginalTextHash?: string;
      expectedOriginalSize?: number;
      resultTextHash?: string;
      resultSize?: number;
    }
  | {
      kind: 'draft_run_execute';
      executable: string;
      argv: string[];
      cwdUri: string;
      envNames: string[];
      scope?: { cwd: string; executable?: string; launcher?: string; environmentNames?: string[];
        launcherTrust?: 'verified_runtime' | 'identity_only';
        projectEntryUri?: string;
        networkTargets?: string[];
        executionArgv?: string[];
        sourceRefs?: Array<{ ref: string; object: string }>;
        transport?: { destination: string; protocol: string };
        osIsolation?: ApprovalExecutionIsolation; projectRootUri?: string; containerRuntime?: ApprovalContainerRuntime;
        paths: Array<{ uri: string; role: string; external: boolean }> };
      restricted?: {
        kind: 'python_ast_v1';
        original: { id: string; specHash: string; executable: string; argv: string[]; cwdUri: string; executed: false };
        targetUri: string;
        inputBytes: number;
        environment: 'empty';
        stdin: 'single UTF-8 snapshot';
        launchIdentity: string;
      };
      timeoutMs: number;
      effectAssessment: DraftRunEffectAssessment;
      specHash: string;
    };