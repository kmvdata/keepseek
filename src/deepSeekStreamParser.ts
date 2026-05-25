import { AgentRunCallbacks } from './types';
import type { KeepseekLanguage } from './i18n';
import { DeepSeekStreamChunk, DeepSeekStreamResult, DeepSeekToolCall, DeepSeekToolCallDelta } from './deepSeekTypes';

interface StreamingToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export class DeepSeekStreamParser {
  public async parse(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    onStreamActivity?: () => void
  ): Promise<DeepSeekStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallParts = new Map<number, StreamingToolCallAccumulator>();
    let buffer = '';
    let finishReason: string | null | undefined;
    let streamDone = false;
    let sawChunk = false;

    const normalizeAndConsumeBuffer = () => {
      buffer = buffer.replace(/\r\n?/gu, '\n');

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventResult = this.consumeSseEvent(rawEvent, language, contentParts, reasoningParts, toolCallParts, callbacks);
        sawChunk = sawChunk || eventResult.sawChunk;
        finishReason = eventResult.finishReason ?? finishReason;
        streamDone = eventResult.done;
        if (streamDone) {
          break;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    };

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        normalizeAndConsumeBuffer();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      onStreamActivity?.();
      normalizeAndConsumeBuffer();
    }

    const remaining = buffer.trim();
    if (remaining && !streamDone) {
      const eventResult = this.consumeSseEvent(remaining, language, contentParts, reasoningParts, toolCallParts, callbacks);
      sawChunk = sawChunk || eventResult.sawChunk;
      finishReason = eventResult.finishReason ?? finishReason;
    }

    if (!sawChunk) {
      throw new Error(language === 'en'
        ? 'DeepSeek API did not return any streaming chunks.'
        : 'DeepSeek API 未返回任何流式数据块。');
    }

    return {
      message: {
        role: 'assistant',
        content: contentParts.join(''),
        reasoning_content: reasoningParts.join(''),
        tool_calls: this.buildStreamingToolCalls(toolCallParts)
      },
      finishReason
    };
  }

  private consumeSseEvent(
    rawEvent: string,
    language: KeepseekLanguage,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): { done: boolean; sawChunk: boolean; finishReason?: string | null } {
    const dataLines = rawEvent
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());

    let finishReason: string | null | undefined;
    let sawChunk = false;

    for (const data of dataLines) {
      if (data.trim() === '[DONE]') {
        return { done: true, sawChunk, finishReason };
      }

      if (!data.trim()) {
        continue;
      }

      const chunk = this.parseStreamChunk(data, language);
      sawChunk = true;
      finishReason = this.applyStreamChunk(chunk, contentParts, reasoningParts, toolCallParts, callbacks) ?? finishReason;
    }

    return { done: false, sawChunk, finishReason };
  }

  private parseStreamChunk(data: string, language: KeepseekLanguage): DeepSeekStreamChunk {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!this.isRecord(parsed)) {
        throw new Error(language === 'en' ? 'Chunk is not a JSON object.' : '数据块不是 JSON 对象。');
      }
      return parsed as DeepSeekStreamChunk;
    } catch (error) {
      throw new Error(language === 'en'
        ? `Cannot parse DeepSeek streaming response: ${error instanceof Error ? error.message : String(error)}`
        : `无法解析 DeepSeek 流式响应：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyStreamChunk(
    chunk: DeepSeekStreamChunk,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): string | null | undefined {
    let finishReason: string | null | undefined;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

    for (const choice of choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      this.collectTextDelta(delta.reasoning_content, reasoningParts, callbacks, 'reasoning');
      this.collectTextDelta(delta.content, contentParts, callbacks, 'content');
      this.collectToolCallDeltas(delta.tool_calls ?? [], toolCallParts, callbacks);
    }

    return finishReason;
  }

  private collectTextDelta(
    delta: string | null | undefined,
    parts: string[],
    callbacks: AgentRunCallbacks,
    type: 'content' | 'reasoning'
  ): void {
    if (typeof delta !== 'string' || !delta) {
      return;
    }
    parts.push(delta);
    callbacks.onStatus?.({
      base: 'thinking',
      phase: type === 'reasoning' ? 'reasoning' : 'generating'
    });
    callbacks.onDelta?.({ type, delta });
  }

  private collectToolCallDeltas(
    toolCallDeltas: DeepSeekToolCallDelta[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): void {
    if (toolCallDeltas.length) {
      callbacks.onStatus?.({
        base: 'thinking',
        phase: 'planning_tool'
      });
    }

    for (let deltaIndex = 0; deltaIndex < toolCallDeltas.length; deltaIndex += 1) {
      const toolCallDelta = toolCallDeltas[deltaIndex];
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
      .map(([index, toolCall]) => ({
        id: toolCall.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        }
      }))
      .filter((toolCall) => Boolean(toolCall.function.name));

    return toolCalls.length ? toolCalls : null;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
