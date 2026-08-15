import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import { isRecord } from '../shared/errors';
import {
  MODEL_SOURCE_PROVIDERS,
  type CreateModelSourceInput,
  type DiscoveredModelInfo,
  type ModelDiscoveryCache,
  type ModelSource,
  type ModelSourceModel,
  type ModelSourceProvider,
  type UpdateModelSourceInput
} from './types';

export const ACCOUNTS_STORAGE_DIRECTORY = 'accounts';
export const DEFAULT_MODEL_SOURCE_ID = 'default';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';

const ACCOUNT_FILE_EXTENSION = '.json';
const ACCOUNT_STORAGE_INITIALIZED_FILE = '.initialized';
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ACCOUNT_NAME_LENGTH = 200;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 512;

export interface ModelSourceStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export interface NormalizeModelSourceOptions {
  expectedId?: string;
  expectedProvider?: ModelSourceProvider;
  now?: number;
}

export class ModelSourceStore {
  private readonly accountsRootUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly now: () => number;
  private readonly createId: () => string;

  public constructor(
    globalStorageUri: vscode.Uri,
    options: ModelSourceStoreOptions = {}
  ) {
    this.accountsRootUri = vscode.Uri.joinPath(globalStorageUri, ACCOUNTS_STORAGE_DIRECTORY);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  public async listSources(provider?: ModelSourceProvider): Promise<ModelSource[]> {
    const providers = provider ? [provider] : [...MODEL_SOURCE_PROVIDERS];
    const sources: ModelSource[] = [];
    const seenIds = new Set<string>();

    for (const currentProvider of providers) {
      const providerSources = await this.readProviderSources(currentProvider);
      for (const source of providerSources) {
        // sourceId is the stable half of a model selection, so it remains unique
        // across provider directories even though the physical storage is scoped.
        if (!seenIds.has(source.id)) {
          seenIds.add(source.id);
          sources.push(source);
        }
      }
    }

    return sources;
  }

  public async getSource(sourceId: string): Promise<ModelSource | undefined> {
    if (!isValidModelSourceId(sourceId)) {
      return undefined;
    }
    return (await this.listSources()).find((source) => source.id === sourceId);
  }

  public async getSourceByProvider(
    provider: ModelSourceProvider,
    sourceId: string
  ): Promise<ModelSource | undefined> {
    if (!isModelSourceProvider(provider) || !isValidModelSourceId(sourceId)) {
      return undefined;
    }
    return await this.readSourceFile(provider, sourceId);
  }

  public async createSource(input: CreateModelSourceInput): Promise<ModelSource> {
    if (!isModelSourceProvider(input.provider)) {
      throw new Error('Unsupported KeepSeek model source provider.');
    }
    const id = input.id?.trim() || this.createId();
    assertValidModelSourceId(id);
    if (await this.getSource(id)) {
      throw new Error(`KeepSeek model source already exists: ${id}`);
    }

    const timestamp = normalizeTimestamp(this.now(), Date.now());
    const source = normalizeModelSource({
      id,
      name: input.name,
      provider: input.provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      models: input.models ?? [],
      modelCache: input.modelCache,
      enabled: input.enabled,
      createdAt: timestamp,
      updatedAt: timestamp
    }, {
      expectedId: id,
      expectedProvider: input.provider,
      now: timestamp
    });
    if (!source) {
      throw new Error('Invalid KeepSeek model source settings.');
    }
    await this.writeSource(source);
    await this.markStorageInitialized();
    return source;
  }

  public async saveSource(source: ModelSource): Promise<ModelSource> {
    const normalized = normalizeModelSource(source, {
      expectedId: source.id,
      expectedProvider: source.provider,
      now: this.now()
    });
    if (!normalized) {
      throw new Error('Invalid KeepSeek model source settings.');
    }
    await this.writeSource(normalized);
    return normalized;
  }

  public async updateSource(
    sourceId: string,
    patch: UpdateModelSourceInput
  ): Promise<ModelSource | undefined> {
    const current = await this.getSource(sourceId);
    if (!current) {
      return undefined;
    }
    const timestamp = Math.max(current.updatedAt, normalizeTimestamp(this.now(), Date.now()));
    const candidate: ModelSource = {
      ...current,
      name: patch.name ?? current.name,
      apiKey: patch.apiKey ?? current.apiKey,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      models: patch.models ?? current.models,
      modelCache: Object.prototype.hasOwnProperty.call(patch, 'modelCache')
        ? patch.modelCache
        : current.modelCache,
      enabled: patch.enabled ?? current.enabled,
      updatedAt: timestamp
    };
    return await this.saveSource(candidate);
  }

  public async deleteSource(sourceId: string): Promise<ModelSource | undefined> {
    const source = await this.getSource(sourceId);
    if (!source) {
      return undefined;
    }
    // Persist the user's explicit source-system choice before removing the
    // last JSON file, otherwise the preserved legacy key could remigrate it.
    await this.markStorageInitialized();
    await vscode.workspace.fs.delete(this.getSourceFileUri(source.provider, source.id), {
      recursive: false,
      useTrash: false
    });
    return source;
  }

  /** Create the legacy migration target without ever mutating an existing default. */
  public async upsertDefaultSource(input: {
    apiKey: string;
    baseUrl?: string;
    name?: string;
  }): Promise<ModelSource> {
    const existing = await this.getSourceByProvider('deepseek', DEFAULT_MODEL_SOURCE_ID);
    if (existing) {
      return existing;
    }
    return await this.createSource({
      id: DEFAULT_MODEL_SOURCE_ID,
      name: input.name ?? 'DeepSeek',
      provider: 'deepseek',
      apiKey: input.apiKey,
      baseUrl: input.baseUrl || DEFAULT_DEEPSEEK_BASE_URL
    });
  }

  /** Migration is allowed only when no physical source JSON exists. */
  public async hasStoredSourceFiles(): Promise<boolean> {
    for (const provider of MODEL_SOURCE_PROVIDERS) {
      const providerUri = this.getProviderDirectoryUri(provider);
      try {
        const entries = await vscode.workspace.fs.readDirectory(providerUri);
        if (entries.some(([name, type]) => (
          type === vscode.FileType.File && name.endsWith(ACCOUNT_FILE_EXTENSION)
        ))) {
          return true;
        }
      } catch (error) {
        if (!isFileNotFoundError(error)) {
          // An unreadable directory is not safely known to be empty. Suppress
          // migration rather than risking an accidental overwrite.
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Distinguishes a never-migrated installation from one where the user deleted
   * the last source. The marker contains no source data or credentials.
   */
  public async isStorageInitialized(): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.getInitializedMarkerUri());
      return stat.type === vscode.FileType.File;
    } catch (error) {
      return !isFileNotFoundError(error);
    }
  }

  public getProviderDirectoryUri(provider: ModelSourceProvider): vscode.Uri {
    if (!isModelSourceProvider(provider)) {
      throw new Error('Unsupported KeepSeek model source provider.');
    }
    return vscode.Uri.joinPath(this.accountsRootUri, provider);
  }

  public getSourceFileUri(provider: ModelSourceProvider, sourceId: string): vscode.Uri {
    assertValidModelSourceId(sourceId);
    return vscode.Uri.joinPath(
      this.getProviderDirectoryUri(provider),
      `${sourceId}${ACCOUNT_FILE_EXTENSION}`
    );
  }

  private async readProviderSources(provider: ModelSourceProvider): Promise<ModelSource[]> {
    const providerUri = this.getProviderDirectoryUri(provider);
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(providerUri);
    } catch {
      return [];
    }

    const sources: ModelSource[] = [];
    const sourceFileNames = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(ACCOUNT_FILE_EXTENSION))
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
    for (const fileName of sourceFileNames) {
      const sourceId = fileName.slice(0, -ACCOUNT_FILE_EXTENSION.length);
      if (!isValidModelSourceId(sourceId)) {
        continue;
      }
      const source = await this.readSourceFile(provider, sourceId);
      if (source) {
        sources.push(source);
      }
    }
    return sources;
  }

  private async readSourceFile(
    provider: ModelSourceProvider,
    sourceId: string
  ): Promise<ModelSource | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.getSourceFileUri(provider, sourceId));
      const parsed: unknown = JSON.parse(this.decoder.decode(bytes));
      return normalizeModelSource(parsed, {
        expectedId: sourceId,
        expectedProvider: provider,
        now: this.now()
      });
    } catch {
      // A single damaged source must not hide other usable sources or block
      // KeepSeek's legacy configuration fallback.
      return undefined;
    }
  }

  private async writeSource(source: ModelSource): Promise<void> {
    const providerUri = this.getProviderDirectoryUri(source.provider);
    await vscode.workspace.fs.createDirectory(providerUri);
    await vscode.workspace.fs.writeFile(
      this.getSourceFileUri(source.provider, source.id),
      this.encoder.encode(`${JSON.stringify(source, null, 2)}\n`)
    );
  }

  private async markStorageInitialized(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.accountsRootUri);
    await vscode.workspace.fs.writeFile(
      this.getInitializedMarkerUri(),
      this.encoder.encode('1\n')
    );
  }

  private getInitializedMarkerUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.accountsRootUri, ACCOUNT_STORAGE_INITIALIZED_FILE);
  }
}

export function normalizeModelSource(
  value: unknown,
  options: NormalizeModelSourceOptions = {}
): ModelSource | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const provider = normalizeModelSourceProvider(value.provider);
  if (!id || !isValidModelSourceId(id) || !provider) {
    return undefined;
  }
  if (options.expectedId && id !== options.expectedId) {
    return undefined;
  }
  if (options.expectedProvider && provider !== options.expectedProvider) {
    return undefined;
  }

  const now = normalizeTimestamp(options.now, Date.now());
  const createdAt = normalizeTimestamp(value.createdAt, now);
  const updatedAt = Math.max(createdAt, normalizeTimestamp(value.updatedAt, createdAt));
  return {
    id,
    name: normalizeBoundedString(value.name, MAX_ACCOUNT_NAME_LENGTH)
      || getDefaultModelSourceName(provider),
    provider,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    baseUrl: readNonEmptyString(value.baseUrl) || getDefaultModelSourceBaseUrl(provider),
    models: normalizePersistedSourceModels(value),
    modelCache: normalizeModelDiscoveryCache(value.modelCache),
    enabled: value.enabled !== false,
    createdAt,
    updatedAt
  };
}

export function normalizeModelDiscoveryCache(value: unknown): ModelDiscoveryCache | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return undefined;
  }
  return {
    models: normalizeDiscoveredModels(value.models),
    fetchedAt: normalizeTimestamp(value.fetchedAt, 0)
  };
}

export function normalizeDiscoveredModels(value: unknown): DiscoveredModelInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: DiscoveredModelInfo[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = normalizeBoundedString(item.id, MAX_MODEL_ID_LENGTH);
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    const name = normalizeBoundedString(item.name, MAX_MODEL_NAME_LENGTH);
    models.push(name ? { id, name } : { id });
  }
  return models;
}

export function normalizeSourceModels(value: unknown): ModelSourceModel[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: ModelSourceModel[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }
    const id = normalizeBoundedString(item.id, MAX_MODEL_ID_LENGTH);
    if (!id || seenIds.has(id)) {
      continue;
    }
    seenIds.add(id);
    models.push({ id });
  }
  return models;
}

function normalizePersistedSourceModels(value: Record<string, unknown>): ModelSourceModel[] {
  const hasCurrentModels = Array.isArray(value.models);
  const models = hasCurrentModels ? normalizeSourceModels(value.models) : [];
  const byId = new Map(models.map((model) => [model.id, { ...model }]));
  const order = models.map((model) => model.id);

  // Older account files represented manually entered ids as unnamed cache
  // entries. Only perform that conversion when the new `models` field is
  // absent; current provider discovery can legitimately return unnamed ids.
  if (!hasCurrentModels) {
    const legacyCache = normalizeModelDiscoveryCache(value.modelCache);
    for (const model of legacyCache?.models ?? []) {
      if (model.name || byId.has(model.id)) {
        continue;
      }
      byId.set(model.id, { id: model.id });
      order.push(model.id);
    }
  }

  return order.map((id) => byId.get(id) as ModelSourceModel);
}

export function normalizeModelSourceProvider(value: unknown): ModelSourceProvider | undefined {
  return isModelSourceProvider(value) ? value : undefined;
}

export function isModelSourceProvider(value: unknown): value is ModelSourceProvider {
  return typeof value === 'string' && MODEL_SOURCE_PROVIDERS.some((provider) => provider === value);
}

export function isValidModelSourceId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function getDefaultModelSourceName(provider: ModelSourceProvider): string {
  return provider === 'deepseek' ? 'DeepSeek' : 'OpenAI Compatible';
}

export function getDefaultModelSourceBaseUrl(provider: ModelSourceProvider): string {
  return provider === 'deepseek'
    ? DEFAULT_DEEPSEEK_BASE_URL
    : DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
}

function assertValidModelSourceId(sourceId: string): void {
  if (!isValidModelSourceId(sourceId)) {
    throw new Error('Invalid KeepSeek model source id.');
  }
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Math.floor(fallback);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeBoundedString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'FileNotFound' || error.code === 'ENOENT');
}
