import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import {
  MAX_DISCOVERED_CONTEXT_WINDOW_TOKENS,
  MAX_DISCOVERED_OUTPUT_TOKENS,
  ModelSourceStore
} from './accountStore';
import { isOfficialAnthropicSource, isOfficialDeepSeekSource } from './sourceCapabilities';
import type {
  DiscoveredModelInfo,
  ModelDiscoveryCache,
  ModelSource,
  ModelSourceProvider
} from './types';

export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_MODEL_CACHE_MAX_AGE_MS = 15 * 60_000;
export const MAX_MODEL_DISCOVERY_RESPONSE_CHARS = 2_000_000;

export interface ModelsFetchResponse {
  ok: boolean;
  status?: number;
  text(): Promise<string>;
}

export type ModelsFetch = (
  input: string,
  init: RequestInit
) => Promise<ModelsFetchResponse>;

export interface DiscoverSourceModelsOptions {
  fetchImpl?: ModelsFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export interface RefreshSourceModelCacheOptions extends DiscoverSourceModelsOptions {
  force?: boolean;
  maxAgeMs?: number;
}

export function getSourceModelsEndpointUrl(
  rawBaseUrl: string,
  provider: ModelSourceProvider = 'deepseek'
): string {
  const fallback = provider === 'deepseek' ? DEFAULT_DEEPSEEK_BASE_URL : '';
  const url = new URL(rawBaseUrl.trim() || fallback);
  const cleanPath = url.pathname.replace(/\/+$/u, '');

  // DeepSeek accepts /v1 for OpenAI compatibility, but its canonical models
  // endpoint is rooted at /models. Proxies retain their routing prefix.
  if (isOfficialDeepSeekSource({ provider, baseUrl: url.toString() })) {
    url.pathname = '/models';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  const completionsSuffix = '/chat/completions';
  const responsesSuffix = '/responses';
  const messagesSuffix = '/messages';
  const withoutProtocolEndpoint = cleanPath.endsWith(completionsSuffix)
    ? cleanPath.slice(0, -completionsSuffix.length)
    : cleanPath.endsWith(responsesSuffix)
      ? cleanPath.slice(0, -responsesSuffix.length)
      : cleanPath.endsWith(messagesSuffix)
        ? cleanPath.slice(0, -messagesSuffix.length)
        : cleanPath;
  url.pathname = withoutProtocolEndpoint.endsWith('/models')
    ? withoutProtocolEndpoint
    : `${withoutProtocolEndpoint || ''}/models`;
  url.hash = '';
  return url.toString();
}

export function parseSourceModelsResponse(
  value: unknown,
  provider?: ModelSourceProvider
): DiscoveredModelInfo[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawModels = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models) ? value.models : undefined;
  if (!rawModels) {
    return undefined;
  }

  const models: DiscoveredModelInfo[] = [];
  const seenIds = new Set<string>();
  for (const rawModel of rawModels) {
    const model = parseSourceModel(rawModel, provider);
    if (!model || seenIds.has(model.id)) {
      continue;
    }
    seenIds.add(model.id);
    models.push(model);
  }
  return models;
}

/** A failed request returns undefined and never disrupts the chat request path. */
export async function discoverSourceModels(
  source: Pick<ModelSource, 'apiKey' | 'baseUrl' | 'provider'>,
  options: DiscoverSourceModelsOptions = {}
): Promise<ModelDiscoveryCache | undefined> {
  const apiKey = source.apiKey.trim();
  if (!source.baseUrl.trim()) {
    return undefined;
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeoutMs = normalizeNonNegativeInteger(
      options.timeoutMs,
      DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    );
    if (timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    const endpointUrl = getSourceModelsEndpointUrl(source.baseUrl, source.provider);
    const fetchImpl: ModelsFetch = options.fetchImpl ?? fetch;
    const headers = createModelDiscoveryHeaders(source.provider, apiKey);
    const response = await fetchImpl(endpointUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    const responseText = await response.text();
    if (responseText.length > MAX_MODEL_DISCOVERY_RESPONSE_CHARS) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(responseText);
    const models = parseSourceModelsResponse(parsed, source.provider);
    if (!models) {
      return undefined;
    }
    return {
      models,
      fetchedAt: normalizeTimestamp(options.now, Date.now())
    };
  } catch {
    return undefined;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

export interface ProbeSourceConnectionResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export type SourceConnectionProber = (
  source: Pick<ModelSource, 'apiKey' | 'baseUrl' | 'provider'>,
  options?: DiscoverSourceModelsOptions
) => Promise<ProbeSourceConnectionResult>;

/**
 * Lightweight connectivity probe run before creating a new source. With an
 * API key the probe requires a 2xx response (authentication succeeded).
 * Without a key any HTTP response proves the Base URL is reachable, which
 * matches local models that need no credentials.
 */
export async function probeSourceConnection(
  source: Pick<ModelSource, 'apiKey' | 'baseUrl' | 'provider'>,
  options: DiscoverSourceModelsOptions = {}
): Promise<ProbeSourceConnectionResult> {
  const baseUrl = source.baseUrl.trim();
  if (!baseUrl) {
    return { ok: false, error: 'Base URL is required.' };
  }
  const apiKey = source.apiKey.trim();
  if (!apiKey && isOfficialAnthropicSource(source)) {
    return { ok: false, error: 'An API Key is required for the official Anthropic endpoint.' };
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (options.signal?.aborted) {
      controller.abort();
    } else {
      options.signal?.addEventListener('abort', abortFromParent, { once: true });
    }
    const timeoutMs = normalizeNonNegativeInteger(
      options.timeoutMs,
      DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS
    );
    if (timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(), timeoutMs);
    }

    const endpointUrl = getSourceModelsEndpointUrl(baseUrl, source.provider);
    const fetchImpl: ModelsFetch = options.fetchImpl ?? fetch;
    const headers = createModelDiscoveryHeaders(source.provider, apiKey);
    const response = await fetchImpl(endpointUrl, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    if (!response.ok) {
      if ((source.provider === 'openai-responses' || source.provider === 'anthropic-compatible')
        && response.status === 404) {
        return {
          ok: false,
          status: response.status,
          error: `${source.provider === 'anthropic-compatible' ? 'Anthropic Messages' : 'KeepSeek Responses'} accounts require a compatible GET /models endpoint for account discovery.`
        };
      }
      if (source.provider === 'anthropic-compatible'
        && (response.status === 401 || response.status === 403)) {
        return {
          ok: false,
          status: response.status,
          error: `Authentication failed (HTTP ${response.status}). Check the API Key and Base URL.`
        };
      }
      if (!apiKey) {
        return { ok: true, status: response.status };
      }
      return {
        ok: false,
        status: response.status,
        error: response.status === 401 || response.status === 403
          ? `Authentication failed (HTTP ${response.status}). Check the API Key and Base URL.`
          : `Model discovery failed (HTTP ${response.status}). KeepSeek account discovery requires GET /models.`
      };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      return {
        ok: false,
        error: `Model discovery timed out after ${normalizeNonNegativeInteger(options.timeoutMs, DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS)} ms.`
      };
    }
    return {
      ok: false,
      error: `Cannot reach the Base URL: ${error instanceof Error ? error.message : String(error)}`
    };
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Return a fresh cache when possible and a stale cache on discovery failure.
 * Persisting cache data is best-effort because it is never request-critical.
 */
export interface RefreshSourceModelCacheResult {
  cache?: ModelDiscoveryCache;
  status: 'fresh' | 'cached' | 'failed' | 'missing-source';
}

export async function refreshSourceModelCache(
  sourceStore: ModelSourceStore,
  sourceId: string,
  options: RefreshSourceModelCacheOptions = {}
): Promise<RefreshSourceModelCacheResult> {
  const source = await sourceStore.getSource(sourceId);
  if (!source) {
    return { status: 'missing-source' };
  }
  const now = normalizeTimestamp(options.now, Date.now());
  const maxAgeMs = normalizeNonNegativeInteger(options.maxAgeMs, DEFAULT_MODEL_CACHE_MAX_AGE_MS);
  if (!options.force && source.modelCache && now - source.modelCache.fetchedAt < maxAgeMs) {
    return { cache: cloneCache(source.modelCache), status: 'cached' };
  }

  const discovered = await discoverSourceModels(source, { ...options, now });
  if (!discovered) {
    return {
      cache: source.modelCache ? cloneCache(source.modelCache) : undefined,
      status: 'failed'
    };
  }
  const latestSource = await sourceStore.getSource(source.id);
  if (!latestSource) {
    return { status: 'missing-source' };
  }
  if (
    latestSource.provider !== source.provider
    || latestSource.apiKey !== source.apiKey
    || latestSource.baseUrl !== source.baseUrl
  ) {
    // A slow response from the previous connection must not populate the cache
    // after the user has saved a different key or endpoint.
    return {
      cache: latestSource.modelCache ? cloneCache(latestSource.modelCache) : undefined,
      status: 'failed'
    };
  }
  try {
    await sourceStore.updateSource(source.id, { modelCache: discovered });
  } catch {
    // The newly fetched result is still useful for the current UI render.
  }
  return { cache: cloneCache(discovered), status: 'fresh' };
}

export function createModelDiscoveryHeaders(
  provider: ModelSourceProvider,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (provider === 'anthropic-compatible') {
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function parseSourceModel(
  value: unknown,
  provider?: ModelSourceProvider
): DiscoveredModelInfo | undefined {
  if (typeof value === 'string') {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  if (!id) {
    return undefined;
  }
  const name = readNonEmptyString(value.name)
    ?? readNonEmptyString(value.display_name)
    ?? readNonEmptyString(value.displayName)
    ?? readNonEmptyString(value.label);
  if (provider !== 'anthropic-compatible') {
    return name ? { id, name } : { id };
  }
  const contextWindowTokens = readBoundedPositiveInteger(
    value.max_input_tokens,
    MAX_DISCOVERED_CONTEXT_WINDOW_TOKENS
  );
  const maxOutputTokens = readBoundedPositiveInteger(
    value.max_tokens,
    MAX_DISCOVERED_OUTPUT_TOKENS
  );
  const anthropicCapabilities = parseAnthropicCapabilities(value.capabilities);
  return {
    id,
    ...(name ? { name } : {}),
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(anthropicCapabilities ? { anthropicCapabilities } : {})
  };
}

function parseAnthropicCapabilities(
  value: unknown
): DiscoveredModelInfo['anthropicCapabilities'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawThinking = value.thinking;
  let thinking: 'adaptive' | 'enabled' | undefined;
  if (rawThinking === 'adaptive') {
    thinking = 'adaptive';
  } else if (rawThinking === true || rawThinking === 'enabled') {
    thinking = 'enabled';
  } else if (isRecord(rawThinking)) {
    const modes = Array.isArray(rawThinking.modes) ? rawThinking.modes : [];
    if (rawThinking.adaptive === true || modes.includes('adaptive') || rawThinking.type === 'adaptive') {
      thinking = 'adaptive';
    } else if (rawThinking.enabled === true || modes.includes('enabled') || rawThinking.type === 'enabled') {
      thinking = 'enabled';
    }
  }

  const rawEffort = value.effort;
  const effort: Array<'high' | 'max'> = [];
  const addEffort = (level: 'high' | 'max') => {
    if (!effort.includes(level)) {
      effort.push(level);
    }
  };
  if (rawEffort === true) {
    addEffort('high');
  } else if (typeof rawEffort === 'string') {
    if (rawEffort === 'high' || rawEffort === 'max') {
      addEffort(rawEffort);
    }
  } else if (Array.isArray(rawEffort)) {
    if (rawEffort.includes('high')) addEffort('high');
    if (rawEffort.includes('max')) addEffort('max');
  } else if (isRecord(rawEffort)) {
    const levels = Array.isArray(rawEffort.levels) ? rawEffort.levels : [];
    if (rawEffort.high === true || levels.includes('high')) addEffort('high');
    if (rawEffort.max === true || levels.includes('max')) addEffort('max');
  }
  return thinking || effort.length
    ? { ...(thinking ? { thinking } : {}), ...(effort.length ? { effort } : {}) }
    : undefined;
}

function cloneCache(cache: ModelDiscoveryCache): ModelDiscoveryCache {
  return {
    fetchedAt: cache.fetchedAt,
    models: cache.models.map((model) => model.anthropicCapabilities
      ? {
          ...model,
          anthropicCapabilities: {
            ...model.anthropicCapabilities,
            effort: model.anthropicCapabilities.effort
              ? [...model.anthropicCapabilities.effort]
              : undefined
          }
        }
      : { ...model })
  };
}

function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : Math.floor(fallback);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readBoundedPositiveInteger(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
