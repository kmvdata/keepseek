import type { DraftEdit, DraftRunProposal } from '../../shared/types';
import { createHash } from 'node:crypto';
import { isRecord } from '../../shared/errors';
import type { SubagentLane } from './types';

export type SubagentResultStatus = 'complete' | 'partial' | 'failed';

export interface SubagentEvidence {
  claim: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  /** A populated claim is a model report, not proof that the host verified it. */
  verification?: 'unverified';
}

export interface CommonSubagentResultEnvelope {
  contractVersion?: 2;
  /** Deterministic binding supplied in the current child task, never a random run id. */
  taskHash?: string;
  status: SubagentResultStatus;
  summary: string;
  evidence: SubagentEvidence[];
  uncertainties: string[];
  coverage?: string[];
  missing?: string[];
  nextSteps?: string[];
  verification?: Array<{ claim: string; method: string; result: string; source: 'model_reported' }>;
}

export interface SubagentReviewFinding {
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  title: string;
  evidence: string;
  impact: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface ReviewSubagentResultEnvelope extends CommonSubagentResultEnvelope {
  kind: 'review';
  verdict: 'pass' | 'warn' | 'block';
  reviewedPaths: string[];
  findings: SubagentReviewFinding[];
}

export interface ResearchSubagentResultEnvelope extends CommonSubagentResultEnvelope {
  kind: 'research';
}

export interface ProposalSubagentResultEnvelope extends CommonSubagentResultEnvelope {
  kind: 'proposal';
  artifacts: {
    draftEditCount: number;
    draftRunCount: number;
    paths: string[];
  };
}

export type SubagentResultEnvelope =
  | ResearchSubagentResultEnvelope
  | ReviewSubagentResultEnvelope
  | ProposalSubagentResultEnvelope;

export interface SubagentResultAcceptance {
  ok: boolean;
  envelope?: SubagentResultEnvelope;
  diagnostics: string[];
}

const GENERIC_FALLBACK = /^(?:done|completed|finished|ok|success|no (?:result|answer)|i (?:cannot|can't) (?:help|answer)|任务完成|已完成|完成|无法回答)[.!。！\s]*$/iu;

export function acceptSubagentResult(input: {
  raw: string;
  lane: SubagentLane;
  draftEdits?: readonly DraftEdit[];
  draftRuns?: readonly DraftRunProposal[];
  maxChars?: number;
  expectedTaskHash?: string;
  contractVersion?: 2;
}): SubagentResultAcceptance {
  if (typeof input.maxChars === 'number' && input.raw.length > input.maxChars) {
    return { ok: false, diagnostics: ['result_too_large'] };
  }
  const parsed = parseJsonObject(input.raw);
  if (!parsed) {
    // A damaged wrapper is repairable; an explicitly foreign binding is not.
    // Do not let format repair silently rewrite a task identity hidden in a
    // truncated JSON object. Escaped keys inside quoted prose are excluded.
    const claimed = input.raw.match(/(?<!\\)"taskHash"\s*:\s*"([^"\\]*)"/u)?.[1];
    if (input.expectedTaskHash && claimed !== undefined && claimed !== input.expectedTaskHash) {
      return { ok: false, diagnostics: ['task_binding_mismatch'] };
    }
    return { ok: false, diagnostics: ['result_not_json_object'] };
  }
  const diagnostics: string[] = [];
  const taskHash = readNonEmptyString(parsed.taskHash);
  const status = readEnum(parsed.status, ['complete', 'partial', 'failed'] as const);
  const summary = readNonEmptyString(parsed.summary);
  const evidence = normalizeEvidence(parsed.evidence);
  const uncertainties = normalizeStringArray(parsed.uncertainties);
  if (!status) diagnostics.push('status_invalid');
  if (!summary || GENERIC_FALLBACK.test(summary)) diagnostics.push('summary_missing_or_generic');
  if (!Array.isArray(parsed.evidence) || !evidence) diagnostics.push('evidence_invalid');
  if (!Array.isArray(parsed.uncertainties) || !uncertainties) diagnostics.push('uncertainties_invalid');
  if (input.expectedTaskHash && taskHash !== input.expectedTaskHash) diagnostics.push('task_binding_mismatch');
  if (status === 'complete' && (!evidence || evidence.length === 0)) diagnostics.push('complete_requires_evidence');
  if (diagnostics.length || !status || !summary || !evidence || !uncertainties) {
    return { ok: false, diagnostics };
  }
  const extra: Partial<CommonSubagentResultEnvelope> = {};
  {
    for (const key of ['coverage', 'missing', 'nextSteps'] as const) {
      if (parsed[key] === undefined) continue;
      const values = normalizeStringArray(parsed[key]);
      if (!values) return { ok: false, diagnostics: [`${key}_invalid`] };
      extra[key] = values;
    }
    if (parsed.verification !== undefined) {
      if (!Array.isArray(parsed.verification)) return { ok: false, diagnostics: ['verification_invalid'] };
      extra.verification = [];
      for (const item of parsed.verification) {
        if (!isRecord(item)) return { ok: false, diagnostics: ['verification_invalid'] };
        const claim = readNonEmptyString(item.claim);
        const method = readNonEmptyString(item.method);
        const result = readNonEmptyString(item.result);
        if (!claim || !method || !result) return { ok: false, diagnostics: ['verification_invalid'] };
        extra.verification.push({ claim, method, result, source: 'model_reported' });
      }
    }
    extra.contractVersion = 2;
  }
  const common = {
    ...(taskHash ? { taskHash } : {}), status, summary,
    evidence: evidence.map((item) => ({ ...item, verification: 'unverified' as const })),
    uncertainties, ...extra
  };
  if (input.lane === 'review-read') {
    const verdict = readEnum(parsed.verdict, ['pass', 'warn', 'block'] as const);
    const reviewedPaths = normalizeStringArray(parsed.reviewedPaths);
    const findings = normalizeFindings(parsed.findings);
    if (!verdict) diagnostics.push('review_verdict_invalid');
    if (!reviewedPaths?.length) diagnostics.push('reviewed_paths_missing');
    if (!findings) diagnostics.push('review_findings_invalid');
    if ((verdict === 'warn' || verdict === 'block') && !findings?.length
      && status === 'complete') diagnostics.push('review_findings_required');
    if (diagnostics.length || !verdict || !reviewedPaths || !findings) return { ok: false, diagnostics };
    return { ok: true, diagnostics, envelope: { kind: 'review', ...common, verdict, reviewedPaths, findings } };
  }
  if (input.lane === 'proposal') {
    const edits = input.draftEdits ?? [];
    const runs = input.draftRuns ?? [];
    if (status === 'complete' && edits.length + runs.length === 0) {
      return { ok: false, diagnostics: ['proposal_missing_host_artifacts'] };
    }
    return {
      ok: true,
      diagnostics,
      envelope: {
        kind: 'proposal',
        ...common,
        artifacts: {
          draftEditCount: edits.length,
          draftRunCount: runs.length,
          paths: [...new Set(edits.map((edit) => edit.label))].sort()
        }
      }
    };
  }
  return { ok: true, diagnostics, envelope: { kind: 'research', ...common } };
}

export function getSubagentResultFormatInstruction(lane: SubagentLane, _contractVersion: 2 = 2): string {
  const common = 'Return exactly one JSON object with taskHash (copy the exact deterministic value from the current task binding), status (complete|partial|failed), summary, evidence (array of {claim,path?,startLine?,endLine?}), and uncertainties (string array). Do not wrap it in Markdown.';
  const extended = ' Include compact coverage, missing, nextSteps string arrays when relevant, and verification entries {claim,method,result} only for checks actually performed. Mark incomplete work partial. Evidence and verification are model reports pending parent verification; do not claim host verification. A review verdict is not approval permission. Return essential conclusions first; the parent reads disputed details on demand.';
  if (lane === 'review-read') {
    return `${common} Also include verdict (pass|warn|block), reviewedPaths (string array), and findings (array of {severity,title,evidence,impact,path?,startLine?,endLine?}).${extended}`;
  }
  if (lane === 'proposal') {
    return `${common} Describe only pending proposals in summary/evidence. Artifact counts and paths are derived by the host; do not claim that edits were applied or commands ran.${extended}`;
  }
  return common + extended;
}

/** Binding, authorization, resource limits and missing facts are never formatting errors. */
export function canRepairSubagentResult(diagnostics: readonly string[]): boolean {
  const allowed = new Set(['result_not_json_object', 'status_invalid',
    'evidence_invalid', 'uncertainties_invalid', 'review_verdict_invalid', 'reviewed_paths_missing',
    'review_findings_invalid', 'coverage_invalid', 'missing_invalid', 'nextSteps_invalid', 'verification_invalid']);
  return diagnostics.length > 0 && diagnostics.every((item) => allowed.has(item));
}

/** A child's own independent branches still need its parent-model disposition. */
export function applySubagentParentAcceptance(envelope: SubagentResultEnvelope, delegation: {
  explicitUnfulfilled?: boolean; results: Array<{ acceptance?: string }>;
} | undefined, pending = false): SubagentResultEnvelope {
  // pending is computed by the validated delegation tracker, which also knows
  // when accepted follow-up evidence supersedes an earlier partial result.
  if (envelope.status !== 'complete' || (!pending && !delegation?.explicitUnfulfilled)) return envelope;
  return { ...envelope, status: 'partial',
    missing: [...new Set([...(envelope.missing ?? []), 'parent_acceptance_pending'])],
    uncertainties: [...envelope.uncertainties, 'One or more delegated branches have not been accepted by this child.'],
    nextSteps: [...(envelope.nextSteps ?? []), 'Inspect the disputed branch or finish parent acceptance before marking the task complete.'] };
}

/** The profile limit bounds accepted canonical delivery, separately from model output tokens. */
export function prepareSubagentResultDelivery(envelope: SubagentResultEnvelope, maxChars: number): {
  envelope: SubagentResultEnvelope; content: string; truncated: boolean; originalHash: string; originalChars: number;
} {
  const original = JSON.stringify(envelope);
  const originalHash = createHash('sha256').update(original, 'utf8').digest('hex');
  if (original.length <= maxChars) return { envelope, content: original, truncated: false, originalHash, originalChars: original.length };
  // Never slice serialized JSON. A resource-limited result is explicit partial
  // material. The unavailable original has no readable ref and cannot be reused.
  const partial: SubagentResultEnvelope = {
    ...envelope, status: 'partial',
    summary: 'Result exceeds the profile delivery limit; the complete result was not accepted.',
    evidence: [], uncertainties: ['Original result is unavailable through resultRef.'],
    missing: ['result_too_large'], coverage: [], nextSteps: ['Narrow the task or request a smaller result.'],
    verification: [],
    ...(envelope.kind === 'proposal' ? { artifacts: { ...envelope.artifacts, paths: [] } } : {}),
    ...(envelope.kind === 'review' ? { findings: [], reviewedPaths: envelope.reviewedPaths.slice(0, 1), verdict: 'warn' as const } : {})
  };
  let content = JSON.stringify(partial);
  if (content.length > maxChars) {
    // Remove optional model prose/artifacts before failing the hard bound.
    delete partial.coverage; delete partial.verification; delete partial.nextSteps;
    if (partial.kind === 'review') partial.reviewedPaths = [];
    if (partial.kind === 'proposal') partial.artifacts.paths = [];
    content = JSON.stringify(partial);
  }
  if (content.length > maxChars) throw new Error('subagent_profile_result_limit_too_small');
  return { envelope: partial, content, truncated: true, originalHash, originalChars: original.length };
}

export function getSubagentFormatRepairPrompt(lane: SubagentLane, diagnostics: readonly string[], taskHash: string): string {
  return [
    'Reformat the immediately preceding answer only. Preserve its claims; do not add new analysis, evidence, or conclusions.',
    getSubagentResultFormatInstruction(lane),
    `Required taskHash: ${taskHash}`,
    `Validation errors: ${diagnostics.join(', ')}`
  ].join('\n');
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
    : trimmed;
  try {
    const value: unknown = JSON.parse(candidate);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | undefined {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: string[] = [];
  for (const item of value) {
    const text = readNonEmptyString(item);
    if (!text) return undefined;
    output.push(text);
  }
  return output;
}

function normalizeEvidence(value: unknown): SubagentEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: SubagentEvidence[] = [];
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      output.push({ claim: item.trim() });
      continue;
    }
    if (!isRecord(item)) return undefined;
    const claim = readNonEmptyString(item.claim);
    if (!claim) return undefined;
    const location = normalizeLocation(item);
    if (!location) return undefined;
    output.push({ claim, ...location });
  }
  return output;
}

function normalizeFindings(value: unknown): SubagentReviewFinding[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: SubagentReviewFinding[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const severity = readEnum(item.severity, ['info', 'low', 'medium', 'high', 'critical'] as const);
    const title = readNonEmptyString(item.title);
    const evidence = readNonEmptyString(item.evidence);
    const impact = readNonEmptyString(item.impact);
    const location = normalizeLocation(item);
    if (!severity || !title || !evidence || !impact || !location) return undefined;
    output.push({ severity, title, evidence, impact, ...location });
  }
  return output;
}

function normalizeLocation(value: Record<string, unknown>): {
  path?: string;
  startLine?: number;
  endLine?: number;
} | undefined {
  const pathValue = value.path === undefined ? undefined : readNonEmptyString(value.path);
  const startLine = normalizeLine(value.startLine);
  const endLine = normalizeLine(value.endLine);
  if ((value.path !== undefined && !pathValue)
    || (value.startLine !== undefined && startLine === undefined)
    || (value.endLine !== undefined && endLine === undefined)
    || (startLine !== undefined && endLine !== undefined && endLine < startLine)) return undefined;
  return { ...(pathValue ? { path: pathValue } : {}), ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) };
}

function normalizeLine(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}
