import type { AgentSettings, CompressionThreshold, KeepseekModel } from './types';
import { getGuessedContextWindowTokens } from './modelContextWindowGuesses';

export const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek-v4-pro';
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;
/**
 * Capability fallback for a model whose source supplies no trustworthy metadata.
 * 32K / 8K is intentionally conservative: KeepSeek must not claim a million-token
 * window or a six-figure completion limit merely because a compatible endpoint
 * accepted an arbitrary model ID.
 */
export const DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS = 32_768;
export const DEFAULT_GENERIC_MAX_OUTPUT_TOKENS = 8_192;
export const DEFAULT_GENERIC_SUMMARY_BUDGET_TOKENS = 4_000;
export const MAX_MODEL_CONTEXT_WINDOW_TOKENS = 10_000_000;
export const MAX_MODEL_OUTPUT_TOKENS = 1_000_000;

export type DeepSeekV4ModelId =
  | typeof DEEPSEEK_V4_FLASH_MODEL_ID
  | typeof DEEPSEEK_V4_PRO_MODEL_ID;

export interface ContextCompressionSettings {
  keepRecentTurns: number;
  softCompactRatio: number;
  toolResultSnipRatio: number;
  triggerRatio: number;
  forceRatio: number;
  summaryBudgetTokens: number;
  summaryRequestTimeoutMs: number;
}

export interface AgentRuntimeProfile {
  modelId: string;
  profileKind: 'deepseek-v4' | 'generic';
  reasoningMode: 'non-thinking' | 'high' | 'max';
  contextWindowTokens: number;
  maxTokens: number;
  maxToolIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  toolResultTokenBudget: number;
  streamIdleTimeoutMs: number;
  temperature: number;
  topP: number;
  contextCompression: ContextCompressionSettings;
}

export interface DeepSeekV4RuntimeProfile extends AgentRuntimeProfile {
  modelId: DeepSeekV4ModelId;
  profileKind: 'deepseek-v4';
}

export const COMPRESSION_THRESHOLDS: Record<
  CompressionThreshold,
  Pick<ContextCompressionSettings, 'triggerRatio' | 'forceRatio'>
> = {
  aggressive: { triggerRatio: 0.7, forceRatio: 0.85 },
  balanced: { triggerRatio: 0.8, forceRatio: 0.92 },
  cache: { triggerRatio: 0.85, forceRatio: 0.95 }
};

type RuntimeAgentSettings = Pick<AgentSettings, 'thinkingEnabled' | 'reasoningEffort'>
  & Partial<Pick<AgentSettings, 'compressionThreshold'>>;

const SUPPORTED_MODELS: readonly KeepseekModel[] = [
  {
    id: DEEPSEEK_V4_FLASH_MODEL_ID,
    label: 'DeepSeek-V4-Flash',
    provider: 'deepseek',
    contextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
  },
  {
    id: DEEPSEEK_V4_PRO_MODEL_ID,
    label: 'DeepSeek-V4-Pro',
    provider: 'deepseek',
    contextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
  }
];

const FLASH_PROFILES = {
  'non-thinking': {
    maxTokens: 48_000,
    maxToolIterations: 16,
    maxToolCalls: 48,
    maxRunMs: 600_000,
    toolResultTokenBudget: 160_000,
    contextCompression: {
      keepRecentTurns: 14,
      softCompactRatio: 0.38,
      toolResultSnipRatio: 0.48,
      triggerRatio: 0.58,
      forceRatio: 0.72,
      summaryBudgetTokens: 6_000,
      summaryRequestTimeoutMs: 45_000
    }
  },
  high: {
    maxTokens: 96_000,
    maxToolIterations: 24,
    maxToolCalls: 72,
    maxRunMs: 1_200_000,
    toolResultTokenBudget: 240_000,
    contextCompression: {
      keepRecentTurns: 12,
      softCompactRatio: 0.34,
      toolResultSnipRatio: 0.44,
      triggerRatio: 0.54,
      forceRatio: 0.68,
      summaryBudgetTokens: 8_000,
      summaryRequestTimeoutMs: 60_000
    }
  },
  max: {
    maxTokens: 192_000,
    maxToolIterations: 32,
    maxToolCalls: 96,
    maxRunMs: 1_800_000,
    toolResultTokenBudget: 320_000,
    contextCompression: {
      keepRecentTurns: 10,
      softCompactRatio: 0.28,
      toolResultSnipRatio: 0.38,
      triggerRatio: 0.46,
      forceRatio: 0.62,
      summaryBudgetTokens: 10_000,
      summaryRequestTimeoutMs: 75_000
    }
  }
} as const;

const PRO_PROFILES = {
  'non-thinking': {
    maxTokens: 64_000,
    maxToolIterations: 20,
    maxToolCalls: 64,
    maxRunMs: 900_000,
    toolResultTokenBudget: 200_000,
    contextCompression: {
      keepRecentTurns: 18,
      softCompactRatio: 0.46,
      toolResultSnipRatio: 0.58,
      triggerRatio: 0.7,
      forceRatio: 0.84,
      summaryBudgetTokens: 8_000,
      summaryRequestTimeoutMs: 60_000
    }
  },
  high: {
    maxTokens: 128_000,
    maxToolIterations: 32,
    maxToolCalls: 96,
    maxRunMs: 1_800_000,
    toolResultTokenBudget: 320_000,
    contextCompression: {
      keepRecentTurns: 16,
      softCompactRatio: 0.4,
      toolResultSnipRatio: 0.52,
      triggerRatio: 0.62,
      forceRatio: 0.78,
      summaryBudgetTokens: 12_000,
      summaryRequestTimeoutMs: 90_000
    }
  },
  max: {
    maxTokens: 256_000,
    maxToolIterations: 48,
    maxToolCalls: 144,
    maxRunMs: 3_600_000,
    toolResultTokenBudget: 400_000,
    contextCompression: {
      keepRecentTurns: 12,
      softCompactRatio: 0.32,
      toolResultSnipRatio: 0.45,
      triggerRatio: 0.5,
      forceRatio: 0.7,
      summaryBudgetTokens: 16_000,
      summaryRequestTimeoutMs: 120_000
    }
  }
} as const;

const GENERIC_PROFILE = {
  maxToolIterations: 16,
  maxToolCalls: 48,
  maxRunMs: 600_000,
  maxToolResultTokenBudget: 64_000,
  streamIdleTimeoutMs: 0,
  temperature: 1,
  topP: 1,
  contextCompression: {
    keepRecentTurns: 8,
    softCompactRatio: 0.5,
    toolResultSnipRatio: 0.6,
    summaryRequestTimeoutMs: 45_000
  }
} as const;

export function getSupportedDeepSeekV4Models(): KeepseekModel[] {
  return SUPPORTED_MODELS.map((model) => ({ ...model }));
}

export function normalizeDeepSeekV4ModelId(modelId: string | undefined): DeepSeekV4ModelId {
  return modelId === DEEPSEEK_V4_PRO_MODEL_ID
    ? DEEPSEEK_V4_PRO_MODEL_ID
    : DEEPSEEK_V4_FLASH_MODEL_ID;
}

export function getEffectiveContextWindowTokens(
  model?: Pick<KeepseekModel, 'id' | 'provider' | 'contextWindowTokens'>
): number {
  const declared = normalizeCapabilityTokens(
    model?.contextWindowTokens,
    MAX_MODEL_CONTEXT_WINDOW_TOKENS
  );
  if (declared) {
    return declared;
  }
  return model && isDeepSeekV4Model(model)
    ? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
    : getGuessedContextWindowTokens(model?.id) ?? DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS;
}

/**
 * Resolves all runtime and context-budget behavior in one provider-safe place.
 * Catalog construction has already applied manual > discovered > built-in
 * metadata precedence; this layer validates and clamps the resulting evidence.
 */
export function getAgentRuntimeProfile(
  model: KeepseekModel,
  settings: RuntimeAgentSettings
): AgentRuntimeProfile {
  const threshold = COMPRESSION_THRESHOLDS[settings.compressionThreshold ?? 'balanced']
    ?? COMPRESSION_THRESHOLDS.balanced;
  const reasoningMode = getReasoningMode(settings);
  const contextWindowTokens = getEffectiveContextWindowTokens(model);
  const declaredMaxOutputTokens = normalizeCapabilityTokens(
    model.maxOutputTokens,
    MAX_MODEL_OUTPUT_TOKENS
  );

  if (isDeepSeekV4Model(model)) {
    const selected = model.id === DEEPSEEK_V4_PRO_MODEL_ID
      ? PRO_PROFILES[reasoningMode]
      : FLASH_PROFILES[reasoningMode];
    const maxTokens = Math.min(
      selected.maxTokens,
      declaredMaxOutputTokens ?? selected.maxTokens,
      contextWindowTokens
    );
    return {
      modelId: model.id,
      profileKind: 'deepseek-v4',
      reasoningMode,
      contextWindowTokens,
      maxTokens,
      maxToolIterations: selected.maxToolIterations,
      maxToolCalls: selected.maxToolCalls,
      maxRunMs: selected.maxRunMs,
      toolResultTokenBudget: Math.min(selected.toolResultTokenBudget, contextWindowTokens),
      streamIdleTimeoutMs: 0,
      temperature: 1,
      topP: 1,
      contextCompression: {
        ...selected.contextCompression,
        ...threshold,
        summaryBudgetTokens: Math.min(selected.contextCompression.summaryBudgetTokens, maxTokens)
      }
    };
  }

  // Thinking settings may change protocol fields where the provider supports
  // them, but they never inflate an unknown model's evidence-backed limits.
  const maxTokens = Math.min(
    declaredMaxOutputTokens ?? DEFAULT_GENERIC_MAX_OUTPUT_TOKENS,
    contextWindowTokens
  );
  return {
    modelId: model.id,
    profileKind: 'generic',
    reasoningMode,
    contextWindowTokens,
    maxTokens,
    maxToolIterations: GENERIC_PROFILE.maxToolIterations,
    maxToolCalls: GENERIC_PROFILE.maxToolCalls,
    maxRunMs: GENERIC_PROFILE.maxRunMs,
    toolResultTokenBudget: Math.max(1, Math.min(
      GENERIC_PROFILE.maxToolResultTokenBudget,
      Math.floor(contextWindowTokens * 0.5)
    )),
    streamIdleTimeoutMs: GENERIC_PROFILE.streamIdleTimeoutMs,
    temperature: GENERIC_PROFILE.temperature,
    topP: GENERIC_PROFILE.topP,
    contextCompression: {
      ...GENERIC_PROFILE.contextCompression,
      ...threshold,
      summaryBudgetTokens: Math.min(DEFAULT_GENERIC_SUMMARY_BUDGET_TOKENS, maxTokens)
    }
  };
}

export function getAgentContextCompressionSettings(
  model: KeepseekModel,
  settings: RuntimeAgentSettings
): ContextCompressionSettings {
  return getAgentRuntimeProfile(model, settings).contextCompression;
}

export function getDeepSeekV4RuntimeProfile(
  model: Pick<KeepseekModel, 'id'> | string,
  settings: RuntimeAgentSettings
): DeepSeekV4RuntimeProfile {
  const modelId = normalizeDeepSeekV4ModelId(typeof model === 'string' ? model : model.id);
  return getAgentRuntimeProfile({
    id: modelId,
    label: modelId,
    provider: 'deepseek',
    contextWindowTokens: DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
  }, settings) as DeepSeekV4RuntimeProfile;
}

export function getDeepSeekV4ContextCompressionSettings(
  model: Pick<KeepseekModel, 'id'> | string,
  settings: RuntimeAgentSettings
): ContextCompressionSettings {
  return getDeepSeekV4RuntimeProfile(model, settings).contextCompression;
}

function getReasoningMode(
  settings: RuntimeAgentSettings
): AgentRuntimeProfile['reasoningMode'] {
  return settings.thinkingEnabled
    ? settings.reasoningEffort === 'max' ? 'max' : 'high'
    : 'non-thinking';
}

function isDeepSeekV4Model(
  model: Pick<KeepseekModel, 'id' | 'provider'>
): model is Pick<KeepseekModel, 'id' | 'provider'> & { id: DeepSeekV4ModelId } {
  return model.provider === 'deepseek'
    && (model.id === DEEPSEEK_V4_FLASH_MODEL_ID || model.id === DEEPSEEK_V4_PRO_MODEL_ID);
}

function normalizeCapabilityTokens(value: number | undefined, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
    ? Math.floor(value)
    : undefined;
}
