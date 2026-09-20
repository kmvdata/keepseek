import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ModelSourceProvider } from '../accounts/types';
import { writeJsonAtomic } from '../shared/atomicStorage';
import {
  CONTEXT_WINDOW_CALIBRATION_VERSION,
  migrateContextWindowCalibrationState,
  type ContextWindowCalibrationState,
  type ContextWindowDeclaration,
  type RestoredContextWindowCalibrationState
} from './toolResultAdmission';

export interface ContextWindowCalibrationKey {
  sourceId: string;
  provider: ModelSourceProvider;
  /** Original wire model ID, retained only for locating v1 records. */
  modelId: string;
  /** Canonical local identity used by v2 records. */
  canonicalModelId?: string;
  endpointHash: string;
}

interface StoredCalibrationV2 {
  version: 2;
  keyHash: string;
  state: ContextWindowCalibrationState;
  updatedAt: string;
}

/** Calibration is local host metadata and never enters system/history bytes. */
export class ContextWindowCalibrationStore {
  private readonly decoder = new TextDecoder();

  public constructor(private readonly globalStorageUri?: vscode.Uri) {}

  public async load(
    key: ContextWindowCalibrationKey,
    declaration?: ContextWindowDeclaration & { declaredWindowTokens: number }
  ): Promise<ContextWindowCalibrationState | undefined> {
    if (!this.globalStorageUri) return undefined;
    const v2Hash = hashKey(key, true);
    const current = await this.read(this.uri(v2Hash, 2));
    let raw: RestoredContextWindowCalibrationState | undefined = isStoredCalibrationV2(current)
      && current.keyHash === v2Hash ? current.state : undefined;
    let migratedFromV1 = false;
    if (!raw) {
      const v1Hash = hashKey(key, false);
      const legacy = await this.read(this.uri(v1Hash, 1));
      if (isStoredCalibrationV1(legacy) && legacy.keyHash === v1Hash) {
        raw = legacy.state;
        migratedFromV1 = true;
      }
    }
    if (!raw) return undefined;
    const normalized = migrateContextWindowCalibrationState(
      raw,
      declaration?.declaredWindowTokens ?? raw.declaredWindowTokens,
      {
        identity: declaration?.identity
          ?? (raw.version === 2 ? raw.declaredIdentity : undefined)
          ?? key.canonicalModelId ?? key.modelId,
        version: declaration?.version
          ?? (raw.version === 2 ? raw.declaredVersion : undefined)
          ?? 'context-capability-v2'
      }
    ).state;
    if (declaration || migratedFromV1) {
      // A failed write leaves the v1 source intact, so migration is retryable.
      try {
        await this.save(key, normalized);
      } catch {
        // The normalized in-memory state is still safe to use. Never delete or
        // rewrite the v1 source before the atomic v2 write succeeds.
      }
    }
    return normalized;
  }

  public async save(key: ContextWindowCalibrationKey, state: ContextWindowCalibrationState): Promise<void> {
    if (!this.globalStorageUri) return;
    const keyHash = hashKey(key, true);
    await writeJsonAtomic(this.uri(keyHash, 2), {
      version: CONTEXT_WINDOW_CALIBRATION_VERSION,
      keyHash,
      state: structuredClone(state),
      updatedAt: new Date().toISOString()
    } satisfies StoredCalibrationV2);
  }

  private async read(uri: vscode.Uri): Promise<unknown> {
    try {
      return JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(uri)));
    } catch {
      return undefined;
    }
  }

  private uri(keyHash: string, version: 1 | 2): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri!, 'model-calibration', `v${version}`, `${keyHash}.json`);
  }
}

function hashKey(key: ContextWindowCalibrationKey, canonical: boolean): string {
  return createHash('sha256').update(JSON.stringify([
    key.provider,
    key.sourceId.trim(),
    canonical ? (key.canonicalModelId ?? key.modelId).trim() : key.modelId.trim(),
    key.endpointHash
  ]), 'utf8').digest('hex');
}

function isStoredCalibrationV2(value: unknown): value is StoredCalibrationV2 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredCalibrationV2>;
  const state = item.state;
  return item.version === 2 && typeof item.keyHash === 'string' && state?.version === 2
    && isFinitePositive(state.declaredWindowTokens)
    && isFinitePositive(state.learnedEffectiveWindowTokens)
    && Number.isFinite(state.estimatorScale)
    && Number.isFinite(state.observations)
    && Number.isFinite(state.contextTooLongCount);
}

function isStoredCalibrationV1(value: unknown): value is {
  version: 1;
  keyHash: string;
  state: RestoredContextWindowCalibrationState;
} {
  if (!value || typeof value !== 'object') return false;
  const item = value as { version?: unknown; keyHash?: unknown; state?: unknown };
  const state = item.state as Partial<RestoredContextWindowCalibrationState> | undefined;
  return item.version === 1 && typeof item.keyHash === 'string' && Boolean(state)
    && isFinitePositive(state?.declaredWindowTokens)
    && isFinitePositive(state.learnedEffectiveWindowTokens)
    && Number.isFinite(state.estimatorScale);
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
