import { isRecoverableNetworkError } from './networkErrors';
import type { DeepSeekUsage } from '../deepseek/types';
import type { ProviderStreamParseOptions, ProviderStreamProgress } from './types';

/** A clean or truncated EOF before a protocol terminal is a transport failure. */
export class ProviderIncompleteStreamError extends Error {
  public readonly code = 'KEEPSEEK_INCOMPLETE_STREAM';
  public constructor(message: string) { super(message); this.name = 'ProviderIncompleteStreamError'; }
}

/** Complete invalid events must never be replayed automatically. */
export class ProviderStreamProtocolError extends Error {
  public readonly code = 'KEEPSEEK_STREAM_PROTOCOL_ERROR';
  public constructor(message: string) { super(message); this.name = 'ProviderStreamProtocolError'; }
}

export class ProviderStreamProviderError extends Error {
  public readonly code = 'KEEPSEEK_STREAM_PROVIDER_ERROR';
  public constructor(message: string) { super(message); this.name = 'ProviderStreamProviderError'; }
}

export class ProviderStreamTailTimeoutError extends Error {
  public readonly code = 'KEEPSEEK_STREAM_TAIL_TIMEOUT';
  public constructor() { super('Completed stream tail exceeded its read deadline.'); this.name = 'ProviderStreamTailTimeoutError'; }
}

/** Only an identified reader transport failure can preserve a completed result. */
export function isStreamTransportError(value: unknown): boolean {
  return value instanceof ProviderStreamTailTimeoutError || isRecoverableNetworkError(value);
}

export function isTruncatedJsonError(error: unknown): boolean {
  return error instanceof SyntaxError && /unexpected end|unterminated/iu.test(error.message);
}

/** Per-attempt progress contains protocol bytes, never UI-filtered partial text. */
export class ProviderStreamReader {
  public readonly progress: ProviderStreamProgress = {
    semanticComplete: false, receivedBytes: 0, eventCount: 0,
    lastActivityAt: Date.now(), httpComplete: false
  };
  private terminalAt?: number;
  public constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
    private readonly options: ProviderStreamParseOptions
  ) {}

  public publish(usage?: DeepSeekUsage | null): void {
    if (usage !== undefined && usage !== null) this.progress.usage = mergeProviderStreamUsage(this.progress.usage, usage);
    this.options.onProgress?.({ ...this.progress });
  }

  public event(usage?: DeepSeekUsage | null): void {
    this.progress.eventCount += 1;
    this.publish(usage);
  }

  public completed(usage?: DeepSeekUsage | null): void {
    this.progress.semanticComplete = true;
    this.terminalAt ??= Date.now();
    this.publish(usage);
  }

  public interruptedTail(): void {
    this.progress.tailInterrupted = true;
    this.publish();
  }

  public async read(): Promise<{ done: boolean; value?: Uint8Array }> {
    this.checkCancelled();
    const timeoutMs = this.terminalAt === undefined ? undefined
      : Math.max(0, (this.options.tailTimeoutMs ?? 2_000) - (Date.now() - this.terminalAt));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeAbort: (() => void) | undefined;
    const competing: Array<Promise<{ done: boolean; value?: Uint8Array }>> = [this.reader.read()];
    if (timeoutMs !== undefined) competing.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ProviderStreamTailTimeoutError()), timeoutMs);
    }));
    if (this.options.signal) competing.push(new Promise((_, reject) => {
      const signal = this.options.signal!;
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }));
    try {
      const chunk = await Promise.race(competing);
      this.checkCancelled();
      if (chunk.done) {
        this.progress.httpComplete = true;
      } else {
        this.progress.receivedBytes += chunk.value!.byteLength;
        this.progress.lastActivityAt = Date.now();
        this.options.onStreamActivity?.();
      }
      this.publish();
      return chunk;
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort?.();
    }
  }

  public canPreserve(error: unknown): boolean {
    const signalReason = this.options.signal?.reason as { code?: unknown } | undefined;
    return this.progress.semanticComplete
      && (!this.options.signal?.aborted || signalReason?.code === 'KEEPSEEK_STREAM_TAIL_TIMEOUT')
      && isStreamTransportError(error);
  }

  public async release(): Promise<void> {
    if (!this.progress.httpComplete) await this.reader.cancel().catch(() => undefined);
    this.reader.releaseLock();
  }

  private checkCancelled(): void {
    if (this.options.signal?.aborted) {
      throw this.options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
  }
}

/** Malformed bytes cannot silently alter native text or tool argument strings. */
export class ProviderStreamTextDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  public constructor(private readonly stream: ProviderStreamReader) {}
  public decode(value?: Uint8Array): string {
    try { return value === undefined ? this.decoder.decode() : this.decoder.decode(value, { stream: true }); }
    catch {
      if (value !== undefined) throw new ProviderStreamProtocolError('Streaming response contained invalid UTF-8 bytes.');
      // decode(stream:true) already accepted all previous bytes. A flush failure
      // therefore means EOF cut off the last multi-byte code point.
      if (this.stream.progress.semanticComplete) { this.stream.interruptedTail(); return ''; }
      throw new ProviderIncompleteStreamError('Stream ended in an incomplete UTF-8 character.');
    }
  }
}

const usageCountFields = new Set([
  'prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens',
  'prompt_cache_miss_tokens', 'cached_tokens'
]);

/** Usage events are cumulative observations for one physical attempt. */
export function mergeProviderStreamUsage(
  previous: DeepSeekUsage | null | undefined,
  next: DeepSeekUsage | null | undefined
): DeepSeekUsage | null | undefined {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return previous ?? next;
  const result: DeepSeekUsage = { ...previous };
  const count = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (usageCountFields.has(key)) {
      if (count(value)) result[key] = count(result[key]) ? Math.max(result[key], value) : value;
    } else if (key === 'prompt_tokens_details' || key === 'completion_tokens_details') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const details: Record<string, unknown> = { ...result[key] };
      for (const [field, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        details[field] = count(entry) && count(details[field]) ? Math.max(entry, details[field]) : entry;
      }
      result[key] = details;
    } else result[key] = value;
  }
  if (count(result.prompt_tokens) && count(result.completion_tokens)) {
    result.total_tokens = Math.max(count(result.total_tokens) ? result.total_tokens : 0, result.prompt_tokens + result.completion_tokens);
  }
  return Object.keys(result).length ? result : null;
}
