import { AgentRunCallbacks } from '../../shared/types';
import { getConfiguredModelRequestTimeoutMs } from '../../shared/config';
import type { KeepseekLanguage } from '../../shared/i18n';
import { StreamParser } from './streamParser';
import { isRecoverableNetworkError, parseRetryAfter } from './networkErrors';
import { ProviderToolOutputTruncatedError, ProviderStreamProtocolError, ProviderStreamProviderError } from './streamErrors';
import { formatUnknownError, summarizeDeepSeekMessage, summarizeText } from '../logging/interactionTrace';
import type {
  DeepSeekAssistantMessage,
  DeepSeekStreamResult,
  DeepSeekUsage
} from '../deepseek/types';
import type { OpenAiResponsesStreamResult } from './responsesTypes';
import type { AnthropicMessagesStreamResult } from './anthropicTypes';
import type {
  ProviderClient,
  ProviderClientConfig,
  ProviderClientRequest,
  ProviderClientResult,
  ProviderStreamParseOptions
} from './types';

interface OpenAICompatibleClientOptions {
  /** 用于错误提示的展示名，例如 DeepSeek / Ollama / OpenAI Compatible。 */
  displayName: string;
  /** Base URL 为空时使用的默认端点。 */
  defaultBaseUrl?: string;
}

interface ClientAttemptResult extends ProviderClientResult {
  hadStreamActivity: boolean;
  retryAfterMs?: number;
}

/**
 * 通用 OpenAI 兼容传输客户端：负责 HTTP 请求、重试、流式空闲超时、
 * 运行时限与 SSE 生命周期。Chat Completions 使用默认端点/解析器；
 * Responses 子类只替换协议端点与流解析器，复用相同的安全传输策略。
 */
export class OpenAICompatibleClient implements ProviderClient {
  protected readonly displayName: string;
  protected readonly defaultBaseUrl: string;
  private readonly streamParser = new StreamParser();

  public constructor(options: OpenAICompatibleClientOptions) {
    this.displayName = options.displayName;
    this.defaultBaseUrl = options.defaultBaseUrl ?? '';
  }

  public async createModelResponse(
    config: ProviderClientConfig,
    request: ProviderClientRequest
  ): Promise<ProviderClientResult> {
    // Freeze the lane, credentials and authoritative projection before callbacks
    // can mutate live configuration. Every physical send reuses these bytes.
    const frozenConfig = { ...config };
    const frozen = {
      url: this.getRequestUrl(frozenConfig.baseUrl),
      headers: Object.freeze(this.buildRequestHeaders(frozenConfig)),
      body: request.serializedBody ?? JSON.stringify(request.body),
      timeoutMs: getConfiguredModelRequestTimeoutMs()
    };
    const maxRetries = Math.min(5, Math.max(0, Math.floor(frozenConfig.maxRequestRetries) || 0));
    const initialAttempts = Math.max(0, Math.floor(request.initialAttemptCount
      ?? (request.initialRetryCount === undefined ? 0 : request.initialRetryCount + 1)) || 0);
    let physicalAttemptCount = 0;
    let lastResult: ClientAttemptResult | undefined;
    const finish = (result: ProviderClientResult): ProviderClientResult => ({
      ...result,
      attemptCount: physicalAttemptCount,
      retryCount: Math.max(0, initialAttempts + physicalAttemptCount - 1)
    });
    const stopped = (): ProviderClientResult | undefined => {
      if (request.signal?.aborted) return finish({ ...lastResult, ok: false, hadPartialOutput: lastResult?.hadPartialOutput ?? false,
        retryable: false, failureKind: 'external_abort', error: request.language === 'en' ? 'Agent run was stopped.' : 'Agent 推理已中止。' });
      if (typeof request.runDeadlineAt === 'number' && request.runDeadlineAt <= Date.now()) return finish({ ...lastResult,
        ok: false, hadPartialOutput: lastResult?.hadPartialOutput ?? false, retryable: false, failureKind: 'run_time_limit',
        error: request.language === 'en' ? 'The agent reached the total run-time limit.' : 'Agent 本次执行达到总时长上限。' });
      return undefined;
    };
    for (let localAttempt = 0; initialAttempts + physicalAttemptCount <= maxRetries; localAttempt += 1) {
      const boundary = stopped();
      if (boundary) return boundary;
      await request.callbacks?.beforeModelRequest?.();
      const nextBoundary = stopped();
      if (nextBoundary) return nextBoundary;
      request.callbacks?.onActivity?.('request');
      physicalAttemptCount += 1;
      const absoluteAttempt = initialAttempts + physicalAttemptCount - 1;
      const result = await this.createModelResponseAttempt(frozenConfig, request, frozen, localAttempt, absoluteAttempt);
      lastResult = result;
      if (!result.ok) request.callbacks?.onAttemptReset?.();
      await request.onAttemptResult?.({ attemptIndex: localAttempt, result: finish(result) });
      if (result.ok || !result.retryable) return finish(result);
      if (initialAttempts + physicalAttemptCount > maxRetries) break;
      const delayMs = Math.max(result.retryAfterMs ?? 0, Math.min(60_000,
        Math.max(0, frozenConfig.requestRetryBaseMs) * (2 ** absoluteAttempt) * (0.8 + Math.random() * 0.4)));
      const reconnectAttempt = initialAttempts + physicalAttemptCount;
      await request.callbacks?.beforeRetry?.();
      const retryBoundary = stopped();
      if (retryBoundary) return retryBoundary;
      request.trace?.record({ type: 'upstream_retry_scheduled', requestId: request.requestId,
        attempt: absoluteAttempt, nextAttempt: reconnectAttempt, maxRetries, delayMs,
        failureKind: result.failureKind, status: result.status, error: result.error });
      request.callbacks?.onActivity?.('retry');
      request.callbacks?.onStatus?.({ base: 'thinking', phase: 'reconnecting',
        reconnectAttempt, maxReconnectAttempts: maxRetries, retryDelayMs: Math.ceil(delayMs) });
      await this.sleepBeforeRetry(delayMs, request.signal, request.runDeadlineAt);
    }
    const boundary = stopped();
    if (boundary) return boundary;
    const error = request.language === 'en'
      ? `${this.displayName} connection recovery failed after ${maxRetries} reconnects. ${lastResult?.error ?? ''}`
      : `${this.displayName} 自动恢复失败，已用尽 ${maxRetries} 次重连。${lastResult?.error ?? ''}`;
    request.callbacks?.onStatus?.({ base: 'thinking', phase: 'failed', detail: error });
    return finish({ ...lastResult, ok: false, hadPartialOutput: lastResult?.hadPartialOutput ?? false,
      retryable: false, recoveryExhausted: true, failureKind: lastResult?.failureKind ?? 'network', error });
  }

  private async createModelResponseAttempt(
    config: ProviderClientConfig,
    request: ProviderClientRequest,
    frozen: { url: string; headers: Readonly<Record<string, string>>; body: string; timeoutMs: number },
    localAttempt: number,
    attempt: number
  ): Promise<ClientAttemptResult> {
    const controller = new AbortController();
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let runTimeout: ReturnType<typeof setTimeout> | undefined;
    let requestTimeout: ReturnType<typeof setTimeout> | undefined;
    let observedBody: ReadableStream<Uint8Array> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let abortedByStreamIdleTimeout = false;
    let abortedByRunTimeLimit = false;
    let abortedByExternalSignal = false;
    let abortedByRequestTimeout = false;
    let hadStreamActivity = false;
    let hadPartialOutput = false;
    let httpComplete = false;
    let semanticComplete = false;
    let usage: DeepSeekUsage | null | undefined;
    let responseBytes = 0;
    let eventCount = 0;
    let lastActivityAt = Date.now();
    let phase: 'waiting_response_headers' | 'reading_error_body' | 'reading_sse' | 'model_complete' | 'finishing' = 'waiting_response_headers';
    let status: number | undefined;
    let rejectedHttpResponse = false;
    let retryAfterMs: number | undefined;
    let providerRequestId: string | undefined;
    const startedAt = Date.now();
    const monotonicStart = performance.now();
    let firstChunkMs: number | undefined;
    let firstContentMs: number | undefined;
    const partialContentParts: string[] = [];
    const partialReasoningParts: string[] = [];
    const language = request.language;
    const trace = request.trace;
    const diagnostics = () => ({ phase, status, providerRequestId, elapsedMs: performance.now() - monotonicStart, firstChunkMs, firstContentMs,
      receivedBytes: responseBytes, eventCount, lastActivityAt: new Date(lastActivityAt).toISOString(),
      semanticComplete, httpComplete, attempt, reconnectCount: attempt });
    const abortByExternalSignal = () => { abortedByExternalSignal = true; controller.abort(); };
    const clearStreamIdleTimeout = () => { if (idleTimeout) clearTimeout(idleTimeout); idleTimeout = undefined; };
    const resetStreamIdleTimeout = () => {
      clearStreamIdleTimeout();
      if (config.streamIdleTimeoutMs <= 0 || semanticComplete) return;
      idleTimeout = setTimeout(() => { abortedByStreamIdleTimeout = true; controller.abort(); }, config.streamIdleTimeoutMs);
    };
    const setRunTimeout = () => {
      if (typeof request.runDeadlineAt !== 'number' || !Number.isFinite(request.runDeadlineAt)) return;
      const remainingMs = request.runDeadlineAt - Date.now();
      if (remainingMs <= 0) { abortedByRunTimeLimit = true; controller.abort(); return; }
      runTimeout = setTimeout(setRunTimeout, Math.min(remainingMs, 2_147_483_647));
    };
    const callbacks: AgentRunCallbacks = {
      ...request.callbacks,
      onDelta: (event) => {
        if (event.delta.length > 0 && firstContentMs === undefined) {
          firstContentMs = performance.now() - monotonicStart;
          trace?.record({ type: 'provider_first_content', requestId: request.requestId, attempt, firstContentMs });
        }
        hadPartialOutput = true;
        (event.type === 'reasoning' ? partialReasoningParts : partialContentParts).push(event.delta);
        request.callbacks?.onDelta?.(event);
      }
    };
    const partialMessage = (): DeepSeekAssistantMessage | undefined => {
      const content = partialContentParts.join('');
      const reasoningContent = partialReasoningParts.join('');
      return content || reasoningContent ? { role: 'assistant', content, reasoning_content: reasoningContent, tool_calls: null } : undefined;
    };
    try {
      request.callbacks?.onStatus?.({ base: 'thinking', phase: 'requesting_model' });
      trace?.record({ type: 'upstream_attempt_start', requestId: request.requestId, attempt,
        // Query parameters and URL userinfo may contain credentials.
        endpoint: this.safeEndpoint(frozen.url), transport: this.transportRuntime(frozen.timeoutMs) });
      await request.onAttempt?.({ requestId: request.requestId ?? '', attemptIndex: localAttempt,
        startedAt: new Date(startedAt).toISOString() });
      if (request.signal?.aborted) abortByExternalSignal();
      else request.signal?.addEventListener('abort', abortByExternalSignal, { once: true });
      resetStreamIdleTimeout();
      setRunTimeout();
      // The same deadline covers headers and streaming for every protocol/lane.
      // Network activity must not extend this user-configured request budget.
      requestTimeout = setTimeout(() => { abortedByRequestTimeout = true;
        controller.abort(new Error('Model request timed out.'));
      }, frozen.timeoutMs);
      const response = await fetch(frozen.url, { method: 'POST', headers: frozen.headers,
        body: frozen.body, signal: controller.signal });
      status = response.status;
      rejectedHttpResponse = !response.ok;
      retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      providerRequestId = (response.headers.get('x-request-id') ?? response.headers.get('request-id')
        ?? response.headers.get('x-amzn-requestid') ?? response.headers.get('trace-id'))?.slice(0, 256);
      phase = response.ok ? 'reading_sse' : 'reading_error_body';
      trace?.record({ type: 'upstream_http_response', requestId: request.requestId, ok: response.ok, ...diagnostics() });
      if (!response.ok) {
        const responseText = await this.readErrorBody(response, controller);
        trace?.record({ type: 'upstream_http_error', requestId: request.requestId, ...diagnostics(),
          responseText: trace.includesPayload('request') ? responseText : summarizeText(responseText) });
        return { ok: false, hadPartialOutput, hadStreamActivity, retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
          retryAfterMs, failureKind: 'http', status: response.status,
          error: language === 'en'
            ? `${this.displayName} API request failed (${response.status}): ${this.formatApiError(responseText, language)}`
            : `${this.displayName} API 请求失败 (${response.status}): ${this.formatApiError(responseText, language)}` };
      }
      if (!response.body) return { ok: false, hadPartialOutput, hadStreamActivity, retryable: true, failureKind: 'empty_body',
        error: language === 'en' ? `${this.displayName} API returned no streaming body.` : `${this.displayName} API 未返回流式响应体。` };
      resetStreamIdleTimeout();
      reader = response.body.getReader();
      observedBody = new ReadableStream<Uint8Array>({
        pull: async (target) => {
          try {
            const chunk = await reader!.read();
            if (chunk.done) { httpComplete = true; target.close(); return; }
            if (firstChunkMs === undefined) firstChunkMs = performance.now() - monotonicStart;
            hadStreamActivity = true; lastActivityAt = Date.now(); responseBytes += chunk.value.byteLength;
            if (responseBytes > 32 * 1024 * 1024) throw new Error('Streaming resource limit (32 MiB) / 流响应资源上限（32 MiB）');
            request.callbacks?.onActivity?.('network'); resetStreamIdleTimeout(); target.enqueue(chunk.value);
          } catch (error) { target.error(error); }
        },
        cancel: async () => { controller.abort(); await reader!.cancel().catch(() => undefined); }
      });
      const result = await this.parseStream(observedBody, language, callbacks, {
        trace, requestId: request.requestId, attempt, signal: controller.signal,
        onStreamActivity: () => { hadStreamActivity = true; resetStreamIdleTimeout(); },
        onProgress: (progress) => {
          usage = progress.usage ?? usage; eventCount = progress.eventCount;
          if (progress.semanticComplete && !semanticComplete) {
            semanticComplete = true; phase = 'model_complete'; clearStreamIdleTimeout();
            trace?.record({ type: 'upstream_model_complete', requestId: request.requestId, ...diagnostics() });
          }
        }
      });
      // Cancellation and budgets remain hard boundaries even if a terminal was seen.
      if (abortedByExternalSignal || request.signal?.aborted || abortedByRunTimeLimit || abortedByStreamIdleTimeout || abortedByRequestTimeout) throw new DOMException('Aborted', 'AbortError');
      phase = 'finishing';
      trace?.record({ type: 'upstream_attempt_finish', requestId: request.requestId, ok: true,
        finishReason: result.finishReason, usage: result.usage ?? usage, ...diagnostics(),
        nativeOutputItems: 'outputItems' in result ? { count: result.outputItems.length, types: result.outputItems.map((item) => item.type ?? 'local_message') } : undefined,
        nativeAnthropicBlocks: 'contentBlocks' in result ? { count: result.contentBlocks.length, types: result.contentBlocks.map((block) => block.type) } : undefined,
        message: trace?.includesPayload('request') ? result.message : summarizeDeepSeekMessage(result.message) });
      const normalizedMessage = 'outputItems' in result && partialReasoningParts.length
        ? { ...result.message, reasoning_content: partialReasoningParts.join('') } : result.message;
      return { ok: true, finishReason: result.finishReason, message: normalizedMessage, usage: result.usage ?? usage,
        nativeOutputItems: 'outputItems' in result ? result.outputItems : undefined,
        nativeAnthropicContentBlocks: 'contentBlocks' in result ? result.contentBlocks : undefined,
        hadPartialOutput, hadStreamActivity, retryable: false };
    } catch (error) {
      let failureKind: ProviderClientResult['failureKind'];
      let message: string;
      let retryable = false;
      if (abortedByExternalSignal || request.signal?.aborted) {
        failureKind = 'external_abort'; message = language === 'en' ? 'Agent run was stopped.' : 'Agent 推理已中止。';
      } else if (abortedByRunTimeLimit) {
        failureKind = 'run_time_limit'; message = language === 'en' ? 'The agent reached the total run-time limit.' : 'Agent 本次执行达到总时长上限。';
      } else if (abortedByRequestTimeout) {
        failureKind = 'request_timeout'; message = language === 'en'
          ? `${this.displayName} model request timed out after ${frozen.timeoutMs / 1000} seconds.`
          : `${this.displayName} 模型请求超过 ${frozen.timeoutMs / 1000} 秒，已停止本次请求。`;
      } else if (abortedByStreamIdleTimeout) {
        failureKind = 'stream_idle_timeout'; message = language === 'en'
          ? `${this.displayName} streaming response was idle for ${Math.round(config.streamIdleTimeoutMs / 1000)} seconds.`
          : `${this.displayName} API 流式响应连续 ${Math.round(config.streamIdleTimeoutMs / 1000)} 秒没有返回数据，已停止本次请求。`;
      } else {
        // A broken error body cannot turn a known authentication/configuration
        // rejection into a retryable POST.
        retryable = rejectedHttpResponse
          ? [408, 429, 500, 502, 503, 504].includes(status ?? 0)
          : isRecoverableNetworkError(error);
        failureKind = rejectedHttpResponse ? 'http'
          : error instanceof ProviderToolOutputTruncatedError ? 'tool_output_truncated'
          : error instanceof ProviderStreamProtocolError ? 'protocol'
            : error instanceof ProviderStreamProviderError ? 'provider'
              : error instanceof Error && /resource limit|资源上限/u.test(error.message) ? 'resource_limit'
                : retryable ? (hadStreamActivity ? 'stream' : 'network') : 'stream';
        message = rejectedHttpResponse
          ? `${this.displayName} API (${status}): ${error instanceof Error ? error.message : String(error)}`
          : this.formatStreamingError(error, language, phase);
      }
      trace?.record({ type: 'upstream_attempt_finish', requestId: request.requestId, ok: false,
        failureKind, retryable, hadPartialOutput, hadStreamActivity, usage, ...diagnostics(), error: formatUnknownError(error),
        partialMessage: trace?.includesPayload('request') ? partialMessage() : summarizeDeepSeekMessage(partialMessage() ?? {}) });
      return { ok: false, message: partialMessage(), usage, hadPartialOutput, hadStreamActivity, retryable,
        failureKind, status, retryAfterMs, error: message,
        finishReason: error instanceof ProviderToolOutputTruncatedError ? error.finishReason : undefined,
        toolIntegrity: error instanceof ProviderToolOutputTruncatedError ? 'incomplete' : undefined };
    } finally {
      request.signal?.removeEventListener('abort', abortByExternalSignal);
      clearStreamIdleTimeout();
      if (runTimeout) clearTimeout(runTimeout);
      if (requestTimeout) clearTimeout(requestTimeout);
      // Natural EOF keeps the healthy socket reusable. Incomplete/failed reads
      // must be aborted and fully cancelled before the next request is dispatched.
      if (!httpComplete) controller.abort();
      if (observedBody && !observedBody.locked && !httpComplete) await observedBody.cancel().catch(() => undefined);
      if (reader) {
        if (!httpComplete) await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
  }

  private async readErrorBody(response: Response, controller: AbortController): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let complete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = controller.signal;
    let removeAbort: (() => void) | undefined;
    // A rejected request needs only a short diagnostic preview. Silent error
    // bodies must not bypass cancellation or hold recovery indefinitely when
    // the normal stream idle timeout is disabled.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = Object.assign(new Error('HTTP error response body exceeded its 2-second read deadline.'), {
          code: 'KEEPSEEK_HTTP_ERROR_BODY_TIMEOUT'
        });
        controller.abort(error);
        reject(error);
      }, 2_000);
    });
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    });
    try {
      while (bytes < 65_536) {
        const chunk = await Promise.race([reader.read(), deadline, cancelled]);
        if (chunk.done) { complete = true; break; }
        const part = chunk.value.subarray(0, 65_536 - bytes);
        chunks.push(part); bytes += part.byteLength;
      }
      return Buffer.concat(chunks).toString('utf8');
    } finally {
      if (timer) clearTimeout(timer);
      removeAbort?.();
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  private async sleepBeforeRetry(delayMs: number, signal?: AbortSignal, runDeadlineAt?: number): Promise<void> {
    if (signal?.aborted) return;
    const wakeAt = Math.min(Date.now() + delayMs, runDeadlineAt ?? Infinity);
    if (wakeAt <= Date.now()) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const wait = () => {
        const remainingMs = wakeAt - Date.now();
        // Timers can wake slightly early. Never turn a bounded backoff into a
        // fresh POST just before the logical task deadline.
        if (signal?.aborted || remainingMs <= 0) finish();
        else timer = setTimeout(wait, Math.min(remainingMs, 2_147_483_647));
      };
      signal?.addEventListener('abort', finish, { once: true });
      wait();
    });
  }

  private safeEndpoint(value: string): string {
    const url = new URL(value); url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  }

  private transportRuntime(requestTimeoutMs: number): Record<string, unknown> {
    const runtime = globalThis as typeof globalThis & { __vscodeOriginalFetch?: unknown; __vscodePatchedFetch?: unknown };
    return { implementation: runtime.__vscodeOriginalFetch ? 'vscode_fetch' : 'runtime_fetch',
      nodeVersion: process.version, undiciVersion: (process.versions as Record<string, string | undefined>).undici,
      requestTimeoutMs, errorBodyTimeoutMs: 2_000, bodyIdleTimeoutManagedByRuntime: true };
  }

  private formatStreamingError(error: unknown, language: KeepseekLanguage, phase: string): string {
    const original = error instanceof Error ? error.message : String(error);
    if (!isRecoverableNetworkError(error)) return original;
    const phaseText = phase === 'waiting_response_headers'
      ? (language === 'en' ? 'connecting or waiting for response headers' : '连接或等待响应头时')
      : (language === 'en' ? 'reading the streaming response' : '读取流式响应时');
    return language === 'en'
      ? `${this.displayName} connection failed while ${phaseText} (${original}).`
      : `${this.displayName} 在${phaseText}连接中断（${original}）。`;
  }

  private formatApiError(responseText: string, language: KeepseekLanguage): string {
    if (!responseText.trim()) {
      return language === 'en' ? 'Response is empty.' : '响应为空。';
    }

    try {
      const parsed: unknown = JSON.parse(responseText);
      if (this.isRecord(parsed)) {
        const error = parsed.error;
        if (this.isRecord(error) && typeof error.message === 'string') {
          return error.message;
        }
        if (typeof parsed.message === 'string') {
          return parsed.message;
        }
      }
    } catch {
      // Fall through to a clipped raw response.
    }

    return responseText.length > 800 ? `${responseText.slice(0, 800)}...` : responseText;
  }

  /**
   * 默认拼接 /chat/completions；协议子类可覆写端点推导。
   */
  protected getRequestUrl(rawBaseUrl: string): string {
    const url = new URL(rawBaseUrl || this.defaultBaseUrl);
    const cleanPath = url.pathname.replace(/\/+$/u, '');

    if (cleanPath.endsWith('/chat/completions')) {
      url.pathname = cleanPath;
      return url.toString();
    }

    const basePath = cleanPath.endsWith('/anthropic')
      ? cleanPath.slice(0, -'/anthropic'.length)
      : cleanPath;
    url.pathname = `${basePath || ''}/chat/completions`;
    return url.toString();
  }

  protected buildRequestHeaders(config: ProviderClientConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json'
    };
    // Ollama 等本地部署不需要 API Key；空 key 时不发送 Authorization 头。
    if (config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
    return headers;
  }

  protected async parseStream(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: ProviderStreamParseOptions
  ): Promise<DeepSeekStreamResult | OpenAiResponsesStreamResult | AnthropicMessagesStreamResult> {
    return await this.streamParser.parse(body, language, callbacks, options);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
