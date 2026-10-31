import type { ChatMessage, ChatSession } from '../shared/types';

/** Display-only high-water marks. Never used by execution budgets. */
export interface SessionExecutionTime {
  version: 1;
  byTask: Record<string, number>;
  incomplete: boolean;
}
function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(Math.floor(value)) && value >= 0;
}
export function reconcileExecutionTime(value: unknown, messages: ChatMessage[]): SessionExecutionTime {
  const raw = value as Partial<SessionExecutionTime> | undefined;
  const valid = raw?.version === 1 && raw.byTask && typeof raw.byTask === 'object' && !Array.isArray(raw.byTask);
  const byTask: Record<string, number> = Object.create(null);
  let corrupt = false;
  if (valid) for (const [id, ms] of Object.entries(raw.byTask!)) {
    if (id && duration(ms)) byTask[id] = ms;
    else corrupt = true;
  }
  // Legacy records cannot prove that earlier runs were retained in full.
  let incomplete = corrupt || (valid ? raw.incomplete !== false : true);
  for (const message of messages) {
    const run = message.runCheckpoint ?? message.runCheckpointArchive?.summary ?? message.runState;
    if (!run) continue;
    if (!run.taskId || !duration(run.usedMs)) { incomplete = true; continue; }
    byTask[run.taskId] = Math.max(byTask[run.taskId] ?? 0, run.usedMs);
  }
  return { version: 1, byTask, incomplete };
}
export function executionTimeView(session: ChatSession): { totalMs?: number; incomplete: boolean } {
  const stats = reconcileExecutionTime(session.executionTime, session.messages);
  const values = Object.values(stats.byTask);
  const total = values.reduce((sum, ms) => sum + ms, 0);
  return { totalMs: (values.length || !stats.incomplete) && Number.isSafeInteger(Math.floor(total)) ? total : undefined,
    incomplete: stats.incomplete };
}
