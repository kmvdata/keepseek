import type { ProjectTaskCard } from './projectTasks';

export const TASK_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const VISIBLE_UNFINISHED = new Set(['queued', 'preparing', 'running', 'waiting', 'settling', 'stopping']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Always provide the complete durable Registry order, then filter the result.
 * Neither transient state nor a filtered list offset is an ordering key. */
export function orderProjectTaskCards(cards: readonly ProjectTaskCard[]): ProjectTaskCard[] {
  return cards.map((card, registryIndex) => ({ card, registryIndex,
    time: sidebarTimestamp(card.firstSubmittedAt) ?? sidebarTimestamp(card.createdAt) ?? 0
  })).sort((a, b) => a.time - b.time || a.registryIndex - b.registryIndex || a.card.taskCardId.localeCompare(b.card.taskCardId)).map(item => item.card);
}

/** Display-only. Expiration never deletes, archives, stops or selects a task. */
export function isProjectTaskRecent(card: ProjectTaskCard, now: number, viewedTaskId?: string | null): boolean {
  if (VISIBLE_UNFINISHED.has(card.state)) return true;
  if (card.archived) return false;
  if (card.state === 'interrupted') return true;
  if (!TERMINAL.has(card.state)) return false;
  const activity = sidebarTimestamp(card.lastActivityAt);
  if (activity !== undefined && Number.isFinite(now) && now - activity < TASK_RECENT_WINDOW_MS) return true;
  return viewedTaskId === card.taskCardId;
}

function sidebarTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value || value.length > 128) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : undefined;
}
