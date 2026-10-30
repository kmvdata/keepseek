/** Versioned, phase-independent single-request admission. Not a task budget. */
export const OUTPUT_BUDGET_POLICY_VERSION = 2;

export interface OutputBudget {
  policyVersion: number;
  modelMaxOutputTokens: number;
  estimatedInputTokens: number;
  inputBudgetTokens: number;
  effectiveWindowTokens: number;
  safetyTokens: number;
  actualMaxOutputTokens: number;
  limitSource: 'model' | 'context_remaining';
  needsCompaction: boolean;
}

export function calculateOutputBudget(input: {
  modelMaxOutputTokens: number;
  estimatedInputTokens: number;
  effectiveWindowTokens: number;
  estimatorScale?: number;
  uncertaintyTokens?: number;
}): OutputBudget {
  if (![input.modelMaxOutputTokens, input.effectiveWindowTokens].every((n) => Number.isSafeInteger(n) && n > 0)
    || !Number.isFinite(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw new Error('Invalid model output/context capability / 模型输出或上下文能力无效');
  }
  const inputBudgetTokens = Math.ceil(input.estimatedInputTokens * Math.max(1, input.estimatorScale ?? 1.08));
  const safetyTokens = Math.max(384, Math.min(8_192,
    Math.ceil(Math.max(0, input.uncertaintyTokens ?? 0) * 1.25 + inputBudgetTokens * 0.015)));
  const remaining = Math.floor(input.effectiveWindowTokens - inputBudgetTokens - safetyTokens);
  const actualMaxOutputTokens = Math.max(0, Math.min(input.modelMaxOutputTokens, remaining));
  return {
    policyVersion: OUTPUT_BUDGET_POLICY_VERSION,
    modelMaxOutputTokens: input.modelMaxOutputTokens,
    estimatedInputTokens: input.estimatedInputTokens,
    inputBudgetTokens, effectiveWindowTokens: input.effectiveWindowTokens, safetyTokens,
    actualMaxOutputTokens,
    limitSource: actualMaxOutputTokens < input.modelMaxOutputTokens ? 'context_remaining' : 'model',
    needsCompaction: remaining < input.modelMaxOutputTokens
  };
}
