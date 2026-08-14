import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import { AccountStore } from './accountStore';
import type {
  AccountModelCache,
  AccountModelInfo,
  AccountProvider,
  KeepseekAccount
} from './types';

export const DEFAULT_MODEL_DISCOVERY_TIMEOUT_MS = 10_000;
export const DEFAULT_MODEL_CACHE_MAX_AGE_MS = 15 * 60_000;
export const MAX_MODEL_DISCOVERY_RESPONSE_CHARS = 2_000_000;

export interface ModelsFetchResponse {
  ok: boolean;
  text(): Promise<string>;
}

export type ModelsFetch = (
  input: string,
  init: RequestInit
) => Promise<ModelsFetchResponse>;

export interface DiscoverAccountModelsOptions {
  fetchImpl?: ModelsFetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: number;
}

export interface RefreshAccountModelCacheOptions extends DiscoverAccountModelsOptions {
  force?: boolean;
  maxAgeMs?: number;
}

export function getAccountModelsEndpointUrl(
  rawBaseUrl: string,
  provider: AccountProvider = 'deepseek'
): string {
  const fallback = provider === 'deepseek' ? DEFAULT_DEEPSEEK_BASE_URL : '';
  const url = new URL(rawBaseUrl.trim() || fallback);
  const cleanPath = url.pathname.replace(/\/+$/u, '');

  // DeepSeek accepts /v1 for OpenAI compatibility, but its canonical models
  // endpoint is rooted at /models. Proxies retain their routing prefix.
  if (url.hostname === 'api.deepseek.com') {
    url.pathname = '/models';
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  const completionsSuffix = '/chat/completions';
  const withoutCompletions = cleanPath.endsWith(completionsSuffix)
    ? cleanPath.slice(0, -completionsSuffix.length)
    : cleanPath;
  url.pathname = withoutCompletions.endsWith('/models')
    ? withoutCompletions
    : `${withoutCompletions || ''}/models`;
  url.hash = '';
  return url.toString();
}

export function parseAccountModelsResponse(value: unknown): AccountModelInfo[] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawModels = Array.isArray(value.data)
    ? value.data
    : Array.isArray(value.models) ? value.models : undefined;
  if (!rawModels) {
    return undefined;
  }

  const models: AccountModelInfo[] = [];
  const seenIds = new Set<string>();
  for (const rawModel of rawModels) {
    const model = parseAccountModel(rawModel);
    if (!model || seenIds.has(model.id)) {
      continue;
    }
    seenIds.add(model.id);
    models.push(model);
  }
  return models;
}

/** A failed request returns undefined and never disrupts the chat request path. */
export async function discoverAccountModels(
  account: Pick<KeepseekAccount, 'apiKey' | 'baseUrl' | 'provider'>,
  options: DiscoverAccountModelsOptions = {}
): Promise<AccountModelCache | undefined> {
  const apiKey = account.apiKey.trim();
  if (!apiKey || !account.baseUrl.trim()) {
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

    const endpointUrl = getAccountModelsEndpointUrl(account.baseUrl, account.provider);
    const fetchImpl: ModelsFetch = options.fetchImpl ?? fetch;
    const response = await fetchImpl(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
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
    const models = parseAccountModelsResponse(parsed);
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

/**
 * Return a fresh cache when possible and a stale cache on discovery failure.
 * Persisting cache data is best-effort because it is never request-critical.
 */
export async function refreshAccountModelCache(
  accountStore: AccountStore,
  accountId: string,
  options: RefreshAccountModelCacheOptions = {}
): Promise<AccountModelCache | undefined> {
  const account = await accountStore.getAccount(accountId);
  if (!account) {
    return undefined;
  }
  const now = normalizeTimestamp(options.now, Date.now());
  const maxAgeMs = normalizeNonNegativeInteger(options.maxAgeMs, DEFAULT_MODEL_CACHE_MAX_AGE_MS);
  if (!options.force && account.modelCache && now - account.modelCache.fetchedAt < maxAgeMs) {
    return cloneCache(account.modelCache);
  }

  const discovered = await discoverAccountModels(account, { ...options, now });
  if (!discovered) {
    return account.modelCache ? cloneCache(account.modelCache) : undefined;
  }
  const latestAccount = await accountStore.getAccount(account.id);
  if (!latestAccount) {
    return undefined;
  }
  if (
    latestAccount.provider !== account.provider
    || latestAccount.apiKey !== account.apiKey
    || latestAccount.baseUrl !== account.baseUrl
  ) {
    // A slow response from the previous connection must not populate the cache
    // after the user has saved a different key or endpoint.
    return latestAccount.modelCache ? cloneCache(latestAccount.modelCache) : undefined;
  }
  const merged = mergeDiscoveredCacheWithManualModels(discovered, latestAccount.modelCache);
  try {
    await accountStore.updateAccount(account.id, { modelCache: merged });
  } catch {
    // The newly fetched result is still useful for the current UI render.
  }
  return cloneCache(merged);
}

/**
 * Provider responses replace stale named entries, while unnamed entries that
 * are absent from the response are retained as manually entered model ids.
 */
export function mergeDiscoveredCacheWithManualModels(
  discovered: AccountModelCache,
  previous: AccountModelCache | undefined
): AccountModelCache {
  const models = discovered.models.map((model) => ({ ...model }));
  const discoveredIds = new Set(models.map((model) => model.id));
  for (const model of previous?.models ?? []) {
    if (!model.name && !discoveredIds.has(model.id)) {
      discoveredIds.add(model.id);
      models.push({ id: model.id });
    }
  }
  return {
    models,
    fetchedAt: discovered.fetchedAt
  };
}

/**
 * Connection changes invalidate provider-discovered names, but model ids entered
 * manually must remain available when an OpenAI-compatible endpoint has no
 * usable /models response. Unnamed cache entries are the persisted manual-id
 * representation used by the settings UI and discovery merge path.
 */
export function retainManualAccountModelCache(
  cache: AccountModelCache | undefined
): AccountModelCache | undefined {
  const models = (cache?.models ?? [])
    .filter((model) => !model.name?.trim())
    .map((model) => ({ id: model.id }));
  return models.length
    ? { models, fetchedAt: 0 }
    : undefined;
}

function parseAccountModel(value: unknown): AccountModelInfo | undefined {
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
  return name ? { id, name } : { id };
}

function cloneCache(cache: AccountModelCache): AccountModelCache {
  return {
    fetchedAt: cache.fetchedAt,
    models: cache.models.map((model) => ({ ...model }))
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
