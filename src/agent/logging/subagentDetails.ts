/** A bounded display projection. It deliberately excludes tasks, result bodies,
 * evidence text and private child transcripts. Parent decisions are model
 * judgments and never approval permits. */
export interface RunDetailsDelegationSummary {
  version: 1;
  candidateCount: number;
  explicitSelection?: 'research' | 'review' | 'proposal' | 'parallel';
  explicitUnfulfilled?: boolean;
  assessment?: {
    trigger: 'initial' | 'scope_expanded';
    decision: 'local' | 'delegate';
    reason: string;
  };
  results: RunDetailsChildResult[];
  events: Array<{ kind: string; candidateId?: string; subagentId?: string; reason?: string }>;
}

export interface RunDetailsChildResult {
  subagentId: string;
  profile?: string;
  lifecycleStatus?: string;
  resultStatus: 'complete' | 'partial' | 'failed' | 'unknown';
  formatAccepted?: boolean;
  parentAcceptance: 'pending' | 'accepted' | 'needs_details' | 'needs_followup' | 'rejected';
  resultRef?: string;
  supersededBy?: string;
  detailsAvailable?: boolean;
  errorType?: string;
  reason?: string;
}

const MAX_RESULTS = 16;
const MAX_EVENTS = 16;

export function normalizeRunDetailsDelegation(value: unknown): RunDetailsDelegationSummary | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  const assessment = isRecord(value.assessment) ? value.assessment : undefined;
  const results = Array.isArray(value.results)
    ? value.results.slice(-MAX_RESULTS).map(normalizeChildResult).filter((item): item is RunDetailsChildResult => Boolean(item)) : [];
  for (const result of results) {
    if (result.supersededBy && (result.supersededBy === result.subagentId || result.parentAcceptance === 'accepted'
      || !results.some((next) => next.subagentId === result.supersededBy && next.parentAcceptance === 'accepted'
        && next.resultStatus === 'complete' && next.formatAccepted === true && !next.supersededBy))) {
      delete result.supersededBy;
    }
  }
  return {
    version: 1,
    candidateCount: typeof value.candidateCount === 'number' && Number.isFinite(value.candidateCount)
      ? Math.min(8, Math.max(0, Math.floor(value.candidateCount))) : 0,
    ...(isExplicitSelection(value.explicitSelection) ? { explicitSelection: value.explicitSelection } : {}),
    ...(value.explicitUnfulfilled === true ? { explicitUnfulfilled: true } : {}),
    ...(assessment && (assessment.trigger === 'initial' || assessment.trigger === 'scope_expanded')
      && (assessment.decision === 'local' || assessment.decision === 'delegate') ? {
        assessment: { trigger: assessment.trigger, decision: assessment.decision, reason: text(assessment.reason, 240) ?? '' }
      } : {}),
    results,
    events: Array.isArray(value.events)
      ? value.events.filter(isRecord).slice(-MAX_EVENTS).map((event) => ({
        kind: text(event.kind, 64) ?? 'unknown',
        ...(id(event.candidateId) ? { candidateId: id(event.candidateId) } : {}),
        ...(id(event.subagentId) ? { subagentId: id(event.subagentId) } : {}),
        ...(text(event.reason, 240) ? { reason: text(event.reason, 240) } : {})
      })) : []
  };
}

export function projectDelegationDetails(
  delegation: unknown,
  observed: readonly RunDetailsChildResult[]
): RunDetailsDelegationSummary | undefined {
  const state = isRecord(delegation) && delegation.version === 1 ? delegation : undefined;
  if (!state && !observed.length) return undefined;
  const results = new Map(observed.map((result) => [result.subagentId, { ...result }]));
  if (state && Array.isArray(state.results)) {
    for (const value of state.results.slice(-MAX_RESULTS)) {
      const incoming = normalizeChildResult(value);
      if (!incoming) continue;
      const existing = results.get(incoming.subagentId);
      // The parent acceptance record supersedes the handoff's pending marker.
      // Page failures remain visible even after a result was previously adopted.
      results.set(incoming.subagentId, {
        ...existing,
        ...incoming,
        supersededBy: incoming.supersededBy,
        ...(existing?.detailsAvailable === false ? { detailsAvailable: false } : {})
      });
    }
  }
  return normalizeRunDetailsDelegation({
    version: 1,
    candidateCount: state && Array.isArray(state.candidates) ? state.candidates.length : 0,
    explicitSelection: state?.explicitSelection,
    explicitUnfulfilled: state?.explicitUnfulfilled,
    assessment: state?.assessment,
    events: state?.events,
    results: [...results.values()]
  });
}

/** Reads only manifest metadata. Canonical result or preview content is never
 * retained in a Run Details summary. V2 results have unknown business status. */
export function observeChildResultMetadata(
  current: readonly RunDetailsChildResult[],
  raw: Record<string, unknown>
): RunDetailsChildResult[] {
  const results = new Map(current.map((result) => [result.subagentId, { ...result }]));
  const manifests = raw.kind === 'subagent_parallel_manifest' && Array.isArray(raw.results)
    ? raw.results.slice(0, 8).filter(isRecord)
    : raw.kind === 'subagent_result_manifest' ? [raw] : [];
  for (const manifest of manifests) {
    const incoming = normalizeChildResult({
      ...manifest,
      lifecycleStatus: manifest.status,
      detailsAvailable: typeof manifest.resultRef === 'string' && manifest.resultRef.length > 0
    });
    if (incoming) results.set(incoming.subagentId, { ...results.get(incoming.subagentId), ...incoming });
  }
  const ref = id(raw.ref ?? raw.subagentId);
  if (ref && results.has(ref)) {
    const existing = results.get(ref)!;
    if (raw.ok === false && (raw.errorType === 'subagent_result_corrupt' || raw.errorType === 'subagent_result_not_found'
      || raw.errorType === 'subagent_result_unavailable')) {
      results.set(ref, { ...existing, detailsAvailable: false, errorType: text(raw.errorType, 80) });
    } else if (raw.ok === true && typeof raw.content === 'string') {
      results.set(ref, { ...existing, detailsAvailable: true, errorType: undefined });
    }
  }
  return [...results.values()].slice(-MAX_RESULTS);
}

function normalizeChildResult(value: unknown): RunDetailsChildResult | undefined {
  if (!isRecord(value) || !id(value.subagentId)) return undefined;
  const acceptance = value.acceptance ?? value.parentAcceptance;
  const parentAcceptance = (acceptance === 'adopt' || acceptance === 'accepted')
    && value.resultStatus === 'complete' && value.formatAccepted === true ? 'accepted'
    : acceptance === 'needs_details' ? 'needs_details'
    : acceptance === 'investigate' || acceptance === 'needs_followup' ? 'needs_followup'
    : acceptance === 'reject' || acceptance === 'rejected' ? 'rejected' : 'pending';
  return {
    subagentId: id(value.subagentId)!,
    resultStatus: value.resultStatus === 'complete' || value.resultStatus === 'partial' || value.resultStatus === 'failed'
      ? value.resultStatus : 'unknown',
    parentAcceptance,
    ...(text(value.profile, 80) ? { profile: text(value.profile, 80) } : {}),
    ...(typeof value.lifecycleStatus === 'string'
      && ['queued', 'running', 'completed', 'failed', 'cancelled', 'stopped', 'budget_exhausted'].includes(value.lifecycleStatus)
      ? { lifecycleStatus: value.lifecycleStatus } : {}),
    ...(typeof value.formatAccepted === 'boolean' ? { formatAccepted: value.formatAccepted } : {}),
    ...(id(value.resultRef) ? { resultRef: id(value.resultRef) } : {}),
    ...(id(value.supersededBy) ? { supersededBy: id(value.supersededBy) } : {}),
    ...(typeof value.detailsAvailable === 'boolean' ? { detailsAvailable: value.detailsAvailable } : {}),
    ...(text(value.errorType, 80) ? { errorType: text(value.errorType, 80) } : {}),
    ...(text(value.reason, 240) ? { reason: text(value.reason, 240) } : {})
  };
}

function isExplicitSelection(value: unknown): value is NonNullable<RunDetailsDelegationSummary['explicitSelection']> {
  return value === 'research' || value === 'review' || value === 'proposal' || value === 'parallel';
}

function id(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/u.test(value) ? value : undefined;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, Math.max(1024, max * 4))
    .replace(/(api[_ -]?key|authorization|bearer|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|client[_ -]?secret)(\s*[:=]\s*)\S+/giu, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,})\b/gu, '[redacted]')
    .replace(/\s+/gu, ' ').trim().slice(0, max) || undefined : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
