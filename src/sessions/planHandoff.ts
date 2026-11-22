import { createHash } from 'node:crypto';
import { buildPlanHandoffPrompt, getLatestPendingPlan, hashPlanContent, isPlanRecordContentValid } from '../agent/handoffPrompt';
import { getApprovalModeUserTail } from '../agent/approvalMode';
import type { KeepseekLanguage } from '../shared/i18n';
import type { ApprovalMode, ChatSession } from '../shared/types';
import { normalizeUserTaskBudgets, type UserTaskBudget } from './userTaskBudget';

export interface PlanHandoffInput {
  sourceSessionId: string;
  planId: string;
  planHash: string;
  body: string;
  bodyHash: string;
  projectScopeUri: string;
  canonicalScopeUri?: string;
  language?: KeepseekLanguage;
  approvalMode: ApprovalMode;
  sourceId: string;
  modelId: string;
}

export type PlanHandoffPhase = 'committed' | 'queued' | 'dispatch_unknown' | 'completed';

/** The source shard owns this journal. The budget is an immutable transfer
 * receipt. Only the target's userTaskBudgets entry can subsequently spend it. */
export interface PlanHandoffRecord extends PlanHandoffInput {
  version: 1;
  id: string;
  workspaceKey: string;
  sourceTaskId: string;
  targetSessionId: string;
  targetMessageId: string;
  confirmedAt: string;
  phase: PlanHandoffPhase;
  budget: UserTaskBudget;
  projectionHash?: string;
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const validHash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192;
const validScope = (v: unknown): v is string => validId(v) && /^file:\/\//iu.test(v);
const phases: readonly PlanHandoffPhase[] = ['committed', 'queued', 'dispatch_unknown', 'completed'];

function identities(scope: string, source: string, plan: string) {
  const id = hash(JSON.stringify([1, scope, source, plan]));
  return { id, targetSessionId: hash('session:' + id), targetMessageId: hash('message:' + id) };
}

export function normalizePlanHandoffs(value: unknown, source: string, workspace: string): PlanHandoffRecord[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid plan handoff journal');
  const ids = new Set<string>();
  const tasks = new Set<string>();
  return value.map((v: PlanHandoffRecord) => {
    if (!v || typeof v !== 'object' || v.version !== 1 || v.workspaceKey !== workspace
      || v.sourceSessionId !== source || !validId(v.planId) || !validId(v.sourceTaskId)
      || !validScope(v.projectScopeUri) || (v.canonicalScopeUri !== undefined && !validScope(v.canonicalScopeUri)) || !validId(v.sourceId) || !validId(v.modelId)
      || (v.language !== undefined && v.language !== 'en' && v.language !== 'zh-CN')
      || !['ask', 'approve-all'].includes(v.approvalMode) || !validHash(v.planHash) || !validHash(v.bodyHash)
      || typeof v.body !== 'string' || !v.body || v.body !== v.body.trim() || v.body.length > 32_000
      || hash(v.body) !== v.bodyHash || !phases.includes(v.phase)
      || typeof v.confirmedAt !== 'string' || !Number.isFinite(Date.parse(v.confirmedAt))
      || (phases.indexOf(v.phase) >= 2 ? !validHash(v.projectionHash) : v.projectionHash !== undefined)) {
      throw new Error('Invalid plan handoff identity, hash or phase');
    }
    const expected = identities(workspace, source, v.planId);
    const budget = normalizeUserTaskBudgets({ [v.targetMessageId]: v.budget })[v.targetMessageId];
    if (!budget || v.id !== expected.id || v.targetSessionId !== expected.targetSessionId
      || v.targetMessageId !== expected.targetMessageId || ids.has(v.id) || tasks.has(v.sourceTaskId)) {
      throw new Error('Invalid plan handoff reservation');
    }
    ids.add(v.id);
    tasks.add(v.sourceTaskId);
    return { version: 1, ...expected, workspaceKey: workspace, sourceSessionId: source,
      planId: v.planId, planHash: v.planHash, body: v.body, bodyHash: v.bodyHash,
      sourceTaskId: v.sourceTaskId, confirmedAt: v.confirmedAt, projectScopeUri: v.projectScopeUri,
      ...(v.canonicalScopeUri && { canonicalScopeUri: v.canonicalScopeUri }), ...(v.language && { language: v.language }),
      approvalMode: v.approvalMode, sourceId: v.sourceId, modelId: v.modelId, phase: v.phase,
      budget, ...(v.projectionHash && { projectionHash: v.projectionHash }) };
  });
}

/** Small source-shard watermark. A stale generic session snapshot cannot
 * resurrect the source budget or regress a dispatch claim, even if another
 * reader in that process has refreshed the object-store revision. */
export function handoffWatermarks(session: ChatSession): { id: string; hash: string; phase: number; projectionHash?: string }[] | undefined {
  const records = normalizePlanHandoffs(session.planHandoffs, session.id, session.workspaceKey);
  if (!records?.length) return undefined;
  return records.map(record => {
    if (session.userTaskBudgets?.[record.sourceTaskId] || session.planWorkflows?.some(
      plan => plan.id === record.planId && plan.status !== 'superseded')) throw new Error('Transferred task is sealed / 已移交的任务不可继续');
    const { phase, projectionHash, ...identity } = record;
    return { id: record.id, hash: hash(JSON.stringify(identity)), phase: phases.indexOf(phase), projectionHash };
  });
}

export function assertHandoffInput(record: PlanHandoffRecord, input: PlanHandoffInput): void {
  const fields = ['planHash', 'bodyHash', 'body', 'sourceSessionId', 'planId', 'projectScopeUri', 'canonicalScopeUri', 'language', 'approvalMode', 'sourceId', 'modelId'] as const;
  if (fields.some(key => input[key] !== record[key])) throw new Error('Plan handoff preview changed / 交接预览已变化');
}

export function reservePlanHandoff(source: ChatSession, input: PlanHandoffInput): PlanHandoffRecord {
  const prior = source.planHandoffs?.find(record => record.planId === input.planId);
  if (prior) {
    assertHandoffInput(prior, input);
    return prior;
  }
  const plan = getLatestPendingPlan(source);
  if (!plan || plan.id !== input.planId || input.sourceSessionId !== source.id || plan.contentHash !== input.planHash
    || !isPlanRecordContentValid(source, plan) || hashPlanContent(input.body) !== input.bodyHash
    || (source.projectScopeUri ?? (source.workspaceFolders.length === 1 && source.workspaceFolders[0])) !== input.projectScopeUri
    || input.body.length + 2 + getApprovalModeUserTail(input.approvalMode).length > 32_000
    || source.approvalMode !== input.approvalMode || source.pendingHistoryTruncation) {
    throw new Error('Plan, scope or preview changed / 计划、范围或预览已变化');
  }
  if (input.language) {
    const preview = buildPlanHandoffPrompt(source, plan.id, input.language);
    if (!preview.ok || preview.bodyHash !== input.bodyHash || preview.body !== input.body || preview.planHash !== input.planHash) {
      throw new Error('The reviewed prompt has changed / 已预览的交接正文发生变化');
    }
  }
  const sourceTaskId = source.messages.find(m => m.id === plan.userMessageId)?.userTask?.id;
  const budget = sourceTaskId && source.userTaskBudgets?.[sourceTaskId];
  if (!sourceTaskId || !budget || source.planHandoffs?.some(r => r.sourceTaskId === sourceTaskId)) {
    throw new Error('Task budget unavailable or transferred / 任务预算不可用或已移交');
  }
  const reservation = identities(source.workspaceKey, source.id, plan.id);
  // Correction keys, permit-like scope references and child paths belong to the
  // source. Retain counts, limits, charged reservations and exhaustion states.
  const transfer: UserTaskBudget = { ...structuredClone(budget), commandRecoveryKeys: undefined,
    commandRecoveryObservations: undefined,
    delegationBudget: budget.delegationBudget && { ...budget.delegationBudget, paths: [], parents: budget.delegationBudget.parents.map(
      ([id, count]) => [id === sourceTaskId ? reservation.targetMessageId : id, count]) } };
  const now = new Date().toISOString();
  const candidate: PlanHandoffRecord = { ...input, version: 1, ...reservation, workspaceKey: source.workspaceKey,
    confirmedAt: now, phase: 'committed', budget: transfer, sourceTaskId };
  const record = normalizePlanHandoffs([candidate], source.id, source.workspaceKey)![0];
  plan.status = 'superseded';
  plan.decidedAt = now;
  source.planHandoffs = [...(source.planHandoffs ?? []), record];
  delete source.userTaskBudgets![sourceTaskId];
  source.updatedAt = now;
  return record;
}

export function assertHandoffTarget(target: ChatSession, r: PlanHandoffRecord): void {
  if (target.id !== r.targetSessionId || target.workspaceKey !== r.workspaceKey || target.planHandoffId !== r.id
    || target.planHandoffSourceId !== r.sourceSessionId) throw new Error('Handoff target identity changed / 交接目标身份已变化');
  // Once both the result and target receipt are known, its history is an
  // ordinary conversation and the user can edit messages there.
  if (target.planHandoffCompleted) return;
  const message = target.messages[0];
  if (target.projectScopeUri !== r.projectScopeUri || message?.role !== 'user' || message.id !== r.targetMessageId
    || message.userTask?.id !== r.targetMessageId || message.userTask.originMessageId !== r.targetMessageId
    || message.userTask.reason !== 'plan' || message.content !== r.body
    || message.providerContent !== r.body + '\n\n' + getApprovalModeUserTail(r.approvalMode) || message.modelId !== r.modelId
    || message.contextMeta?.protectedReason !== 'first_user_request' || hash(message.content) !== r.bodyHash) {
    throw new Error('Plan handoff target identity changed / 交接目标身份或正文已变化');
  }
}
