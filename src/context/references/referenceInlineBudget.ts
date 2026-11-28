import type { KeepseekModel, ModelCapabilitySource } from '../../shared/types';

/**
 * Lower bound for one message's file-reference inline budget.
 *
 * A model whose window is unknown, guessed, tiny or merely declared as the
 * generic fallback still gets a usable amount of inlined source. Without a
 * floor every reference on such a model would degrade to a pointer, and the
 * agent would pay an extra tool round for content the user already selected.
 */
export const REFERENCE_INLINE_FLOOR_CHARS = 8_000;

/**
 * Upper bound for one message's file-reference inline budget.
 *
 * 24,000 is deliberately well below the 32,000-character first-message guard:
 * that same message must still carry the user's own text, the execution-mode
 * tail and the other provider tail blocks. A ceiling at or above the guard
 * would let one reference set re-create the oversized first message this
 * budget exists to prevent, so the guard would keep firing and the change
 * would have no effect.
 */
export const REFERENCE_INLINE_CEIL_CHARS = 24_000;

/** Share of the declared context window one message may spend inlining. */
const REFERENCE_INLINE_WINDOW_PERCENT = 15;

/**
 * Existing repository convention: one token is budgeted as four characters,
 * the same ratio `getConfiguredTotalContextBudgetTokens() * 4` uses. This
 * module reuses that convention instead of inventing a second one.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Window provenances allowed to scale the budget. `guessed` and `fallback` are
 * omitted on purpose: the generic fallback window is a placeholder, and
 * scaling a budget from a placeholder turns a guess into oversized messages.
 */
const TRUSTED_WINDOW_SOURCES: readonly ModelCapabilitySource[] = ['manual', 'discovered', 'built-in'];

export interface ReferenceInlineBudget {
  /** Characters available for inlined reference bodies in one message. */
  chars: number;
  /** `window` when a trusted declaration scaled it, `conservative` otherwise. */
  source: 'window' | 'conservative';
}

export type ReferenceInlineBudgetModel = Pick<KeepseekModel, 'contextWindowTokens' | 'contextWindowSource'>;

export interface ReferenceInlineBudgetInput {
  model?: ReferenceInlineBudgetModel;
}

/**
 * Derives one message's file-reference inline budget from the declared context
 * window. The declaration is the only input this decision may use: it never
 * reads the task token budget configuration, the learned/calibrated effective
 * window (`learnedEffectiveWindowTokens`), historical context-too-long
 * observations, or any other cross-turn runtime state. Those values shrink over
 * a session (context-too-long collapses the learned window by 0.8 each time),
 * and a shrinking budget would give the same reference a different answer at
 * different times, which breaks "decide once, persist once".
 */
export function resolveReferenceInlineBudget(input: ReferenceInlineBudgetInput = {}): ReferenceInlineBudget {
  const model = input.model;
  const declaredTokens = normalizeDeclaredTokens(model?.contextWindowTokens);
  // Mirrors the request-budget convention: a declared window with no recorded
  // provenance is an explicit declaration, not a guess.
  const windowSource = model?.contextWindowSource ?? (declaredTokens ? 'manual' : 'fallback');
  if (!declaredTokens || !TRUSTED_WINDOW_SOURCES.includes(windowSource)) {
    return { chars: REFERENCE_INLINE_FLOOR_CHARS, source: 'conservative' };
  }

  // Integer math keeps the result exact and machine independent: percent first,
  // then the token-to-character ratio, floored exactly once.
  const windowChars = Math.floor((declaredTokens * REFERENCE_INLINE_WINDOW_PERCENT * CHARS_PER_TOKEN) / 100);
  return {
    chars: Math.min(Math.max(windowChars, REFERENCE_INLINE_FLOOR_CHARS), REFERENCE_INLINE_CEIL_CHARS),
    source: 'window'
  };
}

function normalizeDeclaredTokens(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}