import type { KeepseekModel, ModelSelection } from '../shared/types';
import { getSupportedDeepSeekV4Models } from '../shared/modelProfiles';
import { isOfficialDeepSeekSource } from './sourceCapabilities';
import type { ModelSource } from './types';

export interface CreateModelCatalogOptions {
  includeDisabledModels?: boolean;
}

export function createModelCatalog(
  sources: readonly ModelSource[],
  options: CreateModelCatalogOptions = {}
): KeepseekModel[] {
  const builtIns = getSupportedDeepSeekV4Models();
  const catalog: KeepseekModel[] = [];

  for (const source of sources) {
    if (!source.enabled) {
      continue;
    }
    const official = isOfficialDeepSeekSource(source);
    const disabledModelIds = new Set(source.disabledModelIds ?? []);
    const hasSuccessfulDiscovery = Boolean(source.modelCache && source.modelCache.fetchedAt > 0);
    const orderedIds: string[] = [];
    const seenIds = new Set<string>();
    const addId = (rawId: string) => {
      const id = rawId.trim();
      if (!id || seenIds.has(id)) {
        return;
      }
      seenIds.add(id);
      orderedIds.push(id);
    };

    if (official && !hasSuccessfulDiscovery) {
      builtIns.forEach((model) => addId(model.id));
    } else {
      source.modelCache?.models.forEach((model) => addId(model.id));
    }
    source.models.forEach((model) => addId(model.id));

    for (const modelId of orderedIds) {
      if (!options.includeDisabledModels && disabledModelIds.has(modelId)) {
        continue;
      }
      const builtIn = builtIns.find((model) => model.id === modelId);
      const fetched = source.modelCache?.models.find((model) => model.id === modelId);
      catalog.push({
        id: modelId,
        label: builtIn?.label ?? modelId,
        provider: source.provider,
        contextWindowTokens: fetched?.contextWindowTokens ?? builtIn?.contextWindowTokens,
        maxOutputTokens: fetched?.maxOutputTokens,
        anthropicCapabilities: fetched?.anthropicCapabilities
          ? {
              ...fetched.anthropicCapabilities,
              effort: fetched.anthropicCapabilities.effort
                ? [...fetched.anthropicCapabilities.effort]
                : undefined
            }
          : undefined,
        fetchedName: fetched?.name,
        sourceId: source.id,
        sourceName: source.name,
        supportsBilling: official
      });
    }
  }

  return catalog;
}

export function findModelBySelection(
  models: readonly KeepseekModel[],
  selection: Partial<ModelSelection> | undefined
): KeepseekModel | undefined {
  const sourceId = selection?.sourceId?.trim();
  const modelId = selection?.modelId?.trim();
  if (sourceId && modelId) {
    return models.find((model) => model.sourceId === sourceId && model.id === modelId);
  }
  if (modelId) {
    // Backward compatibility for workspaces that persisted only selectedModelId.
    return models.find((model) => model.id === modelId);
  }
  return models[0];
}

export function toModelSelection(model: { sourceId: string; id: string }): ModelSelection {
  return { sourceId: model.sourceId, modelId: model.id };
}
