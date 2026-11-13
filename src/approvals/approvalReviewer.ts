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
import { AUTO_APPROVAL_REVIEWER_SYSTEM_PROMPT, PROJECT_POLICY_CORRECTION, ApprovalAffectedScopeError, ApprovalResponseFormatError,
  findDeterministicReviewDenial, isProjectBehaviorOnlyEscalation, isVerifiedProjectOperation, parseAutoApprovalReviewerJson,
  prepareAutomaticReviewEvidence, redactSensitiveReviewText, reviewResponseCorrection, verifiedBusinessAuthorization } from './approvalPolicy';
import { requestApprovalReviewText } from './oneShotTextRequest';
import { APPROVAL_POLICY_VERSION, AUTHORIZED_BUSINESS_EFFECT_RULE, EXACT_USER_AUTHORIZATION_RULE,
  PROJECT_BEHAVIOR_UNKNOWN_RULE, VERIFIED_PROJECT_OPERATION_RULE,
  USER_CONFIRMABLE_RISK_RULE, type ApprovalReviewAttemptFailure,
  approvalDisposition, type ApprovalAuthorizationSource, type ApprovalReviewerJson, type ApprovalReviewOutcome,
  type ApprovalReviewRecord, type ApprovalReviewRequest, type ApprovalReviewState, type ApprovalUserAuthorizationReceipt } from './approvalReviewTypes';
import { ApprovalAuditError, ApprovalReviewStore } from './approvalReviewStore';
import { hashApprovalValue, hashExternalFileReviewAction } from './approvalReviewHash';
import type { ApprovalCircuitBreaker } from './approvalCircuitBreaker';

export interface ApprovalReviewerModelContext {
  model?: KeepseekModel;
  sourceConfig?: ModelSourceConfigSnapshot;
  taskCostBudget?: AgentRequest['taskCostBudget'];
  taskRunBudget?: AgentRequest['taskRunBudget'];
}

interface ApprovalReviewRetry {
  retryOf: string;
  /** The execution owner proved that the previous host never dispatched this action. */
  recovery?: 'not_dispatched';
}

export interface ApprovalReviewerAdapter {
  review(request: ApprovalReviewRequest, modelContext?: ApprovalReviewerModelContext, signal?: AbortSignal,
    onStart?: (record: ApprovalReviewRecord) => void, options?: ApprovalReviewRetry): Promise<ApprovalReviewOutcome>;
  findHistoricalDenial?(request: ApprovalReviewRequest): ApprovalReviewRecord | undefined;
  createUserAuthorization?(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalUserAuthorizationReceipt>;
  createUserRejection?(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalReviewRecord>;
  assertReviewerConfiguration?(request: ApprovalReviewRequest, context: ApprovalReviewerModelContext | undefined, record: ApprovalReviewRecord): Promise<void>;
  consumeApproval(record: ApprovalReviewRecord, expectedSource: ApprovalAuthorizationSource): Promise<void>;
}

export class ApprovalReviewerService implements ApprovalReviewerAdapter {
  private readonly configBindingKey = randomBytes(32);
  private readonly unavailableServices = new Map<string, Error>();

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
    if (record.approvalSource === 'user_click') return;
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
    onStart?: (record: ApprovalReviewRecord) => void,
    options?: ApprovalReviewRetry
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
    if (request.externalAuthorization?.required && !hasExactUserAuthorizationGap(request)) {
      return this.createPause(request, 'scope_mismatch', 'missing_authorization_target', request.responseLanguage === 'en'
        ? 'The required authorization target could not be established. Nothing executed.'
        : '无法确定待授权的精确目标，尚未执行。');
    }
    if (request.businessAuthorization && (!verifiedBusinessAuthorization(request) || !this.matchesUserAuthorization(request, options))) {
      return this.createPause(request, 'scope_mismatch', 'unverified_business_authorization', request.responseLanguage === 'en'
        ? 'The exact business authorization could not be verified. Nothing executed.'
        : '无法核实本次精确业务授权，尚未执行。');
    }
    const serialized = prepareAutomaticReviewEvidence(request);
    if (!serialized) {
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
    }, options?.retryOf, options?.recovery);
    if (claim.status === 'denied') return this.blockPreviouslyDenied(request, claim.record);
    if (claim.status === 'duplicate') {
      const rationale = request.responseLanguage === 'en'
        ? 'Independent review was already claimed for this operation.' : '该精确操作已被认领进行独立审查。';
      if (claim.record.targetId !== request.targetId) {
        return this.createPause(request, 'interrupted', 'review_already_attempted', rationale);
      }
      return { status: 'unavailable', record: { ...claim.record, decision: 'unavailable',
        reviewState: claim.record.reviewState === 'in_progress' ? 'in_progress' : 'interrupted',
        projectApproval: undefined, rationale,
        policyRules: ['review_already_attempted'] } };
    }
    const attempts: ReviewAttempts = { reviewAttempts: 0, attemptFailures: [] };
    try {
      throwIfCancelled(signal);
      onStart?.(claim.record);
      return await this.reviewClaim(request, serialized, attempts, modelContext, signal, !!options?.retryOf);
    } catch (error) {
      if (signal?.aborted || (error instanceof OneShotTextRequestError && error.reason === 'cancelled')) {
        noteAttemptFailure(attempts, 'cancelled');
        await this.createPause(request, 'cancelled', 'approval_review_cancelled', request.responseLanguage === 'en'
          ? 'The approval review was cancelled. Nothing executed.' : '审批审查已取消，尚未执行。', attempts);
      }
      throw error;
    } finally {
      this.options.store.finishAutomaticReview(claim.record.reviewId);
    }
  }

  private async reviewClaim(request: ApprovalReviewRequest, serialized: string, attempts: ReviewAttempts,
    modelContext?: ApprovalReviewerModelContext, signal?: AbortSignal, explicitRetry = false): Promise<ApprovalReviewOutcome> {
    const deadlineAt = Date.now() + getConfiguredModelRequestTimeoutMs();
    try { assertReviewBudget(modelContext); }
    catch (error) {
      if (!isApprovalBudgetFailure(error)) throw error;
      return this.createBudgetStop(request, error, attempts);
    }
    const resolved = await this.resolveReviewer(request, modelContext);
    throwIfCancelled(signal);
    try { assertReviewBudget(modelContext); }
    catch (error) {
      if (!isApprovalBudgetFailure(error)) throw error;
      return this.createBudgetStop(request, error, attempts);
    }
    if (resolved.status === 'unavailable') {
      return this.createUnavailable(request, resolved, resolved.error, 'configuration_unavailable', 'review_configuration_unavailable', attempts);
    }
    const serviceKey = JSON.stringify([request.sessionId, request.rootTaskId, request.agentRunId, resolved.configFingerprint]);
    if (explicitRetry) this.unavailableServices.delete(serviceKey);
    const unavailable = this.unavailableServices.get(serviceKey);
    if (unavailable) return this.createUnavailable(request, resolved, unavailable, 'service_unavailable', 'reviewer_unavailable', attempts);
    let correction = '';
    for (let attempt = 0; ; attempt++) {
      let decision: ApprovalReviewerJson;
      try {
        throwIfCancelled(signal);
        assertReviewBudget(modelContext);
        const circuit = this.restoreCircuit(request);
        if (circuit?.tripped) return this.createCircuitStop(request, circuit.reason);
        if (Date.now() >= deadlineAt) throw new OneShotTextRequestError('timeout', 'Approval review deadline reached. / 已达到审批审查时限。');
        attempts.reviewAttempts++;
        const raw = await (this.options.requestText ?? requestApprovalReviewText)({
          model: resolved.model, sourceConfig: resolved.sourceConfig, globalStorageUri: this.options.globalStorageUri,
          taskCostBudget: modelContext?.taskCostBudget, taskRunBudget: modelContext?.taskRunBudget,
          systemPrompt: AUTO_APPROVAL_REVIEWER_SYSTEM_PROMPT, userPrompt: serialized + correction, language: request.responseLanguage,
          signal, deadlineAt, sessionId: request.sessionId, taskId: request.rootTaskId, runId: request.agentRunId,
          onUsage: event => this.options.onUsage?.(event, request.sessionId),
          onUsageLedgerRecord: record => this.options.onUsageLedgerRecord?.(record, request.sessionId)
        });
        throwIfCancelled(signal);
        decision = parseAutoApprovalReviewerJson(raw, request);
        const uncertainProjectBehavior = isProjectBehaviorOnlyEscalation(decision, request);
        if (decision.decision !== 'deny' || uncertainProjectBehavior) assertReviewDeadline(modelContext, deadlineAt);
        if (uncertainProjectBehavior) {
          noteAttemptFailure(attempts, 'project_behavior_unknown', 'policyRules');
          if (!attempt) {
            correction = PROJECT_POLICY_CORRECTION;
            continue;
          }
          return this.createUnavailable(request, resolved, new Error(request.responseLanguage === 'en'
            ? 'No usable project operation decision after the bounded correction.' : '有界纠正后仍无有效工程操作决定。'),
          'invalid_response', PROJECT_BEHAVIOR_UNKNOWN_RULE, attempts);
        }
      } catch (error) {
        throwIfCancelled(signal);
        if (isApprovalBudgetFailure(error)) return this.createBudgetStop(request, error, attempts);
        if (error instanceof ApprovalAffectedScopeError) {
          noteAttemptFailure(attempts, 'scope_mismatch', 'affectedTargets');
          return this.createUnavailable(request, resolved, new Error(request.responseLanguage === 'en'
            ? 'The reviewer reported an affected target outside the exact operation scope. Verify the actual targets before retrying.'
            : '审批模型报告的受影响目标与精确操作范围不符。请核实实际目标后重试。'),
          'scope_mismatch', 'review_affected_scope_mismatch', attempts);
        }
        const formatError = error instanceof ApprovalResponseFormatError ? error : undefined;
        const providerError = error instanceof OneShotTextRequestError ? error
          : formatError ? new OneShotTextRequestError('invalid', formatError.message)
            : isRecoverableNetworkError(error) && error instanceof Error
              ? new OneShotTextRequestError('unavailable', error.message, true) : undefined;
        if (!providerError) throw error;
        if (providerError.reason === 'save_failed') throw new ApprovalAuditError(providerError);
        if (!['timeout', 'invalid', 'unavailable'].includes(providerError.reason)) throw error;
        noteAttemptFailure(attempts, formatError?.category ?? (providerError.reason === 'invalid' ? 'unusable_response'
          : providerError.reason === 'timeout' ? 'timeout' : 'service_unavailable'), formatError?.field);
        if (Date.now() >= (modelContext?.taskRunBudget?.deadlineAt ?? Infinity)) {
          return this.createBudgetStop(request, new LogicalBudgetExceededError('run_time_budget_exhausted'), attempts);
        }
        if (modelContext?.taskCostBudget?.exhausted) {
          return this.createBudgetStop(request, new LogicalBudgetExceededError('provider_cost_budget_exhausted'), attempts);
        }
        if (!attempt && Date.now() < deadlineAt && (providerError.retryable || providerError.reason === 'invalid')) {
          if (providerError.reason === 'invalid') correction = reviewResponseCorrection(formatError);
          continue;
        }
        if (providerError.reason === 'timeout') return this.createUnavailable(request, resolved, providerError, 'timeout', 'review_timeout', attempts);
        if (providerError.reason === 'invalid') return this.createUnavailable(request, resolved, providerError, 'invalid_response', 'invalid_review_response', attempts);
        // Only a proven service failure is shared across this execution segment.
        // Invalid decisions and timeouts remain local to their exact action.
        if (providerError.sharedServiceFailure) {
          if (this.unavailableServices.size >= 64) this.unavailableServices.delete(this.unavailableServices.keys().next().value!);
          this.unavailableServices.set(serviceKey, providerError);
        }
        return this.createUnavailable(request, resolved, providerError, 'service_unavailable', 'reviewer_unavailable', attempts);
      }
      const outcome = applyHostDecisionPolicy(decision, request);
      const record = await this.options.store.add({
        ...reviewIdentity(request), approvalSource: 'auto_approval_review',
        reviewerConfigFingerprint: resolved.configFingerprint, reviewerSourceId: resolved.sourceConfig.sourceId,
        reviewerModelId: resolved.model.id, reviewerProvider: resolved.sourceConfig.provider,
        decision: outcome.decision, risk: outcome.risk, rationale: redactSensitiveReviewText(outcome.reason, 800),
        projectApproval: outcome.projectApproval,
        businessAuthorization: outcome.decision === 'approve' ? verifiedBusinessAuthorization(request) : undefined,
        policyRules: outcome.policyRules, affectedTargets: outcome.affectedTargets?.map(target => redactSensitiveReviewText(target, 300)),
        saferAlternative: outcome.saferAlternative ? redactSensitiveReviewText(outcome.saferAlternative) : undefined,
        reviewState: outcome.reviewState, ...attempts
      });
      throwIfCancelled(signal);
      return this.withCircuit(request, outcome.decision === 'unavailable' ? 'unavailable' : 'reviewed', record);
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
    reason: string, attempts?: ReviewAttempts): Promise<ApprovalReviewOutcome> {
    const record = await this.options.store.add({
      ...reviewIdentity(request), approvalSource: 'local_policy', reviewerSourceId: '', reviewerModelId: '',
      reviewerProvider: 'local_policy', decision: 'needs_user', risk: 'high', rationale: redactSensitiveReviewText(reason),
      riskUnassessed: true, policyRules: [rule], reviewState, ...attempts
    });
    return { status: 'reviewed', record };
  }

  private createBudgetStop(request: ApprovalReviewRequest, error: unknown, attempts: ReviewAttempts): Promise<ApprovalReviewOutcome> {
    const reason = error instanceof Error ? error.message : String(error);
    noteAttemptFailure(attempts, 'budget_stopped');
    return this.createPause(request, 'budget_stopped', 'approval_budget_exhausted', request.responseLanguage === 'en'
      ? `Approval stopped at the task budget boundary. Nothing executed. ${reason}`
      : `审批已在任务预算边界停止，尚未执行。${reason}`, attempts);
  }

  private async createCircuitStop(request: ApprovalReviewRequest,
    reason: ApprovalReviewOutcome['circuitBreakReason']): Promise<ApprovalReviewOutcome> {
    const stopped = await this.createPause(request, 'circuit_stopped', 'approval_circuit_stopped', request.responseLanguage === 'en'
      ? 'The approval refusal limit has been reached. Nothing executed.' : '已达到审批拒绝熔断阈值，尚未执行。');
    return { ...stopped, circuitBreakReason: reason };
  }

  public async createUserAuthorization(request: ApprovalReviewRequest, link: { priorReviewId?: string; userRequestId: string }): Promise<ApprovalUserAuthorizationReceipt> {
    const reviewed = link.priorReviewId ? this.options.store.get(link.priorReviewId) : undefined;
    if (!link.userRequestId || !reviewed || reviewed.runtimeId !== this.options.store.runtimeId
      || !this.options.store.matchesSnapshot(reviewed.reviewId, request)
      || !canUseManualReview(reviewed, request)) {
      throw new Error('No live matching user request review exists. Nothing executed. / 缺少本次人工请求的有效审查记录，未执行。');
    }
    const prior = this.findHistoricalDenial(request);
    if (prior) throw new Error(prior.rationale);
    const denial = !request.workspaceTrusted || !vscode.workspace.isTrusted ? 'workspace_untrusted' : findDeterministicReviewDenial(request);
    if (denial) throw new Error((await this.createLocalDenial(request, denial)).rationale);
    const targets = [...new Set(request.externalAuthorization?.required ? request.externalAuthorization.targets : reviewed.affectedTargets)];
    if (!targets.length) throw new Error('The exact user authorization has no verified targets. / 精确用户授权缺少可核验的目标。');
    const record = await this.options.store.add({
      ...reviewIdentity(request), ...link,
      approvalSource: 'user_click', reviewerSourceId: '', reviewerModelId: '', reviewerProvider: 'user_click',
      reviewerConfigFingerprint: reviewed.reviewerConfigFingerprint,
      decision: 'needs_user', risk: reviewed.risk, policyRules: ['user_authorized_exact_scope'],
      affectedTargets: targets,
      rationale: request.responseLanguage === 'en' ? 'The user authorized this exact scope. Independent review is still required.'
        : '用户已授权此精确范围，仍需独立审批模型作出决定。'
    });
    return { record, authorization: { kind: 'confirmed_action', authority: 'user_confirmation', targets, receiptId: record.reviewId } };
  }

  private matchesUserAuthorization(request: ApprovalReviewRequest, retry?: ApprovalReviewRetry): boolean {
    const authorization = request.businessAuthorization;
    if (authorization?.kind !== 'confirmed_action') return true;
    const receipt = this.options.store.get(authorization.receiptId);
    return !!receipt && receipt.runtimeId === this.options.store.runtimeId && !receipt.historyInvalidatedBy
      && receipt.approvalSource === 'user_click' && receipt.decision === 'needs_user'
      && receipt.policyRules.includes('user_authorized_exact_scope') && receipt.priorReviewId === retry?.retryOf
      && receipt.sessionId === request.sessionId && receipt.rootTaskId === request.rootTaskId && receipt.agentRunId === request.agentRunId
      && receipt.targetId === request.targetId && receipt.actionKind === request.actionKind && receipt.actionHash === request.actionHash
      && receipt.effectHash === request.effectHash && !!receipt.affectedTargets
      && receipt.affectedTargets.length === authorization.targets.length
      && authorization.targets.every(target => receipt.affectedTargets!.includes(target))
      && (receipt.scopeFingerprint === request.scopeFingerprint || this.matchesExternalReadRefinement(receipt, request, retry));
  }

  private matchesExternalReadRefinement(receipt: ApprovalReviewRecord, request: ApprovalReviewRequest, retry?: ApprovalReviewRetry): boolean {
    const action = request.exactAction;
    if (action.kind !== 'external_file_access' || action.access !== 'read' || !receipt.authorizationPending
      || retry?.recovery !== 'not_dispatched' || request.externalAuthorization?.required !== false
      || receipt.affectedTargets?.length !== 1 || receipt.affectedTargets[0] !== action.uri
      || request.externalAuthorization.targets.length !== 1 || request.externalAuthorization.targets[0] !== action.uri
      || !request.scopeFingerprint || !/^[a-f0-9]{64}$/u.test(request.scopeFingerprint)) return false;
    // A one-shot read is initially scoped to the literal URI. Only after the
    // exact grant can the workspace service resolve and stat that same file.
    const provisional = hashApprovalValue({ uri: action.uri, access: action.access });
    return receipt.scopeFingerprint === provisional && receipt.effectHash === provisional
      && receipt.actionHash === hashExternalFileReviewAction(action, provisional);
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
      decision: 'deny', risk: reviewed.risk, riskUnassessed: reviewed.decision === 'unavailable' ? true : undefined,
      affectedTargets: reviewed.affectedTargets,
      rationale: request.responseLanguage === 'en' ? 'User rejected this operation.' : '用户已拒绝本次操作。',
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
    reviewState: UnavailableReviewState, rule: string, attempts: ReviewAttempts): Promise<ApprovalReviewOutcome> {
    const model = resolved.status === 'resolved' ? resolved : undefined;
    const message = redactSensitiveReviewText(error.message);
    const reason = ({
      invalid_response: ['The operation is unstarted because the approval response was unusable', '审批回复不可用，操作尚未执行'],
      scope_mismatch: ['The operation is unstarted because the reviewed scope did not match', '审批范围不符，操作尚未执行'],
      configuration_unavailable: ['The operation is unstarted because the approval model configuration is unavailable', '审批模型配置不可用，操作尚未执行'],
      service_unavailable: ['The operation is unstarted because the approval model service is unavailable', '审批模型服务不可用，操作尚未执行'],
      timeout: ['The operation is unstarted because the approval review timed out', '审批审查超时，操作尚未执行']
    } satisfies Record<UnavailableReviewState, string[]>)[reviewState][request.responseLanguage === 'en' ? 0 : 1];
    const record = await this.options.store.add({
      ...reviewIdentity(request), approvalSource: 'auto_approval_review',
      reviewerConfigFingerprint: resolved.configFingerprint, reviewerSourceId: model?.sourceConfig.sourceId ?? '',
      reviewerModelId: model?.model.id ?? '', reviewerProvider: model?.sourceConfig.provider ?? '',
      decision: 'unavailable', risk: 'high', reviewState,
      riskUnassessed: true,
      rationale: `${reason} · ${message}`,
      policyRules: [rule], ...attempts
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
  const action = request.exactAction;
  return {
    sessionId: request.sessionId, rootTaskId: request.rootTaskId, agentRunId: request.agentRunId,
    targetId: request.targetId, actionKind: request.actionKind, actionHash: request.actionHash, effectHash: request.effectHash,
    policyVersion: APPROVAL_POLICY_VERSION, approvalMode: request.approvalMode, scopeFingerprint: request.scopeFingerprint,
    originalActionHash: originalActionHash(request),
    authorizationPending: hasExactUserAuthorizationGap(request) ? true as const : undefined,
    osIsolation: action.kind === 'draft_run_execute' ? action.scope?.osIsolation ?? 'none' as const
      : action.kind === 'validation_run' ? action.launch?.osIsolation ?? 'none' as const : undefined
  };
}

function canUseManualReview(reviewed: ApprovalReviewRecord, request: ApprovalReviewRequest): boolean {
  if (request.exactAction.kind === 'draft_run_execute' && request.exactAction.restricted) return false;
  return approvalDisposition(reviewed) === 'request_user';
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

function hasExactUserAuthorizationGap(request: ApprovalReviewRequest): boolean {
  return request.externalAuthorization?.required === true && request.externalAuthorization.targets.length > 0;
}

type HostReviewDecision = Omit<ApprovalReviewerJson, 'decision'> & Pick<ApprovalReviewRecord, 'decision' | 'reviewState' | 'projectApproval'>;
type UnavailableReviewState = Extract<ApprovalReviewState, 'invalid_response' | 'scope_mismatch' | 'configuration_unavailable' | 'service_unavailable' | 'timeout'>;
type ReviewAttempts = { reviewAttempts: number; attemptFailures: ApprovalReviewAttemptFailure[] };

function noteAttemptFailure(attempts: ReviewAttempts, category: ApprovalReviewAttemptFailure['category'],
  field?: ApprovalReviewAttemptFailure['field']): void {
  const attempt = attempts.reviewAttempts;
  if (attempt > 0 && !attempts.attemptFailures.some(item => item.attempt === attempt)) {
    attempts.attemptFailures.push({ attempt, category, field, at: new Date().toISOString() });
  }
}

function applyHostDecisionPolicy(decision: ApprovalReviewerJson, request: ApprovalReviewRequest): HostReviewDecision {
  if (decision.decision === 'deny') return decision;
  const highRisk = decision.risk === 'high';
  if (decision.risk === 'critical' || decision.policyRules.includes('concrete_danger')) return { ...decision, decision: 'deny' };
  const businessAuthorization = verifiedBusinessAuthorization(request);
  if (decision.policyRules.includes(AUTHORIZED_BUSINESS_EFFECT_RULE) && !businessAuthorization) return {
    ...decision, decision: 'unavailable', reviewState: 'scope_mismatch', policyRules: ['unverified_business_authorization'],
    reason: request.responseLanguage === 'en' ? 'The review cited an authorization the host did not establish.'
      : '审批模型引用了宿主尚未核验的业务授权。'
  };
  const hasUnknownScope = decision.policyRules.includes(VERIFIED_PROJECT_OPERATION_RULE) && !isVerifiedProjectOperation(request);
  if (hasUnknownScope) return {
    ...decision, decision: 'unavailable', reviewState: 'scope_mismatch',
    policyRules: ['unverified_project_operation'],
    reason: request.responseLanguage === 'en'
      ? 'The reviewer claimed a verified project scope that the host did not establish.'
      : '审批模型引用了宿主尚未核验的工程范围。'
  };
  const exactGap = decision.policyRules.includes(EXACT_USER_AUTHORIZATION_RULE);
  const authorizationRequired = hasExactUserAuthorizationGap(request);
  const insufficientEvidence = decision.policyRules.includes('insufficient_evidence')
    || decision.policyRules.includes(PROJECT_BEHAVIOR_UNKNOWN_RULE)
    || (exactGap && !authorizationRequired);
  if (decision.decision === 'needs_user') {
    const confirmableRisk = highRisk && !businessAuthorization && decision.policyRules.includes(USER_CONFIRMABLE_RISK_RULE);
    return { ...decision, reviewState: !insufficientEvidence && (exactGap || confirmableRisk) ? undefined : 'insufficient_evidence' };
  }
  if (insufficientEvidence) return { ...decision, decision: 'needs_user', reviewState: 'insufficient_evidence' };
  if (authorizationRequired) {
    return { ...decision, decision: 'needs_user', policyRules: prependPolicyRule(decision, EXACT_USER_AUTHORIZATION_RULE) };
  }
  if (highRisk && !businessAuthorization) {
    return {
      ...decision, decision: 'needs_user',
      policyRules: prependPolicyRule(decision, USER_CONFIRMABLE_RISK_RULE),
      reason: request.responseLanguage === 'en'
        ? `Review reported a risk that requires your exact confirmation. ${decision.reason}`
        : `审查报告的风险需要你对本次精确操作作出确认。${decision.reason}`
    };
  }
  if (highRisk) decision = { ...decision, policyRules: prependPolicyRule(decision, AUTHORIZED_BUSINESS_EFFECT_RULE) };
  if (isVerifiedProjectOperation(request)) {
    return { ...decision, projectApproval: true, policyRules: prependPolicyRule(decision, VERIFIED_PROJECT_OPERATION_RULE) };
  }
  return decision;
}

function prependPolicyRule(decision: ApprovalReviewerJson, rule: string): string[] {
  return [rule, ...decision.policyRules.filter(value => value !== rule).slice(0, 15)];
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
