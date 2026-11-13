import type { DraftEditAction, DraftRunEffectAssessment, SafeNpmScript } from '../shared/types';
import { isGitReleaseRef } from './authorization/commandSemantics';

export const APPROVAL_POLICY_VERSION = 9;

export const EXACT_USER_AUTHORIZATION_RULE = 'exact_user_authorization_required';
export const PROJECT_BEHAVIOR_UNKNOWN_RULE = 'project_behavior_unknown';
export const VERIFIED_PROJECT_OPERATION_RULE = 'verified_project_operation';
export const USER_CONFIRMABLE_RISK_RULE = 'user_confirmable_risk';
export const AUTHORIZED_BUSINESS_EFFECT_RULE = 'authorized_business_effect';
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

export type ApprovalReviewDecision = 'approve' | 'needs_user' | 'deny';
export type ApprovalReviewRisk = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalAuthorizationSource = 'auto_approval_review' | 'user_click';
export type ApprovalReviewSource = ApprovalAuthorizationSource | 'host_policy' | 'local_policy';

const REVIEW_STATES = ['in_progress', 'interrupted', 'configuration_unavailable', 'service_unavailable',
  'timeout', 'invalid_response', 'scope_mismatch', 'cancelled', 'budget_stopped', 'insufficient_evidence', 'circuit_stopped'] as const;
export type ApprovalReviewState = typeof REVIEW_STATES[number];

export const MANUAL_FALLBACK_STATES: readonly ApprovalReviewState[] = [
  'configuration_unavailable', 'service_unavailable', 'timeout', 'invalid_response'
];

export const REVIEW_RESPONSE_FIELDS = ['decision', 'risk', 'reason', 'policyRules', 'saferAlternative', 'affectedTargets'] as const;
export type ApprovalResponseField = typeof REVIEW_RESPONSE_FIELDS[number];
export const REVIEW_ATTEMPT_FAILURES = ['size_limit', 'malformed_json', 'wrong_type', 'duplicate_field', 'missing_field',
  'unknown_field', 'invalid_value', 'contradictory_decision', 'scope_mismatch', 'project_behavior_unknown',
  'unusable_response', 'timeout', 'service_unavailable', 'budget_stopped', 'cancelled'] as const;

export interface ApprovalReviewAttemptFailure {
  attempt: number;
  category: typeof REVIEW_ATTEMPT_FAILURES[number];
  field?: ApprovalResponseField;
  at: string;
}

export function normalizeApprovalReviewAttempts(value: unknown): number | undefined {
  return value === 0 || value === 1 || value === 2 ? value : undefined;
}

export function normalizeApprovalAttemptFailures(value: unknown): ApprovalReviewAttemptFailure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: ApprovalReviewAttemptFailure[] = [];
  for (const entry of value.slice(0, 2)) {
    if (!entry || typeof entry !== 'object') continue;
    const { attempt, category, field, at } = entry as ApprovalReviewAttemptFailure;
    if (![1, 2].includes(attempt) || !REVIEW_ATTEMPT_FAILURES.includes(category)
      || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
    normalized.push({ attempt, category, at: new Date(at).toISOString(), field: REVIEW_RESPONSE_FIELDS.find(item => item === field) });
  }
  return normalized;
}

export function normalizeApprovalReviewState(value: unknown): ApprovalReviewState | undefined {
  return REVIEW_STATES.find(state => state === value);
}

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

export interface ApprovalReviewRequest {
  version: 1;
  sessionId: string;
  /** Stable across automatic continuation turns for refusal-fuse accounting. */
  rootTaskId: string;
  agentRunId: string;
  actionKind: ApprovalActionKind;
  targetId: string;
  actionHash: string;
  effectHash?: string;
  historicalActionHashes?: readonly string[];
  scopeFingerprint?: string;
  approvalMode?: 'delegate';
  externalAuthorization?: { required: boolean; targets: string[] };
  /** Positive authority supplied by the host for this exact bound action. */
  businessAuthorization?: ApprovalBusinessAuthorization;
  /** Host-verified scope, never a model claim or a grant. Runtime only. */
  verifiedProjectOperation?: VerifiedProjectOperation;
  originalGoalSummary: string;
  /** Recent genuine user instructions for this task, in chronological order. */
  taskConstraints?: string[];
  evidenceIncomplete?: boolean;
  visibleSessionEvidence: string[];
  workspaceTrusted: boolean;
  workspaceRootIds: string[];
  purpose: string;
  staticRiskAnalysis: string[];
  exactAction: ApprovalReviewExactAction;
  responseLanguage: 'zh-CN' | 'en';
}

export interface ApprovalReviewerJson {
  decision: ApprovalReviewDecision;
  risk: ApprovalReviewRisk;
  reason: string;
  policyRules: string[];
  saferAlternative: string;
  affectedTargets?: string[];
}

export interface ApprovalReviewRecord {
  reviewId: string;
  runtimeId: string;
  sessionId: string;
  rootTaskId: string;
  agentRunId: string;
  targetId: string;
  actionKind: ApprovalActionKind;
  actionHash: string;
  effectHash?: string;
  policyVersion: number;
  scopeFingerprint?: string;
  approvalMode?: 'delegate';
  approvalSource: ApprovalReviewSource;
  projectApproval?: true;
  osIsolation?: ApprovalExecutionIsolation;
  businessAuthorization?: ApprovalBusinessAuthorization;
  authorizationPending?: true;
  reviewerConfigFingerprint?: string;
  originalActionHash?: string;
  reviewerSourceId: string;
  reviewerModelId: string;
  reviewerProvider: string;
  decision: ApprovalReviewDecision | 'unavailable';
  reviewState?: ApprovalReviewState;
  risk: ApprovalReviewRisk;
  /** Legacy risk is required in storage even when the reviewer could not assess it. */
  riskUnassessed?: true;
  rationale: string;
  policyRules: string[];
  saferAlternative?: string;
  affectedTargets?: string[];
  createdAt: string;
  consumedAt?: string;
  /** Original reviewer outcome remains an independent audit record. */
  priorReviewId?: string;
  userRequestId?: string;
  /** An explicit retry supersedes the earlier review without changing its decision. */
  supersededByReviewId?: string;
  reviewAttempts?: number;
  attemptFailures?: ApprovalReviewAttemptFailure[];
  /** Local history membership only; never changes the original review decision. */
  historyInvalidatedBy?: string;
}

export type ApprovalReviewDisplay = Omit<ApprovalReviewRecord, 'runtimeId' | 'actionHash' | 'effectHash' | 'policyRules' | 'scopeFingerprint' | 'reviewerConfigFingerprint' | 'originalActionHash' | 'historyInvalidatedBy' | 'supersededByReviewId'>;

export interface ApprovalReviewOutcome {
  status: 'reviewed' | 'unavailable';
  record: ApprovalReviewRecord;
  circuitBreakReason?: 'consecutive_denials' | 'recent_denials';
}

export interface ApprovalUserAuthorizationReceipt {
  record: ApprovalReviewRecord;
  authorization: Extract<ApprovalBusinessAuthorization, { kind: 'confirmed_action' }>;
}

/** Shared by draft processing and in-loop tools; text never determines routing. */
export function approvalDisposition(record: ApprovalReviewRecord): 'execute' | 'request_user' | 'deny' | 'stop' {
  if (record.decision === 'deny') return 'deny';
  if (record.policyVersion !== APPROVAL_POLICY_VERSION || record.supersededByReviewId
    || record.approvalSource !== 'auto_approval_review' || record.reviewState || record.risk === 'critical') return 'stop';
  if (record.decision === 'approve') {
    if (record.authorizationPending) return 'request_user';
    if (record.risk === 'low' || record.risk === 'medium' || (record.risk === 'high' && record.scopeFingerprint
      && record.policyRules.includes(AUTHORIZED_BUSINESS_EFFECT_RULE) && normalizeBusinessAuthorization(record.businessAuthorization))) return 'execute';
  }
  if (record.decision === 'needs_user' && (record.authorizationPending && record.policyRules.includes(EXACT_USER_AUTHORIZATION_RULE)
    || (record.risk === 'high' && record.policyRules.includes(USER_CONFIRMABLE_RISK_RULE)))) return 'request_user';
  return 'stop';
}

export interface ApprovalRecordMatch {
  reviewId: string;
  sessionId: string;
  rootTaskId: string;
  agentRunId: string;
  targetId: string;
  actionKind: ApprovalActionKind;
  actionHash: string;
  policyVersion: number;
  approvalMode?: 'delegate';
  expectedSource: ApprovalAuthorizationSource;
  reviewerConfigFingerprint?: string;
  scopeFingerprint?: string;
  workspaceTrusted: boolean;
}

export type ManualApprovalResolutionReason = 'retry_requested' | 'user_cancelled' | 'session_changed' | 'host_interrupted'
  | 'stale_request' | 'mode_changed' | 'storage_failed' | 'user_approved' | 'user_rejected' | 'history_changed';

export interface ManualToolApproval {
  id: string;
  sessionId: string;
  label: string;
  reason: string;
  request?: ApprovalReviewRequest;
  priorReviewId?: string;
  runtimeId?: string;
  authorizationTargets?: string[];
  affectedTargets?: string[];
  risk?: ApprovalReviewRisk;
  reviewState?: ApprovalReviewState;
  resolutionReason?: ManualApprovalResolutionReason;
  status?: 'waiting' | 'interrupted' | 'approved' | 'rejected' | 'cancelled';
}
