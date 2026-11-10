import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ModelSourceProvider } from '../accounts/types';
import { writeJsonAtomic } from '../shared/atomicStorage';
import {
  CONTEXT_WINDOW_CALIBRATION_VERSION,
  isCurrentContextWindowCalibrationState,
  migrateContextWindowCalibrationState,
  type ContextWindowCalibrationState,
  type ContextWindowDeclaration
} from './toolResultAdmission';

export interface ContextWindowCalibrationKey {
  sourceId: string;
  provider: ModelSourceProvider;
  /** Wire model ID used when no canonical model identity is available. */
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
    const keyHash = hashKey(key);
    const current = await this.read(this.uri(keyHash));
    const raw = isStoredCalibrationV2(current) && current.keyHash === keyHash ? current.state : undefined;
    if (!raw) return undefined;
    const normalized = migrateContextWindowCalibrationState(
      raw,
      declaration?.declaredWindowTokens ?? raw.declaredWindowTokens,
      {
        identity: declaration?.identity ?? raw.declaredIdentity,
        version: declaration?.version ?? raw.declaredVersion
      }
    ).state;
    if (declaration) {
      try {
        await this.save(key, normalized);
      } catch {
        // Optional local metadata can remain in memory after an atomic write
        // fails. The last committed current record stays authoritative on disk.
      }
    }
    return normalized;
  }

  public async save(key: ContextWindowCalibrationKey, state: ContextWindowCalibrationState): Promise<void> {
    if (!this.globalStorageUri) return;
    if (!isCurrentContextWindowCalibrationState(state)) throw new Error('Invalid current context-window calibration state');
    const keyHash = hashKey(key);
    await writeJsonAtomic(this.uri(keyHash), {
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

  private uri(keyHash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri!, 'model-calibration', 'v2', `${keyHash}.json`);
  }
}

function hashKey(key: ContextWindowCalibrationKey): string {
  return createHash('sha256').update(JSON.stringify([
    key.provider,
    key.sourceId.trim(),
    (key.canonicalModelId ?? key.modelId).trim(),
    key.endpointHash
  ]), 'utf8').digest('hex');
}

function isStoredCalibrationV2(value: unknown): value is StoredCalibrationV2 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredCalibrationV2>;
  return item.version === 2 && typeof item.keyHash === 'string' && isCurrentContextWindowCalibrationState(item.state);
}
