import type { DraftEditAction, DraftRunEffectAssessment, SafeNpmScript } from '../shared/types';

export const APPROVAL_POLICY_VERSION = 2;
export const AUTO_APPROVAL_POLICY_VERSION = 4;

export function reviewerRoute(mode: ApprovalReviewRequest['approvalMode']): 'model_review' | 'auto_approval_review' {
  return mode === 'delegate' ? 'auto_approval_review' : 'model_review';
}

export function policyVersionFor(source: ApprovalReviewSource): number {
  return source === 'auto_approval_review' ? AUTO_APPROVAL_POLICY_VERSION : APPROVAL_POLICY_VERSION;
}

export type ApprovalActionKind =
  | 'external_file_access'
  | 'validation_run'
  | 'draft_edit_apply'
  | 'draft_delete_apply'
  | 'draft_run_execute';

export type ApprovalReviewDecision = 'approve' | 'deny';
export type ApprovalReviewRisk = 'low' | 'medium' | 'high' | 'critical';
export type ApprovalReviewSource = 'auto_approval_review' | 'model_review' | 'host_policy' | 'local_policy' | 'user_click';
export type ApprovalRoute = 'host_policy' | 'auto_approval_review' | 'model_review' | 'user_click';

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
  scopeFingerprint?: string;
  approvalMode?: 'model_review' | 'delegate';
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
  policyVersion: number;
  scopeFingerprint?: string;
  approvalMode?: 'model_review' | 'delegate';
  approvalSource: ApprovalReviewSource;
  osIsolation?: 'none';
  reviewerConfigFingerprint?: string;
  originalActionHash?: string;
  reviewerSourceId: string;
  reviewerModelId: string;
  reviewerProvider: string;
  decision: ApprovalReviewDecision | 'unavailable';
  risk: ApprovalReviewRisk;
  rationale: string;
  policyRules: string[];
  saferAlternative?: string;
  affectedTargets?: string[];
  createdAt: string;
  consumedAt?: string;
}

export type ApprovalReviewDisplay = Omit<ApprovalReviewRecord, 'runtimeId' | 'actionHash' | 'policyRules' | 'scopeFingerprint' | 'reviewerConfigFingerprint' | 'originalActionHash'>;

export interface ApprovalReviewOutcome {
  status: 'reviewed' | 'unavailable';
  record: ApprovalReviewRecord;
  circuitBreakReason?: 'consecutive_denials' | 'recent_denials';
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
  approvalMode?: 'model_review' | 'delegate';
  expectedSource: ApprovalRoute;
  reviewerConfigFingerprint?: string;
  scopeFingerprint?: string;
  workspaceTrusted: boolean;
}

export interface ManualToolApproval {
  id: string;
  sessionId: string;
  label: string;
  reason: string;
}
