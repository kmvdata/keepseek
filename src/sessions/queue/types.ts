/**
 * Project session queue: pure types shared by the queue logic, its storage
 * adapter and the host projection.
 *
 * Nothing in this module imports `vscode`. The queue is the single authority
 * for *fairness order* only. It no longer derives an execution mode: every
 * session is equally writable in principle, and permission to touch the
 * workspace comes from the project write lease (`writeLease.ts`).
 *
 * Keeping order here and permission there is deliberate: the queue can be
 * reordered by the user at any time without ever granting a write, and the
 * lease can move between sessions without touching the ordering file.
 */

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
 * INVARIANT: `entries` has no duplicate `sessionId` and no duplicate `serial`.
 * `entries[0]` is the head used by the project-level approve-all drain to pick
 * the next session to serve.
 */
export interface ProjectSessionQueue {
  version: 1;
  workspaceKey: string;
  entries: QueueEntry[];
  /** Increased on every accepted mutation; the basis for cross-window CAS. */
  revision: number;
  updatedAt: string;
}

export const PROJECT_SESSION_QUEUE_VERSION = 1 as const;