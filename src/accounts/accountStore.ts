import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { DEFAULT_DEEPSEEK_BASE_URL } from '../shared/config';
import { isRecord } from '../shared/errors';
import {
  ACCOUNT_PROVIDERS,
  type AccountModelCache,
  type AccountModelInfo,
  type AccountProvider,
  type CreateAccountInput,
  type KeepseekAccount,
  type UpdateAccountInput
} from './types';

export const ACCOUNTS_STORAGE_DIRECTORY = 'accounts';
export const DEFAULT_ACCOUNT_ID = 'default';
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'https://api.openai.com/v1';

const ACCOUNT_FILE_EXTENSION = '.json';
const ACCOUNT_STORAGE_INITIALIZED_FILE = '.initialized';
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ACCOUNT_NAME_LENGTH = 200;
const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 512;

export interface AccountStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export interface NormalizeAccountOptions {
  expectedId?: string;
  expectedProvider?: AccountProvider;
  now?: number;
}

export class AccountStore {
  private readonly accountsRootUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private readonly now: () => number;
  private readonly createId: () => string;

  public constructor(
    globalStorageUri: vscode.Uri,
    options: AccountStoreOptions = {}
  ) {
    this.accountsRootUri = vscode.Uri.joinPath(globalStorageUri, ACCOUNTS_STORAGE_DIRECTORY);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  public async listAccounts(provider?: AccountProvider): Promise<KeepseekAccount[]> {
    const providers = provider ? [provider] : [...ACCOUNT_PROVIDERS];
    const accounts: KeepseekAccount[] = [];
    const seenIds = new Set<string>();

    for (const currentProvider of providers) {
      const providerAccounts = await this.readProviderAccounts(currentProvider);
      for (const account of providerAccounts) {
        // activeAccountId intentionally contains only the id, so duplicate ids
        // across provider directories would be ambiguous. Keep the first stable
        // provider-order entry and refuse to create duplicates through the API.
        if (!seenIds.has(account.id)) {
          seenIds.add(account.id);
          accounts.push(account);
        }
      }
    }

    return accounts;
  }

  public async getAccount(accountId: string): Promise<KeepseekAccount | undefined> {
    if (!isValidAccountId(accountId)) {
      return undefined;
    }
    return (await this.listAccounts()).find((account) => account.id === accountId);
  }

  public async getAccountByProvider(
    provider: AccountProvider,
    accountId: string
  ): Promise<KeepseekAccount | undefined> {
    if (!isAccountProvider(provider) || !isValidAccountId(accountId)) {
      return undefined;
    }
    return await this.readAccountFile(provider, accountId);
  }

  public async createAccount(input: CreateAccountInput): Promise<KeepseekAccount> {
    if (!isAccountProvider(input.provider)) {
      throw new Error('Unsupported KeepSeek account provider.');
    }
    const id = input.id?.trim() || this.createId();
    assertValidAccountId(id);
    if (await this.getAccount(id)) {
      throw new Error(`KeepSeek account already exists: ${id}`);
    }

    const timestamp = normalizeTimestamp(this.now(), Date.now());
    const account = normalizeAccount({
      id,
      name: input.name,
      provider: input.provider,
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      modelAliases: input.modelAliases,
      modelCache: input.modelCache,
      enabled: input.enabled,
      createdAt: timestamp,
      updatedAt: timestamp
    }, {
      expectedId: id,
      expectedProvider: input.provider,
      now: timestamp
    });
    if (!account) {
      throw new Error('Invalid KeepSeek account settings.');
    }
    await this.writeAccount(account);
    await this.markStorageInitialized();
    return account;
  }

  public async saveAccount(account: KeepseekAccount): Promise<KeepseekAccount> {
    const normalized = normalizeAccount(account, {
      expectedId: account.id,
      expectedProvider: account.provider,
      now: this.now()
    });
    if (!normalized) {
      throw new Error('Invalid KeepSeek account settings.');
    }
    await this.writeAccount(normalized);
    return normalized;
  }

  public async updateAccount(
    accountId: string,
    patch: UpdateAccountInput
  ): Promise<KeepseekAccount | undefined> {
    const current = await this.getAccount(accountId);
    if (!current) {
      return undefined;
    }
    const timestamp = Math.max(current.updatedAt, normalizeTimestamp(this.now(), Date.now()));
    const candidate: KeepseekAccount = {
      ...current,
      name: patch.name ?? current.name,
      apiKey: patch.apiKey ?? current.apiKey,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      modelAliases: patch.modelAliases ?? current.modelAliases,
      modelCache: Object.prototype.hasOwnProperty.call(patch, 'modelCache')
        ? patch.modelCache
        : current.modelCache,
      enabled: patch.enabled ?? current.enabled,
      updatedAt: timestamp
    };
    return await this.saveAccount(candidate);
  }

  public async deleteAccount(accountId: string): Promise<KeepseekAccount | undefined> {
    const account = await this.getAccount(accountId);
    if (!account) {
      return undefined;
    }
    // Persist the user's explicit account-system choice before removing the
    // last JSON file, otherwise the preserved legacy key could remigrate it.
    await this.markStorageInitialized();
    await vscode.workspace.fs.delete(this.getAccountFileUri(account.provider, account.id), {
      recursive: false,
      useTrash: false
    });
    return account;
  }

  /** Create the legacy migration target without ever mutating an existing default. */
  public async upsertDefaultAccount(input: {
    apiKey: string;
    baseUrl?: string;
    name?: string;
  }): Promise<KeepseekAccount> {
    const existing = await this.getAccountByProvider('deepseek', DEFAULT_ACCOUNT_ID);
    if (existing) {
      return existing;
    }
    return await this.createAccount({
      id: DEFAULT_ACCOUNT_ID,
      name: input.name ?? 'DeepSeek',
      provider: 'deepseek',
      apiKey: input.apiKey,
      baseUrl: input.baseUrl || DEFAULT_DEEPSEEK_BASE_URL
    });
  }

  /** Migration is allowed only when no physical account JSON exists. */
  public async hasStoredAccountFiles(): Promise<boolean> {
    for (const provider of ACCOUNT_PROVIDERS) {
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
   * the last account. The marker contains no account data or credentials.
   */
  public async isStorageInitialized(): Promise<boolean> {
    try {
      const stat = await vscode.workspace.fs.stat(this.getInitializedMarkerUri());
      return stat.type === vscode.FileType.File;
    } catch (error) {
      return !isFileNotFoundError(error);
    }
  }

  public getProviderDirectoryUri(provider: AccountProvider): vscode.Uri {
    if (!isAccountProvider(provider)) {
      throw new Error('Unsupported KeepSeek account provider.');
    }
    return vscode.Uri.joinPath(this.accountsRootUri, provider);
  }

  public getAccountFileUri(provider: AccountProvider, accountId: string): vscode.Uri {
    assertValidAccountId(accountId);
    return vscode.Uri.joinPath(
      this.getProviderDirectoryUri(provider),
      `${accountId}${ACCOUNT_FILE_EXTENSION}`
    );
  }

  private async readProviderAccounts(provider: AccountProvider): Promise<KeepseekAccount[]> {
    const providerUri = this.getProviderDirectoryUri(provider);
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(providerUri);
    } catch {
      return [];
    }

    const accounts: KeepseekAccount[] = [];
    const accountFileNames = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(ACCOUNT_FILE_EXTENSION))
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
    for (const fileName of accountFileNames) {
      const accountId = fileName.slice(0, -ACCOUNT_FILE_EXTENSION.length);
      if (!isValidAccountId(accountId)) {
        continue;
      }
      const account = await this.readAccountFile(provider, accountId);
      if (account) {
        accounts.push(account);
      }
    }
    return accounts;
  }

  private async readAccountFile(
    provider: AccountProvider,
    accountId: string
  ): Promise<KeepseekAccount | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.getAccountFileUri(provider, accountId));
      const parsed: unknown = JSON.parse(this.decoder.decode(bytes));
      return normalizeAccount(parsed, {
        expectedId: accountId,
        expectedProvider: provider,
        now: this.now()
      });
    } catch {
      // A single damaged account must not hide other usable accounts or block
      // KeepSeek's legacy configuration fallback.
      return undefined;
    }
  }

  private async writeAccount(account: KeepseekAccount): Promise<void> {
    const providerUri = this.getProviderDirectoryUri(account.provider);
    await vscode.workspace.fs.createDirectory(providerUri);
    await vscode.workspace.fs.writeFile(
      this.getAccountFileUri(account.provider, account.id),
      this.encoder.encode(`${JSON.stringify(account, null, 2)}\n`)
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

export function normalizeAccount(
  value: unknown,
  options: NormalizeAccountOptions = {}
): KeepseekAccount | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = readNonEmptyString(value.id);
  const provider = normalizeAccountProvider(value.provider);
  if (!id || !isValidAccountId(id) || !provider) {
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
      || getDefaultAccountName(provider),
    provider,
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    baseUrl: readNonEmptyString(value.baseUrl) || getDefaultAccountBaseUrl(provider),
    modelAliases: normalizeModelAliases(value.modelAliases),
    modelCache: normalizeAccountModelCache(value.modelCache),
    enabled: value.enabled !== false,
    createdAt,
    updatedAt
  };
}

export function normalizeAccountModelCache(value: unknown): AccountModelCache | undefined {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    return undefined;
  }
  return {
    models: normalizeAccountModels(value.models),
    fetchedAt: normalizeTimestamp(value.fetchedAt, 0)
  };
}

export function normalizeAccountModels(value: unknown): AccountModelInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const models: AccountModelInfo[] = [];
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

export function normalizeModelAliases(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const aliases: Array<[string, string]> = [];
  for (const [rawModelId, rawAlias] of Object.entries(value)) {
    const modelId = normalizeBoundedString(rawModelId, MAX_MODEL_ID_LENGTH);
    const alias = normalizeBoundedString(rawAlias, MAX_MODEL_NAME_LENGTH);
    if (modelId && alias) {
      aliases.push([modelId, alias]);
    }
  }
  return Object.fromEntries(aliases);
}

export function normalizeAccountProvider(value: unknown): AccountProvider | undefined {
  return isAccountProvider(value) ? value : undefined;
}

export function isAccountProvider(value: unknown): value is AccountProvider {
  return typeof value === 'string' && ACCOUNT_PROVIDERS.some((provider) => provider === value);
}

export function isValidAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value) && value !== '.' && value !== '..';
}

export function getDefaultAccountName(provider: AccountProvider): string {
  return provider === 'deepseek' ? 'DeepSeek' : 'OpenAI Compatible';
}

export function getDefaultAccountBaseUrl(provider: AccountProvider): string {
  return provider === 'deepseek'
    ? DEFAULT_DEEPSEEK_BASE_URL
    : DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
}

function assertValidAccountId(accountId: string): void {
  if (!isValidAccountId(accountId)) {
    throw new Error('Invalid KeepSeek account id.');
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
