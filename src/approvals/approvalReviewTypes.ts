import type { DraftEditAction, DraftRunEffectAssessment, SafeNpmScript } from '../shared/types';

export const APPROVAL_POLICY_VERSION = 7;

export const EXACT_USER_AUTHORIZATION_RULE = 'exact_user_authorization_required';
export const PROJECT_BEHAVIOR_UNKNOWN_RULE = 'project_behavior_unknown';
export const VERIFIED_PROJECT_OPERATION_RULE = 'verified_project_operation';

export type VerifiedProjectOperation = 'file_change' | 'script_launch' | 'fixed_validation';

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
  'timeout', 'invalid_response', 'budget_stopped', 'insufficient_evidence', 'circuit_stopped'] as const;
export type ApprovalReviewState = typeof REVIEW_STATES[number];

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
      launch?: { cwdUri: string; executable: string; argv: string[]; envNames: string[]; scripts: BoundedReviewText };
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
        osIsolation?: 'none'; paths: Array<{ uri: string; role: string; external: boolean }> };
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
  /** Host-verified scope, never a model claim or a grant. Runtime only. */
  verifiedProjectOperation?: VerifiedProjectOperation;
  originalGoalSummary: string;
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
  osIsolation?: 'none';
  reviewerConfigFingerprint?: string;
  originalActionHash?: string;
  reviewerSourceId: string;
  reviewerModelId: string;
  reviewerProvider: string;
  decision: ApprovalReviewDecision | 'unavailable';
  reviewState?: ApprovalReviewState;
  risk: ApprovalReviewRisk;
  rationale: string;
  policyRules: string[];
  saferAlternative?: string;
  affectedTargets?: string[];
  createdAt: string;
  consumedAt?: string;
  /** Original reviewer outcome remains an independent audit record. */
  priorReviewId?: string;
  userRequestId?: string;
  /** Local history membership only; never changes the original review decision. */
  historyInvalidatedBy?: string;
}

export type ApprovalReviewDisplay = Omit<ApprovalReviewRecord, 'runtimeId' | 'actionHash' | 'effectHash' | 'policyRules' | 'scopeFingerprint' | 'reviewerConfigFingerprint' | 'originalActionHash' | 'historyInvalidatedBy'>;

export interface ApprovalReviewOutcome {
  status: 'reviewed' | 'unavailable';
  record: ApprovalReviewRecord;
  circuitBreakReason?: 'consecutive_denials' | 'recent_denials';
}

/** Shared by draft processing and in-loop tools; text never determines routing. */
export function approvalDisposition(record: ApprovalReviewRecord): 'execute' | 'request_user' | 'deny' | 'stop' {
  if (record.decision === 'deny') return 'deny';
  if (record.policyVersion !== APPROVAL_POLICY_VERSION || record.reviewState
    || record.approvalSource === 'host_policy' || record.approvalSource === 'local_policy') return 'stop';
  if (record.decision === 'approve' && (record.approvalSource === 'user_click' || ['low', 'medium'].includes(record.risk))) return 'execute';
  if (record.decision === 'needs_user' && record.approvalSource === 'auto_approval_review'
    && record.policyRules.includes(EXACT_USER_AUTHORIZATION_RULE)) return 'request_user';
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

export interface ManualToolApproval {
  id: string;
  sessionId: string;
  label: string;
  reason: string;
  request?: ApprovalReviewRequest;
  priorReviewId?: string;
  runtimeId?: string;
  authorizationTargets?: string[];
  status?: 'waiting' | 'interrupted' | 'approved' | 'rejected' | 'cancelled';
}
