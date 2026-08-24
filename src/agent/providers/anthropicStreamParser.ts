import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentRunCallbacks } from '../../shared/types';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import type { DeepSeekToolCall, DeepSeekUsage } from '../deepseek/types';
import type {
  AnthropicAssistantContentBlock,
  AnthropicJsonValue,
  AnthropicMessagesStreamResult
} from './anthropicTypes';

interface AnthropicStreamParseOptions {
  trace?: AgentInteractionTrace;
  requestId?: string;
  attempt?: number;
  onStreamActivity?: () => void;
}

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
  inputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  outputTokens: number;
}

export class AnthropicStreamParser {
  public async parse(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: AnthropicStreamParseOptions = {}
  ): Promise<AnthropicMessagesStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawEvent = false;
    let sawMessageStart = false;
    let sawMessageStop = false;
    let stopReason: string | null | undefined;
    const blocks = new Map<number, BlockAccumulator>();
    const usage: UsageAccumulator = {
      inputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      outputTokens: 0
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = this.consumeFrames(buffer, (frame) => {
        sawEvent = true;
        options.onStreamActivity?.();
        this.recordRawSseData(frame.data, options);
        const event = this.parseData(frame.data, language);
        const type = typeof event.type === 'string' ? event.type : frame.event;
        switch (type) {
          case 'message_start':
            sawMessageStart = true;
            if (this.isRecord(event.message)) {
              this.mergeUsage(usage, event.message.usage);
            }
            break;
          case 'content_block_start':
            this.startBlock(blocks, event);
            break;
          case 'content_block_delta':
            this.applyDelta(blocks, event, callbacks);
            break;
          case 'content_block_stop':
            this.stopBlock(blocks, event);
            break;
          case 'message_delta':
            if (this.isRecord(event.delta) && typeof event.delta.stop_reason === 'string') {
              stopReason = event.delta.stop_reason;
            }
            this.mergeUsage(usage, event.usage);
            break;
          case 'message_stop':
            sawMessageStop = true;
            break;
          case 'error':
            throw new Error(this.formatError(event, language));
          case 'ping':
          default:
            // Unknown future event types are activity but do not change state.
            break;
        }
      });
    }

    if (buffer.trim()) {
      this.consumeFrames(`${buffer}\n\n`, (frame) => {
        sawEvent = true;
        options.onStreamActivity?.();
        const event = this.parseData(frame.data, language);
        if (event.type === 'error') {
          throw new Error(this.formatError(event, language));
        }
        throw new Error(language === 'en'
          ? 'Anthropic Messages stream ended with an incomplete SSE event.'
          : 'Anthropic Messages 流以不完整的 SSE 事件结束。');
      });
    }
    if (!sawEvent) {
      throw new Error(language === 'en'
        ? 'Anthropic Messages API did not return any streaming events.'
        : 'Anthropic Messages API 未返回任何流式事件。');
    }
    if (!sawMessageStart || !sawMessageStop) {
      throw new Error(language === 'en'
        ? 'Anthropic Messages stream ended before the message completed.'
        : 'Anthropic Messages 流在消息完成前结束。');
    }
    if ([...blocks.values()].some((block) => !block.stopped)) {
      throw new Error(language === 'en'
        ? 'Anthropic Messages stream ended with an unfinished content block.'
        : 'Anthropic Messages 流包含未完成的内容块。');
    }

    const contentBlocks = [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => this.finalizeBlock(block, language));
    if (stopReason === 'model_context_window_exceeded') {
      throw new Error(language === 'en'
        ? 'Anthropic reported that the model context window was exceeded.'
        : 'Anthropic 报告模型上下文窗口已超限。');
    }
    if (!contentBlocks.length) {
      throw new Error(language === 'en'
        ? 'Anthropic Messages API returned an empty stream.'
        : 'Anthropic Messages API 返回了空流。');
    }

    const toolCalls: DeepSeekToolCall[] = contentBlocks
      .filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input)
        }
      }));
    const text = contentBlocks
      .filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const thinking = contentBlocks
      .filter((block): block is Extract<AnthropicAssistantContentBlock, { type: 'thinking' }> => block.type === 'thinking')
      .map((block) => block.thinking)
      .join('');
    const mappedFinishReason = this.mapStopReason(stopReason, toolCalls.length);
    return {
      message: {
        role: 'assistant',
        content: text,
        reasoning_content: thinking || null,
        tool_calls: toolCalls.length ? toolCalls : null
      },
      finishReason: mappedFinishReason,
      stopReason,
      usage: this.normalizeUsage(usage),
      contentBlocks
    };
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
      }
    }
  }

  private parseData(data: string, language: KeepseekLanguage): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(data);
      if (this.isRecord(parsed)) {
        return parsed;
      }
    } catch {
      // Use the protocol-specific message below.
    }
    throw new Error(language === 'en'
      ? 'Cannot parse an Anthropic Messages SSE event as JSON.'
      : '无法将 Anthropic Messages SSE 事件解析为 JSON。');
  }

  private startBlock(blocks: Map<number, BlockAccumulator>, event: Record<string, unknown>): void {
    const index = this.readIndex(event.index);
    if (blocks.has(index) || !this.isRecord(event.content_block)) {
      throw new Error('Invalid Anthropic content_block_start event.');
    }
    const block = event.content_block;
    switch (block.type) {
      case 'text':
        blocks.set(index, { type: 'text', text: typeof block.text === 'string' ? block.text : '', stopped: false });
        return;
      case 'thinking':
        blocks.set(index, {
          type: 'thinking',
          thinking: typeof block.thinking === 'string' ? block.thinking : '',
          signature: typeof block.signature === 'string' ? block.signature : '',
          stopped: false
        });
        return;
      case 'redacted_thinking':
        if (typeof block.data !== 'string') throw new Error('Invalid Anthropic redacted_thinking block.');
        blocks.set(index, { type: 'redacted_thinking', data: block.data, stopped: false });
        return;
      case 'tool_use': {
        if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
          throw new Error('Invalid Anthropic tool_use block.');
        }
        const initialInput = block.input === undefined ? {} : this.toJsonObject(block.input);
        if (!initialInput) {
          throw new Error('Invalid Anthropic tool_use input.');
        }
        blocks.set(index, {
          type: 'tool_use', id: block.id, name: block.name, initialInput, partialJson: '', stopped: false
        });
        return;
      }
      default:
        throw new Error(`Unsupported Anthropic content block type: ${String(block.type)}`);
    }
  }

  private applyDelta(
    blocks: Map<number, BlockAccumulator>,
    event: Record<string, unknown>,
    callbacks: AgentRunCallbacks
  ): void {
    const block = blocks.get(this.readIndex(event.index));
    if (!block || block.stopped || !this.isRecord(event.delta)) {
      throw new Error('Invalid Anthropic content_block_delta event.');
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
    }
  }

  private stopBlock(blocks: Map<number, BlockAccumulator>, event: Record<string, unknown>): void {
    const block = blocks.get(this.readIndex(event.index));
    if (!block || block.stopped) {
      throw new Error('Invalid Anthropic content_block_stop event.');
    }
    block.stopped = true;
  }

  private finalizeBlock(block: BlockAccumulator, language: KeepseekLanguage): AnthropicAssistantContentBlock {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'thinking') {
      if (!block.signature) {
        throw new Error(language === 'en'
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
        if (!parsedObject) throw new Error('not an object');
        input = parsedObject;
      } catch {
        throw new Error(language === 'en'
          ? `Anthropic tool input for ${block.name} was incomplete or invalid JSON.`
          : `Anthropic 工具 ${block.name} 的输入是不完整或无效的 JSON。`);
      }
    }
    return { type: 'tool_use', id: block.id, name: block.name, input };
  }

  private mergeUsage(target: UsageAccumulator, value: unknown): void {
    if (!this.isRecord(value)) return;
    target.inputTokens = this.readNonNegativeInteger(value.input_tokens, target.inputTokens);
    target.cacheCreationInputTokens = this.readNonNegativeInteger(
      value.cache_creation_input_tokens,
      target.cacheCreationInputTokens
    );
    target.cacheReadInputTokens = this.readNonNegativeInteger(
      value.cache_read_input_tokens,
      target.cacheReadInputTokens
    );
    target.outputTokens = this.readNonNegativeInteger(value.output_tokens, target.outputTokens);
  }

  private normalizeUsage(value: UsageAccumulator): DeepSeekUsage {
    const promptTokens = value.inputTokens + value.cacheCreationInputTokens + value.cacheReadInputTokens;
    return {
      prompt_tokens: promptTokens,
      completion_tokens: value.outputTokens,
      total_tokens: promptTokens + value.outputTokens,
      prompt_cache_hit_tokens: value.cacheReadInputTokens,
      prompt_cache_miss_tokens: value.inputTokens + value.cacheCreationInputTokens,
      prompt_tokens_details: { cached_tokens: value.cacheReadInputTokens }
    };
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
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error('Invalid Anthropic content block index.');
    }
    return Math.floor(value);
  }

  private readNonNegativeInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : fallback;
  }

  private recordRawSseData(data: string, options: AnthropicStreamParseOptions): void {
    if (!options.trace?.enabled || !options.trace.logRawStream || !options.trace.includesPayload('full')) return;
    options.trace.record({
      type: 'upstream_sse_data', requestId: options.requestId, attempt: options.attempt, data
    });
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
