import { createHash } from 'node:crypto';
import type { TurnUsageStats } from '../../shared/types';
import type {
  StoredSubagentMetadata,
  SubagentManifestStatus,
  SubagentResultManifestV2
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
    | 'reusedFromSubagentId'>;
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
}): SubagentResultManifestV2 {
  const resultBytes = utf8ByteLength(input.result);
  const preview = truncateUtf8(input.result, Math.max(0, input.previewBytes
    ?? DEFAULT_SUBAGENT_HANDOFF_PREVIEW_BYTES));
  const manifest: SubagentResultManifestV2 = {
    version: 2,
    ok: input.ok,
    kind: 'subagent_result_manifest',
    subagentId: input.metadata.id,
    treeId: input.metadata.treeId,
    profile: input.metadata.profile,
    lane: input.metadata.lane,
    depth: input.metadata.depth,
    status: input.status,
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
  return fitManifest(manifest, input.maxBytes);
}

export function createParallelHandoff(input: {
  manifests: readonly SubagentResultManifestV2[];
  accepted: boolean;
  draftEditCount: number;
  draftRunCount: number;
  maxBytes?: number;
  errorType?: string;
  failedTasks?: readonly number[];
  conflicts?: readonly string[];
  error?: string;
}): string {
  const maxBytes = Math.max(16_384, Math.floor(input.maxBytes
    ?? DEFAULT_SUBAGENT_PARALLEL_HANDOFF_BYTES));
  const previewSources = input.manifests.map((manifest) => manifest.preview);
  const results = input.manifests.map((manifest, taskIndex) => ({
    taskIndex,
    ok: manifest.ok,
    status: manifest.status,
    subagentId: manifest.subagentId,
    treeId: manifest.treeId,
    profile: manifest.profile,
    lane: manifest.lane,
    depth: manifest.depth,
    resultRef: manifest.resultRef,
    resultHash: manifest.resultHash,
    resultChars: manifest.resultChars,
    resultBytes: manifest.resultBytes,
    hasMore: manifest.hasMore,
    draftEditCount: manifest.draftEditCount,
    draftRunCount: manifest.draftRunCount,
    ...(manifest.errorType ? { errorType: manifest.errorType } : {}),
    preview: ''
  }));
  const payload = () => ({
    version: 2,
    ok: input.accepted,
    kind: 'subagent_parallel_manifest',
    results,
    draftEditCount: Math.max(0, Math.floor(input.draftEditCount)),
    draftRunCount: Math.max(0, Math.floor(input.draftRunCount)),
    ...(input.errorType ? { errorType: input.errorType } : {}),
    ...(input.failedTasks?.length ? { failedTasks: [...input.failedTasks] } : {}),
    ...(input.conflicts?.length ? { conflicts: input.conflicts.map((value) => truncateChars(value, 256)) } : {}),
    ...(input.error ? { error: truncateChars(normalizeInlineText(input.error), 512) } : {})
  });
  let remaining = Math.max(0, maxBytes - utf8ByteLength(stableJson(payload())) - 64);
  const active = new Set(previewSources.map((_value, index) => index).filter((index) => previewSources[index]));
  const allocations = new Array(previewSources.length).fill(0) as number[];
  while (remaining > 0 && active.size) {
    const share = Math.max(1, Math.floor(remaining / active.size));
    let consumed = 0;
    for (const index of [...active]) {
      const total = utf8ByteLength(previewSources[index]!);
      const add = Math.min(share, total - allocations[index]!);
      allocations[index]! += add;
      consumed += add;
      if (allocations[index] === total) active.delete(index);
    }
    if (!consumed) break;
    remaining -= consumed;
  }
  results.forEach((result, index) => { result.preview = truncateUtf8(previewSources[index]!, allocations[index]!); });
  let serialized = stableJson(payload());
  // JSON escaping can be larger than the source UTF-8 slice. Shrink every
  // preview proportionally, preserving metadata and deterministic fairness.
  for (let attempt = 0; utf8ByteLength(serialized) > maxBytes && attempt < 12; attempt += 1) {
    const current = results.reduce((sum, item) => sum + utf8ByteLength(item.preview), 0);
    if (!current) break;
    const excess = utf8ByteLength(serialized) - maxBytes;
    const target = Math.max(0, current - excess - 32);
    results.forEach((item, index) => {
      const bytes = Math.floor(utf8ByteLength(item.preview) * target / current);
      item.preview = truncateUtf8(previewSources[index]!, bytes);
    });
    serialized = stableJson(payload());
  }
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

function fitManifest(manifest: SubagentResultManifestV2, maxBytes: number | undefined): SubagentResultManifestV2 {
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
