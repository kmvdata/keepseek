export const DEEPSEEK_FLASH_MODEL_ID = 'deepseek-flash';
export const DEEPSEEK_V41_FLASH_MODEL_ID = 'deepseek-v4.1-flash';
export const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek-v4-pro';

export type DeepSeekV4ModelId =
  | typeof DEEPSEEK_FLASH_MODEL_ID
  | typeof DEEPSEEK_V41_FLASH_MODEL_ID
  | typeof DEEPSEEK_V4_FLASH_MODEL_ID
  | typeof DEEPSEEK_V4_PRO_MODEL_ID;

export type DeepSeekV4ModelKind = 'flash' | 'pro';

/**
 * Normalize only model IDs whose official billing/runtime identity is known.
 * Do not infer from a broad prefix here: experimental or multimodal resources
 * must not silently inherit text-model pricing or context capabilities.
 */
export function normalizeKnownDeepSeekV4ModelId(
  modelId: string | undefined
): DeepSeekV4ModelId | undefined {
  const normalized = (modelId ?? '').normalize('NFKC').trim().toLowerCase();
  switch (normalized) {
    case DEEPSEEK_FLASH_MODEL_ID:
    case DEEPSEEK_V41_FLASH_MODEL_ID:
    case DEEPSEEK_V4_FLASH_MODEL_ID:
    case DEEPSEEK_V4_PRO_MODEL_ID:
      return normalized;
    default:
      return undefined;
  }
}

export function getDeepSeekV4ModelKind(
  modelId: string | undefined
): DeepSeekV4ModelKind | undefined {
  const normalized = normalizeKnownDeepSeekV4ModelId(modelId);
  if (!normalized) {
    return undefined;
  }
  return normalized === DEEPSEEK_V4_PRO_MODEL_ID ? 'pro' : 'flash';
}

/** Canonical price-table key for official model aliases returned by /models. */
export function getDeepSeekPricingModelId(
  modelId: string | undefined
): typeof DEEPSEEK_V41_FLASH_MODEL_ID | typeof DEEPSEEK_V4_PRO_MODEL_ID | undefined {
  const kind = getDeepSeekV4ModelKind(modelId);
  return kind === 'flash'
    ? DEEPSEEK_V41_FLASH_MODEL_ID
    : kind === 'pro' ? DEEPSEEK_V4_PRO_MODEL_ID : undefined;
}
