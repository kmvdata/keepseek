import * as vscode from 'vscode';
import { isRecord } from '../shared/errors';
import type { SubagentModelSetting } from '../agent/subagents/types';
import { getWorkspaceHash } from '../sessions/globalSessionStorage';

const SUBAGENT_SETTINGS_DIRECTORY = 'subagent-settings';
const SUBAGENT_SETTINGS_VERSION_DIRECTORY = 'v1';

export interface SubagentModelSettingsSnapshot {
  version: 2;
  default: SubagentModelSetting;
  profiles: Record<string, SubagentModelSetting>;
}

export class SubagentSettingsStore {
  private persistenceQueue: Promise<void> = Promise.resolve();
  private readonly directoryUri: vscode.Uri;
  private readonly uri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(globalStorageUri: vscode.Uri, workspaceKey: string) {
    this.directoryUri = vscode.Uri.joinPath(
      globalStorageUri,
      SUBAGENT_SETTINGS_DIRECTORY,
      SUBAGENT_SETTINGS_VERSION_DIRECTORY
    );
    this.uri = vscode.Uri.joinPath(
      this.directoryUri,
      `${getWorkspaceHash(workspaceKey.trim() || 'workspace:empty')}.json`
    );
  }

  public async load(profileId?: string): Promise<SubagentModelSetting> {
    const snapshot = await this.loadAll();
    const profile = normalizeProfileId(profileId);
    return profile ? snapshot.profiles[profile] ?? snapshot.default : snapshot.default;
  }

  public async loadAll(): Promise<SubagentModelSettingsSnapshot> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      return normalizeSubagentModelSettingsSnapshot(JSON.parse(this.decoder.decode(bytes)));
    } catch {
      return createDefaultSubagentModelSettingsSnapshot();
    }
  }

  public async save(
    input: Pick<SubagentModelSetting, 'mode' | 'sourceId' | 'modelId'>,
    profileId?: string
  ): Promise<SubagentModelSetting> {
    const setting = normalizeSubagentModelSetting({
      ...input,
      version: 1,
      updatedAt: new Date().toISOString()
    });
    const profile = normalizeProfileId(profileId);
    const write = this.persistenceQueue.catch(() => undefined).then(async () => {
      const snapshot = await this.loadAll();
      const next: SubagentModelSettingsSnapshot = profile
        ? { ...snapshot, profiles: { ...snapshot.profiles, [profile]: setting } }
        : { ...snapshot, default: setting };
      await vscode.workspace.fs.createDirectory(this.directoryUri);
      await vscode.workspace.fs.writeFile(this.uri, this.encoder.encode(`${JSON.stringify(next, null, 2)}\n`));
    });
    this.persistenceQueue = write;
    await write;
    return setting;
  }
}

export function createDefaultSubagentModelSettingsSnapshot(): SubagentModelSettingsSnapshot {
  return { version: 2, default: createDefaultSubagentModelSetting(), profiles: {} };
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

export function normalizeSubagentModelSettingsSnapshot(value: unknown): SubagentModelSettingsSnapshot {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.profiles)) {
    return { version: 2, default: normalizeSubagentModelSetting(value), profiles: {} };
  }
  const profiles: Record<string, SubagentModelSetting> = {};
  for (const [id, setting] of Object.entries(value.profiles)) {
    const profile = normalizeProfileId(id);
    if (profile) profiles[profile] = normalizeSubagentModelSetting(setting);
  }
  return {
    version: 2,
    default: normalizeSubagentModelSetting(value.default),
    profiles
  };
}

function normalizeProfileId(value: string | undefined): string | undefined {
  const profile = value?.trim();
  return profile && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(profile) ? profile : undefined;
}

function readTimestamp(value: unknown): string {
  if (isRecord(value) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))) {
    return value.updatedAt;
  }
  return new Date(0).toISOString();
}
