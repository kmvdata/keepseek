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
        await store.save(snapshot, { version: 1, activity: summary, stats }, {
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
        const session = await new SessionObjectStore(uri).load(manifest) as unknown as {
          subagentMetadata: unknown; subagentTranscript: Omit<StoredSubagentTranscript, 'messages'>; messages: StoredSubagentTranscript['messages'] };
        const metadata = normalizeMetadata(session.subagentMetadata);
        const transcript = normalizeTranscript({ ...session.subagentTranscript,
          messages: (session.subagentTranscript as StoredSubagentTranscript).messages ?? session.messages });
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
    const stored = await this.read(input.parentSessionId, ref);
    if (!stored) {
      return {
        ok: false,
        errorType: await this.runFileExists(input.parentSessionId, ref)
          ? 'subagent_result_corrupt' : 'subagent_result_not_found',
        error: 'The requested subagent result is unavailable in this session lineage.'
      };
    }
    if (input.allowedTreeId && stored.metadata.treeId !== input.allowedTreeId) {
      return { ok: false, errorType: 'subagent_result_forbidden', error: 'The result reference is outside the current subagent tree.' };
    }
    if (stored.metadata.status === 'queued'
      || stored.metadata.status === 'running'
      || stored.metadata.failureKind === 'interrupted') {
      return {
        ok: false,
        ref,
        status: stored.metadata.status,
        errorType: 'subagent_result_pending',
        error: 'The referenced subagent result is not complete yet.'
      };
    }
    const result = await this.readCanonicalResult(input.parentSessionId, stored);
    if (result === undefined) {
      return { ok: false, ref, errorType: 'subagent_result_corrupt', error: 'The canonical stored result reference is invalid.' };
    }
    if (stored.metadata.resultHash
      && createHash('sha256').update(result, 'utf8').digest('hex') !== stored.metadata.resultHash) {
      return { ok: false, ref, errorType: 'subagent_result_corrupt', error: 'The stored result failed its integrity check.' };
    }
    if (legacy) {
      const offset = clampInteger(input.offset, 0, result.length, 0);
      const maxChars = clampInteger(input.maxChars, 1, MAX_SUBAGENT_RESULT_PAGE_CHARS, DEFAULT_SUBAGENT_RESULT_PAGE_CHARS);
      const content = result.slice(offset, offset + maxChars);
      const nextOffset = offset + content.length;
      return {
        ok: true,
        subagentId: stored.metadata.id,
        status: manifestStatus(stored.metadata),
        profile: stored.metadata.profile,
        lane: stored.metadata.lane,
        offset,
        content,
        totalChars: result.length,
        hasMore: nextOffset < result.length,
        ...(nextOffset < result.length ? { nextOffset } : {}),
        resultHash: stored.metadata.resultHash,
        usage: stored.metadata.usage
      };
    }
    const bytes = this.encoder.encode(result);
    const offsetBytes = clampInteger(input.offsetBytes, 0, Number.MAX_SAFE_INTEGER, 0);
    if (offsetBytes > bytes.byteLength) {
      return { ok: false, ref, errorType: 'subagent_result_offset_out_of_range', offsetBytes, totalBytes: bytes.byteLength,
        error: 'The requested byte offset is beyond the stored result.' };
    }
    if (offsetBytes < bytes.byteLength && isUtf8ContinuationByte(bytes[offsetBytes]!)) {
      return { ok: false, ref, errorType: 'subagent_result_invalid_utf8_offset', offsetBytes,
        error: 'The requested byte offset is not a UTF-8 character boundary.' };
    }
    const limitBytes = clampInteger(input.limitBytes, 4, MAX_SUBAGENT_RESULT_PAGE_BYTES, DEFAULT_SUBAGENT_RESULT_PAGE_BYTES);
    let end = Math.min(bytes.byteLength, offsetBytes + limitBytes);
    while (end > offsetBytes && end < bytes.byteLength && isUtf8ContinuationByte(bytes[end]!)) end -= 1;
    const content = this.decoder.decode(bytes.slice(offsetBytes, end));
    const returnedBytes = end - offsetBytes;
    const hasMore = end < bytes.byteLength;
    return {
      ok: true,
      ref,
      status: manifestStatus(stored.metadata),
      profile: stored.metadata.profile,
      lane: stored.metadata.lane,
      content,
      offsetBytes,
      returnedBytes,
      ...(hasMore ? { nextOffsetBytes: end } : {}),
      totalBytes: bytes.byteLength,
      hasMore,
      resultHash: stored.metadata.resultHash ?? createHash('sha256').update(result, 'utf8').digest('hex'),
      resultTruncated: stored.metadata.resultTruncated === true
    };
  }

  public async readCanonicalResult(
    parentSessionId: string,
    initial: { metadata: StoredSubagentMetadata; transcript: StoredSubagentTranscript }
  ): Promise<string | undefined> {
    let current = initial;
    const visited = new Set<string>();
    for (let depth = 0; depth < 4; depth += 1) {
      if (current.transcript.result) return current.transcript.result;
      const ref = current.transcript.resultRef ?? current.metadata.reusedFromSubagentId;
      if (!ref || visited.has(ref)) return current.transcript.resultRef ? undefined : '';
      visited.add(ref);
      const next = await this.read(parentSessionId, ref);
      if (!next) return undefined;
      current = next;
    }
    return undefined;
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
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.run.json`));
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
    || typeof value.status !== 'string') {
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

function manifestStatus(metadata: StoredSubagentMetadata): string {
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
