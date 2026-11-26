import { decodeBase64Prefix, readImageHeader } from '../../attachments/imageHeader';
import { estimateTokenCount } from '../tokenEstimate';

/**
 * Provider-scoped image token accounting.
 *
 * Stage 0 live probe (`out-test/image-tokenization-report.json`) measured exactly
 * one Chat Completions lane: the selected workspace source with
 * `provider=deepseek`, that account's configured MaaS endpoint (host
 * `token-plan.maas.qwencloudapi.com`) and model id `deepseek-v4.1-flash-1017`
 * (`modelListed: false`). The numbers below describe that lane only. DeepSeek's
 * public API, Qwen-VL and Anthropic Messages were never measured here and must
 * not be inferred from it.
 *
 * Measured `prompt_tokens` minus the 43-token fixed template overhead:
 *   512x512   -> 184   (a 2 KB solid colour and 787 KB of noise both: pixel scoped)
 *   1302x1302 -> 994
 *   1568x1568 -> 994   (the lane downsamples large inputs onto a 31x31 grid)
 *
 * The DeepSeek formula reproduces 184 and 994 exactly. For 1568x1568 it reads
 * 1484 and is clamped to 1024, so it is a deliberate conservative upper bound:
 * at most 30 tokens above the measured value, never below it.
 */
export interface ImageTokenEstimateInput {
  width: number;
  height: number;
  provider?: string | null;
  modelId?: string | null;
}

export interface ImageTokenEstimateOptions {
  provider?: string | null;
  modelId?: string | null;
}

/** Placeholder that replaces a base64 payload before character counting. */
export const IMAGE_TOKEN_PLACEHOLDER = '[image]';

export const DEEPSEEK_IMAGE_TOKEN_RULE = Object.freeze({
  provider: 'deepseek',
  version: 'measured-probe-v1',
  source: 'out-test/image-tokenization-report.json (Stage 0 probe, deepseek-v4.1-flash-1017)',
  verified: false,
  measured: true,
  gridPixels: 42,
  columnOverhead: 1,
  tailTokens: 2,
  ceilingTokens: 1024,
  hasFloor: false
});

/** Qwen and Anthropic lanes carry no vendor text in this repository at all. */
export const IMPLEMENTATION_IMAGE_TOKEN_RULE_VERSION = 'implementation-v1';

const QWEN_DEFAULT_TILE_PIXELS = 32;
const QWEN25_VL_TILE_PIXELS = 28;
const QWEN_IMAGE_TOKEN_MIN = 4;
const QWEN_IMAGE_TOKEN_MAX = 1280;
const ANTHROPIC_PIXELS_PER_TOKEN = 750;
const CONSERVATIVE_IMAGE_TOKEN_ESTIMATE = 1280;
const QWEN25_VL_MODEL_PATTERN = /qwen2[.-]5[-_]?vl/iu;
const DATA_URL_PATTERN = /data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+/giu;
const BASE64_FIELD_PATTERN = /("(?:data|url)"\s*:\s*")([A-Za-z0-9+/=]{256,})(")/gu;

/**
 * `rows = ceil(h/gridPixels)`, `columns = ceil(w/gridPixels)`,
 * `tokens = min(ceilingTokens, rows * (columns + columnOverhead) + tailTokens)`.
 *
 * Every coefficient is read from `DEEPSEEK_IMAGE_TOKEN_RULE`; no other module
 * may restate a bare grid size, tail or ceiling.
 */
export function estimateDeepSeekImageTokens(width: number, height: number): number {
  const rule = DEEPSEEK_IMAGE_TOKEN_RULE;
  const columns = Math.ceil(width / rule.gridPixels);
  const rows = Math.ceil(height / rule.gridPixels);
  return Math.min(rule.ceilingTokens, rows * (columns + rule.columnOverhead) + rule.tailTokens);
}

export interface ImageTokenRuleDescription {
  provider: string;
  formula: string;
  source: string;
  version: string;
  /** True only when vendor-published text is quoted next to the coefficients. */
  verified: boolean;
  /** True when a live probe measured this lane in this repository. */
  measured: boolean;
}

/**
 * Describes the rule a lane is priced with, so trace and UI can show provenance
 * instead of implying that every lane is officially specified.
 */
export function describeImageTokenRule(provider?: string | null): ImageTokenRuleDescription {
  const rule = DEEPSEEK_IMAGE_TOKEN_RULE;
  switch (normalizeImageProviderKey(provider)) {
    case 'deepseek':
      return {
        provider: 'deepseek',
        formula: `tokens = min(${rule.ceilingTokens}, ceil(h/${rule.gridPixels})`
          + ` * (ceil(w/${rule.gridPixels}) + ${rule.columnOverhead}) + ${rule.tailTokens})`,
        source: rule.source,
        version: rule.version,
        verified: rule.verified,
        measured: rule.measured
      };
    case 'qwen':
      return {
        provider: 'qwen',
        formula: 'tokens = clamp(ceil(h/tile) * ceil(w/tile) + 2, 4, 1280), tile = 28 | 32',
        source: 'implementation only: no qwen image-token text was read or measured here',
        version: IMPLEMENTATION_IMAGE_TOKEN_RULE_VERSION,
        verified: false,
        measured: false
      };
    case 'anthropic':
      return {
        provider: 'anthropic',
        formula: 'tokens = ceil(w * h / 750)',
        source: 'implementation comment only (~1 token per 750 px^2); never measured here',
        version: IMPLEMENTATION_IMAGE_TOKEN_RULE_VERSION,
        verified: false,
        measured: false
      };
    default:
      return {
        provider: 'unknown',
        formula: 'tokens = max(1280, ceil(w * h / 750))',
        source: 'conservative allowance for an unmeasured lane',
        version: IMPLEMENTATION_IMAGE_TOKEN_RULE_VERSION,
        verified: false,
        measured: false
      };
  }
}

/** Qwen3-VL/qwen-vl-max use a 32 px tile, Qwen2.5-VL a 28 px tile. Unknown
 * Qwen variants keep the 32 px tile, which is the smaller of the two token
 * counts for a fixed image and therefore the conservative choice only when the
 * real tile is 32; `estimateQwenImageTokens` records this explicitly. */
export function resolveQwenTilePixels(modelId?: string | null): number {
  return QWEN25_VL_MODEL_PATTERN.test(modelId ?? '') ? QWEN25_VL_TILE_PIXELS : QWEN_DEFAULT_TILE_PIXELS;
}

/**
 * `h_bar = ceil(h/tp)*tp`, `w_bar = ceil(w/tp)*tp`,
 * `tokens = clamp(h_bar*w_bar/(tp*tp) + 2, 4, 1280)`; the area term reduces to
 * `ceil(h/tp) * ceil(w/tp)`. No vendor source was available for this lane, so
 * the formula is implementation-only and marked unverified in the delivery.
 */
export function estimateQwenImageTokens(
  width: number,
  height: number,
  modelId?: string | null
): number {
  const tilePixels = resolveQwenTilePixels(modelId);
  const tilesWide = Math.ceil(width / tilePixels);
  const tilesTall = Math.ceil(height / tilePixels);
  const tokens = tilesWide * tilesTall + 2;
  return Math.min(QWEN_IMAGE_TOKEN_MAX, Math.max(QWEN_IMAGE_TOKEN_MIN, tokens));
}

/** Anthropic reports roughly one token per 750 px^2. */
export function estimateAnthropicImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / ANTHROPIC_PIXELS_PER_TOKEN);
}

/** Unknown lanes get the larger of a 1280-token floor and the pixel-scoped
 * Anthropic estimate, so an unmeasured lane is never under-counted. */
export function estimateUnknownProviderImageTokens(width: number, height: number): number {
  return Math.max(
    CONSERVATIVE_IMAGE_TOKEN_ESTIMATE,
    Math.ceil((width * height) / ANTHROPIC_PIXELS_PER_TOKEN)
  );
}

export function estimateImageTokens(input: ImageTokenEstimateInput): number {
  const width = normalizeImagePixels(input.width);
  const height = normalizeImagePixels(input.height);
  if (!width || !height) {
    // Geometry unknown: fall back to the conservative allowance instead of a
    // character count over the base64 payload.
    return CONSERVATIVE_IMAGE_TOKEN_ESTIMATE;
  }
  switch (normalizeImageProviderKey(input.provider)) {
    case 'deepseek':
      return estimateDeepSeekImageTokens(width, height);
    case 'qwen':
      return estimateQwenImageTokens(width, height, input.modelId);
    case 'anthropic':
      return estimateAnthropicImageTokens(width, height);
    default:
      return estimateUnknownProviderImageTokens(width, height);
  }
}

export interface ImageTokenProjection {
  /** The input text with every base64 image payload replaced by a placeholder. */
  text: string;
  /** Tokens contributed by the removed payloads, from image geometry only. */
  imageTokens: number;
}

/**
 * Replaces base64 image payloads with a fixed placeholder and prices them by
 * geometry, so a serialized request can be character-counted without ever
 * feeding base64 to `estimateTokenCount`. Both wire shapes are covered: data
 * URLs anywhere in the text, and raw base64 carried by a `data`/`url` field
 * (the Anthropic `source.data` shape).
 */
export function projectImagePayloadsForTokenEstimate(
  value: string,
  options: ImageTokenEstimateOptions = {}
): ImageTokenProjection {
  let imageTokens = 0;
  const withoutDataUrls = value.replace(DATA_URL_PATTERN, (match: string) => {
    const payloadOffset = match.indexOf(',') + 1;
    imageTokens += estimateBase64ImageTokens(match.slice(payloadOffset), options)
      ?? CONSERVATIVE_IMAGE_TOKEN_ESTIMATE;
    return IMAGE_TOKEN_PLACEHOLDER;
  });
  const text = withoutDataUrls.replace(
    BASE64_FIELD_PATTERN,
    (match: string, prefix: string, payload: string, suffix: string) => {
      const tokens = estimateBase64ImageTokens(payload, options);
      if (tokens === undefined) {
        return match;
      }
      imageTokens += tokens;
      return `${prefix}${IMAGE_TOKEN_PLACEHOLDER}${suffix}`;
    }
  );
  return { text, imageTokens };
}

/** Character estimate of a projected request with image payloads priced by
 * geometry. Drop-in replacement for `estimateTokenCount(serializedRequest)`. */
export function estimateProjectedTokenCount(
  value: string,
  options: ImageTokenEstimateOptions = {}
): number {
  const projection = projectImagePayloadsForTokenEstimate(value, options);
  return estimateTokenCount(projection.text) + projection.imageTokens;
}

function estimateBase64ImageTokens(
  payload: string,
  options: ImageTokenEstimateOptions
): number | undefined {
  const header = readImageHeader(decodeBase64Prefix(payload));
  if (!header) {
    return undefined;
  }
  return estimateImageTokens({
    width: header.width,
    height: header.height,
    provider: options.provider,
    modelId: options.modelId
  });
}

function normalizeImageProviderKey(provider: string | null | undefined): 'deepseek' | 'qwen' | 'anthropic' | 'unknown' {
  const normalized = (provider ?? '').trim().toLowerCase();
  if (normalized === 'deepseek') {
    return 'deepseek';
  }
  if (normalized === 'qwencloud' || normalized === 'qwen') {
    return 'qwen';
  }
  if (normalized === 'anthropic-compatible' || normalized === 'anthropic') {
    return 'anthropic';
  }
  return 'unknown';
}

function normalizeImagePixels(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
