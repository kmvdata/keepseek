import type * as vscode from 'vscode';
import { ContextWindowCalibrationStore } from './contextWindowCalibrationStore';
import { DEEPSEEK_MODEL_IDENTITY_VERSION, getCanonicalModelIdentity } from '../shared/deepSeekModels';
import { createHash } from 'node:crypto';
import type { KeepseekModel, ModelCapabilitySource } from '../shared/types';
import { getAgentRuntimeProfile } from '../shared/modelProfiles';
import { calculateOutputBudget, type OutputBudget } from '../shared/outputBudget';
import type { ModelSourceProvider } from '../accounts/types';
import type { ProviderClientRequest } from './providers/types';
import { normalizeContextUsageEstimate, createContextUsageEstimateFromAnthropic, createContextUsageEstimateFromMessages, createContextUsageEstimateFromResponses } from './contextUsage';

export interface RequestBudgetSnapshot extends OutputBudget {
  sourceId: string;
  modelId: string;
  endpointHash: string;
  protocol: 'chat-completions' | 'openai-responses' | 'anthropic-messages';
  capabilitySource: ModelCapabilitySource;
  contextWindowSource: ModelCapabilitySource;
}

/** Estimate the actual serialized lane, including native replay and tool schemas. */
export function resolveProviderRequestBudget(input: {
  model: KeepseekModel;
  sourceId?: string;
  baseUrl?: string;
  provider: ModelSourceProvider;
  body: ProviderClientRequest['body'];
  calibration?: { learnedEffectiveWindowTokens: number; estimatorScale: number; lastActualInputTokens?: number; lastEstimatedInputTokens?: number };
}): RequestBudgetSnapshot {
  const profile = getAgentRuntimeProfile(input.model, { thinkingEnabled: false, reasoningEffort: 'high' });
  const body = input.body;
  const estimate = 'input' in body
    ? createContextUsageEstimateFromResponses({ model: input.model, input: body.input, tools: body.tools })
    : 'system' in body
      ? createContextUsageEstimateFromAnthropic({ model: input.model, system: body.system ?? [], messages: body.messages, tools: body.tools })
      : createContextUsageEstimateFromMessages({ model: input.model, messages: body.messages, tools: body.tools });
  const calibration = input.calibration;
  return {
    ...calculateOutputBudget({
      modelMaxOutputTokens: profile.maxTokens,
      estimatedInputTokens: estimate.usedTokensEstimate,
      effectiveWindowTokens: Math.min(profile.contextWindowTokens, calibration?.learnedEffectiveWindowTokens ?? profile.contextWindowTokens),
      estimatorScale: calibration?.estimatorScale,
      uncertaintyTokens: Math.abs((calibration?.lastActualInputTokens ?? 0) - (calibration?.lastEstimatedInputTokens ?? 0))
    }),
    modelId: input.model.id,
    sourceId: input.sourceId ?? input.model.sourceId ?? '',
    endpointHash: createHash('sha256').update(input.baseUrl ?? '').digest('hex'),
    protocol: 'input' in body ? 'openai-responses' : 'system' in body ? 'anthropic-messages' : 'chat-completions',
    capabilitySource: input.model.maxOutputSource ?? (input.model.maxOutputTokens ? 'manual' : profile.profileKind === 'deepseek-v4' ? 'built-in' : 'fallback'),
    contextWindowSource: input.model.contextWindowSource ?? (input.model.contextWindowTokens ? 'manual' : 'fallback')
  };
}

export function applyProviderRequestBudget(body: ProviderClientRequest['body'], budget: OutputBudget): void {
  if (budget.actualMaxOutputTokens < 1) {
    throw new Error('Context capacity cannot fit the complete input and legal output after compaction / 压缩后上下文仍无法容纳完整输入和合法输出');
  }
  if ('input' in body) body.max_output_tokens = budget.actualMaxOutputTokens;
  else body.max_tokens = budget.actualMaxOutputTokens;
  if ('system' in body && body.thinking?.type === 'enabled'
    && body.thinking.budget_tokens >= budget.actualMaxOutputTokens) {
    throw new Error('Anthropic thinking budget must be below the admitted max_tokens; reduce input or adjust model configuration / Anthropic 推理预算必须小于准入输出额度，请减少输入或调整模型配置');
  }
}

/** Whitelist persisted metadata; never retain arbitrary provider/auth fields. */
export function normalizeRequestBudget(value: unknown): RequestBudgetSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as RequestBudgetSnapshot;
  const numbers = ['modelMaxOutputTokens', 'estimatedInputTokens', 'inputBudgetTokens', 'effectiveWindowTokens', 'safetyTokens', 'actualMaxOutputTokens'] as const;
  if (![1, 2].includes(v.policyVersion) || numbers.some((k) => !Number.isSafeInteger(v[k]) || v[k] < 0)
    || v.modelMaxOutputTokens < 1 || v.effectiveWindowTokens < 1 || v.actualMaxOutputTokens > v.modelMaxOutputTokens
    || !['model', 'context_remaining'].includes(v.limitSource) || typeof v.needsCompaction !== 'boolean'
    || !['chat-completions', 'openai-responses', 'anthropic-messages'].includes(v.protocol)
    || ![v.sourceId, v.modelId].every((s) => typeof s === 'string' && s.length <= 1024)
    || !/^[a-f0-9]{64}$/u.test(v.endpointHash)
    || ![v.capabilitySource, v.contextWindowSource].every((s) => ['manual', 'discovered', 'built-in', 'guessed', 'fallback'].includes(s))) return undefined;
  return { policyVersion: v.policyVersion, modelMaxOutputTokens: v.modelMaxOutputTokens,
    estimatedInputTokens: v.estimatedInputTokens, inputBudgetTokens: v.inputBudgetTokens,
    effectiveWindowTokens: v.effectiveWindowTokens, safetyTokens: v.safetyTokens,
    actualMaxOutputTokens: v.actualMaxOutputTokens, limitSource: v.limitSource, needsCompaction: v.needsCompaction,
    sourceId: v.sourceId, modelId: v.modelId, endpointHash: v.endpointHash, protocol: v.protocol,
    capabilitySource: v.capabilitySource, contextWindowSource: v.contextWindowSource };
}

export function createRequestBudgetUsage(budget: RequestBudgetSnapshot) {
  return normalizeContextUsageEstimate({
    maxTokensEstimate: budget.effectiveWindowTokens,
    usedTokensEstimate: budget.inputBudgetTokens + budget.actualMaxOutputTokens + budget.safetyTokens,
    breakdown: { inputTokensEstimate: budget.inputBudgetTokens,
      outputReserveTokensEstimate: budget.actualMaxOutputTokens, safetyReserveTokensEstimate: budget.safetyTokens }
  });
}

export async function loadProviderRequestBudget(
  input: Parameters<typeof resolveProviderRequestBudget>[0], globalStorageUri?: vscode.Uri
): Promise<RequestBudgetSnapshot> {
  return resolveProviderRequestBudget({ ...input, calibration: await loadProviderRequestCalibration(input, globalStorageUri) });
}

export async function loadProviderRequestCalibration(
  input: Parameters<typeof resolveProviderRequestBudget>[0], globalStorageUri?: vscode.Uri
): Promise<Parameters<typeof resolveProviderRequestBudget>[0]['calibration']> {
  if (input.calibration || !globalStorageUri) return input.calibration;
  const initial = resolveProviderRequestBudget(input);
  const identity = getCanonicalModelIdentity(input.model.id);
  const calibration = await new ContextWindowCalibrationStore(globalStorageUri).load({
    sourceId: initial.sourceId, provider: input.provider, modelId: input.model.id,
    canonicalModelId: identity, endpointHash: initial.endpointHash
  }, { identity, version: `${DEEPSEEK_MODEL_IDENTITY_VERSION}:${initial.effectiveWindowTokens}`,
    declaredWindowTokens: initial.effectiveWindowTokens });
  return calibration;
}
