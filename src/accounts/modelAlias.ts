import type { AccountModelCache, KeepseekAccount } from './types';

export interface ModelDisplayNameInput {
  id: string;
  alias?: string;
  fetchedName?: string;
  label?: string;
}

/**
 * Keep this ordering in one pure function so the settings UI and command menu
 * cannot disagree about a model's display name.
 */
export function resolveModelDisplayName(input: ModelDisplayNameInput): string {
  return firstNonEmpty(input.alias, input.fetchedName, input.label, input.id);
}

export function resolveAccountModelDisplayName(
  account: Pick<KeepseekAccount, 'modelAliases' | 'modelCache'>,
  modelId: string,
  builtInLabel?: string
): string {
  return resolveModelDisplayName({
    id: modelId,
    alias: account.modelAliases[modelId],
    fetchedName: findFetchedModelName(account.modelCache, modelId),
    label: builtInLabel
  });
}

export function findFetchedModelName(
  cache: AccountModelCache | undefined,
  modelId: string
): string | undefined {
  return cache?.models.find((model) => model.id === modelId)?.name;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized) {
      return normalized;
    }
  }
  return '';
}
