import type { ModelSourceConfigSnapshot } from '../accounts/types';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../accounts/accountStore';
import { resolveConfiguredSubagentModel } from '../accounts/subagentModelResolver';
import type { AgentRequest, KeepseekModel, UsageEvent } from '../shared/types';
import { APPROVAL_REVIEWER_SYSTEM_PROMPT, findDeterministicReviewDenial, parseApprovalReviewerJson, redactSensitiveReviewText, serializeApprovalReviewRequest } from './approvalPolicy';
import { requestApprovalReviewText } from './oneShotTextRequest';
import { APPROVAL_POLICY_VERSION, type ApprovalReviewOutcome, type ApprovalReviewRecord, type ApprovalReviewRequest } from './approvalReviewTypes';
import { ApprovalReviewStore } from './approvalReviewStore';
import type { ApprovalCircuitBreaker } from './approvalCircuitBreaker';

export interface ApprovalReviewerModelContext {
  model: KeepseekModel;
  sourceConfig?: ModelSourceConfigSnapshot;
}

export interface ApprovalReviewerAdapter {
  review(request: ApprovalReviewRequest, modelContext: ApprovalReviewerModelContext, signal?: AbortSignal): Promise<ApprovalReviewOutcome>;
  createHostPolicyApproval(request: ApprovalReviewRequest): Promise<ApprovalReviewOutcome>;
  consumeApproval(record: ApprovalReviewRecord, approvalMode: 'model_review' | 'delegate'): Promise<void>;
}

export class ApprovalReviewerService implements ApprovalReviewerAdapter {
  public constructor(private readonly options: {
    globalStorageUri: import('vscode').Uri;
    workspaceKey: string;
    sourceStore: ModelSourceStore;
    store: ApprovalReviewStore;
    onUsage?: (event: UsageEvent) => void;
    requestText?: typeof requestApprovalReviewText;
    circuitBreaker?: ApprovalCircuitBreaker;
  }) {}

  public async review(
    request: ApprovalReviewRequest,
    modelContext: ApprovalReviewerModelContext,
    signal?: AbortSignal
  ): Promise<ApprovalReviewOutcome> {
    if (signal?.aborted) throw signal.reason ?? new Error('Approval review cancelled.');
    if (!request.workspaceTrusted) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, 'workspace_untrusted'));
    }
    if (this.options.store.findCurrentRuntimeDenialForAction({
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      actionKind: request.actionKind,
      actionHash: request.actionHash
    })) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, 'previously_denied_action'));
    }
    const deterministicDenial = findDeterministicReviewDenial(request);
    if (deterministicDenial) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, deterministicDenial));
    }
    const serialized = serializeApprovalReviewRequest(request);

    let resolved: Awaited<ReturnType<typeof resolveConfiguredSubagentModel>>;
    try {
      resolved = await resolveConfiguredSubagentModel({
        globalStorageUri: this.options.globalStorageUri,
        workspaceKey: this.options.workspaceKey,
        sourceStore: this.options.sourceStore,
        parentRequest: modelContext,
        language: request.responseLanguage
      });
    } catch (error) {
      // Resolution failed before any reviewer request was made. Do not label
      // the parent model as the reviewer; that would look like a silent
      // fallback even though execution correctly failed closed.
      return await this.createUnavailable(request, undefined, error);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await (this.options.requestText ?? requestApprovalReviewText)({
          model: resolved.model,
          sourceConfig: resolved.sourceConfig,
          systemPrompt: APPROVAL_REVIEWER_SYSTEM_PROMPT,
          userPrompt: serialized,
          language: request.responseLanguage,
          signal,
          onUsage: this.options.onUsage
        });
        const decision = parseApprovalReviewerJson(raw);
        const record = await this.options.store.add({
          sessionId: request.sessionId,
          rootTaskId: request.rootTaskId,
          agentRunId: request.agentRunId,
          targetId: request.targetId,
          actionKind: request.actionKind,
          actionHash: request.actionHash,
          policyVersion: APPROVAL_POLICY_VERSION,
          approvalSource: 'model_review',
          reviewerSourceId: resolved.sourceConfig.sourceId,
          reviewerModelId: resolved.model.id,
          reviewerProvider: resolved.sourceConfig.provider,
          decision: decision.decision,
          risk: decision.risk,
          rationale: redactSensitiveReviewText(decision.reason),
          policyRules: decision.policyRules,
          saferAlternative: decision.saferAlternative ? redactSensitiveReviewText(decision.saferAlternative) : undefined
        });
        return this.withCircuit(request, 'reviewed', record);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        lastError = error;
      }
    }
    return await this.createUnavailable(request, resolved, lastError);
  }

  public async createHostPolicyApproval(request: ApprovalReviewRequest): Promise<ApprovalReviewOutcome> {
    if (!request.workspaceTrusted) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, 'workspace_untrusted'));
    }
    if (this.options.store.findCurrentRuntimeDenialForAction({
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      actionKind: request.actionKind,
      actionHash: request.actionHash
    })) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, 'previously_denied_action'));
    }
    const deterministicDenial = findDeterministicReviewDenial(request);
    if (deterministicDenial) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, deterministicDenial));
    }
    const record = await this.options.store.add({
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: APPROVAL_POLICY_VERSION,
      approvalSource: 'host_policy',
      reviewerSourceId: '',
      reviewerModelId: '',
      reviewerProvider: 'host_policy',
      decision: 'approve',
      risk: 'high',
      rationale: request.responseLanguage === 'en'
        ? 'Automatically approved by host policy without model review.'
        : '由宿主策略自动批准，未经模型审查。',
      policyRules: ['host_auto_approval']
    });
    return this.withCircuit(request, 'reviewed', record);
  }

  public async consumeApproval(record: ApprovalReviewRecord, approvalMode: 'model_review' | 'delegate'): Promise<void> {
    await this.options.store.consumeMatchingApproval({
      reviewId: record.reviewId,
      sessionId: record.sessionId,
      agentRunId: record.agentRunId,
      targetId: record.targetId,
      actionKind: record.actionKind,
      actionHash: record.actionHash,
      policyVersion: record.policyVersion,
      approvalMode,
      workspaceTrusted: vscode.workspace.isTrusted
    });
  }

  private async createLocalDenial(request: ApprovalReviewRequest, rule: string) {
    return await this.options.store.add({
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: APPROVAL_POLICY_VERSION,
      approvalSource: 'local_policy',
      reviewerSourceId: '',
      reviewerModelId: '',
      reviewerProvider: 'local_policy',
      decision: 'deny',
      risk: 'critical',
      rationale: formatLocalPolicyRationale(rule, request.responseLanguage),
      policyRules: [rule],
      saferAlternative: request.responseLanguage === 'en'
        ? 'Remove the unsafe material or narrow the operation and submit a new action.'
        : '移除不安全材料或缩小操作范围后，提交新的操作。'
    });
  }

  private async createUnavailable(
    request: ApprovalReviewRequest,
    modelContext: ApprovalReviewerModelContext | Awaited<ReturnType<typeof resolveConfiguredSubagentModel>> | undefined,
    error: unknown
  ): Promise<ApprovalReviewOutcome> {
    const sourceConfig = modelContext?.sourceConfig;
    const message = redactSensitiveReviewText(error instanceof Error ? error.message : String(error ?? 'unknown'));
    const record = await this.options.store.add({
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: APPROVAL_POLICY_VERSION,
      approvalSource: 'model_review',
      reviewerSourceId: sourceConfig?.sourceId ?? '',
      reviewerModelId: modelContext?.model.id ?? '',
      reviewerProvider: sourceConfig?.provider ?? modelContext?.model.provider ?? '',
      decision: 'unavailable',
      risk: 'high',
      rationale: request.responseLanguage === 'en'
        ? `Approval model unavailable after one retry: ${message}`
        : `审批模型重试一次后仍不可用：${message}`,
      policyRules: ['reviewer_unavailable']
    });
    return this.withCircuit(request, 'unavailable', record);
  }

  private withCircuit(
    request: ApprovalReviewRequest,
    status: ApprovalReviewOutcome['status'],
    record: ApprovalReviewRecord
  ): ApprovalReviewOutcome {
    const result = record.decision === 'approve' ? 'approve' : record.decision === 'deny' ? 'deny' : 'unavailable';
    const state = this.options.circuitBreaker?.record(request.rootTaskId, result);
    return { status, record, circuitBreakReason: state?.tripped ? state.reason : undefined };
  }
}

export function toReviewerModelContext(request: AgentRequest): ApprovalReviewerModelContext {
  return { model: request.model, sourceConfig: request.sourceConfig };
}

function formatLocalPolicyRationale(rule: string, language: ApprovalReviewRequest['responseLanguage']): string {
  const descriptions: Record<string, { en: string; zh: string }> = {
    workspace_untrusted: { en: 'the workspace is not trusted', zh: '当前工作区不受信任' },
    previously_denied_action: { en: 'this exact action was already denied', zh: '这项精确操作此前已被拒绝' },
    suspected_credential_material: { en: 'the request may contain credential material', zh: '申请中可能包含凭据材料' },
    suspected_credential_probe: { en: 'the action may probe credentials or authentication files', zh: '操作可能探测凭据或认证文件' },
    approval_bypass_attempt: { en: 'the action may bypass or weaken approval safeguards', zh: '操作可能绕过或削弱审批保护' },
    unregistered_approval_action: { en: 'the action kind is not registered', zh: '操作类型未注册' },
    invalid_approval_identity: { en: 'the approval identity is incomplete', zh: '审批身份字段不完整' },
    approval_action_kind_mismatch: { en: 'the action kind does not match its exact payload', zh: '操作类型与精确内容不匹配' },
    unsupported_validation: { en: 'the validation form is not supported', zh: '验证形式不受支持' },
    draft_run_hash_mismatch: { en: 'the DraftRun hash changed', zh: 'DraftRun 哈希已变化' },
    unsupported_external_uri: { en: 'the external URI form is not supported', zh: '外部 URI 形式不受支持' }
  };
  const description = descriptions[rule];
  return language === 'en'
    ? `Denied by a deterministic safety check: ${description?.en ?? rule}.`
    : `确定性安全检查已拒绝：${description?.zh ?? rule}。`;
}
