import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import {
  APPROVAL_POLICY_VERSION,
  type ApprovalRecordMatch,
  type ApprovalReviewDisplay,
  type ApprovalReviewRecord
} from './approvalReviewTypes';

const MAX_RECORDS = 1_000;

export class ApprovalReviewStore {
  public readonly runtimeId = randomUUID();
  private readonly storageUri: vscode.Uri;
  private readonly records = new Map<string, ApprovalReviewRecord>();
  private persistenceQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  public constructor(globalStorageUri: vscode.Uri) {
    this.storageUri = vscode.Uri.joinPath(globalStorageUri, 'approval-reviews.json');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.storageUri);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { version?: number; records?: unknown[] };
      if (parsed.version !== 1) return;
      for (const value of parsed.records ?? []) {
        const record = normalizeRecord(value);
        if (record) this.records.set(record.reviewId, record);
      }
    } catch {
      // Missing or malformed review history never authorizes an operation.
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
    await this.persist();
    return structuredClone(record);
  }

  public get(reviewId: string): ApprovalReviewRecord | undefined {
    const record = this.records.get(reviewId);
    return record ? structuredClone(record) : undefined;
  }

  public getLatestForTarget(targetId: string): ApprovalReviewDisplay | undefined {
    const record = [...this.records.values()]
      .filter((item) => item.targetId === targetId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return record ? toDisplay(record) : undefined;
  }

  public findCurrentRuntimeDenial(input: Omit<ApprovalRecordMatch, 'reviewId' | 'approvalMode' | 'workspaceTrusted'>): ApprovalReviewRecord | undefined {
    const record = [...this.records.values()].reverse().find((item) => item.runtimeId === this.runtimeId
      && item.sessionId === input.sessionId
      && item.agentRunId === input.agentRunId
      && item.targetId === input.targetId
      && item.actionKind === input.actionKind
      && item.actionHash === input.actionHash
      && item.policyVersion === input.policyVersion
      && item.decision === 'deny');
    return record ? structuredClone(record) : undefined;
  }

  public findCurrentRuntimeDenialForAction(input: {
    sessionId: string;
    rootTaskId: string;
    actionKind: ApprovalReviewRecord['actionKind'];
    actionHash: string;
  }): ApprovalReviewRecord | undefined {
    const record = [...this.records.values()].reverse().find((item) => item.runtimeId === this.runtimeId
      && item.sessionId === input.sessionId
      && item.rootTaskId === input.rootTaskId
      && item.actionKind === input.actionKind
      && item.actionHash === input.actionHash
      && item.decision === 'deny');
    return record ? structuredClone(record) : undefined;
  }

  public async consumeMatchingApproval(input: ApprovalRecordMatch): Promise<ApprovalReviewRecord> {
    if (!input.workspaceTrusted) throw new Error('Approval record cannot be consumed in an untrusted workspace.');
    const record = this.records.get(input.reviewId);
    const expectedSource = input.approvalMode === 'model_review' ? 'model_review' : 'host_policy';
    if (!record || record.runtimeId !== this.runtimeId || record.consumedAt
      || record.sessionId !== input.sessionId || record.agentRunId !== input.agentRunId
      || record.targetId !== input.targetId || record.actionKind !== input.actionKind
      || record.actionHash !== input.actionHash || input.policyVersion !== APPROVAL_POLICY_VERSION
      || record.policyVersion !== input.policyVersion
      || record.approvalSource !== expectedSource || record.decision !== 'approve') {
      throw new Error('No current matching approval record exists for this exact operation.');
    }
    record.consumedAt = new Date().toISOString();
    await this.persist();
    return structuredClone(record);
  }

  public async flush(): Promise<void> { await this.persistenceQueue; }

  private compact(): void {
    if (this.records.size <= MAX_RECORDS) return;
    const remove = [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, this.records.size - MAX_RECORDS);
    remove.forEach((record) => this.records.delete(record.reviewId));
  }

  private async persist(): Promise<void> {
    const write = async () => await writeJsonAtomic(this.storageUri, {
      version: 1,
      records: [...this.records.values()]
    });
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
    approvalSource: record.approvalSource,
    reviewerSourceId: record.reviewerSourceId,
    reviewerModelId: record.reviewerModelId,
    reviewerProvider: record.reviewerProvider,
    decision: record.decision,
    risk: record.risk,
    rationale: record.rationale,
    saferAlternative: record.saferAlternative,
    createdAt: record.createdAt,
    consumedAt: record.consumedAt
  });
}

function normalizeRecord(value: unknown): ApprovalReviewRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as ApprovalReviewRecord;
  if (!record.reviewId || !record.runtimeId || !record.sessionId || !record.agentRunId || !record.targetId
    || !['external_file_access', 'validation_run', 'draft_edit_apply', 'draft_delete_apply', 'draft_run_execute'].includes(record.actionKind)
    || !record.actionHash || !Number.isInteger(record.policyVersion)
    || !['model_review', 'host_policy', 'local_policy'].includes(record.approvalSource)
    || !['approve', 'deny', 'unavailable'].includes(record.decision)
    || !['low', 'medium', 'high', 'critical'].includes(record.risk)
    || typeof record.rationale !== 'string' || !Array.isArray(record.policyRules)
    || !Number.isFinite(Date.parse(record.createdAt))) return undefined;
  return structuredClone({
    ...record,
    rootTaskId: typeof record.rootTaskId === 'string' && record.rootTaskId ? record.rootTaskId : record.agentRunId
  });
}
