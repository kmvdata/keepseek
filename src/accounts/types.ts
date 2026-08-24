/**
 * 账号（ModelSource）→ API 类型（AccountApiType）分层。
 *
 * 每个账号属于且仅属于一种 API 类型：deepseek（DeepSeek 官方协议）、
 * ollama（Ollama 本地端点）、openai-compatible（Chat Completions 兼容端点）、
 * openai-responses（Responses API 兼容端点）。
 * API 类型决定默认 Base URL、模型发现端点、请求客户端分派与余额能力；
 * 账号本身只保存名称、凭证与已挂载模型。
 *
 * 旧版 keepseek.apiKey / keepseek.baseUrl / DEEPSEEK_API_KEY 环境变量
 * 不再支持，读取时直接舍弃，不做迁移。
 */
export const MODEL_SOURCE_PROVIDERS = [
  'deepseek',
  'ollama',
  'openai-compatible',
  'openai-responses'
] as const;

export type ModelSourceProvider = typeof MODEL_SOURCE_PROVIDERS[number];

/** 账号所属的 API 类型（account → api type）。 */
export type AccountApiType = ModelSourceProvider;

/** Model metadata returned by a provider's OpenAI-compatible /models endpoint. */
export interface DiscoveredModelInfo {
  id: string;
  name?: string;
}

export interface ModelDiscoveryCache {
  models: DiscoveredModelInfo[];
  fetchedAt: number;
}

/** A model explicitly attached to a source. */
export interface ModelSourceModel {
  id: string;
}

/** Persisted model-source schema stored below the extension's globalStorageUri. */
export interface ModelSource {
  id: string;
  name: string;
  provider: ModelSourceProvider;
  apiKey: string;
  baseUrl: string;
  models: ModelSourceModel[];
  modelCache?: ModelDiscoveryCache;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateModelSourceInput {
  provider: ModelSourceProvider;
  id?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelSourceModel[];
  modelCache?: ModelDiscoveryCache;
  enabled?: boolean;
}

export interface UpdateModelSourceInput {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  models?: ModelSourceModel[];
  modelCache?: ModelDiscoveryCache;
  enabled?: boolean;
}

/** 解析结果来源：已存储账号，或未配置（不携带任何旧配置快照）。 */
export type ResolvedModelSourceKind = 'source' | 'unconfigured';

/** Credential and model context consumed by every upstream request path. */
export interface ResolvedModelSourceConfig {
  sourceId: string;
  provider: ModelSourceProvider;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: ModelSourceModel[];
  modelCache?: ModelDiscoveryCache;
  modelSource?: ModelSource;
  source: ResolvedModelSourceKind;
  unconfigured: boolean;
  supportsBilling: boolean;
}

/** Immutable per-run credentials shared by the main and summary requests. */
export interface ModelSourceConfigSnapshot {
  readonly sourceId: string;
  readonly provider: ModelSourceProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly supportsBilling: boolean;
}
