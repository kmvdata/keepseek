import { createHash, randomUUID } from 'node:crypto';
import type {
  ActivatedSkill,
  AgentResponse,
  ChatSession,
  ExecutionMode,
  PlanWorkflowRecord,
  PlanWorkflowStatus,
  PlanWorkflowView
} from '../shared/types';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELEGATE_PARALLEL_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME
} from './protocol';
import { resolveSubagentProfile } from './subagents/profiles';

export type PlanDecisionAction = 'start_execution' | 'revise_plan' | 'exit_plan';

export const PLAN_WORKFLOW_TAIL = [
  '[Plan workflow — planning phase only.]',
  'Read, search, and analyze the codebase before deciding the implementation approach.',
  'Ask the user only when a choice materially affects architecture, scope, or an irreversible decision and cannot be settled from the codebase or a sensible default.',
  'Do not begin implementation in this turn. Do not create DraftEdit or DraftRun proposals, delete drafts, apply patches, or delegate to writer/proposal-capable subagents.',
  'End with a complete two-level Markdown implementation plan and then stop. Use about 2–6 top-level numbered phases, with indented concrete and verifiable bullet steps under each phase. Do not write phases as Markdown headings.',
  'The host will ask the user to approve, revise, or exit after the complete plan is returned.'
].join('\n');

export const PLAN_EXECUTION_CONTINUATION_PROMPT = [
  'The user explicitly approved the preceding implementation plan in the KeepSeek confirmation card.',
  'The planning phase has ended. Implement that plan now.',
  'The configured ApprovalMode still applies independently to every DraftEdit and DraftRun.',
  'Do not claim that a file changed before its DraftEdit is applied, and do not claim that a DraftRun ran before it is approved and executed.'
].join('\n');

export const PLAN_PHASE_BLOCKED_ERROR_TYPE = 'plan_phase_implementation_blocked';

const DIRECT_IMPLEMENTATION_TOOLS = new Set([
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME
]);

const PLAN_WORKFLOW_STATUSES = new Set<PlanWorkflowStatus>([
  'pending',
  'approved',
  'revision_requested',
  'exited',
  'superseded'
]);

export function normalizeExecutionMode(value: unknown): ExecutionMode {
  return value === 'plan' ? 'plan' : 'normal';
}

export function getPlanWorkflowTail(mode: ExecutionMode): string {
  return mode === 'plan' ? PLAN_WORKFLOW_TAIL : '';
}

export function hashPlanContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizePlanWorkflowRecords(
  value: unknown,
  sessionId: string
): PlanWorkflowRecord[] {
  if (!Array.isArray(value)) return [];
  const records: PlanWorkflowRecord[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.id !== 'string'
      || !item.id.trim()
      || seen.has(item.id)
      || item.sessionId !== sessionId
      || typeof item.userMessageId !== 'string'
      || !item.userMessageId
      || typeof item.assistantMessageId !== 'string'
      || !item.assistantMessageId
      || typeof item.contentHash !== 'string'
      || !/^[a-f0-9]{64}$/u.test(item.contentHash)
      || typeof item.status !== 'string'
      || !PLAN_WORKFLOW_STATUSES.has(item.status as PlanWorkflowStatus)
      || typeof item.createdAt !== 'string'
      || !Number.isFinite(Date.parse(item.createdAt))) {
      continue;
    }
    records.push({
      id: item.id,
      sessionId,
      userMessageId: item.userMessageId,
      assistantMessageId: item.assistantMessageId,
      contentHash: item.contentHash,
      status: item.status as PlanWorkflowStatus,
      createdAt: item.createdAt,
      decidedAt: typeof item.decidedAt === 'string' && Number.isFinite(Date.parse(item.decidedAt))
        ? item.decidedAt
        : undefined
    });
    seen.add(item.id);
  }
  return records;
}

export function registerPendingPlan(input: {
  session: ChatSession;
  userMessageId: string;
  assistantMessageId: string;
  content: string;
  now?: string;
  id?: string;
}): PlanWorkflowRecord {
  const now = input.now ?? new Date().toISOString();
  for (const record of input.session.planWorkflows ?? []) {
    if (record.status === 'pending' || record.status === 'revision_requested') {
      record.status = 'superseded';
      record.decidedAt = now;
    }
  }
  const record: PlanWorkflowRecord = {
    id: input.id ?? randomUUID(),
    sessionId: input.session.id,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    contentHash: hashPlanContent(input.content),
    status: 'pending',
    createdAt: now
  };
  input.session.planWorkflows = [...(input.session.planWorkflows ?? []), record];
  return record;
}

export function requestPlanRevisionForNewPrompt(session: ChatSession, now = new Date().toISOString()): boolean {
  const pending = getLatestPendingPlan(session);
  if (!pending) return false;
  pending.status = 'revision_requested';
  pending.decidedAt = now;
  return true;
}

export function invalidatePlansForRemovedMessages(
  session: ChatSession,
  removedMessageIds: ReadonlySet<string>,
  now = new Date().toISOString()
): boolean {
  let changed = false;
  for (const record of session.planWorkflows ?? []) {
    if ((record.status === 'pending' || record.status === 'revision_requested')
      && (removedMessageIds.has(record.userMessageId) || removedMessageIds.has(record.assistantMessageId))) {
      record.status = 'superseded';
      record.decidedAt = now;
      changed = true;
    }
  }
  return changed;
}

export function exitPendingPlan(session: ChatSession, now = new Date().toISOString()): boolean {
  const pending = getLatestPendingPlan(session);
  if (!pending) return false;
  pending.status = 'exited';
  pending.decidedAt = now;
  return true;
}

export function resolvePlanDecision(input: {
  session: ChatSession;
  activeSessionId: string;
  planId: string;
  action: PlanDecisionAction;
  now?: string;
}): { ok: true; record: PlanWorkflowRecord; startExecution: boolean } | { ok: false; reason: string } {
  if (input.session.id !== input.activeSessionId) {
    return { ok: false, reason: 'plan_session_mismatch' };
  }
  if (normalizeExecutionMode(input.session.executionMode) !== 'plan') {
    return { ok: false, reason: 'plan_mode_inactive' };
  }
  if (input.action !== 'start_execution' && input.action !== 'revise_plan' && input.action !== 'exit_plan') {
    return { ok: false, reason: 'plan_action_invalid' };
  }
  const record = (input.session.planWorkflows ?? []).find((candidate) => candidate.id === input.planId);
  const latest = getLatestPendingPlan(input.session);
  if (!record || record.status !== 'pending' || latest?.id !== record.id) {
    return { ok: false, reason: 'plan_not_pending' };
  }
  if (!isPlanRecordContentValid(input.session, record)) {
    return { ok: false, reason: 'plan_hash_mismatch' };
  }
  const now = input.now ?? new Date().toISOString();
  if (input.action === 'start_execution') {
    input.session.executionMode = 'normal';
    record.status = 'approved';
  } else if (input.action === 'revise_plan') {
    input.session.executionMode = 'plan';
    record.status = 'revision_requested';
  } else {
    input.session.executionMode = 'normal';
    record.status = 'exited';
  }
  record.decidedAt = now;
  input.session.updatedAt = now;
  return { ok: true, record, startExecution: input.action === 'start_execution' };
}

export function getLatestPendingPlan(session: ChatSession): PlanWorkflowRecord | undefined {
  const records = session.planWorkflows ?? [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (records[index].status === 'pending') return records[index];
  }
  return undefined;
}

export function getPlanWorkflowViews(session: ChatSession): PlanWorkflowView[] {
  const latestPending = getLatestPendingPlan(session);
  return (session.planWorkflows ?? []).map((record) => {
    const view: PlanWorkflowView = {
      id: record.id,
      sessionId: record.sessionId,
      userMessageId: record.userMessageId,
      assistantMessageId: record.assistantMessageId,
      status: record.status,
      createdAt: record.createdAt,
      decidedAt: record.decidedAt
    };
    if (record.status === 'pending' && (record.id !== latestPending?.id || !isPlanRecordContentValid(session, record))) {
      return { ...view, status: 'invalid' };
    }
    return view;
  });
}

export function isPlanRecordContentValid(session: ChatSession, record: PlanWorkflowRecord): boolean {
  if (record.sessionId !== session.id) return false;
  const userMessage = session.messages.find((message) => message.id === record.userMessageId && message.role === 'user');
  const assistantMessage = session.messages.find((message) => message.id === record.assistantMessageId && message.role === 'assistant');
  return Boolean(userMessage && assistantMessage && hashPlanContent(assistantMessage.content) === record.contentHash);
}

export function getPlanPhaseToolBlockReason(input: {
  executionMode: unknown;
  toolName: string;
  args?: Record<string, unknown>;
  skills?: readonly ActivatedSkill[];
}): string | undefined {
  if (normalizeExecutionMode(input.executionMode) !== 'plan') return undefined;
  if (DIRECT_IMPLEMENTATION_TOOLS.has(input.toolName)) {
    return `Tool ${input.toolName} is unavailable during the planning phase because it prepares implementation work.`;
  }
  if (input.toolName !== DELEGATE_TASK_TOOL_NAME && input.toolName !== DELEGATE_PARALLEL_TOOL_NAME) {
    return undefined;
  }
  const invocations = input.toolName === DELEGATE_PARALLEL_TOOL_NAME && Array.isArray(input.args?.tasks)
    ? input.args.tasks.filter(isRecord)
    : [input.args ?? {}];
  for (const invocation of invocations) {
    if (typeof invocation.continueSubagentId === 'string' && invocation.continueSubagentId.trim()) {
      return 'Subagent continuations are unavailable during the planning phase because the host cannot prove that the stored child is read-only before dispatch.';
    }
    const requestedId = typeof invocation.profile === 'string' ? invocation.profile : undefined;
    const requestedLane = invocation.lane === 'proposal' || invocation.lane === 'review-read'
      || invocation.lane === 'research-read' || invocation.lane === 'nested-read'
      ? invocation.lane
      : undefined;
    const profile = resolveSubagentProfile({ requestedId, requestedLane, skills: input.skills });
    if (!profile || profile.lane === 'proposal') {
      return 'Writer/proposal-capable subagents are unavailable during the planning phase. Use a read-only research or review profile.';
    }
  }
  return undefined;
}

export function hasPlanImplementationArtifacts(
  response: Pick<AgentResponse, 'changeSet' | 'draftEdits' | 'draftRuns'>
): boolean {
  return Boolean(response.changeSet) || response.draftEdits.length > 0 || Boolean(response.draftRuns?.length);
}

export function createPlanPhaseBlockedToolResult(toolName: string, reason: string): string {
  return JSON.stringify({
    ok: false,
    errorType: PLAN_PHASE_BLOCKED_ERROR_TYPE,
    executionMode: 'plan',
    phase: 'planning',
    toolName,
    error: `${reason} Finish the implementation plan and wait for the user's confirmation card before implementing.`
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
