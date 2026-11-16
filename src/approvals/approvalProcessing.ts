import { normalizeCommandCapabilityDiagnostic } from './authorization/commandCapability';

/** A never-dispatched command waits for another exact proposal in the same task. */
export interface ApprovalDependency {
  targetId: string;
  label: string;
  reason?: string;
}

export interface DraftRunReplanResult {
  draftRunId: string;
  specHash: string;
  rootTaskId: string;
  executionSegmentId: string;
  phase: 'capability' | 'preflight';
  diagnostic?: import('./authorization/commandCapability').CommandCapabilityDiagnostic;
  code: string;
  reason: string;
  executed: false;
  candidateArgs?: string[];
  dependsOn?: string;
}

export function normalizeApprovalDependency(value: unknown): ApprovalDependency | undefined {
  const v = value as ApprovalDependency | undefined;
  if (!v || typeof v.targetId !== 'string' || typeof v.label !== 'string') return undefined;
  return { targetId: v.targetId, label: v.label.slice(0, 300), reason: approvalReason(v.reason) };
}

export function normalizeDraftRunReplan(value: unknown, id: string, segmentId: string, specHash?: string): DraftRunReplanResult | undefined {
  const v = value as DraftRunReplanResult | undefined;
  if (!v || v.draftRunId !== id || v.executionSegmentId !== segmentId
    || typeof v.specHash !== 'string' || (specHash !== undefined && specHash !== v.specHash)
    || typeof v.rootTaskId !== 'string' || typeof v.code !== 'string' || typeof v.reason !== 'string'
    || !['capability', 'preflight'].includes(v.phase) || v.executed !== false) return undefined;
  return { draftRunId: id, executionSegmentId: segmentId, specHash: v.specHash, rootTaskId: v.rootTaskId,
    phase: v.phase, diagnostic: normalizeCommandCapabilityDiagnostic(v.diagnostic), executed: false, code: v.code.slice(0, 100), reason: v.reason.slice(0, 2000),
    candidateArgs: Array.isArray(v.candidateArgs) && v.candidateArgs.every(arg => typeof arg === 'string')
      ? v.candidateArgs.slice(0, 16).map(arg => arg.slice(0, 300)) : undefined,
    dependsOn: typeof v.dependsOn === 'string' ? v.dependsOn : undefined };
}

function approvalReason(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 2000) : undefined;
}