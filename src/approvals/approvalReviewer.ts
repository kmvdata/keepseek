import { createHmac, randomBytes } from 'node:crypto';
import { OneShotTextRequestError } from '../agent/oneShotTextRequest';
import { ExecutionBudgetError, LogicalBudgetExceededError } from '../agent/executionPolicy';
import { isRecoverableNetworkError } from '../agent/providers/networkErrors';
import type { ModelSourceConfigSnapshot } from '../accounts/types';
import { getAutoApprovalReviewerSetting, getConfiguredModelRequestTimeoutMs, InvalidApprovalReviewerSettingError } from '../shared/config';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../accounts/accountStore';
import { MissingModelSourceApiKeyError } from '../accounts/accountResolver';
import { requiresModelSourceApiKey } from '../accounts/sourceCapabilities';
import { resolveConfiguredSubagentModel, UnavailableSubagentModelError } from '../accounts/subagentModelResolver';
import type { AgentRequest, KeepseekModel, ProviderUsageLedgerRecord, UsageEvent } from '../shared/types';
import { AUTO_APPROVAL_REVIEWER_SYSTEM_PROMPT, ApprovalAffectedScopeError, findDeterministicReviewDenial, hasIncompleteAutomaticReviewEvidence, parseAutoApprovalReviewerJson, redactSensitiveReviewText, serializeApprovalReviewRequest } from './approvalPolicy';
import { requestApprovalReviewText } from './oneShotTextRequest';
import { APPROVAL_POLICY_VERSION, approvalDisposition, type ApprovalAuthorizationSource, type ApprovalReviewerJson, type ApprovalReviewOutcome, type ApprovalReviewRecord, type ApprovalReviewRequest, type ApprovalReviewState } from './approvalReviewTypes';
import { ApprovalAuditError, ApprovalReviewStore } from './approvalReviewStore';
import type { ApprovalCircuitBreaker } from './approvalCircuitBreaker';

export interface ApprovalReviewerModelContext {
  model?: KeepseekModel;
  sourceConfig?: ModelSourceConfigSnapshot;
  taskCostBudget?: AgentRequest['taskCostBudget'];
  taskRunBudget?: AgentRequest['taskRunBudget'];
}

export interface ApprovalReviewerAdapter {
  review(request: ApprovalReviewRequest, modelContext?: ApprovalReviewerModelContext, signal?: AbortSignal,
    onStart?: (record: ApprovalReviewRecord) => void): Promise<ApprovalReviewOutcome>;
  findHistoricalDenial?(request: ApprovalReviewRequest): ApprovalReviewRecord | undefined;
  createUserApproval?(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalReviewOutcome>;
  createUserRejection?(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalReviewRecord>;
  assertReviewerConfiguration?(request: ApprovalReviewRequest, context: ApprovalReviewerModelContext | undefined, record: ApprovalReviewRecord): Promise<void>;
  consumeApproval(record: ApprovalReviewRecord, expectedSource: ApprovalAuthorizationSource): Promise<void>;
}

export class ApprovalReviewerService implements ApprovalReviewerAdapter {
  private readonly configBindingKey = randomBytes(32);

  public constructor(private readonly options: {
    globalStorageUri: import('vscode').Uri;
    workspaceKey: string;
    sourceStore: ModelSourceStore;
    store: ApprovalReviewStore;
    onUsage?: (event: UsageEvent, sessionId: string) => void;
    onUsageLedgerRecord?: (record: ProviderUsageLedgerRecord, sessionId: string) => Promise<void> | void;
    requestText?: typeof requestApprovalReviewText;
    circuitBreaker?: ApprovalCircuitBreaker;
    getAutoSetting?: typeof getAutoApprovalReviewerSetting;
  }) {}

  private async resolveReviewer(request: ApprovalReviewRequest, context?: ApprovalReviewerModelContext) {
    let setting: ReturnType<typeof getAutoApprovalReviewerSetting>;
    try {
      setting = (this.options.getAutoSetting ?? getAutoApprovalReviewerSetting)();
    } catch (error) {
      if (!(error instanceof InvalidApprovalReviewerSettingError)) throw error;
      return { status: 'unavailable' as const, error, configFingerprint: createHmac('sha256', this.configBindingKey)
        .update(JSON.stringify(['invalid', error.setting])).digest('hex') };
    }
    const parentRequest = context?.model ? { model: context.model, sourceConfig: context.sourceConfig } : undefined;
    const fingerprint = (resolved: unknown) => createHmac('sha256', this.configBindingKey)
      // Runtime-keyed digests bind credential rotations without persisting credentials or a reusable secret hash.
      .update(JSON.stringify([setting, setting.mode === 'follow-main' ? parentRequest : undefined, resolved])).digest('hex');
    try {
      const resolved = await resolveConfiguredSubagentModel({
        globalStorageUri: this.options.globalStorageUri, workspaceKey: this.options.workspaceKey,
        sourceStore: this.options.sourceStore, parentRequest, language: request.responseLanguage,
        setting, autoApproval: true
      });
      if (!resolved.sourceConfig.apiKey.trim() && requiresModelSourceApiKey(resolved.sourceConfig)) {
        throw new MissingModelSourceApiKeyError(request.responseLanguage);
      }
      return { status: 'resolved' as const, ...resolved, configFingerprint: fingerprint(resolved) };
    } catch (error) {
      if (!(error instanceof MissingModelSourceApiKeyError || error instanceof UnavailableSubagentModelError)) throw error;
      return { status: 'unavailable' as const, error, configFingerprint: fingerprint(error.message) };
    }
  }

  public async assertReviewerConfiguration(request: ApprovalReviewRequest, context: ApprovalReviewerModelContext | undefined,
    record: ApprovalReviewRecord): Promise<void> {
    const resolved = await this.resolveReviewer(request, context);
    const matches = record.reviewerConfigFingerprint === resolved.configFingerprint
      && (resolved.status === 'unavailable' ? record.reviewState === 'configuration_unavailable'
        : record.reviewerModelId === resolved.model.id && record.reviewerSourceId === resolved.sourceConfig.sourceId
          && record.reviewerProvider === resolved.sourceConfig.provider);
    if (!matches) throw new Error('Reviewer configuration changed. Nothing executed. / 审查模型配置已变化，未执行。');
  }

  public findHistoricalDenial(request: ApprovalReviewRequest): ApprovalReviewRecord | undefined {
    for (const actionHash of [request.actionHash, originalActionHash(request), ...(request.historicalActionHashes ?? [])]) {
      if (!actionHash) continue;
      const identity = { ...request, actionHash };
      const denial = this.options.store.findSafetyDenial(identity) ?? this.options.store.findDenialForAction(identity);
      if (denial) return denial;
    }
    return undefined;
  }

  public async review(
    request: ApprovalReviewRequest,
    modelContext?: ApprovalReviewerModelContext,
    signal?: AbortSignal,
    onStart?: (record: ApprovalReviewRecord) => void
  ): Promise<ApprovalReviewOutcome> {
    throwIfCancelled(signal);
    if (!request.workspaceTrusted || !vscode.workspace.isTrusted) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, 'workspace_untrusted'));
    }
    const previousDenial = this.findHistoricalDenial(request);
    if (previousDenial) return this.blockPreviouslyDenied(request, previousDenial);
    const deterministicDenial = findDeterministicReviewDenial(request);
    if (deterministicDenial) {
      return this.withCircuit(request, 'reviewed', await this.createLocalDenial(request, deterministicDenial));
    }
    if (hasIncompleteAutomaticReviewEvidence(request)) {
      return this.createPause(request, 'insufficient_evidence', 'insufficient_evidence', request.responseLanguage === 'en'
        ? 'Material approval evidence is missing or truncated. Nothing executed.'
        : '审批关键材料缺失或已截断，尚未执行。');
    }
    const circuit = this.restoreCircuit(request);
    if (circuit?.tripped) return this.createCircuitStop(request, circuit.reason);
    // The atomic claim survives interruption and prevents parallel callers from owning the same operation.
    const claim = await this.options.store.claimAutomaticReview({
      ...reviewIdentity(request), approvalSource: 'auto_approval_review', decision: 'unavailable',
      reviewerSourceId: '', reviewerModelId: '', reviewerProvider: '', risk: 'high', reviewState: 'in_progress',
      rationale: request.responseLanguage === 'en' ? 'Independent review started. No permit has been issued.' : '独立审批审查已开始，尚未签发执行许可。',
      policyRules: ['review_in_progress']
    });
    if (claim.status === 'denied') return this.blockPreviouslyDenied(request, claim.record);
    if (claim.status === 'duplicate') {
      return { status: 'unavailable', record: { ...claim.record, decision: 'unavailable',
        reviewState: claim.record.reviewState === 'in_progress' ? 'in_progress' : 'interrupted',
        rationale: request.responseLanguage === 'en' ? 'Independent review was already claimed for this operation.' : '该精确操作已被认领进行独立审查。',
        policyRules: ['review_already_attempted'] } };
    }
    try {
      throwIfCancelled(signal);
      onStart?.(claim.record);
      return await this.reviewClaim(request, modelContext, signal);
    } finally {
      this.options.store.finishAutomaticReview(claim.record.reviewId);
    }
  }

  private async reviewClaim(request: ApprovalReviewRequest, modelContext?: ApprovalReviewerModelContext,
    signal?: AbortSignal): Promise<ApprovalReviewOutcome> {
    const deadlineAt = Date.now() + getConfiguredModelRequestTimeoutMs();
    try { assertReviewBudget(modelContext); }
    catch (error) {
      if (!isApprovalBudgetFailure(error)) throw error;
      return this.createBudgetStop(request, error);
    }
    const resolved = await this.resolveReviewer(request, modelContext);
    throwIfCancelled(signal);
    try { assertReviewBudget(modelContext); }
    catch (error) {
      if (!isApprovalBudgetFailure(error)) throw error;
      return this.createBudgetStop(request, error);
    }
    if (resolved.status === 'unavailable') {
      return this.createUnavailable(request, resolved, resolved.error, 'configuration_unavailable', 'review_configuration_unavailable');
    }
    const serialized = serializeApprovalReviewRequest(request);
    let scopeMismatch = false;
    for (let attempt = 0; ; attempt++) {
      let decision: ApprovalReviewerJson;
      try {
        throwIfCancelled(signal);
        assertReviewBudget(modelContext);
        const circuit = this.restoreCircuit(request);
        if (circuit?.tripped) return this.createCircuitStop(request, circuit.reason);
        if (Date.now() >= deadlineAt) throw new OneShotTextRequestError('timeout', 'Approval review deadline reached. / 已达到审批审查时限。');
        const raw = await (this.options.requestText ?? requestApprovalReviewText)({
          model: resolved.model, sourceConfig: resolved.sourceConfig, globalStorageUri: this.options.globalStorageUri,
          taskCostBudget: modelContext?.taskCostBudget, taskRunBudget: modelContext?.taskRunBudget,
          systemPrompt: AUTO_APPROVAL_REVIEWER_SYSTEM_PROMPT, userPrompt: serialized, language: request.responseLanguage,
          signal, deadlineAt, sessionId: request.sessionId, taskId: request.rootTaskId, runId: request.agentRunId,
          onUsage: event => this.options.onUsage?.(event, request.sessionId),
          onUsageLedgerRecord: record => this.options.onUsageLedgerRecord?.(record, request.sessionId)
        });
        throwIfCancelled(signal);
        try { decision = parseAutoApprovalReviewerJson(raw, request); }
        catch (error) {
          scopeMismatch ||= error instanceof ApprovalAffectedScopeError;
          throw new OneShotTextRequestError('invalid', error instanceof Error ? error.message : 'Invalid review response.');
        }
        if (decision.decision !== 'deny') assertReviewDeadline(modelContext, deadlineAt);
      } catch (error) {
        throwIfCancelled(signal);
        if (isApprovalBudgetFailure(error)) return this.createBudgetStop(request, error);
        const providerError = error instanceof OneShotTextRequestError ? error
          : isRecoverableNetworkError(error) && error instanceof Error
            ? new OneShotTextRequestError('unavailable', error.message, true) : undefined;
        if (!providerError) throw error;
        if (providerError.reason === 'save_failed') throw new ApprovalAuditError(providerError);
        if (!['timeout', 'invalid', 'unavailable'].includes(providerError.reason)) throw error;
        if (Date.now() >= (modelContext?.taskRunBudget?.deadlineAt ?? Infinity)) {
          return this.createBudgetStop(request, new LogicalBudgetExceededError('run_time_budget_exhausted'));
        }
        if (modelContext?.taskCostBudget?.exhausted) {
          return this.createBudgetStop(request, new LogicalBudgetExceededError('provider_cost_budget_exhausted'));
        }
        if (!attempt && Date.now() < deadlineAt && (providerError.retryable || providerError.reason === 'invalid')) continue;
        if (scopeMismatch) return this.createUnavailable(request, resolved, new Error(request.responseLanguage === 'en'
          ? 'The reviewer reported an affected target outside the exact operation scope.' : '审批模型报告的受影响目标超出精确操作范围。'),
        'insufficient_evidence', 'review_affected_scope_mismatch');
        if (providerError.reason === 'timeout') return this.createUnavailable(request, resolved, providerError, 'timeout', 'review_timeout');
        if (providerError.reason === 'invalid') return this.createUnavailable(request, resolved, providerError, 'invalid_response', 'invalid_review_response');
        return this.createUnavailable(request, resolved, providerError, 'service_unavailable', 'reviewer_unavailable');
      }
      const outcome = applyHostDecisionPolicy(decision, request.responseLanguage);
      const record = await this.options.store.add({
        ...reviewIdentity(request), approvalSource: 'auto_approval_review',
        reviewerConfigFingerprint: resolved.configFingerprint, reviewerSourceId: resolved.sourceConfig.sourceId,
        reviewerModelId: resolved.model.id, reviewerProvider: resolved.sourceConfig.provider,
        decision: outcome.decision, risk: outcome.risk, rationale: redactSensitiveReviewText(outcome.reason, 800),
        policyRules: outcome.policyRules, affectedTargets: outcome.affectedTargets?.map(target => redactSensitiveReviewText(target, 300)),
        saferAlternative: outcome.saferAlternative ? redactSensitiveReviewText(outcome.saferAlternative) : undefined,
        reviewState: outcome.decision === 'needs_user' && outcome.policyRules.includes('insufficient_evidence') ? 'insufficient_evidence' : undefined
      });
      throwIfCancelled(signal);
      return this.withCircuit(request, 'reviewed', record);
    }
  }

  private blockPreviouslyDenied(request: ApprovalReviewRequest, record: ApprovalReviewRecord): Promise<ApprovalReviewOutcome> {
    // A click rejecting a request remains a user decision and does not become a safety refusal.
    if (record.approvalSource === 'user_click') return Promise.resolve({ status: 'reviewed', record });
    return this.createLocalDenial(request, 'previously_denied_action', record.saferAlternative)
      .then(denial => this.withCircuit(request, 'reviewed', denial));
  }

  public async consumeApproval(record: ApprovalReviewRecord, expectedSource: ApprovalAuthorizationSource): Promise<void> {
    if (record.runtimeId !== this.options.store.runtimeId) throw new Error('No current matching approval record exists for this exact operation.');
    await this.options.store.consumeMatchingApproval({
      reviewId: record.reviewId,
      sessionId: record.sessionId,
      rootTaskId: record.rootTaskId,
      agentRunId: record.agentRunId,
      targetId: record.targetId,
      actionKind: record.actionKind,
      actionHash: record.actionHash,
      policyVersion: record.policyVersion,
      approvalMode: record.approvalMode,
      scopeFingerprint: record.scopeFingerprint,
      expectedSource,
      reviewerConfigFingerprint: record.reviewerConfigFingerprint,
      workspaceTrusted: vscode.workspace.isTrusted
    });
  }

  private async createPause(request: ApprovalReviewRequest, reviewState: ApprovalReviewState, rule: string,
    reason: string): Promise<ApprovalReviewOutcome> {
    const record = await this.options.store.add({
      ...reviewIdentity(request), approvalSource: 'local_policy', reviewerSourceId: '', reviewerModelId: '',
      reviewerProvider: 'local_policy', decision: 'needs_user', risk: 'high', rationale: redactSensitiveReviewText(reason),
      policyRules: [rule], reviewState
    });
    return { status: 'reviewed', record };
  }

  private createBudgetStop(request: ApprovalReviewRequest, error: unknown): Promise<ApprovalReviewOutcome> {
    const reason = error instanceof Error ? error.message : String(error);
    return this.createPause(request, 'budget_stopped', 'approval_budget_exhausted', request.responseLanguage === 'en'
      ? `Approval stopped at the task budget boundary. Nothing executed. ${reason}`
      : `审批已在任务预算边界停止，尚未执行。${reason}`);
  }

  private async createCircuitStop(request: ApprovalReviewRequest,
    reason: ApprovalReviewOutcome['circuitBreakReason']): Promise<ApprovalReviewOutcome> {
    const stopped = await this.createPause(request, 'circuit_stopped', 'approval_circuit_stopped', request.responseLanguage === 'en'
      ? 'The approval refusal limit has been reached. Nothing executed.' : '已达到审批拒绝熔断阈值，尚未执行。');
    return { ...stopped, circuitBreakReason: reason };
  }

  public async createUserApproval(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalReviewOutcome> {
    const reviewed = link.priorReviewId ? this.options.store.get(link.priorReviewId) : undefined;
    if (!link.userRequestId || !reviewed || reviewed.runtimeId !== this.options.store.runtimeId
      || !this.options.store.matchesSnapshot(reviewed.reviewId, request)
      || !canUseManualReview(reviewed, request)) {
      throw new Error('No live matching user request review exists. Nothing executed. / 缺少本次人工请求的有效审查记录，未执行。');
    }
    const prior = this.findHistoricalDenial(request);
    if (prior) return this.blockPreviouslyDenied(request, prior);
    const denial = !request.workspaceTrusted || !vscode.workspace.isTrusted ? 'workspace_untrusted' : findDeterministicReviewDenial(request);
    if (denial) return { status: 'reviewed', record: await this.createLocalDenial(request, denial) };
    const record = await this.options.store.add({
      ...reviewIdentity(request), ...link,
      approvalSource: 'user_click', reviewerSourceId: '', reviewerModelId: '', reviewerProvider: 'user_click',
      reviewerConfigFingerprint: reviewed.reviewerConfigFingerprint,
      decision: 'approve', risk: reviewed.risk, policyRules: ['user_confirmed_exact_action'],
      rationale: request.responseLanguage === 'en' ? 'User confirmed this exact operation once.' : '用户已对该精确操作作出单次确认。'
    });
    return { status: 'reviewed', record };
  }

  public async createUserRejection(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalReviewRecord> {
    const reviewed = link.priorReviewId ? this.options.store.get(link.priorReviewId) : undefined;
    if (!link.userRequestId || !reviewed || !this.options.store.matchesSnapshot(reviewed.reviewId, request)
      || !canUseManualReview(reviewed, request)) {
      throw new Error('No live matching user request review exists. Nothing executed. / 缺少本次人工请求的有效审查记录，未执行。');
    }
    return this.options.store.add({ ...reviewIdentity(request), approvalSource: 'user_click', ...link,
      reviewerSourceId: '', reviewerModelId: '', reviewerProvider: 'user_click',
      reviewerConfigFingerprint: reviewed.reviewerConfigFingerprint,
      decision: 'deny', risk: 'medium', rationale: request.responseLanguage === 'en' ? 'User rejected this operation.' : '用户已拒绝本次操作。',
      policyRules: ['user_rejected_exact_action'] });
  }

  private async createLocalDenial(request: ApprovalReviewRequest, rule: string, saferAlternative?: string) {
    return await this.options.store.add({
      ...reviewIdentity(request), approvalSource: 'local_policy',
      reviewerSourceId: '',
      reviewerModelId: '',
      reviewerProvider: 'local_policy',
      decision: 'deny',
      risk: 'critical',
      rationale: formatLocalPolicyRationale(rule, request.responseLanguage),
      policyRules: [rule],
      saferAlternative: saferAlternative ?? (request.responseLanguage === 'en'
        ? 'Remove the unsafe material or narrow the operation and submit a new action.'
        : '移除不安全材料或缩小操作范围后，提交新的操作。')
    });
  }

  private async createUnavailable(request: ApprovalReviewRequest,
    resolved: Awaited<ReturnType<ApprovalReviewerService['resolveReviewer']>>, error: Error,
    reviewState: ApprovalReviewState, rule: string): Promise<ApprovalReviewOutcome> {
    const model = resolved.status === 'resolved' ? resolved : undefined;
    const message = redactSensitiveReviewText(error.message);
    const record = await this.options.store.add({
      ...reviewIdentity(request), approvalSource: 'auto_approval_review',
      reviewerConfigFingerprint: resolved.configFingerprint, reviewerSourceId: model?.sourceConfig.sourceId ?? '',
      reviewerModelId: model?.model.id ?? '', reviewerProvider: model?.sourceConfig.provider ?? '',
      decision: 'unavailable', risk: 'high', reviewState,
      rationale: request.responseLanguage === 'en'
        ? `Approval model unavailable; operation did not run: ${message}`
        : `审批模型不可用，操作尚未执行：${message}`,
      policyRules: [rule]
    });
    return this.withCircuit(request, 'unavailable', record);
  }

  private restoreCircuit(request: ApprovalReviewRequest, beforeReviewId?: string) {
    const key = JSON.stringify([request.sessionId, request.rootTaskId]);
    const breaker = this.options.circuitBreaker;
    breaker?.restore(key, this.options.store.decisionHistory(request.sessionId, request.rootTaskId, beforeReviewId));
    return breaker?.current(key);
  }

  private withCircuit(
    request: ApprovalReviewRequest,
    status: ApprovalReviewOutcome['status'],
    record: ApprovalReviewRecord
  ): ApprovalReviewOutcome {
    const key = JSON.stringify([request.sessionId, request.rootTaskId]);
    const existing = this.restoreCircuit(request, record.reviewId);
    const state = this.options.circuitBreaker?.record(key, record.decision);
    return { status, record, circuitBreakReason: existing?.reason ?? state?.reason };
  }
}

function reviewIdentity(request: ApprovalReviewRequest) {
  return {
    sessionId: request.sessionId, rootTaskId: request.rootTaskId, agentRunId: request.agentRunId,
    targetId: request.targetId, actionKind: request.actionKind, actionHash: request.actionHash, effectHash: request.effectHash,
    policyVersion: APPROVAL_POLICY_VERSION, approvalMode: request.approvalMode, scopeFingerprint: request.scopeFingerprint,
    originalActionHash: originalActionHash(request),
    osIsolation: request.actionKind === 'draft_run_execute' || request.actionKind === 'validation_run' ? 'none' as const : undefined
  };
}

function canUseManualReview(reviewed: ApprovalReviewRecord, request: ApprovalReviewRequest): boolean {
  const disposition = approvalDisposition(reviewed);
  return disposition === 'request_user' || (disposition === 'execute' && request.externalAuthorization?.required === true);
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Approval review cancelled.');
}

function assertReviewBudget(context?: ApprovalReviewerModelContext): void {
  context?.taskRunBudget?.assertCanDispatch();
  if (context?.taskCostBudget?.exhausted) throw new LogicalBudgetExceededError('provider_cost_budget_exhausted');
}

function assertReviewDeadline(context: ApprovalReviewerModelContext | undefined, deadlineAt: number): void {
  if (Date.now() >= (context?.taskRunBudget?.deadlineAt ?? Infinity)) {
    throw new LogicalBudgetExceededError('run_time_budget_exhausted');
  }
  if (Date.now() >= deadlineAt) throw new OneShotTextRequestError('timeout', 'Approval review deadline reached. / 已达到审批审查时限。');
}

function isApprovalBudgetFailure(error: unknown): boolean {
  return error instanceof LogicalBudgetExceededError || error instanceof ExecutionBudgetError
    || (error instanceof OneShotTextRequestError && ['unpriced_cost', 'budget_exhausted', 'budget_missing'].includes(error.reason));
}

function applyHostDecisionPolicy(decision: ApprovalReviewerJson, language: ApprovalReviewRequest['responseLanguage']): ApprovalReviewerJson {
  if (decision.decision !== 'approve' || (decision.risk !== 'high' && decision.risk !== 'critical')) return decision;
  const rule = 'high_risk_requires_user';
  return {
    ...decision, decision: 'needs_user', policyRules: [rule, ...decision.policyRules.filter(value => value !== rule).slice(0, 15)],
    reason: language === 'en'
      ? `Host policy prohibits automatic approval at the reported risk level. ${decision.reason}`
      : `宿主规则禁止在此风险等级自动批准。${decision.reason}`
  };
}

export function toReviewerModelContext(request: AgentRequest): ApprovalReviewerModelContext {
  return { model: request.model, sourceConfig: request.sourceConfig, taskCostBudget: request.taskCostBudget, taskRunBudget: request.taskRunBudget };
}

function formatLocalPolicyRationale(rule: string, language: ApprovalReviewRequest['responseLanguage']): string {
  const descriptions: Record<string, { en: string; zh: string }> = {
    insufficient_evidence: { en: 'approval evidence is incomplete, redacted or over the size limit', zh: '审批证据不完整、已脱敏或超出长度上限' },
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
    unsupported_external_uri: { en: 'the external URI form is not supported', zh: '外部 URI 形式不受支持' },
    unsupported_operation_uri: { en: 'the operation URI form is not supported', zh: '操作 URI 形式不受支持' }
  };
  const description = descriptions[rule];
  return language === 'en'
    ? `Denied by a deterministic safety check: ${description?.en ?? rule}.`
    : `确定性安全检查已拒绝：${description?.zh ?? rule}。`;
}

function originalActionHash(request: ApprovalReviewRequest): string | undefined {
  return request.exactAction.kind === 'draft_run_execute' ? request.exactAction.restricted?.original.specHash : undefined;
}
