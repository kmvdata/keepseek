import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DraftRun, DraftRunSpec } from '../shared/types';
import type { DraftRunReplanResult } from '../approvals/approvalProcessing';
import { analyzeCommandCapability } from '../approvals/authorization/commandCapability';
import { analyzeCommand, type CommandSemantics } from '../approvals/authorization/commandSemantics';

// A storage sanity bound, not a retry quota. Never truncate the root-cause
// ledger: forgetting an earlier key could grant another correction attempt.
export const MAX_COMMAND_RECOVERY_KEYS = 4_096;
const SHA256 = /^[a-f0-9]{64}$/u;
const RESPONSE_ID = /^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/u;

export function isCommandRecoveryKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_COMMAND_RECOVERY_KEYS
    && value.every(key => typeof key === 'string' && SHA256.test(key));
}

export interface CommandRecoveryObservation {
  rootTaskId: string;
  key: string;
  draftRunId: string;
  specHash: string;
  /** Absent for a diagnostic first observed by the host outside a model response. */
  observedResponseId?: string;
  /** First accepted response to a request carrying this specific diagnosis. */
  deliveredResponseId?: string;
  /** Another draft whose diagnosis was present in the request for observedResponseId. */
  repeatedOf?: string;
}

export interface CommandRecoveryResponse {
  id: string;
  deliveredDraftRunIds: string[];
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && /^[\w.-]+$/u.test(value);
}

function validResponseId(value: unknown): value is string {
  return typeof value === 'string' && RESPONSE_ID.test(value);
}

function validDraftRunIds(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_RECOVERY_KEYS) return false;
  const ids = new Set(value);
  return ids.size === value.length && [...ids].every(validIdentity);
}

function validObservationIdentity(item: CommandRecoveryObservation, rootTaskId: string): boolean {
  return !!item && validIdentity(item.rootTaskId) && item.rootTaskId === rootTaskId
    && validIdentity(item.draftRunId) && typeof item.specHash === 'string' && SHA256.test(item.specHash)
    && typeof item.key === 'string' && SHA256.test(item.key)
    && (item.observedResponseId === undefined || validResponseId(item.observedResponseId));
}

export function normalizeCommandRecoveryResponse(value: unknown): CommandRecoveryResponse | undefined {
  const response = value as CommandRecoveryResponse | undefined;
  if (!response || !validResponseId(response.id) || !validDraftRunIds(response.deliveredDraftRunIds)) return undefined;
  return { id: response.id, deliveredDraftRunIds: response.deliveredDraftRunIds.slice() };
}

export function normalizeCommandRecoveryContinuation(value: unknown): { targetIds: string[] } | undefined {
  const targetIds = (value as { targetIds?: unknown } | undefined)?.targetIds;
  return validDraftRunIds(targetIds) && targetIds.length ? { targetIds: targetIds.slice() } : undefined;
}

export function normalizeCommandRecoveryObservations(value: unknown, rootTaskId: string): CommandRecoveryObservation[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_COMMAND_RECOVERY_KEYS) return undefined;
  const observations = new Map<string, CommandRecoveryObservation>();
  for (const item of value as CommandRecoveryObservation[]) {
    if (!validObservationIdentity(item, rootTaskId) || observations.has(item.draftRunId)
      || item.deliveredResponseId !== undefined && (!validResponseId(item.deliveredResponseId)
        || item.deliveredResponseId === item.observedResponseId)
      || item.repeatedOf !== undefined && (!validIdentity(item.repeatedOf) || !item.observedResponseId)) return undefined;
    if (item.repeatedOf) {
      const prior = observations.get(item.repeatedOf);
      if (!prior?.deliveredResponseId || prior.key !== item.key || prior.observedResponseId === item.observedResponseId) return undefined;
    }
    observations.set(item.draftRunId, { rootTaskId, key: item.key, draftRunId: item.draftRunId, specHash: item.specHash,
      observedResponseId: item.observedResponseId, deliveredResponseId: item.deliveredResponseId, repeatedOf: item.repeatedOf });
  }
  return [...observations.values()];
}

/** Merge concurrent snapshots without dropping already committed observations. */
export function mergeCommandRecoveryObservations(rootTaskId: string,
  ...snapshots: Array<readonly CommandRecoveryObservation[] | undefined>): CommandRecoveryObservation[] | undefined {
  if (snapshots.every(items => items === undefined)) return undefined;
  const merged = new Map<string, CommandRecoveryObservation>();
  for (const snapshot of snapshots) for (const observation of snapshot ?? []) {
    const prior = merged.get(observation.draftRunId);
    if (observation.rootTaskId !== rootTaskId || prior && (prior.key !== observation.key || prior.specHash !== observation.specHash
      || prior.observedResponseId !== observation.observedResponseId || prior.repeatedOf !== observation.repeatedOf)) {
      throw new Error('Conflicting command correction observation / 命令纠错记录身份冲突');
    }
    merged.set(observation.draftRunId, { ...observation,
      deliveredResponseId: prior?.deliveredResponseId ?? observation.deliveredResponseId });
  }
  const observations = normalizeCommandRecoveryObservations([...merged.values()], rootTaskId);
  if (!observations) throw new Error('Invalid or oversized command correction ledger / 命令纠错记录无效或超出存储上限');
  return observations;
}

export function findCommandRecoveryObservation(observations: readonly CommandRecoveryObservation[] | undefined,
  rootTaskId: string, draftRunId: string, specHash: string): CommandRecoveryObservation | undefined {
  return observations?.find(item => item.rootTaskId === rootTaskId && item.draftRunId === draftRunId && item.specHash === specHash);
}

/** Called after the response to the actual dispatched request has been accepted. */
export function recordCommandRecoveryDelivery(observations: CommandRecoveryObservation[] | undefined, rootTaskId: string,
  responseId: string, deliveredDraftRunIds: readonly string[]): void {
  if (!validResponseId(responseId) || !deliveredDraftRunIds.length) return;
  const delivered = new Set(deliveredDraftRunIds);
  for (const item of observations ?? []) {
    if (item.rootTaskId === rootTaskId && item.observedResponseId !== responseId && delivered.has(item.draftRunId)) {
      item.deliveredResponseId ??= responseId;
    }
  }
}

/** Observe an immutable proposal. Only diagnostics carried by this accepted
 * request can make a new proposal a repeat. Replaying the same proposal
 * returns its existing result, including when approval inspects it again. */
export function observeCommandRecovery(observations: CommandRecoveryObservation[],
  input: Omit<CommandRecoveryObservation, 'deliveredResponseId' | 'repeatedOf'>,
  deliveredDraftRunIds: readonly string[] = []): CommandRecoveryObservation {
  const existing = findCommandRecoveryObservation(observations, input.rootTaskId, input.draftRunId, input.specHash);
  if (existing) return existing;
  if (observations.length >= MAX_COMMAND_RECOVERY_KEYS) throw new Error('Command correction ledger resource limit / 命令纠错记录超过存储上限');
  if (!validObservationIdentity(input, input.rootTaskId)
    || observations.some(item => item.rootTaskId !== input.rootTaskId || item.draftRunId === input.draftRunId)) {
    throw new Error('Invalid command correction observation / 命令纠错记录身份无效');
  }
  const delivered = new Set(deliveredDraftRunIds);
  const prior = input.observedResponseId && observations.find(item => item.rootTaskId === input.rootTaskId
    && item.key === input.key && item.deliveredResponseId && item.observedResponseId !== input.observedResponseId
    && delivered.has(item.draftRunId));
  const observation = { rootTaskId: input.rootTaskId, key: input.key, draftRunId: input.draftRunId,
    specHash: input.specHash, observedResponseId: input.observedResponseId, repeatedOf: prior ? prior.draftRunId : undefined };
  observations.push(observation);
  return observation;
}

/** Static diagnostics are observations, not permission. Only a current never-dispatched
 * proposal is eligible; restored records without this evidence cannot restart work. */
export function commandCapabilityReplan(run: DraftRun, rootTaskId: string): DraftRunReplanResult | undefined {
  if (run.replacementDraftRunId || run.historyInvalidationId || run.historyOriginUnverified || run.startedAt || run.executionStarted === true
    || !['pending', 'needs_replan'].includes(run.status)
    || run.executionStarted !== false || run.executionPhase !== 'not_dispatched') return undefined;
  if (run.status === 'needs_replan' && run.replan?.rootTaskId === rootTaskId && run.replan.phase === 'capability'
    && run.replan.draftRunId === run.id && run.replan.specHash === run.specHash
    && run.replan.executionSegmentId === run.agentRunId) return run.replan;
  const historical = run.status === 'needs_replan' && run.capabilityDiagnostic?.blocking ? run.capabilityDiagnostic : undefined;
  const capability = analyzeCommandCapability(run.spec);
  const current = capability.diagnostics.find(item => item.blocking);
  const diagnostic = historical ?? current;
  if (!diagnostic) return undefined;
  const sameDiagnosis = current?.code === diagnostic.code && current?.argumentIndex === diagnostic.argumentIndex
    && current?.token === diagnostic.token;
  const tagSort = sameDiagnosis && capability.semantics.gitTagQueryNeedsSort;
  const gitReplan = sameDiagnosis ? capability.semantics.gitReplan : undefined;
  return { draftRunId: run.id, specHash: run.specHash, rootTaskId, executionSegmentId: run.agentRunId,
    phase: 'capability', code: tagSort ? 'git_tag_sort_missing' : gitReplan?.code ?? diagnostic.code,
    reason: tagSort
      ? 'Git tag --sort needs a value. Use a supported version sort. / Git tag --sort 缺少参数，请指定受支持的版本排序。'
      : gitReplan?.message ?? diagnostic.reason, executed: false,
    candidateArgs: diagnostic.candidateArgs, diagnostic };
}

/** Lexical scoping is for correction accounting only. Execution still checks
 * the actual repository, canonical path and authorization independently. */
function gitRecoveryScope(spec: DraftRunSpec, parsed: CommandSemantics): unknown {
  const scope = parsed.arguments.filter(arg => arg.role === 'cwd' || arg.role === 'repository');
  if (!scope.length) return undefined;
  let originalCwd: string;
  try { originalCwd = resolve(fileURLToPath(spec.cwdUri)); }
  catch { return scope.map(arg => [arg.role, arg.value]); }
  const cwd = scope.reduce((current, arg) => arg.role === 'cwd' && arg.value ? resolve(current, arg.value) : current, originalCwd);
  const repositories = new Map<string, string>();
  for (const arg of scope) {
    if (arg.role !== 'repository') continue;
    const previous = spec.args[arg.index - 1];
    const option = previous === '--git-dir' || previous === '--work-tree' ? previous : spec.args[arg.index].split('=', 1)[0];
    repositories.set(option, resolve(cwd, arg.value));
  }
  if (cwd === originalCwd && !repositories.size) return undefined;
  return [cwd, repositories.get('--git-dir'), repositories.get('--work-tree')];
}

/** Use only the relevant host grammar identity and scope. Freeform proposal
 * text, option values and unrelated operands cannot change a root cause. */
export function commandRecoveryKey(run: DraftRun | undefined,
  result: Pick<DraftRunReplanResult, 'rootTaskId' | 'phase' | 'code' | 'diagnostic'>): string {
  const parsed = run && analyzeCommand(run.spec);
  const index = result.diagnostic?.argumentIndex;
  const reason = parsed?.reasons.find(reason => `host_${reason.code}` === result.code && reason.argumentIndex === index);
  const saved = run?.capabilityDiagnostic;
  const recorded = saved?.blocking && saved.code === result.code && saved.argumentIndex === index;
  const token = (reason || recorded) && index !== undefined ? run?.spec.args[index] : undefined;
  const subcommand = parsed?.arguments.find(arg => arg.role === 'subcommand')?.value;
  const role = parsed?.arguments.find(arg => arg.index === index)?.role;
  const option = reason?.optionIdentity ?? (role === 'option' && token?.startsWith('-') ? token.split('=', 1)[0] : undefined);
  const variant = result.code === 'host_invalid_argv' ? [reason?.invalidArgvKind, reason?.optionIdentity]
    : ['host_unsupported_option', 'host_missing_option_value'].includes(result.code) ? option : undefined;
  const scope: unknown[] = [
    result.rootTaskId, run?.spec.cwdUri, run?.spec.executable, parsed?.program,
    subcommand,
    result.phase, result.code, run?.spec.env
  ];
  if (result.phase === 'capability') scope.push(variant, run && parsed && gitRecoveryScope(run.spec, parsed));
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex');
}
