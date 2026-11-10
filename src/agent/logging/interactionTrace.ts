import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatLocalTimestamp } from '../../shared/format';
import { withPerformanceTrace, withOwnedTraceWrite, traceOwnerIndexUri, type TraceOwnership } from './performanceTrace';
import { SessionDeletionAuthority } from '../../sessions/sessionDeletionAuthority';
import { assertManagedStoragePath, readAssociatedJson, deleteAssociatedUri, isMissingAssociatedFile } from '../../sessions/sessionAssociatedPersistence';
import { getRuntimeIdentity } from '../../shared/runtimeIdentity';
import {
  getConfiguredInteractionTraceSettings,
  type InteractionTraceLevel,
  type InteractionTraceSettings
} from '../../shared/config';
import type {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekToolCall
} from '../deepseek/types';

const TRACE_ROOT_DIR = 'interaction-logs';
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface InteractionTraceEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentInteractionTrace {
  readonly runId: string;
  readonly logUri?: string;
  readonly enabled: boolean;
  readonly level: InteractionTraceLevel;
  readonly logRawStream: boolean;
  includesPayload(level: 'request' | 'full'): boolean;
  record(event: InteractionTraceEvent): void;
  flush(): Promise<void>;
  close?(): Promise<void>;
}

export type InteractionTraceEventSink = (event: InteractionTraceEvent, timestamp: string) => void;

export class InteractionTraceLogService {
  private lastRunTraceLogUri: string | undefined;
  private readonly scopedRuns = new Map<string, TraceOwnership | undefined>();

  public constructor(private readonly globalStorageUri: vscode.Uri) {}

  public createRunTrace(eventSink?: InteractionTraceEventSink, scope?: { sessionId?: string; taskId?: string }): AgentInteractionTrace {
    const settings = getConfiguredInteractionTraceSettings();
    if (!settings.enabled) {
      this.lastRunTraceLogUri = undefined;
      return createNoopInteractionTrace(eventSink);
    }

    const runId = randomUUID();
    const now = new Date();
    const day = formatLocalTimestamp(now).slice(0, 10);
    const fileName = `run-${formatTimestampForFile(now)}-${runId}.jsonl`;
    const fileUri = vscode.Uri.joinPath(this.globalStorageUri, TRACE_ROOT_DIR, day, fileName);
    void this.cleanupExpiredLogs(settings);
    const owner = scope?.sessionId ? { root: this.globalStorageUri, sessionId: scope.sessionId } : undefined;
    this.scopedRuns.set(runId, owner);
    if (this.scopedRuns.size > 1000) this.scopedRuns.delete(this.scopedRuns.keys().next().value!);

    if (fileUri.scheme === 'file') {
      const trace = new JsonlInteractionTrace(runId, fileUri.fsPath, settings, eventSink, owner);
      this.lastRunTraceLogUri = trace.logUri;
      return this.attachRuntimeIdentity(withPerformanceTrace(trace, fileUri, scope, owner));
    }

    const trace = new WorkspaceFsJsonlInteractionTrace(runId, fileUri, settings, eventSink, owner);
    this.lastRunTraceLogUri = trace.logUri;
    return this.attachRuntimeIdentity(withPerformanceTrace(trace, fileUri, scope, owner));
  }

  private attachRuntimeIdentity(trace: AgentInteractionTrace): AgentInteractionTrace {
    const identity = getRuntimeIdentity();
    if (identity) trace.record({ type: 'run_runtime', ...identity });
    return trace;
  }

  public getLastRunTraceLogUri(): string | undefined {
    return this.lastRunTraceLogUri;
  }

  public async appendRunEvent(
    traceLog: { runId: string; uri: string } | undefined,
    event: InteractionTraceEvent
  ): Promise<void> {
    if (!traceLog?.uri || traceLog.runId === 'disabled') {
      return;
    }
    const settings = getConfiguredInteractionTraceSettings();
    if (!settings.enabled) {
      return;
    }
    const line = `${safeJsonStringify({
      ts: formatLocalTimestamp(),
      runId: traceLog.runId,
      external: true,
      ...event
    })}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      const uri = vscode.Uri.parse(traceLog.uri);
      const knownRun = this.scopedRuns.has(traceLog.runId);
      const storedOwner = knownRun ? undefined : await readAssociatedJson(vscode.Uri.parse(`${uri.toString()}.owner.json`));
      const owner = knownRun ? this.scopedRuns.get(traceLog.runId) : storedOwner?.version === 1
        && typeof storedOwner.sessionId === 'string' && storedOwner.runId === traceLog.runId
        ? { root: this.globalStorageUri, sessionId: storedOwner.sessionId } : undefined;
      if (storedOwner && !owner) return;
      await withOwnedTraceWrite(uri, traceLog.runId, owner, async () => {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size + bytes > settings.maxFileBytes) {
        return;
      }
      if (uri.scheme === 'file') {
        await appendFile(uri.fsPath, line, 'utf8');
        return;
      }
      const previous = await vscode.workspace.fs.readFile(uri);
      const next = new Uint8Array(previous.byteLength + bytes);
      next.set(previous, 0);
      next.set(new TextEncoder().encode(line), previous.byteLength);
      await vscode.workspace.fs.writeFile(uri, next);
      });
    } catch {
      // Post-run trace updates are best-effort and must never block apply or revert actions.
    }
  }

  private async cleanupExpiredLogs(settings: InteractionTraceSettings): Promise<void> {
    if (this.globalStorageUri.scheme !== 'file') {
      await this.cleanupExpiredLogsWithWorkspaceFs(settings);
      return;
    }

    const rootPath = path.join(this.globalStorageUri.fsPath, TRACE_ROOT_DIR);
    const cutoffMs = Date.now() - settings.retentionDays * MS_PER_DAY;
    let entries: Dirent[];

    try {
      entries = await readdir(rootPath, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(rootPath, entry.name);
      try {
        if (entry.isDirectory()) {
          const parsedDay = traceDayEndMs(entry.name);
          if (Number.isFinite(parsedDay) && parsedDay < cutoffMs) {
            await rm(entryPath, { recursive: true, force: true });
          }
          return;
        }

        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
          return;
        }

        const fileStat = await stat(entryPath);
        if (fileStat.mtimeMs < cutoffMs) {
          await rm(entryPath, { force: true });
        }
      } catch {
        // Trace cleanup is best-effort and must never affect agent execution.
      }
    }));
  }

  private async cleanupExpiredLogsWithWorkspaceFs(settings: InteractionTraceSettings): Promise<void> {
    const rootUri = vscode.Uri.joinPath(this.globalStorageUri, TRACE_ROOT_DIR);
    const cutoffMs = Date.now() - settings.retentionDays * MS_PER_DAY;
    let entries: [string, vscode.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(rootUri);
    } catch {
      return;
    }

    await Promise.all(entries.map(async ([name, type]) => {
      const entryUri = vscode.Uri.joinPath(rootUri, name);
      try {
        if (type === vscode.FileType.Directory) {
          const parsedDay = traceDayEndMs(name);
          if (Number.isFinite(parsedDay) && parsedDay < cutoffMs) {
            await vscode.workspace.fs.delete(entryUri, { recursive: true, useTrash: false });
          }
          return;
        }

        if (type !== vscode.FileType.File || !name.endsWith('.jsonl')) {
          return;
        }

        const fileStat = await vscode.workspace.fs.stat(entryUri);
        if (fileStat.mtime < cutoffMs) {
          await vscode.workspace.fs.delete(entryUri, { recursive: false, useTrash: false });
        }
      } catch {
        // Trace cleanup is best-effort and must never affect agent execution.
      }
    }));
  }
}

/** Only explicit sidecar ownership permits removal; legacy log bodies are never
 * read to infer ownership. One recycler instance shares its bounded metadata scan
 * across a batch rather than rescanning all logs for every target. */
export class InteractionTraceCleanup {
  private catalog?: Promise<{ bySession: Map<string, vscode.Uri[]>; unverifiedLegacySources: number }>;
  public constructor(private readonly root: vscode.Uri) {}
  private async readCatalog(): Promise<{ bySession: Map<string, vscode.Uri[]>; unverifiedLegacySources: number }> {
    const result = { bySession: new Map<string, vscode.Uri[]>(), unverifiedLegacySources: 0 };
    const logs = vscode.Uri.joinPath(this.root, TRACE_ROOT_DIR);
    await assertManagedStoragePath(this.root, logs);
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(logs); }
    catch (error) { if (isMissingAssociatedFile(error)) return result; throw error; }
    const directories = [logs];
    for (const [name, type] of entries) if (type === vscode.FileType.Directory && /^\d{4}-\d{2}-\d{2}$/u.test(name)) directories.push(vscode.Uri.joinPath(logs, name));
    for (const directory of directories) {
      await assertManagedStoragePath(this.root, directory);
      let files: [string, vscode.FileType][];
      try { files = await vscode.workspace.fs.readDirectory(directory); }
      catch (error) { if (isMissingAssociatedFile(error)) continue; throw error; }
      const ownedBases = new Set(files.filter(([name, type]) => type === vscode.FileType.File && /^run-.*\.jsonl\.owner\.json$/u.test(name)).map(([name]) => name.slice(0, -'.owner.json'.length)));
      for (const [name, type] of files) if (type === vscode.FileType.File && /^run-.*\.jsonl$/u.test(name)
        && !/\.perf-[0-3]\.jsonl$/u.test(name) && !ownedBases.has(name)) result.unverifiedLegacySources++;
      for (const baseName of ownedBases) {
        const base = vscode.Uri.joinPath(directory, baseName), ownerUri = vscode.Uri.parse(`${base.toString()}.owner.json`);
        await assertManagedStoragePath(this.root, ownerUri);
        const owner = await readAssociatedJson(ownerUri);
        if (owner?.version !== 1 || typeof owner.sessionId !== 'string' || typeof owner.runId !== 'string'
          || !baseName.endsWith(`-${owner.runId}.jsonl`)) { result.unverifiedLegacySources++; continue; }
        const list = result.bySession.get(owner.sessionId) ?? [];
        list.push(base); result.bySession.set(owner.sessionId, list);
      }
    }
    return result;
  }
  private async indexedBases(sessionId: string): Promise<vscode.Uri[]> {
    const uri = traceOwnerIndexUri(this.root, sessionId);
    await assertManagedStoragePath(this.root, uri);
    const index = await readAssociatedJson(uri);
    if (!index) return [];
    if (index.version !== 1 || index.sessionId !== sessionId || !Array.isArray(index.runs)) throw new Error('Trace owner index is damaged.');
    return index.runs.map(value => {
      const run = value as { runId?: unknown; relativeFile?: unknown };
      if (typeof run.runId !== 'string' || typeof run.relativeFile !== 'string'
        || !/^interaction-logs\/\d{4}-\d{2}-\d{2}\/run-[^/]+\.jsonl$/u.test(run.relativeFile)
        || !run.relativeFile.endsWith(`-${run.runId}.jsonl`)) throw new Error('Trace owner identity is damaged.');
      return vscode.Uri.joinPath(this.root, run.relativeFile);
    });
  }
  public async hasSessionHistory(sessionId: string): Promise<boolean> {
    return (await this.indexedBases(sessionId)).length > 0;
  }
  public async cleanup(sessionId: string): Promise<{ unverifiedLegacySources: number }> {
    const authority = new SessionDeletionAuthority(this.root);
    return authority.withSessionIdGate(sessionId, async () => {
      const catalog = await (this.catalog ??= this.readCatalog());
      const bases = new Map([...(catalog.bySession.get(sessionId) ?? []), ...await this.indexedBases(sessionId)].map(uri => [uri.toString(), uri]));
      for (const base of bases.values()) {
        for (const suffix of ['', '.perf-index.json', '.perf-0.jsonl', '.perf-1.jsonl', '.perf-2.jsonl', '.perf-3.jsonl']) {
          const uri = vscode.Uri.parse(`${base.toString()}${suffix}`);
          await assertManagedStoragePath(this.root, uri);
          await deleteAssociatedUri(uri);
        }
        // Retain the content-free owner marker: external post-run callbacks have
        // only runId/URI and still need to discover the deleted parent session.
      }
      return { unverifiedLegacySources: catalog.unverifiedLegacySources };
    });
  }
}

export async function deleteSessionInteractionTraces(root: vscode.Uri, sessionId: string): Promise<{ unverifiedLegacySources: number }> {
  return new InteractionTraceCleanup(root).cleanup(sessionId);
}

class JsonlInteractionTrace implements AgentInteractionTrace {
  public readonly enabled = true;
  public readonly level: InteractionTraceLevel;
  public readonly logRawStream: boolean;

  private writeQueue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private bytesWritten = 0;
  private stopped = false;

  public constructor(
    public readonly runId: string,
    private readonly filePath: string,
    private readonly settings: InteractionTraceSettings,
    private readonly eventSink?: InteractionTraceEventSink,
    private readonly owner?: TraceOwnership
  ) {
    this.logUri = vscode.Uri.file(filePath).toString();
    this.level = settings.level;
    this.logRawStream = settings.logRawStream;
  }

  public readonly logUri: string;

  public includesPayload(level: 'request' | 'full'): boolean {
    if (level === 'full') {
      return this.level === 'full';
    }
    return this.level === 'request' || this.level === 'full';
  }

  public record(event: InteractionTraceEvent): void {
    const timestamp = formatLocalTimestamp();
    this.eventSink?.(event, timestamp);
    if (this.stopped) {
      return;
    }

    const envelope = {
      ts: timestamp,
      runId: this.runId,
      seq: ++this.sequence,
      ...event
    };
    const line = `${safeJsonStringify(envelope)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    this.writeQueue = this.writeQueue
      .then(() => withOwnedTraceWrite(vscode.Uri.file(this.filePath), this.runId, this.owner, () => this.writeLine(line, lineBytes)))
      .catch(() => {
        this.stopped = true;
      });
  }

  public async flush(): Promise<void> {
    await this.writeQueue.catch(() => undefined);
  }

  private async writeLine(line: string, lineBytes: number): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.bytesWritten + lineBytes > this.settings.maxFileBytes) {
      await this.writeTruncationMarker();
      this.stopped = true;
      return;
    }

    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, line, 'utf8');
    this.bytesWritten += lineBytes;
  }

  private async writeTruncationMarker(): Promise<void> {
    const marker = `${safeJsonStringify({
      ts: formatLocalTimestamp(),
      runId: this.runId,
      seq: ++this.sequence,
      type: 'trace_truncated',
      maxFileBytes: this.settings.maxFileBytes,
      bytesWritten: this.bytesWritten
    })}\n`;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, marker, 'utf8');
  }
}

class WorkspaceFsJsonlInteractionTrace implements AgentInteractionTrace {
  public readonly enabled = true;
  public readonly level: InteractionTraceLevel;
  public readonly logRawStream: boolean;
  public readonly logUri: string;

  private readonly encoder = new TextEncoder();
  private writeQueue: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private bytesWritten = 0;
  private stopped = false;
  private content = '';
  private pendingLines: string[] = [];

  public constructor(
    public readonly runId: string,
    private readonly fileUri: vscode.Uri,
    private readonly settings: InteractionTraceSettings,
    private readonly eventSink?: InteractionTraceEventSink,
    private readonly owner?: TraceOwnership
  ) {
    this.logUri = fileUri.toString();
    this.level = settings.level;
    this.logRawStream = settings.logRawStream;
  }

  public includesPayload(level: 'request' | 'full'): boolean {
    if (level === 'full') {
      return this.level === 'full';
    }
    return this.level === 'request' || this.level === 'full';
  }

  public record(event: InteractionTraceEvent): void {
    const timestamp = formatLocalTimestamp();
    this.eventSink?.(event, timestamp);
    if (this.stopped) {
      return;
    }

    const envelope = {
      ts: timestamp,
      runId: this.runId,
      seq: ++this.sequence,
      ...event
    };
    const line = `${safeJsonStringify(envelope)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (this.bytesWritten + lineBytes > this.settings.maxFileBytes) {
      this.recordTruncationMarker();
      this.stopped = true;
      return;
    }

    this.pendingLines.push(line);
    this.bytesWritten += lineBytes;
    this.scheduleFlush();
  }

  public async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    await this.flushPendingLines();
    await this.writeQueue.catch(() => undefined);
  }

  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushPendingLines();
    }, 250);
  }

  private async flushPendingLines(): Promise<void> {
    if (!this.pendingLines.length) {
      return this.writeQueue;
    }

    const lines = this.pendingLines.splice(0);
    this.content += lines.join('');
    const content = this.content;
    this.writeQueue = this.writeQueue
      .then(() => withOwnedTraceWrite(this.fileUri, this.runId, this.owner, async () => {
        await vscode.workspace.fs.createDirectory(this.parentUri(this.fileUri));
        await vscode.workspace.fs.writeFile(this.fileUri, this.encoder.encode(content));
      }))
      .catch(() => {
        this.stopped = true;
      });
    return this.writeQueue;
  }

  private recordTruncationMarker(): void {
    const marker = `${safeJsonStringify({
      ts: formatLocalTimestamp(),
      runId: this.runId,
      seq: ++this.sequence,
      type: 'trace_truncated',
      maxFileBytes: this.settings.maxFileBytes,
      bytesWritten: this.bytesWritten
    })}\n`;
    this.pendingLines.push(marker);
    this.scheduleFlush();
  }

  private parentUri(uri: vscode.Uri): vscode.Uri {
    const slashIndex = uri.path.lastIndexOf('/');
    if (slashIndex <= 0) {
      return uri.with({ path: '/' });
    }
    return uri.with({ path: uri.path.slice(0, slashIndex) });
  }
}

class NoopInteractionTrace implements AgentInteractionTrace {
  public readonly runId = randomUUID();
  public readonly enabled = false;
  public readonly level: InteractionTraceLevel = 'metadata';
  public readonly logRawStream = false;

  public constructor(private readonly eventSink?: InteractionTraceEventSink) {}

  public includesPayload(_level: 'request' | 'full'): boolean {
    return false;
  }

  public record(event: InteractionTraceEvent): void {
    this.eventSink?.(event, formatLocalTimestamp());
  }

  public async flush(): Promise<void> {
    return;
  }
}

export function createNoopInteractionTrace(eventSink?: InteractionTraceEventSink): AgentInteractionTrace {
  return new NoopInteractionTrace(eventSink);
}

export function summarizeText(value: string | null | undefined): Record<string, unknown> {
  if (typeof value !== 'string') {
    return {
      present: value !== undefined && value !== null,
      chars: 0,
      bytes: 0
    };
  }

  return {
    present: true,
    chars: value.length,
    bytes: Buffer.byteLength(value, 'utf8'),
    lines: value ? value.split('\n').length : 0
  };
}

export function summarizeDeepSeekMessage(message: DeepSeekMessage | DeepSeekAssistantMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: summarizeText(message.content),
    reasoningContent: summarizeText(message.reasoning_content),
    toolCallId: 'tool_call_id' in message ? message.tool_call_id : undefined,
    toolCalls: message.tool_calls?.map(summarizeDeepSeekToolCall) ?? null
  };
}

export function summarizeDeepSeekToolCall(toolCall: DeepSeekToolCall): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: toolCall.type,
    function: {
      name: toolCall.function.name,
      arguments: summarizeText(toolCall.function.arguments)
    }
  };
}

export function summarizeDeepSeekRequestBody(body: DeepSeekChatRequestBody): Record<string, unknown> {
  return {
    model: body.model,
    stream: body.stream,
    enableThinking: body.enable_thinking,
    thinking: body.thinking,
    reasoningEffort: body.reasoning_effort,
    toolChoice: body.tool_choice,
    maxTokens: body.max_tokens,
    temperature: body.temperature,
    topP: body.top_p,
    streamOptions: body.stream_options,
    messages: body.messages.map(summarizeDeepSeekMessage),
    tools: body.tools?.map(summarizeDeepSeekTool) ?? []
  };
}

export function summarizeDeepSeekTool(tool: DeepSeekFunctionTool): Record<string, unknown> {
  return {
    type: tool.type,
    name: tool.function.name,
    strict: tool.function.strict === true,
    parameterCount: Object.keys(tool.function.parameters.properties).length
  };
}

export function formatUnknownError(error: unknown): Record<string, unknown> {
  const seen = new Set<object>();
  let nodes = 0;
  const clip = (value: string, limit = 1024): string => redactSensitiveTraceText(value)
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu, '$1[redacted]@').slice(0, limit);
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (!value || typeof value !== 'object') return { message: clip(String(value)) };
    if (seen.has(value)) return { message: '[circular error]' };
    if (depth > 4 || nodes++ >= 24) return { message: '[error chain truncated]' };
    seen.add(value);
    const record = value as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown; cause?: unknown; errors?: unknown };
    return {
      name: typeof record.name === 'string' ? clip(record.name, 100) : undefined,
      message: typeof record.message === 'string' ? clip(record.message) : clip(String(value)),
      code: typeof record.code === 'string' ? clip(record.code, 100) : undefined,
      stack: typeof record.stack === 'string' ? clip(record.stack, 4096) : undefined,
      ...(record.cause !== undefined ? { cause: visit(record.cause, depth + 1) } : {}),
      ...(Array.isArray(record.errors) ? { errors: record.errors.slice(0, 8).map((inner) => visit(inner, depth + 1)) } : {})
    };
  };
  return visit(error, 0);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (key, innerValue: unknown) => {
      if (typeof innerValue === 'string') {
        if (/^(?:apiKey|authorizationHeader|accessToken|refreshToken|password|passwd|secret|clientSecret|privateKey)$/iu.test(key)) {
          return '[redacted]';
        }
        return redactSensitiveTraceText(innerValue);
      }
      if (typeof innerValue === 'bigint') {
        return innerValue.toString();
      }
      if (innerValue instanceof Error) {
        return formatUnknownError(innerValue);
      }
      return innerValue;
    });
  } catch (error) {
    return JSON.stringify({
      type: 'trace_serialization_error',
      error: formatUnknownError(error)
    });
  }
}

function redactSensitiveTraceText(value: string): string {
  return value
    .replace(/(api[_ -]?key|authorization|bearer|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|client[_ -]?secret)(\s*[:=]\s*)\S+/giu, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,})\b/gu, '[redacted]');
}

function formatTimestampForFile(date: Date): string {
  return formatLocalTimestamp(date).replace(/[:.]/gu, '-');
}

function traceDayEndMs(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return NaN;
  // Older folders were UTC-based. Use the later boundary so moving to local
  // dates cannot shorten their retention period.
  return Math.max(Date.parse(`${day}T23:59:59.999`), Date.parse(`${day}T23:59:59.999Z`));
}
