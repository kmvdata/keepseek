import * as vscode from 'vscode';
import { DEFAULT_ACTIVE_ACCOUNT_ID, DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import type { KeepseekLanguage } from '../shared/i18n';
import { AccountStore, DEFAULT_ACCOUNT_ID } from './accountStore';
import type {
  KeepseekAccount,
  ResolvedActiveAccountConfig,
  ResolvedAccountSource
} from './types';

export interface AccountConfigurationReader {
  get<T>(section: string, defaultValue: T): T;
}

export interface ResolveActiveAccountOptions {
  configuration?: AccountConfigurationReader;
  accountStore?: AccountStore;
  activeAccountId?: string;
  legacyApiKey?: string;
  legacyBaseUrl?: string;
  environmentApiKey?: string;
  language?: KeepseekLanguage;
  now?: number;
  /** Runtime request paths require a key; account-management views set this false. */
  requireApiKey?: boolean;
}

export class MissingAccountApiKeyError extends Error {
  public readonly code = 'missing_api_key';

  public constructor(language: KeepseekLanguage = 'zh-CN') {
    super(language === 'en'
      ? 'Save a DeepSeek API Key in KeepSeek Settings > Api Key, or set the DEEPSEEK_API_KEY environment variable.'
      : '请先在 KeepSeek 设置 > Api Key 中保存 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量。');
    this.name = 'MissingAccountApiKeyError';
  }
}

/**
 * The only credential resolver used by conversations, summaries, balance, and
 * provider state. Passing no globalStorageUri deliberately retains the exact
 * legacy configuration/environment behavior.
 */
export async function resolveActiveAccountConfig(
  globalStorageUri?: vscode.Uri,
  options: ResolveActiveAccountOptions = {}
): Promise<ResolvedActiveAccountConfig> {
  const configuration = options.configuration ?? vscode.workspace.getConfiguration('keepseek');
  const activeAccountId = readConfiguredString(
    options.activeAccountId,
    configuration,
    'activeAccountId',
    DEFAULT_ACTIVE_ACCOUNT_ID
  );
  const legacyApiKey = readConfiguredString(
    options.legacyApiKey,
    configuration,
    'apiKey',
    ''
  );
  const legacyBaseUrl = readConfiguredString(
    options.legacyBaseUrl,
    configuration,
    'baseUrl',
    DEFAULT_DEEPSEEK_BASE_URL
  ) || DEFAULT_DEEPSEEK_BASE_URL;
  const environmentApiKey = (options.environmentApiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  const accountStore = options.accountStore ?? (globalStorageUri
    ? new AccountStore(globalStorageUri, {
        now: options.now === undefined ? undefined : () => options.now as number
      })
    : undefined);

  let migrated = false;
  let storageInitialized = false;
  let accounts: KeepseekAccount[] = [];
  if (accountStore) {
    try {
      const hasStoredAccounts = await accountStore.hasStoredAccountFiles();
      storageInitialized = await accountStore.isStorageInitialized();
      if (shouldMigrateLegacyAccount({
        hasStoredAccountFiles: hasStoredAccounts || storageInitialized,
        legacyApiKey
      })) {
        await accountStore.upsertDefaultAccount({
          apiKey: legacyApiKey,
          baseUrl: legacyBaseUrl,
          name: 'DeepSeek'
        });
        migrated = true;
      }
      accounts = await accountStore.listAccounts();
    } catch {
      // Account storage must never make the legacy request path unavailable.
      accounts = [];
      migrated = false;
      storageInitialized = false;
    }
  }

  const activeAccount = chooseActiveAccount(accounts, activeAccountId);
  if (activeAccount) {
    const apiKey = activeAccount.apiKey.trim()
      || (activeAccount.provider === 'deepseek' ? environmentApiKey : '');
    if (!apiKey && options.requireApiKey !== false) {
      throw new MissingAccountApiKeyError(options.language);
    }
    const modelCache = activeAccount.modelCache
      ? {
          fetchedAt: activeAccount.modelCache.fetchedAt,
          models: activeAccount.modelCache.models.map((model) => ({ ...model }))
        }
      : undefined;
    const source: ResolvedAccountSource = migrated && activeAccount.id === DEFAULT_ACCOUNT_ID
      ? 'migration'
      : 'account';
    return {
      accountId: activeAccount.id,
      provider: activeAccount.provider,
      name: activeAccount.name,
      apiKey,
      baseUrl: activeAccount.baseUrl,
      models: modelCache?.models.map((model) => ({ ...model })) ?? [],
      modelCache,
      account: cloneAccount(activeAccount),
      source,
      legacyFallback: false
    };
  }

  if (storageInitialized) {
    if (options.requireApiKey !== false) {
      throw new MissingAccountApiKeyError(options.language);
    }
    return {
      accountId: DEFAULT_ACCOUNT_ID,
      provider: 'deepseek',
      name: 'DeepSeek',
      apiKey: '',
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      models: [],
      source: 'unconfigured',
      legacyFallback: false
    };
  }

  const apiKey = legacyApiKey || environmentApiKey;
  if (!apiKey && options.requireApiKey !== false) {
    throw new MissingAccountApiKeyError(options.language);
  }
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    provider: 'deepseek',
    name: 'DeepSeek',
    apiKey,
    baseUrl: legacyBaseUrl,
    models: [],
    source: legacyApiKey || !environmentApiKey ? 'legacy-config' : 'environment',
    legacyFallback: true
  };
}

export function shouldMigrateLegacyAccount(input: {
  hasStoredAccountFiles: boolean;
  legacyApiKey: string;
}): boolean {
  return !input.hasStoredAccountFiles && Boolean(input.legacyApiKey.trim());
}

export function chooseActiveAccount(
  accounts: readonly KeepseekAccount[],
  configuredAccountId: string
): KeepseekAccount | undefined {
  const enabledAccounts = accounts.filter((account) => account.enabled);
  const configuredId = configuredAccountId.trim();
  if (configuredId) {
    const configured = enabledAccounts.find((account) => account.id === configuredId);
    if (configured) {
      return configured;
    }
  }
  return enabledAccounts.find((account) => account.id === DEFAULT_ACCOUNT_ID)
    ?? enabledAccounts[0];
}

function readConfiguredString(
  override: string | undefined,
  configuration: AccountConfigurationReader,
  key: string,
  fallback: string
): string {
  return (override ?? configuration.get<string>(key, fallback) ?? fallback).trim();
}

function cloneAccount(account: KeepseekAccount): KeepseekAccount {
  return {
    ...account,
    modelAliases: { ...account.modelAliases },
    modelCache: account.modelCache
      ? {
          fetchedAt: account.modelCache.fetchedAt,
          models: account.modelCache.models.map((model) => ({ ...model }))
        }
      : undefined
  };
}
