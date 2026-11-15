import type { WriteCapability } from './modeGate';

/**
 * Process-wide write gate.
 *
 * The project queue decides which session is `normal`, but a mode alone does not
 * stop a foreign session from applying an edit or launching a command. This module
 * is the single choke point every file/command side effect passes through.
 *
 * It is deliberately a registry rather than a function import graph: the edit and
 * run stores live below the provider and must not import it. The provider installs
 * one authority at activation; callers ask that authority.
 */

export type WriteGateResult =
  | { allowed: true }
  | {
      allowed: false;
      /** Stable reason for logs and UI. */
      code: 'no_authority' | 'not_queue_head' | 'lease_not_held';
      /** Human-readable explanation (already localized by the authority). */
      message: string;
    };

export interface WriteGateAuthority {
  /**
   * Decides whether `sessionId` may perform `capability` right now.
   *
   * Implementations must be synchronous so a side effect can never slip between
   * the check and the operation it guards.
   */
  authorize(sessionId: string, capability: WriteCapability): WriteGateResult;
}

let authority: WriteGateAuthority | undefined;

/** Installed by the host at activation; `undefined` restores the permissive state. */
export function installWriteGateAuthority(next: WriteGateAuthority | undefined): void {
  authority = next;
}

export function getWriteGateAuthority(): WriteGateAuthority | undefined {
  return authority;
}

/**
 * Ask the installed authority.
 *
 * With no authority installed the gate is permissive, which preserves behaviour
 * for tests and for hosts that never wire a queue (headless tooling).
 */
export function authorizeWrite(sessionId: string, capability: WriteCapability): WriteGateResult {
  if (!authority) return { allowed: true };
  if (!sessionId) {
    return { allowed: false, code: 'no_authority', message: 'No session is bound to this operation.' };
  }
  return authority.authorize(sessionId, capability);
}

/** Throwing form for stores whose callers already surface exceptions. */
export function assertWriteAuthorized(sessionId: string, capability: WriteCapability): void {
  const result = authorizeWrite(sessionId, capability);
  if (!result.allowed) throw new Error(result.message);
}