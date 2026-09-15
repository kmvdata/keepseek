import { isGoalTerminalStatus, type GoalRecordV1, type GoalStatus } from './goalTypes';

const TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  preparing: ['running', 'paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  running: ['pausing', 'waiting_for_apply', 'waiting_for_authorization', 'waiting_for_command', 'waiting_for_user', 'needs_attention', 'interrupted', 'completed', 'failed', 'stopped'],
  pausing: ['paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  paused: ['running', 'needs_attention', 'interrupted', 'stopped'],
  waiting_for_apply: ['running', 'paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  waiting_for_authorization: ['running', 'paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  waiting_for_command: ['running', 'paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  waiting_for_user: ['running', 'paused', 'needs_attention', 'interrupted', 'failed', 'stopped'],
  needs_attention: ['paused', 'running', 'interrupted', 'stopped', 'failed'],
  interrupted: ['paused', 'running', 'needs_attention', 'stopped', 'failed'],
  completed: [],
  failed: [],
  stopped: []
};

export function canTransitionGoal(from: GoalStatus, to: GoalStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function transitionGoal(
  record: GoalRecordV1,
  to: GoalStatus,
  options: { now?: string; reason?: string } = {}
): GoalRecordV1 {
  if (record.status === to) return structuredClone(record);
  if (!canTransitionGoal(record.status, to)) throw new Error(`Illegal Goal transition: ${record.status} -> ${to}`);
  const now = options.now ?? new Date().toISOString();
  const next = structuredClone(record);
  next.status = to;
  next.updatedAt = now;
  next.waitingReason = isWaiting(to) ? bounded(options.reason) : undefined;
  next.stopReason = isGoalTerminalStatus(to) || to === 'needs_attention' || to === 'interrupted'
    ? bounded(options.reason) : undefined;
  if (isGoalTerminalStatus(to)) next.endedAt = now;
  return next;
}

function isWaiting(status: GoalStatus): boolean {
  return status.startsWith('waiting_') || status === 'paused' || status === 'pausing';
}

function bounded(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 1_000) : undefined;
}
