import type { ChatSession } from './types';

export const SESSION_HARD_RETENTION_DAYS = 60;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SessionRetentionOptions {
  currentWorkspaceKey: string;
  currentActiveSessionId: string;
  now?: number;
}

export interface SessionRetentionResult {
  sessions: ChatSession[];
  deletedCount: number;
}

export function pruneExpiredSessions(
  sessions: readonly ChatSession[],
  options: SessionRetentionOptions
): SessionRetentionResult {
  const cutoff = getHardRetentionCutoff(options.now);
  const retained = sessions.filter((session) => shouldRetainSession(session, cutoff, options));
  return {
    sessions: retained,
    deletedCount: sessions.length - retained.length
  };
}

export function shouldRetainSession(
  session: ChatSession,
  cutoff: number,
  options: SessionRetentionOptions
): boolean {
  if (session.workspaceKey === options.currentWorkspaceKey && session.id === options.currentActiveSessionId) {
    return true;
  }

  const updatedAt = Date.parse(session.updatedAt);
  return Number.isFinite(updatedAt) ? updatedAt >= cutoff : true;
}

export function getHardRetentionCutoff(now = Date.now()): number {
  return now - SESSION_HARD_RETENTION_DAYS * MS_PER_DAY;
}
