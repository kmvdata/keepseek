import type { ProjectSessionQueue, SessionExecutionMode } from './types';
import { effectiveMode, positionOf } from './projectQueue';
import type { LeaseSnapshot } from './writeLease';

/**
 * Host projection for the webview. This module only shapes data for display; it
 * never decides whether a write may happen (`modeGate` does that).
 */

export interface QueueEntryView {
  sessionId: string;
  title: string;
  /** One-based display position. */
  position: number;
  mode: SessionExecutionMode;
  isHead: boolean;
  holdingLease: boolean;
  /** Can be moved toward the head by the user. */
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** Session currently blocking a handoff to this entry, when any. */
  waitingFor?: string;
}

export interface QueueView {
  workspaceKey: string;
  revision: number;
  headSessionId?: string;
  leaseHolderSessionId?: string;
  pendingHandoffToSessionId?: string;
  entries: QueueEntryView[];
}

export interface QueueViewInput {
  queue: ProjectSessionQueue;
  lease?: LeaseSnapshot;
  /** Display titles by session id; missing ids fall back to the id. */
  titles?: ReadonlyMap<string, string> | Record<string, string>;
}

export function buildQueueView(input: QueueViewInput): QueueView {
  const { queue } = input;
  const holder = input.lease?.holderSessionId;
  const pending = input.lease?.pendingHandoffToSessionId;
  const entries: QueueEntryView[] = queue.entries.map((entry, index) => {
    const mode = effectiveMode(queue, entry.sessionId);
    return {
      sessionId: entry.sessionId,
      title: resolveTitle(input.titles, entry.sessionId),
      position: index + 1,
      mode,
      isHead: index === 0,
      holdingLease: entry.sessionId === holder,
      canMoveUp: index > 0,
      canMoveDown: index < queue.entries.length - 1,
      ...(holder && holder !== entry.sessionId && mode === 'normal' ? { waitingFor: holder } : {})
    };
  });
  return {
    workspaceKey: queue.workspaceKey,
    revision: queue.revision,
    ...(queue.entries[0] ? { headSessionId: queue.entries[0].sessionId } : {}),
    ...(holder ? { leaseHolderSessionId: holder } : {}),
    ...(pending ? { pendingHandoffToSessionId: pending } : {}),
    entries
  };
}

/** Position badge for a session outside the queue panel. */
export function queueBadge(
  queue: ProjectSessionQueue,
  sessionId: string,
  lease?: LeaseSnapshot
): { mode: SessionExecutionMode; position: number; holdingLease: boolean } {
  return {
    mode: effectiveMode(queue, sessionId),
    position: positionOf(queue, sessionId),
    holdingLease: lease?.holderSessionId === sessionId
  };
}

function resolveTitle(titles: QueueViewInput['titles'], sessionId: string): string {
  if (!titles) return sessionId;
  if (titles instanceof Map) return titles.get(sessionId) ?? sessionId;
  const value = (titles as Record<string, string>)[sessionId];
  return typeof value === 'string' && value ? value : sessionId;
}

/** Stable identity for change detection without diffing whole entries. */
export function queueViewSignature(view: QueueView): string {
  return view.entries.map((entry) => `${entry.sessionId}:${entry.position}:${entry.mode}:${entry.holdingLease ? 1 : 0}`).join('|');
}
