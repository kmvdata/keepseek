import './registerVscodeStub';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReadableStream } from 'node:stream/web';
import { StreamParser } from '../src/agent/providers/streamParser';
import { ResponsesStreamParser } from '../src/agent/providers/responsesStreamParser';
import { AnthropicStreamParser } from '../src/agent/providers/anthropicStreamParser';
import {
  ProviderIncompleteStreamError,
  ProviderStreamProtocolError,
  ProviderStreamProviderError
} from '../src/agent/providers/streamErrors';
import type { ProviderStreamProgress } from '../src/agent/providers/types';

const usage = { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 };
const parsers = () => [new StreamParser(), new ResponsesStreamParser(), new AnthropicStreamParser()];
const terminalText = '你好🌏';

function frame(value: object, ending = '\n\n'): string {
  return `data: ${JSON.stringify(value)}${ending}`;
}
function chat(text = terminalText): string {
  return frame({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] });
}
function responses(text = terminalText): string {
  return frame({ type: 'response.completed', response: { status: 'completed', output: [{
    type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }]
  }] } });
}
function anthropic(text = terminalText): string {
  return [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' }
  ].map((event) => frame(event)).join('');
}
function stream(text: string, failure?: Error, bytewise = false): NonNullable<Response['body']> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset < bytes.length) {
        const end = bytewise ? offset + 1 : bytes.length;
        controller.enqueue(bytes.slice(offset, end));
        offset = end;
      } else if (failure) controller.error(failure);
      else controller.close();
    }
  });
}
function socketError(): Error {
  return new TypeError('terminated', { cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }) });
}

describe('provider streams distinguish model completion from transport completion', () => {
  it('decodes actual UTF-8 byte splits and CRLF splits in all three protocols', async () => {
    const texts = [chat(), responses(), anthropic()];
    for (const [index, parser] of parsers().entries()) {
      const progress: ProviderStreamProgress[] = [];
      const wire = texts[index].replace(/\n/gu, '\r\n');
      const result = await parser.parse(stream(wire, undefined, true), 'en', {}, { onProgress: (snapshot) => progress.push(snapshot) });
      assert.equal(result.message.content, terminalText);
      assert.equal(progress.at(-1)?.httpComplete, true);
      assert.equal(progress.at(-1)?.semanticComplete, true);
      assert.equal(progress.at(-1)?.receivedBytes, new TextEncoder().encode(wire).length);
    }
  });

  it('rejects malformed UTF-8 bytes instead of changing tool or text contents and recovers a truncated code point', async () => {
    const prefix = new TextEncoder().encode('data: {"value":"');
    for (const parser of parsers()) {
      const malformed = new Uint8Array([...prefix, 0xc3, 0x28, ...new TextEncoder().encode('"}\n\n')]);
      await assert.rejects(parser.parse(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(malformed); controller.close(); } }), 'en', {}), ProviderStreamProtocolError);
      const truncated = new Uint8Array([...prefix, 0xe4, 0xbd]);
      await assert.rejects(parser.parse(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(truncated); controller.close(); } }), 'en', {}), ProviderIncompleteStreamError);
    }
  });

  it('consumes a valid last EOF event even when it has no SSE separator', async () => {
    for (const [index, parser] of parsers().entries()) {
      const result = await parser.parse(stream([chat(), responses(), anthropic()][index].trimEnd()), 'en', {});
      assert.equal(result.message.content, terminalText);
    }
    const result = await new StreamParser().parse(stream(chat() + 'data: [DONE]'), 'en', {});
    assert.equal(result.finishReason, 'stop');
  });

  it('classifies empty, reasoning/body partial, incomplete tool and truncated EOF as recoverable incompletion', async () => {
    for (const parser of parsers()) await assert.rejects(parser.parse(stream(''), 'en', {}), ProviderIncompleteStreamError);
    const chatPartials = [
      { choices: [{ delta: { content: 'temporary' } }] },
      { choices: [{ delta: { reasoning_content: 'temporary thought' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call', function: { name: 'read', arguments: '{' } }] } }] }
    ];
    for (const event of chatPartials) await assert.rejects(new StreamParser().parse(stream(frame(event)), 'en', {}), ProviderIncompleteStreamError);
    await assert.rejects(new StreamParser().parse(stream('data: [DONE]\n\n'), 'en', {}), ProviderIncompleteStreamError);
    await assert.rejects(new ResponsesStreamParser().parse(stream(frame({ type: 'response.reasoning_summary_text.delta', delta: 'thought' })), 'en', {}), ProviderIncompleteStreamError);
    await assert.rejects(new AnthropicStreamParser().parse(stream(frame({ type: 'message_start', message: {} })), 'en', {}), ProviderIncompleteStreamError);
    for (const parser of parsers()) await assert.rejects(parser.parse(stream('data: {"unfinished":'), 'en', {}), ProviderIncompleteStreamError);
  });

  it('keeps a complete result after a recognized socket error and leaves unknown usage unknown', async () => {
    for (const [index, parser] of parsers().entries()) {
      const progress: ProviderStreamProgress[] = [];
      const result = await parser.parse(stream([chat(), responses(), anthropic()][index], socketError()), 'en', {}, { onProgress: (snapshot) => progress.push(snapshot) });
      assert.equal(result.message.content, terminalText);
      assert.equal(result.usage == null, true);
      assert.equal(progress.at(-1)?.tailInterrupted, true);
      assert.equal(progress.at(-1)?.httpComplete, false);
    }
  });

  it('preserves Chat usage obtained before a tail error and reports usage before a preterminal failure', async () => {
    const wire = chat() + frame({ choices: [], usage });
    const result = await new StreamParser().parse(stream(wire, socketError()), 'en', {});
    assert.deepEqual(result.usage, usage);
    let progress: ProviderStreamProgress | undefined;
    await assert.rejects(new StreamParser().parse(stream(frame({ choices: [{ delta: { content: 'partial' } }], usage }), socketError()), 'en', {}, {
      onProgress: (snapshot) => { progress = snapshot; }
    }));
    assert.deepEqual(progress?.usage, usage);
    assert.equal(progress?.semanticComplete, false);
  });

  it('merges partial or empty usage events without discarding already-observed token counts', async () => {
    const result = await new StreamParser().parse(stream(chat() + frame({ choices: [], usage })
      + frame({ choices: [], usage: {} }) + frame({ choices: [], usage: { completion_tokens: 4 } })), 'en', {});
    assert.deepEqual(result.usage, { ...usage, completion_tokens: 4, total_tokens: 15 });
    const observed = frame({ type: 'response.created', response: { usage: { input_tokens: 11, output_tokens: 3, input_tokens_details: { cached_tokens: 7 } } } });
    const terminal = frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11 }, output: [{
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }]
    }] } });
    const native = await new ResponsesStreamParser().parse(stream(observed + terminal), 'en', {});
    assert.equal(native.usage?.completion_tokens, 3);
    assert.equal(native.usage?.total_tokens, 14);
    assert.equal(native.usage?.prompt_cache_hit_tokens, 7);
  });

  it('preserves native usage before failures and does not invent absent Anthropic token counts', async () => {
    let responseProgress: ProviderStreamProgress | undefined;
    await assert.rejects(new ResponsesStreamParser().parse(stream(frame({ type: 'response.failed', response: {
      status: 'failed', usage: { input_tokens: 11, output_tokens: 3 }, error: { message: 'overloaded' }
    } })), 'en', {}, { onProgress: (snapshot) => { responseProgress = snapshot; } }), ProviderStreamProviderError);
    assert.equal(responseProgress?.usage?.prompt_tokens, 11);
    assert.equal(responseProgress?.usage?.completion_tokens, 3);
    let anthropicProgress: ProviderStreamProgress | undefined;
    await assert.rejects(new AnthropicStreamParser().parse(stream(frame({ type: 'message_start', message: { usage: { input_tokens: 11 } } })), 'en', {}, {
      onProgress: (snapshot) => { anthropicProgress = snapshot; }
    }), ProviderIncompleteStreamError);
    assert.equal(anthropicProgress?.usage?.prompt_tokens, 11);
    assert.equal(anthropicProgress?.usage?.completion_tokens, undefined);
    assert.equal(anthropicProgress?.usage?.total_tokens, undefined);
  });

  it('does not disguise provider errors or complete invalid JSON after a terminal as success', async () => {
    for (const [index, parser] of parsers().entries()) {
      const wire = [chat(), responses(), anthropic()][index];
      await assert.rejects(parser.parse(stream(wire + frame({ type: 'error', error: { message: 'late provider failure' } })), 'en', {}), ProviderStreamProviderError);
      await assert.rejects(parser.parse(stream(wire + 'data: {bad}\n\n'), 'en', {}), ProviderStreamProtocolError);
      await assert.rejects(parser.parse(stream(wire + frame({ type: 'error', error: { message: 'buffered provider failure' } }).trimEnd(), socketError()), 'en', {}), ProviderStreamProviderError);
      await assert.rejects(parser.parse(stream(wire + 'data: {bad}', socketError()), 'en', {}), ProviderStreamProtocolError);
      const truncatedTail = await parser.parse(stream(wire + 'data: {"unfinished":', socketError()), 'en', {});
      assert.equal(truncatedTail.message.content, terminalText);
      const truncatedEof = await parser.parse(stream(wire + 'data: {"unfinished":'), 'en', {});
      assert.equal(truncatedEof.message.content, terminalText);
      await assert.rejects(parser.parse(stream(wire, new Error('resource limit reached')), 'en', {}), /resource limit/u);
    }
  });

  it('never silently discards malformed Chat tool calls and exposes usage on terminal validation failure', async () => {
    for (const tool of [
      { id: 'missing-name', function: { arguments: '{}' } },
      { function: { name: 'tool', arguments: '{}' } },
      { id: 'invalid-args', function: { name: 'tool', arguments: '{' } },
      { id: 'array', function: { name: 'tool', arguments: '[]' } }
    ]) {
      let progress: ProviderStreamProgress | undefined;
      const event = { choices: [{ delta: { tool_calls: [tool] }, finish_reason: 'tool_calls' }], usage };
      await assert.rejects(new StreamParser().parse(stream(frame(event)), 'en', {}, { onProgress: (snapshot) => { progress = snapshot; } }), ProviderStreamProtocolError);
      assert.deepEqual(progress?.usage, usage);
      assert.equal(progress?.semanticComplete, false);
    }
  });

  it('validates all seen Responses tool identities and replays completed native blocks without changing them', async () => {
    const item = { type: 'function_call', id: 'native-item', call_id: 'call', name: 'read', arguments: '{"path":"x"}' };
    const reasoning = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] };
    const result = await new ResponsesStreamParser().parse(stream(frame({ type: 'response.completed', response: { status: 'completed', output: [reasoning, item] } })), 'en', {});
    assert.deepEqual(result.outputItems, [reasoning, item]);
    for (const malformed of [{ type: 'function_call', call_id: 'bad', arguments: '{}' }, { ...item, arguments: '{' }]) {
      await assert.rejects(new ResponsesStreamParser().parse(stream(frame({ type: 'response.completed', response: { status: 'completed', output: [malformed] } })), 'en', {}), ProviderStreamProtocolError);
    }
    await assert.rejects(new ResponsesStreamParser().parse(stream(
      frame({ type: 'response.output_item.added', output_index: 0, item }) + responses()
    ), 'en', {}), /omitted or damaged/u);
    await assert.rejects(new ResponsesStreamParser().parse(stream(
      frame({ type: 'response.function_call_arguments.delta', item_id: 'orphan', delta: '{}' }) + responses()
    ), 'en', {}), /did not belong/u);
  });

  it('keeps complete Anthropic signatures and rejects incomplete or damaged native replay', async () => {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'thought', signature: 'signed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' }
    ];
    const result = await new AnthropicStreamParser().parse(stream(events.map((event) => frame(event)).join('')), 'en', {});
    assert.deepEqual(result.contentBlocks, [{ type: 'thinking', thinking: 'thought', signature: 'signed' }]);
    await assert.rejects(new AnthropicStreamParser().parse(stream(events.filter((event) => event.type !== 'content_block_stop').map((event) => frame(event)).join('')), 'en', {}), /unfinished content block/u);
    events[1] = { ...events[1], content_block: { type: 'thinking', thinking: 'thought', signature: '' } };
    await assert.rejects(new AnthropicStreamParser().parse(stream(events.map((event) => frame(event)).join('')), 'en', {}), /without a signature/u);
  });

  it('bounds completed tail reads, awaits cancellation, and leaves normal EOF connections reusable', async () => {
    let cancelled = 0;
    const hanging = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(chat())); },
      cancel() { cancelled += 1; }
    });
    const result = await new StreamParser().parse(hanging, 'en', {}, { tailTimeoutMs: 5 });
    assert.equal(result.message.content, terminalText);
    assert.equal(cancelled, 1);
    const normal = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(chat())); controller.close(); },
      cancel() { cancelled += 1; }
    });
    await new StreamParser().parse(normal, 'en', {});
    assert.equal(cancelled, 1);
  });

  it('honors user cancellation during the completed tail and never preserves cancelled results', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const hanging = new ReadableStream<Uint8Array>({
      start(streamController) { streamController.enqueue(new TextEncoder().encode(chat())); },
      cancel() { cancelled = true; }
    });
    const result = new StreamParser().parse(hanging, 'en', {}, { signal: controller.signal,
      onProgress: (snapshot) => { if (snapshot.semanticComplete) controller.abort(); } });
    await assert.rejects(result, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    assert.equal(cancelled, true);
  });
});
