import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import { SessionDeletionAuthority } from '../sessions/sessionDeletionAuthority';
import { hasAssociatedRecordOwner, assertManagedStoragePath, readAssociatedJson, withAssociatedStoreGate, withoutDeletedSessions } from '../sessions/sessionAssociatedPersistence';
import type { HistoryTruncationScope } from '../sessions/historyTruncation';
import {
  APPROVAL_POLICY_VERSION,
  AUTHORIZED_BUSINESS_EFFECT_RULE,
  MANUAL_FALLBACK_STATES,
  MAX_APPROVAL_TARGETS,
  VERIFIED_PROJECT_OPERATION_RULE,
  approvalDisposition,
  normalizeApprovalAttemptFailures,
  normalizeApprovalExecutionIsolation,
  normalizeApprovalReviewAttempts,
  normalizeApprovalReviewState,
  normalizeBusinessAuthorization,
  type ApprovalRecordMatch,
  type ApprovalReviewDisplay,
  type ApprovalReviewRecord,
  type ApprovalReviewRequest
} from './approvalReviewTypes';

const MAX_RECORDS = 1_000;
type ReviewRecordInput = Omit<ApprovalReviewRecord, 'reviewId' | 'runtimeId' | 'createdAt'>;

export class ApprovalAuditError extends Error {
  public constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'ApprovalAuditError';
  }
}

class ApprovalRecordConflictError extends Error {}

export class ApprovalReviewStore {
  public readonly runtimeId = randomUUID();
  private readonly storageUri: vscode.Uri;
  private readonly records = new Map<string, ApprovalReviewRecord>();
  private readonly knownRecordIds = new Set<string>();
  private readonly liveRecordIds = new Set<string>();
  private readonly activeReviewIds = new Set<string>();
  private readonly consumptionClaims = new Set<string>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  public constructor(private readonly globalStorageUri: vscode.Uri) {
    this.storageUri = vscode.Uri.joinPath(globalStorageUri, 'approval-reviews.json');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.storageUri);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { version?: number; records?: unknown[] };
      console.debug('KeepSeek startup: approval-review-storage-read', {
        bytesRead: bytes.byteLength,
        entries: parsed.records?.length ?? 0
      });
      if (parsed.version !== 1) return;
      for (const value of parsed.records ?? []) {
        const record = normalizeRecord(value);
        if (record && !await new SessionDeletionAuthority(this.globalStorageUri).isSessionIdDeleted(record.sessionId)) {
          this.records.set(record.reviewId, record);
          this.knownRecordIds.add(record.reviewId);
        }
      }
    } catch {
      // Missing or malformed review history never authorizes an operation.
    }
  }

  public async add(input: ReviewRecordInput): Promise<ApprovalReviewRecord> {
    if (input.policyVersion !== APPROVAL_POLICY_VERSION || input.approvalSource === 'host_policy'
      || (input.approvalSource === 'local_policy' && input.decision === 'approve')
      || (input.approvalSource === 'user_click' && input.decision === 'approve')
      || (input.decision === 'approve' && input.risk === 'critical')
      || (input.approvalSource === 'auto_approval_review' && input.decision === 'approve' && input.risk === 'high'
        && !hasAuthorizedHighRiskApproval(input))
      || (input.projectApproval && !hasVerifiedProjectApproval(input))) {
      throw new Error('Historical or non-authorizing approval source cannot issue a current approval record.');
    }
    if (input.approvalSource === 'user_click' && (!input.priorReviewId || !input.userRequestId
      || input.approvalMode !== 'delegate' || !input.scopeFingerprint || !input.reviewerConfigFingerprint)) {
      throw new ApprovalRecordConflictError('A user decision requires a current exact approval request.');
    }
    await new SessionDeletionAuthority(this.globalStorageUri).assertSessionIdWritable(input.sessionId);
    const record = this.createRecord(input);
    await this.persist(records => {
      if (record.approvalSource === 'user_click' && record.userRequestId && [...records.values()].some(prior =>
        prior.approvalSource === 'user_click' && prior.runtimeId === this.runtimeId && prior.sessionId === record.sessionId
        && (prior.userRequestId === record.userRequestId || (record.priorReviewId && prior.priorReviewId === record.priorReviewId)))) {
        throw new ApprovalRecordConflictError('The exact user approval request has already been decided.');
      }
      if (record.approvalSource === 'user_click' && record.priorReviewId) {
        const prior = records.get(record.priorReviewId);
        if (!prior || !this.isCurrentReviewerSnapshot(prior, record) || prior.reviewerConfigFingerprint !== record.reviewerConfigFingerprint
          || (record.decision !== 'deny' && (approvalDisposition(prior) !== 'request_user' || findSafetyDenial(records, record)))) {
          throw new ApprovalRecordConflictError('The exact user approval review is no longer active.');
        }
      }
      records.set(record.reviewId, record);
      return true;
    });
    this.trackCurrentRecord(record);
    return structuredClone(record);
  }

  public async claimAutomaticReview(input: ReviewRecordInput, retryOf?: string, recovery?: 'not_dispatched'): Promise<
    { status: 'claimed' | 'duplicate' | 'denied'; record: ApprovalReviewRecord }
  > {
    if (input.policyVersion !== APPROVAL_POLICY_VERSION || input.approvalMode !== 'delegate'
      || input.approvalSource !== 'auto_approval_review' || input.decision !== 'unavailable' || input.reviewState !== 'in_progress') {
      throw new Error('An automatic review claim cannot authorize an operation.');
    }
    await new SessionDeletionAuthority(this.globalStorageUri).assertSessionIdWritable(input.sessionId);
    const record = this.createRecord(input);
    let duplicate: ApprovalReviewRecord | undefined;
    let denied: ApprovalReviewRecord | undefined;
    await this.persist(records => {
      denied = findSafetyDenial(records, input);
      if (denied) return false;
      duplicate = [...records.values()].reverse().find(prior => !prior.historyInvalidatedBy
        && prior.approvalSource === 'auto_approval_review' && prior.sessionId === input.sessionId
        && prior.rootTaskId === input.rootTaskId && prior.agentRunId === input.agentRunId
        && (prior.policyVersion === APPROVAL_POLICY_VERSION || prior.reviewId === retryOf)
        && (prior.targetId === input.targetId || (prior.actionKind === input.actionKind && prior.actionHash === input.actionHash
          && prior.scopeFingerprint === input.scopeFingerprint)));
      if (retryOf) {
        const provenNotDispatched = recovery === 'not_dispatched';
        const decided = [...records.values()].find(prior => prior.approvalSource === 'user_click' && prior.priorReviewId === retryOf);
        if (!duplicate || duplicate.reviewId !== retryOf
          || !(provenNotDispatched ? sameReviewAction(duplicate, input) : sameReviewIdentity(duplicate, input))
          || (duplicate.consumedAt && !provenNotDispatched) || duplicate.supersededByReviewId || duplicate.decision === 'deny'
          || this.activeReviewIds.has(duplicate.reviewId)
          || (decided && (decided.decision === 'deny' || !provenNotDispatched))
          || (duplicate.runtimeId === this.runtimeId && !['request_user', 'execute'].includes(approvalDisposition(duplicate))
            && !['in_progress', 'interrupted', 'cancelled', 'scope_mismatch', 'insufficient_evidence',
              ...MANUAL_FALLBACK_STATES].includes(duplicate.reviewState ?? ''))) {
          throw new ApprovalRecordConflictError('The exact approval review cannot be retried from this state.');
        }
        records.set(retryOf, { ...duplicate, supersededByReviewId: record.reviewId });
        duplicate = undefined;
      }
      if (duplicate) return false;
      records.set(record.reviewId, record);
      return true;
    });
    if (denied) return { status: 'denied', record: structuredClone(denied) };
    if (duplicate) return { status: 'duplicate', record: this.withReviewLifecycle(duplicate) };
    this.trackCurrentRecord(record);
    this.activeReviewIds.add(record.reviewId);
    return { status: 'claimed', record: structuredClone(record) };
  }

  public finishAutomaticReview(reviewId: string): void {
    this.activeReviewIds.delete(reviewId);
  }

  private createRecord(input: ReviewRecordInput): ApprovalReviewRecord {
    return {
      ...input,
      reviewId: randomUUID(),
      runtimeId: this.runtimeId,
      createdAt: new Date().toISOString()
    };
  }

  private trackCurrentRecord(record: ApprovalReviewRecord): void {
    // A concurrently deleted session may have filtered the write under the gate.
    if (!this.records.has(record.reviewId)) throw new ApprovalAuditError('Approval record could not be persisted for this session.');
    this.knownRecordIds.add(record.reviewId);
    this.liveRecordIds.add(record.reviewId);
    this.compact();
  }

  public get(reviewId: string): ApprovalReviewRecord | undefined {
    const record = this.records.get(reviewId);
    return record ? this.withReviewLifecycle(record) : undefined;
  }

  /** Preserve immutable audit results while revoking membership and unused authority. */
  public async invalidateHistory(scope: HistoryTruncationScope, removedTargetIds: readonly string[] = []): Promise<void> {
    const mark = (records: Map<string, ApprovalReviewRecord>) => {
      for (const record of records.values()) {
        if (record.sessionId === scope.sessionId && (scope.removedSegmentIds.includes(record.agentRunId)
          || removedTargetIds.includes(record.targetId)) && !record.historyInvalidatedBy) record.historyInvalidatedBy = scope.id;
      }
      return [...records.values()].some(record => record.historyInvalidatedBy === scope.id);
    };
    // Persist even on retry: a prior write may have failed after the in-memory mark.
    mark(this.records);
    await this.persist(mark);
  }

  public matchesSnapshot(reviewId: string, request: ApprovalReviewRequest): boolean {
    const record = this.records.get(reviewId);
    return !!record && this.isCurrentReviewerSnapshot(record, request);
  }

  private isCurrentReviewerSnapshot(record: ApprovalReviewRecord, request: ReviewSnapshotIdentity): boolean {
    return this.liveRecordIds.has(record.reviewId) && !this.consumptionClaims.has(record.reviewId)
      && !record.historyInvalidatedBy && !record.consumedAt
      && record.runtimeId === this.runtimeId && record.approvalSource === 'auto_approval_review'
      && sameReviewIdentity(record, request) && record.approvalMode === 'delegate'
      && !!record.reviewerConfigFingerprint && !!record.scopeFingerprint
      && record.policyVersion === APPROVAL_POLICY_VERSION
      && ['execute', 'request_user'].includes(approvalDisposition(record));
  }

  public getLatestForTarget(targetId: string): ApprovalReviewDisplay | undefined {
    const record = [...this.records.values()]
      .reverse().find((item) => item.targetId === targetId && !item.historyInvalidatedBy);
    return record ? toDisplay(this.withReviewLifecycle(record)) : undefined;
  }

  private withReviewLifecycle(record: ApprovalReviewRecord): ApprovalReviewRecord {
    if ((record.reviewState === 'in_progress' || record.policyRules.includes('review_in_progress'))
      && !this.activeReviewIds.has(record.reviewId)) {
      return { ...structuredClone(record), reviewState: 'interrupted' };
    }
    return structuredClone(record);
  }

  public findDenialForAction(input: {
    sessionId: string;
    rootTaskId: string;
    actionKind: ApprovalReviewRecord['actionKind'];
    actionHash: string;
  }): ApprovalReviewRecord | undefined {
    const record = [...this.records.values()].reverse().find((item) => !item.historyInvalidatedBy && item.sessionId === input.sessionId
      && item.rootTaskId === input.rootTaskId
      && item.actionKind === input.actionKind
      && (item.actionHash === input.actionHash || item.originalActionHash === input.actionHash)
      && item.decision === 'deny');
    return record ? structuredClone(record) : undefined;
  }

  public findHardRunDenial(sessionId: string, actionHash: string): ApprovalReviewRecord | undefined {
    return this.findSafetyDenial({ sessionId, actionKind: 'draft_run_execute', actionHash });
  }

  public findSafetyDenial(input: SafetyDenialIdentity): ApprovalReviewRecord | undefined {
    const record = findSafetyDenial(this.records, input);
    return record ? structuredClone(record) : undefined;
  }

  public async consumeMatchingApproval(input: ApprovalRecordMatch): Promise<ApprovalReviewRecord> {
    await new SessionDeletionAuthority(this.globalStorageUri).assertSessionIdWritable(input.sessionId);
    if (!input.workspaceTrusted) throw new Error('Approval record cannot be consumed in an untrusted workspace.');
    if (!this.liveRecordIds.has(input.reviewId) || this.consumptionClaims.has(input.reviewId)) {
      throw new Error('No current matching approval record exists for this exact operation.');
    }
    let consumed: ApprovalReviewRecord | undefined;
    await this.persist(records => {
      const record = records.get(input.reviewId);
      if (!record || !this.liveRecordIds.has(record.reviewId) || this.consumptionClaims.has(record.reviewId)
      || record.historyInvalidatedBy || record.runtimeId !== this.runtimeId || record.consumedAt
      || record.sessionId !== input.sessionId || record.rootTaskId !== input.rootTaskId || record.agentRunId !== input.agentRunId
      || record.targetId !== input.targetId || record.actionKind !== input.actionKind
      || record.actionHash !== input.actionHash || input.policyVersion !== APPROVAL_POLICY_VERSION
      || record.policyVersion !== input.policyVersion
      || input.expectedSource !== 'auto_approval_review'
      || record.approvalSource !== input.expectedSource || approvalDisposition(record) !== 'execute'
      || input.approvalMode !== 'delegate' || record.approvalMode !== input.approvalMode
      || !record.scopeFingerprint || record.scopeFingerprint !== input.scopeFingerprint
      || !input.reviewerConfigFingerprint || record.reviewerConfigFingerprint !== input.reviewerConfigFingerprint
      || !record.reviewerModelId || !record.reviewerSourceId
      || findSafetyDenial(records, record)) {
        throw new ApprovalRecordConflictError('No current matching approval record exists for this exact operation.');
      }
      // Keep the reservation on an ambiguous write failure; the caller cannot retry consumption.
      this.consumptionClaims.add(record.reviewId);
      consumed = { ...record, consumedAt: new Date().toISOString() };
      records.set(consumed.reviewId, consumed);
      return true;
    });
    if (!consumed || !this.records.has(input.reviewId)) {
      throw new ApprovalAuditError('Approval consumption could not be persisted for this session.');
    }
    return structuredClone(consumed);
  }

  public async flush(): Promise<void> {
    try { await this.persistenceQueue; }
    catch (error) {
      // An exact-request conflict rejects that caller before any write.
      if (!(error instanceof ApprovalRecordConflictError)) throw error;
    }
  }

  public decisionHistory(sessionId: string, rootTaskId: string, beforeReviewId?: string): Array<'approve' | 'deny'> {
    const history: Array<'approve' | 'deny'> = [];
    for (const record of this.records.values()) {
      if (record.reviewId === beforeReviewId) break;
      if (!record.historyInvalidatedBy && record.sessionId === sessionId && record.rootTaskId === rootTaskId
        && ['auto_approval_review', 'local_policy'].includes(record.approvalSource)
        && (record.decision === 'approve' || record.decision === 'deny')) history.push(record.decision);
    }
    return history.slice(-50);
  }

  private compact(): void {
    if (this.records.size <= MAX_RECORDS) return;
    const remove = [...this.records.values()].filter(record => !this.activeReviewIds.has(record.reviewId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.records.size - MAX_RECORDS);
    for (const record of remove) {
      this.records.delete(record.reviewId);
      this.liveRecordIds.delete(record.reviewId);
      this.consumptionClaims.delete(record.reviewId);
    }
  }

  public async hasSessionHistory(sessionId: string): Promise<boolean> {
    return hasAssociatedRecordOwner(this.storageUri, sessionId, ['records'], [1]);
  }

  public async deleteSession(sessionId: string): Promise<void> {
    for (const [id, record] of this.records) if (record.sessionId === sessionId) this.records.delete(id);
    await this.flush();
    await withAssociatedStoreGate(this.globalStorageUri, 'approval-reviews', async () => {
      await assertManagedStoragePath(this.globalStorageUri, this.storageUri);
      const stored = await readAssociatedJson(this.storageUri);
      if (!stored) return;
      if (stored.version !== 1 || !Array.isArray(stored.records)) throw new Error('Approval history storage is damaged.');
      await writeJsonAtomic(this.storageUri, { ...stored,
        records: stored.records.filter(record => !record || typeof record !== 'object' || (record as ApprovalReviewRecord).sessionId !== sessionId) });
    });
  }

  private async persist(update?: (records: Map<string, ApprovalReviewRecord>) => boolean): Promise<void> {
    const write = async () => await withAssociatedStoreGate(this.globalStorageUri, 'approval-reviews', async () => {
      const stored = await readAssociatedJson(this.storageUri);
      if (stored && (stored.version !== 1 || !Array.isArray(stored.records))) throw new Error('Approval history storage is damaged.');
      const merged = new Map<string, ApprovalReviewRecord>();
      for (const value of stored?.records as unknown[] ?? []) {
        if (value && typeof value === 'object' && typeof (value as ApprovalReviewRecord).reviewId === 'string') {
          const record = normalizeRecord(value);
          if (record && (!this.knownRecordIds.has(record.reviewId) || this.records.has(record.reviewId))) merged.set(record.reviewId, record);
        }
      }
      for (const record of this.records.values()) {
        const prior = merged.get(record.reviewId);
        if (prior) merged.set(record.reviewId, { ...(this.liveRecordIds.has(record.reviewId) ? record : prior),
          historyInvalidatedBy: prior.historyInvalidatedBy ?? record.historyInvalidatedBy,
          consumedAt: prior.consumedAt ?? record.consumedAt,
          supersededByReviewId: prior.supersededByReviewId ?? record.supersededByReviewId });
        else if (this.knownRecordIds.has(record.reviewId)) merged.set(record.reviewId, record);
      }
      const shouldWrite = update?.(merged) ?? true;
      const records = await withoutDeletedSessions(this.globalStorageUri, [...merged.values()]);
      if (shouldWrite) await writeJsonAtomic(this.storageUri, { version: 1, records });
      const retained = new Set(records.map(record => record.reviewId));
      for (const id of this.records.keys()) if (!retained.has(id)) this.records.delete(id);
      for (const record of records) this.records.set(record.reviewId, record);
    });
    const auditedWrite = async () => {
      try { await write(); }
      catch (error) {
        if (error instanceof ApprovalRecordConflictError) throw error;
        throw new ApprovalAuditError(error);
      }
    };
    this.persistenceQueue = this.persistenceQueue.then(auditedWrite, auditedWrite);
    await this.persistenceQueue;
  }
}

type SafetyDenialIdentity = Pick<ApprovalReviewRequest, 'sessionId' | 'actionKind' | 'actionHash' | 'effectHash'>;
type ReviewSnapshotIdentity = Pick<ApprovalReviewRequest, 'sessionId' | 'rootTaskId' | 'agentRunId' | 'targetId'
  | 'actionKind' | 'actionHash' | 'effectHash' | 'approvalMode' | 'scopeFingerprint'>;

function sameReviewIdentity(a: ReviewSnapshotIdentity, b: ReviewSnapshotIdentity): boolean {
  return sameReviewAction(a, b) && a.effectHash === b.effectHash && a.scopeFingerprint === b.scopeFingerprint;
}

function sameReviewAction(a: ReviewSnapshotIdentity, b: ReviewSnapshotIdentity): boolean {
  return a.sessionId === b.sessionId && a.rootTaskId === b.rootTaskId && a.agentRunId === b.agentRunId
    && a.targetId === b.targetId && a.actionKind === b.actionKind && a.actionHash === b.actionHash
    && a.approvalMode === b.approvalMode;
}

function findSafetyDenial(records: Map<string, ApprovalReviewRecord>, input: SafetyDenialIdentity): ApprovalReviewRecord | undefined {
  // Truncation revokes live history membership, never the safety finding for an equivalent operation.
  return [...records.values()].reverse().find(record => record.sessionId === input.sessionId
    && record.actionKind === input.actionKind && record.decision === 'deny'
    && (record.actionHash === input.actionHash || record.originalActionHash === input.actionHash
      || (input.effectHash && record.effectHash === input.effectHash))
    && (record.approvalSource === 'local_policy' || record.approvalSource === 'auto_approval_review'
      || (record.approvalSource === 'host_policy' && record.risk === 'critical')));
}

export function toApprovalReviewDisplay(record: ApprovalReviewRecord): ApprovalReviewDisplay {
  return toDisplay(record);
}

function toDisplay(record: ApprovalReviewRecord): ApprovalReviewDisplay {
  return structuredClone({
    reviewId: record.reviewId,
    sessionId: record.sessionId,
    rootTaskId: record.rootTaskId,
    agentRunId: record.agentRunId,
    targetId: record.targetId,
    actionKind: record.actionKind,
    policyVersion: record.policyVersion,
    approvalMode: record.approvalMode,
    approvalSource: record.approvalSource,
    projectApproval: hasVerifiedProjectApproval(record) ? true : undefined,
    osIsolation: record.osIsolation,
    businessAuthorization: normalizeBusinessAuthorization(record.businessAuthorization),
    authorizationPending: record.authorizationPending === true ? true : undefined,
    reviewerSourceId: record.reviewerSourceId,
    reviewerModelId: record.reviewerModelId,
    reviewerProvider: record.reviewerProvider,
    decision: record.decision,
    reviewState: record.reviewState,
    risk: record.risk,
    riskUnassessed: record.riskUnassessed,
    rationale: record.rationale,
    saferAlternative: record.saferAlternative,
    affectedTargets: record.affectedTargets,
    createdAt: record.createdAt,
    priorReviewId: record.priorReviewId, userRequestId: record.userRequestId,
    reviewAttempts: record.reviewAttempts, attemptFailures: record.attemptFailures,
    consumedAt: record.consumedAt
  });
}

function normalizeRecord(value: unknown): ApprovalReviewRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as ApprovalReviewRecord;
  if (!record.reviewId || !record.runtimeId || !record.sessionId || !record.rootTaskId || !record.agentRunId || !record.targetId
    || !['external_file_access', 'validation_run', 'draft_edit_apply', 'draft_delete_apply', 'draft_run_execute'].includes(record.actionKind)
    || !record.actionHash || !Number.isInteger(record.policyVersion)
    || !['auto_approval_review', 'host_policy', 'local_policy', 'user_click'].includes(record.approvalSource)
    || (record.approvalMode !== undefined && record.approvalMode !== 'delegate')
    || !['approve', 'needs_user', 'deny', 'unavailable'].includes(record.decision)
    || !['low', 'medium', 'high', 'critical'].includes(record.risk)
    || typeof record.rationale !== 'string' || !Array.isArray(record.policyRules)
    || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  return structuredClone({
    ...record,
    projectApproval: hasVerifiedProjectApproval(record) ? true : undefined,
    reviewState: normalizeApprovalReviewState(record.reviewState),
    riskUnassessed: record.riskUnassessed === true ? true : undefined,
    effectHash: typeof record.effectHash === 'string' && /^[a-f0-9]{64}$/u.test(record.effectHash) ? record.effectHash : undefined,
    priorReviewId: typeof record.priorReviewId === 'string' ? record.priorReviewId.slice(0, 300) : undefined,
    userRequestId: typeof record.userRequestId === 'string' ? record.userRequestId.slice(0, 300) : undefined,
    supersededByReviewId: typeof record.supersededByReviewId === 'string' ? record.supersededByReviewId.slice(0, 300) : undefined,
    reviewAttempts: normalizeApprovalReviewAttempts(record.reviewAttempts),
    attemptFailures: normalizeApprovalAttemptFailures(record.attemptFailures),
    historyInvalidatedBy: typeof record.historyInvalidatedBy === 'string' && record.historyInvalidatedBy.length > 0
      ? record.historyInvalidatedBy.slice(0, 300) : undefined,
    osIsolation: normalizeApprovalExecutionIsolation(record.osIsolation),
    businessAuthorization: normalizeBusinessAuthorization(record.businessAuthorization),
    authorizationPending: record.authorizationPending === true ? true : undefined,
    affectedTargets: Array.isArray(record.affectedTargets)
      ? record.affectedTargets.filter(target => typeof target === 'string').slice(0, MAX_APPROVAL_TARGETS).map(target => target.slice(0, 300)) : undefined,
    reviewerConfigFingerprint: typeof record.reviewerConfigFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(record.reviewerConfigFingerprint)
      ? record.reviewerConfigFingerprint : undefined,
    originalActionHash: typeof record.originalActionHash === 'string' && /^[a-f0-9]{64}$/u.test(record.originalActionHash)
      ? record.originalActionHash : undefined
  });
}

function hasVerifiedProjectApproval(record: ReviewRecordInput): boolean {
  return record.projectApproval === true && record.policyVersion >= 7 && record.policyVersion <= APPROVAL_POLICY_VERSION
    && record.approvalSource === 'auto_approval_review' && record.decision === 'approve'
    && !record.reviewState && record.policyRules.includes(VERIFIED_PROJECT_OPERATION_RULE)
    && (['low', 'medium'].includes(record.risk) || hasAuthorizedHighRiskApproval(record));
}

function hasAuthorizedHighRiskApproval(record: ReviewRecordInput): boolean {
  return record.policyVersion === APPROVAL_POLICY_VERSION && record.risk === 'high' && Boolean(record.scopeFingerprint)
    && record.policyRules.includes(AUTHORIZED_BUSINESS_EFFECT_RULE) && !!normalizeBusinessAuthorization(record.businessAuthorization);
}
