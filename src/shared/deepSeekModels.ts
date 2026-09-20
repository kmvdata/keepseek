/**
 * Stable local identities for DeepSeek models whose capabilities and official
 * billing aliases are known. This table is intentionally exact: a new model
 * must be reviewed and added explicitly instead of inheriting facts from a
 * name prefix.
 */
export const DEEPSEEK_MODEL_IDENTITY_VERSION = 'deepseek-model-identity-v1';

export const DEEPSEEK_FLASH_CANONICAL_MODEL_ID = 'deepseek-v4-flash';
export const DEEPSEEK_FLASH_CANONICAL_FAMILY = 'deepseek-v4-flash-family';
export const DEEPSEEK_FLASH_PRICING_KEY = 'deepseek-v4.1-flash';
export const DEEPSEEK_PRO_CANONICAL_MODEL_ID = 'deepseek-v4-pro';
export const DEEPSEEK_PRO_CANONICAL_FAMILY = 'deepseek-v4-pro-family';
export const DEEPSEEK_PRO_PRICING_KEY = 'deepseek-v4-pro';
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_048_576;
export const DEEPSEEK_V4_MAX_OUTPUT_TOKENS = 393_216;

export type DeepSeekCanonicalFamily =
  | typeof DEEPSEEK_FLASH_CANONICAL_FAMILY
  | typeof DEEPSEEK_PRO_CANONICAL_FAMILY;

export interface DeepSeekModelIdentity {
  canonicalFamily: DeepSeekCanonicalFamily;
  canonicalModelId: typeof DEEPSEEK_FLASH_CANONICAL_MODEL_ID | typeof DEEPSEEK_PRO_CANONICAL_MODEL_ID;
  pricingKey: typeof DEEPSEEK_FLASH_PRICING_KEY | typeof DEEPSEEK_PRO_PRICING_KEY;
  contextWindowTokens: number;
  maxOutputTokens: number;
}

const FLASH_IDENTITY: DeepSeekModelIdentity = Object.freeze({
  canonicalFamily: DEEPSEEK_FLASH_CANONICAL_FAMILY,
  canonicalModelId: DEEPSEEK_FLASH_CANONICAL_MODEL_ID,
  pricingKey: DEEPSEEK_FLASH_PRICING_KEY,
  contextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS
});

const PRO_IDENTITY: DeepSeekModelIdentity = Object.freeze({
  canonicalFamily: DEEPSEEK_PRO_CANONICAL_FAMILY,
  canonicalModelId: DEEPSEEK_PRO_CANONICAL_MODEL_ID,
  pricingKey: DEEPSEEK_PRO_PRICING_KEY,
  contextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  maxOutputTokens: DEEPSEEK_V4_MAX_OUTPUT_TOKENS
});

const KNOWN_DEEPSEEK_MODELS: Readonly<Record<string, DeepSeekModelIdentity>> = Object.freeze({
  'deepseek-flash': FLASH_IDENTITY,
  'deepseek-v4.1-flash': FLASH_IDENTITY,
  'deepseek-v4-flash': FLASH_IDENTITY,
  'deepseek-v4-flash-vision-exp': FLASH_IDENTITY,
  'deepseek-v4-pro': PRO_IDENTITY
});

export function getDeepSeekModelIdentity(modelId: string | undefined): DeepSeekModelIdentity | undefined {
  const normalized = normalizeKnownModelId(modelId);
  const identity = normalized ? KNOWN_DEEPSEEK_MODELS[normalized] : undefined;
  return identity ? { ...identity } : undefined;
}

export function getCanonicalModelIdentity(modelId: string | undefined): string {
  const identity = getDeepSeekModelIdentity(modelId);
  return identity?.canonicalModelId ?? normalizeKnownModelId(modelId) ?? 'unknown-model';
}

export function getCanonicalPricingKey(modelId: string | undefined): string | undefined {
  return getDeepSeekModelIdentity(modelId)?.pricingKey;
}

export function isDeepSeekFlashIdentity(
  identity: DeepSeekModelIdentity | undefined
): boolean {
  return identity?.canonicalFamily === DEEPSEEK_FLASH_CANONICAL_FAMILY;
}

function normalizeKnownModelId(modelId: string | undefined): string | undefined {
  const normalized = (modelId ?? '').normalize('NFKC').trim().toLowerCase();
  return normalized || undefined;
}
