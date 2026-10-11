import type { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { ProviderStreamParseOptions } from './types';
import { ProviderIncompleteStreamError, ProviderStreamProtocolError, ProviderStreamProviderError, ProviderStreamReader, ProviderStreamTextDecoder, isTruncatedJsonError, mergeProviderStreamUsage } from './streamErrors';
import type { DeepSeekToolCall, DeepSeekUsage } from '../deepseek/types';
import type {
  OpenAiResponsesItem,
  OpenAiResponsesStreamResult
} from './responsesTypes';

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
    options: ProviderStreamParseOptions = {}
  ): Promise<OpenAiResponsesStreamResult> {
    const reader = body.getReader();
    const stream = new ProviderStreamReader(reader, options);
    try {
      const decoder = new ProviderStreamTextDecoder(stream);
      const streamedText: string[] = [];
      const streamedReasoningSummary: string[] = [];
      const outputItems = new Map<number, OpenAiResponsesItem>();
      const functionArguments = new Map<string, string>();
      let buffer = '';
      let sawEvent = false;
      let terminalResponse: CompletedResponse | undefined;
      let usage: DeepSeekUsage | null | undefined;
      let finalResult: OpenAiResponsesStreamResult | undefined;
      const state = { streamedText, streamedReasoningSummary, outputItems, functionArguments, options };

      const consume = (rawEvent: string, final = false) => {
        stream.event();
        const result = this.consumeEvent(rawEvent, language, callbacks, state, final,
          stream.progress.semanticComplete, (observed) => { usage = mergeProviderStreamUsage(usage, observed); stream.publish(usage); });
        sawEvent = sawEvent || result.sawEvent;
        terminalResponse = result.response ?? terminalResponse;
        if (terminalResponse) {
          finalResult = this.finalizeResponse(terminalResponse, state, language, usage);
          stream.completed(finalResult.usage);
        }
      };

      const consumeBufferedEvents = (final = false) => {
        const trailingCarriageReturn = !final && buffer.endsWith('\r');
        const normalizable = trailingCarriageReturn ? buffer.slice(0, -1) : buffer;
        buffer = normalizable.replace(/\r\n?/gu, '\n') + (trailingCarriageReturn ? '\r' : '');
        let separatorIndex = buffer.indexOf('\n\n');
        while (separatorIndex >= 0) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          consume(rawEvent);
          separatorIndex = buffer.indexOf('\n\n');
        }
      };
      while (true) {
        let chunk: { done: boolean; value?: Uint8Array };
        try { chunk = await stream.read(); }
        catch (error) {
          if (!stream.canPreserve(error)) throw error;
          stream.interruptedTail();
          break;
        }
        if (chunk.done) {
          buffer += decoder.decode();
          consumeBufferedEvents(true);
          break;
        }
        buffer += decoder.decode(chunk.value!);
        consumeBufferedEvents();
      }
      if (buffer.trim()) {
        try { consume(buffer.trim(), true); }
        catch (error) {
          // A transport cutoff may leave an unfinished tail frame, but a whole
          // provider error or invalid protocol event still overrides completion.
          if (!stream.progress.semanticComplete || !(error instanceof ProviderIncompleteStreamError)) throw error;
          stream.interruptedTail();
        }
      }
      if (!sawEvent) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'The Responses API did not return any streaming events.' : 'Responses API 未返回任何流式事件。');
      if (!finalResult) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'Responses stream ended before a terminal response.' : 'Responses 流未收到完整终态响应。');
      const finalVisibleText = finalResult.message.content ?? '';
      if (!streamedText.length && finalVisibleText) {
        callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
        callbacks.onDelta?.({ type: 'content', delta: finalVisibleText });
      }
      return finalResult;
    } finally { await stream.release(); }
  }

  private finalizeResponse(
    response: CompletedResponse,
    state: { streamedText: string[]; outputItems: Map<number, OpenAiResponsesItem>; functionArguments: Map<string, string> },
    language: KeepseekLanguage,
    observedUsage?: DeepSeekUsage | null
  ): OpenAiResponsesStreamResult {
    const status = response.status;
    const incompleteReason = this.readNestedString(response.incomplete_details, 'reason');
    if (response.error || status === 'failed') throw new ProviderStreamProviderError(this.formatTerminalError('failed', response, language));
    if ((status === 'incomplete' || incompleteReason) && incompleteReason !== 'max_output_tokens') {
      throw new ProviderStreamProviderError(this.formatTerminalError('incomplete', response, language));
    }
    if (status !== 'completed' && status !== 'incomplete') throw new ProviderStreamProtocolError('Invalid Responses terminal status.');
    const authoritativeItems = this.readReplayableItems(response.output);
    let replayItems = response.output !== undefined ? authoritativeItems
      : Array.from(state.outputItems.entries()).sort(([left], [right]) => left - right)
        .map(([index, item]) => this.applyAccumulatedArguments(item, state.functionArguments, index));
    if (state.streamedText.length && !this.buildMessage(replayItems).content) {
      replayItems = this.applyAccumulatedOutputText(replayItems, state.streamedText.join(''));
    }
    for (const item of replayItems) if (item.status !== undefined && item.status !== 'completed'
      && !(item.status === 'incomplete' && status === 'incomplete' && item.type !== 'function_call')) {
      throw new ProviderStreamProtocolError('Responses terminal output contains an unfinished item.');
    }
    const message = this.buildMessage(replayItems);
    const toolCalls = message.tool_calls ?? [];
    if (status === 'incomplete' && toolCalls.length) throw new ProviderStreamProtocolError('Incomplete Responses tool call / Responses 工具调用不完整');
    const ids = new Set<string>();
    for (const call of toolCalls) {
      if (!call.id || !call.function.name || ids.has(call.id)) throw new ProviderStreamProtocolError('Invalid or duplicate Responses tool identity.');
      ids.add(call.id);
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); }
      catch { throw new ProviderStreamProtocolError('Invalid tool arguments'); }
      if (!this.isRecord(args)) throw new ProviderStreamProtocolError('Invalid tool arguments');
    }
    const knownKeys = new Set<string>();
    for (const [index, item] of state.outputItems) {
      if (item.type !== 'function_call') continue;
      if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name
        || !toolCalls.some((call) => call.id === item.call_id && call.function.name === item.name)) {
        throw new ProviderStreamProtocolError('Completed Responses output omitted or damaged a seen tool call.');
      }
      for (const key of [item.id, item.call_id, `output:${index}`]) if (typeof key === 'string') knownKeys.add(key);
    }
    for (const item of replayItems) if (item.type === 'function_call') {
      for (const key of [item.id, item.call_id]) if (typeof key === 'string') knownKeys.add(key);
    }
    for (const key of state.functionArguments.keys()) if (!knownKeys.has(key)) {
      throw new ProviderStreamProtocolError('Responses arguments did not belong to a complete tool call.');
    }
    if (!replayItems.length) throw new ProviderStreamProtocolError('Responses API returned an empty completed output.');
    return { message, finishReason: toolCalls.length ? 'tool_calls' : incompleteReason === 'max_output_tokens' ? 'length' : 'stop',
      usage: mergeProviderStreamUsage(observedUsage, this.normalizeUsage(response.usage)) ?? null, outputItems: replayItems };
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
      options: ProviderStreamParseOptions;
    },
    final = false,
    semanticComplete = false,
    onUsage?: (usage: DeepSeekUsage) => void
  ): { sawEvent: boolean; done: boolean; response?: CompletedResponse } {
    if (rawEvent.split('\n').some((line) => line.startsWith(':'))) callbacks.onActivity?.('event');
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
      if (final && isTruncatedJsonError(error)) throw new ProviderIncompleteStreamError('Responses stream ended in an incomplete JSON event.');
      throw new ProviderStreamProtocolError(language === 'en'
        ? `Cannot parse the Responses streaming event: ${error instanceof Error ? error.message : String(error)}`
        : `无法解析 Responses 流式事件：${error instanceof Error ? error.message : String(error)}`);
    }

    callbacks.onActivity?.('event');
    const type = typeof event.type === 'string' ? event.type : '';
    if (!type) throw new ProviderStreamProtocolError('Responses event type is missing.');
    const observedUsage = this.normalizeUsage(this.isRecord(event.response) ? event.response.usage : event.usage);
    if (observedUsage) onUsage?.(observedUsage);
    if (semanticComplete && /\.(?:delta|done|added)$/u.test(type) && type !== 'response.done') {
      throw new ProviderStreamProtocolError('Responses output arrived after its terminal response.');
    }
    if (type.endsWith('.delta')) callbacks.onActivity?.('content');
    switch (type) {
      case 'response.output_text.delta': {
        if (typeof event.delta !== 'string') throw new ProviderStreamProtocolError('Invalid Responses text delta.');
        const delta = event.delta;
        if (delta) {
          state.streamedText.push(delta);
          callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
          callbacks.onDelta?.({ type: 'content', delta });
        }
        break;
      }
      case 'response.output_text.done': {
        if (typeof event.text !== 'string') throw new ProviderStreamProtocolError('Invalid Responses completed text.');
        if (!state.streamedText.length && typeof event.text === 'string' && event.text) {
          state.streamedText.push(event.text);
          callbacks.onStatus?.({ base: 'thinking', phase: 'generating' });
          callbacks.onDelta?.({ type: 'content', delta: event.text });
        }
        break;
      }
      case 'response.reasoning_summary_text.delta': {
        if (typeof event.delta !== 'string') throw new ProviderStreamProtocolError('Invalid Responses text delta.');
        const delta = event.delta;
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
        if (!item || !REPLAYABLE_OUTPUT_TYPES.has(item.type ?? '')) throw new ProviderStreamProtocolError('Invalid Responses output item.');
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
          if (typeof event.delta !== 'string') throw new ProviderStreamProtocolError('Invalid Responses argument delta.');
          state.functionArguments.set(key, `${current}${event.delta}`);
        } else {
          if (typeof event.arguments !== 'string') throw new ProviderStreamProtocolError('Invalid Responses completed arguments.');
          state.functionArguments.set(key, event.arguments);
        }
        callbacks.onStatus?.({ base: 'thinking', phase: 'planning_tool' });
        break;
      }
      case 'response.completed':
      case 'response.incomplete': {
        if (!this.isRecord(event.response)) throw new ProviderStreamProtocolError('Invalid Responses terminal event.');
        const response = event.response;
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
        if (!this.isRecord(event.response)) throw new ProviderStreamProtocolError('Invalid Responses terminal event.');
        const response = event.response;
        throw new ProviderStreamProviderError(this.formatTerminalError('failed', response, language));
      }
      case 'error':
        throw new ProviderStreamProviderError(this.formatEventError(event, language));
      default:
        break;
    }

    return { sawEvent: true, done: false };
  }

  private buildMessage(items: OpenAiResponsesItem[]): OpenAiResponsesStreamResult['message'] {
    const contentParts: string[] = [];
    const toolCalls: DeepSeekToolCall[] = [];
    for (const item of items) {
      if (item.type === 'message' && typeof item.content !== 'string' && !Array.isArray(item.content)) {
        throw new ProviderStreamProtocolError('Invalid Responses message content.');
      }
      if (item.type === 'message' && typeof item.content === 'string') {
        contentParts.push(item.content);
      } else if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!this.isRecord(part) || !['output_text', 'refusal'].includes(String(part.type))
            || (part.type === 'output_text' && typeof part.text !== 'string')
            || (part.type === 'refusal' && typeof part.refusal !== 'string')) {
            throw new ProviderStreamProtocolError('Invalid Responses output content part.');
          }
          if (part.type === 'output_text' && typeof part.text === 'string') {
            contentParts.push(part.text);
          } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
            contentParts.push(part.refusal);
          }
        }
      } else if (item.type === 'function_call') {
        if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || !item.name || typeof item.arguments !== 'string') {
          throw new ProviderStreamProtocolError('Invalid Responses function call.');
        }
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
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new ProviderStreamProtocolError('Invalid Responses output array.');
    return value.map((rawItem) => {
      const item = this.cloneItem(rawItem);
      if (!item || !REPLAYABLE_OUTPUT_TYPES.has(item.type ?? '')) throw new ProviderStreamProtocolError('Invalid Responses replay output item.');
      return item;
    });
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
    if (!this.isRecord(value)) return null;
    const count = (tokens: unknown): number | undefined => typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0
      ? Math.floor(tokens) : undefined;
    const inputTokens = count(value.input_tokens);
    const outputTokens = count(value.output_tokens);
    const cachedTokens = this.isRecord(value.input_tokens_details) ? count(value.input_tokens_details.cached_tokens) : undefined;
    const reasoningTokens = this.isRecord(value.output_tokens_details) ? count(value.output_tokens_details.reasoning_tokens) : undefined;
    const totalTokens = count(value.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
    const usage: DeepSeekUsage = {};
    if (inputTokens !== undefined) {
      usage.prompt_tokens = inputTokens;
      if (cachedTokens !== undefined) {
        usage.prompt_cache_hit_tokens = cachedTokens;
        usage.prompt_cache_miss_tokens = Math.max(0, inputTokens - cachedTokens);
        usage.prompt_tokens_details = { cached_tokens: cachedTokens };
      }
    }
    if (outputTokens !== undefined) usage.completion_tokens = outputTokens;
    if (totalTokens !== undefined) usage.total_tokens = totalTokens;
    if (reasoningTokens !== undefined) usage.completion_tokens_details = { reasoning_tokens: reasoningTokens };
    return Object.keys(usage).length ? usage : null;
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

  private recordRawSseData(data: string, options: ProviderStreamParseOptions): void {
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
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new ProviderStreamProtocolError('Invalid Responses output index.');
    return value;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
