import type { DraftEdit, DraftRunProposal } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import type { SubagentLane } from './types';

export type SubagentResultStatus = 'complete' | 'partial' | 'failed';

export interface SubagentEvidence {
  claim: string;
  path?: string;
  startLine?: number;
  endLine?: number;
}

export interface CommonSubagentResultEnvelope {
  /** Deterministic binding supplied in the current child task, never a random run id. */
  taskHash?: string;
  status: SubagentResultStatus;
  summary: string;
  evidence: SubagentEvidence[];
  uncertainties: string[];
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
}): SubagentResultAcceptance {
  if (typeof input.maxChars === 'number' && input.raw.length > input.maxChars) {
    return { ok: false, diagnostics: ['result_too_large'] };
  }
  const parsed = parseJsonObject(input.raw);
  if (!parsed) return { ok: false, diagnostics: ['result_not_json_object'] };
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
  const common = { ...(taskHash ? { taskHash } : {}), status, summary, evidence, uncertainties };
  if (input.lane === 'review-read') {
    const verdict = readEnum(parsed.verdict, ['pass', 'warn', 'block'] as const);
    const reviewedPaths = normalizeStringArray(parsed.reviewedPaths);
    const findings = normalizeFindings(parsed.findings);
    if (!verdict) diagnostics.push('review_verdict_invalid');
    if (!reviewedPaths?.length) diagnostics.push('reviewed_paths_missing');
    if (!findings) diagnostics.push('review_findings_invalid');
    if ((verdict === 'warn' || verdict === 'block') && !findings?.length) diagnostics.push('review_findings_required');
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

export function getSubagentResultFormatInstruction(lane: SubagentLane): string {
  const common = 'Return exactly one JSON object with taskHash (copy the exact deterministic value from the current task binding), status (complete|partial|failed), summary, evidence (array of {claim,path?,startLine?,endLine?}), and uncertainties (string array). Do not wrap it in Markdown.';
  if (lane === 'review-read') {
    return `${common} Also include verdict (pass|warn|block), reviewedPaths (string array), and findings (array of {severity,title,evidence,impact,path?,startLine?,endLine?}).`;
  }
  if (lane === 'proposal') {
    return `${common} Describe only pending proposals in summary/evidence. Artifact counts and paths are derived by the host; do not claim that edits were applied or commands ran.`;
  }
  return common;
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
