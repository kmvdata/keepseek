import { estimateTokenCount } from '../tokenEstimate';
import { MIN_EVIDENCE_ENVELOPE_TOKENS, type ToolEvidence, type ToolEvidenceContentType, type ToolEvidenceSource } from './types';

export interface PreparedEvidenceEnvelope {
  content: string;
  completeInline: boolean;
  inlineChars: number;
  inlineTokens: number;
  contentType: ToolEvidenceContentType;
  source?: ToolEvidenceSource;
}

const ARRAY_KEYS = ['results', 'items', 'files', 'entries', 'symbols', 'references', 'findings', 'diagnostics', 'evidence', 'idempotency'] as const;
const TEXT_KEYS = ['content', 'result', 'diff', 'patch', 'output', 'text', 'stdout', 'stderr'] as const;

/** Shapes only new evidence. The returned bytes are persisted once and never
 * regenerated during recovery. All partial forms are valid JSON envelopes. */
export function prepareEvidenceEnvelope(input: {
  record: ToolEvidence;
  rawContent: string;
  inlineTokenAllowance: number;
  inlineCharLimit: number;
}): PreparedEvidenceEnvelope {
  const contentType = input.record.contentType ?? inferType(input.record.toolName, input.rawContent);
  const source = inferSource(input.rawContent);
  const fullTokens = estimateTokenCount(input.rawContent);
  const allowedTokens = Math.max(0, Math.floor(input.inlineTokenAllowance));
  const allowedChars = Math.max(0, Math.floor(input.inlineCharLimit));
  if (input.rawContent.length <= allowedChars && fullTokens <= allowedTokens) {
    return { content: input.rawContent, completeInline: true, inlineChars: input.rawContent.length, inlineTokens: fullTokens, contentType, source };
  }

  const parsed = parseJson(input.rawContent);
  const authority = isRecord(parsed) ? pickAuthority(parsed) : {};
  const base = {
    ok: typeof authority.ok === 'boolean' ? authority.ok : true,
    ...authority,
    completeInline: false,
    evidenceRef: input.record.evidenceRef,
    contentHash: input.record.contentHash,
    contentType,
    totalChars: input.record.totalChars,
    totalBytes: input.record.totalBytes,
    totalTokensEstimate: input.record.totalTokensEstimate,
    source,
    read: {
      tool: 'keepseek_read_evidence',
      paging: 'Use cursor for UTF-8 byte pages, startLine/endLine for lines, itemOffset/itemLimit for arrays, or search within this immutable snapshot.',
      freshness: 'This evidence is the immutable result captured when the original tool ran. Re-read the source only when current state is required.'
    }
  };
  const minimumAuthority = pickMinimumAuthority(authority);
  const minimum = {
    ok: typeof authority.ok === 'boolean' ? authority.ok : true,
    ...minimumAuthority,
    completeInline: false,
    evidenceRef: input.record.evidenceRef,
    contentHash: input.record.contentHash,
    contentType,
    totalChars: input.record.totalChars,
    totalBytes: input.record.totalBytes,
    totalTokensEstimate: input.record.totalTokensEstimate,
    read: { tool: 'keepseek_read_evidence', modes: ['bytes', 'lines', 'items', 'search'] }
  };
  const payload = parsed ? shapeJsonPayload(parsed, Math.max(0, allowedChars - stableStringify(base).length - 256))
    : shapeTextPayload(input.rawContent, Math.max(0, allowedChars - stableStringify(base).length - 256), source?.startLine);
  let content = stableStringify({ ...base, ...payload });
  if (estimateTokenCount(content) > allowedTokens || content.length > allowedChars) {
    content = stableStringify(base);
  }
  if (estimateTokenCount(content) > Math.max(allowedTokens, MIN_EVIDENCE_ENVELOPE_TOKENS)
    || content.length > Math.max(allowedChars, 1_024)) {
    content = stableStringify(minimum);
  }
  return {
    content,
    completeInline: false,
    inlineChars: content.length,
    inlineTokens: estimateTokenCount(content),
    contentType,
    source
  };
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

function shapeJsonPayload(parsed: unknown, budget: number): Record<string, unknown> {
  if (Array.isArray(parsed)) return { itemKey: '$', inlineItems: takeWholeItems(parsed, budget), totalItems: parsed.length };
  if (!isRecord(parsed)) return { inlineValue: parsed };
  for (const key of ARRAY_KEYS) {
    if (Array.isArray(parsed[key])) {
      const authority = pickAuthority(parsed);
      return { ...authority, itemKey: key, inlineItems: takeWholeItems(parsed[key], budget), totalItems: parsed[key].length };
    }
  }
  for (const key of TEXT_KEYS) {
    if (typeof parsed[key] === 'string') {
      const authority = pickAuthority(parsed);
      return { ...authority, field: key, ...shapeTextPayload(parsed[key] as string, budget, readLine(parsed.startLine)) };
    }
  }
  return { summary: pickAuthority(parsed) };
}

function shapeTextPayload(text: string, budget: number, startLine = 1): Record<string, unknown> {
  if (budget <= 0) return {};
  const lines = text.split(/(?<=\n)/u);
  const selected: string[] = [];
  let chars = 0;
  for (const line of lines) {
    // The payload is serialized as JSON. Newlines, quotes, backslashes and
    // control characters expand when escaped, so raw string length is not a
    // safe admission measure. Count the exact encoded string contribution and
    // still admit only complete source lines.
    const encodedChars = stableStringify(line).length - 2;
    if (chars + encodedChars > budget) break;
    selected.push(line);
    chars += encodedChars;
    if (chars >= budget) break;
  }
  return selected.length
    ? {
        inlineStartLine: startLine,
        inlineEndLine: startLine + selected.length - 1,
        inlineContent: selected.join(''),
        nextStartLine: startLine + selected.length
      }
    : { inlineContent: '', nextStartLine: startLine, lineTooLongForInline: true };
}

function takeWholeItems(items: unknown[], budget: number): unknown[] {
  const selected: unknown[] = [];
  let chars = 2;
  for (const item of items) {
    const size = stableStringify(item).length + 1;
    if (selected.length && chars + size > budget) break;
    if (!selected.length && chars + size > budget) break;
    selected.push(item);
    chars += size;
  }
  return selected;
}

function pickAuthority(record: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of [
    'ok', 'id', 'status', 'hash', 'specHash', 'actionHash', 'draftEditId', 'draftRunId', 'changeSetId', 'targetId',
    'path', 'uri', 'script', 'startLine', 'endLine', 'count', 'total', 'exitCode', 'durationMs', 'timedOut', 'errorType', 'error'
  ]) {
    const value = record[key];
    if (typeof value === 'string') selected[key] = value.slice(0, 1_024);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) selected[key] = value;
  }
  if (typeof record.contentHash === 'string') selected.sourceContentHash = record.contentHash.slice(0, 256);
  for (const key of ['draftEdit', 'draftRun', 'changeSet', 'draftRunResult', 'approval', 'validation']) {
    if (isRecord(record[key])) selected[key] = pickNestedAuthority(record[key] as Record<string, unknown>);
  }
  return selected;
}

function pickNestedAuthority(record: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  for (const key of [
    'id', 'status', 'hash', 'specHash', 'actionHash', 'targetId', 'label', 'action', 'path', 'uri', 'script',
    'executable', 'cwd', 'timeoutMs', 'editCount', 'exitCode', 'durationMs', 'timedOut', 'errorType', 'error'
  ]) {
    const value = record[key];
    if (typeof value === 'string') selected[key] = value.slice(0, 512);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) selected[key] = value;
  }
  if (Array.isArray(record.args)) selected.argCount = record.args.length;
  if (Array.isArray(record.env)) selected.envCount = record.env.length;
  if (isRecord(record.replaceRange)) selected.replaceRange = canonicalize(record.replaceRange);
  return selected;
}

/** The last-resort envelope keeps authoritative state while placing a hard,
 * deterministic ceiling on variable strings. Error type and object IDs win
 * over prose; the evidence hash/ref are added by the caller and never dropped. */
function pickMinimumAuthority(authority: Record<string, unknown>): Record<string, unknown> {
  const selected: Record<string, unknown> = {};
  let remainingChars = 240;
  const add = (key: string, value: unknown): void => {
    if (typeof value === 'string' && remainingChars > 0) {
      const bounded = value.slice(0, Math.min(remainingChars, 96));
      if (bounded) {
        selected[key] = bounded;
        remainingChars -= bounded.length;
      }
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      selected[key] = value;
    }
  };
  for (const key of ['errorType', 'id', 'draftEditId', 'draftRunId', 'changeSetId', 'targetId', 'status', 'specHash', 'actionHash', 'hash', 'sourceContentHash', 'path', 'uri', 'script', 'exitCode', 'timedOut', 'error']) {
    add(key, authority[key]);
  }
  for (const key of ['draftEdit', 'draftRun', 'changeSet', 'draftRunResult', 'approval', 'validation']) {
    const nested = authority[key];
    if (!isRecord(nested)) continue;
    const value: Record<string, unknown> = {};
    for (const nestedKey of ['id', 'status', 'specHash', 'actionHash', 'targetId', 'label', 'action', 'path', 'uri', 'script', 'executable', 'cwd', 'exitCode', 'timedOut', 'errorType']) {
      const before = remainingChars;
      const holder: Record<string, unknown> = {};
      const raw = nested[nestedKey];
      if (typeof raw === 'string' && remainingChars > 0) {
        const bounded = raw.slice(0, Math.min(remainingChars, 80));
        if (bounded) { holder[nestedKey] = bounded; remainingChars -= bounded.length; }
      } else if (typeof raw === 'number' || typeof raw === 'boolean' || raw === null) {
        holder[nestedKey] = raw;
      }
      Object.assign(value, holder);
      if (before === remainingChars && remainingChars <= 0) break;
    }
    if (Object.keys(value).length) selected[key] = value;
  }
  return selected;
}

function inferSource(raw: string): ToolEvidenceSource | undefined {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return undefined;
  const path = typeof parsed.path === 'string' ? parsed.path.slice(0, 2_048) : undefined;
  const uri = typeof parsed.uri === 'string' ? parsed.uri.slice(0, 2_048) : undefined;
  const fingerprint = typeof parsed.fingerprint === 'string' ? parsed.fingerprint
    : typeof parsed.contentHash === 'string' ? parsed.contentHash : undefined;
  const startLine = readLine(parsed.startLine);
  const endLine = readLine(parsed.endLine);
  return path || uri || fingerprint || startLine || endLine
    ? { path, uri, fingerprint: fingerprint?.slice(0, 256), startLine, endLine }
    : undefined;
}

function inferType(toolName: string, raw: string): ToolEvidenceContentType {
  if (/diff|patch/iu.test(toolName)) return 'diff';
  if (/diagnostic/iu.test(toolName)) return 'diagnostics';
  const parsed = parseJson(raw);
  if (parsed !== undefined) return Array.isArray(parsed) || (isRecord(parsed) && ARRAY_KEYS.some((key) => Array.isArray(parsed[key]))) ? 'structured' : 'json';
  return 'text';
}
function parseJson(raw: string): unknown | undefined { try { return JSON.parse(raw); } catch { return undefined; } }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function readLine(value: unknown): number | undefined { return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined; }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) result[key] = canonicalize(value[key]);
  return result;
}
