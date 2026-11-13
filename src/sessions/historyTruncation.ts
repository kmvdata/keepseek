import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatSession } from '../shared/types';
import { executionSegmentId } from './userTask';
import { reconcileSessionTitleAfterTruncation } from './sessionTitle';

/** Host-only ownership evidence. Never serialize this into Provider input. */
export interface HistoryTruncationScope {
  id: string;
  sessionId: string;
  removedMessageIds: readonly string[];
  removedSegmentIds: readonly string[];
  retainedMessageIds: readonly string[];
}

/** One write-ahead intent, retired only after independent operation stores commit. */
export interface PendingHistoryTruncation extends HistoryTruncationScope {
  version: 1;
  targetMessageId: string;
  replacement: ChatMessage;
  resultRunIds?: string[];
  /** A first-message edit may replace task-derived stable context semantics. */
  replacementContextInstructions?: string;
  activeContextArchiveIds?: string[];
}

export interface HistoryTruncationHooks {
  persistSession(): Promise<void>;
  /** Must include a durable flush; silently queued writes are insufficient. */
  invalidateOperations(scope: HistoryTruncationScope): Promise<void>;
  /** Result delivery bindings are committed before the replacement becomes visible. */
  commitOperations?(plan: PendingHistoryTruncation): Promise<void>;
  /** Pure, idempotent host-derived state updates; no external side effects. */
  commitContext?(session: ChatSession, scope: HistoryTruncationScope): void;
}

/** A known retained source always wins over a shared execution segment. */
export function isHistoryOriginRemoved(
  scope: HistoryTruncationScope,
  origin: { messageId?: string; runId?: string; agentRunId?: string }
): boolean {
  if (origin.messageId && scope.retainedMessageIds.includes(origin.messageId)) return false;
  if (origin.messageId && scope.removedMessageIds.includes(origin.messageId)) return true;
  const segment = origin.agentRunId ?? origin.runId;
  return Boolean(segment && scope.removedSegmentIds.includes(segment));
}

export function createHistoryTruncationPlan(
  session: ChatSession,
  targetMessageId: string,
  replacement: ChatMessage,
  id: string = randomUUID()
): PendingHistoryTruncation | undefined {
  if (session.pendingHistoryTruncation) throw new Error('History truncation recovery is pending.');
  const index = session.messages.findIndex(message => message.id === targetMessageId && message.role === 'user');
  if (index < 0 || replacement.role !== 'user' || !replacement.content.trim()) return undefined;
  if (session.messages.some(message => message.id === replacement.id)) throw new Error('Replacement message identity must be new.');
  const retained = session.messages.slice(0, index);
  const removed = session.messages.slice(index);
  const retainedSegments = new Set(retained.map(executionSegmentId).filter((value): value is string => !!value));
  return {
    version: 1,
    id,
    sessionId: session.id,
    targetMessageId,
    retainedMessageIds: retained.map(message => message.id),
    removedMessageIds: removed.map(message => message.id),
    removedSegmentIds: [...new Set(removed.map(executionSegmentId).filter((value): value is string =>
      !!value && !retainedSegments.has(value)))],
    replacement: structuredClone(replacement)
  };
}

const transactions = new WeakSet<ChatSession>();

/** The caller holds the host run/action lock through this transaction. */
export async function executeHistoryTruncation(
  session: ChatSession,
  plan: PendingHistoryTruncation,
  hooks: HistoryTruncationHooks
): Promise<void> {
  if (transactions.has(session)) throw new Error('History truncation is already running.');
  if (session.pendingHistoryTruncation && session.pendingHistoryTruncation.id !== plan.id) {
    throw new Error('A different history truncation requires recovery.');
  }
  assertJournalHistory(session, plan);
  transactions.add(session);
  try {
    // Retry this write on recovery as an earlier rejected write may never have
    // reached disk. No independent Store mutation precedes its acknowledgement.
    session.pendingHistoryTruncation = plan;
    // Invalidate before the journal's first asynchronous barrier. A late title
    // response cannot commit against history being removed.
    const naming = reconcileSessionTitleAfterTruncation(session.autoTitle, session.customTitle,
      session.messages.filter(message => plan.retainedMessageIds.includes(message.id)), plan.removedMessageIds);
    session.autoTitle = naming.metadata;
    if (naming.resetTitle && !session.customTitle) {
      const firstUser = session.messages.find(message => message.role === 'user' && plan.retainedMessageIds.includes(message.id))
        ?? plan.replacement;
      session.title = fallbackTitle(firstUser.content);
    }
    await hooks.persistSession();
    await hooks.invalidateOperations(plan);
    await hooks.commitOperations?.(plan);
    hooks.commitContext?.(session, plan);
    const index = plan.retainedMessageIds.length;
    session.messages.splice(index, session.messages.length - index, plan.replacement);
    session.contextUsage = undefined;
    delete session.pendingHistoryTruncation;
    try {
      await hooks.persistSession();
    } catch (error) {
      // All affected operations are already durable tombstones. The journal
      // keeps this process fail-closed and makes a repeated commit idempotent.
      session.pendingHistoryTruncation = plan;
      throw error;
    }
  } finally {
    transactions.delete(session);
  }
}

function fallbackTitle(content: string): string {
  const text = content.replace(/\s+/gu, ' ').trim();
  // Keep the existing temporary-title contract without splitting code points.
  const points = Array.from(text);
  return points.length > 48 ? `${points.slice(0, 48).join('')}...` : text;
}

export async function recoverPendingHistoryTruncation(
  session: ChatSession,
  hooks: HistoryTruncationHooks
): Promise<boolean> {
  const plan = session.pendingHistoryTruncation;
  if (!plan) return false;
  await executeHistoryTruncation(session, plan, hooks);
  return true;
}

function assertJournalHistory(session: ChatSession, plan: PendingHistoryTruncation): void {
  if (session.id !== plan.sessionId || plan.targetMessageId !== plan.removedMessageIds[0]
    || plan.replacement.role !== 'user' || !plan.replacement.content.trim()) {
    throw new Error('Invalid history truncation journal scope.');
  }
  const ids = session.messages.map(message => message.id);
  const original = [...plan.retainedMessageIds, ...plan.removedMessageIds];
  const committed = [...plan.retainedMessageIds, plan.replacement.id];
  if (!sameIds(ids, original) && !sameIds(ids, committed)) {
    throw new Error('History changed while truncation was pending; recovery is required.');
  }
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Invalid/cross-session intents are rejected by the caller, never half-loaded. */
export function normalizePendingHistoryTruncation(
  value: unknown,
  sessionId: string,
  normalizeMessage: (value: unknown) => ChatMessage | undefined
): PendingHistoryTruncation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history truncation journal.');
  const raw = value as Record<string, unknown>;
  const ids = (v: unknown): string[] | undefined => Array.isArray(v)
    && v.every(id => typeof id === 'string' && !!id)
    && new Set(v).size === v.length ? [...v] as string[] : undefined;
  const retainedMessageIds = ids(raw.retainedMessageIds);
  const removedMessageIds = ids(raw.removedMessageIds);
  const removedSegmentIds = ids(raw.removedSegmentIds);
  const resultRunIds = raw.resultRunIds === undefined ? undefined : ids(raw.resultRunIds);
  const activeContextArchiveIds = raw.activeContextArchiveIds === undefined ? undefined : ids(raw.activeContextArchiveIds);
  const replacement = normalizeMessage(raw.replacement);
  if (raw.version !== 1 || typeof raw.id !== 'string' || !raw.id || raw.sessionId !== sessionId
    || typeof raw.targetMessageId !== 'string' || !retainedMessageIds || !removedMessageIds?.length || !removedSegmentIds
    || removedMessageIds[0] !== raw.targetMessageId || !replacement || replacement.role !== 'user'
    || !replacement.content.trim() || retainedMessageIds.some(id => removedMessageIds.includes(id))
    || [...retainedMessageIds, ...removedMessageIds].includes(replacement.id)
    || raw.resultRunIds !== undefined && !resultRunIds
    || raw.activeContextArchiveIds !== undefined && !activeContextArchiveIds
    || raw.replacementContextInstructions !== undefined && typeof raw.replacementContextInstructions !== 'string') {
    throw new Error('Invalid history truncation journal scope.');
  }
  return { version: 1, id: raw.id, sessionId, targetMessageId: raw.targetMessageId,
    retainedMessageIds, removedMessageIds, removedSegmentIds, replacement,
    ...(resultRunIds ? { resultRunIds } : {}),
    ...(typeof raw.replacementContextInstructions === 'string' ? { replacementContextInstructions: raw.replacementContextInstructions } : {}),
    ...(activeContextArchiveIds ? { activeContextArchiveIds } : {}) };
}
