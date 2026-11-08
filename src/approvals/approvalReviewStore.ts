import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import { readSessionAuditLanes, sessionAuditLaneUri } from '../shared/sessionAuditLanes';
import type { HistoryTruncationScope } from '../sessions/historyTruncation';
import {
  policyVersionFor,
  reviewerRoute,
  type ApprovalRecordMatch,
  type ApprovalReviewDisplay,
  type ApprovalReviewRecord,
  type ApprovalReviewRequest
} from './approvalReviewTypes';

const MAX_RECORDS = 1_000;

export class ApprovalReviewStore {
  public readonly runtimeId = randomUUID();
  private readonly storageUri: vscode.Uri;
  private readonly records = new Map<string, ApprovalReviewRecord>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private readonly sessionLanesUri: vscode.Uri;
  private readonly freshSessionIds = new Set<string>();

  public constructor(globalStorageUri: vscode.Uri) {
    this.storageUri = vscode.Uri.joinPath(globalStorageUri, 'approval-reviews.json');
    this.sessionLanesUri = vscode.Uri.joinPath(globalStorageUri, 'approval-reviews', 'sessions');
  }

  public async initializeFreshSession(sessionId: string): Promise<void> {
    sessionAuditLaneUri(this.sessionLanesUri, sessionId);
    this.freshSessionIds.add(sessionId);
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
      for (const value of parsed.version === 1 ? parsed.records ?? [] : []) {
        const record = normalizeRecord(value);
        if (record && !this.records.has(record.reviewId)) this.records.set(record.reviewId, record);
      }
    } catch {
      // Missing or malformed review history never authorizes an operation.
    }
    for (const lane of await readSessionAuditLanes(this.sessionLanesUri)) {
      this.freshSessionIds.add(lane.sessionId);
      for (const value of Array.isArray(lane.records) ? lane.records : []) {
        const record = normalizeRecord(value);
        if (record?.sessionId === lane.sessionId && !this.records.has(record.reviewId)) this.records.set(record.reviewId, record);
      }
    }
  }

  public async add(input: Omit<ApprovalReviewRecord, 'reviewId' | 'runtimeId' | 'createdAt'>): Promise<ApprovalReviewRecord> {
    const record: ApprovalReviewRecord = {
      ...input,
      reviewId: randomUUID(),
      runtimeId: this.runtimeId,
      createdAt: new Date().toISOString()
    };
    this.records.set(record.reviewId, record);
    this.compact();
    await this.persist(record.sessionId);
    return structuredClone(record);
  }

  public get(reviewId: string): ApprovalReviewRecord | undefined {
    const record = this.records.get(reviewId);
    return record ? structuredClone(record) : undefined;
  }

  /** Preserve immutable audit results while revoking membership and unused authority. */
  public async invalidateHistory(scope: HistoryTruncationScope, removedTargetIds: readonly string[] = []): Promise<void> {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.sessionId !== scope.sessionId || (!scope.removedSegmentIds.includes(record.agentRunId)
        && !removedTargetIds.includes(record.targetId))
        || record.historyInvalidatedBy) continue;
      record.historyInvalidatedBy = scope.id;
      changed = true;
    }
    // Persist even on retry: a prior write may have failed after the in-memory mark.
    if (changed || [...this.records.values()].some(record => record.historyInvalidatedBy === scope.id)) await this.persist(scope.sessionId);
  }

  public matchesSnapshot(reviewId: string, request: ApprovalReviewRequest): boolean {
    const record = this.records.get(reviewId);
    return !!record && !record.historyInvalidatedBy && record.sessionId === request.sessionId && record.rootTaskId === request.rootTaskId
      && record.agentRunId === request.agentRunId && record.targetId === request.targetId
      && record.actionKind === request.actionKind && record.actionHash === request.actionHash
      && record.scopeFingerprint === request.scopeFingerprint && record.policyVersion === policyVersionFor(record.approvalSource);
  }

  public getLatestForTarget(targetId: string): ApprovalReviewDisplay | undefined {
    const record = [...this.records.values()]
      .reverse().find((item) => item.targetId === targetId && !item.historyInvalidatedBy);
    return record ? toDisplay(record) : undefined;
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
    return [...this.records.values()].reverse().find(record => !record.historyInvalidatedBy && record.sessionId === sessionId
      && record.actionKind === 'draft_run_execute' && record.decision === 'deny'
      && (record.actionHash === actionHash || record.originalActionHash === actionHash)
      && (record.approvalSource === 'local_policy' || record.approvalSource === 'auto_approval_review' || record.risk === 'critical'));
  }

  public hasAutomaticReviewAttempt(request: ApprovalReviewRequest): boolean {
    return [...this.records.values()].some(record => !record.historyInvalidatedBy && record.approvalSource === 'auto_approval_review'
      && record.sessionId === request.sessionId && record.rootTaskId === request.rootTaskId
      && record.agentRunId === request.agentRunId && record.targetId === request.targetId);
  }

  public async consumeMatchingApproval(input: ApprovalRecordMatch): Promise<ApprovalReviewRecord> {
    if (!input.workspaceTrusted) throw new Error('Approval record cannot be consumed in an untrusted workspace.');
    const record = this.records.get(input.reviewId);
    if (!record || record.historyInvalidatedBy || record.runtimeId !== this.runtimeId || record.consumedAt
      || record.sessionId !== input.sessionId || record.rootTaskId !== input.rootTaskId || record.agentRunId !== input.agentRunId
      || record.targetId !== input.targetId || record.actionKind !== input.actionKind
      || record.actionHash !== input.actionHash || input.policyVersion !== policyVersionFor(input.expectedSource)
      || record.policyVersion !== input.policyVersion
      || record.approvalSource !== input.expectedSource || record.decision !== 'approve'
      || record.approvalMode !== input.approvalMode || record.scopeFingerprint !== input.scopeFingerprint
      || record.reviewerConfigFingerprint !== input.reviewerConfigFingerprint
      || (input.expectedSource === 'auto_approval_review' && !input.reviewerConfigFingerprint)
      || (input.expectedSource === 'host_policy' && input.approvalMode === 'model_review')
      || (input.expectedSource === 'auto_approval_review' && input.expectedSource !== reviewerRoute(input.approvalMode))) {
      throw new Error('No current matching approval record exists for this exact operation.');
    }
    record.consumedAt = new Date().toISOString();
    await this.persist(record.sessionId);
    return structuredClone(record);
  }

  public async flush(): Promise<void> { await this.persistenceQueue; }

  public decisionHistory(sessionId: string, rootTaskId: string, beforeReviewId: string): Array<'approve' | 'deny'> {
    const history: Array<'approve' | 'deny'> = [];
    for (const record of this.records.values()) {
      if (record.reviewId === beforeReviewId) break;
      if (!record.historyInvalidatedBy && record.sessionId === sessionId && record.rootTaskId === rootTaskId
        && ['auto_approval_review', 'model_review', 'local_policy'].includes(record.approvalSource)
        && (record.decision === 'approve' || record.decision === 'deny')) history.push(record.decision);
    }
    return history.slice(-50);
  }

  private compact(): void {
    if (this.records.size <= MAX_RECORDS) return;
    const remove = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.records.size - MAX_RECORDS);
    remove.forEach((record) => this.records.delete(record.reviewId));
  }

  private async persist(changedSessionId: string): Promise<void> {
    const snapshot = [...this.records.values()].map(record => structuredClone(record));
    const write = async () => {
      const legacy = snapshot.filter(record => !this.freshSessionIds.has(record.sessionId));
      if (!this.freshSessionIds.has(changedSessionId)) await writeJsonAtomic(this.storageUri, { version: 1, records: legacy });
      for (const sessionId of this.freshSessionIds.has(changedSessionId) ? [changedSessionId] : []) {
        await writeJsonAtomic(sessionAuditLaneUri(this.sessionLanesUri, sessionId), {
          version: 1, sessionId, records: snapshot.filter(record => record.sessionId === sessionId)
        }, { durable: true });
      }
    };
    this.persistenceQueue = this.persistenceQueue.then(write, write);
    await this.persistenceQueue;
  }
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
    osIsolation: record.osIsolation,
    reviewerSourceId: record.reviewerSourceId,
    reviewerModelId: record.reviewerModelId,
    reviewerProvider: record.reviewerProvider,
    decision: record.decision,
    risk: record.risk,
    rationale: record.rationale,
    saferAlternative: record.saferAlternative,
    affectedTargets: record.affectedTargets,
    createdAt: record.createdAt,
    priorReviewId: record.priorReviewId, userRequestId: record.userRequestId,
    consumedAt: record.consumedAt
  });
}

function normalizeRecord(value: unknown): ApprovalReviewRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as ApprovalReviewRecord;
  if (!record.reviewId || !record.runtimeId || !record.sessionId || !record.agentRunId || !record.targetId
    || !['external_file_access', 'validation_run', 'draft_edit_apply', 'draft_delete_apply', 'draft_run_execute'].includes(record.actionKind)
    || !record.actionHash || !Number.isInteger(record.policyVersion)
    || !['auto_approval_review', 'model_review', 'host_policy', 'local_policy', 'user_click'].includes(record.approvalSource)
    || !['approve', 'needs_user', 'deny', 'unavailable'].includes(record.decision)
    || !['low', 'medium', 'high', 'critical'].includes(record.risk)
    || typeof record.rationale !== 'string' || !Array.isArray(record.policyRules)
    || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  return structuredClone({
    ...record,
    priorReviewId: typeof record.priorReviewId === 'string' ? record.priorReviewId.slice(0, 300) : undefined,
    userRequestId: typeof record.userRequestId === 'string' ? record.userRequestId.slice(0, 300) : undefined,
    historyInvalidatedBy: typeof record.historyInvalidatedBy === 'string' && record.historyInvalidatedBy.length > 0
      ? record.historyInvalidatedBy.slice(0, 300) : undefined,
    osIsolation: record.osIsolation === 'none' ? record.osIsolation : undefined,
    affectedTargets: Array.isArray(record.affectedTargets)
      ? record.affectedTargets.filter(target => typeof target === 'string').slice(0, 12).map(target => target.slice(0, 300)) : undefined,
    reviewerConfigFingerprint: typeof record.reviewerConfigFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(record.reviewerConfigFingerprint)
      ? record.reviewerConfigFingerprint : undefined,
    originalActionHash: typeof record.originalActionHash === 'string' && /^[a-f0-9]{64}$/u.test(record.originalActionHash)
      ? record.originalActionHash : undefined,
    rootTaskId: typeof record.rootTaskId === 'string' && record.rootTaskId ? record.rootTaskId : record.agentRunId
  });
}
