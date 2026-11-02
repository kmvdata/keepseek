import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  OpenAIImagesAdapter, ImageAdapterError, calculateOpenAIImageCost, normalizeOpenAIImageUsage,
  OPENAI_IMAGE_RESPONSE_LIMIT
} from '../src/images/openaiImagesAdapter';
import type { ImageJobSpec } from '../src/images/types';

const SPEC: ImageJobSpec = {
  adapter: 'openai-images-v1', adapterVersion: 1, sourceId: 'official', endpoint: 'https://api.openai.com/v1',
  model: 'gpt-image-2.5-sunburst', operation: 'generate', prompt: 'A red circle on white', inputAssets: [],
  size: '1024x1024', quality: 'medium', background: 'opaque', outputFormat: 'png', n: 1
};
const OUTPUT = png(1024, 1024);
const INPUT = png(1, 1);
const SOURCE = { sourceId: 'official', apiKey: 'secret-test-key', baseUrl: 'https://api.openai.com/v1' };
function adapter(fetcher: typeof fetch, source = SOURCE): OpenAIImagesAdapter {
  return new OpenAIImagesAdapter({ fetch: fetcher, resolveSource: async () => source, timeoutMs: () => 3000 });
}
function response(data: unknown = [{ b64_json: OUTPUT.toString('base64') }], usage?: unknown): Response {
  return Response.json({ data, usage }, { headers: { 'x-request-id': 'req_test1' } });
}
const USAGE = { input_tokens: 30, output_tokens: 50, total_tokens: 80,
  input_tokens_details: { text_tokens: 10, image_tokens: 20 } };

describe('OpenAI Images API paid-create contract', () => {
  it('sends one exact independent generation request and preserves original bytes', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const api = adapter(async (url, init) => { calls.push({ url: String(url), init }); return response(undefined, USAGE); });
    const result = await api.create(SPEC);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations');
    assert.deepEqual(JSON.parse(calls[0].init?.body as string), {
      model: SPEC.model, prompt: SPEC.prompt, n: 1, size: '1024x1024', quality: 'medium', background: 'opaque', output_format: 'png'
    });
    assert.equal(calls[0].init?.redirect, 'error');
    assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Bearer secret-test-key');
    assert.deepEqual(result.bytes, OUTPUT);
    assert.equal(result.requestId, 'req_test1');
    assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 50, inputTextTokens: 10, inputImageTokens: 20 });
    assert.equal(result.cost.status, 'calculated');
    assert.equal(result.cost.amount, 0.00171);
    assert.equal(api.quote(SPEC).upperBound, undefined);
    assert.equal(api.quote(SPEC).amount, undefined);
  });

  it('edits with only the explicitly selected original image and no mask or history', async () => {
    let body: FormData | undefined;
    const spec: ImageJobSpec = { ...SPEC, operation: 'edit', inputAssets: [{ assetId: 'input', hash: createHash('sha256').update(INPUT).digest('hex') }] };
    const api = adapter(async (url, init) => {
      assert.equal(String(url), 'https://api.openai.com/v1/images/edits');
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], undefined);
      body = init?.body as FormData;
      return response();
    });
    await api.create(spec, { bytes: INPUT, mimeType: 'image/png' });
    assert.deepEqual([...body!.keys()].sort(), ['background','image[]','model','n','output_format','prompt','quality','size'].sort());
    assert.equal(body!.getAll('image[]').length, 1);
    const file = body!.get('image[]') as File;
    assert.equal(file.name, 'input.png');
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), INPUT);
  });

  it('persists the safe request identity before reading response bytes and retains results if that persistence fails', async () => {
    for (const failPersistence of [false, true]) {
      const raw = response();
      let observed: string | undefined;
      const originalGetReader = raw.body!.getReader.bind(raw.body!);
      Object.defineProperty(raw.body!, 'getReader', { value: () => {
        assert.equal(observed, 'req_test1');
        return originalGetReader();
      } });
      const result = await adapter(async () => raw).create(SPEC, undefined, undefined, async (id) => {
        assert.equal(raw.body!.locked, false);
        observed = id;
        if (failPersistence) throw new Error('disk unavailable');
      });
      assert.equal(result.requestId, 'req_test1');
      assert.deepEqual(result.bytes, OUTPUT);
    }
  });

  it('rejects changed endpoint, damaged input, invalid parameters and missing credentials before sending', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return response(); };
    await assert.rejects(adapter(fetcher, { ...SOURCE, baseUrl: 'https://proxy.example/v1' }).create(SPEC), code('image_source_changed', false));
    await assert.rejects(adapter(fetcher).create({ ...SPEC, quality: 'auto' }), code('image_invalid_spec', false));
    await assert.rejects(adapter(fetcher, { ...SOURCE, apiKey: '' }).create(SPEC), code('image_authentication', false));
    await assert.rejects(adapter(fetcher).create({ ...SPEC, endpoint: 'https://api.openai.com.attacker.example/v1' }), code('image_invalid_spec', false));
    await assert.rejects(adapter(fetcher).create({ ...SPEC, operation: 'edit', inputAssets: [{ assetId: 'x', hash: 'a'.repeat(64) }] }, { bytes: INPUT, mimeType: 'image/png' }), code('image_input_hash_mismatch', false));
    await assert.rejects(adapter(fetcher).create(SPEC, { bytes: INPUT, mimeType: 'image/png' }), code('image_input_count', false));
    assert.equal(calls, 0);
  });

  it('never retries paid creation on network failure, timeout, or ambiguous HTTP failure', async () => {
    for (const mode of ['network', 'server']) {
      let calls = 0;
      const api = adapter(async () => {
        calls++;
        if (mode === 'network') throw new Error('private upstream body and credential');
        return new Response('private upstream body and credential', { status: 503 });
      });
      await assert.rejects(api.create(SPEC), (error: unknown) => {
        assert.ok(error instanceof ImageAdapterError);
        assert.equal(error.submissionUnknown, true);
        assert.equal(error.message.includes('private'), false);
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it('marks explicit authentication and quota rejection without storing upstream text', async () => {
    for (const [status, errorCode, expected] of [[401, 'bad_key', 'image_authentication'], [429, 'insufficient_quota', 'image_quota_exceeded']] as const) {
      const api = adapter(async () => Response.json({ error: { code: errorCode, message: 'secret-test-key' } }, { status }));
      await assert.rejects(api.create(SPEC), code(expected, false));
    }
  });

  it('rejects missing, extra, malformed, oversized and wrong-size output without resubmission or URL fetch', async () => {
    const cases: (() => Response)[] = [
      () => response([]),
      () => response([{ b64_json: OUTPUT.toString('base64') }, { b64_json: OUTPUT.toString('base64') }]),
      () => response([{ url: 'http://127.0.0.1/private?signature=secret' }]),
      () => response([{ b64_json: '%%%=' }]),
      () => response([{ b64_json: INPUT.toString('base64') }]),
      () => new Response('{}', { headers: { 'content-length': String(OPENAI_IMAGE_RESPONSE_LIMIT + 1) } })
    ];
    for (const makeResponse of cases) {
      let calls = 0;
      await assert.rejects(adapter(async () => { calls++; return makeResponse(); }).create(SPEC), (error: unknown) => {
        assert.ok(error instanceof ImageAdapterError);
        assert.equal(error.submissionUnknown, true);
        return true;
      });
      assert.equal(calls, 1);
    }
  });

  it('does not submit after cancellation before create, and treats in-flight abort as local unknown', async () => {
    let calls = 0;
    const stopped = new AbortController(); stopped.abort();
    await assert.rejects(adapter(async () => { calls++; return response(); }).create(SPEC, undefined, stopped.signal), code('image_stopped_before_submission', false));
    assert.equal(calls, 0);
    const running = new AbortController();
    const api = adapter(async (_url, init) => {
      calls++;
      const result = new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      running.abort();
      return result;
    });
    await assert.rejects(api.create(SPEC, undefined, running.signal), code('image_submission_unknown', true));
    assert.equal(calls, 1);
  });

  it('stops timed-out local waiting without retrying and accepts an already completed late result', async () => {
    let calls = 0;
    const api = new OpenAIImagesAdapter({ resolveSource: async () => SOURCE, timeoutMs: () => 5,
      fetch: async (_url, init) => {
        calls++;
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timeout'))));
      } });
    await assert.rejects(api.create(SPEC), code('image_submission_unknown', true));
    assert.equal(calls, 1);
    const stopped = new AbortController();
    const late = await adapter(async () => { stopped.abort(); return response(); }).create(SPEC, undefined, stopped.signal);
    assert.deepEqual(late.bytes, OUTPUT);
  });

  it('keeps incomplete usage cost unknown and never uses text reference prices or cache discounts', () => {
    assert.equal(normalizeOpenAIImageUsage({ ...USAGE, input_tokens: 999 }), undefined);
    assert.equal(normalizeOpenAIImageUsage({ ...USAGE, output_tokens: -1 }), undefined);
    assert.equal(normalizeOpenAIImageUsage({ ...USAGE, output_tokens_details: { image_tokens: 49, text_tokens: 1 } }), undefined);
    assert.deepEqual(calculateOpenAIImageCost(undefined), { status: 'unknown', currency: 'USD', pricingVersion: 'openai-images-sunburst-standard-2026-11-02-v1' });
    assert.equal(calculateOpenAIImageCost(normalizeOpenAIImageUsage({ ...USAGE, input_tokens_details: { text_tokens: 10, image_tokens: 20, cached_tokens: 30 } })).amount, 0.00171);
  });
});

function code(expected: string, unknown: boolean): (value: unknown) => boolean {
  return (value) => value instanceof ImageAdapterError && value.code === expected && value.submissionUnknown === unknown;
}
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const result = Buffer.alloc(bytes.length + 12);
  result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
