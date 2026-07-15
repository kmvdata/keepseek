import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
}

export class InteractionTraceLogService {
  private lastRunTraceLogUri: string | undefined;

  public constructor(private readonly globalStorageUri: vscode.Uri) {}

  public createRunTrace(): AgentInteractionTrace {
    const settings = getConfiguredInteractionTraceSettings();
    if (!settings.enabled) {
      this.lastRunTraceLogUri = undefined;
      return createNoopInteractionTrace();
    }

    const runId = randomUUID();
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const fileName = `run-${formatTimestampForFile(now)}-${runId}.jsonl`;
    const fileUri = vscode.Uri.joinPath(this.globalStorageUri, TRACE_ROOT_DIR, day, fileName);
    void this.cleanupExpiredLogs(settings);

    if (fileUri.scheme === 'file') {
      const trace = new JsonlInteractionTrace(runId, fileUri.fsPath, settings);
      this.lastRunTraceLogUri = trace.logUri;
      return trace;
    }

    const trace = new WorkspaceFsJsonlInteractionTrace(runId, fileUri, settings);
    this.lastRunTraceLogUri = trace.logUri;
    return trace;
  }

  public getLastRunTraceLogUri(): string | undefined {
    return this.lastRunTraceLogUri;
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
          const parsedDay = Date.parse(`${entry.name}T23:59:59.999Z`);
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
          const parsedDay = Date.parse(`${name}T23:59:59.999Z`);
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
    private readonly settings: InteractionTraceSettings
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
    if (this.stopped) {
      return;
    }

    const envelope = {
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: ++this.sequence,
      ...event
    };
    const line = `${safeJsonStringify(envelope)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    this.writeQueue = this.writeQueue
      .then(() => this.writeLine(line, lineBytes))
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
      ts: new Date().toISOString(),
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
    private readonly settings: InteractionTraceSettings
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
    if (this.stopped) {
      return;
    }

    const envelope = {
      ts: new Date().toISOString(),
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
      .then(async () => {
        await vscode.workspace.fs.createDirectory(this.parentUri(this.fileUri));
        await vscode.workspace.fs.writeFile(this.fileUri, this.encoder.encode(content));
      })
      .catch(() => {
        this.stopped = true;
      });
    return this.writeQueue;
  }

  private recordTruncationMarker(): void {
    const marker = `${safeJsonStringify({
      ts: new Date().toISOString(),
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
  public readonly runId = 'disabled';
  public readonly enabled = false;
  public readonly level: InteractionTraceLevel = 'metadata';
  public readonly logRawStream = false;

  public includesPayload(_level: 'request' | 'full'): boolean {
    return false;
  }

  public record(_event: InteractionTraceEvent): void {
    return;
  }

  public async flush(): Promise<void> {
    return;
  }
}

export function createNoopInteractionTrace(): AgentInteractionTrace {
  return new NoopInteractionTrace();
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
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
  }

  return {
    message: String(error)
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, innerValue: unknown) => {
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

function formatTimestampForFile(date: Date): string {
  return date.toISOString().replace(/[:.]/gu, '-');
}
