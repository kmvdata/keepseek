import type { BackgroundRunStatus } from '../shared/types';

/**
 * Display-only projection of one conversation's run status for the history list.
 *
 * Ordering and status are deliberately unrelated: the list is ordered by
 * creation time, and a badge only *describes* a row. Nothing here persists,
 * approves, writes or re-sorts; `running` and `failed` are live host
 * observations, so a reload degrades them to whatever the last durable
 * checkpoint still proves.
 */
export type SessionRunStatusKind = 'running' | 'waiting' | 'failed' | 'stopped' | 'completed' | 'idle';

export interface SessionRunStatusView {
  kind: SessionRunStatusKind;
  /** Untrusted short reason (stop reason, blocker, draft ids, error) for the tooltip. */
  detail?: string;
  updatedAt?: string;
  source: 'live' | 'checkpoint' | 'archive';
}

/** Durable proof of how one session's last run ended. */
export interface SessionLastRunObservation {
  /** Omitted when the recorded status is not one this view understands. */
  status?: 'running' | 'interrupted' | 'completed' | 'blocked';
  stopReason?: string;
  error?: string;
  blocker?: string;
  /** The run stopped so the user can act, for example on pending DraftEdits. */
  pendingUser?: boolean;
  updatedAt?: string;
  source?: 'checkpoint' | 'archive';
}

export interface SessionRunStatusInput {
  /** Session ids to project, usually the current workspace's history summaries. */
  sessionIds: readonly string[];
  runningSessionIds?: readonly string[];
  backgroundRun?: { sessionId: string; status: BackgroundRunStatus };
  /** Session that owns the command (DraftRun) currently executing. */
  commandRunSessionId?: string;
  /** Live failure marks; only host memory holds them. */
  liveFailures?: ReadonlyMap<string, { at: string; detail?: string }>;
  /** Durable last-run lookup; `undefined` means "this session has no run". */
  readLastRun: (sessionId: string) => SessionLastRunObservation | undefined;
}

/**
 * One status per session, resolved by strict priority:
 *
 *   running → waiting → failed → stopped → completed → idle
 *
 * The first matching rule wins, so two live signals can never stack two badges
 * on one row. A status never feeds back into the order.
 */
export function projectSessionRunStatuses(
  input: SessionRunStatusInput
): Record<string, SessionRunStatusView> {
  const running = new Set(input.runningSessionIds ?? []);
  const statuses: Record<string, SessionRunStatusView> = {};
  for (const sessionId of input.sessionIds) {
    if (!sessionId) continue;
    const background = input.backgroundRun?.sessionId === sessionId ? input.backgroundRun.status : undefined;
    const lastRun = input.readLastRun(sessionId);
    const failure = input.liveFailures?.get(sessionId);
    const durableSource: SessionRunStatusView['source'] = lastRun?.source === 'archive' ? 'archive' : 'checkpoint';
    const updated = lastRun?.updatedAt ? { updatedAt: lastRun.updatedAt } : {};

    if (running.has(sessionId) || background === 'running' || input.commandRunSessionId === sessionId) {
      statuses[sessionId] = { kind: 'running', source: 'live', ...updated };
      continue;
    }

    const waiting = waitingDetail(background, lastRun);
    if (waiting) {
      statuses[sessionId] = { kind: 'waiting', detail: waiting, source: durableSource, ...updated };
      continue;
    }

    if (failure || lastRun?.error) {
      const detail = failure?.detail ?? lastRun?.error;
      statuses[sessionId] = {
        kind: 'failed',
        ...(detail ? { detail } : {}),
        source: failure ? 'live' : durableSource,
        ...updated
      };
      continue;
    }

    if (lastRun?.status === 'interrupted' || lastRun?.status === 'running') {
      // A checkpoint still marked `running` outlived the process that wrote it, so
      // it is reported as interrupted instead of claiming a live run forever.
      statuses[sessionId] = { kind: 'stopped', source: durableSource, ...updated };
      continue;
    }

    if (lastRun?.status === 'completed') {
      statuses[sessionId] = { kind: 'completed', source: durableSource, ...updated };
      continue;
    }

    statuses[sessionId] = { kind: 'idle', source: durableSource };
  }
  return statuses;
}

/** Why this session is waiting for the user, or `undefined` when it is not. */
function waitingDetail(
  background: BackgroundRunStatus | undefined,
  lastRun: SessionLastRunObservation | undefined
): string | undefined {
  if (background === 'waiting_for_apply' || background === 'waiting_for_authorization') return background;
  if (lastRun?.pendingUser) return 'pending_user_action';
  if (lastRun?.blocker) return lastRun.blocker;
  if (lastRun?.status === 'blocked') return lastRun.stopReason ?? 'blocked';
  return undefined;
}