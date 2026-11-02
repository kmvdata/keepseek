import { createHash } from 'node:crypto';

export interface ImageJobScope { workspaceId: string; sessionId: string }
export interface ImageInputRef { assetId: string; hash: string }
export interface ImageJobSpec {
  adapter: 'openai-images-v1';
  adapterVersion: 1;
  sourceId: string;
  endpoint: string;
  model: string;
  operation: 'generate' | 'edit';
  prompt: string;
  inputAssets: readonly ImageInputRef[];
  size: '1024x1024' | '1536x1024' | '1024x1536';
  quality: 'auto' | 'low' | 'medium' | 'high';
  background: 'auto' | 'opaque' | 'transparent';
  outputFormat: 'png' | 'jpeg' | 'webp';
  n: 1;
}
export interface ImageUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTextTokens?: number;
  inputImageTokens?: number;
  [key: string]: unknown;
}
export interface ImageCost {
  status: 'unknown' | 'estimated' | 'calculated';
  currency: string;
  amount?: number;
  upperBound?: number;
  pricingVersion: string;
}
export type ImageJobStatus = 'pending' | 'preparing' | 'submitting' | 'submission_unknown'
  | 'accepted' | 'generating' | 'generated' | 'saved' | 'failed' | 'local_stopped'
  | 'server_cancelled' | 'expired';
export interface ImageJob {
  version: 1;
  revision: number;
  jobId: string;
  actionId: string;
  scope: ImageJobScope;
  spec: ImageJobSpec;
  specHash: string;
  parentJobId?: string;
  status: ImageJobStatus;
  createdAt: string;
  updatedAt: string;
  authorization: { source: 'user_click'; authorizedAt: string; specHash: string };
  budget: { domain: string; limit: number; reservation: ImageCost; reservationState?: 'held' | 'released' | 'settled'; settlement?: ImageCost };
  resultAssetId?: string;
  resultHash?: string;
  requestId?: string;
  usage?: ImageUsage;
  error?: { code: string; message: string };
  ownerRuntime?: { id: string; pid: number; hostname: string };
  stoppedAt?: string;
}

/** Prompt bytes use LF and trim only; no truncation or silent parameter fallback. */
export function normalizeImageJobSpec(value: unknown): ImageJobSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('image_invalid_spec');
  const v = value as Record<string, unknown>;
  const keys = new Set(['adapter', 'adapterVersion', 'sourceId', 'endpoint', 'model', 'operation', 'prompt', 'inputAssets', 'size', 'quality', 'background', 'outputFormat', 'n']);
  if (Object.keys(v).some((key) => !keys.has(key))) throw new Error('image_unsupported_parameter');
  if (v.adapter !== 'openai-images-v1' || v.adapterVersion !== 1 || v.n !== 1) throw new Error('image_unsupported_adapter');
  if (typeof v.sourceId !== 'string' || !v.sourceId.trim() || v.sourceId.length > 256) throw new Error('image_invalid_source');
  if (typeof v.endpoint !== 'string') throw new Error('image_invalid_endpoint');
  const endpoint = new URL(v.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol !== 'https:') throw new Error('image_invalid_endpoint');
  const normalizedEndpoint = endpoint.toString().replace(/\/$/u, '');
  if (normalizedEndpoint !== 'https://api.openai.com/v1') throw new Error('image_unsupported_endpoint');
  if (v.model !== 'gpt-image-2.5-sunburst') throw new Error('image_unsupported_model');
  if (v.operation !== 'generate' && v.operation !== 'edit') throw new Error('image_unsupported_operation');
  if (typeof v.prompt !== 'string') throw new Error('image_invalid_prompt');
  const prompt = v.prompt.replace(/\r\n?/gu, '\n').trim();
  if (!prompt || prompt.length > 32_000) throw new Error('image_prompt_limit');
  if (!Array.isArray(v.inputAssets) || v.inputAssets.length !== (v.operation === 'edit' ? 1 : 0)) throw new Error('image_input_count');
  const inputAssets = v.inputAssets.map((input): ImageInputRef => {
    if (!input || typeof input !== 'object' || typeof input.assetId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(input.assetId)
      || typeof input.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.hash)) throw new Error('image_invalid_input');
    return { assetId: input.assetId, hash: input.hash };
  });
  if (typeof v.size !== 'string' || !['1024x1024', '1536x1024', '1024x1536'].includes(v.size)) throw new Error('image_unsupported_size');
  if (typeof v.quality !== 'string' || !['low', 'medium', 'high'].includes(v.quality)) throw new Error('image_unsupported_quality');
  if (typeof v.background !== 'string' || !['opaque', 'transparent'].includes(v.background)) throw new Error('image_unsupported_background');
  if (typeof v.outputFormat !== 'string' || !['png', 'jpeg', 'webp'].includes(v.outputFormat)) throw new Error('image_unsupported_format');
  if (v.outputFormat === 'jpeg' && v.background === 'transparent') throw new Error('image_transparency_format');
  return Object.freeze({
    adapter: 'openai-images-v1', adapterVersion: 1, sourceId: v.sourceId.trim(), endpoint: normalizedEndpoint,
    model: v.model, operation: v.operation, prompt, inputAssets: Object.freeze(inputAssets.map((input) => Object.freeze(input))),
    size: v.size as ImageJobSpec['size'], quality: v.quality as ImageJobSpec['quality'],
    background: v.background as ImageJobSpec['background'], outputFormat: v.outputFormat as ImageJobSpec['outputFormat'], n: 1
  });
}

export function hashImageJobSpec(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(normalizeImageJobSpec(value))).digest('hex');
}

export function validateImageScope(scope: ImageJobScope): void {
  if (!scope || typeof scope.workspaceId !== 'string' || !scope.workspaceId || scope.workspaceId.length > 4096
    || typeof scope.sessionId !== 'string' || !scope.sessionId || scope.sessionId.length > 256) throw new Error('image_invalid_scope');
}
