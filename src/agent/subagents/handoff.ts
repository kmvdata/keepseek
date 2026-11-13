import { createHash } from 'node:crypto';
import type { TurnUsageStats } from '../../shared/types';
import type { SubagentResultEnvelope } from './resultEnvelope';
import type {
  StoredSubagentMetadata,
  SubagentManifestStatus,
  SubagentResultManifest
} from './types';

export const DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES = 10_240;
export const DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES = 20_480;
export const SUBAGENT_HANDOFF_SUMMARY_MAX_CHARS = 1_024;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function createSubagentResultManifest(input: {
  metadata: Pick<StoredSubagentMetadata,
    'id' | 'treeId' | 'profile' | 'lane' | 'depth' | 'sourceId' | 'modelId'
    | 'resultHash' | 'resultChars' | 'resultBytes' | 'resultTruncated'
    | 'originalResultChars' | 'originalResultHash' | 'failureKind' | 'diagnostic'
    | 'reusedFromSubagentId' | 'resultStatus' | 'resultFormatAccepted'>;
  result: string;
  status: SubagentManifestStatus;
  ok: boolean;
  summary: string;
  usage?: TurnUsageStats;
  draftEditCount?: number;
  draftRunCount?: number;
  previewBytes?: number;
  maxBytes?: number;
  errorType?: string;
  error?: string;
  contractVersion?: 2;
  envelope?: SubagentResultEnvelope;
}): SubagentResultManifest {
  const resultBytes = utf8ByteLength(input.result);
  const preview = truncateUtf8(input.result, Math.max(0, input.previewBytes
    ?? DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES));
  const manifest: SubagentResultManifest = {
    version: 3,
    ok: input.ok,
    kind: 'subagent_result_manifest',
    subagentId: input.metadata.id,
    treeId: input.metadata.treeId,
    profile: input.metadata.profile,
    lane: input.metadata.lane,
    depth: input.metadata.depth,
    status: input.status,
    ...{
      resultStatus: input.metadata.resultStatus ?? 'failed',
      formatAccepted: input.metadata.resultFormatAccepted === true,
      parentAcceptance: 'pending' as const,
      missing: (input.envelope?.missing ?? []).slice(0, 4).map((value) => truncateChars(value, 160)),
      uncertainties: (input.envelope?.uncertainties ?? []).slice(0, 4).map((value) => truncateChars(value, 160)),
      keyEvidence: (input.envelope?.evidence ?? []).slice(0, 3).map((item) => ({
        claim: truncateChars(item.claim, 240),
        ...(item.path ? { path: truncateChars(item.path, 512) } : {}),
        ...(item.startLine ? { startLine: item.startLine } : {}),
        verification: 'unverified' as const
      }))
    },
    summary: truncateChars(normalizeInlineText(input.summary), SUBAGENT_HANDOFF_SUMMARY_MAX_CHARS),
    preview,
    resultRef: input.metadata.id,
    resultHash: input.metadata.resultHash ?? sha256(input.result),
    resultChars: input.metadata.resultChars ?? input.result.length,
    resultBytes: input.metadata.resultBytes ?? resultBytes,
    hasMore: resultBytes > utf8ByteLength(preview),
    ...(input.metadata.resultTruncated ? { resultTruncated: true } : {}),
    ...(typeof input.metadata.originalResultChars === 'number'
      ? { originalResultChars: input.metadata.originalResultChars } : {}),
    ...(input.metadata.originalResultHash ? { originalResultHash: input.metadata.originalResultHash } : {}),
    model: { sourceId: input.metadata.sourceId, modelId: input.metadata.modelId },
    usageSummary: compactUsage(input.usage),
    draftEditCount: Math.max(0, Math.floor(input.draftEditCount ?? 0)),
    draftRunCount: Math.max(0, Math.floor(input.draftRunCount ?? 0)),
    ...(input.errorType ? { errorType: truncateChars(input.errorType, 128) } : {}),
    ...(input.error ? { error: truncateChars(normalizeInlineText(input.error), 512) } : {}),
    ...(input.metadata.diagnostic?.id ? { diagnosticRef: input.metadata.diagnostic.id } : {}),
    ...(input.metadata.reusedFromSubagentId
      ? { reusedFromSubagentId: input.metadata.reusedFromSubagentId } : {})
  };
  return fitManifest(manifest, input.maxBytes ?? 12_288);
}

export function createParallelHandoff(input: {
  manifests: readonly SubagentResultManifest[];
  accepted: boolean;
  draftEditCount: number;
  draftRunCount: number;
  maxBytes?: number;
  errorType?: string;
  failedTasks?: readonly number[];
  conflicts?: readonly string[];
  error?: string;
}): string {
  const maxBytes = Math.max(16_384, Math.floor(input.maxBytes ?? DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES));
  const results = input.manifests.map((manifest, taskIndex) => ({
    taskIndex, ok: manifest.ok, status: manifest.status,
    resultStatus: manifest.resultStatus ?? 'failed', formatAccepted: manifest.formatAccepted === true,
    parentAcceptance: manifest.parentAcceptance ?? 'pending',
    subagentId: manifest.subagentId, treeId: manifest.treeId, profile: manifest.profile,
    lane: manifest.lane, depth: manifest.depth, resultRef: manifest.resultRef,
    resultHash: manifest.resultHash, resultChars: manifest.resultChars, resultBytes: manifest.resultBytes,
    hasMore: manifest.resultBytes > 0, resultTruncated: manifest.resultTruncated === true,
    draftEditCount: manifest.draftEditCount, draftRunCount: manifest.draftRunCount,
    ...(manifest.errorType ? { errorType: manifest.errorType } : {}),
    summary: '', preview: ''
  }));
  const payload = () => ({
    version: 3, ok: input.accepted, kind: 'subagent_parallel_manifest', results,
    draftEditCount: Math.max(0, Math.floor(input.draftEditCount)),
    draftRunCount: Math.max(0, Math.floor(input.draftRunCount)),
    ...(input.errorType ? { errorType: truncateChars(input.errorType, 128) } : {}),
    ...(input.failedTasks?.length ? { failedTasks: [...input.failedTasks] } : {}),
    ...(input.conflicts?.length ? { conflicts: input.conflicts.slice(0, 16).map((item) => truncateChars(item, 256)) } : {}),
    ...(input.error ? { error: truncateChars(normalizeInlineText(input.error), 512) } : {})
  });
  // Reserve semantic summaries before positional previews. Allocate escaped JSON
  // bytes fairly, so quotes, CJK and emoji obey the same total transport bound.
  const allocate = (field: 'summary' | 'preview', sources: string[]) => {
    const active = new Set(sources.map((_item, index) => index).filter((index) => sources[index]));
    let remaining = Math.max(0, maxBytes - utf8ByteLength(stableJson(payload())));
    const allocations = new Array(sources.length).fill(0) as number[];
    while (remaining > 8 && active.size) {
      const share = Math.max(1, Math.floor(remaining / active.size));
      let consumed = 0;
      for (const index of [...active]) {
        const current = results[index]![field];
        const source = sources[index]!;
        let low = allocations[index]!;
        let high = utf8ByteLength(source);
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          const candidate = truncateUtf8(source, mid);
          const added = utf8ByteLength(JSON.stringify(candidate)) - utf8ByteLength(JSON.stringify(current));
          if (added <= share) low = mid; else high = mid - 1;
        }
        const candidate = truncateUtf8(source, low);
        const added = utf8ByteLength(JSON.stringify(candidate)) - utf8ByteLength(JSON.stringify(current));
        allocations[index] = low;
        results[index]![field] = candidate;
        consumed += added;
        if (low >= utf8ByteLength(source) || !added) active.delete(index);
      }
      if (!consumed) break;
      remaining -= consumed;
    }
  };
  allocate('summary', input.manifests.map((manifest) => truncateChars(manifest.summary, SUBAGENT_HANDOFF_SUMMARY_MAX_CHARS)));
  allocate('preview', input.manifests.map((manifest) => manifest.preview));
  results.forEach((result) => { result.hasMore = result.resultBytes > utf8ByteLength(result.preview); });
  const serialized = stableJson(payload());
  if (utf8ByteLength(serialized) > maxBytes) throw new Error('subagent_parallel_metadata_too_large');
  return serialized;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

export function utf8ByteLength(value: string): number { return encoder.encode(value).byteLength; }

export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, Math.min(bytes.byteLength, Math.floor(maxBytes)));
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  try { return decoder.decode(bytes.slice(0, end)); }
  catch { return ''; }
}

function fitManifest(manifest: SubagentResultManifest, maxBytes: number | undefined): SubagentResultManifest {
  if (!maxBytes || utf8ByteLength(stableJson(manifest)) <= maxBytes) return manifest;
  const next = { ...manifest };
  let low = 0;
  let high = utf8ByteLength(next.preview);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    next.preview = truncateUtf8(manifest.preview, middle);
    if (utf8ByteLength(stableJson(next)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  next.preview = truncateUtf8(manifest.preview, low);
  next.hasMore = manifest.hasMore || next.preview !== manifest.preview;
  if (utf8ByteLength(stableJson(next)) <= maxBytes) return next;
  next.summary = truncateChars(next.summary, 160);
  if (next.error) next.error = truncateChars(next.error, 160);
  {
    next.keyEvidence = []; next.uncertainties = []; next.missing = (next.missing ?? []).slice(0, 1);
    next.hasMore = next.resultBytes > utf8ByteLength(next.preview);
    if (utf8ByteLength(stableJson(next)) > maxBytes) throw new Error('subagent_manifest_metadata_too_large');
  }
  return next;
}

function compactUsage(usage: TurnUsageStats | undefined): { requests: number; totalTokens: number } {
  return {
    requests: Math.max(0, Math.floor(usage?.requestCount ?? 0)),
    totalTokens: Math.max(0, Math.floor(usage?.totalTokens ?? 0))
  };
}

function truncateChars(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeInlineText(value: string): string { return value.replace(/\s+/gu, ' ').trim(); }
function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) result[key] = canonicalize(source[key]);
  return result;
}
