import { monitorEventLoopDelay } from 'node:perf_hooks';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../../shared/atomicStorage';
import type { AgentInteractionTrace, InteractionTraceEvent } from './interactionTrace';

const listeners = new Set<(event: InteractionTraceEvent) => void>();
export function recordLocalPerformance(event: InteractionTraceEvent): void {
  for (const listener of listeners) { try { listener(event); } catch { /* telemetry cannot fail a durable operation */ } }
}
export function subscribeLocalPerformance(listener: (event: InteractionTraceEvent) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
const KEYS = new Set(['sessionId', 'taskId', 'epochIndex', 'requestId', 'attempt', 'attemptIndex', 'phase', 'status', 'ok', 'reason',
  'stopReason', 'finishReason', 'toolName', 'durationMs', 'elapsedMs', 'headersMs', 'firstContentMs', 'firstChunkMs',
  'estimatedPromptTokens', 'afterEstimatedPromptTokens', 'netReleasedTokens', 'summaryInputTokens', 'summaryOutputTokens',
  'protectedMessageCount', 'compressibleMessageCount', 'bytesWritten', 'objectsWritten', 'snapshotMs', 'encodeMs', 'commitMs',
  'loadMs', 'eventLoopMaxMs', 'eventLoopP95Ms', 'droppedEvents', 'bodyDelivered', 'envelopeBytes', 'modelMaxOutputTokens', 'costKnown',
  'actualMaxOutputTokens', 'estimatedInputTokens', 'inputBudgetTokens', 'safetyTokens', 'effectiveWindowTokens', 'limitSource', 'eventScope']);

/** Independent bounded tail: four 256 KiB segments, at most 256 KiB queued.
 * Only whitelisted scalars enter this log, never history, arguments or output. */
export class PerformanceTrace {
  private queue: string[] = [];
  private queuedBytes = 0;
  private dropped = 0;
  private totalDropped = 0;
  private sequence = 0;
  private slot = 0;
  private generation = 0;
  private segment = '';
  private drain?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private retryAfter = 0;
  private writeFailures = 0;
  private inFlightRemaining = 0;
  public constructor(private readonly base: vscode.Uri, private readonly runId: string,
    private readonly segmentBytes = 256 * 1024, private readonly maxQueuedBytes = 256 * 1024) {}
  public record(event: InteractionTraceEvent): void {
    if (!/^(run_|upstream_(attempt|http|retry|model)|provider_first|context_|request_output|tool_(call|result|delivery)|checkpoint_|progress_|projection_|event_loop)/u.test(event.type)) return;
    const scalars: Record<string, unknown> = {};
    for (const [key, value] of Object.entries({ ...event, ...(event.compression as object ?? {}) })) {
      if (KEYS.has(key) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
        || typeof value === 'string' && value.length <= 160)) scalars[key] = value;
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), monotonicMs: performance.now(), runId: this.runId,
      seq: ++this.sequence, type: event.type, ...scalars }) + '\n';
    if (this.queuedBytes + Buffer.byteLength(line) > this.maxQueuedBytes) { this.dropped++; this.totalDropped++; return; }
    this.queue.push(line); this.queuedBytes += Buffer.byteLength(line);
    if (!this.timer && performance.now() >= this.retryAfter) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 100); this.timer.unref?.(); }
  }
  public async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.drain) return this.drain;
    if (performance.now() < this.retryAfter) return;
    // One bounded in-flight batch plus one bounded queue. Slow storage must not
    // create an unbounded chain of promises retaining already drained batches.
    this.drain = this.drainQueue().catch(() => {
      this.writeFailures++;
      this.dropped += this.inFlightRemaining; this.totalDropped += this.inFlightRemaining; this.inFlightRemaining = 0;
      // Bounded best-effort recovery: no timer retries during an outage. A later
      // event/flush retries after backoff; the index reports the diagnostic gap.
      this.retryAfter = performance.now() + 1000;
    })
      .finally(() => { this.drain = undefined; });
    return this.drain;
  }
  private async drainQueue(): Promise<void> {
    while (this.queue.length || this.dropped) {
      const lines = this.queue; this.queue = []; this.queuedBytes = 0;
      if (this.dropped) { lines.push(JSON.stringify({ type: 'performance_events_dropped', runId: this.runId, count: this.dropped, seq: ++this.sequence }) + '\n'); this.dropped = 0; }
      this.inFlightRemaining = lines.length;
      for (const line of lines) {
        if (Buffer.byteLength(this.segment) + Buffer.byteLength(line) > this.segmentBytes) {
          await this.writeSegment(); this.slot = (this.slot + 1) % 4; this.generation++; this.segment = '';
        }
        this.segment += line;
        this.inFlightRemaining--;
      }
      await this.writeSegment();
      await writeJsonAtomic(vscode.Uri.parse(`${this.base.toString()}.perf-index.json`), {
        version: 1, runId: this.runId, activeSlot: this.slot, generation: this.generation, lastSequence: this.sequence,
        segmentCount: 4, segmentBytes: this.segmentBytes, sampled: false, rotated: this.generation > 0,
        droppedEvents: this.totalDropped, writeFailures: this.writeFailures, queueLimitBytes: this.maxQueuedBytes
      });
    }
  }
  private async writeSegment(): Promise<void> {
    const uri = vscode.Uri.parse(`${this.base.toString()}.perf-${this.slot}.jsonl`);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(this.segment));
  }
}

export function withPerformanceTrace(trace: AgentInteractionTrace, base: vscode.Uri, scope?: { sessionId?: string; taskId?: string }): AgentInteractionTrace {
  const perf = new PerformanceTrace(base, trace.runId);
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  const record = (event: InteractionTraceEvent) => perf.record({ ...scope, ...event });
  const listener = (event: InteractionTraceEvent) => {
    if (!scope?.sessionId || event.sessionId !== scope.sessionId) return;
    if (event.runId && event.runId !== trace.runId) return;
    if (event.taskId && scope.taskId && event.taskId !== scope.taskId) return;
    // Session storage work has no unique requesting run when parent/child saves
    // overlap. Label shared observations rather than inventing run attribution.
    record({ ...event, eventScope: event.runId ? 'run' : event.taskId ? 'task' : 'session_shared' });
  };
  listeners.add(listener);
  const sample = () => { record({ type: 'event_loop', eventLoopMaxMs: loop.max / 1e6, eventLoopP95Ms: loop.percentile(95) / 1e6 }); loop.reset(); };
  const timer = setInterval(sample, 5000); timer.unref?.();
  let closed = false;
  return {
    runId: trace.runId, logUri: trace.logUri, enabled: trace.enabled, level: trace.level, logRawStream: trace.logRawStream,
    includesPayload: level => trace.includesPayload(level),
    record: event => { record(event); trace.record(event); },
    flush: async () => { await Promise.all([trace.flush(), perf.flush()]); },
    close: async () => {
      if (!closed) { closed = true; sample(); clearInterval(timer); loop.disable(); listeners.delete(listener); }
      await Promise.all([trace.flush(), perf.flush()]);
    }
  };
}
