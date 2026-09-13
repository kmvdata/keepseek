import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../../shared/atomicStorage';
import { estimateTokenCount } from '../tokenEstimate';
import type {
  EvidenceIntentInput,
  EvidenceReadInput,
  ToolEvidence,
  ToolEvidenceContentType,
  ToolEvidenceSource
} from './types';

const EVIDENCE_VERSION_DIR = 'v1';
export const DEFAULT_EVIDENCE_PAGE_CHARS = 12_000;
export const MAX_EVIDENCE_PAGE_CHARS = 48_000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,160}$/u;
const TEXT_SURFACE_KEYS = ['content', 'result', 'diff', 'patch', 'output', 'text', 'stdout', 'stderr'] as const;

export class ToolEvidencePersistenceError extends Error {
  public constructor(public readonly reason: 'storage_failure' | 'resource_limit', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolEvidencePersistenceError';
  }
}

export class ToolEvidenceStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly records = new Map<string, ToolEvidence>();
  private readonly memoryBlobs = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly globalStorageUri?: vscode.Uri,
    private readonly maxEvidenceBytes = 100_000_000
  ) {}

  public createEvidenceId(input: Pick<EvidenceIntentInput, 'sessionId' | 'taskId' | 'toolCallId' | 'epochIndex'>): string {
    return `ev_${createHash('sha256').update(`${input.sessionId}\0${input.taskId}\0${input.epochIndex ?? 0}\0${input.toolCallId}`, 'utf8').digest('hex').slice(0, 40)}`;
  }

  public async ensureIntent(input: EvidenceIntentInput): Promise<ToolEvidence> {
    this.assertScope(input.sessionId, input.taskId, input.toolCallId);
    const id = this.createEvidenceId(input);
    const existing = await this.readRecord(input.sessionId, input.taskId, id);
    if (existing) {
      if (existing.toolCallId !== input.toolCallId || existing.toolName !== input.toolName
        || existing.argumentsHash !== input.argumentsHash) {
        throw new Error('Tool evidence intent binding mismatch.');
      }
      return existing;
    }
    const now = new Date().toISOString();
    const evidenceRef = `${id}.${createHash('sha256').update(`${input.sessionId}\0${input.taskId}\0${id}`).digest('hex').slice(0, 24)}`;
    const record: ToolEvidence = {
      version: 1,
      id,
      evidenceRef,
      sessionId: input.sessionId,
      taskId: input.taskId,
      epochIndex: input.epochIndex ?? 0,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      argumentsHash: input.argumentsHash,
      effectKind: input.effectKind,
      executionStatus: 'pending',
      deliveryStatus: 'pending',
      createdAt: now,
      updatedAt: now
    };
    await this.writeRecord(record);
    return record;
  }

  public async markExecuting(record: ToolEvidence): Promise<ToolEvidence> {
    if (record.executionStatus === 'completed') return record;
    return await this.update(record, { executionStatus: 'executing' });
  }

  public async markUncertain(record: ToolEvidence): Promise<ToolEvidence> {
    if (record.executionStatus === 'completed') return record;
    return await this.update(record, { executionStatus: 'uncertain' });
  }

  public async resetReplayableIntent(record: ToolEvidence): Promise<ToolEvidence> {
    if (!['read', 'proposal'].includes(record.effectKind) || record.executionStatus === 'completed') return record;
    return await this.update(record, { executionStatus: 'pending' });
  }

  public async complete(
    record: ToolEvidence,
    content: string,
    metadata: { contentType?: ToolEvidenceContentType; source?: ToolEvidenceSource } = {}
  ): Promise<ToolEvidence> {
    if (record.executionStatus === 'completed') {
      const hash = hashText(content);
      if (record.contentHash !== hash) throw new Error('Completed tool evidence cannot be rewritten.');
      return record;
    }
    const bytes = this.encoder.encode(content);
    if (bytes.byteLength > this.maxEvidenceBytes) {
      throw new ToolEvidencePersistenceError('resource_limit',
        `Tool evidence exceeds the configured storage limit (${this.maxEvidenceBytes} bytes).`);
    }
    const contentHash = hashText(content);
    const blobName = `${contentHash}.blob`;
    await this.writeBlob(record.sessionId, record.taskId, blobName, bytes);
    return await this.update(record, {
      executionStatus: 'completed',
      contentHash,
      contentType: metadata.contentType ?? inferContentType(record.toolName, content),
      totalChars: content.length,
      totalBytes: bytes.byteLength,
      totalTokensEstimate: estimateTokenCount(content),
      source: metadata.source,
      storageKind: 'blob',
      blobName
    });
  }

  public async saveProviderEnvelope(record: ToolEvidence, envelope: string, completeInline: boolean, source?: ToolEvidenceSource): Promise<ToolEvidence> {
    if (record.executionStatus !== 'completed') throw new Error('Cannot prepare an envelope before evidence is complete.');
    if (record.providerEnvelope !== undefined) {
      if (record.providerEnvelope !== envelope) throw new Error('Provider-visible evidence bytes are immutable.');
      return record;
    }
    return await this.update(record, {
      providerEnvelope: envelope,
      completeInline,
      source: source ?? record.source,
      deliveryStatus: 'envelope_ready'
    });
  }

  public async markSending(record: ToolEvidence): Promise<ToolEvidence> {
    if (!record.providerEnvelope) throw new Error('Evidence envelope is not ready.');
    if (record.deliveryStatus === 'delivered') return record;
    return await this.update(record, { deliveryStatus: 'sending' });
  }

  public async markDelivered(record: ToolEvidence): Promise<ToolEvidence> {
    if (!record.providerEnvelope) throw new Error('Evidence envelope is not ready.');
    return await this.update(record, { deliveryStatus: 'delivered' });
  }

  public async findByToolCall(sessionId: string, taskId: string, toolCallId: string, epochIndex = 0): Promise<ToolEvidence | undefined> {
    return await this.readRecord(sessionId, taskId, this.createEvidenceId({ sessionId, taskId, toolCallId, epochIndex }));
  }

  public async findByRef(ref: string, sessionId: string, taskId: string): Promise<ToolEvidence | undefined> {
    return await this.resolveRef(ref, sessionId, taskId);
  }

  public async readContent(record: ToolEvidence): Promise<string> {
    if (record.executionStatus !== 'completed' || !record.blobName) throw new Error('Tool evidence content is unavailable.');
    const memory = this.memoryBlobs.get(this.blobKey(record.sessionId, record.taskId, record.blobName));
    if (memory !== undefined) return memory;
    if (!this.globalStorageUri) throw new Error('Tool evidence blob is unavailable.');
    return this.decoder.decode(await vscode.workspace.fs.readFile(this.getBlobUri(record.sessionId, record.taskId, record.blobName)));
  }

  public async read(input: EvidenceReadInput): Promise<Record<string, unknown>> {
    const record = await this.resolveRef(input.evidenceRef, input.sessionId, input.taskId);
    if (!record || record.executionStatus !== 'completed' || !record.contentHash) {
      return { ok: false, errorType: 'evidence_not_found', error: 'Evidence was not found in this session and task.' };
    }
    const maxChars = clampInt(input.maxChars, 1, MAX_EVIDENCE_PAGE_CHARS, DEFAULT_EVIDENCE_PAGE_CHARS);
    if (input.startLine !== undefined || input.endLine !== undefined) {
      return await this.readLines(record, input.startLine, input.endLine, maxChars);
    }
    if (input.itemOffset !== undefined || input.itemLimit !== undefined) {
      return await this.readItems(record, input.itemOffset, input.itemLimit, maxChars);
    }
    if (input.search?.trim()) {
      return await this.search(record, input.search.trim(), maxChars, input.cursor);
    }
    const offset = input.cursor ? parseCursor(input.cursor) : clampInt(input.offset, 0, record.totalBytes ?? 0, 0);
    return await this.readBytePage(record, offset, maxChars);
  }

  public async saveEpochSnapshot(sessionId: string, taskId: string, index: number, snapshot: unknown): Promise<string> {
    this.assertScope(sessionId, taskId, String(index));
    const name = `epoch-${index}.json`;
    if (!this.globalStorageUri) return name;
    try {
      await writeJsonAtomic(vscode.Uri.joinPath(this.getTaskDirectory(sessionId, taskId), name), snapshot);
    } catch (error) {
      throw new ToolEvidencePersistenceError('storage_failure', 'Context Epoch evidence snapshot could not be persisted.', { cause: error });
    }
    return name;
  }

  /** Session retention owns evidence retention. Call only after the session has
   * been selected for deletion; active/checkpoint-protected sessions must never
   * reach this method. */
  public async deleteSessionEvidence(sessionId: string): Promise<void> {
    if (!sessionId.trim()) return;
    for (const key of [...this.records.keys()]) if (key.startsWith(`${sessionId}\0`)) this.records.delete(key);
    for (const key of [...this.memoryBlobs.keys()]) if (key.startsWith(`${sessionId}\0`)) this.memoryBlobs.delete(key);
    if (!this.globalStorageUri) return;
    await Promise.resolve(vscode.workspace.fs.delete(
      vscode.Uri.joinPath(this.getRootUri(), safeHash(sessionId)),
      { recursive: true, useTrash: false }
    )).catch((error) => {
      const code = (error as { code?: string }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT') throw error;
    });
  }

  private async resolveRef(ref: string, sessionId: string, taskId: string): Promise<ToolEvidence | undefined> {
    const [id] = ref.split('.', 1);
    if (!id || !SAFE_ID.test(id)) return undefined;
    const record = await this.readRecord(sessionId, taskId, id);
    return record?.evidenceRef === ref && record.sessionId === sessionId && record.taskId === taskId ? record : undefined;
  }

  private async readBytePage(record: ToolEvidence, offset: number, maxChars: number): Promise<Record<string, unknown>> {
    const totalBytes = record.totalBytes ?? 0;
    const start = Math.min(Math.max(0, offset), totalBytes);
    let pageStart = start;
    let content: string;
    let consumedBytes: number;
    if (this.globalStorageUri?.scheme === 'file' && record.blobName) {
      const handle = await open(this.getBlobUri(record.sessionId, record.taskId, record.blobName).fsPath, 'r');
      try {
        if (pageStart > 0 && pageStart < totalBytes) {
          const probe = Buffer.alloc(Math.min(4, totalBytes - pageStart));
          const probeRead = await handle.read(probe, 0, probe.length, pageStart);
          let skipped = 0;
          while (skipped < probeRead.bytesRead && (probe[skipped] & 0xC0) === 0x80) skipped += 1;
          pageStart += skipped;
        }
        const buffer = Buffer.alloc(Math.min(totalBytes - pageStart, maxChars * 4 + 4));
        const read = await handle.read(buffer, 0, buffer.length, pageStart);
        const decoded = decodeUtf8Prefix(buffer.subarray(0, read.bytesRead), maxChars);
        content = decoded.text;
        consumedBytes = decoded.bytes;
      } finally {
        await handle.close();
      }
    } else {
      const full = await this.readContent(record);
      const location = start === 0 ? { charOffset: 0, byteOffset: 0 } : utf8ByteOffsetToNextCharOffset(full, start);
      pageStart = location.byteOffset;
      content = sliceWithoutSplittingSurrogate(full, location.charOffset, maxChars);
      consumedBytes = this.encoder.encode(content).byteLength;
    }
    const next = pageStart + consumedBytes;
    return this.pageEnvelope(record, {
      mode: 'bytes',
      cursor: `b:${pageStart}`,
      content,
      hasMore: next < totalBytes,
      ...(next < totalBytes ? { nextCursor: `b:${next}` } : {})
    });
  }

  private async readLines(record: ToolEvidence, rawStart: number | undefined, rawEnd: number | undefined, maxChars: number): Promise<Record<string, unknown>> {
    const surface = extractTextSurface(await this.readContent(record), record.source?.startLine);
    const lines = surface.text.split(/(?<=\n)/u);
    const lastLine = surface.startLine + Math.max(1, lines.length) - 1;
    const startLine = clampInt(rawStart, surface.startLine, lastLine, surface.startLine);
    const wantedEnd = clampInt(rawEnd, startLine, lastLine, Math.min(lastLine, startLine + 199));
    const selected: string[] = [];
    let chars = 0;
    let endLine = startLine - 1;
    for (let line = startLine; line <= wantedEnd; line += 1) {
      const value = lines[line - surface.startLine] ?? '';
      if (chars + value.length > maxChars) break;
      selected.push(value);
      chars += value.length;
      endLine = line;
      if (chars >= maxChars) break;
    }
    const lineTooLong = !selected.length && (lines[startLine - surface.startLine]?.length ?? 0) > maxChars;
    return this.pageEnvelope(record, {
      mode: 'lines', field: surface.field, startLine, endLine, content: selected.join(''),
      hasMore: endLine < lastLine,
      ...(lineTooLong ? {
        lineTooLong: true,
        hint: 'The next complete line exceeds maxChars; use byte cursor paging or search for a bounded excerpt.'
      } : {}),
      ...(endLine < lastLine ? { nextStartLine: endLine + 1 } : {})
    });
  }

  private async readItems(record: ToolEvidence, rawOffset: number | undefined, rawLimit: number | undefined, maxChars: number): Promise<Record<string, unknown>> {
    const text = await this.readContent(record);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch {
      return { ok: false, errorType: 'evidence_not_structured', error: 'Evidence is not valid structured JSON.' };
    }
    const located = locateArray(parsed);
    if (!located) return { ok: false, errorType: 'evidence_has_no_items', error: 'Evidence contains no pageable array.' };
    const offset = clampInt(rawOffset, 0, located.items.length, 0);
    const limit = clampInt(rawLimit, 1, 1_000, 100);
    const items: unknown[] = [];
    let chars = 2;
    for (const item of located.items.slice(offset, offset + limit)) {
      const size = JSON.stringify(item).length + 1;
      if (chars + size > maxChars) break;
      items.push(item);
      chars += size;
    }
    const next = offset + items.length;
    return this.pageEnvelope(record, {
      mode: 'items', itemKey: located.key, itemOffset: offset, items,
      totalItems: located.items.length, hasMore: next < located.items.length,
      ...(!items.length && offset < located.items.length ? {
        itemTooLarge: true,
        hint: 'The next complete item exceeds maxChars; use byte cursor paging or search.'
      } : {}),
      ...(next < located.items.length ? { nextItemOffset: next } : {})
    });
  }

  private async search(record: ToolEvidence, query: string, maxChars: number, cursor?: string): Promise<Record<string, unknown>> {
    const surface = extractTextSurface(await this.readContent(record), record.source?.startLine);
    const text = surface.text;
    const lower = text.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    const matches: Array<{ line: number; start: number; text: string }> = [];
    const start = parseSearchCursor(cursor);
    let from = Math.min(start, text.length);
    let chars = 0;
    let nextCursor: string | undefined;
    while (matches.length < 100) {
      const index = lower.indexOf(needle, from);
      if (index < 0) break;
      const lineStart = text.lastIndexOf('\n', index - 1) + 1;
      const lineEndValue = text.indexOf('\n', index);
      const lineEnd = lineEndValue < 0 ? text.length : lineEndValue;
      const excerpt = text.slice(lineStart, Math.min(lineEnd, lineStart + Math.min(1_000, maxChars)));
      if (matches.length && chars + excerpt.length > maxChars) { nextCursor = `s:${index}`; break; }
      matches.push({ line: surface.startLine + countNewlines(text, 0, lineStart), start: index, text: excerpt });
      chars += excerpt.length;
      from = index + Math.max(1, needle.length);
    }
    if (!nextCursor && matches.length >= 100 && lower.indexOf(needle, from) >= 0) nextCursor = `s:${from}`;
    return this.pageEnvelope(record, {
      mode: 'search', field: surface.field, query, cursor: `s:${start}`, matches, matchCount: matches.length,
      hasMore: Boolean(nextCursor), ...(nextCursor ? { nextCursor } : {})
    });
  }

  private pageEnvelope(record: ToolEvidence, payload: Record<string, unknown>): Record<string, unknown> {
    return {
      ok: true,
      evidenceRef: record.evidenceRef,
      contentHash: record.contentHash,
      totalChars: record.totalChars,
      totalBytes: record.totalBytes,
      contentType: record.contentType,
      ...payload
    };
  }

  private async update(record: ToolEvidence, patch: Partial<ToolEvidence>): Promise<ToolEvidence> {
    const current = await this.readRecord(record.sessionId, record.taskId, record.id) ?? record;
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() } as ToolEvidence;
    await this.writeRecord(next);
    return next;
  }

  private async writeRecord(record: ToolEvidence): Promise<void> {
    const snapshot = structuredClone(record);
    this.records.set(this.recordKey(record.sessionId, record.taskId, record.id), snapshot);
    if (!this.globalStorageUri) return;
    const write = this.queue.catch(() => undefined).then(async () => {
      await writeJsonAtomic(this.getRecordUri(record.sessionId, record.taskId, record.id), snapshot);
    });
    this.queue = write;
    try {
      await write;
    } catch (error) {
      throw new ToolEvidencePersistenceError('storage_failure', 'Tool evidence journal could not be persisted.', { cause: error });
    }
  }

  private async readRecord(sessionId: string, taskId: string, id: string): Promise<ToolEvidence | undefined> {
    const key = this.recordKey(sessionId, taskId, id);
    const cached = this.records.get(key);
    if (cached) return structuredClone(cached);
    if (!this.globalStorageUri || !SAFE_ID.test(id)) return undefined;
    try {
      const value: unknown = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(this.getRecordUri(sessionId, taskId, id))));
      if (!isToolEvidence(value) || value.sessionId !== sessionId || value.taskId !== taskId || value.id !== id) return undefined;
      this.records.set(key, value);
      return structuredClone(value);
    } catch { return undefined; }
  }

  private async writeBlob(sessionId: string, taskId: string, blobName: string, bytes: Uint8Array): Promise<void> {
    const key = this.blobKey(sessionId, taskId, blobName);
    if (!this.globalStorageUri) {
      if (!this.memoryBlobs.has(key)) this.memoryBlobs.set(key, this.decoder.decode(bytes));
      return;
    }
    const uri = this.getBlobUri(sessionId, taskId, blobName);
    try { await vscode.workspace.fs.stat(uri); return; } catch { /* create */ }
    const blobDirectory = vscode.Uri.joinPath(this.getTaskDirectory(sessionId, taskId), 'blobs');
    const temporary = vscode.Uri.joinPath(blobDirectory, `.keepseek-${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(blobDirectory);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: false });
    } catch (error) {
      try { await vscode.workspace.fs.stat(uri); }
      catch {
        throw new ToolEvidencePersistenceError('storage_failure', 'Tool evidence blob could not be persisted.', { cause: error });
      }
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).catch(() => undefined);
    }
  }

  private getRootUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri!, 'chat-sessions', EVIDENCE_VERSION_DIR, 'evidence');
  }

  private getTaskDirectory(sessionId: string, taskId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getRootUri(), safeHash(sessionId), safeHash(taskId));
  }

  private getRecordUri(sessionId: string, taskId: string, id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getTaskDirectory(sessionId, taskId), `${id}.json`);
  }

  private getBlobUri(sessionId: string, taskId: string, blobName: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getTaskDirectory(sessionId, taskId), 'blobs', blobName);
  }

  private recordKey(sessionId: string, taskId: string, id: string): string { return `${sessionId}\0${taskId}\0${id}`; }
  private blobKey(sessionId: string, taskId: string, name: string): string { return `${sessionId}\0${taskId}\0${name}`; }

  private assertScope(sessionId: string, taskId: string, childId: string): void {
    if (!sessionId.trim() || !taskId.trim() || !childId.trim()) throw new Error('Invalid evidence scope.');
  }
}

function hashText(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function safeHash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32); }
function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}
function parseCursor(value: string): number {
  const match = /^b:(\d+)$/u.exec(value.trim());
  return match ? Number(match[1]) : 0;
}
function parseSearchCursor(value: string | undefined): number {
  const match = /^s:(\d+)$/u.exec(value?.trim() ?? '');
  return match ? Number(match[1]) : 0;
}
function decodeUtf8Prefix(bytes: Uint8Array, maxChars: number): { text: string; bytes: number } {
  let end = bytes.length;
  while (end > 0) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
      const selected = sliceWithoutSplittingSurrogate(text, 0, maxChars);
      return { text: selected, bytes: new TextEncoder().encode(selected).byteLength };
    } catch { end -= 1; }
  }
  return { text: '', bytes: 0 };
}
function sliceWithoutSplittingSurrogate(text: string, start: number, maxChars: number): string {
  let end = Math.min(text.length, start + maxChars);
  if (end > start && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const next = text.charCodeAt(end);
    if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end -= 1;
  }
  if (end === start && start < text.length) {
    const first = text.charCodeAt(start);
    end = first >= 0xD800 && first <= 0xDBFF ? Math.min(text.length, start + 2) : start + 1;
  }
  return text.slice(start, end);
}
function utf8ByteOffsetToNextCharOffset(text: string, offset: number): { charOffset: number; byteOffset: number } {
  let bytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes === offset) return { charOffset: index, byteOffset: bytes };
    if (bytes + size > offset) return { charOffset: index + character.length, byteOffset: bytes + size };
    bytes += size;
    index += character.length;
  }
  return { charOffset: text.length, byteOffset: bytes };
}
function countNewlines(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = start; index < end; index += 1) if (text.charCodeAt(index) === 10) count += 1;
  return count;
}
function extractTextSurface(raw: string, fallbackStartLine?: number): { text: string; startLine: number; field: string } {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of TEXT_SURFACE_KEYS) {
        if (typeof record[key] === 'string') {
          const declaredStart = typeof record.startLine === 'number' && Number.isSafeInteger(record.startLine) && record.startLine > 0
            ? record.startLine
            : undefined;
          return { text: record[key] as string, startLine: declaredStart ?? fallbackStartLine ?? 1, field: key };
        }
      }
    }
  } catch { /* raw text surface */ }
  return { text: raw, startLine: fallbackStartLine ?? 1, field: '$' };
}
function locateArray(value: unknown): { key: string; items: unknown[] } | undefined {
  if (Array.isArray(value)) return { key: '$', items: value };
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['results', 'items', 'files', 'entries', 'symbols', 'references', 'findings', 'diagnostics', 'evidence', 'idempotency']) {
    if (Array.isArray(record[key])) return { key, items: record[key] as unknown[] };
  }
  return undefined;
}
function inferContentType(toolName: string, content: string): ToolEvidenceContentType {
  if (/diff|patch/iu.test(toolName)) return 'diff';
  if (/diagnostic/iu.test(toolName)) return 'diagnostics';
  try {
    const parsed: unknown = JSON.parse(content);
    return locateArray(parsed) ? 'structured' : 'json';
  } catch { return 'text'; }
}
function isToolEvidence(value: unknown): value is ToolEvidence {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ToolEvidence>;
  return item.version === 1 && typeof item.id === 'string' && typeof item.evidenceRef === 'string'
    && typeof item.sessionId === 'string' && typeof item.taskId === 'string'
    && typeof item.toolCallId === 'string' && typeof item.toolName === 'string'
    && typeof item.argumentsHash === 'string' && typeof item.executionStatus === 'string'
    && typeof item.deliveryStatus === 'string';
}
