interface ModelContextWindowGuessRule {
  aliases: readonly string[];
  tokens: number;
}

/**
 * Low-trust context-window hints for providers whose /models response omits
 * capability metadata. Rules are deliberately centralized, ordered from the
 * most specific family to the broadest, and never persisted as provider facts.
 * A user override or discovered value always wins in the model catalog.
 */
const MODEL_CONTEXT_WINDOW_GUESS_RULES: readonly ModelContextWindowGuessRule[] = [
  { aliases: ['llama-4-scout', 'qwen-long'], tokens: 10_000_000 },

  { aliases: ['gpt-5-4-mini', 'gpt-5-2-codex'], tokens: 400_000 },
  {
    aliases: [
      'gemini-3-1-pro',
      'gemini-3-5-flash',
      'gemini-3-6-flash',
      'gemini-2-5-pro'
    ],
    tokens: 1_048_576
  },
  {
    aliases: [
      'gpt-5-5',
      'gpt-5-4',
      'claude-opus-4-8',
      'claude-4-8-opus',
      'claude-opus-4-7',
      'claude-4-7-opus',
      'claude-opus-4-6',
      'claude-4-6-opus',
      'claude-sonnet-4-6',
      'claude-4-6-sonnet',
      'claude-fable-5',
      'qwen3-8-max',
      'qwen-3-8-max',
      'qwen3-5-plus',
      'qwen-3-5-plus',
      'deepseek-v4',
      'deepseek-v3-2',
      'glm-5-2',
      'kimi-k3',
      'minimax-m3'
    ],
    tokens: 1_000_000
  },
  {
    aliases: ['kimi-k2-7', 'kimi-k2-6', 'kimi-k2-5'],
    tokens: 256_000
  },
  {
    aliases: [
      'claude-sonnet-4-5',
      'claude-4-5-sonnet',
      'claude-haiku-4-5',
      'claude-4-5-haiku',
      'glm-5-1',
      'glm-5',
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
      'ernie-4-5',
      'ernie-4-0-turbo',
      'ernie-3-5-turbo',
      'qwen-2-5',
      'qwen2-5'
    ],
    tokens: 128_000
  },
  { aliases: ['gpt-4-32k'], tokens: 32_768 },
  { aliases: ['qwen-omni-turbo'], tokens: 32_768 },
  { aliases: ['gpt-4-8k', 'gpt-4'], tokens: 8_192 }
];

export function getGuessedContextWindowTokens(modelId: string | undefined): number | undefined {
  const normalizedId = normalizeModelIdForGuess(modelId);
  if (!normalizedId) {
    return undefined;
  }
  for (const rule of MODEL_CONTEXT_WINDOW_GUESS_RULES) {
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
