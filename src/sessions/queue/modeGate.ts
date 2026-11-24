import type { WriteLeaseRecord } from './writeLease';

/**
 * Write capability kinds. Every one of these is a workspace side effect, so
 * every one requires the project write lease.
 */
export type WriteCapability = 'edit' | 'command' | 'validation' | 'git_mutation';

export interface WritePermissionInput {
  sessionId: string;
  capability: WriteCapability;
  /**
   * The mirrored lease snapshot. Passed in rather than read from a module
   * singleton so the decision stays pure and testable.
   */
  lease: WriteLeaseRecord;
}

export type WriteBlockReason =
  | 'no_session'
  /** Another session holds the project write lease. */
  | 'lease_held_by_other'
  /** The lease is free: nobody acquired it, so nothing may write yet. */
  | 'lease_free';

export type WritePermission =
  | { allowed: true; capability: WriteCapability }
  | {
      allowed: false;
      capability: WriteCapability;
      reason: WriteBlockReason;
      /** Session that must release before this one can write. */
      holderSessionId?: string;
      /** What the holder is doing, for the UI. */
      holderCapability?: WriteCapability;
    };

/**
 * The single authority for "may this session write right now".
 *
 * There is no mode anymore: every session is equally `normal`, and the only
 * question is whether it holds the project's write lease. Queue position is
 * fairness and display, never permission.
 *
 * `lease_free` is a refusal, not a grant: the caller must acquire the lease
 * asynchronously first, then re-check. Treating "free" as allowed would let a
 * write slip in between the check and the acquire.
 */
export function checkWritePermission(input: WritePermissionInput): WritePermission {
  if (!input.sessionId) {
    return { allowed: false, capability: input.capability, reason: 'no_session' };
  }
  if (input.lease.state !== 'held' || !input.lease.holderSessionId) {
    return { allowed: false, capability: input.capability, reason: 'lease_free' };
  }
  if (input.lease.holderSessionId === input.sessionId) {
    return { allowed: true, capability: input.capability };
  }
  return {
    allowed: false,
    capability: input.capability,
    reason: 'lease_held_by_other',
    holderSessionId: input.lease.holderSessionId,
    ...(input.lease.purpose ? { holderCapability: input.lease.purpose } : {})
  };
}

export function canWrite(input: WritePermissionInput): boolean {
  return checkWritePermission(input).allowed;
}

/** Human-readable, non-technical explanation for the UI. */
export function describeWriteBlock(
  permission: WritePermission,
  language: 'zh-CN' | 'en' = 'zh-CN'
): string | undefined {
  if (permission.allowed) return undefined;
  const en = language === 'en';
  switch (permission.reason) {
    case 'no_session':
      return en ? 'No session is bound to this operation.' : '没有会话绑定到该操作。';
    case 'lease_held_by_other':
      return en
        ? 'Waiting for another session to release the project write lock.'
        : '正在等待其他会话释放项目写锁。';
    case 'lease_free':
      return en ? 'The project write lock is not acquired yet.' : '尚未取得项目写锁。';
    default:
      return undefined;
  }
}