import type { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import type { DeepSeekToolCall, DeepSeekUsage } from '../deepseek/types';
import type {
  OpenAiResponsesItem,
  OpenAiResponsesStreamResult
} from './responsesTypes';

interface ResponsesStreamParseOptions {
  trace?: AgentInteractionTrace;
  requestId?: string;
  attempt?: number;
  onStreamActivity?: () => void;
}

interface CompletedResponse {
  status?: string;
  output?: unknown;
  usage?: unknown;
  incomplete_details?: unknown;
  error?: unknown;
}

const REPLAYABLE_OUTPUT_TYPES = new Set(['message', 'reasoning', 'function_call']);

/** Incremental SSE parser for the OpenAI Responses protocol. */
export class ResponsesStreamParser {
  public async parse(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: ResponsesStreamParseOptions = {}
  ): Promise<OpenAiResponsesStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const streamedText: string[] = [];
    const streamedReasoningSummary: string[] = [];
    const outputItems = new Map<number, OpenAiResponsesItem>();
    const functionArguments = new Map<string, string>();
    let buffer = '';
    let sawEvent = false;
    let done = false;
    let terminalResponse: CompletedResponse | undefined;

    const consumeBufferedEvents = (final = false) => {
      const trailingCarriageReturn = !final && buffer.endsWith('\r');
      const normalizable = trailingCarriageReturn ? buffer.slice(0, -1) : buffer;
      buffer = normalizable.replace(/\r\n?/gu, '\n') + (trailingCarriageReturn ? '\r' : '');
      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const result = this.consumeEvent(rawEvent, language, callbacks, {
          streamedText,
          streamedReasoningSummary,
          outputItems,
          functionArguments,
          options
        });
        sawEvent = sawEvent || result.sawEvent;
        done = done || result.done;
        terminalResponse = result.response ?? terminalResponse;
        if (done) {
          break;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    };

    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        consumeBufferedEvents(true);
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      options.onStreamActivity?.();
      consumeBufferedEvents();
    }

    if (buffer.trim() && !done) {
      const result = this.consumeEvent(buffer, language, callbacks, {
        streamedText,
        streamedReasoningSummary,
        outputItems,
        functionArguments,
        options
      });
      sawEvent = sawEvent || result.sawEvent;
      terminalResponse = result.response ?? terminalResponse;
    }

    if (!sawEvent) {
      throw new Error(language === 'en'
        ? 'The Responses API did not return any streaming events.'
        : 'Responses API 未返回任何流式事件。');
    }

    const authoritativeItems = this.readReplayableItems(terminalResponse?.output);
    let replayItems = authoritativeItems.length
      ? authoritativeItems
      : Array.from(outputItems.entries())
          .sort(([left], [right]) => left - right)
          .map(([index, item]) => this.applyAccumulatedArguments(item, functionArguments, index))
          .filter((item) => REPLAYABLE_OUTPUT_TYPES.has(item.type ?? ''));
    if (streamedText.length && !this.buildMessage(replayItems).content) {
      replayItems = this.applyAccumulatedOutputText(replayItems, streamedText.join(''));
    }
    const message = this.buildMessage(replayItems);
    const finalVisibleText = message.content ?? '';
    if (!streamedText.length && finalVisibleText) {
      callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
      callbacks.onDelta?.({ type: 'content', delta: finalVisibleText });
    }

    const status = terminalResponse?.status;
    const incompleteReason = this.readNestedString(terminalResponse?.incomplete_details, 'reason');
    if (status === 'incomplete' && incompleteReason !== 'max_output_tokens') {
      throw new Error(this.formatTerminalError('incomplete', terminalResponse ?? {}, language));
    }
    if (status === 'failed') {
      throw new Error(this.formatTerminalError('failed', terminalResponse ?? {}, language));
    }

    const toolCalls = message.tool_calls ?? [];
    return {
      message,
      finishReason: toolCalls.length
        ? 'tool_calls'
        : incompleteReason === 'max_output_tokens' ? 'length' : 'stop',
      usage: this.normalizeUsage(terminalResponse?.usage),
      outputItems: replayItems
    };
  }

  private consumeEvent(
    rawEvent: string,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    state: {
      streamedText: string[];
      streamedReasoningSummary: string[];
      outputItems: Map<number, OpenAiResponsesItem>;
      functionArguments: Map<string, string>;
      options: ResponsesStreamParseOptions;
    }
  ): { sawEvent: boolean; done: boolean; response?: CompletedResponse } {
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data.trim()) {
      return { sawEvent: false, done: false };
    }
    this.recordRawSseData(data, state.options);
    if (data.trim() === '[DONE]') {
      return { sawEvent: true, done: true };
    }

    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!this.isRecord(parsed)) {
        throw new Error(language === 'en' ? 'Event is not a JSON object.' : '事件不是 JSON 对象。');
      }
      event = parsed;
    } catch (error) {
      throw new Error(language === 'en'
        ? `Cannot parse the Responses streaming event: ${error instanceof Error ? error.message : String(error)}`
        : `无法解析 Responses 流式事件：${error instanceof Error ? error.message : String(error)}`);
    }

    const type = typeof event.type === 'string' ? event.type : '';
    switch (type) {
      case 'response.output_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          state.streamedText.push(delta);
          callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
          callbacks.onDelta?.({ type: 'content', delta });
        }
        break;
      }
      case 'response.output_text.done': {
        if (!state.streamedText.length && typeof event.text === 'string' && event.text) {
          state.streamedText.push(event.text);
          callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
          callbacks.onDelta?.({ type: 'content', delta: event.text });
        }
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : '';
        if (delta) {
          state.streamedReasoningSummary.push(delta);
          callbacks.onStatus?.({ base: 'thinking', phase: 'reasoning' });
          callbacks.onDelta?.({ type: 'reasoning', delta });
        }
        break;
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        const index = this.readNonNegativeInteger(event.output_index, state.outputItems.size);
        const item = this.cloneItem(event.item);
        if (item) {
          state.outputItems.set(index, item);
          if (item.type === 'function_call') {
            callbacks.onStatus?.({ base: 'thinking', phase: 'planning_tool' });
          }
        }
        break;
      }
      case 'response.function_call_arguments.delta':
      case 'response.function_call_arguments.done': {
        const key = this.readCallAccumulatorKey(event);
        const current = state.functionArguments.get(key) ?? '';
        if (type.endsWith('.delta')) {
          state.functionArguments.set(key, `${current}${typeof event.delta === 'string' ? event.delta : ''}`);
        } else if (typeof event.arguments === 'string') {
          state.functionArguments.set(key, event.arguments);
        }
        callbacks.onStatus?.({ base: 'thinking', phase: 'planning_tool' });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = this.isRecord(event.response) ? event.response : {};
        return {
          sawEvent: true,
          done: true,
          response: {
            ...response,
            status: typeof response.status === 'string'
              ? response.status
              : type === 'response.incomplete' ? 'incomplete' : 'completed'
          }
        };
      }
      case 'response.failed': {
        const response = this.isRecord(event.response) ? event.response : {};
        throw new Error(this.formatTerminalError('failed', response, language));
      }
      case 'error':
        throw new Error(this.formatEventError(event, language));
      default:
        break;
    }

    return { sawEvent: true, done: false };
  }

  private buildMessage(items: OpenAiResponsesItem[]): OpenAiResponsesStreamResult['message'] {
    const contentParts: string[] = [];
    const toolCalls: DeepSeekToolCall[] = [];
    for (const item of items) {
      if (item.type === 'message' && typeof item.content === 'string') {
        contentParts.push(item.content);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!this.isRecord(part)) {
            continue;
          }
          if (part.type === 'output_text' && typeof part.text === 'string') {
            contentParts.push(part.text);
          } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
            contentParts.push(part.refusal);
          }
        }
      } else if (item.type === 'function_call'
        && typeof item.call_id === 'string'
        && typeof item.name === 'string') {
        toolCalls.push({
          id: item.call_id,
          type: 'function',
          function: {
            name: item.name,
            arguments: typeof item.arguments === 'string' ? item.arguments : ''
          }
        });
      }
    }
    return {
      role: 'assistant',
      content: contentParts.join(''),
      reasoning_content: null,
      tool_calls: toolCalls.length ? toolCalls : null
    };
  }

  private readReplayableItems(value: unknown): OpenAiResponsesItem[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => this.cloneItem(item))
      .filter((item): item is OpenAiResponsesItem => Boolean(item && REPLAYABLE_OUTPUT_TYPES.has(item.type ?? '')));
  }

  private applyAccumulatedArguments(
    item: OpenAiResponsesItem,
    accumulated: Map<string, string>,
    outputIndex: number
  ): OpenAiResponsesItem {
    if (item.type !== 'function_call') {
      return item;
    }
    const keys = [item.id, item.call_id, `output:${outputIndex}`]
      .filter((value): value is string => typeof value === 'string');
    const argumentsText = keys.map((key) => accumulated.get(key)).find((value) => value !== undefined);
    return argumentsText === undefined ? item : { ...item, arguments: argumentsText };
  }

  private applyAccumulatedOutputText(
    items: OpenAiResponsesItem[],
    text: string
  ): OpenAiResponsesItem[] {
    const messageIndex = items.findIndex((item) => item.type === 'message');
    const content = [{ type: 'output_text', text, annotations: [] }];
    if (messageIndex < 0) {
      return [...items, { type: 'message', role: 'assistant', status: 'completed', content }];
    }
    return items.map((item, index) => index === messageIndex ? { ...item, content } : item);
  }

  private normalizeUsage(value: unknown): DeepSeekUsage | null {
    if (!this.isRecord(value)) {
      return null;
    }
    const inputTokens = this.readNonNegativeInteger(value.input_tokens, 0);
    const outputTokens = this.readNonNegativeInteger(value.output_tokens, 0);
    const cachedTokens = this.isRecord(value.input_tokens_details)
      ? this.readNonNegativeInteger(value.input_tokens_details.cached_tokens, 0)
      : 0;
    const reasoningTokens = this.isRecord(value.output_tokens_details)
      ? this.readNonNegativeInteger(value.output_tokens_details.reasoning_tokens, 0)
      : 0;
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: this.readNonNegativeInteger(value.total_tokens, inputTokens + outputTokens),
      prompt_cache_hit_tokens: cachedTokens,
      prompt_cache_miss_tokens: Math.max(0, inputTokens - cachedTokens),
      prompt_tokens_details: { cached_tokens: cachedTokens },
      completion_tokens_details: { reasoning_tokens: reasoningTokens }
    };
  }

  private formatEventError(event: Record<string, unknown>, language: KeepseekLanguage): string {
    const error = this.isRecord(event.error) ? event.error : event;
    const message = typeof error.message === 'string' ? error.message : '';
    return message || (language === 'en'
      ? 'The Responses API returned an error event.'
      : 'Responses API 返回了错误事件。');
  }

  private formatTerminalError(
    status: 'failed' | 'incomplete',
    response: CompletedResponse,
    language: KeepseekLanguage
  ): string {
    const error = this.isRecord(response.error) && typeof response.error.message === 'string'
      ? response.error.message
      : '';
    const reason = this.readNestedString(response.incomplete_details, 'reason');
    if (error) {
      return error;
    }
    return language === 'en'
      ? `The Responses API response ${status}${reason ? ` (${reason})` : ''}.`
      : `Responses API 响应${status === 'failed' ? '失败' : '未完整完成'}${reason ? `（${reason}）` : ''}。`;
  }

  private readCallAccumulatorKey(event: Record<string, unknown>): string {
    if (typeof event.item_id === 'string' && event.item_id) {
      return event.item_id;
    }
    if (typeof event.call_id === 'string' && event.call_id) {
      return event.call_id;
    }
    return `output:${this.readNonNegativeInteger(event.output_index, 0)}`;
  }

  private readNestedString(value: unknown, key: string): string | undefined {
    return this.isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
  }

  private cloneItem(value: unknown): OpenAiResponsesItem | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }
    try {
      return JSON.parse(JSON.stringify(value)) as OpenAiResponsesItem;
    } catch {
      return undefined;
    }
  }

  private recordRawSseData(data: string, options: ResponsesStreamParseOptions): void {
    if (!options.trace?.enabled || !options.trace.logRawStream || !options.trace.includesPayload('full')) {
      return;
    }
    options.trace.record({
      type: 'upstream_sse_data',
      requestId: options.requestId,
      attempt: options.attempt,
      data
    });
  }

  private readNonNegativeInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
