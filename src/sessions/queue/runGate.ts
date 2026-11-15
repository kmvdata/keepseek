import type { ProjectSessionQueue, SessionExecutionMode } from './types';
import { effectiveMode, positionOf } from './projectQueue';

/**
 * Admission and progression rules for a task (decision D3).
 *
 * D3: **every** submission starts read-only in the plan phase; the head session
 * may progress into the writable phase within the same turn. Only an explicit
 * "execute plan" promotes a non-head session.
 *
 * This module owns the decision; the provider applies it. Keeping it pure makes
 * the rule testable without a webview or model.
 */

export type SubmitAdmission =
  /** Read-only planning turn; a non-head session always lands here. */
  | { mode: 'plan'; writable: false; reason: 'queued' | 'plan_head' }
  /** The queue head, already holding the write position for this turn. */
  | { mode: 'normal'; writable: true; reason: 'head' };

export interface SubmitAdmissionInput {
  queue: ProjectSessionQueue | undefined;
  sessionId: string;
  /** Mode currently resolved for the session (queue-derived when available). */
  resolvedMode: SessionExecutionMode;
  /** True when this turn is the host's plan-execution continuation. */
  executingPlan?: boolean;
}

/**
 * Decide how a new submission is admitted.
 *
 * Without a loaded queue the caller keeps its own mode: the queue is only the
 * authority once it can answer, which preserves projects that never queued.
 */
export function admitSubmission(input: SubmitAdmissionInput): SubmitAdmission {
  if (input.executingPlan) {
    return { mode: 'normal', writable: true, reason: 'head' };
  }
  if (!input.queue) {
    return input.resolvedMode === 'normal'
      ? { mode: 'normal', writable: true, reason: 'head' }
      : { mode: 'plan', writable: false, reason: 'plan_head' };
  }
  const position = positionOf(input.queue, input.sessionId);
  const isHead = effectiveMode(input.queue, input.sessionId) === 'normal';
  if (position >= 0 && isHead) {
    // The head may progress into writing within the same turn; it never has to
    // click through a plan card just because it already owns the position.
    return { mode: 'normal', writable: true, reason: 'head' };
  }
  return { mode: 'plan', writable: false, reason: position >= 0 ? 'queued' : 'plan_head' };
}

/** Whether a submission may write files or run commands during this turn. */
export function submissionMayWrite(admission: SubmitAdmission): boolean {
  return admission.writable;
}

export type PlanExecutionDecision =
  | { allowed: true; promoteSessionId: string }
  | { allowed: false; reason: 'not_queued' | 'already_head' | 'no_plan' };

export interface PlanExecutionInput {
  queue: ProjectSessionQueue | undefined;
  sessionId: string;
  /** The plan record the user is confirming; must exist and still be pending. */
  hasPendingPlan: boolean;
}

/**
 * "Execute plan" is the only path that promotes a non-head session.
 *
 * It is refused without a pending plan so an empty confirmation cannot be used
 * to take the write position.
 */
export function decidePlanExecution(input: PlanExecutionInput): PlanExecutionDecision {
  if (!input.hasPendingPlan) return { allowed: false, reason: 'no_plan' };
  if (!input.queue) return { allowed: true, promoteSessionId: input.sessionId };
  const position = positionOf(input.queue, input.sessionId);
  if (position < 0) return { allowed: false, reason: 'not_queued' };
  if (effectiveMode(input.queue, input.sessionId) === 'normal') {
    return { allowed: false, reason: 'already_head' };
  }
  return { allowed: true, promoteSessionId: input.sessionId };
}

/**
 * A planning turn must actually produce a plan before the next turn may write.
 *
 * This is the guard that keeps D3's "same-turn progression" from degenerating
 * into a silent write path: no plan artifact, no writable phase.
 */
export function planningTurnProducedPlan(input: {
  mode: SessionExecutionMode;
  hasPlanArtifact: boolean;
}): boolean {
  return input.mode !== 'plan' || input.hasPlanArtifact;
}