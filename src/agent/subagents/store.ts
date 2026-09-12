import { writeJsonAtomic } from '../../shared/atomicStorage';
import { normalizeRunCheckpoint } from '../runCheckpoint';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { isRecord } from '../../shared/errors';
import { normalizeSubagentRunUsageSummaryValue } from '../subagentUsageStats';
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
export const DEFAULT_SUBAGENT_RESULT_PAGE_CHARS = 12_000;
export const MAX_SUBAGENT_RESULT_PAGE_CHARS = 24_000;

export class SubagentStore {
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly rootUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(globalStorageUri: vscode.Uri, workspaceKey: string) {
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
    const directory = this.getParentDirectory(metadata.parentSessionId);
    await vscode.workspace.fs.createDirectory(directory);
    const snapshot = structuredClone({ version: 1, metadata, transcript });
    const write = this.persistenceQueue.catch(() => undefined).then(() => writeJsonAtomic(vscode.Uri.joinPath(directory, `${metadata.id}.run.json`), snapshot));
    this.persistenceQueue = write;
    await write;
  }

  public async read(parentSessionId: string, subagentId: string): Promise<{
    metadata: StoredSubagentMetadata;
    transcript: StoredSubagentTranscript;
  } | undefined> {
    if (!isSafeId(parentSessionId) || !isSafeId(subagentId)) {
      return undefined;
    }
    try {
      try {
        const data = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.getParentDirectory(parentSessionId), `${subagentId}.run.json`)
        ))) as { metadata?: unknown; transcript?: unknown };
        const metadata = normalizeMetadata(data.metadata);
        const transcript = normalizeTranscript(data.transcript);
        if (metadata && transcript && transcript.metadataId === metadata.id) return { metadata, transcript };
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
      if (!metadata || !transcript || transcript.metadataId !== metadata.id) {
        return undefined;
      }
      return { metadata, transcript };
    } catch {
      return undefined;
    }
  }

  public async readResultPage(input: {
    parentSessionId: string;
    subagentId: string;
    offset?: number;
    maxChars?: number;
  }): Promise<Record<string, unknown>> {
    const stored = await this.read(input.parentSessionId, input.subagentId);
    if (!stored) {
      return { ok: false, errorType: 'subagent_not_found', error: 'The requested subagent result was not found in this parent session.' };
    }
    const result = stored.transcript.result;
    const offset = clampInteger(input.offset, 0, result.length, 0);
    const maxChars = clampInteger(
      input.maxChars,
      1,
      MAX_SUBAGENT_RESULT_PAGE_CHARS,
      DEFAULT_SUBAGENT_RESULT_PAGE_CHARS
    );
    const content = result.slice(offset, offset + maxChars);
    const nextOffset = offset + content.length;
    return {
      ok: true,
      subagentId: stored.metadata.id,
      status: stored.metadata.status,
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
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith('.run.json'))
      .map(([name]) => name.slice(0, -'.run.json'.length))
      .filter((id) => id !== input.excludeSubagentId)
      .slice(-64);
    const candidates = (await Promise.all(ids.map(async (id) => await this.read(input.parentSessionId, id))))
      .filter((value): value is { metadata: StoredSubagentMetadata; transcript: StoredSubagentTranscript } => Boolean(value))
      .filter(({ metadata }) => metadata.status === 'completed'
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
        && Boolean(metadata.resultEnvelope));
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
}

function normalizeMetadata(value: unknown): StoredSubagentMetadata | undefined {
  if (!isRecord(value)
    || value.version !== 1
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
    || value.version !== 1
    || typeof value.metadataId !== 'string'
    || typeof value.contextInstructions !== 'string'
    || !Array.isArray(value.messages)
    || typeof value.result !== 'string') {
    return undefined;
  }
  return { ...value, checkpoint: normalizeRunCheckpoint(value.checkpoint) } as unknown as StoredSubagentTranscript;
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
