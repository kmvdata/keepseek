import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { validateImageBytes, verifyImageContainer, IMAGE_MAX_BYTES } from './imageValidation';
import { normalizeImageJobSpec, type ImageJobSpec, type ImageUsage, type ImageCost } from './types';

/** Verified against OpenAI's Standard Images API documentation on 2026-11-02. */
export const OPENAI_IMAGE_PRICING_VERSION = 'openai-images-sunburst-standard-2026-11-02-v1';
export const OPENAI_IMAGES_ENDPOINT = 'https://api.openai.com/v1';
export const OPENAI_IMAGE_MODEL = 'gpt-image-2.5-sunburst';
export const OPENAI_IMAGE_RESPONSE_LIMIT = Math.ceil(IMAGE_MAX_BYTES / 3) * 4 + 64 * 1024;

export class ImageAdapterError extends Error {
  public constructor(
    public readonly code: string,
    public readonly submissionUnknown: boolean,
    public readonly status?: number,
    public readonly requestId?: string
  ) {
    // Never include a request/response body, credential, remote URL, or upstream message.
    super(code);
    this.name = 'ImageAdapterError';
  }
}

export interface OpenAIImageSource {
  sourceId: string;
  apiKey: string;
  baseUrl: string;
}
export interface OpenAIImagesAdapterOptions {
  /** The caller must use accounts/accountResolver.ts; credentials are never retained by this adapter. */
  resolveSource: (sourceId: string) => Promise<OpenAIImageSource>;
  fetch?: typeof fetch;
  timeoutMs?: () => number;
}
export interface ImageAdapterInput { bytes: Uint8Array; mimeType: string }
export interface ImageAdapterResult {
  bytes: Uint8Array;
  mimeType: string;
  requestId?: string;
  usage?: ImageUsage;
  cost: ImageCost;
}

/** One synchronous paid creation call. There is intentionally no create retry or speculative lookup. */
export class OpenAIImagesAdapter {
  public constructor(private readonly options: OpenAIImagesAdapterOptions) {}

  public quote(_spec: ImageJobSpec): ImageCost {
    // Official prices are token based; dimensions alone do not bound input and output usage.
    return { status: 'unknown', currency: 'USD', pricingVersion: OPENAI_IMAGE_PRICING_VERSION };
  }

  public async create(
    spec: ImageJobSpec,
    input?: ImageAdapterInput,
    signal?: AbortSignal,
    onRequestId?: (requestId: string) => Promise<void>
  ): Promise<ImageAdapterResult> {
    let normalized: ImageJobSpec;
    try { normalized = normalizeImageJobSpec(spec); }
    catch { throw new ImageAdapterError('image_invalid_spec', false); }
    if (normalized.model !== OPENAI_IMAGE_MODEL || normalized.quality === 'auto' || normalized.background === 'auto') {
      throw new ImageAdapterError('image_unsupported_parameter', false);
    }
    if (signal?.aborted) throw new ImageAdapterError('image_stopped_before_submission', false);
    if ((normalized.operation === 'edit') !== !!input) throw new ImageAdapterError('image_input_count', false);
    if (input) {
      try {
        const metadata = validateImageBytes(input.bytes, input.mimeType);
        await verifyImageContainer(input.bytes, metadata);
      } catch { throw new ImageAdapterError('image_invalid_input', false); }
      if (createHash('sha256').update(input.bytes).digest('hex') !== normalized.inputAssets[0]?.hash) {
        throw new ImageAdapterError('image_input_hash_mismatch', false);
      }
    }
    let source: OpenAIImageSource;
    try { source = await this.options.resolveSource(normalized.sourceId); }
    catch { throw new ImageAdapterError('image_source_unavailable', false); }
    if (source.sourceId !== normalized.sourceId || !source.apiKey.trim()) throw new ImageAdapterError('image_authentication', false);
    if (source.baseUrl.replace(/\/$/u, '') !== normalized.endpoint || normalized.endpoint !== OPENAI_IMAGES_ENDPOINT) {
      throw new ImageAdapterError('image_source_changed', false);
    }
    const fields = {
      model: normalized.model, prompt: normalized.prompt, n: 1, size: normalized.size,
      quality: normalized.quality, background: normalized.background, output_format: normalized.outputFormat
    };
    const headers: Record<string, string> = { Authorization: `Bearer ${source.apiKey}`, Accept: 'application/json' };
    let body: string | FormData;
    if (input) {
      body = new FormData();
      for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
      const extension = input.mimeType === 'image/jpeg' ? 'jpg' : input.mimeType.split('/')[1];
      body.set('image[]', new Blob([new Uint8Array(input.bytes)], { type: input.mimeType }), `input.${extension}`);
    } else {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(fields);
    }
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const configuredTimeout = this.options.timeoutMs?.() ?? 3_600_000;
    if (!Number.isFinite(configuredTimeout) || configuredTimeout < 1 || configuredTimeout > 86_400_000) {
      signal?.removeEventListener('abort', stop);
      throw new ImageAdapterError('image_invalid_timeout', false);
    }
    const timer = setTimeout(stop, configuredTimeout);
    let requestId: string | undefined;
    try {
      if (signal?.aborted) throw new ImageAdapterError('image_stopped_before_submission', false);
      const response = await (this.options.fetch ?? fetch)(
        `${normalized.endpoint}/images/${input ? 'edits' : 'generations'}`,
        { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' }
      );
      requestId = safeRequestId(response.headers.get('x-request-id'));
      if (requestId && onRequestId) {
        // Persist diagnostic identity promptly. A storage failure must not discard
        // an already paid response: continue draining and stage the result bytes.
        try { await onRequestId(requestId); } catch { /* The final result also carries this identity. */ }
      }
      if (!response.ok) {
        let quota = false;
        try {
          const errorBody = JSON.parse(await readBoundedResponse(response, 64 * 1024)) as { error?: { code?: unknown } };
          quota = ['insufficient_quota', 'billing_hard_limit_reached', 'billing_not_active'].includes(String(errorBody.error?.code));
        } catch { /* Only the status and a bounded whitelist affect diagnostics. */ }
        const code = response.status === 401 || response.status === 403 ? 'image_authentication'
          : quota ? 'image_quota_exceeded'
            : response.status === 429 ? 'image_rate_limited'
              : response.status === 400 || response.status === 404 || response.status === 422 ? 'image_request_rejected'
                : 'image_submission_unknown';
        const definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
        throw new ImageAdapterError(code, !definitive, response.status, requestId);
      }
      const contentType = response.headers.get('content-type');
      if (contentType && !/^application\/json(?:\s*;|$)/iu.test(contentType)) throw new ImageAdapterError('image_invalid_result', true, undefined, requestId);
      const raw = await readBoundedResponse(response, OPENAI_IMAGE_RESPONSE_LIMIT);
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { throw new ImageAdapterError('image_invalid_result', true, undefined, requestId); }
      if (!isRecord(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== 1 || !isRecord(parsed.data[0])) {
        throw new ImageAdapterError('image_result_count', true, undefined, requestId);
      }
      // GPT Image returns base64 bytes. Never follow arbitrary provider-supplied URLs.
      const encoded = parsed.data[0].b64_json;
      if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(IMAGE_MAX_BYTES / 3) * 4
        || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
        throw new ImageAdapterError('image_invalid_result', true, undefined, requestId);
      }
      await setImmediate();
      const bytes = Buffer.from(encoded, 'base64');
      const mimeType = `image/${normalized.outputFormat}`;
      try {
        const metadata = validateImageBytes(bytes, mimeType);
        await verifyImageContainer(bytes, metadata);
        if (`${metadata.width}x${metadata.height}` !== normalized.size) throw new Error('image_result_size');
      } catch { throw new ImageAdapterError('image_invalid_result', true, undefined, requestId); }
      const usage = normalizeOpenAIImageUsage(parsed.usage);
      return { bytes, mimeType, requestId, usage, cost: calculateOpenAIImageCost(usage) };
    } catch (error) {
      if (error instanceof ImageAdapterError) throw error;
      // Once fetch is entered, timeout, disconnect and cancellation cannot establish no charge.
      throw new ImageAdapterError('image_submission_unknown', true, undefined, requestId);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }
}

export function normalizeOpenAIImageUsage(value: unknown): ImageUsage | undefined {
  if (!isRecord(value) || !isRecord(value.input_tokens_details)) return undefined;
  const inputTokens = tokenCount(value.input_tokens);
  const outputTokens = tokenCount(value.output_tokens);
  const inputTextTokens = tokenCount(value.input_tokens_details.text_tokens);
  const inputImageTokens = tokenCount(value.input_tokens_details.image_tokens);
  if (inputTokens === undefined || outputTokens === undefined || inputTextTokens === undefined || inputImageTokens === undefined
    || inputTextTokens + inputImageTokens !== inputTokens) return undefined;
  if (value.total_tokens !== undefined && tokenCount(value.total_tokens) !== inputTokens + outputTokens) return undefined;
  if (value.output_tokens_details !== undefined && (!isRecord(value.output_tokens_details)
    || tokenCount(value.output_tokens_details.image_tokens) !== outputTokens
    || (value.output_tokens_details.text_tokens !== undefined && value.output_tokens_details.text_tokens !== 0))) return undefined;
  return { inputTokens, outputTokens, inputTextTokens, inputImageTokens };
}

/** Calculated at published token rates; this is not an assertion about the supplier invoice. */
export function calculateOpenAIImageCost(usage: ImageUsage | undefined): ImageCost {
  const cost: ImageCost = { status: 'unknown', currency: 'USD', pricingVersion: OPENAI_IMAGE_PRICING_VERSION };
  if (!usage || tokenCount(usage.inputTextTokens) === undefined || tokenCount(usage.inputImageTokens) === undefined
    || tokenCount(usage.outputTokens) === undefined) return cost;
  return { ...cost, status: 'calculated', amount: (usage.inputTextTokens! * 5 + usage.inputImageTokens! * 8 + usage.outputTokens! * 30) / 1_000_000 };
}

async function readBoundedResponse(response: Response, limit: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
    await response.body?.cancel();
    throw new ImageAdapterError('image_response_limit', true);
  }
  if (!response.body) throw new ImageAdapterError('image_invalid_result', true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ImageAdapterError('image_response_limit', true);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function safeRequestId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_-]{1,256}$/u.test(value) ? value : undefined;
}
function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
