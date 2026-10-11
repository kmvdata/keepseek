import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { OpenAiResponsesClient } from '../src/agent/providers/openAiResponsesClient';
import { AnthropicMessagesClient } from '../src/agent/providers/anthropicMessagesClient';
import { isRecoverableNetworkError, parseRetryAfter } from '../src/agent/providers/networkErrors';
import { formatUnknownError, createNoopInteractionTrace } from '../src/agent/logging/interactionTrace';
import type { ProviderClientConfig, ProviderClientResult, ProviderClientRequest } from '../src/agent/providers/types';
import type { AgentActivityInput } from '../src/shared/types';

const config: ProviderClientConfig = { apiKey: 'key', baseUrl: 'https://example.invalid/v1',
  streamIdleTimeoutMs: 0, maxRequestRetries: 5, requestRetryBaseMs: 0 };
const request = (): ProviderClientRequest => ({ body: { model: 'model', messages: [{ role: 'user', content: 'hello' }], stream: true }, language: 'en' });
const client = () => new OpenAICompatibleClient({ displayName: 'Test' });
const encoded = (text: string) => new TextEncoder().encode(text);
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (content: string, finish: string | null = null, usage?: Record<string, number>) =>
  event({ choices: [{ delta: { content }, finish_reason: finish }], ...(usage ? { usage } : {}) });
const completed = () => new Response(chunk('complete', 'stop') + 'data: [DONE]\n\n', { status: 200 });
const networkError = (code = 'ECONNRESET') => new TypeError('fetch failed', { cause: Object.assign(new Error('socket lost'), { code }) });

async function usingFetch(replacement: typeof fetch, action: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = replacement;
  try { await action(); } finally { globalThis.fetch = previous; }
}

// Emit bytes in separate pull turns so read failures occur after the first event
// was consumed, instead of erroring the entire queue during stream construction.
function interrupted(text: string): Response {
  let sent = false;
  return new Response(new ReadableStream<Uint8Array>({ pull(target) {
    if (!sent) { sent = true; target.enqueue(encoded(text)); }
    else target.error(networkError());
  } }), { status: 200 });
}

test('reconnects use frozen lane and request bytes, replace partials, and settle each physical attempt', async () => {
  const bodies: unknown[] = []; const urls: unknown[] = []; const keys: unknown[] = [];
  const states: AgentActivityInput[] = []; const settled: ProviderClientResult[] = [];
  const visible: string[] = []; let resets = 0;
  const mutableConfig = { ...config }; const input = request();
  input.callbacks = { beforeRetry: async () => {
    input.body.model = 'mutated'; mutableConfig.baseUrl = 'https://changed.invalid'; mutableConfig.apiKey = 'changed';
  }, onDelta: (delta) => visible.push(delta.delta), onAttemptReset: () => { resets++; visible.length = 0; }, onStatus: (status) => states.push(status) };
  input.onAttemptResult = async ({ result }) => { settled.push(result); };
  await usingFetch((async (url, init) => {
    urls.push(url); bodies.push(init?.body); keys.push((init?.headers as Record<string, string>).Authorization);
    return bodies.length === 1 ? interrupted(chunk('partial '.repeat(12), null, { prompt_tokens: 11, completion_tokens: 3 })) : completed();
  }) as typeof fetch, async () => {
    const result = await client().createModelResponse(mutableConfig, input);
    assert.equal(result.ok, true); assert.equal(result.attemptCount, 2); assert.equal(result.retryCount, 1);
  });
  assert.equal(new Set(bodies).size, 1); assert.equal(new Set(urls).size, 1); assert.deepEqual(keys, ['Bearer key', 'Bearer key']);
  assert.equal(resets, 1); assert.equal(visible.join(''), 'complete');
  assert.equal(settled.length, 2); assert.equal(settled[0].ok, false); assert.equal(settled[0].usage?.prompt_tokens, 11);
  assert.equal(states.find((state) => state.phase === 'reconnecting')?.reconnectAttempt, 1);
  assert.equal(states.at(-1)?.phase, 'generating');
});

test('mixed HTTP and transport failures stop after five reconnects and six physical sends', async () => {
  let count = 0; const attempts: number[] = []; const states: AgentActivityInput[] = [];
  await usingFetch((async () => {
    count++;
    if (count % 3 === 1) throw networkError();
    return new Response('busy', { status: count % 3 === 2 ? 429 : 503, headers: { 'retry-after': '0' } });
  }) as typeof fetch, async () => {
    const result = await client().createModelResponse(config, { ...request(),
      onAttempt: ({ attemptIndex }) => { attempts.push(attemptIndex); }, callbacks: { onStatus: (status) => states.push(status) } });
    assert.equal(result.ok, false); assert.equal(result.recoveryExhausted, true);
    assert.equal(result.attemptCount, 6); assert.equal(result.retryCount, 5); assert.match(result.error!, /5 reconnects/u);
  });
  assert.equal(count, 6); assert.deepEqual(attempts, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(states.filter((state) => state.phase === 'reconnecting').map((state) => state.reconnectAttempt), [1, 2, 3, 4, 5]);
  assert.equal(states.at(-1)?.phase, 'failed');
});

test('checkpoint attempt seeds cannot reset the six-send cap', async () => {
  let count = 0;
  await usingFetch((async () => { count++; throw networkError(); }) as typeof fetch, async () => {
    const result = await client().createModelResponse(config, { ...request(), initialAttemptCount: 4 });
    assert.equal(result.attemptCount, 2); assert.equal(result.retryCount, 5);
    const exhausted = await client().createModelResponse(config, { ...request(), initialAttemptCount: 6 });
    assert.equal(exhausted.attemptCount, 0); assert.equal(exhausted.recoveryExhausted, true);
  });
  assert.equal(count, 2);
});

test('Retry-After backoff is cancellable immediately and does not dispatch another request', async () => {
  let count = 0; const controller = new AbortController(); let delay = 0;
  const started = Date.now();
  await usingFetch((async () => { count++; return new Response('busy', { status: 429, headers: { 'retry-after': '60' } }); }) as typeof fetch, async () => {
    const result = await client().createModelResponse(config, { ...request(), signal: controller.signal,
      callbacks: { onStatus: (status) => { if (status.phase === 'reconnecting') { delay = status.retryDelayMs!; setTimeout(() => controller.abort(), 10); } } } });
    assert.equal(result.failureKind, 'external_abort'); assert.equal(result.retryCount, 0);
  });
  assert.equal(count, 1); assert.equal(delay, 60_000); assert.ok(Date.now() - started < 1000);
  assert.equal(parseRetryAfter('invalid'), undefined); assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('Thu, 01 Jan 1970 00:00:05 GMT', 3000), 2000);
});

test('backoff respects the remaining deadline instead of retrying earlier than Retry-After', async () => {
  let count = 0;
  await usingFetch((async () => { count++; return new Response('busy', { status: 429, headers: { 'retry-after': '60' } }); }) as typeof fetch, async () => {
    const result = await client().createModelResponse(config, { ...request(), runDeadlineAt: Date.now() + 25 });
    assert.equal(result.failureKind, 'run_time_limit');
  });
  assert.equal(count, 1);
});

test('certificate, authentication, complete invalid JSON, resources and user idle timeouts are never replayed', async () => {
  const cases: Array<() => Response | Promise<Response>> = [
    () => { throw networkError('CERT_HAS_EXPIRED'); },
    () => new Response('denied', { status: 401 }),
    () => new Response('data: {bad}\n\n', { status: 200 }),
    () => { throw new Error('Streaming resource limit (32 MiB)'); }
  ];
  for (const scenario of cases) {
    let count = 0;
    await usingFetch((async () => { count++; return scenario(); }) as typeof fetch, async () => {
      const result = await client().createModelResponse(config, request()); assert.equal(result.ok, false);
    });
    assert.equal(count, 1);
  }
  let count = 0;
  await usingFetch((async (_url, init) => { count++; return new Promise((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }); }) as typeof fetch, async () => {
    const result = await client().createModelResponse({ ...config, streamIdleTimeoutMs: 5 }, request());
    assert.equal(result.failureKind, 'stream_idle_timeout');
  });
  assert.equal(count, 1);
});

test('valid completion survives transport tail failure and keeps known or unknown usage', async () => {
  for (const usage of [undefined, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }]) {
    let count = 0;
    await usingFetch((async () => { count++; return interrupted(chunk('complete', 'stop', usage)); }) as typeof fetch, async () => {
      const result = await client().createModelResponse(config, request());
      assert.equal(result.ok, true); assert.equal(result.message?.content, 'complete');
      assert.deepEqual(result.usage, usage);
    });
    assert.equal(count, 1);
  }
});

test('silent HTTP error bodies time out, finish cleanup before retry, and retain authentication stop semantics', async () => {
  for (const status of [429, 401]) {
    let count = 0; let cancelled = false;
    const startedAt = Date.now();
    await usingFetch((async () => {
      count++;
      if (count > 1) { assert.equal(cancelled, true, 'retry dispatched before closing rejected response'); return completed(); }
      return new Response(new ReadableStream<Uint8Array>({ cancel: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 10)); cancelled = true;
      } }), { status, headers: { 'retry-after': '0' } });
    }) as typeof fetch, async () => {
      const result = await client().createModelResponse(config, request());
      assert.equal(result.ok, status === 429); assert.equal(count, status === 429 ? 2 : 1);
      if (status === 401) { assert.equal(result.status, 401); assert.equal(result.retryable, false); }
    });
    assert.equal(cancelled, true);
    assert.ok(Date.now() - startedAt >= 1_900);
    assert.ok(Date.now() - startedAt < 5_000);
  }
});

test('user cancellation stops a silent rejected HTTP body immediately', async () => {
  const controller = new AbortController(); let count = 0; let cancelled = false;
  const startedAt = Date.now();
  await usingFetch((async () => {
    count++;
    setTimeout(() => controller.abort(), 10);
    return new Response(new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } }), { status: 503 });
  }) as typeof fetch, async () => {
    const result = await client().createModelResponse(config, { ...request(), signal: controller.signal });
    assert.equal(result.failureKind, 'external_abort');
  });
  assert.equal(count, 1); assert.equal(cancelled, true); assert.ok(Date.now() - startedAt < 1_000);
});

test('three shared protocol clients recover an empty EOF with the same serialized projection', async () => {
  const entries = [
    { provider: client(), input: request(), success: chunk('done', 'stop') + 'data: [DONE]\n\n' },
    { provider: new OpenAiResponsesClient(), input: { body: { model: 'model', input: [], stream: true, store: false }, language: 'en' } as ProviderClientRequest,
      success: 'event: response.completed\n' + event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } }) },
    { provider: new AnthropicMessagesClient(), input: { body: { model: 'model', messages: [], max_tokens: 100, stream: true }, language: 'en' } as ProviderClientRequest,
      success: 'event: message_start\n' + event({ type: 'message_start', message: { role: 'assistant', content: [] } })
        + 'event: content_block_start\n' + event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } })
        + 'event: content_block_stop\n' + event({ type: 'content_block_stop', index: 0 })
        + 'event: message_delta\n' + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } })
        + 'event: message_stop\n' + event({ type: 'message_stop' }) }
  ];
  for (const entry of entries) {
    const bodies: unknown[] = [];
    await usingFetch((async (_url, init) => { bodies.push(init?.body); return new Response(bodies.length === 1 ? '' : entry.success); }) as typeof fetch, async () => {
      const result = await entry.provider.createModelResponse(config, entry.input); assert.equal(result.ok, true, result.error);
    });
    assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  }
});

test('bounded network causes expose nested codes and redact proxy credentials', () => {
  const cause = Object.assign(new Error('connect http://alice:secret@proxy.invalid password=hidden'), { code: 'ECONNRESET' });
  const error = new TypeError('fetch failed', { cause: new AggregateError([cause], 'multiple failures') });
  assert.equal(isRecoverableNetworkError(error), true);
  const formatted = JSON.stringify(formatUnknownError(error));
  assert.match(formatted, /ECONNRESET/u); assert.doesNotMatch(formatted, /alice:secret|password=hidden/u);
  const circular = Object.assign(new Error('loop'), { cause: undefined as unknown }); circular.cause = circular;
  assert.match(JSON.stringify(formatUnknownError(circular)), /circular error/u);
  assert.equal(isRecoverableNetworkError(networkError('UND_ERR_BODY_TIMEOUT')), true);
  assert.equal(isRecoverableNetworkError(networkError('ENOTFOUND')), false);
});

test('local fault server exercises delayed headers, disconnection, delayed EOF and healthy connection reuse', async (t) => {
  let count = 0; const sockets = new Set<unknown>(); const traces: Record<string, unknown>[] = [];
  const server = createServer((incoming, outgoing) => {
    sockets.add(incoming.socket); count++;
    incoming.resume();
    if (count === 1) {
      outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fault-first' });
      outgoing.write(chunk('temporary '.repeat(10)));
      setTimeout(() => outgoing.destroy(), 10);
    } else {
      setTimeout(() => {
        outgoing.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': `complete-${count}` });
        outgoing.write(chunk('local complete', 'stop', { prompt_tokens: 7, completion_tokens: 2 }));
        setTimeout(() => outgoing.end('data: [DONE]\n\n'), 10);
      }, 10);
    }
  });
  server.listen(0, '127.0.0.1');
  try { await once(server, 'listening'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('This sandbox disallows binding a local fault server.'); return; }
    throw error;
  }
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const localConfig = { ...config, baseUrl: `http://127.0.0.1:${address.port}` };
    const first = await client().createModelResponse(localConfig, { ...request(), trace: createNoopInteractionTrace((entry) => traces.push(entry)) });
    assert.equal(first.ok, true); assert.equal(first.attemptCount, 2); assert.equal(first.usage?.prompt_tokens, 7);
    // Let Undici make the just-drained socket available to the next request.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const second = await client().createModelResponse(localConfig, request()); assert.equal(second.ok, true);
    assert.equal(count, 3); assert.equal(sockets.size, 2);
    const finished = traces.find((entry) => entry.type === 'upstream_attempt_finish' && entry.ok === true)!;
    assert.equal(finished.semanticComplete, true); assert.equal(finished.httpComplete, true);
    assert.ok(Number(finished.receivedBytes) > 0); assert.ok(Number(finished.eventCount) > 0);
    assert.equal(finished.providerRequestId, 'complete-2');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
