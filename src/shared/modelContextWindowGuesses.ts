import type { NonTextModelKind } from './types';

interface ModelTokenGuessRule {
  aliases: readonly string[];
  tokens: number;
}

interface NonTextModelRule {
  aliases: readonly string[];
  kind: NonTextModelKind;
}

/**
 * Low-trust context-window hints for providers whose /models response omits
 * capability metadata. Rules are deliberately centralized, ordered from the
 * most specific family to the broadest, and never persisted as provider facts.
 * A user override or discovered value always wins in the model catalog.
 */
const MODEL_CONTEXT_WINDOW_GUESS_RULES: readonly ModelTokenGuessRule[] = [
  { aliases: ['llama-4-scout', 'qwen-long'], tokens: 10_000_000 },

  { aliases: ['gpt-5-4-mini', 'gpt-5-2-codex'], tokens: 400_000 },
  { aliases: ['gpt-5-4'], tokens: 1_050_000 },
  {
    aliases: [
      'gemini-3-1-pro',
      'gemini-3-5-flash',
      'gemini-2-5-pro'
    ],
    tokens: 1_048_576
  },
  {
    aliases: [
      'gpt-5-5',
      'claude-opus-5',
      'claude-5-opus',
      'claude-sonnet-5',
      'claude-5-sonnet',
      'claude-opus-4-8',
      'claude-4-8-opus',
      'claude-opus-4-7',
      'claude-4-7-opus',
      'claude-opus-4-6',
      'claude-4-6-opus',
      'claude-sonnet-4-6',
      'claude-4-6-sonnet',
      'claude-fable-5',
      'claude-5-fable',
      'gemini-3-6-flash',
      'gemini-3-7-flash',
      'qwen3-8-2-4t-a95b',
      'qwen-3-8-2-4t-a95b',
      'qwen3-8-max',
      'qwen-3-8-max',
      'qwen3-7-max',
      'qwen-3-7-max',
      'qwen3-7-plus',
      'qwen-3-7-plus',
      'qwen3-6-flash',
      'qwen-3-6-flash',
      'qwen3-5-plus',
      'qwen-3-5-plus',
      'deepseek-v4',
      'deepseek-v3-2',
      'glm-5-2',
      'glm-5-3',
      'kimi-k3',
      'minimax-m3',
      'minimax-m2-5-lightning'
    ],
    tokens: 1_000_000
  },
  { aliases: ['gpt-5'], tokens: 400_000 },
  { aliases: ['kimi-k2-5'], tokens: 262_144 },
  {
    aliases: ['kimi-k2-7', 'kimi-k2-6'],
    tokens: 256_000
  },
  { aliases: ['hy3'], tokens: 256_000 },
  {
    aliases: [
      'claude-sonnet-4-5',
      'claude-4-5-sonnet',
      'claude-haiku-4-5',
      'claude-4-5-haiku',
      'glm-5-turbo',
      'glm-5-1',
      'glm-5',
      'glm-4-7',
      'glm-4-6'
    ],
    tokens: 200_000
  },
  {
    aliases: [
      'gpt-4o',
      'gpt-4-turbo',
      'deepseek-v3-1',
      'deepseek-v3',
      'glm-4-5-air',
      'glm-4-5',
      'ernie-4-5',
      'ernie-4-0-turbo',
      'ernie-3-5-turbo',
      'qwen-2-5',
      'qwen2-5'
    ],
    tokens: 128_000
  },
  { aliases: ['gpt-4-32k'], tokens: 32_768 },
  { aliases: ['qwen-audio-3-0-realtime-plus'], tokens: 40_960 },
  { aliases: ['qwen-omni-turbo'], tokens: 32_768 },
  { aliases: ['gpt-4-8k', 'gpt-4'], tokens: 8_192 }
];

/**
 * Low-trust max-output hints used only when a source supplies no manual,
 * discovered, or built-in capability. Models with no published value are
 * deliberately absent and continue to use the conservative generic fallback.
 */
const MODEL_MAX_OUTPUT_GUESS_RULES: readonly ModelTokenGuessRule[] = [
  {
    aliases: [
      'qwen3-8-2-4t-a95b',
      'qwen-3-8-2-4t-a95b',
      'qwen3-8-max',
      'qwen-3-8-max',
      'qwen3-7-max',
      'qwen-3-7-max',
      'qwen3-7-plus',
      'qwen-3-7-plus'
    ],
    tokens: 131_072
  },
  { aliases: ['qwen3-6-flash', 'qwen-3-6-flash'], tokens: 65_536 },
  { aliases: ['qwen-audio-3-0-realtime-plus'], tokens: 8_192 },
  { aliases: ['gemini-3-1-pro', 'gemini-2-5-pro', 'gemini-3-6-flash'], tokens: 65_535 },
  { aliases: ['gemini-3-7-flash'], tokens: 64_000 },
  { aliases: ['gpt-4o'], tokens: 16_384 },
  { aliases: ['minimax-m2-5-lightning'], tokens: 8_192 },
  { aliases: ['deepseek-v4'], tokens: 384_000 },
  { aliases: ['minimax-m3'], tokens: 131_000 },
  { aliases: ['kimi-k3'], tokens: 131_072 },
  { aliases: ['glm-4-5-air', 'glm-4-5'], tokens: 96_000 },
  {
    aliases: [
      'gpt-5',
      'claude-opus-5',
      'claude-5-opus',
      'claude-sonnet-5',
      'claude-5-sonnet',
      'claude-fable-5',
      'claude-5-fable',
      'glm-5-3',
      'glm-5-2',
      'glm-5-turbo',
      'glm-5-1',
      'glm-5',
      'glm-4-7',
      'glm-4-6'
    ],
    tokens: 128_000
  }
];

const NON_TEXT_MODEL_RULES: readonly NonTextModelRule[] = [
  {
    aliases: ['wan2-7-image-pro', 'wan2-7-image'],
    kind: 'image-generation'
  },
  {
    aliases: ['qwen-audio-3-0-tts-plus'],
    kind: 'speech-synthesis'
  }
];

export function getGuessedContextWindowTokens(modelId: string | undefined): number | undefined {
  return getGuessedTokens(modelId, MODEL_CONTEXT_WINDOW_GUESS_RULES);
}

export function getGuessedMaxOutputTokens(modelId: string | undefined): number | undefined {
  return getGuessedTokens(modelId, MODEL_MAX_OUTPUT_GUESS_RULES);
}

export function getKnownNonTextModelKind(
  modelId: string | undefined
): NonTextModelKind | undefined {
  const normalizedId = normalizeModelIdForGuess(modelId);
  if (!normalizedId) {
    return undefined;
  }
  for (const rule of NON_TEXT_MODEL_RULES) {
    if (rule.aliases.some((alias) => matchesNormalizedModelFamily(normalizedId, alias))) {
      return rule.kind;
    }
  }
  return undefined;
}

function getGuessedTokens(
  modelId: string | undefined,
  rules: readonly ModelTokenGuessRule[]
): number | undefined {
  const normalizedId = normalizeModelIdForGuess(modelId);
  if (!normalizedId) {
    return undefined;
  }
  for (const rule of rules) {
    if (rule.aliases.some((alias) => matchesNormalizedModelFamily(normalizedId, alias))) {
      return rule.tokens;
    }
  }
  return undefined;
}

function normalizeModelIdForGuess(modelId: string | undefined): string {
  return (modelId ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');
}

function matchesNormalizedModelFamily(normalizedId: string, alias: string): boolean {
  let offset = normalizedId.indexOf(alias);
  while (offset >= 0) {
    const beforeMatches = offset === 0 || normalizedId[offset - 1] === '-';
    const afterOffset = offset + alias.length;
    const afterMatches = afterOffset === normalizedId.length || normalizedId[afterOffset] === '-';
    if (beforeMatches && afterMatches) {
      return true;
    }
    offset = normalizedId.indexOf(alias, offset + 1);
  }
  return false;
}
