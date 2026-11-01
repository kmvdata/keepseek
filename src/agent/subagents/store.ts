import { writeJsonAtomic } from '../../shared/atomicStorage';
import { normalizeRunCheckpoint } from '../runCheckpoint';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { isRecord } from '../../shared/errors';
import { normalizeSubagentRunUsageSummaryValue } from '../subagentUsageStats';
import { SessionObjectStore } from '../../sessions/sessionObjectStore';
import { copyPersistenceValue, snapshotCheckpoint, packPersistenceInput } from '../../sessions/persistenceSnapshot';
import { withStorageCoordinator } from '../../shared/atomicStorage';
import { recordLocalPerformance } from '../logging/performanceTrace';
import type { ChatSession, SubagentActivity } from '../../shared/types';
import { CoalescedWriter } from '../../sessions/coalescedWriter';
import { normalizeResultIndex, readResultRange, resultMetadata, saveResultIndex,
  type ResultIndexMetadata, type SubagentResultIndex } from './resultIndex';
import { legacyVerifiedRanges, verifyLegacyRanges, type LegacyVerifiedRange } from './legacyResultProjection';
import type {
  StoredSubagentMetadata,
  StoredSubagentTranscript,
  SubagentDiagnosticReference,
  SubagentFailureKind
} from './types';

const SUBAGENT_STORAGE_VERSION = 'v1';
const DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DIAGNOSTIC_CHARS = 768;
const MAX_DIAGNOSTIC_BYTES = 8_192;
export const DEFAULT_SUBAGENT_RESULT_PAGE_BYTES = 12_288;
export const MAX_SUBAGENT_RESULT_PAGE_BYTES = 24_576;
/** V1-V9 compatibility aliases. */
export const DEFAULT_SUBAGENT_RESULT_PAGE_CHARS = 12_000;
export const MAX_SUBAGENT_RESULT_PAGE_CHARS = 24_000;

export class SubagentStore {
  private readonly objectStores = new Map<string, SessionObjectStore>();
  private readonly queueDepths = new Map<string, number>();
  private readonly writers = new Map<string, CoalescedWriter<() => Promise<void>>>();
  private readonly rootUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(globalStorageUri: vscode.Uri, private readonly workspaceKey: string,
    private readonly onActivity?: (activity: SubagentActivity) => void) {
    const workspaceHash = createHash('sha256').update(workspaceKey, 'utf8').digest('hex').slice(0, 24);
    this.rootUri = vscode.Uri.joinPath(
      globalStorageUri,
      'chat-sessions',
      SUBAGENT_STORAGE_VERSION,
      'subagents',
      workspaceHash
    );
  }

  public async save(metadata: StoredSubagentMetadata, transcript: StoredSubagentTranscript): Promise<void> {
    if (!isSafeId(metadata.id) || transcript.metadataId !== metadata.id) throw new Error('Invalid subagent storage scope');
    const directory = this.getParentDirectory(metadata.parentSessionId);
    const started = performance.now();
    const { messages, checkpoint, ...header } = transcript;
    const savedCheckpoint = checkpoint ? snapshotCheckpoint(checkpoint) : undefined;
    if (savedCheckpoint) packPersistenceInput(savedCheckpoint.request.history);
    const snapshot = { id: metadata.id, workspaceKey: this.workspaceKey, messages: [],
      subagentMetadata: copyPersistenceValue(metadata),
      subagentTranscript: { ...copyPersistenceValue(header), messages: packPersistenceInput(copyPersistenceValue(messages)),
        checkpoint: savedCheckpoint }
    } as unknown as ChatSession;
    const summary = activityFromMetadata(metadata);
    const stats = copyPersistenceValue(metadata.stats);
    const copied = performance.now();
    const uri = vscode.Uri.joinPath(directory, `${metadata.id}.state.json`);
    const key = uri.toString();
    let writer = this.writers.get(key);
    if (!writer) { writer = new CoalescedWriter(commit => commit()); this.writers.set(key, writer); }
    const depth = (this.queueDepths.get(key) ?? 0) + 1;
    this.queueDepths.set(key, depth);
    try {
      await writer.save(() => withStorageCoordinator(key + ':child', async () => {
        const processing = performance.now();
        let store = this.objectStores.get(key);
        if (!store) {
          store = new SessionObjectStore(uri);
          try { await store.load(JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(uri)))); }
          catch (error) { if (!isMissing(error)) throw error; }
          this.objectStores.set(key, store);
        }
        const resultIndex = await saveResultIndex(directory,
          (snapshot as unknown as { subagentMetadata: StoredSubagentMetadata }).subagentMetadata, header);
        await store.save(snapshot, { version: 1, activity: summary, stats, resultIndex }, {
          sessionId: summary.parentSessionId, taskId: checkpoint?.taskId, childId: summary.id });
        this.onActivity?.(summary);
        recordLocalPerformance({ type: 'checkpoint_child_store', sessionId: metadata.parentSessionId,
          taskId: checkpoint?.taskId, childId: metadata.id, snapshotMs: copied - started,
          queueMs: processing - copied, processingMs: performance.now() - processing,
          durationMs: performance.now() - started, queueDepth: depth });
      }));
    } finally {
      const remaining = (this.queueDepths.get(key) ?? 1) - 1;
      if (remaining) this.queueDepths.set(key, remaining); else this.queueDepths.delete(key);
    }
  }

  public async saveActivity(activity: SubagentActivity): Promise<void> {
    if (!validActivity(activity, activity.parentSessionId, activity.id) || !isSafeId(activity.id)) throw new Error('Invalid subagent activity scope');
    activity = copyActivity(activity);
    await writeJsonAtomic(vscode.Uri.joinPath(this.getParentDirectory(activity.parentSessionId), `${activity.id}.activity.json`),
      { version: 1, activity }, { durable: true });
    this.onActivity?.(activity);
  }

  /** One bounded manifest per child; V4 never decodes private transcript objects. */
  public async readSummaries(parentSessionId: string): Promise<{ activities: SubagentActivity[];
    summaries: import('../../shared/types').SubagentRunUsageSummary[]; incomplete: boolean }> {
    const result = { activities: [] as SubagentActivity[], summaries: [] as import('../../shared/types').SubagentRunUsageSummary[], incomplete: false };
    let files: [string, vscode.FileType][];
    try { files = await vscode.workspace.fs.readDirectory(this.getParentDirectory(parentSessionId)); }
    catch (error) { result.incomplete = !isMissing(error); return result; }
    const ids = new Set(files.flatMap(([name, type]) => type === vscode.FileType.File
      && /\.(state|run|activity|meta)\.json$/u.test(name) ? [name.replace(/\.(state|run|activity|meta)\.json$/u, '')] : []));
    for (const id of ids) {
      if (!isSafeId(id)) { result.incomplete = true; continue; }
      try {
        const graph = files.some(([name]) => name === `${id}.state.json`);
        const legacy = files.some(([name]) => name === `${id}.run.json`);
        const split = files.some(([name]) => name === `${id}.meta.json`);
        const value = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(
          this.getParentDirectory(parentSessionId), `${id}.${graph ? 'state' : legacy ? 'run' : split ? 'meta' : 'activity'}.json`))));
        const metadata = !graph && (legacy || split) ? normalizeMetadata(legacy ? value.metadata : value) : undefined;
        const activity = metadata ? activityFromMetadata(metadata) : graph ? value.summary?.activity : value.activity;
        if (!validActivity(activity, parentSessionId, id) || graph && (value.version !== 4
          || value.workspaceKey !== this.workspaceKey || value.sessionId !== id || value.summary?.version !== 1
          || value.summaryHash !== createHash('sha256').update(JSON.stringify(value.summary)).digest('hex'))) throw new Error('Invalid child index');
        result.activities.push({ ...copyActivity(activity), ...(activity.status === 'queued' || activity.status === 'running'
          ? { status: 'stopped' as const, interrupted: true } : {}) });
        const stats = normalizeSubagentRunUsageSummaryValue(metadata?.stats ?? value.summary?.stats);
        if (stats && stats.subagentId === id && stats.parentRunId === activity.parentRunId && stats.rootRunId === activity.rootRunId
          && stats.sourceId === activity.sourceId && stats.modelId === activity.modelId && stats.profile === activity.profile && stats.lane === activity.lane) result.summaries.push(stats);
        else if (activity.status === 'completed' || activity.status === 'failed') result.incomplete = true;
      } catch { result.incomplete = true; }
    }
    return result;
  }

  public async read(parentSessionId: string, subagentId: string): Promise<{
    metadata: StoredSubagentMetadata;
    transcript: StoredSubagentTranscript;
  } | undefined> {
    if (!isSafeId(parentSessionId) || !isSafeId(subagentId)) {
      return undefined;
    }
    try {
      const uri = vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.state.json`);
      try {
        const manifest = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(uri)));
        if (manifest.workspaceKey !== this.workspaceKey || manifest.sessionId !== subagentId) return undefined;
        if (manifest.summary && manifest.summaryHash !== createHash('sha256').update(JSON.stringify(manifest.summary)).digest('hex')) return undefined;
        const indexedResult = manifest.summary && Object.hasOwn(manifest.summary, 'resultIndex')
          ? normalizeResultIndex(manifest.summary.resultIndex, parentSessionId, subagentId) : undefined;
        if (manifest.summary && Object.hasOwn(manifest.summary, 'resultIndex') && !indexedResult) return undefined;
        const session = await new SessionObjectStore(uri).load(manifest) as unknown as {
          subagentMetadata: unknown; subagentTranscript: Omit<StoredSubagentTranscript, 'messages'>; messages: StoredSubagentTranscript['messages'] };
        const metadata = normalizeMetadata(session.subagentMetadata);
        const transcript = normalizeTranscript({ ...session.subagentTranscript,
          messages: (session.subagentTranscript as StoredSubagentTranscript).messages ?? session.messages });
        if (metadata && transcript && indexedResult && (metadata.resultHash && metadata.resultHash !== indexedResult.metadata.resultHash
          || !['queued', 'running'].includes(indexedResult.metadata.status) && metadata.resultStatus !== indexedResult.metadata.resultStatus)) return undefined;
        if (metadata?.status === 'completed' && indexedResult) {
          const canonical = await this.resolveResultSource(parentSessionId, indexedResult);
          if (!canonical || createHash('sha256').update(await canonical.range(0, canonical.bytes)).digest('hex') !== canonical.hash) return undefined;
        }
        return metadata && transcript && metadata.id === subagentId && metadata.parentSessionId === parentSessionId
          && transcript.metadataId === subagentId ? { metadata, transcript } : undefined;
      } catch (error) { if (!isMissing(error)) return undefined; }
      try {
        const data = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.run.json`)
        ))) as { metadata?: unknown; transcript?: unknown };
        const metadata = normalizeMetadata(data.metadata);
        const transcript = normalizeTranscript(data.transcript);
        if (metadata && transcript && metadata.id === subagentId && metadata.parentSessionId === parentSessionId
          && transcript.metadataId === metadata.id) return { metadata, transcript };
        return undefined;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['FileNotFound', 'ENOENT'].includes(String(error.code))) return undefined;
      }
      const [metadataBytes, transcriptBytes] = await Promise.all([
        vscode.workspace.fs.readFile(this.getMetadataUri(parentSessionId, subagentId)),
        vscode.workspace.fs.readFile(this.getTranscriptUri(parentSessionId, subagentId))
      ]);
      const metadata = normalizeMetadata(JSON.parse(this.decoder.decode(metadataBytes)));
      const transcript = normalizeTranscript(JSON.parse(this.decoder.decode(transcriptBytes)));
      if (!metadata || !transcript || metadata.id !== subagentId || metadata.parentSessionId !== parentSessionId || transcript.metadataId !== metadata.id) {
        return undefined;
      }
      return { metadata, transcript };
    } catch {
      return undefined;
    }
  }

  public async readResultPage(input: {
    parentSessionId: string;
    ref?: string;
    subagentId?: string;
    allowedTreeId?: string;
    offsetBytes?: number;
    limitBytes?: number;
    offset?: number;
    maxChars?: number;
  }): Promise<Record<string, unknown>> {
    const ref = input.ref ?? input.subagentId ?? '';
    const legacy = !input.ref && input.offsetBytes === undefined && input.limitBytes === undefined;
    try {
      const stored = await this.resultSource(input.parentSessionId, ref);
      if (!stored) return { ok: false, errorType: await this.runFileExists(input.parentSessionId, ref)
        ? 'subagent_result_corrupt' : 'subagent_result_not_found', error: 'The requested result is unavailable in this session lineage.' };
      const metadata = stored.metadata;
      if (input.allowedTreeId && metadata.treeId !== input.allowedTreeId) return { ok: false,
        errorType: 'subagent_result_forbidden', error: 'The result reference is outside the current subagent tree.' };
      if (metadata.status === 'queued' || metadata.status === 'running' || metadata.failureKind === 'interrupted') return {
        ok: false, ref, subagentId: metadata.id, status: metadata.status, errorType: 'subagent_result_pending', error: 'The referenced result is not complete yet.' };
      if (metadata.resultTruncated && metadata.resultContractVersion !== 2) return { ok: false, ref,
        resultStatus: 'partial', formatAccepted: false, errorType: 'subagent_result_unavailable',
        error: 'This legacy result was truncated; its original canonical body is unavailable.' };
      const canonical = await this.resolveResultSource(input.parentSessionId, stored);
      if (!canonical) return { ok: false, ref, errorType: 'subagent_result_corrupt', error: 'The canonical result reference failed its integrity check.' };
      const shared = { ok: true, subagentId: metadata.id, status: manifestStatus(metadata), profile: metadata.profile, lane: metadata.lane,
        resultHash: canonical.hash, resultStatus: metadata.resultStatus ?? 'unknown',
        formatAccepted: metadata.resultFormatAccepted === true, parentAcceptance: 'pending',
        resultTruncated: metadata.resultTruncated === true };
      if (legacy) {
        const result = this.decoder.decode(await canonical.range(0, canonical.bytes));
        const offset = clampInteger(input.offset, 0, result.length, 0);
        const maxChars = clampInteger(input.maxChars, 1, MAX_SUBAGENT_RESULT_PAGE_CHARS, DEFAULT_SUBAGENT_RESULT_PAGE_CHARS);
        const content = result.slice(offset, offset + maxChars), nextOffset = offset + content.length;
        return { ...shared, subagentId: metadata.id, offset, content, totalChars: result.length,
          usage: metadata.usage, hasMore: nextOffset < result.length, ...(nextOffset < result.length ? { nextOffset } : {}) };
      }
      if (input.offsetBytes !== undefined && (!Number.isSafeInteger(input.offsetBytes) || input.offsetBytes < 0)) return {
        ok: false, ref, errorType: 'subagent_result_offset_out_of_range', error: 'The byte offset must be a nonnegative integer.' };
      const offsetBytes = input.offsetBytes ?? 0;
      if (offsetBytes > canonical.bytes) return { ok: false, ref, errorType: 'subagent_result_offset_out_of_range',
        offsetBytes, totalBytes: canonical.bytes, error: 'The requested byte offset is beyond the stored result.' };
      const limitBytes = clampInteger(input.limitBytes, 4, MAX_SUBAGENT_RESULT_PAGE_BYTES, DEFAULT_SUBAGENT_RESULT_PAGE_BYTES);
      const bytes = await canonical.range(offsetBytes, Math.min(canonical.bytes, offsetBytes + limitBytes + 1));
      if (bytes.length && isUtf8ContinuationByte(bytes[0]!)) return { ok: false, ref,
        errorType: 'subagent_result_invalid_utf8_offset', offsetBytes, error: 'The byte offset is not a UTF-8 character boundary.' };
      let returnedBytes = Math.min(bytes.length, limitBytes);
      while (returnedBytes > 0 && returnedBytes < bytes.length && isUtf8ContinuationByte(bytes[returnedBytes]!)) returnedBytes--;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(0, returnedBytes));
      const end = offsetBytes + returnedBytes, hasMore = end < canonical.bytes;
      return { ...shared, ref, content, offsetBytes, returnedBytes, ...(hasMore ? { nextOffsetBytes: end } : {}),
        totalBytes: canonical.bytes, hasMore };
    } catch {
      return { ok: false, ref, errorType: 'subagent_result_corrupt', error: 'The result index or canonical content failed its integrity check.' };
    }
  }

  /** Acceptance verifies the entire immutable body, not just a delivered page.
   * This deliberately costs one full canonical read, but no private graph. */
  public async verifyResult(input: { parentSessionId: string; ref: string; allowedTreeId?: string }): Promise<{
    subagentId: string; resultHash: string; resultStatus: 'complete' | 'partial' | 'failed'; formatAccepted: boolean;
  } | undefined> {
    try {
      const source = await this.resultSource(input.parentSessionId, input.ref);
      if (!source || input.allowedTreeId && source.metadata.treeId !== input.allowedTreeId
        || source.metadata.status === 'queued' || source.metadata.status === 'running' || source.metadata.failureKind === 'interrupted'
        || !source.metadata.resultStatus || source.metadata.resultTruncated && source.metadata.resultContractVersion !== 2) return undefined;
      const canonical = await this.resolveResultSource(input.parentSessionId, source);
      if (!canonical) return undefined;
      const bytes = await canonical.range(0, canonical.bytes);
      if (bytes.length !== canonical.bytes || createHash('sha256').update(bytes).digest('hex') !== canonical.hash) return undefined;
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { subagentId: source.metadata.id, resultHash: canonical.hash, resultStatus: source.metadata.resultStatus,
        formatAccepted: source.metadata.resultFormatAccepted === true };
    } catch { return undefined; }
  }

  /** Bounded result-only projection; no private messages/checkpoint decoding. */
  private async resultSource(parentSessionId: string, id: string): Promise<ResultSource | undefined> {
    if (!isSafeId(parentSessionId) || !isSafeId(id)) return undefined;
    const directory = this.getParentDirectory(parentSessionId), uri = vscode.Uri.joinPath(directory, `${id}.state.json`);
    try {
      const manifest = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(uri)));
      if (manifest.workspaceKey !== this.workspaceKey || manifest.sessionId !== id || manifest.version !== 4
        || manifest.summary?.version !== 1 || manifest.summaryHash !== createHash('sha256').update(JSON.stringify(manifest.summary)).digest('hex')) {
        throw new Error('Invalid child result manifest');
      }
      if (Object.hasOwn(manifest.summary, 'resultIndex')) {
        const index = normalizeResultIndex(manifest.summary.resultIndex, parentSessionId, id);
        if (!index) throw new Error('Invalid child result index');
        return index;
      }
      const graph = new SessionObjectStore(uri);
      const metadata = normalizeMetadata(await graph.loadField(manifest, ['subagentMetadata']));
      const result = await graph.loadField(manifest, ['subagentTranscript', 'result']);
      const resultRef = await graph.loadField(manifest, ['subagentTranscript', 'resultRef']);
      if (!metadata || metadata.id !== id || metadata.parentSessionId !== parentSessionId || typeof result !== 'string') throw new Error('Invalid legacy child result');
      return { metadata: resultMetadata(metadata), result, resultRef: typeof resultRef === 'string' ? resultRef : metadata.reusedFromSubagentId };
    } catch (error) { if (!isMissing(error)) throw error; }
    // Legacy combined/split records are immutable after completion. Cache only
    // extracted, hash-verified result data, keyed by scope and source identity.
    return this.legacyResultSource(parentSessionId, id);
  }

  private async resolveResultSource(parentSessionId: string, initial: ResultSource): Promise<{
    hash: string; bytes: number; range: (start: number, end: number) => Promise<Uint8Array>
  } | undefined> {
    let current = initial;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(current.metadata.id)) return undefined;
      visited.add(current.metadata.id);
      if (current.metadata.resultTruncated && current.metadata.resultContractVersion !== 2) return undefined;
      if (current.canonical) {
        const canonical = current.canonical;
        if (initial.metadata.resultHash && initial.metadata.resultHash !== canonical.hash
          || initial.metadata.resultBytes !== undefined && initial.metadata.resultBytes !== canonical.bytes
          || initial.metadata.resultChars !== undefined && initial.metadata.resultChars !== canonical.chars) return undefined;
        return { hash: canonical.hash, bytes: canonical.bytes, range: (start, end) => readResultRange(this.getParentDirectory(parentSessionId), canonical, start, end) };
      }
      if (current.result) {
        const bytes = this.encoder.encode(current.result), hash = createHash('sha256').update(bytes).digest('hex');
        if (current.metadata.resultHash && current.metadata.resultHash !== hash || initial.metadata.resultHash && initial.metadata.resultHash !== hash
          || current.metadata.resultBytes !== undefined && current.metadata.resultBytes !== bytes.length
          || current.metadata.resultChars !== undefined && current.metadata.resultChars !== current.result.length
          || initial.metadata.resultBytes !== undefined && initial.metadata.resultBytes !== bytes.length
          || initial.metadata.resultChars !== undefined && initial.metadata.resultChars !== current.result.length) return undefined;
        return { hash, bytes: bytes.length, range: async (start, end) => bytes.slice(start, end) };
      }
      const ref = current.resultRef ?? current.metadata.reusedFromSubagentId;
      if (!ref) return current.metadata.resultHash && current.metadata.resultHash !== createHash('sha256').update('').digest('hex') ? undefined
        : { hash: createHash('sha256').update('').digest('hex'), bytes: 0, range: async () => new Uint8Array() };
      if (ref !== current.metadata.reusedFromSubagentId) return undefined;
      const next = await this.resultSource(parentSessionId, ref);
      if (!next || next.metadata.parentSessionId !== parentSessionId || current.metadata.reusedFromParentRunId !== next.metadata.parentRunId
        || current.metadata.normalizedTaskHash !== next.metadata.normalizedTaskHash
        || current.metadata.resultHash !== next.metadata.resultHash || next.metadata.status !== 'completed'
        || next.metadata.resultStatus !== 'complete' || next.metadata.resultTruncated) return undefined;
      current = next;
    }
    return undefined;
  }

  private readonly legacyResults = new Map<string, { signature: string; bytes: number; source: ResultSource;
    ranges: Array<{ uri: vscode.Uri; values: LegacyVerifiedRange[] }> }>();
  private async legacyResultSource(parentSessionId: string, id: string): Promise<ResultSource | undefined> {
    const directory = this.getParentDirectory(parentSessionId), combined = vscode.Uri.joinPath(directory, `${id}.run.json`);
    let uris: vscode.Uri[];
    try { await vscode.workspace.fs.stat(combined); uris = [combined]; }
    catch (error) { if (!isMissing(error)) throw error; uris = [this.getMetadataUri(parentSessionId, id), this.getTranscriptUri(parentSessionId, id)]; }
    const signatureFor = async () => JSON.stringify(await Promise.all(uris.map(async uri => {
      const stat = await vscode.workspace.fs.stat(uri); return [uri.toString(), stat.size, stat.ctime, stat.mtime];
    })));
    let signature: string;
    try { signature = await signatureFor(); } catch (error) { if (isMissing(error)) return undefined; throw error; }
    const key = `${parentSessionId}/${id}`, cached = this.legacyResults.get(key);
    if (cached?.signature === signature) {
      for (const range of cached.ranges) await verifyLegacyRanges(range.uri, range.values);
      if (signature !== await signatureFor()) throw new Error('Legacy result changed during verification');
      this.legacyResults.delete(key); this.legacyResults.set(key, cached); return cached.source;
    }
    this.legacyResults.delete(key);
    const texts = await Promise.all(uris.map(async uri => new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri))));
    const values = texts.map(text => JSON.parse(text));
    const metadata = normalizeMetadata(uris.length === 1 ? values[0].metadata : values[0]);
    const transcript = uris.length === 1 ? values[0].transcript : values[1];
    if (!metadata || metadata.id !== id || metadata.parentSessionId !== parentSessionId || !isRecord(transcript)
      || transcript.metadataId !== id || typeof transcript.result !== 'string') throw new Error('Invalid legacy child result');
    const result = transcript.result, bytes = Buffer.byteLength(result), hash = createHash('sha256').update(result).digest('hex');
    if (metadata.resultHash && metadata.resultHash !== hash && !transcript.resultRef) throw new Error('Legacy result integrity mismatch');
    // Re-encode only the extracted projection so a sliced string cannot retain
    // the much larger combined private source buffer in the bounded cache.
    const source = JSON.parse(JSON.stringify({ metadata: resultMetadata(metadata), result,
      resultRef: typeof transcript.resultRef === 'string' ? transcript.resultRef : metadata.reusedFromSubagentId })) as ResultSource;
    if (signature !== await signatureFor()) throw new Error('Legacy result changed during verification');
    if (bytes <= 2 * 1024 * 1024 && uris.every(uri => uri.scheme === 'file')) {
      const ranges = uris.map((uri, position) => ({ uri, values: uris.length === 2 && position === 0
        ? [{ offset: 0, bytes: Buffer.byteLength(texts[position]!), hash: createHash('sha256').update(texts[position]!).digest('hex') }]
        : legacyVerifiedRanges(texts[position]!, uris.length === 1) }));
      this.legacyResults.set(key, { signature, bytes, source, ranges });
      while (this.legacyResults.size > 8 || [...this.legacyResults.values()].reduce((total, value) => total + value.bytes, 0) > 4 * 1024 * 1024) {
        this.legacyResults.delete(this.legacyResults.keys().next().value!);
      }
    }
    return source;
  }

  public async readCanonicalResult(
    parentSessionId: string,
    initial: { metadata: StoredSubagentMetadata; transcript: StoredSubagentTranscript }
  ): Promise<string | undefined> {
    if (initial.metadata.parentSessionId !== parentSessionId || initial.transcript.metadataId !== initial.metadata.id) return undefined;
    try {
      const canonical = await this.resolveResultSource(parentSessionId, { metadata: resultMetadata(initial.metadata),
        result: initial.transcript.result, resultRef: initial.transcript.resultRef });
      return canonical ? new TextDecoder('utf-8', { fatal: true }).decode(await canonical.range(0, canonical.bytes)) : undefined;
    } catch { return undefined; }
  }

  public async findCompletedCandidates(input: {
    parentSessionId: string;
    excludeSubagentId?: string;
    normalizedTaskHash: string;
    profile: string;
    lane: string;
    sourceId: string;
    modelId: string;
    sourceConfigHash: string;
    systemPromptHash: string;
    toolSchemaHash: string;
    profileHash: string;
    projectInstructionsHash: string;
    authorizationContextHash: string;
    workspaceContextHash: string;
  }): Promise<Array<{ metadata: StoredSubagentMetadata; transcript: StoredSubagentTranscript }>> {
    if (!isSafeId(input.parentSessionId)) return [];
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.getParentDirectory(input.parentSessionId));
    } catch {
      return [];
    }
    const ids = entries
      .filter(([name, type]) => type === vscode.FileType.File && /\.(run|state)\.json$/u.test(name))
      .map(([name]) => name.replace(/\.(run|state)\.json$/u, ''))
      .filter((id) => id !== input.excludeSubagentId)
      .slice(-64);
    const candidates = (await Promise.all(ids.map(async (id) => await this.read(input.parentSessionId, id))))
      .filter((value): value is { metadata: StoredSubagentMetadata; transcript: StoredSubagentTranscript } => Boolean(value))
      .filter(({ metadata, transcript }) => metadata.status === 'completed'
        && metadata.resultStatus === 'complete'
        && !metadata.resultTruncated
        && (!metadata.resultHash || createHash('sha256').update(transcript.result).digest('hex') === metadata.resultHash)
        && metadata.normalizedTaskHash === input.normalizedTaskHash
        && metadata.profile === input.profile
        && metadata.lane === input.lane
        && metadata.sourceId === input.sourceId
        && metadata.modelId === input.modelId
        && metadata.sourceConfigHash === input.sourceConfigHash
        && metadata.systemPromptHash === input.systemPromptHash
        && metadata.toolSchemaHash === input.toolSchemaHash
        && metadata.profileHash === input.profileHash
        && metadata.projectInstructionsHash === input.projectInstructionsHash
        && metadata.authorizationContextHash === input.authorizationContextHash
        && metadata.workspaceContextHash === input.workspaceContextHash
        && Boolean(transcript.result));
    return candidates.sort((left, right) => right.metadata.updatedAt.localeCompare(left.metadata.updatedAt)).slice(0, 5);
  }

  public async saveDiagnostic(input: {
    parentSessionId: string;
    subagentId: string;
    parentRunId: string;
    kind: SubagentFailureKind;
    reasonCode: string;
    summary: string;
    traceRunIds?: readonly string[];
    checkpointTaskId?: string;
  }): Promise<SubagentDiagnosticReference> {
    if (!isSafeId(input.parentSessionId) || !isSafeId(input.subagentId)) {
      throw new Error('Invalid subagent diagnostic scope.');
    }
    const id = `diag_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + DIAGNOSTIC_RETENTION_MS).toISOString();
    const payload = {
      version: 1,
      id,
      subagentId: input.subagentId,
      parentRunId: input.parentRunId,
      kind: input.kind,
      reasonCode: sanitizeDiagnosticText(input.reasonCode, 96),
      summary: sanitizeDiagnosticText(input.summary, MAX_DIAGNOSTIC_CHARS),
      traceRunIds: (input.traceRunIds ?? []).filter(isSafeId).slice(-4),
      checkpointTaskId: input.checkpointTaskId && isSafeId(input.checkpointTaskId) ? input.checkpointTaskId : undefined,
      createdAt,
      expiresAt
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const sizeBytes = this.encoder.encode(serialized).byteLength;
    if (sizeBytes > MAX_DIAGNOSTIC_BYTES) throw new Error('Subagent diagnostic exceeded its storage limit.');
    const directory = this.getParentDirectory(input.parentSessionId);
    await vscode.workspace.fs.createDirectory(directory);
    await writeJsonAtomic(vscode.Uri.joinPath(directory, `${input.subagentId}.${id}.diagnostic.json`), payload);
    return { id, kind: input.kind, sizeBytes, expiresAt };
  }

  public async readDiagnostic(input: {
    parentSessionId: string;
    subagentId: string;
    diagnosticId: string;
  }): Promise<Record<string, unknown> | undefined> {
    if (!isSafeId(input.parentSessionId) || !isSafeId(input.subagentId) || !isSafeId(input.diagnosticId)) return undefined;
    try {
      const uri = vscode.Uri.joinPath(this.getParentDirectory(input.parentSessionId), `${input.subagentId}.${input.diagnosticId}.diagnostic.json`);
      const value: unknown = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(uri)));
      if (!isRecord(value) || value.id !== input.diagnosticId || value.subagentId !== input.subagentId
        || typeof value.expiresAt !== 'string') return undefined;
      if (Date.parse(value.expiresAt) <= Date.now()) {
        await Promise.resolve(vscode.workspace.fs.delete(uri, { useTrash: false })).catch(() => undefined);
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private getParentDirectory(parentSessionId: string): vscode.Uri {
    if (!isSafeId(parentSessionId)) {
      throw new Error('Invalid parent session id for subagent storage.');
    }
    return vscode.Uri.joinPath(this.rootUri, parentSessionId);
  }

  private getMetadataUri(parentSessionId: string, subagentId: string): vscode.Uri {
    if (!isSafeId(subagentId)) {
      throw new Error('Invalid subagent id.');
    }
    return vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.meta.json`);
  }

  private getTranscriptUri(parentSessionId: string, subagentId: string): vscode.Uri {
    if (!isSafeId(subagentId)) {
      throw new Error('Invalid subagent id.');
    }
    return vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.transcript.json`);
  }

  private async runFileExists(parentSessionId: string, subagentId: string): Promise<boolean> {
    if (!isSafeId(parentSessionId) || !isSafeId(subagentId)) return false;
    try {
      await Promise.resolve(vscode.workspace.fs.stat(vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.state.json`))).catch(async error => {
        if (!isMissing(error)) throw error;
        try { await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.run.json`)); }
        catch (legacyError) { if (!isMissing(legacyError)) throw legacyError;
          await vscode.workspace.fs.stat(this.getMetadataUri(parentSessionId, subagentId)); }
      });
      return true;
    } catch { return false; }
  }
}

export function activityFromMetadata(metadata: StoredSubagentMetadata): SubagentActivity {
  return { id: metadata.id, parentSessionId: metadata.parentSessionId, parentRunId: metadata.parentRunId,
    rootRunId: metadata.rootRunId, treeId: metadata.treeId, profile: metadata.profile, lane: metadata.lane,
    status: metadata.status, sourceId: metadata.sourceId, modelId: metadata.modelId, provider: metadata.provider,
    updatedAt: metadata.updatedAt, reused: Boolean(metadata.reusedFromSubagentId),
    interrupted: metadata.failureKind === 'interrupted' };
}
function copyActivity(value: SubagentActivity): SubagentActivity {
  return { id: value.id, parentSessionId: value.parentSessionId, parentRunId: value.parentRunId, rootRunId: value.rootRunId,
    treeId: value.treeId, profile: value.profile, lane: value.lane, status: value.status, sourceId: value.sourceId,
    modelId: value.modelId, provider: value.provider, updatedAt: value.updatedAt, reused: value.reused === true,
    interrupted: value.interrupted === true };
}
function validActivity(value: unknown, parentSessionId: string, id: string): value is SubagentActivity {
  return isRecord(value) && value.id === id && value.parentSessionId === parentSessionId
    && typeof value.parentRunId === 'string' && isSafeId(value.parentRunId)
    && typeof value.treeId === 'string' && isSafeId(value.treeId)
    && typeof value.rootRunId === 'string' && isSafeId(value.rootRunId)
    && typeof value.profile === 'string' && typeof value.lane === 'string'
    && typeof value.status === 'string' && ['queued', 'running', 'completed', 'failed', 'stopped'].includes(value.status)
    && typeof value.updatedAt === 'string';
}
function isMissing(error: unknown): boolean {
  return ['FileNotFound', 'ENOENT'].includes(String((error as { code?: string })?.code));
}

function normalizeMetadata(value: unknown): StoredSubagentMetadata | undefined {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || typeof value.id !== 'string'
    || typeof value.parentSessionId !== 'string'
    || typeof value.status !== 'string' || !['queued', 'running', 'completed', 'failed', 'stopped'].includes(value.status)
    || value.hostContextHash !== undefined && (typeof value.hostContextHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.hostContextHash))
    || value.resultStatus !== undefined && !['complete', 'partial', 'failed'].includes(String(value.resultStatus))
    || value.resultFormatAccepted !== undefined && typeof value.resultFormatAccepted !== 'boolean'
    || value.resultContractVersion !== undefined && value.resultContractVersion !== 2) {
    return undefined;
  }
  const interrupted = value.status === 'running' || value.status === 'queued';
  return {
    ...value,
    status: interrupted ? 'stopped' : value.status,
    ...(interrupted ? {
      resultStatus: 'failed',
      failureKind: 'interrupted',
      error: typeof value.error === 'string' && value.error.trim()
        ? value.error
        : 'Subagent was interrupted by extension restart.'
    } : {}),
    stats: normalizeSubagentRunUsageSummaryValue(value.stats)
  } as unknown as StoredSubagentMetadata;
}

function normalizeTranscript(value: unknown): StoredSubagentTranscript | undefined {
  if (!isRecord(value)
    || (value.version !== 1 && value.version !== 2)
    || typeof value.metadataId !== 'string'
    || typeof value.contextInstructions !== 'string'
    || !Array.isArray(value.messages)
    || typeof value.result !== 'string') {
    return undefined;
  }
  return {
    ...value,
    ...(typeof value.resultRef === 'string' && isSafeId(value.resultRef) ? { resultRef: value.resultRef } : {}),
    checkpoint: normalizeRunCheckpoint(value.checkpoint)
  } as unknown as StoredSubagentTranscript;
}

function isUtf8ContinuationByte(value: number): boolean { return (value & 0xc0) === 0x80; }

function manifestStatus(metadata: ResultIndexMetadata): string {
  if (metadata.failureKind === 'budget_exhausted') return 'budget_exhausted';
  if (metadata.failureKind === 'cancelled') return 'cancelled';
  return metadata.status;
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value) && value !== '.' && value !== '..';
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.floor(value)))
    : fallback;
}

function sanitizeDiagnosticText(value: string, maxChars: number): string {
  return value
    .replace(/(?:api[-_ ]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/giu, 'credential=[redacted]')
    .replace(/\b[A-Z][A-Z0-9_]{1,63}=\S+/gu, 'environment=[redacted]')
    .replace(/[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\){2,}[^\\/:*?"<>|\r\n]*/gu, '[path redacted]')
    .replace(/(?:\/[A-Za-z0-9._ -]+){3,}/gu, '[path redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxChars);
}

interface ResultSource { metadata: ResultIndexMetadata; canonical?: SubagentResultIndex['canonical']; result?: string; resultRef?: string; }
