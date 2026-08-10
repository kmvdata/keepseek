import { getSupportedDeepSeekV4Models } from '../../shared/modelProfiles';

export interface ResolveSubagentModelInput {
  taskType: string;
  explicitModel?: string;
  overrides?: Record<string, string>;
  defaultModel?: string;
  executorModel: string;
  supportedModelIds?: readonly string[];
}

export function resolveSubagentModel(input: ResolveSubagentModelInput): string {
  const supported = new Set(
    input.supportedModelIds ?? getSupportedDeepSeekV4Models().map((model) => model.id)
  );
  const taskType = normalizeTaskType(input.taskType);
  const normalizedOverrides = new Map<string, string>();
  for (const [key, modelId] of Object.entries(input.overrides ?? {})) {
    normalizedOverrides.set(normalizeTaskType(key), modelId);
  }
  const candidates = [
    input.explicitModel,
    normalizedOverrides.get(taskType),
    input.defaultModel,
    input.executorModel
  ];
  for (const candidate of candidates) {
    const modelId = candidate?.trim();
    if (modelId && supported.has(modelId)) {
      return modelId;
    }
  }
  return input.executorModel;
}

function normalizeTaskType(value: string): string {
  return value.trim().toLowerCase().replace(/[-_]+/gu, '_');
}
