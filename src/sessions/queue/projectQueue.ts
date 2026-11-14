import type { ProjectSessionQueue, QueueEntry, SessionExecutionMode } from './types';

/**
 * Pure queue operations. Every function returns a new queue and never mutates
 * its input, so callers can compute a candidate order, persist it, and discard
 * it on a failed CAS.
 *
 * The array order is the only authority. "Creation order" is preserved by
 * `serial`, which is assigned once and never changes.
 */

function nowIso(now?: string | Date): string {
  if (now instanceof Date) return now.toISOString();
  return now ?? new Date().toISOString();
}

function nextSerial(entries: readonly QueueEntry[]): number {
  let max = 0;
  for (const entry of entries) if (entry.serial > max) max = entry.serial;
  return max + 1;
}

export function createEmptyQueue(workspaceKey: string, now?: string | Date): ProjectSessionQueue {
  return {
    version: 1,
    workspaceKey,
    entries: [],
    revision: 1,
    updatedAt: nowIso(now)
  };
}

/** Deep-ish copy so callers cannot mutate a queue they do not own. */
export function cloneQueue(queue: ProjectSessionQueue): ProjectSessionQueue {
  return {
    ...queue,
    entries: queue.entries.map((entry) => ({ ...entry }))
  };
}

export function findEntry(queue: ProjectSessionQueue, sessionId: string): QueueEntry | undefined {
  return queue.entries.find((entry) => entry.sessionId === sessionId);
}

export function indexOfSession(queue: ProjectSessionQueue, sessionId: string): number {
  return queue.entries.findIndex((entry) => entry.sessionId === sessionId);
}

/** Zero-based position, or -1 when the session is not queued. */
export function positionOf(queue: ProjectSessionQueue, sessionId: string): number {
  return indexOfSession(queue, sessionId);
}

/**
 * The only write-capable position. A session is normal exactly when it is
 * first in the queue.
 */
export function effectiveMode(
  queue: ProjectSessionQueue,
  sessionId: string
): SessionExecutionMode {
  const head = queue.entries[0];
  return head && head.sessionId === sessionId ? 'normal' : 'plan';
}

export function headSessionId(queue: ProjectSessionQueue): string | undefined {
  return queue.entries[0]?.sessionId;
}

/**
 * Append a new session at the end. A newly created session is therefore
 * `plan` whenever another session already exists, which is the requirement.
 *
 * Idempotent: enqueueing an already-queued session returns the input queue so
 * a retried create cannot duplicate an entry.
 */
export function enqueueNewSession(
  queue: ProjectSessionQueue,
  sessionId: string,
  now?: string | Date
): ProjectSessionQueue {
  if (!sessionId) return queue;
  if (findEntry(queue, sessionId)) return queue;
  const next: QueueEntry = {
    sessionId,
    serial: nextSerial(queue.entries),
    createdAt: nowIso(now)
  };
  return {
    ...queue,
    entries: [...queue.entries, next],
    revision: queue.revision + 1,
    updatedAt: nowIso(now)
  };
}

/** Remove a session; a removed head hands the head position to the next entry. */
export function removeEntry(queue: ProjectSessionQueue, sessionId: string, now?: string | Date): ProjectSessionQueue {
  const index = indexOfSession(queue, sessionId);
  if (index < 0) return queue;
  const entries = queue.entries.slice();
  entries.splice(index, 1);
  return {
    ...queue,
    entries,
    revision: queue.revision + 1,
    updatedAt: nowIso(now)
  };
}

function reorder(
  queue: ProjectSessionQueue,
  from: number,
  to: number,
  now?: string | Date
): ProjectSessionQueue {
  if (from < 0 || from >= queue.entries.length) return queue;
  const clamped = Math.max(0, Math.min(to, queue.entries.length - 1));
  if (clamped === from) return queue;
  const entries = queue.entries.slice();
  const [moved] = entries.splice(from, 1);
  entries.splice(clamped, 0, moved);
  return {
    ...queue,
    entries: entries.map((entry) => ({ ...entry, userOrdered: true })),
    revision: queue.revision + 1,
    updatedAt: nowIso(now)
  };
}

/** Move one entry to an absolute zero-based index. */
export function moveToIndex(
  queue: ProjectSessionQueue,
  sessionId: string,
  targetIndex: number,
  now?: string | Date
): ProjectSessionQueue {
  const from = indexOfSession(queue, sessionId);
  if (from < 0) return queue;
  return reorder(queue, from, targetIndex, now);
}

/** Promote a session to the head; this is what "execute plan" does. */
export function promoteToFront(queue: ProjectSessionQueue, sessionId: string, now?: string | Date): ProjectSessionQueue {
  return moveToIndex(queue, sessionId, 0, now);
}

export function moveUp(queue: ProjectSessionQueue, sessionId: string, now?: string | Date): ProjectSessionQueue {
  const from = indexOfSession(queue, sessionId);
  if (from <= 0) return queue;
  return reorder(queue, from, from - 1, now);
}

export function moveDown(queue: ProjectSessionQueue, sessionId: string, now?: string | Date): ProjectSessionQueue {
  const from = indexOfSession(queue, sessionId);
  if (from < 0 || from >= queue.entries.length - 1) return queue;
  return reorder(queue, from, from + 1, now);
}

/**
 * Reconcile the queue against the set of sessions that actually exist.
 *
 * - Unknown sessions are appended in creation (`createdAt`) then `serial`
 *   order so a rebuild never invents a different head than creation order.
 * - Sessions missing from the queue are added; queued sessions that no longer
 *   exist are dropped.
 * - Duplicate ids and duplicate serials are repaired.
 *
 * Returns the input queue unchanged when nothing had to be repaired, so
 * callers can cheaply detect a no-op.
 */
export function reconcile(
  queue: ProjectSessionQueue,
  sessions: readonly { id: string; createdAt: string }[],
  now?: string | Date
): ProjectSessionQueue {
  const live = new Map<string, { id: string; createdAt: string }>();
  for (const session of sessions) {
    if (session?.id && !live.has(session.id)) live.set(session.id, session);
  }

  const seen = new Set<string>();
  const usedSerials = new Set<number>();
  const kept: QueueEntry[] = [];
  let changed = false;

  for (const entry of queue.entries) {
    if (!live.has(entry.sessionId) || seen.has(entry.sessionId)) {
      changed = true;
      continue;
    }
    seen.add(entry.sessionId);
    if (usedSerials.has(entry.serial)) {
      changed = true;
      const repaired = { ...entry, serial: nextFreeSerial(usedSerials) };
      usedSerials.add(repaired.serial);
      kept.push(repaired);
      continue;
    }
    usedSerials.add(entry.serial);
    kept.push({ ...entry });
  }

  const missing = [...live.values()].filter((session) => !seen.has(session.id));
  if (missing.length) {
    changed = true;
    missing.sort(compareCreatedThenId);
    for (const session of missing) {
      const serial = nextFreeSerial(usedSerials);
      usedSerials.add(serial);
      seen.add(session.id);
      kept.push({ sessionId: session.id, serial, createdAt: session.createdAt });
    }
  }

  if (!changed) return queue;
  return {
    ...queue,
    entries: kept,
    revision: queue.revision + 1,
    updatedAt: nowIso(now)
  };
}

function nextFreeSerial(used: ReadonlySet<number>): number {
  let candidate = 1;
  for (const serial of used) if (serial >= candidate) candidate = serial + 1;
  return candidate;
}

function compareCreatedThenId(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string }
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftValid = Number.isFinite(leftTime);
  const rightValid = Number.isFinite(rightTime);
  if (leftValid && rightValid && leftTime !== rightTime) return leftTime - rightTime;
  if (leftValid !== rightValid) return leftValid ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Queue order for display: head first, i.e. the array order itself. Provided as
 * a named function so callers do not re-sort and accidentally invent a second
 * ordering authority (the current UI sorts by `updatedAt`).
 */
export function orderedSessionIds(queue: ProjectSessionQueue): string[] {
  return queue.entries.map((entry) => entry.sessionId);
}