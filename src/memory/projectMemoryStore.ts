import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredProjectMemoryStorageMode } from '../shared/config';
import type {
  ProjectMemory,
  ProjectMemoryCategory,
  ProjectMemoryEntry,
  ProjectMemorySource,
  ProjectMemoryStorageMode
} from '../shared/types';

const MEMORY_SCHEMA_VERSION = 1;
const WORKSPACE_MEMORY_DIRECTORY = '.keepseek';
const MEMORY_FILE_NAME = 'memory.json';
const GLOBAL_MEMORY_DIRECTORY = 'project-memory';

type ActualStorageMode = Exclude<ProjectMemoryStorageMode, 'auto' | 'disabled'>;

export interface ProjectMemoryStoreSnapshot {
  memory: ProjectMemory;
  configuredMode: ProjectMemoryStorageMode;
  actualMode?: ActualStorageMode;
  location?: string;
  error?: string;
}

export class ProjectMemoryStore {
  private snapshot: ProjectMemoryStoreSnapshot = {
    memory: createEmptyProjectMemory(),
    configuredMode: 'auto'
  };

  public constructor(private readonly globalStorageUri: vscode.Uri) {}

  public async load(): Promise<ProjectMemoryStoreSnapshot> {
    const configuredMode = getConfiguredProjectMemoryStorageMode();
    if (configuredMode === 'disabled') {
      this.snapshot = {
        memory: createEmptyProjectMemory(),
        configuredMode
      };
      return this.getSnapshot();
    }

    const workspaceUri = this.getWorkspaceMemoryUri();
    const globalUri = this.getGlobalMemoryUri();
    const candidates: Array<{ mode: ActualStorageMode; uri: vscode.Uri }> = configuredMode === 'global'
      ? [{ mode: 'global', uri: globalUri }]
      : configuredMode === 'workspace'
        ? workspaceUri
          ? [{ mode: 'workspace', uri: workspaceUri }, { mode: 'global', uri: globalUri }]
          : [{ mode: 'global', uri: globalUri }]
        : [
            ...(workspaceUri ? [{ mode: 'workspace' as const, uri: workspaceUri }] : []),
            { mode: 'global' as const, uri: globalUri }
          ];

    for (const candidate of candidates) {
      const loaded = await this.tryRead(candidate.uri);
      if (!loaded) {
        continue;
      }
      this.snapshot = {
        memory: loaded,
        configuredMode,
        actualMode: candidate.mode,
        location: candidate.uri.toString()
      };
      return this.getSnapshot();
    }

    const preferred = configuredMode === 'global' || !workspaceUri
      ? { mode: 'global' as const, uri: globalUri }
      : { mode: 'workspace' as const, uri: workspaceUri };
    this.snapshot = {
      memory: createEmptyProjectMemory(),
      configuredMode,
      actualMode: preferred.mode
    };
    return this.getSnapshot();
  }

  public async save(memory: ProjectMemory): Promise<ProjectMemoryStoreSnapshot> {
    const normalized = normalizeProjectMemory(memory);
    const configuredMode = getConfiguredProjectMemoryStorageMode();
    if (configuredMode === 'disabled') {
      throw new Error('Project Memory storage is disabled. Enable a storage mode before applying changes.');
    }

    const preferredUri = this.snapshot.actualMode === 'global'
      ? this.getGlobalMemoryUri()
      : this.getWorkspaceMemoryUri();
    const preferredMode = this.snapshot.actualMode ?? (configuredMode === 'global' ? 'global' : 'workspace');
    if (preferredUri) {
      try {
        await this.write(preferredUri, normalized);
        this.snapshot = {
          memory: normalized,
          configuredMode,
          actualMode: preferredMode,
          location: preferredUri.toString()
        };
        return this.getSnapshot();
      } catch (error) {
        if (preferredMode === 'global') {
          this.snapshot = {
            memory: normalized,
            configuredMode,
            actualMode: preferredMode,
            location: preferredUri.toString(),
            error: toErrorMessage(error)
          };
          throw error;
        }
      }
    }

    const fallbackUri = this.getGlobalMemoryUri();
    await this.write(fallbackUri, normalized);
    this.snapshot = {
      memory: normalized,
      configuredMode,
      actualMode: 'global',
      location: fallbackUri.toString(),
      error: preferredUri
        ? 'Workspace memory was not writable; using VS Code global storage.'
        : undefined
    };
    return this.getSnapshot();
  }

  public getSnapshot(): ProjectMemoryStoreSnapshot {
    return {
      ...this.snapshot,
      memory: cloneProjectMemory(this.snapshot.memory)
    };
  }

  private getWorkspaceMemoryUri(): vscode.Uri | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder
      ? vscode.Uri.joinPath(folder.uri, WORKSPACE_MEMORY_DIRECTORY, MEMORY_FILE_NAME)
      : undefined;
  }

  private getGlobalMemoryUri(): vscode.Uri {
    const workspaceKey = vscode.workspace.workspaceFile?.toString()
      ?? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join('|')
      ?? 'empty-workspace';
    const key = createHash('sha256').update(workspaceKey || 'empty-workspace').digest('hex').slice(0, 24);
    return vscode.Uri.joinPath(this.globalStorageUri, GLOBAL_MEMORY_DIRECTORY, key, MEMORY_FILE_NAME);
  }

  private async tryRead(uri: vscode.Uri): Promise<ProjectMemory | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return normalizeProjectMemory(parsed);
    } catch {
      return undefined;
    }
  }

  private async write(uri: vscode.Uri, memory: ProjectMemory): Promise<void> {
    const parentPath = uri.path.slice(0, Math.max(1, uri.path.lastIndexOf('/')));
    await vscode.workspace.fs.createDirectory(uri.with({ path: parentPath }));
    const content = `${JSON.stringify(memory, null, 2)}\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }
}

export function createEmptyProjectMemory(now = new Date().toISOString()): ProjectMemory {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAt: now,
    entries: []
  };
}

export function normalizeProjectMemory(value: unknown): ProjectMemory {
  if (!isRecord(value)) {
    return createEmptyProjectMemory();
  }
  const entries = Array.isArray(value.entries)
    ? value.entries.map(normalizeProjectMemoryEntry).filter((entry): entry is ProjectMemoryEntry => Boolean(entry))
    : [];
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    updatedAt: normalizeTimestamp(value.updatedAt),
    entries
  };
}

function normalizeProjectMemoryEntry(value: unknown): ProjectMemoryEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }
  const id = value.id.trim();
  const content = value.content.replace(/\s+/gu, ' ').trim().slice(0, 2_000);
  if (!id || !content) {
    return undefined;
  }
  const category = normalizeCategory(value.category);
  const source = normalizeSource(value.source);
  const confidence = Number(value.confidence);
  const tags = Array.isArray(value.tags)
    ? Array.from(new Set(value.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, 64))
      .filter(Boolean)))
      .slice(0, 20)
    : [];
  const createdAt = normalizeTimestamp(value.createdAt);
  return {
    id,
    category,
    content,
    source,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1,
    tags,
    enabled: value.enabled !== false,
    createdAt,
    updatedAt: normalizeTimestamp(value.updatedAt, createdAt)
  };
}

function normalizeCategory(value: unknown): ProjectMemoryCategory {
  const categories: ProjectMemoryCategory[] = [
    'architecture',
    'preference',
    'command',
    'testing',
    'restriction',
    'project_note',
    'workflow'
  ];
  return categories.includes(value as ProjectMemoryCategory)
    ? value as ProjectMemoryCategory
    : 'project_note';
}

function normalizeSource(value: unknown): ProjectMemorySource {
  return value === 'user' || value === 'agent_suggestion' || value === 'manual'
    ? value
    : 'manual';
}

function normalizeTimestamp(value: unknown, fallback = new Date().toISOString()): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return new Date(value).toISOString();
}

function cloneProjectMemory(memory: ProjectMemory): ProjectMemory {
  return {
    ...memory,
    entries: memory.entries.map((entry) => ({ ...entry, tags: [...entry.tags] }))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
