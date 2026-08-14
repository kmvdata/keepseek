export const MODEL_SOURCE_PROVIDERS = ['deepseek', 'openai-compatible'] as const;

export type ModelSourceProvider = typeof MODEL_SOURCE_PROVIDERS[number];

/** Model metadata returned by a provider's OpenAI-compatible /models endpoint. */
export interface DiscoveredModelInfo {
  id: string;
  name?: string;
}

export interface ModelDiscoveryCache {
  models: DiscoveredModelInfo[];
  fetchedAt: number;
}

/** A model explicitly attached to a source. `name` is the user's display nickname. */
export interface ModelSourceModel {
  id: string;
  name?: string;
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

export type ResolvedModelSourceKind =
  | 'source'
  | 'migration'
  | 'legacy-config'
  | 'environment'
  | 'unconfigured';

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
