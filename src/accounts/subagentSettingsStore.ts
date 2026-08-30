import * as vscode from 'vscode';
import { isRecord } from '../shared/errors';
import type { SubagentModelSetting } from '../agent/subagents/types';
import { ACCOUNTS_STORAGE_DIRECTORY } from './accountStore';

export const SUBAGENT_SETTINGS_FILE_NAME = 'settings.v1.json';

export class SubagentSettingsStore {
  private readonly uri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(private readonly globalStorageUri: vscode.Uri) {
    this.uri = vscode.Uri.joinPath(globalStorageUri, ACCOUNTS_STORAGE_DIRECTORY, SUBAGENT_SETTINGS_FILE_NAME);
  }

  public async load(): Promise<SubagentModelSetting> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      return normalizeSubagentModelSetting(JSON.parse(this.decoder.decode(bytes)));
    } catch {
      return createDefaultSubagentModelSetting();
    }
  }

  public async save(input: Pick<SubagentModelSetting, 'mode' | 'sourceId' | 'modelId'>): Promise<SubagentModelSetting> {
    const setting = normalizeSubagentModelSetting({
      ...input,
      version: 1,
      updatedAt: new Date().toISOString()
    });
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.globalStorageUri, ACCOUNTS_STORAGE_DIRECTORY));
    await vscode.workspace.fs.writeFile(this.uri, this.encoder.encode(`${JSON.stringify(setting, null, 2)}\n`));
    return setting;
  }
}

export function createDefaultSubagentModelSetting(): SubagentModelSetting {
  return {
    version: 1,
    mode: 'follow-main',
    updatedAt: new Date(0).toISOString()
  };
}

export function normalizeSubagentModelSetting(value: unknown): SubagentModelSetting {
  if (!isRecord(value) || value.mode !== 'fixed') {
    return {
      version: 1,
      mode: 'follow-main',
      updatedAt: readTimestamp(value)
    };
  }
  const sourceId = typeof value.sourceId === 'string' ? value.sourceId.trim() : '';
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim() : '';
  return {
    version: 1,
    mode: 'fixed',
    ...(sourceId ? { sourceId } : {}),
    ...(modelId ? { modelId } : {}),
    updatedAt: readTimestamp(value)
  };
}

function readTimestamp(value: unknown): string {
  if (isRecord(value) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) {
    return value.updatedAt;
  }
  return new Date(0).toISOString();
}
