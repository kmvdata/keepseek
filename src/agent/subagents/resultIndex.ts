import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { writeBytesAtomic } from '../../shared/atomicStorage';
import { isRecord } from '../../shared/errors';
import type { StoredSubagentMetadata, StoredSubagentTranscript } from './types';

/** Storage capacity, independent of profile delivery and model token limits. */
export const MAX_CANONICAL_SUBAGENT_BYTES = 2 * 1024 * 1024;
const CHUNK_BYTES = 24_576;
const HASH = /^[a-f0-9]{64}$/u;
export type ResultIndexMetadata = Pick<StoredSubagentMetadata, 'id' | 'treeId' | 'parentSessionId' | 'parentRunId'
  | 'rootRunId' | 'profile' | 'lane' | 'status' | 'resultStatus' | 'failureKind' | 'resultHash' | 'resultChars'
  | 'resultBytes' | 'resultTruncated' | 'reusedFromSubagentId' | 'reusedFromParentRunId' | 'normalizedTaskHash'
  | 'resultFormatAccepted' | 'resultContractVersion' | 'usage'>;
export interface SubagentResultIndex {
  version: 1;
  metadata: ResultIndexMetadata;
  canonical?: { hash: string; bytes: number; chars: number; chunks: Array<{ hash: string; bytes: number }> };
  resultRef?: string;
}
export function resultMetadata(metadata: StoredSubagentMetadata): ResultIndexMetadata {
  return { id: metadata.id, treeId: metadata.treeId, parentSessionId: metadata.parentSessionId,
    parentRunId: metadata.parentRunId, rootRunId: metadata.rootRunId, profile: metadata.profile, lane: metadata.lane,
    status: metadata.status, resultStatus: metadata.resultStatus, failureKind: metadata.failureKind,
    resultHash: metadata.resultHash, resultChars: metadata.resultChars, resultBytes: metadata.resultBytes,
    resultTruncated: metadata.resultTruncated, reusedFromSubagentId: metadata.reusedFromSubagentId,
    reusedFromParentRunId: metadata.reusedFromParentRunId, normalizedTaskHash: metadata.normalizedTaskHash,
    resultFormatAccepted: metadata.resultFormatAccepted, resultContractVersion: metadata.resultContractVersion, usage: metadata.usage };
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const chunkUri = (directory: vscode.Uri, hash: string) => vscode.Uri.joinPath(directory, 'result-objects', `${hash}.bin`);

/** Objects commit before the state manifest; an orphan after interruption is harmless. */
export async function saveResultIndex(directory: vscode.Uri, metadata: StoredSubagentMetadata,
  transcript: Pick<StoredSubagentTranscript, 'result' | 'resultRef'>): Promise<SubagentResultIndex> {
  const index: SubagentResultIndex = { version: 1, metadata: resultMetadata(metadata) };
  if (!transcript.result && transcript.resultRef) { index.resultRef = transcript.resultRef; return index; }
  const bytes = new TextEncoder().encode(transcript.result);
  if (bytes.length > MAX_CANONICAL_SUBAGENT_BYTES) throw new Error('Subagent canonical result exceeds the storage capacity.');
  const hash = digest(bytes);
  if (metadata.resultHash && metadata.resultHash !== hash || metadata.resultBytes !== undefined && metadata.resultBytes !== bytes.length
    || metadata.resultChars !== undefined && metadata.resultChars !== transcript.result.length) throw new Error('Subagent result metadata integrity mismatch.');
  const canonical: NonNullable<SubagentResultIndex['canonical']> = { hash, bytes: bytes.length, chars: transcript.result.length, chunks: [] };
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + CHUNK_BYTES);
    while (end < bytes.length && isContinuation(bytes[end]!)) end--;
    const chunk = bytes.slice(start, end), hash = digest(chunk), uri = chunkUri(directory, hash);
    try {
      if (digest(await vscode.workspace.fs.readFile(uri)) !== hash) throw new Error('Subagent result object integrity mismatch.');
    } catch (error) {
      if (!['FileNotFound', 'ENOENT'].includes(String((error as { code?: string })?.code))) throw error;
      await writeBytesAtomic(uri, chunk, { durable: true });
    }
    canonical.chunks.push({ hash, bytes: chunk.length }); start = end;
  }
  index.canonical = canonical;
  index.metadata = { ...index.metadata, resultHash: hash, resultChars: transcript.result.length, resultBytes: bytes.length };
  return index;
}

export function normalizeResultIndex(value: unknown, parentSessionId: string, id: string): SubagentResultIndex | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.metadata)) return undefined;
  const m = value.metadata;
  if (m.id !== id || m.parentSessionId !== parentSessionId || !['treeId', 'parentRunId', 'rootRunId', 'profile', 'lane', 'status']
    .every(key => typeof m[key] === 'string') || !['queued', 'running', 'completed', 'failed', 'stopped'].includes(String(m.status))
    || !['treeId', 'parentRunId', 'rootRunId'].every(key => safeId(String(m[key])))
    || m.resultStatus !== undefined && !['complete', 'partial', 'failed'].includes(String(m.resultStatus))
    || m.resultFormatAccepted !== undefined && typeof m.resultFormatAccepted !== 'boolean'
    || m.resultContractVersion !== undefined && m.resultContractVersion !== 2
    || m.resultTruncated !== undefined && typeof m.resultTruncated !== 'boolean') return undefined;
  if (typeof value.resultRef === 'string') {
    if (value.canonical !== undefined || !safeId(value.resultRef) || value.resultRef !== m.reusedFromSubagentId
      || typeof m.reusedFromParentRunId !== 'string' || typeof m.resultHash !== 'string' || !HASH.test(m.resultHash)) return undefined;
  } else {
    const c = value.canonical;
    if (!isRecord(c) || typeof c.hash !== 'string' || !HASH.test(c.hash) || !Number.isSafeInteger(c.bytes) || !Number.isSafeInteger(c.chars)
      || Number(c.bytes) < 0 || Number(c.bytes) > MAX_CANONICAL_SUBAGENT_BYTES || Number(c.chars) < 0 || !Array.isArray(c.chunks)
      || c.chunks.length > Math.ceil(MAX_CANONICAL_SUBAGENT_BYTES / (CHUNK_BYTES - 3)) || !c.chunks.every(chunk => isRecord(chunk)
        && typeof chunk.hash === 'string' && HASH.test(chunk.hash) && Number.isSafeInteger(chunk.bytes)
        && Number(chunk.bytes) > 0 && Number(chunk.bytes) <= CHUNK_BYTES)
      || c.chunks.reduce((sum, chunk) => sum + Number(chunk.bytes), 0) !== c.bytes
      || c.hash !== m.resultHash || c.bytes !== m.resultBytes || c.chars !== m.resultChars) return undefined;
  }
  return value as unknown as SubagentResultIndex;
}

/** Read only overlapping chunks. Each read rechecks bytes; no body cache can hide corruption. */
export async function readResultRange(directory: vscode.Uri, canonical: NonNullable<SubagentResultIndex['canonical']>,
  start: number, end: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; let offset = 0;
  for (const chunk of canonical.chunks) {
    const next = offset + chunk.bytes;
    if (offset < end && next > start) {
      const bytes = await vscode.workspace.fs.readFile(chunkUri(directory, chunk.hash));
      if (bytes.length !== chunk.bytes || digest(bytes) !== chunk.hash) throw new Error('Subagent result object integrity mismatch.');
      // Fatal decoding also rejects malformed UTF-8 in a forged index.
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      parts.push(bytes.slice(Math.max(0, start - offset), Math.min(bytes.length, end - offset)));
    }
    offset = next;
  }
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let position = 0; for (const part of parts) { result.set(part, position); position += part.length; }
  return result;
}
function isContinuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }
function safeId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value) && value !== '.' && value !== '..'; }
