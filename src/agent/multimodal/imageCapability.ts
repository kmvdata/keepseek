/**
 * Image lane admission.
 *
 * The stage 0 probe measured exactly one Chat Completions lane live: KeepSeek
 * `provider=deepseek`, that account's configured MaaS endpoint host
 * `token-plan.maas.qwencloudapi.com`, model `deepseek-v4.1-flash-1017` (the model
 * id was not in the account's model list). That is a source + endpoint
 * observation, not a statement about DeepSeek's public API. Qwen-VL and
 * Anthropic Messages were never measured here and stay unverified.
 *
 * Policy: only the measured lane is `supported`. Every other lane is
 * `unverified` and refuses to *send* this turn's new images; images already in
 * history degrade to placeholder text so a text-only turn still works.
 * `unsupported` marks a lane that cannot carry images at all in v1.
 * v1 adds no configuration switch for this policy.
 */
export type ImageLaneCapability = 'supported' | 'unverified' | 'unsupported';

export type ImageLaneReasonCode =
  | 'image_lane_measured'
  | 'image_lane_unverified'
  | 'image_lane_unsupported';

export interface ImageLaneDecision {
  capability: ImageLaneCapability;
  /** Stable code for UI copy lookup; `reason` is the host-side fallback text. */
  reasonCode: ImageLaneReasonCode;
  reason: { zh: string; en: string };
}

/** The single live-measured lane from the stage 0 probe. */
export const MEASURED_IMAGE_LANE = {
  provider: 'deepseek',
  baseUrlHost: 'token-plan.maas.qwencloudapi.com',
  modelId: 'deepseek-v4.1-flash-1017'
} as const;

const MEASURED_REASON = {
  zh: '该来源与端点是阶段 0 实测过的图片通道。',
  en: 'This source and endpoint is the lane measured with images in stage 0.'
};

const UNVERIFIED_REASON = {
  zh: '该模型通道未实测图片支持，本轮新增图片未发送。请切换到已实测通道，或移除图片后重发。',
  en: 'This lane has not been measured with images, so this turn\'s new images were not sent. Switch to the measured lane or resend without images.'
};

const UNSUPPORTED_REASON = {
  zh: '该协议通道在 v1 不支持图片，本轮新增图片未发送。',
  en: 'This protocol lane does not support images in v1, so this turn\'s new images were not sent.'
};

/** Deterministic lane decision: same provider/protocol/endpoint/model, same
 * capability. No probe is repeated and no request is ever made here. */
export function resolveImageLaneCapability(input: {
  provider?: string | null;
  protocol?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}): ImageLaneDecision {
  const provider = (input.provider ?? '').trim().toLowerCase();
  const protocol = (input.protocol ?? '').trim().toLowerCase();
  if (protocol === 'openai-responses' || provider === 'openai-responses') {
    return { capability: 'unsupported', reasonCode: 'image_lane_unsupported', reason: UNSUPPORTED_REASON };
  }
  if (protocol === 'anthropic-messages' || provider === 'anthropic-compatible') {
    return { capability: 'unverified', reasonCode: 'image_lane_unverified', reason: UNVERIFIED_REASON };
  }
  const measured = provider === MEASURED_IMAGE_LANE.provider
    && endpointHost(input.baseUrl) === MEASURED_IMAGE_LANE.baseUrlHost
    && (input.modelId ?? '').trim() === MEASURED_IMAGE_LANE.modelId;
  return measured
    ? { capability: 'supported', reasonCode: 'image_lane_measured', reason: MEASURED_REASON }
    : { capability: 'unverified', reasonCode: 'image_lane_unverified', reason: UNVERIFIED_REASON };
}

/** True when this turn carries new images and the lane may not send them. */
export function refusesNewImages(decision: ImageLaneDecision, hasNewImages: boolean): boolean {
  return hasNewImages && decision.capability !== 'supported';
}

function endpointHost(baseUrl: string | null | undefined): string {
  const raw = (baseUrl ?? '').trim();
  if (!raw) {
    return '';
  }
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    return '';
  }
}
