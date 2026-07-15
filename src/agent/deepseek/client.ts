import { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../../shared/config';
import { DeepSeekStreamParser } from './streamParser';
import { AgentInteractionTrace, formatUnknownError, summarizeDeepSeekMessage, summarizeText } from '../logging/interactionTrace';
import {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekStreamResult,
  DeepSeekUsage
} from './types';

export type DeepSeekClientFailureKind =
  | 'http'
  | 'empty_body'
  | 'empty_stream'
  | 'network'
  | 'stream'
  | 'external_abort'
  | 'run_time_limit'
  | 'stream_idle_timeout';

export interface DeepSeekClientConfig {
  apiKey: string;
  baseUrl: string;
  streamIdleTimeoutMs: number;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
}

export interface DeepSeekClientRequest {
  body: DeepSeekChatRequestBody;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: AgentRunCallbacks;
  runDeadlineAt?: number;
  trace?: AgentInteractionTrace;
  requestId?: string;
}

export interface DeepSeekClientResult {
  ok: boolean;
  finishReason?: string | null;
  message?: DeepSeekAssistantMessage;
  usage?: DeepSeekUsage | null;
  hadPartialOutput: boolean;
  retryable: boolean;
  error?: string;
  failureKind?: DeepSeekClientFailureKind;
  status?: number;
}

interface DeepSeekAttemptResult extends DeepSeekClientResult {
  hadStreamActivity: boolean;
}

export class DeepSeekClient {
  private readonly streamParser = new DeepSeekStreamParser();

  public async createChatCompletion(
    config: DeepSeekClientConfig,
    request: DeepSeekClientRequest
  ): Promise<DeepSeekClientResult> {
    const maxRetries = Math.max(0, Math.floor(config.maxRequestRetries));

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const result = await this.createChatCompletionAttempt(config, request, attempt);
      if (result.ok || !this.shouldRetry(result, attempt, maxRetries)) {
        return result;
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
      error: request.language === 'en'
        ? 'DeepSeek API request failed after retries.'
        : 'DeepSeek API 请求重试后仍失败。'
    };
  }

  private async createChatCompletionAttempt(
    config: DeepSeekClientConfig,
    request: DeepSeekClientRequest,
    attempt: number
  ): Promise<DeepSeekAttemptResult> {
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
      const chatCompletionsUrl = this.getChatCompletionsUrl(config.baseUrl);
      trace?.record({
        type: 'upstream_attempt_start',
        requestId: request.requestId,
        attempt,
        url: chatCompletionsUrl
      });
      const response = await fetch(chatCompletionsUrl, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
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
            ? `DeepSeek API request failed (${response.status}): ${this.formatApiError(responseText, language)}`
            : `DeepSeek API 请求失败 (${response.status}): ${this.formatApiError(responseText, language)}`
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
            ? 'DeepSeek API did not return a streaming response body.'
            : 'DeepSeek API 未返回流式响应体。'
        };
      }

      resetStreamIdleTimeout();
      const result: DeepSeekStreamResult = await this.streamParser.parse(
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
        message: trace.includesPayload('request') ? result.message : summarizeDeepSeekMessage(result.message)
      });
      return {
        ok: true,
        finishReason: result.finishReason,
        message: result.message,
        usage: result.usage,
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
            ? `DeepSeek API streaming response was idle for ${Math.round(config.streamIdleTimeoutMs / 1000)} seconds.`
            : `DeepSeek API 流式响应连续 ${Math.round(config.streamIdleTimeoutMs / 1000)} 秒没有返回数据，已停止本次请求。`
        };
      }

      const retryable = !hadPartialOutput && !hadStreamActivity && this.isRetryableTransportError(error);
      const isEmptyStream = error instanceof Error && (
        error.message.includes('did not return any streaming chunks') ||
        error.message.includes('未返回任何流式数据块')
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

  private shouldRetry(result: DeepSeekAttemptResult, attempt: number, maxRetries: number): boolean {
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
    config: DeepSeekClientConfig,
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
      ? `DeepSeek streaming connection failed before completion (${originalMessage}).${idleHint}${partialHint}`
      : `DeepSeek 流式连接在完成前中断（${originalMessage}）。${idleHint}${partialHint}`;
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

  private getChatCompletionsUrl(rawBaseUrl: string): string {
    const url = new URL(rawBaseUrl || DEFAULT_DEEPSEEK_BASE_URL);
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

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
