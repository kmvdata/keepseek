import { analyzeDraftRunEffects } from './authorization/commandEffects';
import { taskGoal } from '../sessions/userTask';
import * as vscode from 'vscode';
import type { AgentRequest, ChatMessage, DraftEdit, DraftRun, SafeNpmScript } from '../shared/types';
import { createBoundedReviewText, hashApprovalText, hashApprovalValue, hashDraftEditAction, hashDraftRunAction,
  hashExternalFileReviewAction } from './approvalReviewHash';
import { normalizeApprovalExecutionIsolation, type ApprovalReviewRequest } from './approvalReviewTypes';
import { getDraftEditBase, getDraftEditFullText, getDraftEditKind, getDraftEditResult } from '../edits/draftEdit';
import type { CommandScope } from './authorization/commandScope';
import { redactSensitiveReviewText } from './approvalPolicy';
import { renderPatchReview } from '../edits/textPatch';

export function createDraftEditReviewRequest(input: {
  sessionId: string;
  rootTaskId?: string;
  agentRunId: string;
  edit: DraftEdit;
  canonicalTargets?: readonly string[];
  originalText: string;
  metadataOnly?: boolean;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const kind = input.edit.action === 'delete' ? 'draft_delete_apply' : 'draft_edit_apply';
  const base = getDraftEditBase(input.edit);
  const result = getDraftEditResult(input.edit);
  const originalTextHash = base?.sha256 ?? hashApprovalText(input.originalText);
  const contentUnavailable = !input.metadataOnly && input.edit.kind === 'full_text_v1'
    && !!input.edit.contentBlobHash && getDraftEditFullText(input.edit) === undefined;
  // External authorization grants the operation, while reviewers receive
  // metadata only. Deletion review never transmits the file being removed.
  const change = input.edit.kind === 'move_v1'
    ? `${input.edit.sourceUri} -> ${input.edit.targetUri}`
    : input.metadataOnly || input.edit.action === 'delete' ? ''
      : input.edit.kind === 'text_patch_v1' ? renderPatchReview(input.edit.patch)
        : getDraftEditFullText(input.edit)
          ?? (contentUnavailable ? '[Proposed content was unavailable in the bounded review surface.]' : '');
  return createBaseRequest({
    sessionId: input.sessionId,
    rootTaskId: input.rootTaskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: kind,
    targetId: input.edit.id,
    actionHash: hashDraftEditAction(input.edit),
    evidenceIncomplete: contentUnavailable,
    hideToolResultBodies: input.metadataOnly || input.edit.action === 'delete',
    history: input.history,
    purpose: input.edit.reason,
    staticRiskAnalysis: [
      `file_action:${input.edit.action}`,
      input.edit.action === 'delete' ? 'destructive_delete' : 'workspace_write',
      base?.sha256 ? 'baseline_hash_present' : 'baseline_hash_absent',
      `payload_version:${getDraftEditKind(input.edit)}`,
      ...(input.metadataOnly ? ['External file content is withheld. Check the exact authorization facts supplied by the host.'] : [])
    ],
    exactAction: {
      kind,
      action: input.edit.action,
      uri: input.edit.uri,
      sourceUri: input.edit.kind === 'move_v1' ? input.edit.sourceUri : undefined,
      targetUri: input.edit.kind === 'move_v1' ? input.edit.targetUri : undefined,
      canonicalTargets: input.canonicalTargets ? [...input.canonicalTargets] : undefined,
      metadataOnly: input.metadataOnly || input.edit.action === 'delete',
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
  originalDraftRun?: DraftRun;
  scope?: CommandScope;
  rootTaskId?: string;
  history: readonly ChatMessage[];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const plan = input.draftRun.spec.restricted;
  const original = input.originalDraftRun;
  const boundary = input.scope?.projectExecution;
  const osIsolation = normalizeApprovalExecutionIsolation(boundary?.kind) ?? 'none';
  const verifiedProjectOperation = plan ? undefined : input.scope?.trustedProjectScript ? 'script_launch'
    : boundary && input.scope?.verifiedProjectCommand ? 'project_process' : undefined;
  const assessment = plan ? input.draftRun.effectAssessment : analyzeDraftRunEffects(input.draftRun.spec, input.scope);
  return createBaseRequest({
    sessionId: input.draftRun.sessionId,
    rootTaskId: input.rootTaskId ?? input.draftRun.agentRunId,
    agentRunId: input.draftRun.agentRunId,
    actionKind: 'draft_run_execute',
    targetId: input.draftRun.id,
    actionHash: hashDraftRunAction(input.draftRun),
    verifiedProjectOperation,
    history: input.history,
    purpose: input.draftRun.spec.reason,
    staticRiskAnalysis: [
      `verdict:${assessment.verdict}`,
      ...assessment.effects.map((effect) => `effect:${effect}`),
      ...assessment.evidence,
      ...(plan ? ['Host-constrained fixed parser, one UTF-8 snapshot via stdin, empty environment, bounded input and timeout.'] : []),
      ...(verifiedProjectOperation && osIsolation === 'none' ? ['Runs verified project code with extension-host privileges.'] : []),
      'The host checks exact external authorization independently.'
    ],
    exactAction: {
      kind: 'draft_run_execute',
      executable: input.draftRun.spec.executable,
      argv: [...input.draftRun.spec.args],
      cwdUri: input.draftRun.spec.cwdUri,
      envNames: input.draftRun.spec.env.map(({ name }) => name),
      scope: plan ? { cwd: input.draftRun.spec.cwdUri, executable: input.draftRun.spec.executable,
        paths: [{ uri: plan.targetUri, role: 'read_snapshot', external: false }] }
        : input.scope && { cwd: input.scope.cwd, executable: input.scope.executable, launcher: input.scope.boundLauncher,
          launcherTrust: input.scope.verifiedLauncher ? 'verified_runtime' : 'identity_only',
          projectEntryUri: input.scope.projectScriptEntryUri,
          networkTargets: input.scope.semantics?.networkTargets?.map(target => redactSensitiveReviewText(target)),
          osIsolation, projectRootUri: boundary ? vscode.Uri.file(boundary.root).toString() : undefined,
          containerRuntime: boundary?.kind === 'container' ? { image: boundary.image, command: boundary.containerCommand } : undefined,
          environmentNames: input.scope.environmentNames, paths: input.scope.paths },
      restricted: plan && original && { kind: plan.kind, original: {
        id: original.id, specHash: original.specHash, executable: original.spec.executable,
        argv: [...original.spec.args], cwdUri: original.spec.cwdUri, executed: false
      }, targetUri: plan.targetUri, inputBytes: plan.snapshotBytes, environment: 'empty',
      stdin: 'single UTF-8 snapshot', launchIdentity: plan.boundaryFingerprint },
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
  const osIsolation = normalizeApprovalExecutionIsolation(input.snapshot.projectExecution?.kind) ?? 'none';
  const boundary = input.snapshot.projectExecution;
  const actionHash = hashApprovalValue([input.script, input.workspaceRootId, input.snapshot.fingerprint]);
  return createBaseRequest({
    sessionId: input.request.sessionId ?? '',
    rootTaskId: input.request.approvalRootTaskId ?? input.request.checkpoint?.taskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'validation_run',
    targetId: input.targetId,
    actionHash,
    historicalActionHashes: input.snapshot.historicalFingerprint
      ? [hashApprovalValue([input.script, input.workspaceRootId, input.snapshot.historicalFingerprint])] : undefined,
    verifiedProjectOperation: input.snapshot.evidenceComplete ? 'fixed_validation' : undefined,
    history: input.request.history,
    purpose: `Run the fixed ${input.script} validation requested by the main model.`,
    staticRiskAnalysis: ['registered_validation_tool', `fixed_script:${input.script}`,
      ...(osIsolation === 'none' ? ['Runs repository code and installed dependencies with extension-host privileges.'] : []),
      ...input.snapshot.configNames.map(name => `launch configuration present: ${name}`)],
    exactAction: { kind: 'validation_run', script: input.script, workspaceRootId: input.workspaceRootId,
      launch: { cwdUri: input.snapshot.cwdUri, executable: input.snapshot.executable, argv: [...input.snapshot.argv],
        envNames: Object.keys(input.snapshot.env), scripts: input.snapshot.evidence, osIsolation,
        containerRuntime: boundary?.kind === 'container' ? { image: boundary.image, command: boundary.containerCommand } : undefined } },
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
  readLimits?: { maxBytes: number; startLine?: number; endLine?: number };
  requiresExactAuthorization?: boolean;
}): ApprovalReviewRequest {
  const effect = { uri: input.uri, access: input.access };
  const previousIdentity = { ...effect, fingerprint: input.fingerprint, purpose: input.purpose };
  const historicalActionHashes = [hashApprovalValue(previousIdentity),
    hashApprovalValue({ ...previousIdentity, fingerprint: hashApprovalValue(effect) })];
  const { readLimits } = input;
  const review = createBaseRequest({
    sessionId: input.request?.sessionId ?? input.sessionId ?? '',
    rootTaskId: input.request?.approvalRootTaskId ?? input.request?.checkpoint?.taskId ?? input.rootTaskId ?? input.agentRunId,
    agentRunId: input.agentRunId,
    actionKind: 'external_file_access',
    targetId: input.targetId,
    actionHash: hashExternalFileReviewAction({ ...effect, readLimits }, input.fingerprint),
    effectHash: hashApprovalValue(effect),
    historicalActionHashes,
    hideToolResultBodies: true,
    history: input.request?.history ?? input.history ?? [],
    purpose: readLimits?.startLine !== undefined
      ? `Read lines ${readLimits.startLine}-${readLimits.endLine} of the explicitly referenced external text file.`
      : input.purpose,
    staticRiskAnalysis: ['external_exact_uri', `access:${input.access}`, 'Exact read permission is checked separately; no directory wildcard. File contents are excluded from this review.'],
    exactAction: { kind: 'external_file_access', ...effect, readLimits },
    language: input.request?.language ?? input.language ?? 'en'
  });
  return { ...review, externalAuthorization: { required: input.requiresExactAuthorization === true, targets: [input.uri] } };
}

function createBaseRequest(input: {
  sessionId: string;
  rootTaskId: string;
  agentRunId: string;
  actionKind: ApprovalReviewRequest['actionKind'];
  targetId: string;
  actionHash: string;
  effectHash?: string;
  historicalActionHashes?: readonly string[];
  verifiedProjectOperation?: ApprovalReviewRequest['verifiedProjectOperation'];
  evidenceIncomplete?: boolean;
  hideToolResultBodies?: boolean;
  history: readonly ChatMessage[];
  purpose: string;
  staticRiskAnalysis: string[];
  exactAction: ApprovalReviewRequest['exactAction'];
  language: 'zh-CN' | 'en';
}): ApprovalReviewRequest {
  const firstUser = taskGoal(input.history, input.rootTaskId);
  const taskConstraints = input.history.filter(message => message.role === 'user' && !message.contextMeta?.displayKind
    && message.userTask?.id === input.rootTaskId && (message.userTask.reason === 'user' || message.userTask.reason === 'recovery'))
    .slice(-3).map(message => boundTaskConstraint(message.content));
  return deepFreeze({
    version: 1,
    sessionId: input.sessionId,
    rootTaskId: input.rootTaskId,
    agentRunId: input.agentRunId,
    actionKind: input.actionKind,
    targetId: input.targetId,
    actionHash: input.actionHash,
    effectHash: input.effectHash,
    historicalActionHashes: input.historicalActionHashes,
    verifiedProjectOperation: input.verifiedProjectOperation,
    originalGoalSummary: compact(redactSensitiveReviewText(firstUser), 1_200),
    taskConstraints: taskConstraints.length ? taskConstraints : undefined,
    evidenceIncomplete: input.evidenceIncomplete === true || firstUser !== redactSensitiveReviewText(firstUser) || input.purpose.length > 1_200
      || input.staticRiskAnalysis.some(item => item.length > 1_000),
    visibleSessionEvidence: boundedTaskEvidence(input.history, input.rootTaskId, input.targetId, input.hideToolResultBodies),
    workspaceTrusted: vscode.workspace.isTrusted,
    workspaceRootIds: (vscode.workspace.workspaceFolders ?? []).map((folder, index) => `root-${index + 1}:${folder.name}`),
    purpose: compact(input.purpose, 1_200),
    staticRiskAnalysis: input.staticRiskAnalysis.map((item) => compact(item, 1_000)),
    exactAction: structuredClone(input.exactAction),
    responseLanguage: input.language
  });
}

function boundTaskConstraint(content: string): string {
  const redacted = redactSensitiveReviewText(content, content.length).replace(/\s+/gu, ' ').trim();
  const edgeSize = 760;
  return redacted.length <= 1_600 ? redacted
    : `${redacted.slice(0, edgeSize)} [Middle omitted by host.] ${redacted.slice(-edgeSize)}`;
}

/** Host-produced results for this task only. */
export function boundedTaskEvidence(history: readonly ChatMessage[], rootTaskId: string, targetId: string, hideToolResultBodies = false): string[] {
  const items: string[] = [];
  for (const message of history.filter(item => item.userTask?.id === rootTaskId)) {
    for (const review of message.runDetails?.approvalReviews ?? []) {
      if (review.targetId === targetId || review.decision !== 'approve') items.push(JSON.stringify({
        type: 'prior_approval', targetId: review.targetId, decision: review.decision,
        reason: hideToolResultBodies ? undefined : redactSensitiveReviewText(review.rationale, 600),
        alternative: hideToolResultBodies || !review.saferAlternative ? undefined : redactSensitiveReviewText(review.saferAlternative, 600)
      }));
    }
    for (const tool of (message.runDetails?.toolCalls ?? []).slice(-4)) {
      items.push(JSON.stringify({ type: 'actual_tool_result', name: tool.name, status: tool.status,
        result: hideToolResultBodies ? undefined : redactSensitiveReviewText(tool.resultSummary ?? '', 600) }));
    }
  }
  const selected = items.slice(-8);
  if (items.length > selected.length) selected.unshift('[Earlier task evidence omitted by the host context limit.]');
  return selected;
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
