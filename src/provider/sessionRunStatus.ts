import type { BackgroundRunStatus, ChatMessage, ChatSession } from '../shared/types';

/**
 * Display-only projection of one conversation's run status for the history list.
 *
 * Ordering and status are deliberately unrelated: the list is ordered by
 * creation time, and a badge only *describes* a row. Nothing here persists,
 * approves, writes or re-sorts; `running` and `failed` are live host
 * observations, so a reload degrades them to whatever the last durable
 * checkpoint still proves.
 *
 * "Waiting for the user" is decided by *live* pending work only. A checkpoint
 * that ended in `blocked` also records which drafts were pending at that moment,
 * and those ids are not proof that the user still owes an answer: an approve-all
 * round applies the ChangeSet by itself, so the durable set can outlive the work
 * it described. Trusting it kept a settled row blue forever.
 */
export type SessionRunStatusKind = 'running' | 'waiting' | 'failed' | 'stopped' | 'completed' | 'idle';

export interface SessionRunStatusView {
  kind: SessionRunStatusKind;
  /** Untrusted short reason (stop reason, blocker, error) for the tooltip. */
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
  /**
   * Sessions whose pending work still owes the user an action, read from the
   * live stores (pending ChangeSets, pending command approvals, a blocked repair
   * loop). This — not a durable checkpoint — is what "waiting" means.
   */
  awaitingUserSessionIds?: ReadonlySet<string>;
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

    const waiting = waitingDetail(background, lastRun, input.awaitingUserSessionIds?.has(sessionId) === true);
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

    if (lastRun?.status === 'completed' || lastRun?.status === 'blocked') {
      // `blocked` records a run that paused for the user (pending apply, budget
      // stop). Nothing is pending here any more, so the run is finished — this is
      // the auto-approved case that used to stay blue.
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
  lastRun: SessionLastRunObservation | undefined,
  awaitingUser: boolean
): string | undefined {
  if (background === 'waiting_for_apply' || background === 'waiting_for_authorization') return background;
  if (lastRun?.blocker) return lastRun.blocker;
  if (awaitingUser) return 'pending_user_action';
  return undefined;
}

/** Durable identity of one run: which message proves it and when it was last seen. */
export interface SessionRunEvidence {
  messageId: string;
  /** Newest timestamp the durable proof still carries; absent when it carries none. */
  proofAt?: string;
}

/** The session header's "the user already dismissed this run" marker. */
export type SessionRunStatusDismissal = NonNullable<ChatSession['runStatusDismissal']>;

/**
 * The single derivation of "which run is this session's newest durable proof".
 *
 * Reading the badge and writing the dismissal marker both go through here, so a
 * marker can never describe a different message than the one the projection reads.
 * The archived projection drops `updatedAt`, so an archived run carries no
 * `proofAt` and its identity rests on the message id alone.
 */
export function deriveSessionRunEvidence(message: ChatMessage): SessionRunEvidence {
  const proofAt = message.runCheckpoint?.updatedAt;
  return { messageId: message.id, ...(proofAt ? { proofAt } : {}) };
}

/**
 * True when the user already left exactly this run.
 *
 * Identity is the message id, so a new run — a new assistant message — always
 * re-surfaces the row. A known timestamp must still match, which is what makes a
 * refreshed checkpoint on the same message visible again. An archived run keeps no
 * timestamp, so a dismissal recorded against the checkpoint form still covers the
 * archived form of the same message; otherwise a completed and already archived
 * row could never leave the list. Two forms that both lack a timestamp match on
 * identity alone: that is the remaining looseness, and it is deliberate, because
 * such a run can only be re-dated by a new checkpoint on the same message.
 */
export function isSessionRunDismissed(
  dismissal: SessionRunStatusDismissal | undefined,
  evidence: SessionRunEvidence | undefined
): boolean {
  if (!dismissal || !evidence) return false;
  if (dismissal.messageId !== evidence.messageId) return false;
  if (!dismissal.proofAt) return !evidence.proofAt;
  return !evidence.proofAt || dismissal.proofAt === evidence.proofAt;
}