import type { DraftRunSpec } from '../shared/types';
import { analyzeCommand } from '../approvals/authorization/commandSemantics';

/** Result facts for the host's finite local Git query grammar. This is data,
 * never an authorization or an instruction supplied by the command output. */
export interface GitQueryResult {
  version: 1;
  kind: 'ancestor' | 'tag_list' | 'revision_parse' | 'revision_count' | 'log';
  /** Host launch snapshot, used to reject stale predicate prerequisites. */
  scopeFingerprint?: string;
  predicate?: boolean;
  values?: string[];
  count?: number;
  errorCode?: 'invalid_revision' | 'invalid_range' | 'git_query_failed' | 'invalid_query_output';
}

export interface GitQueryExit {
  exitCode?: number;
  signal?: string;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

/** Exit status 1 is meaningful only for the exact ancestor predicate grammar.
 * Every other nonzero exit stays an error; callers cannot nominate exit codes. */
export function interpretGitQueryResult(
  spec: DraftRunSpec,
  outcome: GitQueryExit,
  stdout: string,
  stderr: string
): GitQueryResult | undefined {
  const query = analyzeCommand(spec).gitLocalQuery;
  if (!query || outcome.cancelled || outcome.timedOut || outcome.signal || outcome.error || outcome.exitCode === undefined) return undefined;
  const result: GitQueryResult = { version: 1, kind: query.kind };
  if (query.kind === 'ancestor' && (outcome.exitCode === 0 || outcome.exitCode === 1)) {
    return { ...result, predicate: outcome.exitCode === 0 };
  }
  if (outcome.exitCode !== 0) {
    const invalidRevision = /(?:bad revision|unknown revision|not a valid object|ambiguous argument|needed a single revision|invalid object name|bad object|invalid revision|no such ref)/iu.test(stderr);
    return { ...result, errorCode: invalidRevision
      ? query.revisions.some(revision => revision.includes('..')) ? 'invalid_range' : 'invalid_revision'
      : 'git_query_failed' };
  }
  if (query.kind === 'tag_list') {
    const values = stdout.split(/\r?\n/u).filter(Boolean);
    if (values.length > 4096 || values.some(value => value.length > 1024 || /\s/u.test(value) || hasControlCharacter(value))) {
      return { ...result, errorCode: 'invalid_query_output' };
    }
    return { ...result, predicate: values.length > 0, values };
  }
  if (query.kind === 'revision_parse') {
    const values = stdout.trim().split(/\r?\n/u);
    return values.length === query.revisions.length && values.every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))
      ? { ...result, values } : { ...result, errorCode: 'invalid_query_output' };
  }
  if (query.kind === 'revision_count') {
    const value = stdout.trim();
    const count = /^\d+$/u.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(count) && count >= 0 ? { ...result, count } : { ...result, errorCode: 'invalid_query_output' };
  }
  return result;
}

/** Used by the store as well as the real executor, without laundering exit 1. */
export function isSuccessfulDraftRunOutcome(outcome: GitQueryExit & { queryResult?: GitQueryResult }): boolean {
  return !outcome.cancelled && !outcome.timedOut && !outcome.signal && !outcome.error && !outcome.queryResult?.errorCode
    && (outcome.exitCode === 0 || outcome.exitCode === 1
      && outcome.queryResult?.kind === 'ancestor' && outcome.queryResult.predicate === false);
}

export function normalizeGitQueryResult(value: unknown): GitQueryResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Partial<GitQueryResult>;
  if (item.version !== 1 || !['ancestor', 'tag_list', 'revision_parse', 'revision_count', 'log'].includes(item.kind ?? '')) return undefined;
  if (item.errorCode !== undefined && !['invalid_revision', 'invalid_range', 'git_query_failed', 'invalid_query_output'].includes(item.errorCode)) return undefined;
  if (item.predicate !== undefined && typeof item.predicate !== 'boolean') return undefined;
  if (item.scopeFingerprint !== undefined && (typeof item.scopeFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item.scopeFingerprint))) return undefined;
  if (item.count !== undefined && (!Number.isSafeInteger(item.count) || item.count < 0)) return undefined;
  if (item.values !== undefined && (!Array.isArray(item.values) || item.values.length > 4096
    || item.values.some(v => typeof v !== 'string' || v.length > 1024 || hasControlCharacter(v)))) return undefined;
  if (item.errorCode && (item.predicate !== undefined || item.count !== undefined || item.values !== undefined)) return undefined;
  if (item.predicate !== undefined && item.kind !== 'ancestor' && item.kind !== 'tag_list') return undefined;
  if (item.count !== undefined && item.kind !== 'revision_count') return undefined;
  if (item.values !== undefined && item.kind !== 'tag_list' && item.kind !== 'revision_parse') return undefined;
  if (item.kind === 'revision_parse' && item.values?.some(value => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value))) return undefined;
  if (item.kind === 'tag_list' && item.values && (item.values.some(value => !value || /\s/u.test(value))
    || item.predicate !== undefined && item.predicate !== (item.values.length > 0))) return undefined;
  return { version: 1, kind: item.kind!, ...(item.predicate === undefined ? {} : { predicate: item.predicate }),
    ...(item.scopeFingerprint === undefined ? {} : { scopeFingerprint: item.scopeFingerprint }),
    ...(item.count === undefined ? {} : { count: item.count }), ...(item.values === undefined ? {} : { values: [...item.values] }),
    ...(item.errorCode === undefined ? {} : { errorCode: item.errorCode }) };
}

function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
