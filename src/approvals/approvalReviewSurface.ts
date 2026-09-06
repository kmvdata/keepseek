import * as vscode from 'vscode';
import type { AgentRequest, ChatMessage, DraftEdit, DraftRun, SafeNpmScript } from '../shared/types';
import { createBoundedReviewText, hashApprovalText, hashApprovalValue, hashDraftEditAction, hashDraftRunAction } from './approvalReviewHash';
import type { ApprovalReviewRequest } from './approvalReviewTypes';

export function createDraftEditReviewRequest(input: {
  sessionId: string;
  rootTaskId?: string;
  agentRunId: string;
  edit: DraftEdit;
  originalText: string;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const kind = input.edit.action === 'delete' ? 'draft_delete_apply' : 'draft_edit_apply';
  const originalTextHash = input.edit.expectedOriginalTextHash ?? hashApprovalText(input.originalText);
  // Create/modify reviews receive the exact proposed new content (bounded
  // deterministically); delete reviews receive the bounded content that would
  // disappear. The original full-file hash separately binds the baseline.
  const change = input.edit.action === 'delete' ? input.originalText : input.edit.newText;
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
      input.edit.expectedOriginalTextHash ? 'baseline_hash_present' : 'baseline_hash_absent'
    ],
    exactAction: {
      kind,
      action: input.edit.action,
      uri: input.edit.uri,
      proposedChange: createBoundedReviewText(change),
      expectedOriginalTextHash: originalTextHash,
      expectedOriginalSize: input.edit.expectedOriginalSize ?? Buffer.byteLength(input.originalText, 'utf8')
    },
    language: input.language
  });
}

export function createDraftRunReviewRequest(input: {
  draftRun: DraftRun;
  rootTaskId?: string;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
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
      `verdict:${input.draftRun.effectAssessment.verdict}`,
      ...input.draftRun.effectAssessment.effects.map((effect) => `effect:${effect}`),
      ...input.draftRun.effectAssessment.evidence
    ],
    exactAction: {
      kind: 'draft_run_execute',
      executable: input.draftRun.spec.executable,
      argv: [...input.draftRun.spec.args],
      cwdUri: input.draftRun.spec.cwdUri,
      env: input.draftRun.spec.env.map((entry) => ({ ...entry })),
      timeoutMs: input.draftRun.spec.timeoutMs,
      effectAssessment: structuredClone(input.draftRun.effectAssessment),
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
}): ApprovalReviewRequest {
  return createBaseRequest({
    sessionId: input.request.sessionId ?? '',
    rootTaskId: input.request.approvalRootTaskId ?? input.request.checkpoint?.taskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'validation_run',
    targetId: input.targetId,
    actionHash: hashApprovalValue({ script: input.script, workspaceRootId: input.workspaceRootId }),
    history: input.request.history,
    purpose: `Run the fixed ${input.script} validation requested by the main model.`,
    staticRiskAnalysis: ['registered_validation_tool', `fixed_script:${input.script}`, 'static_validation_preflight_passed'],
    exactAction: { kind: 'validation_run', script: input.script, workspaceRootId: input.workspaceRootId },
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
  purpose: string;
}): ApprovalReviewRequest {
  return createBaseRequest({
    sessionId: input.request?.sessionId ?? input.sessionId ?? '',
    rootTaskId: input.request?.approvalRootTaskId ?? input.request?.checkpoint?.taskId ?? input.rootTaskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'external_file_access',
    targetId: input.targetId,
    actionHash: hashApprovalValue({ uri: input.uri, access: input.access, purpose: input.purpose }),
    history: input.request?.history ?? input.history ?? [],
    purpose: input.purpose,
    staticRiskAnalysis: ['external_exact_uri', `access:${input.access}`, 'no_directory_wildcard'],
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
  const visible = input.history.filter((message) => message.role === 'user' || message.role === 'assistant');
  const firstUser = visible.find((message) => message.role === 'user')?.content ?? '';
  return deepFreeze({
    version: 1,
    sessionId: input.sessionId,
    rootTaskId: input.rootTaskId,
    agentRunId: input.agentRunId,
    actionKind: input.actionKind,
    targetId: input.targetId,
    actionHash: input.actionHash,
    originalGoalSummary: compact(firstUser, 1_200),
    visibleSessionEvidence: visible.slice(-6).map((message) => `${message.role}: ${compact(message.content, 1_200)}`),
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
