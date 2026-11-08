import {
  MAX_DISCOVERED_CONTEXT_WINDOW_TOKENS,
  MAX_DISCOVERED_OUTPUT_TOKENS,
  ModelSourceStore
} from './accountStore';
import { createModelCatalog } from './modelCatalog';
import { requiresModelSourceApiKey } from './sourceCapabilities';
import type { ModelSource, ModelSourceModel, ModelSourceProvider } from './types';

export interface AddModelInput {
  sourceId?: string;
  provider: ModelSourceProvider;
  name?: string;
  apiKey: string;
  baseUrl: string;
  modelId?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface AddModelResult {
  source: ModelSource;
  reusedSource: boolean;
}

export class ModelSourceService {
  public constructor(
    private readonly sourceStore: ModelSourceStore
  ) {}

  public async addModel(input: AddModelInput): Promise<AddModelResult> {
    return this.sourceStore.transaction(async () => {
      const modelId = input.modelId?.trim() ?? '';
      const existingById = input.sourceId?.trim()
        ? await this.sourceStore.getSource(input.sourceId.trim())
        : undefined;
      let source = existingById;
      let reusedSource = Boolean(source);
      if (source && source.provider !== input.provider) {
        throw new Error('An account API protocol cannot be changed. Create a new account for the other protocol.');
      }

      if (!source) {
        const name = normalizeRequiredSourceName(input.name);
        const apiKey = input.apiKey.trim();
        const baseUrl = normalizeRequiredBaseUrl(input.baseUrl);
        assertRequiredHostedApiKey(input.provider, baseUrl, apiKey);
        source = await this.findReusableSource(input.provider, apiKey, baseUrl);
        reusedSource = Boolean(source);
        if (!source) {
          await this.assertUniqueSourceName(name);
          source = await this.sourceStore.createSource({
            provider: input.provider,
            name,
            apiKey,
            baseUrl,
            models: []
          });
        }
      }

      if (!source.enabled) {
        throw new Error('The selected model source is disabled.');
      }
      if (modelId) {
        source = await this.upsertModel(source, modelId, {
          contextWindowTokens: normalizeOptionalCapabilityTokens(
            input.contextWindowTokens,
            MAX_DISCOVERED_CONTEXT_WINDOW_TOKENS,
            'contextWindowTokens'
          ),
          maxOutputTokens: normalizeOptionalCapabilityTokens(
            input.maxOutputTokens,
            MAX_DISCOVERED_OUTPUT_TOKENS,
            'maxOutputTokens'
          )
        });
      }

      return { source: await this.sourceStore.getSource(source.id) ?? source, reusedSource };
    });
  }

  public async removeModel(sourceId: string, modelId: string): Promise<ModelSource> {
    return this.sourceStore.transaction(async () => {
      const trimmedModelId = modelId.trim();
      const source = await this.sourceStore.getSource(sourceId);
      if (!source) {
        throw new Error('Model source not found.');
      }
      const models = source.models.filter((model) => model.id !== trimmedModelId);
      const updated = await this.sourceStore.updateSource(sourceId, { models });
      if (!updated) {
        throw new Error('Model source not found.');
      }
      return updated;
    });
  }

  public async setModelEnabled(
    sourceId: string,
    modelId: string,
    enabled: boolean
  ): Promise<ModelSource> {
    return this.sourceStore.transaction(async () => {
      const trimmedModelId = modelId.trim();
      const source = await this.sourceStore.getSource(sourceId);
      if (!source) {
        throw new Error('Model source not found.');
      }
      const knownModel = createModelCatalog([source], { includeDisabledModels: true })
        .find((model) => model.id === trimmedModelId);
      if (!knownModel) {
        throw new Error('Model not found in this source.');
      }
      if (enabled && knownModel.agentCompatible === false) {
        throw new Error('This resource is not compatible with the text Agent.');
      }

      const disabledModelIds = new Set(source.disabledModelIds ?? []);
      if (enabled) {
        disabledModelIds.delete(trimmedModelId);
      } else {
        disabledModelIds.add(trimmedModelId);
      }
      const updated = await this.sourceStore.updateSource(sourceId, {
        disabledModelIds: [...disabledModelIds]
      });
      if (!updated) {
        throw new Error('Model source not found.');
      }
      return updated;
    });
  }

  public async setModelContextWindowTokens(
    sourceId: string,
    modelId: string,
    contextWindowTokens: number
  ): Promise<ModelSource> {
    return this.sourceStore.transaction(async () => {
      const trimmedModelId = modelId.trim();
      const normalizedContextWindowTokens = normalizeOptionalCapabilityTokens(
        contextWindowTokens,
        MAX_DISCOVERED_CONTEXT_WINDOW_TOKENS,
        'contextWindowTokens'
      );
      const source = await this.sourceStore.getSource(sourceId);
      if (!source) {
        throw new Error('Model source not found.');
      }
      const knownModel = createModelCatalog([source], { includeDisabledModels: true })
        .find((model) => model.id === trimmedModelId);
      if (!knownModel) {
        throw new Error('Model not found in this source.');
      }
      if (knownModel.agentCompatible === false) {
        throw new Error('Token capabilities do not apply to this resource.');
      }

      const models: ModelSourceModel[] = source.models.map((model) => ({ ...model }));
      const index = models.findIndex((model) => model.id === trimmedModelId);
      const current = index >= 0 ? models[index] : undefined;
      const next: ModelSourceModel = {
        id: trimmedModelId,
        ...(normalizedContextWindowTokens
          ? { contextWindowTokens: normalizedContextWindowTokens }
          : {}),
        ...(current?.maxOutputTokens ? { maxOutputTokens: current.maxOutputTokens } : {})
      };
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
    });
  }

  public async setModelMaxOutputTokens(
    sourceId: string,
    modelId: string,
    maxOutputTokens: number
  ): Promise<ModelSource> {
    return this.sourceStore.transaction(async () => {
      const trimmedModelId = modelId.trim();
      const normalizedMaxOutputTokens = normalizeOptionalCapabilityTokens(
        maxOutputTokens,
        MAX_DISCOVERED_OUTPUT_TOKENS,
        'maxOutputTokens'
      );
      const source = await this.sourceStore.getSource(sourceId);
      if (!source) {
        throw new Error('Model source not found.');
      }
      const knownModel = createModelCatalog([source], { includeDisabledModels: true })
        .find((model) => model.id === trimmedModelId);
      if (!knownModel) {
        throw new Error('Model not found in this source.');
      }
      if (knownModel.agentCompatible === false) {
        throw new Error('Token capabilities do not apply to this resource.');
      }

      const models: ModelSourceModel[] = source.models.map((model) => ({ ...model }));
      const index = models.findIndex((model) => model.id === trimmedModelId);
      const current = index >= 0 ? models[index] : undefined;
      const next: ModelSourceModel = {
        id: trimmedModelId,
        ...(current?.contextWindowTokens ? { contextWindowTokens: current.contextWindowTokens } : {}),
        ...(normalizedMaxOutputTokens ? { maxOutputTokens: normalizedMaxOutputTokens } : {})
      };
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
    });
  }

  public async saveSource(input: {
    sourceId: string;
    apiKey: string;
    baseUrl: string;
    name?: string;
    expectedUpdatedAt?: number;
  }): Promise<{ source: ModelSource; connectionChanged: boolean }> {
    return this.sourceStore.transaction(async () => {
      const source = await this.sourceStore.getSource(input.sourceId);
      if (!source) {
        throw new Error('Model source not found.');
      }
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== source.updatedAt) {
        throw new Error('This account changed in another window. Reopen it before saving; your form was kept.');
      }
      const name = input.name?.trim() || source.name;
      await this.assertUniqueSourceName(name, source.id);
      const apiKey = input.apiKey.trim();
      const baseUrl = normalizeRequiredBaseUrl(input.baseUrl);
      assertRequiredHostedApiKey(source.provider, baseUrl, apiKey);
      const connectionChanged = source.apiKey !== apiKey || source.baseUrl !== baseUrl;
      const updated = await this.sourceStore.updateSource(source.id, {
        name,
        apiKey,
        baseUrl,
        modelCache: connectionChanged ? undefined : source.modelCache
      });
      if (!updated) {
        throw new Error('Model source not found.');
      }
      return { source: await this.sourceStore.getSource(updated.id) ?? updated, connectionChanged };
    });
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

  private async assertUniqueSourceName(name: string, excludeSourceId?: string): Promise<void> {
    const normalizedName = name.trim().toLowerCase();
    const sources = await this.sourceStore.listSources();
    const duplicate = sources.find((source) => (
      source.id !== excludeSourceId
      && source.name.trim().toLowerCase() === normalizedName
    ));
    if (duplicate) {
      throw new Error(`KeepSeek model source name already exists: ${name}`);
    }
  }

  private async upsertModel(
    source: ModelSource,
    modelId: string,
    capabilities: Pick<ModelSourceModel, 'contextWindowTokens' | 'maxOutputTokens'>
  ): Promise<ModelSource> {
    const models: ModelSourceModel[] = source.models.map((model) => ({ ...model }));
    const index = models.findIndex((model) => model.id === modelId);
    const current = index >= 0 ? models[index] : undefined;
    const next: ModelSourceModel = {
      id: modelId,
      contextWindowTokens: capabilities.contextWindowTokens ?? current?.contextWindowTokens,
      maxOutputTokens: capabilities.maxOutputTokens ?? current?.maxOutputTokens
    };
    if (index >= 0) {
      models[index] = next;
    } else {
      models.push(next);
    }
    const updated = await this.sourceStore.updateSource(source.id, {
      models,
      disabledModelIds: (source.disabledModelIds ?? []).filter((id) => id !== modelId)
    });
    if (!updated) {
      throw new Error('Model source not found.');
    }
    return updated;
  }
}

function normalizeOptionalCapabilityTokens(
  value: number | undefined,
  max: number,
  field: string
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0 || value > max || !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer no greater than ${max}.`);
  }
  return value;
}

function assertRequiredHostedApiKey(
  provider: ModelSourceProvider,
  baseUrl: string,
  apiKey: string
): void {
  if (!apiKey && requiresModelSourceApiKey({ provider, baseUrl })) {
    throw new Error('Official hosted accounts require an API Key.');
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

const MAX_SOURCE_NAME_LENGTH = 200;

function normalizeRequiredSourceName(rawName: string | undefined): string {
  const name = rawName?.trim() ?? '';
  if (!name) {
    throw new Error('Source name is required.');
  }
  if (name.length > MAX_SOURCE_NAME_LENGTH) {
    throw new Error('Source name is too long (200 characters max).');
  }
  return name;
}
