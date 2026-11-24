import type { ProjectSessionQueue } from './types';
import { positionOf } from './projectQueue';
import type { WriteLeaseRecord } from './writeLease';

/**
 * Host projection for the webview. This module only shapes data for display; it
 * never decides whether a write may happen (`modeGate` does that).
 *
 * The queue no longer implies a mode: every session is equally `normal`, and
 * write permission comes from the project write lease. The queue is therefore
 * purely the fairness order and the "who is holding / waiting" display.
 */

export interface QueueEntryView {
  sessionId: string;
  title: string;
  /** One-based display position. */
  position: number;
  isHead: boolean;
  /** True when this session currently holds the project write lease. */
  holdingLease: boolean;
}

export interface QueueView {
  workspaceKey: string;
  revision: number;
  headSessionId?: string;
  leaseHolderSessionId?: string;
  entries: QueueEntryView[];
}

export interface QueueViewInput {
  queue: ProjectSessionQueue;
  lease?: WriteLeaseRecord;
  /** Display titles by session id; missing ids fall back to the id. */
  titles?: ReadonlyMap<string, string> | Record<string, string>;
}

export function buildQueueView(input: QueueViewInput): QueueView {
  const { queue } = input;
  const holder = input.lease?.state === 'held' ? input.lease.holderSessionId : undefined;
  const entries: QueueEntryView[] = queue.entries.map((entry, index) => ({
    sessionId: entry.sessionId,
    title: resolveTitle(input.titles, entry.sessionId),
    position: index + 1,
    isHead: index === 0,
    holdingLease: entry.sessionId === holder
  }));
  return {
    workspaceKey: queue.workspaceKey,
    revision: queue.revision,
    ...(queue.entries[0] ? { headSessionId: queue.entries[0].sessionId } : {}),
    ...(holder ? { leaseHolderSessionId: holder } : {}),
    entries
  };
}

/** Position badge for a session outside the queue panel. */
export function queueBadge(
  queue: ProjectSessionQueue,
  sessionId: string,
  lease?: WriteLeaseRecord
): { position: number; holdingLease: boolean } {
  return {
    position: positionOf(queue, sessionId),
    holdingLease: lease?.state === 'held' && lease.holderSessionId === sessionId
  };
}

function resolveTitle(titles: QueueViewInput['titles'], sessionId: string): string {
  if (!titles) return sessionId;
  if (titles instanceof Map) return titles.get(sessionId) ?? sessionId;
  const value = (titles as Record<string, string>)[sessionId];
  return typeof value === 'string' && value ? value : sessionId;
}