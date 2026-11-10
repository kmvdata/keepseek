import type { ChatMessage, ChatSession } from '../shared/types';
import { ExecutionClock } from '../agent/executionPolicy';
import { executionSegmentId, type UserTaskLink } from './userTask';

interface TaskTime {
  originMessageId: string;
  usedMs: number;
  segments: string[];
  /** Host scopes already cover Runner work; never add Runner time again. */
  measured: boolean;
}
/** Display accounting only, never an execution-budget or approval authority. */
export interface SessionExecutionTime {
  version: 2;
  byTask: Record<string, number>;
  tasks?: Record<string, TaskTime>;
  currentTaskId?: string;
  incomplete: boolean;
}
function duration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(Math.floor(value)) && value >= 0;
}
export function reconcileExecutionTime(value: unknown, messages: readonly ChatMessage[]): SessionExecutionTime {
  const raw = value as Partial<SessionExecutionTime> | undefined;
  const valid = raw?.version === 2 && raw.byTask && typeof raw.byTask === 'object' && !Array.isArray(raw.byTask);
  const byTask: Record<string, number> = Object.create(null);
  const tasks: Record<string, TaskTime> = Object.create(null);
  let corrupt = false;
  if (valid) for (const [id, ms] of Object.entries(raw.byTask!)) {
    if (id && duration(ms)) byTask[id] = ms;
    else corrupt = true;
  }
  if (raw?.version === 2 && raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks)) {
    for (const [id, t] of Object.entries(raw.tasks)) {
      if (id && t && typeof t.originMessageId === 'string' && duration(t.usedMs) && Array.isArray(t.segments)
        && t.segments.every(s => typeof s === 'string' && !!s)) {
        tasks[id] = { originMessageId: t.originMessageId, usedMs: t.usedMs, segments: [...new Set(t.segments)], measured: t.measured === true };
      } else corrupt = true;
    }
  } else if (raw?.version === 2 && raw.tasks !== undefined) corrupt = true;
  let incomplete = corrupt || (valid ? raw.incomplete !== false : true);
  // Timing uses explicit current host task links and never rewrites history.
  let currentTaskId = typeof raw?.currentTaskId === 'string' ? raw.currentTaskId : undefined;
  for (const message of messages) {
    const run = message.runCheckpoint ?? message.runCheckpointArchive?.summary ?? message.runState;
    if (!run) continue;
    if (!run.taskId || !duration(run.usedMs)) { incomplete = true; continue; }
    byTask[run.taskId] = Math.max(byTask[run.taskId] ?? 0, run.usedMs);
    const link = message.userTask;
    if (link) {
      const task = tasks[link.id] ??= { originMessageId: link.originMessageId, usedMs: 0, segments: [], measured: false };
      if (!task.segments.includes(run.taskId)) task.segments.push(run.taskId);
      if (!currentTaskId) currentTaskId = link.id;
      if (!task.measured) incomplete = true;
    }
  }
  for (const task of Object.values(tasks)) {
    if (!task.measured) task.usedMs = Math.max(task.usedMs, task.segments.reduce((sum, id) => sum + (byTask[id] ?? 0), 0));
  }
  return { version: 2, byTask, tasks, currentTaskId, incomplete };
}
export function executionTimeView(session: ChatSession): { totalMs?: number; currentMs?: number; incomplete: boolean } {
  // Hot display path uses host state, independent of paged message history.
  const stats = session.executionTime?.version === 2 ? session.executionTime : reconcileExecutionTime(session.executionTime, session.messages);
  const tasks = Object.values(stats.tasks ?? {});
  const covered = new Set(tasks.flatMap(task => task.segments));
  const values = [...tasks.map(task => task.usedMs), ...Object.entries(stats.byTask).filter(([id]) => !covered.has(id)).map(([, ms]) => ms)];
  const total = values.reduce((sum, ms) => sum + ms, 0);
  const currentMs = stats.currentTaskId ? stats.tasks?.[stats.currentTaskId]?.usedMs : undefined;
  return { totalMs: (values.length || !stats.incomplete) && duration(total) ? total : undefined,
    ...(currentMs !== undefined ? { currentMs } : {}), incomplete: stats.incomplete };
}

/** Active scopes form a union. Persist samples, never live timestamps: reload
 * resumes known work without charging offline time. No per-second disk writes. */
export class UserTaskClock {
  private readonly active = new Map<string, { session: ChatSession; taskId: string; scopes: number; clock: ExecutionClock }>();
  public constructor(private readonly now: () => number = () => performance.now()) {}
  public enter(session: ChatSession, link: UserTaskLink): { setActive(active: boolean): void; finish(): void } {
    if (session.executionTime?.version !== 2) session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
    const stats = session.executionTime!;
    stats.tasks ??= Object.create(null) as Record<string, TaskTime>;
    const task = stats.tasks[link.id] ??= { originMessageId: link.originMessageId, usedMs: 0, segments: [], measured: true };
    task.measured = true;
    stats.currentTaskId = link.id;
    const key = `${session.id}:${link.id}`;
    let entry = this.active.get(key);
    if (!entry) {
      entry = { session, taskId: link.id, scopes: 0, clock: new ExecutionClock(0, task.usedMs, this.now) };
      this.active.set(key, entry);
    }
    entry.scopes++;
    let release: (() => void) | undefined = entry.clock.enter();
    let finished = false;
    return {
      setActive: active => {
        if (finished) return;
        if (active && !release) release = entry!.clock.enter();
        if (!active && release) { release(); release = undefined; }
        this.sample();
      },
      finish: () => { if (finished) return; release?.(); release = undefined; finished = true; this.sample();
        if (--entry!.scopes === 0) { entry!.clock.dispose(); this.active.delete(key); }
      }
    };
  }
  public bindSegment(session: ChatSession, message: ChatMessage): void {
    const id = executionSegmentId(message), link = message.userTask;
    const task = link && session.executionTime?.tasks?.[link.id];
    if (id && task && !task.segments.includes(id)) task.segments.push(id);
    this.sample();
  }
  public owns(sessionId: string, taskId: string): boolean {
    return this.active.has(`${sessionId}:${taskId}`);
  }
  public get hasScopes(): boolean { return this.active.size > 0; }
  public sample(): void {
    for (const entry of this.active.values()) {
      const task = entry.session.executionTime?.tasks?.[entry.taskId];
      if (task) task.usedMs = Math.max(task.usedMs, entry.clock.usedMs);
    }
  }
  public dispose(): void { this.sample(); for (const entry of this.active.values()) entry.clock.dispose(); this.active.clear(); }
}
