import type { KeepseekModel, ModelSelection } from '../shared/types';
import { getGuessedContextWindowTokens } from '../shared/modelContextWindowGuesses';
import {
  DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS,
  getSupportedDeepSeekV4Models
} from '../shared/modelProfiles';
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
      const builtIn = source.provider === 'deepseek'
        ? builtIns.find((model) => model.id === modelId)
        : undefined;
      const fetched = source.modelCache?.models.find((model) => model.id === modelId);
      const manual = source.models.find((model) => model.id === modelId);
      const guessedContextWindowTokens = getGuessedContextWindowTokens(modelId);
      const contextWindowTokens = manual?.contextWindowTokens
        ?? fetched?.contextWindowTokens
        ?? builtIn?.contextWindowTokens
        ?? guessedContextWindowTokens
        ?? DEFAULT_GENERIC_CONTEXT_WINDOW_TOKENS;
      const contextWindowSource: KeepseekModel['contextWindowSource'] = manual?.contextWindowTokens
        ? 'manual'
        : fetched?.contextWindowTokens
          ? 'discovered'
          : builtIn?.contextWindowTokens
            ? 'built-in'
            : guessedContextWindowTokens
              ? 'guessed'
              : 'fallback';
      catalog.push({
        id: modelId,
        label: builtIn?.label ?? modelId,
        provider: source.provider,
        // Explicit per-source overrides win over discovery and built-in facts;
        // only then do low-trust family guesses and the generic fallback apply.
        contextWindowTokens,
        contextWindowSource,
        maxOutputTokens: manual?.maxOutputTokens
          ?? fetched?.maxOutputTokens
          ?? builtIn?.maxOutputTokens,
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
