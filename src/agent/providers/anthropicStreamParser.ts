import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentRunCallbacks } from '../../shared/types';
import type { ProviderStreamParseOptions } from './types';
import { ProviderToolOutputTruncatedError, ProviderIncompleteStreamError, ProviderStreamProtocolError, ProviderStreamProviderError, ProviderStreamReader, ProviderStreamTextDecoder, isTruncatedJsonError } from './streamErrors';
import type { DeepSeekToolCall, DeepSeekUsage } from '../deepseek/types';
import type {
  AnthropicAssistantContentBlock,
  AnthropicJsonValue,
  AnthropicMessagesStreamResult
} from './anthropicTypes';

type BlockAccumulator =
  | { type: 'text'; text: string; stopped: boolean }
  | { type: 'thinking'; thinking: string; signature: string; stopped: boolean }
  | { type: 'redacted_thinking'; data: string; stopped: boolean }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      initialInput: Record<string, AnthropicJsonValue>;
      partialJson: string;
      stopped: boolean;
    };

interface UsageAccumulator {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
}

export class AnthropicStreamParser {
  public async parse(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: ProviderStreamParseOptions = {}
  ): Promise<AnthropicMessagesStreamResult> {
    const reader = body.getReader();
    const stream = new ProviderStreamReader(reader, options);
    try {
      const decoder = new ProviderStreamTextDecoder(stream);
      let buffer = '';
      let sawEvent = false;
      let sawMessageStart = false;
      let sawMessageStop = false;
      let stopReason: string | null | undefined;
      const blocks = new Map<number, BlockAccumulator>();
      const usage: UsageAccumulator = {};
      let finalResult: AnthropicMessagesStreamResult | undefined;
      const visit = (frame: { event?: string; data: string }, final = false) => {
        sawEvent = true;
        stream.event();
        callbacks.onActivity?.('event');
        this.recordRawSseData(frame.data, options);
        const event = this.parseData(frame.data, language, final);
        const type = typeof event.type === 'string' ? event.type : frame.event;
        if (sawMessageStop && type !== 'ping' && type !== 'error') {
          throw new ProviderStreamProtocolError('Anthropic event arrived after message_stop.');
        }
        if (type === 'content_block_delta') callbacks.onActivity?.('content');
        switch (type) {
          case 'message_start':
            if (sawMessageStart || !this.isRecord(event.message)) throw new ProviderStreamProtocolError('Invalid Anthropic message_start event.');
            sawMessageStart = true;
            this.mergeUsage(usage, event.message.usage);
            break;
          case 'content_block_start':
            if (!sawMessageStart) throw new ProviderStreamProtocolError('Anthropic content arrived before message_start.');
            this.startBlock(blocks, event);
            break;
          case 'content_block_delta': this.applyDelta(blocks, event, callbacks); break;
          case 'content_block_stop': this.stopBlock(blocks, event); break;
          case 'message_delta':
            if (!sawMessageStart || !this.isRecord(event.delta)) throw new ProviderStreamProtocolError('Invalid Anthropic message_delta event.');
            if (typeof event.delta.stop_reason === 'string') stopReason = event.delta.stop_reason;
            this.mergeUsage(usage, event.usage);
            break;
          case 'message_stop': sawMessageStop = true; break;
          case 'error': throw new ProviderStreamProviderError(this.formatError(event, language));
          case 'ping':
          default: break;
        }
        stream.publish(this.normalizeUsage(usage));
        if (stopReason === 'max_tokens' && [...blocks.values()].some((block) => block.type === 'tool_use')) stream.terminalFailure();
        if (sawMessageStop) {
          finalResult = this.finalizeMessage(sawMessageStart, blocks, stopReason, usage, language);
          stream.completed(finalResult.usage);
        }
      };
      while (true) {
        let chunk: { done: boolean; value?: Uint8Array };
        try { chunk = await stream.read(); }
        catch (error) {
          if (stopReason === 'max_tokens' && [...blocks.values()].some((block) => block.type === 'tool_use')) throw new ProviderToolOutputTruncatedError(stopReason);
          if (!stream.canPreserve(error)) throw error;
          stream.interruptedTail();
          break;
        }
        if (chunk.done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(chunk.value!);
        buffer = this.consumeFrames(buffer, visit);
      }
      if (buffer.trim()) {
        try { this.consumeFrames(`${buffer}\n\n`, (frame) => visit(frame, true)); }
        catch (error) {
          if (!stream.progress.semanticComplete || !(error instanceof ProviderIncompleteStreamError)) throw error;
          stream.interruptedTail();
        }
      }
      if (!sawEvent) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'Anthropic Messages API did not return any streaming events.' : 'Anthropic Messages API 未返回任何流式事件。');
      if (!finalResult && stopReason === 'max_tokens' && [...blocks.values()].some((block) => block.type === 'tool_use')) throw new ProviderToolOutputTruncatedError(stopReason);
      if (!finalResult) throw new ProviderIncompleteStreamError(language === 'en'
        ? 'Anthropic Messages stream ended before the message completed.' : 'Anthropic Messages 流在消息完成前结束。');
      return finalResult;
    } finally { await stream.release(); }
  }

  private finalizeMessage(
    sawMessageStart: boolean,
    blocks: Map<number, BlockAccumulator>,
    stopReason: string | null | undefined,
    usage: UsageAccumulator,
    language: KeepseekLanguage
  ): AnthropicMessagesStreamResult {
    if (stopReason === 'max_tokens' && [...blocks.values()].some((block) => block.type === 'tool_use')) {
      throw new ProviderToolOutputTruncatedError(stopReason);
    }
    if (!sawMessageStart) throw new ProviderStreamProtocolError('Anthropic message_stop arrived before message_start.');
    if ([...blocks.values()].some((block) => !block.stopped)) throw new ProviderStreamProtocolError(language === 'en'
      ? 'Anthropic Messages stream ended with an unfinished content block.' : 'Anthropic Messages 流包含未完成的内容块。');
    const contentBlocks = [...blocks.entries()].sort(([left], [right]) => left - right)
      .map(([, block]) => this.finalizeBlock(block, language));
    if (stopReason === 'model_context_window_exceeded') throw new ProviderStreamProviderError(language === 'en'
      ? 'Anthropic reported that the model context window was exceeded.' : 'Anthropic 报告模型上下文窗口已超限。');
    if (!stopReason || !['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'pause_turn', 'refusal'].includes(stopReason)) {
      throw new ProviderStreamProtocolError('Anthropic message completed without a valid stop_reason.');
    }
    if (!contentBlocks.length) throw new ProviderStreamProtocolError(language === 'en'
      ? 'Anthropic Messages API returned an empty stream.' : 'Anthropic Messages API 返回了空流。');
    const toolCalls: DeepSeekToolCall[] = contentBlocks
      .filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }));
    if ((toolCalls.length > 0) !== (stopReason === 'tool_use')) throw new ProviderStreamProtocolError('Incomplete Anthropic tool response.');
    if (new Set(toolCalls.map((call) => call.id)).size !== toolCalls.length) throw new ProviderStreamProtocolError('Duplicate Anthropic tool identity.');
    const text = contentBlocks.filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text).join('');
    const thinking = contentBlocks.filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'thinking' }> => block.type === 'thinking')
      .map((block) => block.thinking).join('');
    return { message: { role: 'assistant', content: text, reasoning_content: thinking || null, tool_calls: toolCalls.length ? toolCalls : null },
      finishReason: this.mapStopReason(stopReason, toolCalls.length), stopReason, usage: this.normalizeUsage(usage), contentBlocks };
  }

  private consumeFrames(
    input: string,
    visit: (frame: { event?: string; data: string }) => void
  ): string {
    // A CRLF separator may itself be split across two network chunks. Keep a
    // trailing CR pending until the next chunk so it is not counted as a full
    // newline and then followed by a second LF.
    const trailingCr = input.endsWith('\r') ? '\r' : '';
    const stableInput = trailingCr ? input.slice(0, -1) : input;
    const normalized = stableInput.replace(/\r\n?/gu, '\n');
    let start = 0;
    while (true) {
      const boundary = normalized.indexOf('\n\n', start);
      if (boundary < 0) {
        return normalized.slice(start) + trailingCr;
      }
      const rawFrame = normalized.slice(start, boundary);
      start = boundary + 2;
      if (!rawFrame.trim()) {
        continue;
      }
      let event: string | undefined;
      const data: string[] = [];
      for (const line of rawFrame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /u, ''));
        }
      }
      if (data.length) {
        visit({ event, data: data.join('\n') });
      } else if (rawFrame.split('\n').some((line) => line.startsWith(':'))) {
        visit({ event: 'ping', data: '{"type":"ping"}' });
      }
    }
  }

  private parseData(data: string, language: KeepseekLanguage, final = false): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(data);
      if (this.isRecord(parsed)) {
        return parsed;
      }
    } catch (error) {
      if (final && isTruncatedJsonError(error)) throw new ProviderIncompleteStreamError('Anthropic stream ended in an incomplete JSON event.');
    }
    throw new ProviderStreamProtocolError(language === 'en'
      ? 'Cannot parse an Anthropic Messages SSE event as JSON.'
      : '无法将 Anthropic Messages SSE 事件解析为 JSON。');
  }

  private startBlock(blocks: Map<number, BlockAccumulator>, event: Record<string, unknown>): void {
    const index = this.readIndex(event.index);
    if (blocks.has(index) || !this.isRecord(event.content_block)) {
      throw new ProviderStreamProtocolError('Invalid Anthropic content_block_start event.');
    }
    const block = event.content_block;
    switch (block.type) {
      case 'text':
        if (typeof block.text !== 'string') throw new ProviderStreamProtocolError('Invalid Anthropic text block.');
        blocks.set(index, { type: 'text', text: typeof block.text === 'string' ? block.text : '', stopped: false });
        return;
      case 'thinking':
        if (typeof block.thinking !== 'string' || (block.signature !== undefined && typeof block.signature !== 'string')) {
          throw new ProviderStreamProtocolError('Invalid Anthropic thinking block.');
        }
        blocks.set(index, {
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
          stopped: false
        });
        return;
      case 'redacted_thinking':
        if (typeof block.data !== 'string') throw new ProviderStreamProtocolError('Invalid Anthropic redacted_thinking block.');
        blocks.set(index, { type: 'redacted_thinking', data: block.data, stopped: false });
        return;
      case 'tool_use': {
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
          throw new ProviderStreamProtocolError('Invalid Anthropic tool_use block.');
        }
        const initialInput = block.input === undefined ? {} : this.toJsonObject(block.input);
        if (!initialInput) {
          throw new ProviderStreamProtocolError('Invalid Anthropic tool_use input.');
        }
        blocks.set(index, {
          type: 'tool_use', id: block.id, name: block.name, initialInput, partialJson: '', stopped: false
        });
        return;
      }
      default:
        throw new ProviderStreamProtocolError(`Unsupported Anthropic content block type: ${String(block.type)}`);
    }
  }

  private applyDelta(
    blocks: Map<number, BlockAccumulator>,
    event: Record<string, unknown>,
    callbacks: AgentRunCallbacks
  ): void {
    const block = blocks.get(this.readIndex(event.index));
    if (!block || block.stopped || !this.isRecord(event.delta)) {
      throw new ProviderStreamProtocolError('Invalid Anthropic content_block_delta event.');
    }
    const delta = event.delta;
    if (delta.type === 'text_delta' && block.type === 'text' && typeof delta.text === 'string') {
      block.text += delta.text;
      callbacks.onDelta?.({ type: 'content', delta: delta.text });
    } else if (delta.type === 'thinking_delta' && block.type === 'thinking' && typeof delta.thinking === 'string') {
      block.thinking += delta.thinking;
      callbacks.onDelta?.({ type: 'reasoning', delta: delta.thinking });
    } else if (delta.type === 'signature_delta' && block.type === 'thinking' && typeof delta.signature === 'string') {
      block.signature += delta.signature;
    } else if (delta.type === 'input_json_delta' && block.type === 'tool_use' && typeof delta.partial_json === 'string') {
      block.partialJson += delta.partial_json;
    } else {
      throw new ProviderStreamProtocolError('Invalid Anthropic delta type for content block.');
    }
  }

  private stopBlock(blocks: Map<number, BlockAccumulator>, event: Record<string, unknown>): void {
    const block = blocks.get(this.readIndex(event.index));
    if (!block || block.stopped) {
      throw new ProviderStreamProtocolError('Invalid Anthropic content_block_stop event.');
    }
    block.stopped = true;
  }

  private finalizeBlock(block: BlockAccumulator, language: KeepseekLanguage): AnthropicAssistantContentBlock {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') {
      if (!block.signature) {
        throw new ProviderStreamProtocolError(language === 'en'
          ? 'Anthropic thinking block completed without a signature.'
          : 'Anthropic Thinking 内容块完成时缺少签名。');
      }
      return { type: 'thinking', thinking: block.thinking, signature: block.signature };
    }
    if (block.type === 'redacted_thinking') {
      return { type: 'redacted_thinking', data: block.data };
    }
    let input: Record<string, AnthropicJsonValue> = block.initialInput;
    if (block.partialJson) {
      try {
        const parsed: unknown = JSON.parse(block.partialJson);
        const parsedObject = this.toJsonObject(parsed);
        if (!parsedObject) throw new ProviderStreamProtocolError('not an object');
        input = parsedObject;
      } catch {
        throw new ProviderStreamProtocolError(language === 'en'
          ? `Anthropic tool input for ${block.name} was incomplete or invalid JSON.`
          : `Anthropic 工具 ${block.name} 的输入是不完整或无效的 JSON。`);
      }
    }
    return { type: 'tool_use', id: block.id, name: block.name, input };
  }

  private mergeUsage(target: UsageAccumulator, value: unknown): void {
    if (!this.isRecord(value)) return;
    const fields = { input_tokens: 'inputTokens', cache_creation_input_tokens: 'cacheCreationInputTokens',
      cache_read_input_tokens: 'cacheReadInputTokens', output_tokens: 'outputTokens' } as const;
    for (const [source, destination] of Object.entries(fields)) {
      const tokens = value[source];
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) target[destination] = Math.floor(tokens);
    }
  }

  private normalizeUsage(value: UsageAccumulator): DeepSeekUsage | null {
    if (!Object.keys(value).length) return null;
    const promptTokens = value.inputTokens === undefined ? undefined
      : value.inputTokens + (value.cacheCreationInputTokens ?? 0) + (value.cacheReadInputTokens ?? 0);
    const usage: DeepSeekUsage = {};
    if (promptTokens !== undefined) {
      usage.prompt_tokens = promptTokens;
      usage.prompt_cache_hit_tokens = value.cacheReadInputTokens ?? 0;
      usage.prompt_cache_miss_tokens = value.inputTokens! + (value.cacheCreationInputTokens ?? 0);
      usage.prompt_tokens_details = { cached_tokens: value.cacheReadInputTokens ?? 0 };
    }
    if (value.outputTokens !== undefined) usage.completion_tokens = value.outputTokens;
    if (promptTokens !== undefined && value.outputTokens !== undefined) usage.total_tokens = promptTokens + value.outputTokens;
    return usage;
  }

  private mapStopReason(stopReason: string | null | undefined, toolCallCount: number): string | null {
    switch (stopReason) {
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      case 'pause_turn': return 'pause_turn';
      case 'refusal': return 'refusal';
      case 'stop_sequence': return 'stop_sequence';
      case 'end_turn': return 'stop';
      default: return toolCallCount ? 'tool_calls' : stopReason ?? null;
    }
  }

  private formatError(event: Record<string, unknown>, language: KeepseekLanguage): string {
    const error = this.isRecord(event.error) ? event.error : event;
    const type = typeof error.type === 'string' ? error.type : 'error';
    const message = typeof error.message === 'string' ? error.message : '';
    return message || (language === 'en'
      ? `Anthropic Messages stream returned ${type}.`
      : `Anthropic Messages 流返回错误 ${type}。`);
  }

  private toJsonObject(value: unknown): Record<string, AnthropicJsonValue> | undefined {
    if (!this.isRecord(value)) return undefined;
    const result: Record<string, AnthropicJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = this.toJsonValue(entry);
      if (normalized === undefined) {
        return undefined;
      }
      result[key] = normalized;
    }
    return result;
  }

  private toJsonValue(value: unknown): AnthropicJsonValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : undefined;
    }
    if (Array.isArray(value)) {
      const result: AnthropicJsonValue[] = [];
      for (const entry of value) {
        const normalized = this.toJsonValue(entry);
        if (normalized === undefined) return undefined;
        result.push(normalized);
      }
      return result;
    }
    return this.toJsonObject(value);
  }

  private readIndex(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new ProviderStreamProtocolError('Invalid Anthropic content block index.');
    }
    return Math.floor(value);
  }

  private recordRawSseData(data: string, options: ProviderStreamParseOptions): void {
    if (!options.trace?.enabled || !options.trace.logRawStream || !options.trace.includesPayload('full')) return;
    options.trace.record({
      type: 'upstream_sse_data', requestId: options.requestId, attempt: options.attempt, data
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
