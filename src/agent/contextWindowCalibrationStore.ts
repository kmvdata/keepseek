import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { ModelSourceProvider } from '../accounts/types';
import { writeJsonAtomic } from '../shared/atomicStorage';
import type { ContextWindowCalibrationState } from './toolResultAdmission';

export interface ContextWindowCalibrationKey {
  sourceId: string;
  provider: ModelSourceProvider;
  modelId: string;
  endpointHash: string;
}

interface StoredCalibration {
  version: 1;
  keyHash: string;
  state: ContextWindowCalibrationState;
  updatedAt: string;
}

/** Calibration is local host metadata and never enters system/history bytes. */
export class ContextWindowCalibrationStore {
  private readonly decoder = new TextDecoder();

  public constructor(private readonly globalStorageUri?: vscode.Uri) {}

  public async load(key: ContextWindowCalibrationKey): Promise<ContextWindowCalibrationState | undefined> {
    if (!this.globalStorageUri) return undefined;
    const keyHash = hashKey(key);
    try {
      const value: unknown = JSON.parse(this.decoder.decode(await vscode.workspace.fs.readFile(this.uri(keyHash))));
      if (!isStoredCalibration(value) || value.keyHash !== keyHash) return undefined;
      return structuredClone(value.state);
    } catch {
      return undefined;
    }
  }

  public async save(key: ContextWindowCalibrationKey, state: ContextWindowCalibrationState): Promise<void> {
    if (!this.globalStorageUri) return;
    const keyHash = hashKey(key);
    await writeJsonAtomic(this.uri(keyHash), {
      version: 1,
      keyHash,
      state: structuredClone(state),
      updatedAt: new Date().toISOString()
    } satisfies StoredCalibration);
  }

  private uri(keyHash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri!, 'model-calibration', 'v1', `${keyHash}.json`);
  }
}

function hashKey(key: ContextWindowCalibrationKey): string {
  return createHash('sha256').update(JSON.stringify([
    key.provider,
    key.sourceId.trim(),
    key.modelId.trim(),
    key.endpointHash
  ]), 'utf8').digest('hex');
}

function isStoredCalibration(value: unknown): value is StoredCalibration {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredCalibration>;
  const state = item.state;
  return item.version === 1 && typeof item.keyHash === 'string' && Boolean(state)
    && typeof state?.declaredWindowTokens === 'number'
    && typeof state.learnedEffectiveWindowTokens === 'number'
    && typeof state.estimatorScale === 'number'
    && typeof state.observations === 'number'
    && typeof state.contextTooLongCount === 'number';
}
