import * as vscode from 'vscode';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import type { KeepseekLanguage } from '../shared/i18n';
import {
  DEFAULT_MODEL_SOURCE_ID,
  ModelSourceStore
} from './accountStore';
import { isOfficialDeepSeekSource } from './sourceCapabilities';
import type {
  ModelDiscoveryCache,
  ModelSource,
  ResolvedModelSourceConfig,
  ResolvedModelSourceKind
} from './types';

export interface ModelSourceConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface ResolveModelSourceOptions {
  configuration?: ModelSourceConfigurationReader;
  sourceStore?: ModelSourceStore;
  legacyApiKey?: string;
  legacyBaseUrl?: string;
  environmentApiKey?: string;
  language?: KeepseekLanguage;
  now?: number;
  requireApiKey?: boolean;
}

export class MissingModelSourceApiKeyError extends Error {
  public readonly code = 'missing_api_key';

  public constructor(language: KeepseekLanguage = 'zh-CN') {
    super(language === 'en'
      ? 'Add a model and configure its API Key in KeepSeek settings first.'
      : '请先在 KeepSeek 设置中添加模型并配置 API Key。');
    this.name = 'MissingModelSourceApiKeyError';
  }
}

/**
 * Resolves credentials only for the requested source. A missing source id never
 * selects another stored source; legacy values are returned solely as an
 * unconfigured compatibility snapshot and are not eligible for model requests.
 */
export async function resolveModelSourceConfig(
  sourceId: string | undefined,
  globalStorageUri?: vscode.Uri,
  options: ResolveModelSourceOptions = {}
): Promise<ResolvedModelSourceConfig> {
  const configuration = options.configuration ?? vscode.workspace.getConfiguration('keepseek');
  const legacyApiKey = readConfiguredString(options.legacyApiKey, configuration, 'apiKey', '');
  const legacyBaseUrl = readConfiguredString(
    options.legacyBaseUrl,
    configuration,
    'baseUrl',
    DEFAULT_DEEPSEEK_BASE_URL
  ) || DEFAULT_DEEPSEEK_BASE_URL;
  const environmentApiKey = (options.environmentApiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  const sourceStore = options.sourceStore ?? (globalStorageUri
    ? new ModelSourceStore(globalStorageUri, {
        now: options.now === undefined ? undefined : () => options.now as number
      })
    : undefined);
  const migration = sourceStore
    ? await ensureLegacyModelSourceMigration(sourceStore, { legacyApiKey, legacyBaseUrl })
    : { migrated: false, storageInitialized: false };

  const normalizedSourceId = sourceId?.trim() ?? '';
  if (normalizedSourceId && sourceStore) {
    const source = await sourceStore.getSource(normalizedSourceId);
    if (source?.enabled) {
      const apiKey = source.apiKey.trim();
      if (!apiKey && options.requireApiKey !== false) {
        throw new MissingModelSourceApiKeyError(options.language);
      }
      return createResolvedStoredSource(
        source,
        migration.migrated && source.id === DEFAULT_MODEL_SOURCE_ID ? 'migration' : 'source',
        apiKey
      );
    }
  }

  if (options.requireApiKey !== false) {
    throw new MissingModelSourceApiKeyError(options.language);
  }

  const apiKey = migration.storageInitialized ? '' : legacyApiKey || environmentApiKey;
  const kind: ResolvedModelSourceKind = migration.storageInitialized
    ? 'unconfigured'
    : legacyApiKey ? 'legacy-config' : environmentApiKey ? 'environment' : 'unconfigured';
  return {
    sourceId: '',
    provider: 'deepseek',
    name: 'DeepSeek',
    apiKey,
    baseUrl: legacyBaseUrl,
    models: [],
    source: kind,
    unconfigured: true,
    supportsBilling: false
  };
}

export async function ensureLegacyModelSourceMigration(
  sourceStore: ModelSourceStore,
  input: { legacyApiKey: string; legacyBaseUrl: string }
): Promise<{ migrated: boolean; storageInitialized: boolean }> {
  let migrated = false;
  try {
    const hasStoredSources = await sourceStore.hasStoredSourceFiles();
    const initializedBefore = await sourceStore.isStorageInitialized();
    if (shouldMigrateLegacySource({
      hasStoredSourceFiles: hasStoredSources || initializedBefore,
      legacyApiKey: input.legacyApiKey
    })) {
      await sourceStore.upsertDefaultSource({
        apiKey: input.legacyApiKey,
        baseUrl: input.legacyBaseUrl,
        name: 'DeepSeek'
      });
      migrated = true;
    }
    return {
      migrated,
      storageInitialized: initializedBefore || migrated
    };
  } catch {
    // Storage failures leave legacy values as an unconfigured compatibility
    // snapshot; they never authorize selecting an arbitrary stored source.
    return { migrated: false, storageInitialized: false };
  }
}

export function shouldMigrateLegacySource(input: {
  hasStoredSourceFiles: boolean;
  legacyApiKey: string;
}): boolean {
  return !input.hasStoredSourceFiles && Boolean(input.legacyApiKey.trim());
}

function createResolvedStoredSource(
  source: ModelSource,
  kind: 'source' | 'migration',
  apiKey: string
): ResolvedModelSourceConfig {
  return {
    sourceId: source.id,
    provider: source.provider,
    name: source.name,
    apiKey,
    baseUrl: source.baseUrl,
    models: source.models.map((model) => ({ ...model })),
    modelCache: cloneCache(source.modelCache),
    modelSource: cloneSource(source),
    source: kind,
    unconfigured: false,
    supportsBilling: isOfficialDeepSeekSource(source)
  };
}

function readConfiguredString(
  override: string | undefined,
  configuration: ModelSourceConfigurationReader,
  key: string,
  fallback: string
): string {
  return (override ?? configuration.get<string>(key, fallback) ?? fallback).trim();
}

function cloneCache(cache: ModelDiscoveryCache | undefined): ModelDiscoveryCache | undefined {
  return cache
    ? { fetchedAt: cache.fetchedAt, models: cache.models.map((model) => ({ ...model })) }
    : undefined;
}

function cloneSource(source: ModelSource): ModelSource {
  return {
    ...source,
    models: source.models.map((model) => ({ ...model })),
    modelCache: cloneCache(source.modelCache)
  };
}
