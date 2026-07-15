import type { AgentSettings, KeepseekModel } from './types';

export const DEEPSEEK_V4_FLASH_MODEL_ID = 'deepseek-v4-flash';
export const DEEPSEEK_V4_PRO_MODEL_ID = 'deepseek-v4-pro';
export const DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS = 1_000_000;

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

export interface DeepSeekV4RuntimeProfile {
  modelId: DeepSeekV4ModelId;
  reasoningMode: 'non-thinking' | 'high' | 'max';
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

export function getSupportedDeepSeekV4Models(): KeepseekModel[] {
  return SUPPORTED_MODELS.map((model) => ({ ...model }));
}

export function normalizeDeepSeekV4ModelId(modelId: string | undefined): DeepSeekV4ModelId {
  return modelId === DEEPSEEK_V4_PRO_MODEL_ID
    ? DEEPSEEK_V4_PRO_MODEL_ID
    : DEEPSEEK_V4_FLASH_MODEL_ID;
}

export function getDeepSeekV4RuntimeProfile(
  model: Pick<KeepseekModel, 'id'> | string,
  settings: AgentSettings
): DeepSeekV4RuntimeProfile {
  const modelId = normalizeDeepSeekV4ModelId(typeof model === 'string' ? model : model.id);
  const reasoningMode = settings.thinkingEnabled
    ? settings.reasoningEffort === 'max' ? 'max' : 'high'
    : 'non-thinking';
  const selected = modelId === DEEPSEEK_V4_PRO_MODEL_ID
    ? PRO_PROFILES[reasoningMode]
    : FLASH_PROFILES[reasoningMode];

  return {
    modelId,
    reasoningMode,
    maxTokens: selected.maxTokens,
    maxToolIterations: selected.maxToolIterations,
    maxToolCalls: selected.maxToolCalls,
    maxRunMs: selected.maxRunMs,
    toolResultTokenBudget: selected.toolResultTokenBudget,
    streamIdleTimeoutMs: 0,
    temperature: 1,
    topP: 1,
    contextCompression: { ...selected.contextCompression }
  };
}

export function getDeepSeekV4ContextCompressionSettings(
  model: Pick<KeepseekModel, 'id'> | string,
  settings: AgentSettings
): ContextCompressionSettings {
  return getDeepSeekV4RuntimeProfile(model, settings).contextCompression;
}
