export const ACCOUNT_PROVIDERS = ['deepseek', 'openai-compatible'] as const;

export type AccountProvider = typeof ACCOUNT_PROVIDERS[number];

export interface AccountModelInfo {
  id: string;
  name?: string;
}

export interface AccountModelCache {
  models: AccountModelInfo[];
  fetchedAt: number;
}

/** Persisted account schema stored below the extension's globalStorageUri. */
export interface KeepseekAccount {
  id: string;
  name: string;
  provider: AccountProvider;
  apiKey: string;
  baseUrl: string;
  modelAliases: Record<string, string>;
  modelCache?: AccountModelCache;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CreateAccountInput {
  provider: AccountProvider;
  id?: string;
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  modelAliases?: Record<string, string>;
  modelCache?: AccountModelCache;
  enabled?: boolean;
}

export interface UpdateAccountInput {
  name?: string;
  apiKey?: string;
  baseUrl?: string;
  modelAliases?: Record<string, string>;
  modelCache?: AccountModelCache;
  enabled?: boolean;
}

export type ResolvedAccountSource =
  | 'account'
  | 'migration'
  | 'legacy-config'
  | 'environment'
  | 'unconfigured';

/** Credential and model context consumed by every upstream request path. */
export interface ResolvedActiveAccountConfig {
  accountId: string;
  provider: AccountProvider;
  name: string;
  apiKey: string;
  baseUrl: string;
  models: AccountModelInfo[];
  modelCache?: AccountModelCache;
  account?: KeepseekAccount;
  source: ResolvedAccountSource;
  legacyFallback: boolean;
}

/** Immutable per-run credentials shared by the main and summary requests. */
export interface ActiveAccountConfigSnapshot {
  readonly accountId: string;
  readonly provider: AccountProvider;
  readonly apiKey: string;
  readonly baseUrl: string;
}
