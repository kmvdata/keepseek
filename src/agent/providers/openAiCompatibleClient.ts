import { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import { StreamParser } from './streamParser';
import { formatUnknownError, summarizeDeepSeekMessage, summarizeText } from '../logging/interactionTrace';
import type {
  DeepSeekAssistantMessage,
  DeepSeekStreamResult
} from '../deepseek/types';
import type { OpenAiResponsesStreamResult } from './responsesTypes';
import type { AnthropicMessagesStreamResult } from './anthropicTypes';
import type {
  ProviderClient,
  ProviderClientConfig,
  ProviderClientRequest,
  ProviderClientResult
} from './types';

interface OpenAICompatibleClientOptions {
  /** 用于错误提示的展示名，例如 DeepSeek / Ollama / OpenAI Compatible。 */
  displayName: string;
  /** Base URL 为空时使用的默认端点。 */
  defaultBaseUrl?: string;
}

interface ClientAttemptResult extends ProviderClientResult {
  hadStreamActivity: boolean;
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
    const maxRetries = Math.max(0, Math.floor(config.maxRequestRetries));

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.createModelResponseAttempt(config, request, attempt);
      if (result.ok || !this.shouldRetry(result, attempt, maxRetries)) {
        return {
          ...result,
          attemptCount: attempt + 1,
          retryCount: attempt
        };
      }

      request.trace?.record({
        type: 'upstream_retry_scheduled',
        requestId: request.requestId,
        attempt,
        nextAttempt: attempt + 1,
        maxRetries,
        failureKind: result.failureKind,
        status: result.status,
        error: result.error
      });
      await this.sleepBeforeRetry(config.requestRetryBaseMs, attempt, request.signal, request.runDeadlineAt);
    }

    return {
      ok: false,
      hadPartialOutput: false,
      retryable: false,
      attemptCount: maxRetries + 1,
      retryCount: maxRetries,
      error: request.language === 'en'
        ? `${this.displayName} API request failed after retries.`
        : `${this.displayName} API 请求重试后仍失败。`
    };
  }

  private async createModelResponseAttempt(
    config: ProviderClientConfig,
    request: ProviderClientRequest,
    attempt: number
  ): Promise<ClientAttemptResult> {
    const controller = new AbortController();
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let runTimeout: ReturnType<typeof setTimeout> | undefined;
    let abortedByStreamIdleTimeout = false;
    let abortedByRunTimeLimit = false;
    let abortedByExternalSignal = false;
    let hadStreamActivity = false;
    let hadPartialOutput = false;
    const partialContentParts: string[] = [];
    const partialReasoningParts: string[] = [];
    const language = request.language;
    const trace = request.trace;
    const abortByExternalSignal = () => {
      abortedByExternalSignal = true;
      controller.abort();
    };
    const resetStreamIdleTimeout = () => {
      if (config.streamIdleTimeoutMs <= 0) {
        return;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        abortedByStreamIdleTimeout = true;
        controller.abort();
      }, config.streamIdleTimeoutMs);
    };
    const clearStreamIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = undefined;
      }
    };
    const setRunTimeout = () => {
      if (typeof request.runDeadlineAt !== 'number') {
        return;
      }
      const remainingMs = request.runDeadlineAt - Date.now();
      if (remainingMs <= 0) {
        abortedByRunTimeLimit = true;
        controller.abort();
        return;
      }
      runTimeout = setTimeout(() => {
        abortedByRunTimeLimit = true;
        controller.abort();
      }, remainingMs);
    };
    const clearRunTimeout = () => {
      if (runTimeout) {
        clearTimeout(runTimeout);
        runTimeout = undefined;
      }
    };
    const callbacks: AgentRunCallbacks = {
      ...request.callbacks,
      onDelta: (event) => {
        hadPartialOutput = true;
        if (event.type === 'reasoning') {
          partialReasoningParts.push(event.delta);
        } else {
          partialContentParts.push(event.delta);
        }
        request.callbacks?.onDelta?.(event);
      }
    };
    const partialMessage = (): DeepSeekAssistantMessage | undefined => {
      const content = partialContentParts.join('');
      const reasoningContent = partialReasoningParts.join('');
      if (!content && !reasoningContent) {
        return undefined;
      }
      return {
        role: 'assistant',
        content,
        reasoning_content: reasoningContent,
        tool_calls: null
      };
    };

    resetStreamIdleTimeout();
    setRunTimeout();
    if (request.signal?.aborted) {
      abortByExternalSignal();
    } else {
      request.signal?.addEventListener('abort', abortByExternalSignal, { once: true });
    }

    try {
      request.callbacks?.onStatus?.({
        base: 'thinking',
        phase: 'requesting_model'
      });
      const requestUrl = this.getRequestUrl(config.baseUrl);
      trace?.record({
        type: 'upstream_attempt_start',
        requestId: request.requestId,
        attempt,
        url: requestUrl
      });
      const headers = this.buildRequestHeaders(config);
      const response = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(request.body),
        signal: controller.signal
      });
      trace?.record({
        type: 'upstream_http_response',
        requestId: request.requestId,
        attempt,
        status: response.status,
        ok: response.ok
      });

      if (!response.ok) {
        const responseText = await response.text();
        trace?.record({
          type: 'upstream_http_error',
          requestId: request.requestId,
          attempt,
          status: response.status,
          responseText: trace.includesPayload('request') ? responseText : summarizeText(responseText)
        });
        return {
          ok: false,
          hadPartialOutput,
          hadStreamActivity,
          retryable: this.isRetryableStatus(response.status),
          failureKind: 'http',
          status: response.status,
          error: language === 'en'
            ? `${this.displayName} API request failed (${response.status}): ${this.formatApiError(responseText, language)}`
            : `${this.displayName} API 请求失败 (${response.status}): ${this.formatApiError(responseText, language)}`
        };
      }

      if (!response.body) {
        trace?.record({
          type: 'upstream_empty_body',
          requestId: request.requestId,
          attempt
        });
        return {
          ok: false,
          hadPartialOutput,
          hadStreamActivity,
          retryable: false,
          failureKind: 'empty_body',
          error: language === 'en'
            ? `${this.displayName} API did not return a streaming response body.`
            : `${this.displayName} API 未返回流式响应体。`
        };
      }

      resetStreamIdleTimeout();
      const result = await this.parseStream(
        response.body,
        language,
        callbacks,
        {
          trace,
          requestId: request.requestId,
          attempt,
          onStreamActivity: () => {
            hadStreamActivity = true;
            resetStreamIdleTimeout();
          }
        }
      );
      trace?.record({
        type: 'upstream_attempt_finish',
        requestId: request.requestId,
        attempt,
        ok: true,
        finishReason: result.finishReason,
        usage: result.usage,
        nativeOutputItems: 'outputItems' in result
          ? {
              count: result.outputItems.length,
              types: result.outputItems.map((item) => item.type ?? 'local_message')
            }
          : undefined,
        nativeAnthropicBlocks: 'contentBlocks' in result
          ? { count: result.contentBlocks.length, types: result.contentBlocks.map((block) => block.type) }
          : undefined,
        message: trace.includesPayload('request') ? result.message : summarizeDeepSeekMessage(result.message)
      });
      const normalizedMessage = 'outputItems' in result && partialReasoningParts.length
        ? { ...result.message, reasoning_content: partialReasoningParts.join('') }
        : result.message;
      return {
        ok: true,
        finishReason: result.finishReason,
        message: normalizedMessage,
        usage: result.usage,
        nativeOutputItems: 'outputItems' in result ? result.outputItems : undefined,
        nativeAnthropicContentBlocks: 'contentBlocks' in result ? result.contentBlocks : undefined,
        hadPartialOutput,
        hadStreamActivity,
        retryable: false
      };
    } catch (error) {
      const abortError = error instanceof Error && error.name === 'AbortError';
      if (abortError && (abortedByExternalSignal || request.signal?.aborted)) {
        trace?.record({
          type: 'upstream_attempt_finish',
          requestId: request.requestId,
          attempt,
          ok: false,
          failureKind: 'external_abort',
          hadPartialOutput,
          hadStreamActivity,
          partialMessage: trace.includesPayload('request') ? partialMessage() : summarizeDeepSeekMessage(partialMessage() ?? {})
        });
        return {
          ok: false,
          message: partialMessage(),
          hadPartialOutput,
          hadStreamActivity,
          retryable: false,
          failureKind: 'external_abort',
          error: language === 'en' ? 'Agent run was stopped.' : 'Agent 推理已中止。'
        };
      }
      if (abortError && abortedByRunTimeLimit) {
        trace?.record({
          type: 'upstream_attempt_finish',
          requestId: request.requestId,
          attempt,
          ok: false,
          failureKind: 'run_time_limit',
          hadPartialOutput,
          hadStreamActivity,
          partialMessage: trace.includesPayload('request') ? partialMessage() : summarizeDeepSeekMessage(partialMessage() ?? {})
        });
        return {
          ok: false,
          message: partialMessage(),
          hadPartialOutput,
          hadStreamActivity,
          retryable: false,
          failureKind: 'run_time_limit',
          error: language === 'en'
            ? 'The agent reached the total run-time limit and stopped this run.'
            : 'Agent 本次执行达到总时长上限，已停止本次执行。'
        };
      }
      if (abortError && abortedByStreamIdleTimeout) {
        trace?.record({
          type: 'upstream_attempt_finish',
          requestId: request.requestId,
          attempt,
          ok: false,
          failureKind: 'stream_idle_timeout',
          hadPartialOutput,
          hadStreamActivity,
          partialMessage: trace.includesPayload('request') ? partialMessage() : summarizeDeepSeekMessage(partialMessage() ?? {})
        });
        return {
          ok: false,
          message: partialMessage(),
          hadPartialOutput,
          hadStreamActivity,
          retryable: false,
          failureKind: 'stream_idle_timeout',
          error: language === 'en'
            ? `${this.displayName} API streaming response was idle for ${Math.round(config.streamIdleTimeoutMs / 1000)} seconds.`
            : `${this.displayName} API 流式响应连续 ${Math.round(config.streamIdleTimeoutMs / 1000)} 秒没有返回数据，已停止本次请求。`
        };
      }

      const retryable = !hadPartialOutput && !hadStreamActivity && this.isRetryableTransportError(error);
      const isEmptyStream = error instanceof Error && (
        error.message.includes('did not return any streaming chunks') ||
        error.message.includes('未返回任何流式数据块') ||
        error.message.includes('did not return any streaming events') ||
        error.message.includes('未返回任何流式事件')
      );
      trace?.record({
        type: 'upstream_attempt_finish',
        requestId: request.requestId,
        attempt,
        ok: false,
        failureKind: this.isRetryableTransportError(error) ? 'network' : isEmptyStream ? 'empty_stream' : 'stream',
        retryable: retryable || isEmptyStream,
        hadPartialOutput,
        hadStreamActivity,
        error: formatUnknownError(error),
        partialMessage: trace?.includesPayload('request') ? partialMessage() : summarizeDeepSeekMessage(partialMessage() ?? {})
      });
      return {
        ok: false,
        message: partialMessage(),
        hadPartialOutput,
        hadStreamActivity,
        retryable: retryable || isEmptyStream,
        failureKind: this.isRetryableTransportError(error) ? 'network' : isEmptyStream ? 'empty_stream' : 'stream',
        error: this.formatStreamingError(error, config, language, hadPartialOutput)
      };
    } finally {
      request.signal?.removeEventListener('abort', abortByExternalSignal);
      clearStreamIdleTimeout();
      clearRunTimeout();
    }
  }

  private shouldRetry(result: ClientAttemptResult, attempt: number, maxRetries: number): boolean {
    return result.retryable && !result.hadPartialOutput && !result.hadStreamActivity && attempt < maxRetries;
  }

  private async sleepBeforeRetry(
    baseMs: number,
    attempt: number,
    signal: AbortSignal | undefined,
    runDeadlineAt: number | undefined
  ): Promise<void> {
    const rawDelayMs = Math.max(0, Math.floor(baseMs)) * (2 ** attempt);
    const deadlineDelayMs = typeof runDeadlineAt === 'number'
      ? Math.max(0, runDeadlineAt - Date.now())
      : rawDelayMs;
    const delayMs = Math.min(rawDelayMs, deadlineDelayMs);
    if (delayMs <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      const handleAbort = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', handleAbort);
        resolve();
      }, delayMs);
      signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private isRetryableTransportError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return error.name === 'TypeError' && (
      message.includes('fetch failed') ||
      message.includes('terminated') ||
      message.includes('socket') ||
      message.includes('network')
    );
  }

  private formatStreamingError(
    error: unknown,
    config: ProviderClientConfig,
    language: KeepseekLanguage,
    hadPartialOutput: boolean
  ): string {
    if (!this.isRetryableTransportError(error)) {
      return error instanceof Error ? error.message : String(error);
    }

    const originalMessage = error instanceof Error ? error.message : String(error);
    const idleHint = config.streamIdleTimeoutMs > 0
      ? (language === 'en'
        ? ` KeepSeek's automatic stream timeout for this request is ${Math.round(config.streamIdleTimeoutMs / 1000)} seconds.`
        : `KeepSeek 对本次请求使用的自动流式超时为 ${Math.round(config.streamIdleTimeoutMs / 1000)} 秒。`)
      : (language === 'en'
        ? ' KeepSeek stream idle timeout is disabled, so this usually means the network, proxy, or provider closed the SSE connection.'
        : 'KeepSeek 已禁用流式空闲超时，因此这通常表示网络、代理或服务商关闭了 SSE 连接。');
    const partialHint = hadPartialOutput
      ? (language === 'en' ? ' Any partial output already received was kept in the transcript.' : ' 已收到的部分输出会保留在对话中。')
      : '';

    return language === 'en'
      ? `${this.displayName} streaming connection failed before completion (${originalMessage}).${idleHint}${partialHint}`
      : `${this.displayName} 流式连接在完成前中断（${originalMessage}）。${idleHint}${partialHint}`;
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
    options: {
      trace?: import('../logging/interactionTrace').AgentInteractionTrace;
      requestId?: string;
      attempt?: number;
      onStreamActivity?: () => void;
    }
  ): Promise<DeepSeekStreamResult | OpenAiResponsesStreamResult | AnthropicMessagesStreamResult> {
    return await this.streamParser.parse(body, language, callbacks, options);
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
