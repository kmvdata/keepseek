import { analyzeDraftRunEffects } from './authorization/commandEffects';
import { taskGoal } from '../sessions/userTask';
import * as vscode from 'vscode';
import type { AgentRequest, ChatMessage, DraftEdit, DraftRun, SafeNpmScript } from '../shared/types';
import { createBoundedReviewText, hashApprovalText, hashApprovalValue, hashDraftEditAction, hashDraftRunAction } from './approvalReviewHash';
import type { ApprovalReviewRequest } from './approvalReviewTypes';
import { getDraftEditBase, getDraftEditFullText, getDraftEditKind, getDraftEditResult } from '../edits/draftEdit';
import type { CommandScope } from './authorization/commandScope';
import { redactSensitiveReviewText } from './approvalPolicy';
import { renderPatchReview } from '../edits/textPatch';

export function createDraftEditReviewRequest(input: {
  sessionId: string;
  rootTaskId?: string;
  agentRunId: string;
  edit: DraftEdit;
  originalText: string;
  metadataOnly?: boolean;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const kind = input.edit.action === 'delete' ? 'draft_delete_apply' : 'draft_edit_apply';
  const base = getDraftEditBase(input.edit);
  const result = getDraftEditResult(input.edit);
  const originalTextHash = base?.sha256 ?? hashApprovalText(input.originalText);
  // External authorization grants the operation, while reviewers receive
  // metadata only. Deletion review never transmits the file being removed.
  const change = input.edit.kind === 'move_v1'
    ? `${input.edit.sourceUri} -> ${input.edit.targetUri}`
    : input.metadataOnly || input.edit.action === 'delete' ? ''
      : input.edit.kind === 'text_patch_v1' ? renderPatchReview(input.edit.patch)
        : getDraftEditFullText(input.edit)
          ?? (input.edit.kind === 'full_text_v1' && input.edit.contentBlobHash
            ? `[content-addressed blob sha256 ${input.edit.contentBlobHash}; ${input.edit.result.sizeBytes} bytes]` : '');
  return createBaseRequest({
    sessionId: input.sessionId,
    rootTaskId: input.rootTaskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: kind,
    targetId: input.edit.id,
    actionHash: hashDraftEditAction(input.edit, originalTextHash),
    history: input.history,
    purpose: input.edit.reason,
    staticRiskAnalysis: [
      `file_action:${input.edit.action}`,
      input.edit.action === 'delete' ? 'destructive_delete' : 'workspace_write',
      base?.sha256 ? 'baseline_hash_present' : 'baseline_hash_absent',
      `payload_version:${getDraftEditKind(input.edit)}`,
      ...(input.metadataOnly ? ['External scope authorized by the user; content intentionally withheld.'] : [])
    ],
    exactAction: {
      kind,
      action: input.edit.action,
      uri: input.edit.uri,
      proposedChange: createBoundedReviewText(change),
      payloadVersion: getDraftEditKind(input.edit),
      canonicalPayloadHash: input.edit.kind === 'text_patch_v1' ? input.edit.patch.canonicalHash : undefined,
      expectedOriginalTextHash: originalTextHash,
      expectedOriginalSize: base?.sizeBytes ?? Buffer.byteLength(input.originalText, 'utf8'),
      resultTextHash: result?.sha256,
      resultSize: result?.sizeBytes
    },
    language: input.language
  });
}

export function createDraftRunReviewRequest(input: {
  draftRun: DraftRun;
  scope?: CommandScope;
  rootTaskId?: string;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const assessment = analyzeDraftRunEffects(input.draftRun.spec, input.scope?.diagnostics);
  return createBaseRequest({
    sessionId: input.draftRun.sessionId,
    rootTaskId: input.rootTaskId ?? input.draftRun.agentRunId,
    agentRunId: input.draftRun.agentRunId,
    actionKind: 'draft_run_execute',
    targetId: input.draftRun.id,
    actionHash: hashDraftRunAction(input.draftRun),
    history: input.history,
    purpose: input.draftRun.spec.reason,
    staticRiskAnalysis: [
      `verdict:${assessment.verdict}`,
      ...assessment.effects.map((effect) => `effect:${effect}`),
      ...assessment.evidence,
      'Exact external scope, when present, requires separate user authorization.'
    ],
    exactAction: {
      kind: 'draft_run_execute',
      executable: input.draftRun.spec.executable,
      argv: [...input.draftRun.spec.args],
      cwdUri: input.draftRun.spec.cwdUri,
      envNames: input.draftRun.spec.env.map(({ name }) => name),
      scope: input.scope && { cwd: input.scope.cwd, executable: input.scope.executable, paths: input.scope.paths },
      timeoutMs: input.draftRun.spec.timeoutMs,
      effectAssessment: assessment,
      specHash: input.draftRun.specHash
    },
    language: input.language
  });
}

export function createValidationReviewRequest(input: {
  request: AgentRequest;
  agentRunId: string;
  targetId: string;
  script: SafeNpmScript;
  workspaceRootId: string;
  snapshot: import('../agent/tools/validationSnapshot').ValidationSnapshot;
}): ApprovalReviewRequest {
  return createBaseRequest({
    sessionId: input.request.sessionId ?? '',
    rootTaskId: input.request.approvalRootTaskId ?? input.request.checkpoint?.taskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'validation_run',
    targetId: input.targetId,
    actionHash: hashApprovalValue([input.script, input.workspaceRootId, input.snapshot.fingerprint]),
    history: input.request.history,
    purpose: `Run the fixed ${input.script} validation requested by the main model.`,
    staticRiskAnalysis: ['registered_validation_tool', `fixed_script:${input.script}`,
      'Runs repository code and installed dependencies with extension-host privileges.',
      ...input.snapshot.configNames.map(name => `launch configuration present: ${name}`)],
    exactAction: { kind: 'validation_run', script: input.script, workspaceRootId: input.workspaceRootId,
      launch: { cwdUri: input.snapshot.cwdUri, executable: input.snapshot.executable, argv: [...input.snapshot.argv],
        envNames: Object.keys(input.snapshot.env), scripts: input.snapshot.evidence } },
    language: input.request.language
  });
}

export function createExternalFileReviewRequest(input: {
  request?: AgentRequest;
  sessionId?: string;
  rootTaskId?: string;
  history?: readonly ChatMessage[];
  language?: 'zh-CN' | 'en';
  agentRunId: string;
  targetId: string;
  uri: string;
  access: 'read' | 'write' | 'delete';
  fingerprint?: string;
  purpose: string;
}): ApprovalReviewRequest {
  return createBaseRequest({
    sessionId: input.request?.sessionId ?? input.sessionId ?? '',
    rootTaskId: input.request?.approvalRootTaskId ?? input.request?.checkpoint?.taskId ?? input.rootTaskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'external_file_access',
    targetId: input.targetId,
    actionHash: hashApprovalValue({ uri: input.uri, access: input.access, fingerprint: input.fingerprint, purpose: input.purpose }),
    history: input.request?.history ?? input.history ?? [],
    purpose: input.purpose,
    staticRiskAnalysis: ['external_exact_uri', `access:${input.access}`, 'User granted this exact read scope; no directory wildcard. File contents are excluded from this review.'],
    exactAction: { kind: 'external_file_access', uri: input.uri, access: input.access },
    language: input.request?.language ?? input.language ?? 'en'
  });
}

function createBaseRequest(input: {
  sessionId: string;
  rootTaskId: string;
  agentRunId: string;
  actionKind: ApprovalReviewRequest['actionKind'];
  targetId: string;
  actionHash: string;
  history: readonly ChatMessage[];
  purpose: string;
  staticRiskAnalysis: string[];
  exactAction: ApprovalReviewRequest['exactAction'];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const firstUser = taskGoal(input.history, input.rootTaskId);
  return deepFreeze({
    version: 1,
    sessionId: input.sessionId,
    rootTaskId: input.rootTaskId,
    agentRunId: input.agentRunId,
    actionKind: input.actionKind,
    targetId: input.targetId,
    actionHash: input.actionHash,
    originalGoalSummary: compact(redactSensitiveReviewText(firstUser), 1_200),
    visibleSessionEvidence: [],
    workspaceTrusted: vscode.workspace.isTrusted,
    workspaceRootIds: (vscode.workspace.workspaceFolders ?? []).map((folder, index) => `root-${index + 1}:${folder.name}`),
    purpose: compact(input.purpose, 1_200),
    staticRiskAnalysis: input.staticRiskAnalysis.map((item) => compact(item, 1_000)),
    exactAction: structuredClone(input.exactAction),
    responseLanguage: input.language
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function compact(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}
