import { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { ProviderStreamParseOptions } from './types';
import { ProviderToolOutputTruncatedError, ProviderIncompleteStreamError, ProviderStreamProtocolError, ProviderStreamProviderError, ProviderStreamReader, ProviderStreamTextDecoder, isTruncatedJsonError, mergeProviderStreamUsage } from './streamErrors';
import { DsmlToolParser } from '../deepseek/dsmlToolParser';
import { DeepSeekStreamChunk, DeepSeekStreamResult, DeepSeekToolCall, DeepSeekToolCallDelta } from '../deepseek/types';

interface StreamingToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;

  };
}

class StreamingDsmlDisplayFilter {
  private static readonly maxMarkerLength = 40;
  private static readonly startPattern = /<[\uFF5C|]+DSML[\uFF5C|]+tool_calls>/iu;
  private static readonly endPattern = /<\/[\uFF5C|]+DSML[\uFF5C|]+tool_calls>/iu;

  private pending = '';
  private suppressing = false;

  public push(delta: string): string {
    let input = `${this.pending}${delta}`;
    this.pending = '';
    let output = '';

    while (input) {
      if (this.suppressing) {
        const endMatch = StreamingDsmlDisplayFilter.endPattern.exec(input);
        if (!endMatch || endMatch.index === undefined) {
          this.pending = input.slice(-StreamingDsmlDisplayFilter.maxMarkerLength);
          return output;
        }

        input = input.slice(endMatch.index + endMatch[0].length);
        this.suppressing = false;
        continue;
      }

      const startMatch = StreamingDsmlDisplayFilter.startPattern.exec(input);
      if (!startMatch || startMatch.index === undefined) {
        const emitLength = Math.max(0, input.length - StreamingDsmlDisplayFilter.maxMarkerLength);
        output += input.slice(0, emitLength);
        this.pending = input.slice(emitLength);
        return output;
      }

      output += input.slice(0, startMatch.index);
      input = input.slice(startMatch.index + startMatch[0].length);
      this.suppressing = true;
    }

    return output;
  }

  public flush(): string {
    if (this.suppressing) {
      this.pending = '';
      return '';
    }

    const output = this.pending;
    this.pending = '';
    return output;
  }
}

/**
 * OpenAI 兼容 SSE 流解析器。deepseek / kimi / glm / qwencloud / ollama /
 * openai-compatible 共享同一套流式协议解析，属于协议层而不是某一家服务商。
 */
export class StreamParser {
  private readonly dsmlToolParser = new DsmlToolParser();
  public async parse(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: ProviderStreamParseOptions = {}
  ): Promise<DeepSeekStreamResult> {
    const reader = body.getReader();
    const stream = new ProviderStreamReader(reader, options);
    try {
      const decoder = new ProviderStreamTextDecoder(stream);
      const contentParts: string[] = [];
      const reasoningParts: string[] = [];
      const toolCallParts = new Map<number, StreamingToolCallAccumulator>();
      const contentDisplayFilter = new StreamingDsmlDisplayFilter();
      const reasoningDisplayFilter = new StreamingDsmlDisplayFilter();
      let buffer = '';
      let finishReason: string | null | undefined;
      let usage: DeepSeekStreamResult['usage'];
      let sawChunk = false;
      let truncation: ProviderToolOutputTruncatedError | undefined;

      const validateTerminal = (): boolean => {
        if (!finishReason) return false;
        if (!['stop', 'length', 'tool_calls', 'content_filter'].includes(finishReason)) {
          throw new ProviderStreamProtocolError(`Invalid finish_reason: ${finishReason}`);
        }
        if (!contentParts.length && !reasoningParts.length && !toolCallParts.size) {
          throw new ProviderStreamProtocolError(language === 'en'
            ? 'The model API did not return any streaming chunks.' : '模型 API 未返回任何流式数据块。');
        }
        if (finishReason === 'length' && (toolCallParts.size || /<[\uFF5C|]+DSML[\uFF5C|]+(?:tool_calls|calls|invoke)/iu.test(contentParts.join('') + reasoningParts.join('')))) {
          truncation ??= new ProviderToolOutputTruncatedError(finishReason);
          stream.terminalFailure();
          return false;
        }
        if (toolCallParts.size && finishReason !== 'tool_calls' && finishReason !== 'stop') {
          throw new ProviderStreamProtocolError('Incomplete tool response / 工具响应未完成');
        }
        this.dsmlToolParser.parse(contentParts.join(''));
        this.dsmlToolParser.parse(reasoningParts.join(''));
        const toolCalls = this.buildStreamingToolCalls(toolCallParts);
        if (finishReason === 'tool_calls' && !toolCalls?.length) {
          throw new ProviderStreamProtocolError('Terminal tool response contains no tool calls.');
        }
        return true;
      };

      const consume = (rawEvent: string, final = false) => {
        stream.event();
        const eventResult = this.consumeSseEvent(
          rawEvent, language, contentParts, reasoningParts, toolCallParts,
          contentDisplayFilter, reasoningDisplayFilter, callbacks, options, final,
          stream.progress.semanticComplete, (observed) => { usage = mergeProviderStreamUsage(usage, observed); stream.publish(usage); }
        );
        sawChunk = sawChunk || eventResult.sawChunk;
        finishReason = eventResult.finishReason ?? finishReason;
        usage = mergeProviderStreamUsage(usage, eventResult.usage);
        stream.publish(usage);
        if (validateTerminal()) stream.completed(usage);
      };

      const consumeBuffer = (final = false) => {
        const trailingCr = !final && buffer.endsWith('\r');
        buffer = (trailingCr ? buffer.slice(0, -1) : buffer).replace(/\r\n?/gu, '\n') + (trailingCr ? '\r' : '');
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
          if (truncation) break;
          if (!stream.canPreserve(error)) throw error;
          stream.interruptedTail();
          break;
        }
        if (chunk.done) {
          buffer += decoder.decode();
          consumeBuffer(true);
          break;
        }
        buffer += decoder.decode(chunk.value!);
        consumeBuffer();
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
      if (truncation) throw truncation;
      // [DONE] is a framing marker, not evidence of valid model completion.
      if (!sawChunk) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'The model API did not return any streaming chunks.' : '模型 API 未返回任何流式数据块。');
      if (!validateTerminal()) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'Stream ended before completion.' : '流在完成前中断。');
      this.flushDisplayFilter(reasoningDisplayFilter, callbacks, 'reasoning');
      this.flushDisplayFilter(contentDisplayFilter, callbacks, 'content');
      return {
        message: { role: 'assistant', content: contentParts.join(''), reasoning_content: reasoningParts.join(''),
          tool_calls: this.buildStreamingToolCalls(toolCallParts) }, finishReason, usage
      };
    } finally { await stream.release(); }
  }

  private consumeSseEvent(
    rawEvent: string,
    language: KeepseekLanguage,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    contentDisplayFilter: StreamingDsmlDisplayFilter,
    reasoningDisplayFilter: StreamingDsmlDisplayFilter,
    callbacks: AgentRunCallbacks,
    options: ProviderStreamParseOptions,
    final = false,
    semanticComplete = false,
    onUsage?: (usage: NonNullable<DeepSeekStreamResult['usage']>) => void
  ): { done: boolean; sawChunk: boolean; finishReason?: string | null; usage?: DeepSeekStreamResult['usage'] } {
    if (rawEvent.split('\n').some((line) => line.startsWith(':'))) callbacks.onActivity?.('event');
    const dataLines = rawEvent
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart()).join('\n');

    let finishReason: string | null | undefined;
    let usage: DeepSeekStreamResult['usage'];
    let sawChunk = false;

    for (const data of [dataLines]) {
      if (data.trim() === '[DONE]') {
        this.recordRawSseData(data, options);
        return { done: true, sawChunk, finishReason };
      }

      if (!data.trim()) {
        continue;
      }

      this.recordRawSseData(data, options);
      const chunk = this.parseStreamChunk(data, language, final);
      callbacks.onActivity?.('event');
      if (chunk.usage) onUsage?.(chunk.usage);
      if ((chunk as unknown as { error?: unknown }).error) throw new ProviderStreamProviderError(JSON.stringify((chunk as unknown as { error: unknown }).error));
      if (semanticComplete && chunk.choices?.some((choice) => choice.delta && (choice.delta.content || choice.delta.reasoning_content || choice.delta.tool_calls?.length))) {
        throw new ProviderStreamProtocolError('Model output arrived after finish_reason.');
      }
      sawChunk = true;
      usage = chunk.usage ?? usage;
      finishReason = this.applyStreamChunk(
        chunk,
        contentParts,
        reasoningParts,
        toolCallParts,
        contentDisplayFilter,
        reasoningDisplayFilter,
        callbacks
      ) ?? finishReason;
    }

    return { done: false, sawChunk, finishReason, usage };
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

  private parseStreamChunk(data: string, language: KeepseekLanguage, final = false): DeepSeekStreamChunk {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!this.isRecord(parsed)) {
        throw new ProviderStreamProtocolError(language === 'en' ? 'Chunk is not a JSON object.' : '数据块不是 JSON 对象。');
      }
      if (parsed.choices !== undefined && (!Array.isArray(parsed.choices) || parsed.choices.some((choice) => !this.isRecord(choice)))) {
        throw new ProviderStreamProtocolError('Invalid streaming choices.');
      }
      return parsed as DeepSeekStreamChunk;
    } catch (error) {
      if (final && isTruncatedJsonError(error)) throw new ProviderIncompleteStreamError('Stream ended in an incomplete JSON event.');
      throw new ProviderStreamProtocolError(language === 'en'
        ? `Cannot parse the streaming response: ${error instanceof Error ? error.message : String(error)}`
        : `无法解析流式响应：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyStreamChunk(
    chunk: DeepSeekStreamChunk,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    contentDisplayFilter: StreamingDsmlDisplayFilter,
    reasoningDisplayFilter: StreamingDsmlDisplayFilter,
    callbacks: AgentRunCallbacks
  ): string | null | undefined {
    let finishReason: string | null | undefined;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

    for (const choice of choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) throw new ProviderStreamProtocolError('Invalid finish_reason.');
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) {
        continue;
      }
      if (!this.isRecord(delta) || (delta.tool_calls !== undefined && !Array.isArray(delta.tool_calls))) {
        throw new ProviderStreamProtocolError('Invalid streaming delta.');
      }
      for (const text of [delta.content, delta.reasoning_content]) if (text !== undefined && text !== null && typeof text !== 'string') {
        throw new ProviderStreamProtocolError('Invalid streaming text delta.');
      }

      this.collectTextDelta(typeof delta.reasoning_content === 'string' ? delta.reasoning_content : null, reasoningParts, reasoningDisplayFilter, callbacks, 'reasoning');
      this.collectTextDelta(typeof delta.content === 'string' ? delta.content : null, contentParts, contentDisplayFilter, callbacks, 'content');
      this.collectToolCallDeltas(delta.tool_calls ?? [], toolCallParts, callbacks);
    }

    return finishReason;
  }

  private collectTextDelta(
    delta: string | null | undefined,
    parts: string[],
    displayFilter: StreamingDsmlDisplayFilter,
    callbacks: AgentRunCallbacks,
    type: 'content' | 'reasoning'
  ): void {
    if (typeof delta !== 'string' || !delta) {
      return;
    }
    callbacks.onActivity?.('content');
    parts.push(delta);
    callbacks.onStatus?.({
      base: 'thinking',
      phase: type === 'reasoning' ? 'reasoning' : 'generating'
    });
    const displayDelta = displayFilter.push(delta);
    if (displayDelta) {
      callbacks.onDelta?.({ type, delta: displayDelta });
    }
  }

  private flushDisplayFilter(
    displayFilter: StreamingDsmlDisplayFilter,
    callbacks: AgentRunCallbacks,
    type: 'content' | 'reasoning'
  ): void {
    const delta = displayFilter.flush();
    if (delta) {
      callbacks.onDelta?.({ type, delta });
    }
  }

  private collectToolCallDeltas(
    toolCallDeltas: DeepSeekToolCallDelta[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): void {
    if (toolCallDeltas.length) {
      callbacks.onActivity?.('content');
      callbacks.onStatus?.({
        base: 'thinking',
        phase: 'planning_tool'
      });
    }

    for (let deltaIndex = 0; deltaIndex < toolCallDeltas.length; deltaIndex += 1) {
      const toolCallDelta = toolCallDeltas[deltaIndex];
      if (!this.isRecord(toolCallDelta) || (toolCallDelta.index !== undefined && (typeof toolCallDelta.index !== 'number' || !Number.isInteger(toolCallDelta.index) || toolCallDelta.index < 0))
        || (toolCallDelta.type !== undefined && toolCallDelta.type !== 'function')
        || (toolCallDelta.id !== undefined && typeof toolCallDelta.id !== 'string')
        || (toolCallDelta.function !== undefined && (!this.isRecord(toolCallDelta.function)
          || (toolCallDelta.function.name !== undefined && typeof toolCallDelta.function.name !== 'string')
          || (toolCallDelta.function.arguments !== undefined && typeof toolCallDelta.function.arguments !== 'string')))) {
        throw new ProviderStreamProtocolError('Invalid streaming tool call.');
      }
      const index = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : deltaIndex;
      const current = toolCallParts.get(index) ?? {
        id: '',
        type: 'function' as const,
        function: {
          name: '',
          arguments: ''
        }
      };

      if (typeof toolCallDelta.id === 'string' && toolCallDelta.id) {
        if (current.id && current.id !== toolCallDelta.id) throw new ProviderStreamProtocolError('Conflicting tool call identity.');
        current.id = toolCallDelta.id;
      }
      if (toolCallDelta.type === 'function') {
        current.type = 'function';
      }
      if (typeof toolCallDelta.function?.name === 'string') {
        current.function.name += toolCallDelta.function.name;
      }
      if (typeof toolCallDelta.function?.arguments === 'string') {
        current.function.arguments += toolCallDelta.function.arguments;
      }

      toolCallParts.set(index, current);
    }
  }

  private buildStreamingToolCalls(toolCallParts: Map<number, StreamingToolCallAccumulator>): DeepSeekToolCall[] | null {
    const toolCalls = Array.from(toolCallParts.entries())
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([, toolCall]) => ({ id: toolCall.id, type: 'function' as const,
        function: { name: toolCall.function.name, arguments: toolCall.function.arguments } }));
    const ids = new Set<string>();
    for (const call of toolCalls) {
      if (!call.id || !call.function.name || ids.has(call.id)) {
        throw new ProviderStreamProtocolError('Incomplete or duplicate tool call identity / 工具调用标识不完整或重复');
      }
      ids.add(call.id);
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); }
      catch { throw new ProviderStreamProtocolError('Incomplete tool arguments / 工具参数不完整'); }
      if (!this.isRecord(args)) throw new ProviderStreamProtocolError('Incomplete tool arguments / 工具参数不完整');
    }
    return toolCalls.length ? toolCalls : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
