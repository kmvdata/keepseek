import type { ProjectSessionQueue, SessionExecutionMode } from './types';
import { effectiveMode, headSessionId, positionOf } from './projectQueue';

/**
 * Write capability kinds. Only a `normal` session that also holds the project
 * write lease may produce these; every other session is read-only.
 */
export type WriteCapability = 'edit' | 'command' | 'validation' | 'git_mutation';

export const WRITE_CAPABILITIES: readonly WriteCapability[] = ['edit', 'command', 'validation', 'git_mutation'];

export interface WriteLeaseFacts {
  /** Session currently holding the project write lease, if any. */
  holderSessionId?: string;
}

export interface WritePermissionInput {
  queue: ProjectSessionQueue;
  sessionId: string;
  lease: WriteLeaseFacts;
  capability: WriteCapability;
}

export type WriteBlockReason =
  | 'not_queued'
  | 'queued_not_head'
  | 'lease_held_by_other'
  | 'lease_free';

export type WritePermission =
  | { allowed: true; mode: 'normal'; capability: WriteCapability }
  | {
      allowed: false;
      mode: SessionExecutionMode;
      capability: WriteCapability;
      reason: WriteBlockReason;
      /** Waiting session that must hand off before this one can write. */
      waitingFor?: string;
      /** Zero-based queue position, -1 when not queued. */
      position: number;
    };

/**
 * The single authority for "may this session write right now".
 *
 * A session may write only when it is both the queue head (`normal`) and the
 * write-lease holder. Under explicit handoff (no preemption) the lease is not
 * stolen: when another session holds it the caller must wait for that owner to
 * reach a boundary and hand off.
 */
export function checkWritePermission(input: WritePermissionInput): WritePermission {
  const position = positionOf(input.queue, input.sessionId);
  const mode = effectiveMode(input.queue, input.sessionId);

  if (position < 0) {
    return { allowed: false, mode, capability: input.capability, reason: 'not_queued', position };
  }
  if (mode !== 'normal') {
    const head = headSessionId(input.queue);
    return {
      allowed: false,
      mode,
      capability: input.capability,
      reason: 'queued_not_head',
      ...(head ? { waitingFor: head } : {}),
      position
    };
  }
  const holder = input.lease.holderSessionId;
  if (holder === input.sessionId) {
    return { allowed: true, mode: 'normal', capability: input.capability };
  }
  if (holder) {
    return {
      allowed: false,
      mode,
      capability: input.capability,
      reason: 'lease_held_by_other',
      waitingFor: holder,
      position
    };
  }
  return { allowed: false, mode, capability: input.capability, reason: 'lease_free', position };
}

export function canWrite(input: WritePermissionInput): boolean {
  return checkWritePermission(input).allowed;
}

/** Human-readable, non-technical explanation for the UI. */
export function describeWriteBlock(permission: WritePermission, language: 'zh-CN' | 'en' = 'zh-CN'): string | undefined {
  if (permission.allowed) return undefined;
  const position = permission.position >= 0 ? permission.position + 1 : 0;
  const en = language === 'en';
  switch (permission.reason) {
    case 'not_queued':
      return en ? 'This session is not in the project queue.' : '该会话不在项目队列中。';
    case 'queued_not_head':
      return en
        ? `Queued at position ${position}. Only the first session can write.`
        : `排队中，第 ${position} 位；只有队首会话可以写入。`;
    case 'lease_held_by_other':
      return en
        ? 'Waiting for the current writer to hand off write access.'
        : '正在等待当前会话交棒写权限。';
    case 'lease_free':
      return en
        ? 'The write lease is not acquired yet.'
        : '尚未取得写租约。';
    default:
      return undefined;
  }
}

/** True when this session is a handoff candidate for `target`. */
export function isHandoffBlocker(queue: ProjectSessionQueue, holderSessionId: string | undefined, targetSessionId: string): boolean {
  if (!holderSessionId || holderSessionId === targetSessionId) return false;
  return positionOf(queue, holderSessionId) >= 0;
}