/**
 * Project session queue: pure types shared by the queue logic, its storage
 * adapter and the host projection.
 *
 * Nothing in this module imports `vscode`. The queue is the single authority
 * for "which session comes first" and therefore for the derived normal/plan
 * mode of every session in one project.
 */

/** Derived view of a session's write capability. Never stored on the session. */
export type SessionExecutionMode = 'normal' | 'plan';

/**
 * One project session entry.
 *
 * `serial` is allocated once at creation and monotonically increases. It is
 * the stable tie-breaker when a queue has to be rebuilt from sessions on disk
 * and it never changes after assignment, so "creation order" remains
 * recoverable even after the user reorders entries.
 */
export interface QueueEntry {
  sessionId: string;
  serial: number;
  createdAt: string;
  /**
   * Set once the user has explicitly reordered entries. Purely diagnostic:
   * the array order is always the authority, this only records that the
   * order no longer matches creation order.
   */
  userOrdered?: boolean;
}

/**
 * Per-project ordering authority. Exactly one of these exists per
 * `workspaceKey`.
 *
 * INVARIANT: `entries` has no duplicate `sessionId` and no duplicate
 * `serial`. `entries[0]` is the only session that may derive `normal`.
 */
export interface ProjectSessionQueue {
  version: 1;
  workspaceKey: string;
  /** The only meaningful order. `entries[0]` is the normal session. */
  entries: QueueEntry[];
  /** Increased on every accepted mutation; the basis for cross-window CAS. */
  revision: number;
  updatedAt: string;
}

export const PROJECT_SESSION_QUEUE_VERSION = 1 as const;
