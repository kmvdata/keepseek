import {
  getDefaultModelSourceName,
  ModelSourceStore
} from './accountStore';
import {
  refreshSourceModelCache,
  type RefreshSourceModelCacheOptions,
  type RefreshSourceModelCacheResult
} from './modelDiscovery';
import { isOfficialDeepSeekSource } from './sourceCapabilities';
import type { ModelSource, ModelSourceModel, ModelSourceProvider } from './types';

export interface AddModelInput {
  sourceId?: string;
  provider: ModelSourceProvider;
  apiKey: string;
  baseUrl: string;
  modelId?: string;
  nickname?: string;
}

export interface AddModelResult {
  source: ModelSource;
  reusedSource: boolean;
  discovery?: RefreshSourceModelCacheResult;
}

export type SourceModelCacheRefresher = (
  sourceStore: ModelSourceStore,
  sourceId: string,
  options: RefreshSourceModelCacheOptions
) => Promise<RefreshSourceModelCacheResult>;

export class ModelSourceService {
  public constructor(
    private readonly sourceStore: ModelSourceStore,
    private readonly refreshModelCache: SourceModelCacheRefresher = refreshSourceModelCache
  ) {}

  public async addModel(input: AddModelInput): Promise<AddModelResult> {
    const modelId = input.modelId?.trim() ?? '';
    const existingById = input.sourceId?.trim()
      ? await this.sourceStore.getSource(input.sourceId.trim())
      : undefined;
    let source = existingById;
    let reusedSource = Boolean(source);

    if (!source) {
      const apiKey = input.apiKey.trim();
      const baseUrl = normalizeRequiredBaseUrl(input.baseUrl);
      if (!apiKey) {
        throw new Error('API Key is required.');
      }
      if (!modelId && !isOfficialDeepSeekSource({ provider: input.provider, baseUrl })) {
        throw new Error('Model ID is required for this source.');
      }
      source = await this.findReusableSource(input.provider, apiKey, baseUrl);
      reusedSource = Boolean(source);
      if (!source) {
        source = await this.sourceStore.createSource({
          provider: input.provider,
          name: createSourceName(input.provider, baseUrl),
          apiKey,
          baseUrl,
          models: []
        });
      }
    }

    if (!source.enabled) {
      throw new Error('The selected model source is disabled.');
    }
    if (!modelId && !isOfficialDeepSeekSource(source)) {
      throw new Error('Model ID is required for this source.');
    }
    if (modelId) {
      source = await this.upsertModel(source, modelId, input.nickname ?? '');
    }

    const discovery = isOfficialDeepSeekSource(source)
      ? await this.refreshModelCache(this.sourceStore, source.id, { force: true })
      : undefined;
    return {
      source: await this.sourceStore.getSource(source.id) ?? source,
      reusedSource,
      discovery
    };
  }

  public async saveSource(input: {
    sourceId: string;
    apiKey: string;
    baseUrl: string;
    name?: string;
  }): Promise<{ source: ModelSource; connectionChanged: boolean; discovery?: RefreshSourceModelCacheResult }> {
    const source = await this.sourceStore.getSource(input.sourceId);
    if (!source) {
      throw new Error('Model source not found.');
    }
    const apiKey = input.apiKey.trim();
    const baseUrl = normalizeRequiredBaseUrl(input.baseUrl);
    if (!apiKey) {
      throw new Error('API Key is required.');
    }
    const connectionChanged = source.apiKey !== apiKey || source.baseUrl !== baseUrl;
    const updated = await this.sourceStore.updateSource(source.id, {
      name: input.name?.trim() || source.name,
      apiKey,
      baseUrl,
      modelCache: connectionChanged ? undefined : source.modelCache
    });
    if (!updated) {
      throw new Error('Model source not found.');
    }
    const discovery = isOfficialDeepSeekSource(updated)
      ? await this.refreshModelCache(this.sourceStore, updated.id, { force: true })
      : undefined;
    return {
      source: await this.sourceStore.getSource(updated.id) ?? updated,
      connectionChanged,
      discovery
    };
  }

  public async saveModel(input: {
    sourceId: string;
    modelId: string;
    nickname?: string;
  }): Promise<ModelSource> {
    const source = await this.sourceStore.getSource(input.sourceId);
    const modelId = input.modelId.trim();
    if (!source) {
      throw new Error('Model source not found.');
    }
    if (!modelId) {
      throw new Error('Model ID is required.');
    }
    return await this.upsertModel(source, modelId, input.nickname ?? '');
  }

  private async findReusableSource(
    provider: ModelSourceProvider,
    apiKey: string,
    baseUrl: string
  ): Promise<ModelSource | undefined> {
    const normalizedBaseUrl = normalizeBaseUrlForMatch(baseUrl);
    return (await this.sourceStore.listSources()).find((source) => (
      source.provider === provider
      && source.apiKey === apiKey
      && normalizeBaseUrlForMatch(source.baseUrl) === normalizedBaseUrl
    ));
  }

  private async upsertModel(
    source: ModelSource,
    modelId: string,
    nickname: string
  ): Promise<ModelSource> {
    const normalizedNickname = nickname.trim();
    const models: ModelSourceModel[] = source.models.map((model) => ({ ...model }));
    const index = models.findIndex((model) => model.id === modelId);
    const next = normalizedNickname ? { id: modelId, name: normalizedNickname } : { id: modelId };
    if (index >= 0) {
      models[index] = next;
    } else {
      models.push(next);
    }
    const updated = await this.sourceStore.updateSource(source.id, { models });
    if (!updated) {
      throw new Error('Model source not found.');
    }
    return updated;
  }
}

function normalizeRequiredBaseUrl(rawBaseUrl: string): string {
  const baseUrl = rawBaseUrl.trim();
  if (!baseUrl) {
    throw new Error('Base URL is required.');
  }
  return new URL(baseUrl).toString().replace(/\/$/u, '');
}

function normalizeBaseUrlForMatch(rawBaseUrl: string): string {
  try {
    const url = new URL(rawBaseUrl.trim());
    url.pathname = url.pathname.replace(/\/+$/u, '');
    url.hash = '';
    return url.toString().replace(/\/$/u, '');
  } catch {
    return rawBaseUrl.trim().replace(/\/+$/u, '');
  }
}

function createSourceName(provider: ModelSourceProvider, baseUrl: string): string {
  if (isOfficialDeepSeekSource({ provider, baseUrl })) {
    return 'DeepSeek Official';
  }
  try {
    return new URL(baseUrl).host || getDefaultModelSourceName(provider);
  } catch {
    return getDefaultModelSourceName(provider);
  }
}
