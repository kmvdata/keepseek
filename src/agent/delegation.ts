import type { DelegateTaskInput } from './subagents/types';

export interface DelegationCandidate {
  id: string;
  goal: string;
  scope: string[];
  inputs: string[];
  dependsOn: string[];
  capabilities: Array<'read' | 'review' | 'proposal'>;
  acceptance: string[];
}
export interface DelegationResultObservation {
  candidateId: string;
  subagentId: string;
  resultRef: string;
  resultHash: string;
  resultStatus: 'complete' | 'partial' | 'failed' | 'unknown';
  formatAccepted: boolean;
  acceptance?: 'adopt' | 'needs_details' | 'investigate' | 'reject';
  reason?: string;
  /** A later complete result for the same immutable candidate was adopted. */
  supersededBy?: string;
}
export interface DelegationStateV1 {
  version: 1;
  explicitSelection?: 'research' | 'review' | 'proposal' | 'parallel';
  explicitUnfulfilled?: boolean;
  explicitFulfilled?: boolean;
  completedWindows?: number;
  adoptedResultCount?: number;
  assessment?: {
    trigger: 'initial' | 'scope_expanded';
    decision: 'local' | 'delegate';
    reason: string;
    evidence: string[];
  };
  candidates: DelegationCandidate[];
  results: DelegationResultObservation[];
  events: Array<{ kind: string; candidateId?: string; subagentId?: string; reason?: string }>;
}

/** Metadata is intentionally small. Host validation proves only the declared contract. */
export class DelegationTracker {
  private readonly state: DelegationStateV1;
  private readonly observedPaths = new Set<string>();
  private pendingNotice?: string;
  public constructor(initial: unknown, explicit: { kind: 'single' | 'parallel'; profile: 'research' | 'review' | 'proposal' } | undefined, private readonly changed: (state: DelegationStateV1) => void) {
    this.state = normalizeDelegationState(initial) ?? { version: 1, candidates: [], results: [], events: [] };
    const command = explicit?.kind === 'parallel' ? 'parallel' : explicit?.profile;
    if (command && !this.state.explicitSelection) {
      this.state.explicitSelection = command as DelegationStateV1['explicitSelection'];
      this.event('explicit_selection', command);
    }
  }

  public assess(args: Record<string, unknown>): string {
    if (args.trigger !== 'initial' && args.trigger !== 'scope_expanded') throw new Error('Invalid delegation assessment trigger.');
    if (args.decision !== 'local' && args.decision !== 'delegate') throw new Error('Invalid delegation assessment decision.');
    const reason = requiredText(args.reason, 240);
    const evidence = textArray(args.evidence ?? [], 4, 240);
    if (args.trigger === 'scope_expanded' && !evidence.length) throw new Error('Scope expansion requires concrete observed locations.');
    const incoming = args.candidates === undefined ? [] : candidateArray(args.candidates);
    if (args.decision === 'delegate' && !incoming.length) throw new Error('A delegate assessment requires self-contained candidates.');
    // A new, independent scope may retire a fully accepted window. Durable tool
    // evidence retains its audit history; no logical-task budget is reset.
    const archiveWindow = args.trigger === 'scope_expanded' && incoming.length > 0 && this.state.results.length > 0
      && unresolvedDelegationCount(this.state) === 0
      && incoming.every((item) => !this.state.candidates.some((old) => old.id === item.id)
        && item.dependsOn.every((id) => incoming.some((next) => next.id === id)));
    const byId = new Map((archiveWindow ? [] : this.state.candidates).map((item) => [item.id, item]));
    for (const item of incoming) {
      const previous = byId.get(item.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw new Error('A candidate identity cannot be rebound to a different task.');
      byId.set(item.id, item);
    }
    if (byId.size > 8) throw new Error('Delegation candidate limit (8) reached. Continue sequentially within the current contract.');
    for (const item of byId.values()) {
      for (const dependency of item.dependsOn) if (!byId.has(dependency)) throw new Error(`Unknown dependency: ${dependency}`);
    }
    rejectCycles([...byId.values()]);
    if (archiveWindow) {
      this.state.completedWindows = Math.min(Number.MAX_SAFE_INTEGER, (this.state.completedWindows ?? 0) + 1);
      this.state.adoptedResultCount = Math.min(Number.MAX_SAFE_INTEGER, (this.state.adoptedResultCount ?? 0) + this.state.results.length);
      this.state.results = [];
      this.event('accepted_window_archived', 'A new independent scope replaced the fully adopted active window; audit evidence and shared budgets are preserved.');
    }
    this.state.candidates = [...byId.values()];
    if (args.decision === 'local') {
      // A concise, explicit local decision may retire unrequested candidates.
      // Already returned work still requires acceptance and cannot disappear.
      this.state.candidates = this.state.candidates.filter((item) => this.state.results.some((result) => result.candidateId === item.id)
        || this.state.candidates.some((dependent) => dependent.dependsOn.includes(item.id)
          && this.state.results.some((result) => result.candidateId === dependent.id)));
    }
    this.state.assessment = { trigger: args.trigger, decision: args.decision, reason, evidence };
    this.event('model_assessment', reason);
    return JSON.stringify({ ok: true, kind: 'delegation_assessment', judgment: 'model_declared', hostVerified: 'contract_shape_and_dependencies', candidateIds: incoming.map((item) => item.id) });
  }

  public prepare(inputs: DelegateTaskInput[]): DelegateTaskInput[] {
    try {
      const ids = inputs.map((input) => requiredText(input.candidateId, 80));
      if (this.state.results.length + inputs.length > 16) throw new Error('Parent acceptance result limit (16) reached.');
      if (new Set(ids).size !== ids.length) throw new Error('The same candidate cannot be requested twice in one batch.');
      return inputs.map((input, index) => {
        const candidate = this.state.candidates.find((item) => item.id === ids[index]);
        if (!candidate) throw new Error('Assess the self-contained candidate before requesting delegation.');
        for (const dependency of candidate.dependsOn) {
          if (ids.includes(dependency)) throw new Error('Dependent candidates must run sequentially, never in one parallel batch.');
          if (!candidateAccepted(this.state, dependency)) throw new Error(`Dependency has not been accepted by the parent: ${dependency}`);
        }
        if ((input.lane === 'proposal' || input.profile === 'proposal') && !candidate.capabilities.includes('proposal')) {
          throw new Error('Proposal capability was not declared in the assessed task.');
        }
        if (input.paths?.some((path) => !candidate.scope.includes(path))) throw new Error('Declared write paths must occur in the candidate scope.');
        this.event('requested', undefined, candidate.id);
        return { ...input, assessedCapabilities: [...candidate.capabilities], task: [
          `Goal: ${candidate.goal}`, `Scope: ${candidate.scope.join('; ')}`,
          `Explicit inputs: ${candidate.inputs.length ? candidate.inputs.join('; ') : 'none; use permitted reads'}`,
          `Dependencies already accepted: ${candidate.dependsOn.join('; ') || 'none'}`,
          `Required capabilities: ${candidate.capabilities.join('; ')}`,
          `Acceptance: ${candidate.acceptance.join('; ')}`, `Task details: ${input.task}`
        ].join('\n') };
      });
    } catch (error) {
      this.event('host_contract_rejected', error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public returned(inputs: DelegateTaskInput[], raw: string): void {
    let result: Record<string, unknown>;
    try { result = record(JSON.parse(raw)); } catch { this.event('delivery_unavailable', 'The host result was not a structured envelope.'); return; }
    const children = Array.isArray(result.results) ? result.results : [result];
    const selection = this.state.explicitSelection;
    const matchingSelection = selection === 'parallel'
      ? result.kind === 'subagent_parallel_manifest' && children.length >= 2
        && children.every((child) => typeof record(child).subagentId === 'string')
      : selection && children.some((child) => {
        const item = record(child);
        return typeof item.subagentId === 'string' && (item.profile === selection
          || item.lane === (selection === 'proposal' ? 'proposal' : selection === 'review' ? 'review-read' : 'research-read'));
      });
    if (matchingSelection) {
      this.state.explicitFulfilled = true;
      this.event('explicit_selection_fulfilled', 'A host-returned child result matched the explicit selection.');
    }
    children.slice(0, inputs.length).forEach((child, index) => {
      const item = record(child);
      const candidateId = inputs[index]?.candidateId;
      if (!candidateId) return;
      if (typeof item.subagentId !== 'string') { this.event('host_rejected', typeof item.errorType === 'string' ? item.errorType : 'No child accepted.', candidateId); return; }
      const status = item.resultStatus === 'complete' || item.resultStatus === 'partial' || item.resultStatus === 'failed' ? item.resultStatus : 'unknown';
      const observed: DelegationResultObservation = {
        candidateId, subagentId: item.subagentId.slice(0, 128),
        resultRef: typeof item.resultRef === 'string' ? item.resultRef.slice(0, 512) : '',
        resultHash: typeof item.resultHash === 'string' ? item.resultHash.slice(0, 128) : '',
        resultStatus: status, formatAccepted: item.formatAccepted === true
      };
      const previous = this.state.results.findIndex((entry) => entry.subagentId === observed.subagentId);
      if (previous >= 0) {
        const existing = this.state.results[previous]!;
        if (existing.candidateId !== observed.candidateId || existing.resultHash !== observed.resultHash
          || existing.resultRef !== observed.resultRef || existing.resultStatus !== observed.resultStatus) {
          throw new Error('A returned child identity cannot be rebound to different result content.');
        }
        this.state.results[previous] = { ...existing, ...observed };
      }
      else if (this.state.results.length < 16) this.state.results.push(observed);
      else throw new Error('Parent acceptance record limit reached; no additional child result can be adopted in this plan.');
      this.event(item.reusedFromSubagentId ? 'reused_returned' : 'returned', undefined, candidateId, observed.subagentId);
    });
  }

  public accept(args: Record<string, unknown>, authority: { subagentId: string; resultHash: string; resultStatus: 'complete' | 'partial' | 'failed'; formatAccepted: boolean }): string {
    const id = requiredText(args.subagentId, 128);
    const result = this.state.results.find((item) => item.subagentId === id);
    if (!result || authority.subagentId !== id || !result.resultHash || result.resultHash !== authority.resultHash) throw new Error('Acceptance requires a result returned to this parent plan and matching authoritative content.');
    const decision = args.decision;
    if (decision !== 'adopt' && decision !== 'needs_details' && decision !== 'investigate' && decision !== 'reject') throw new Error('Invalid parent acceptance decision.');
    if (decision === 'adopt' && (!authority.formatAccepted || authority.resultStatus !== 'complete')) throw new Error('Partial, failed, or unaccepted results cannot complete a parent plan dependency.');
    const reason = requiredText(args.reason, 240);
    result.formatAccepted = authority.formatAccepted;
    result.resultStatus = authority.resultStatus;
    result.acceptance = decision;
    result.reason = reason;
    delete result.supersededBy;
    for (const previous of this.state.results) if (previous.supersededBy === result.subagentId) delete previous.supersededBy;
    if (decision === 'adopt') {
      for (const previous of this.state.results) {
        if (previous.candidateId === result.candidateId && previous.subagentId !== result.subagentId
          && previous.acceptance !== 'adopt') previous.supersededBy = result.subagentId;
      }
    }
    this.event('parent_model_acceptance', result.reason, result.candidateId, id);
    return JSON.stringify({ ok: true, subagentId: id, decision, judgment: 'parent_model', formatAccepted: result.formatAccepted, resultStatus: result.resultStatus, effectsApplied: false });
  }

  public observeScope(toolName: string, argsText: string): void {
    if (this.observedPaths.size >= 3) return;
    if (!/(?:search_workspace|read_workspace_file|find_references|get_document_symbols)/u.test(toolName)) return;
    try {
      const args = record(JSON.parse(argsText));
      if (typeof args.path === 'string') this.observedPaths.add(args.path.slice(0, 240));
      if (this.observedPaths.size === 3 && !this.state.events.some((item) => item.kind === 'scope_expanded')) {
        this.event('scope_expanded', 'Host observed read/search requests across at least three paths; this does not prove content was obtained. Reassess independent branches.');
        this.pendingNotice = 'Read/search requests now span at least three paths. Reassess independent branches with keepseek_delegation_checkpoint (trigger scope_expanded, concrete locations). Choose local when coordination adds no value. This notice does not establish successful reads or task independence.';
      }
    } catch { /* Invalid tool arguments are rejected by the normal tool route. */ }
  }

  /** Attach once before immutable evidence is committed; never rewrite replay. */
  public attachScopeNotice(raw: string): string {
    if (!this.pendingNotice) return raw;
    try {
      const value = record(JSON.parse(raw));
      const notice = this.pendingNotice;
      this.pendingNotice = undefined;
      return JSON.stringify({ ...value, delegationNotice: notice });
    } catch { return raw; }
  }

  /** Parent acceptance is mutable plan observation, separate from canonical bytes. */
  public decorateResultPage(raw: string): string {
    try {
      const page = record(JSON.parse(raw));
      if (page.ok !== true || typeof page.resultHash !== 'string') return raw;
      const observed = this.state.results.find((item) => item.resultHash === page.resultHash
        && (item.subagentId === page.subagentId || item.resultRef === page.ref));
      if (!observed) return raw;
      const parentAcceptance = observed.acceptance === 'adopt' ? 'accepted'
        : observed.acceptance === 'investigate' ? 'needs_followup'
          : observed.acceptance === 'reject' ? 'rejected' : observed.acceptance ?? 'pending';
      return JSON.stringify({ ...page, parentAcceptance });
    } catch { return raw; }
  }

  public finalize(): { pending: number; explicitUnfulfilled: boolean } {
    const pending = unresolvedDelegationCount(this.state);
    const explicitUnfulfilled = Boolean(this.state.explicitSelection && !this.state.explicitFulfilled);
    this.state.explicitUnfulfilled = explicitUnfulfilled;
    if (explicitUnfulfilled && !this.state.events.some((item) => item.kind === 'explicit_unfulfilled')) this.event('explicit_unfulfilled', 'No host-returned result matched the explicit selection; no budget or permission reason is inferred.');
    else this.changed(this.snapshot());
    return { pending, explicitUnfulfilled };
  }
  public snapshot(): DelegationStateV1 { return structuredClone(this.state); }
  private event(kind: string, reason?: string, candidateId?: string, subagentId?: string): void {
    this.state.events.push({ kind, reason: reason?.slice(0, 240), candidateId, subagentId });
    this.state.events = this.state.events.slice(-32);
    this.changed(this.snapshot());
  }
}

export function normalizeDelegationState(value: unknown): DelegationStateV1 | undefined {
  try {
    const item = record(value);
    if (item.version !== 1) return undefined;
    const candidates = candidateArray(item.candidates);
    rejectCycles(candidates);
    if (!Array.isArray(item.results) || item.results.length > 16) throw new Error('Invalid bounded result records.');
    const results: DelegationResultObservation[] = item.results.map((raw): DelegationResultObservation => {
      const result = record(raw);
      if (!candidates.some((candidate) => candidate.id === result.candidateId)) throw new Error('Unknown candidate result.');
      const status = result.resultStatus;
      if (status !== 'complete' && status !== 'partial' && status !== 'failed' && status !== 'unknown') throw new Error('Unknown completion status.');
      const acceptance = result.acceptance;
      if (acceptance !== undefined && acceptance !== 'adopt' && acceptance !== 'needs_details' && acceptance !== 'investigate' && acceptance !== 'reject') throw new Error('Unknown acceptance.');
      if (acceptance === 'adopt' && (status !== 'complete' || result.formatAccepted !== true)) throw new Error('Invalid adopted result.');
      return { candidateId: requiredText(result.candidateId, 80), subagentId: requiredText(result.subagentId, 128), resultRef: requiredText(result.resultRef, 512), resultHash: requiredText(result.resultHash, 128), resultStatus: status, formatAccepted: result.formatAccepted === true, acceptance, reason: typeof result.reason === 'string' ? result.reason.slice(0, 240) : undefined,
        supersededBy: result.supersededBy === undefined ? undefined : requiredText(result.supersededBy, 128) };
    });
    if (new Set(results.map((result) => result.subagentId)).size !== results.length) throw new Error('Duplicate child result identities.');
    for (const result of results) if (result.supersededBy && (result.acceptance === 'adopt'
      || !results.some((next) => next.subagentId === result.supersededBy
        && next.subagentId !== result.subagentId && next.candidateId === result.candidateId && next.acceptance === 'adopt'
        && !next.supersededBy && next.resultStatus === 'complete' && next.formatAccepted))) throw new Error('Invalid replacement result proof.');
    const selection = item.explicitSelection;
    const state: DelegationStateV1 = { version: 1, candidates, results, events: (Array.isArray(item.events) ? item.events : []).slice(-32).map((raw) => {
      const event = record(raw); return { kind: requiredText(event.kind, 80), reason: typeof event.reason === 'string' ? event.reason.slice(0, 240) : undefined, candidateId: typeof event.candidateId === 'string' ? event.candidateId.slice(0, 80) : undefined, subagentId: typeof event.subagentId === 'string' ? event.subagentId.slice(0, 128) : undefined };
    }) };
    if (selection === 'research' || selection === 'review' || selection === 'proposal' || selection === 'parallel') state.explicitSelection = selection;
    state.explicitUnfulfilled = item.explicitUnfulfilled === true;
    state.explicitFulfilled = item.explicitFulfilled === true;
    for (const key of ['completedWindows', 'adoptedResultCount'] as const) {
      if (item[key] !== undefined) {
        if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) throw new Error('Invalid delegation window counters.');
        state[key] = item[key] as number;
      }
    }
    if (item.assessment) {
      const assessment = record(item.assessment);
      if ((assessment.trigger === 'initial' || assessment.trigger === 'scope_expanded') && (assessment.decision === 'local' || assessment.decision === 'delegate')) state.assessment = { trigger: assessment.trigger, decision: assessment.decision, reason: requiredText(assessment.reason, 240), evidence: textArray(assessment.evidence, 4, 240) };
    }
    return state;
  } catch { return undefined; }
}
export function unresolvedDelegationCount(state: DelegationStateV1 | undefined): number {
  if (!state) return 0;
  return state.results.filter((item) => item.acceptance !== 'adopt' && !item.supersededBy).length
    + state.candidates.filter((candidate) => !state.results.some((item) => item.candidateId === candidate.id)).length;
}
function candidateAccepted(state: DelegationStateV1, candidateId: string): boolean {
  const results = state.results.filter((item) => item.candidateId === candidateId);
  return results.length > 0 && results.every((item) => item.acceptance === 'adopt' || Boolean(item.supersededBy));
}
function candidateArray(value: unknown): DelegationCandidate[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Candidates must be an array of at most 8 items.');
  const candidates = value.map((raw) => {
    const item = record(raw);
    const capabilities = textArray(item.capabilities, 3, 20);
    if (!capabilities.length || capabilities.some((name) => name !== 'read' && name !== 'review' && name !== 'proposal')) throw new Error('Unsupported candidate capability.');
    const scope = textArray(item.scope, 12, 240), acceptance = textArray(item.acceptance, 8, 240);
    if (!scope.length || !acceptance.length) throw new Error('A candidate needs explicit scope and acceptance criteria.');
    return { id: requiredText(item.id, 80), goal: requiredText(item.goal, 500), scope, inputs: textArray(item.inputs, 12, 500), dependsOn: textArray(item.dependsOn, 8, 80), capabilities: capabilities as DelegationCandidate['capabilities'], acceptance };
  });
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length) throw new Error('Duplicate candidate identities.');
  return candidates;
}
function rejectCycles(candidates: DelegationCandidate[]): void {
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Cyclic delegation dependencies are not allowed.');
    if (visited.has(id)) return;
    const candidate = candidates.find((item) => item.id === id);
    if (!candidate) throw new Error('Unknown delegation dependency.');
    visiting.add(id); candidate.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  };
  candidates.forEach((candidate) => visit(candidate.id));
}
function textArray(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Expected a bounded array (max ${maxItems}).`);
  return value.map((item) => requiredText(item, maxLength));
}
function requiredText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`Expected nonempty text (max ${maxLength}).`);
  return value.trim();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a structured object.');
  return value as Record<string, unknown>;
}
