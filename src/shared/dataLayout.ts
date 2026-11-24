import { GLOBAL_DEFAULT_MODEL_KEY } from '../accounts/defaultModelStore';
import { MODEL_SOURCE_PROVIDERS, type ModelSourceProvider } from '../accounts/types';
import { KEEPSEEK_STORAGE_NAMESPACE } from './identity';

/**
 * Authoritative inventory of everything KeepSeek persists below the single
 * native data root (`getNativeStorageUri()` in `shared/storageRoot.ts`).
 *
 * Every path below was verified against the writer that owns it. When a new
 * store is added under that root, add it here in the same change: the reset
 * feature deletes every root entry that is not an account record, so this list
 * is the review checklist for "what does a fresh install look like".
 *
 * Layout facts confirmed in source:
 * - Model sources live at `accounts/<provider>/<sourceId>.json` (flat file, one
 *   directory level). `ModelSource` embeds the account name, credentials, the
 *   attached `models` list and `disabledModelIds`, so this single file is the
 *   account record *and* the allowed-model list. Preserving it preserves all
 *   three preserved concepts except the default selection.
 * - `accounts/<provider>/<sourceId>/balance.json` is a *directory* named after
 *   the source, written by `agent/deepseek/balanceStore.ts`. It is not an
 *   account record and never survives a reset: keeping the `accounts`
 *   directory wholesale would keep a cache the user asked to delete.
 * - `context.globalState` carries two KeepSeek keys: the default model above
 *   and the Skills state key from `skills/skillStore.ts`.
 */
export const ACCOUNTS_DIRECTORY = 'accounts';
/** Account records are `<sourceId>.json`; anything else in that directory is a cache. */
export const ACCOUNT_FILE_EXTENSION = '.json';
/** `accounts/<provider>/<sourceId>.json` mirrors `ModelSourceStore` id rules. */
export const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
/** Balance cache directory: `accounts/<provider>/<sourceId>/balance.json`. */
export const BALANCE_FILE_NAME = 'balance.json';
/** Snapshot staging area for an in-flight reset (deleted as the final step). */
export const DATA_RESET_STAGING_DIRECTORY = 'reset-staging';
/** Machine-wide reset lock carrying pid + heartbeat timestamp. */
export const DATA_RESET_LOCK_FILE = 'reset-lock.json';
/** Reset lock lifetime; a live pid keeps it owned past the TTL. */
export const DATA_RESET_LOCK_TTL_MS = 30_000;
/** Global Memento keys that survive a reset. */
export const DATA_RESET_PRESERVED_GLOBAL_STATE_KEYS: readonly string[] = [GLOBAL_DEFAULT_MODEL_KEY];
/** Global Memento keys cleared by a reset (`skills/skillStore.ts` SKILL_STATE_KEY). */
export const DATA_RESET_PURGED_GLOBAL_STATE_KEYS: readonly string[] = ['keepseek.skillState.v1'];

export type DataLayoutPolicy = 'preserve' | 'preserve-filtered' | 'purge' | 'transient';

export interface DataLayoutEntry {
  /** Path relative to the native data root. */
  readonly path: string;
  readonly policy: DataLayoutPolicy;
  /** Writer/normalizer that owns this path, used to re-verify the inventory. */
  readonly owner: string;
  readonly description: string;
}

/** Managed entries below the native data root. */
export const KEEPSEEK_DATA_LAYOUT: readonly DataLayoutEntry[] = Object.freeze([
  {
    path: ACCOUNTS_DIRECTORY, policy: 'preserve-filtered',
    owner: 'src/accounts/accountStore.ts ModelSourceStore',
    description: 'Only `<provider>/<sourceId>.json` model-source records survive; balance directories and unknown files are purged.'
  },
  {
    path: `${ACCOUNTS_DIRECTORY}/<provider>/<sourceId>/${BALANCE_FILE_NAME}`, policy: 'purge',
    owner: 'src/agent/deepseek/balanceStore.ts GlobalBalanceStore',
    description: 'Per-source balance snapshot and refresh timestamp cache.'
  },
  {
    path: `${ACCOUNTS_DIRECTORY}/subagent-settings/v2`, policy: 'purge',
    owner: 'src/accounts/subagentSettingsStore.ts SubagentSettingsStore',
    description: 'Per-workspace subagent model settings (workspaceKey.json).'
  },
  {
    path: 'chat-sessions', policy: 'purge',
    owner: 'src/sessions/globalSessionStorage.ts, src/agent/evidence/store.ts, src/agent/subagents/store.ts',
    description: 'v2 session index/sessions/queue/write-lease, v1 evidence blobs and subagent results. Purged as one root so old version directories cannot linger.'
  },
  {
    path: 'model-calibration/v2', policy: 'purge',
    owner: 'src/agent/contextWindowCalibrationStore.ts',
    description: 'Learned effective context window and output budget per model identity.'
  },
  {
    path: 'interaction-logs', policy: 'purge',
    owner: 'src/agent/logging/interactionTrace.ts, src/agent/logging/performanceTrace.ts',
    description: 'Debug-mode trace logs and their ownership index.'
  },
  {
    path: 'usage-ledger/v2', policy: 'purge',
    owner: 'src/agent/usageLedgerStore.ts',
    description: 'Per-session billing and token usage ledger.'
  },
  {
    path: 'change-sets/v4', policy: 'purge',
    owner: 'src/edits/changeSetStore.ts',
    description: 'Draft edit / ChangeSet index, runtime records, checkpoints and history.'
  },
  {
    path: 'change-artifacts/v1', policy: 'purge',
    owner: 'src/edits/changeArtifactStore.ts',
    description: 'Content-addressed blobs for large draft payloads.'
  },
  {
    path: 'draft-runs.json', policy: 'purge',
    owner: 'src/runs/draftRunStore.ts',
    description: 'DraftRun proposals, approval records and command output references.'
  },
  {
    path: 'write-leases', policy: 'purge',
    owner: 'src/provider/KeepseekChatViewProvider.ts installProjectWriteLease',
    description: 'Fallback per-project write lease when the session store cannot provide a URI.'
  },
  {
    path: 'dropped-file-references', policy: 'purge',
    owner: 'src/provider/KeepseekChatViewProvider.ts',
    description: 'Copies of files dropped into the composer.'
  },
  {
    path: 'text-references', policy: 'purge',
    owner: 'src/context/textReferences.ts',
    description: 'Captured terminal / output / debug-console text references.'
  },
  {
    path: 'session-deletions/v1', policy: 'purge',
    owner: 'src/sessions/sessionDeletionAuthority.ts',
    description: 'Deletion tombstones, use leases and short gates.'
  },
  {
    path: 'session-quarantine/v1', policy: 'purge',
    owner: 'src/sessions/sessionQuarantine.ts',
    description: 'Undecodable store files isolated instead of deleted.'
  },
  {
    path: 'history-cleanup/v1', policy: 'purge',
    owner: 'src/sessions/sessionHistoryCleanup.ts FileHistoryCleanupJournal',
    description: 'History cleanup journals and operation records.'
  },
  {
    path: DATA_RESET_STAGING_DIRECTORY, policy: 'transient',
    owner: 'src/shared/dataReset.ts',
    description: 'Reset snapshot staging area; only its own batch is removed and a failed reset keeps it for manual recovery.'
  },
  {
    path: DATA_RESET_LOCK_FILE, policy: 'transient',
    owner: 'src/shared/dataReset.ts acquireDataResetLock',
    description: 'Machine-wide reset lock (pid + heartbeat TTL).'
  }
]);

/** The namespace every managed global Memento key is derived from. */
export const KEEPSEEK_GLOBAL_STATE_NAMESPACE = KEEPSEEK_STORAGE_NAMESPACE;

/** `<sourceId>.json` with a valid id body. */
export function isAccountRecordFileName(name: string): boolean {
  if (!name.endsWith(ACCOUNT_FILE_EXTENSION)) return false;
  return ACCOUNT_ID_PATTERN.test(name.slice(0, -ACCOUNT_FILE_EXTENSION.length));
}

export function accountSourceIdFromFileName(name: string): string | undefined {
  return isAccountRecordFileName(name) ? name.slice(0, -ACCOUNT_FILE_EXTENSION.length) : undefined;
}

export function isModelSourceProvider(value: unknown): value is ModelSourceProvider {
  return typeof value === 'string' && (MODEL_SOURCE_PROVIDERS as readonly string[]).includes(value);
}
