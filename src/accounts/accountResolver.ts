import * as vscode from 'vscode';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import type { KeepseekLanguage } from '../shared/i18n';
import { ModelSourceStore } from './accountStore';
import { isOfficialDeepSeekSource } from './sourceCapabilities';
import type {
  ModelDiscoveryCache,
  ModelSource,
  ResolvedModelSourceConfig
} from './types';

export interface ResolveModelSourceOptions {
  sourceStore?: ModelSourceStore;
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
 * 凭据解析的唯一入口：只解析请求的账号（ModelSource）。账号缺失或未启用时
 * 绝不隐式选择其它账号；旧版 keepseek.apiKey / keepseek.baseUrl 与
 * DEEPSEEK_API_KEY 环境变量不再支持，一律忽略（旧配置直接舍弃）。
 */
export async function resolveModelSourceConfig(
  sourceId: string | undefined,
  globalStorageUri?: vscode.Uri,
  options: ResolveModelSourceOptions = {}
): Promise<ResolvedModelSourceConfig> {
  const sourceStore = options.sourceStore ?? (globalStorageUri
    ? new ModelSourceStore(globalStorageUri, {
        now: options.now === undefined ? undefined : () => options.now as number
      })
    : undefined);

  const normalizedSourceId = sourceId?.trim() ?? '';
  if (normalizedSourceId && sourceStore) {
    const source = await sourceStore.getSource(normalizedSourceId);
    if (source?.enabled) {
      const apiKey = source.apiKey.trim();
      if (!apiKey && options.requireApiKey !== false) {
        throw new MissingModelSourceApiKeyError(options.language);
      }
      return createResolvedStoredSource(source, apiKey);
    }
  }

  if (options.requireApiKey !== false) {
    throw new MissingModelSourceApiKeyError(options.language);
  }
  return {
    sourceId: '',
    provider: 'deepseek',
    name: 'DeepSeek',
    apiKey: '',
    baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
    models: [],
    source: 'unconfigured',
    unconfigured: true,
    supportsBilling: false
  };
}

function createResolvedStoredSource(
  source: ModelSource,
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
    source: 'source',
    unconfigured: false,
    supportsBilling: isOfficialDeepSeekSource(source)
  };
}

function cloneCache(cache: ModelDiscoveryCache | undefined): ModelDiscoveryCache | undefined {
  return cache
    ? { fetchedAt: cache.fetchedAt, models: cache.models.map(cloneDiscoveredModel) }
    : undefined;
}

function cloneDiscoveredModel(model: ModelDiscoveryCache['models'][number]): ModelDiscoveryCache['models'][number] {
  return model.anthropicCapabilities
    ? {
        ...model,
        anthropicCapabilities: {
          ...model.anthropicCapabilities,
          effort: model.anthropicCapabilities.effort
            ? [...model.anthropicCapabilities.effort]
            : undefined
        }
      }
    : { ...model };
}

function cloneSource(source: ModelSource): ModelSource {
  return {
    ...source,
    models: source.models.map((model) => ({ ...model })),
    modelCache: cloneCache(source.modelCache)
  };
}
