/**
 * Per-lane geometry limit for composer image attachments.
 *
 * The one measured image lane (`agent/multimodal/imageTokens.ts`) is
 * `deepseek-v4.1-flash-1017`: it resamples every input onto a 31×31 grid of
 * 42 px cells, so it keeps at most 31 × 42 = 1302 px per edge. Bytes beyond that
 * edge are resampled away by the lane, so sending them only grows the upload and
 * the token bill without adding detail.
 *
 * Lanes that were never measured keep the 1568 px long edge the composer
 * transcode already used. Only the long edge is limited: the ratio is preserved
 * by the caller, so a panorama and a portrait both fit the same range.
 */
export const DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE = 1568;

/** 31 cells × 42 px: the measured native grid of the DeepSeek flash lane. */
export const DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE = 1302;

const DEEPSEEK_V41_FLASH_MODEL_PATTERN = /^deepseek-v4\.1-flash(?:$|[-_.])/iu;

export interface ImageAttachmentLimitInput {
  provider?: string | null;
  modelId?: string | null;
}

/**
 * Deterministic: the same provider/model pair always resolves to the same long
 * edge, so the composer crops to a limit that was decided by the lane itself and
 * no request is ever made to discover it.
 */
export function resolveImageAttachmentMaxEdge(input: ImageAttachmentLimitInput = {}): number {
  const provider = (input.provider ?? '').trim().toLowerCase();
  const modelId = (input.modelId ?? '').trim();
  if (provider === 'deepseek' && DEEPSEEK_V41_FLASH_MODEL_PATTERN.test(modelId)) {
    return DEEPSEEK_V41_FLASH_IMAGE_MAX_EDGE;
  }
  return DEFAULT_IMAGE_ATTACHMENT_MAX_EDGE;
}