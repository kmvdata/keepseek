import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import type {
  DraftEdit,
  LegacyProjectMemoryContext,
  LegacyProjectMemoryMigrationStateView,
  LegacyProjectMemoryMigrationStatus
} from '../shared/types';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import { estimateTokenCount } from '../agent/tokenEstimate';
import {
  LegacyProjectMemoryEntry,
  normalizeLegacyProjectMemory
} from './legacyProjectMemoryFormat';

const MIGRATION_STATE_KEY = 'keepseek.legacyProjectMemoryMigration.v1';
const LEGACY_MEMORY_DIRECTORY = '.keepseek';
const LEGACY_MEMORY_FILE = 'memory.json';
const GLOBAL_MEMORY_DIRECTORY = 'project-memory';
const LEGACY_CONTEXT_BUDGET_TOKENS = 1_200;

interface StoredMigrationState {
  workspaces?: Record<string, {
    status?: LegacyProjectMemoryMigrationStatus;
    lastDraftChangeSetId?: string;
  }>;
}

interface LegacyMemorySource {
  uri: vscode.Uri;
  workspaceFolder?: vscode.WorkspaceFolder;
  entries: LegacyProjectMemoryEntry[];
}

export interface LegacyMemoryMigrationDraft {
  edits: DraftEdit[];
  exportText: string;
  sourceUris: string[];
  entryCount: number;
}

export class LegacyProjectMemoryMigration {
  private sources: LegacyMemorySource[] = [];
  private error: string | undefined;

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly storage: vscode.Memento,
    private readonly getWorkspaceKey: () => string
  ) {}

  public async refresh(): Promise<void> {
    const sources: LegacyMemorySource[] = [];
    const maxBytes = getConfiguredMaxFileBytes();
    try {
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const uri = vscode.Uri.joinPath(folder.uri, LEGACY_MEMORY_DIRECTORY, LEGACY_MEMORY_FILE);
        const entries = await readLegacyEntries(uri, maxBytes);
        if (entries.length) {
          sources.push({ uri, workspaceFolder: folder, entries });
        }
      }
      const globalUri = this.getGlobalMemoryUri();
      const globalEntries = await readLegacyEntries(globalUri, maxBytes);
      if (globalEntries.length) {
        sources.push({ uri: globalUri, entries: globalEntries });
      }
      this.sources = sources;
      this.error = undefined;
    } catch (error) {
      this.sources = sources;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  public getStateView(): LegacyProjectMemoryMigrationStateView {
    const stored = this.getStoredWorkspaceState();
    const detected = this.sources.some((source) => source.entries.length > 0);
    const status = stored.status ?? 'pending';
    return {
      detected,
      status,
      sourceUris: this.sources.map((source) => source.uri.toString()),
      entryCount: dedupeEntries(this.sources.flatMap((source) => source.entries)).length,
      canCreateDraft: detected && status === 'pending',
      canComplete: detected && status === 'draft-created',
      canRollback: detected && status === 'completed',
      exportAvailable: detected,
      lastDraftChangeSetId: stored.lastDraftChangeSetId,
      error: this.error
    };
  }

  public createReadonlyContext(prompt: string): LegacyProjectMemoryContext | undefined {
    if (this.getStateView().status === 'completed') {
      return undefined;
    }
    const entries = dedupeEntries(this.sources.flatMap((source) => source.entries))
      .filter((entry) => entry.enabled && !containsCredentialShape(entry.content));
    if (!entries.length) {
      return undefined;
    }
    const terms = new Set(tokenize(prompt));
    const ranked = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
    const lines: string[] = [];
    const entryIds: string[] = [];
    for (const { entry } of ranked) {
      const line = `- [${entry.category}] ${entry.content}`;
      const candidate = [...lines, line].join('\n');
      if (estimateTokenCount(candidate) > LEGACY_CONTEXT_BUDGET_TOKENS) {
        continue;
      }
      lines.push(line);
      entryIds.push(entry.id);
    }
    const content = lines.join('\n');
    return content
      ? {
          content,
          entryIds,
          tokenEstimate: estimateTokenCount(content),
          sourceUris: this.sources.map((source) => source.uri.toString())
        }
      : undefined;
  }

  public async createDraft(): Promise<LegacyMemoryMigrationDraft> {
    const state = this.getStateView();
    if (!state.detected) {
      return { edits: [], exportText: '', sourceUris: [], entryCount: 0 };
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const firstFolder = folders[0];
    const entriesByFolder = new Map<string, LegacyProjectMemoryEntry[]>();
    for (const source of this.sources) {
      const targetFolder = source.workspaceFolder ?? firstFolder;
      if (!targetFolder) {
        continue;
      }
      const key = targetFolder.uri.toString();
      const existing = entriesByFolder.get(key) ?? [];
      existing.push(...source.entries.filter((entry) => !containsCredentialShape(entry.content)));
      entriesByFolder.set(key, existing);
    }

    const edits: DraftEdit[] = [];
    for (const folder of folders) {
      const entries = dedupeEntries(entriesByFolder.get(folder.uri.toString()) ?? []);
      if (!entries.length) {
        continue;
      }
      const projectEntries = entries.filter((entry) => shouldMigrateToAgents(entry));
      const workflowEntries = entries.filter((entry) => shouldMigrateToWorkflowSkill(entry));
      if (projectEntries.length) {
        edits.push(await this.createAgentsDraft(folder, projectEntries));
      }
      if (workflowEntries.length) {
        const workflowDraft = await this.createWorkflowSkillDraft(folder, workflowEntries);
        if (workflowDraft) {
          edits.push(workflowDraft);
        }
      }
    }

    const allEntries = dedupeEntries(this.sources.flatMap((source) => source.entries));
    return {
      edits,
      exportText: renderLegacyMemoryExport(allEntries),
      sourceUris: state.sourceUris,
      entryCount: allEntries.length
    };
  }

  public async markDraftCreated(changeSetId?: string): Promise<void> {
    await this.updateStoredWorkspaceState({ status: 'draft-created', lastDraftChangeSetId: changeSetId });
  }

  public async complete(): Promise<void> {
    await this.updateStoredWorkspaceState({
      ...this.getStoredWorkspaceState(),
      status: 'completed'
    });
  }

  public async rollback(): Promise<void> {
    await this.updateStoredWorkspaceState({
      ...this.getStoredWorkspaceState(),
      status: 'pending'
    });
  }

  public async getExportText(): Promise<string> {
    return renderLegacyMemoryExport(dedupeEntries(this.sources.flatMap((source) => source.entries)));
  }

  private async createAgentsDraft(
    folder: vscode.WorkspaceFolder,
    entries: LegacyProjectMemoryEntry[]
  ): Promise<DraftEdit> {
    const targetUri = vscode.Uri.joinPath(folder.uri, 'AGENTS.md');
    const existing = await readOptionalTextFile(targetUri, getConfiguredMaxFileBytes());
    const section = renderAgentsMigrationSection(entries);
    const newText = existing
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
    return {
      id: randomUUID(),
      uri: targetUri.toString(),
      label: `${folder.name}/AGENTS.md`,
      action: existing === undefined ? 'create' : 'modify',
      newText,
      reason: 'Migrate reviewed Legacy Project Memory rules into AGENTS.md without deleting the legacy source.'
    };
  }

  private async createWorkflowSkillDraft(
    folder: vscode.WorkspaceFolder,
    entries: LegacyProjectMemoryEntry[]
  ): Promise<DraftEdit | undefined> {
    const skillsRoot = vscode.Uri.joinPath(folder.uri, '.agents', 'skills');
    const names = ['legacy-project-workflow', ...Array.from({ length: 20 }, (_, index) => `legacy-project-workflow-${index + 2}`)];
    for (const name of names) {
      const targetUri = vscode.Uri.joinPath(skillsRoot, name, 'SKILL.md');
      if (await uriExists(targetUri)) {
        continue;
      }
      return {
        id: randomUUID(),
        uri: targetUri.toString(),
        label: `${folder.name}/.agents/skills/${name}/SKILL.md`,
        action: 'create',
        newText: renderWorkflowSkill(name, entries),
        reason: 'Migrate reviewed Legacy Project Memory commands and workflows into a Codex-compatible Skill.'
      };
    }
    return undefined;
  }

  private getGlobalMemoryUri(): vscode.Uri {
    const workspaceKey = vscode.workspace.workspaceFile?.toString()
      ?? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join('|')
      ?? 'empty-workspace';
    const key = createHash('sha256').update(workspaceKey || 'empty-workspace').digest('hex').slice(0, 24);
    return vscode.Uri.joinPath(this.globalStorageUri, GLOBAL_MEMORY_DIRECTORY, key, LEGACY_MEMORY_FILE);
  }

  private getStoredWorkspaceState(): NonNullable<StoredMigrationState['workspaces']>[string] {
    return this.storage.get<StoredMigrationState>(MIGRATION_STATE_KEY, {}).workspaces?.[this.getWorkspaceKey()] ?? {};
  }

  private async updateStoredWorkspaceState(
    next: NonNullable<StoredMigrationState['workspaces']>[string]
  ): Promise<void> {
    const stored = this.storage.get<StoredMigrationState>(MIGRATION_STATE_KEY, {});
    await this.storage.update(MIGRATION_STATE_KEY, {
      workspaces: {
        ...(stored.workspaces ?? {}),
        [this.getWorkspaceKey()]: next
      }
    } satisfies StoredMigrationState);
  }
}

async function readLegacyEntries(uri: vscode.Uri, maxBytes: number): Promise<LegacyProjectMemoryEntry[]> {
  const content = await readOptionalTextFile(uri, maxBytes);
  if (!content) {
    return [];
  }
  try {
    return normalizeLegacyProjectMemory(JSON.parse(content)).entries;
  } catch {
    return [];
  }
}

async function readOptionalTextFile(uri: vscode.Uri, maxBytes: number): Promise<string | undefined> {
  if (shouldSkipTextUri(uri)) {
    return undefined;
  }
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > maxBytes) {
      return undefined;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) {
      return undefined;
    }
    const content = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/\r\n?/gu, '\n');
    return isReadableTextContent(content) ? content : undefined;
  } catch {
    return undefined;
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
  } catch {
    return false;
  }
}

function dedupeEntries(entries: readonly LegacyProjectMemoryEntry[]): LegacyProjectMemoryEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = createHash('sha256').update(`${entry.category}\n${entry.content.trim()}`).digest('hex');
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function shouldMigrateToAgents(entry: LegacyProjectMemoryEntry): boolean {
  return entry.category === 'architecture'
    || entry.category === 'restriction'
    || entry.category === 'project_note'
    || ((entry.category === 'testing' || entry.category === 'command') && !looksLikeReusableWorkflow(entry.content));
}

function shouldMigrateToWorkflowSkill(entry: LegacyProjectMemoryEntry): boolean {
  return entry.category === 'workflow'
    || ((entry.category === 'testing' || entry.category === 'command') && looksLikeReusableWorkflow(entry.content));
}

function looksLikeReusableWorkflow(content: string): boolean {
  return /(?:npm|pnpm|yarn|bun|test|lint|compile|build|先.+再|步骤|流程|workflow|before|after|then)/iu.test(content);
}

function renderAgentsMigrationSection(entries: readonly LegacyProjectMemoryEntry[]): string {
  return [
    '## Migrated Legacy KeepSeek Rules',
    '',
    '> Review this proposed section before applying. The original Legacy Project Memory file is intentionally retained.',
    '',
    ...entries.map((entry) => `- [${entry.category}] ${entry.content}`)
  ].join('\n');
}

function renderWorkflowSkill(name: string, entries: readonly LegacyProjectMemoryEntry[]): string {
  return [
    '---',
    `name: ${name}`,
    'description: Migrated project commands, testing steps, and workflow conventions from Legacy KeepSeek Project Memory.',
    'metadata:',
    '  keepseek:',
    '    allowImplicit: false',
    '    userInvocable: true',
    '---',
    '',
    `# ${name}`,
    '',
    '## Instructions',
    '',
    ...entries.map((entry) => `- [${entry.category}] ${entry.content}`),
    '',
    'Skill scripts are not executed by KeepSeek.'
  ].join('\n');
}

export function renderLegacyMemoryExport(entries: readonly LegacyProjectMemoryEntry[]): string {
  const safeEntries = entries.filter((entry) => !containsCredentialShape(entry.content));
  const omittedCredentialEntries = entries.length - safeEntries.length;
  const preferences = safeEntries.filter((entry) => entry.category === 'preference');
  return [
    '# Legacy KeepSeek Project Memory Export',
    '',
    'This export does not delete or modify the original memory files.',
    '',
    '## Suggested project migration',
    '',
    ...safeEntries.filter((entry) => entry.category !== 'preference')
      .map((entry) => `- [${entry.category}] ${entry.content}`),
    ...(omittedCredentialEntries
      ? ['', `> ${omittedCredentialEntries} credential-shaped legacy entry or entries were omitted. Review the retained source file locally.`]
      : []),
    '',
    '## Suggested personal Codex Skill',
    '',
    'After reviewing, copy this template to `~/.codex/skills/keepseek-personal-preferences/SKILL.md`. KeepSeek does not write to your home directory:',
    '',
    '```markdown',
    '---',
    'name: keepseek-personal-preferences',
    'description: Personal coding preferences migrated from Legacy KeepSeek Project Memory.',
    'metadata:',
    '  keepseek:',
    '    allowImplicit: false',
    '    userInvocable: true',
    '---',
    '',
    '# Personal preferences',
    '',
    ...(preferences.length ? preferences.map((entry) => `- ${entry.content}`) : ['- No Legacy preference entries were found.']),
    '```'
  ].join('\n').trim();
}

function tokenize(value: string): string[] {
  return value.normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}_./-]+/u).filter((term) => term.length > 1);
}

function scoreEntry(entry: LegacyProjectMemoryEntry, promptTerms: Set<string>): number {
  const haystack = new Set(tokenize(`${entry.category} ${entry.tags.join(' ')} ${entry.content}`));
  let score = entry.category === 'restriction' || entry.category === 'architecture' ? 3 : 1;
  for (const term of promptTerms) {
    if (haystack.has(term)) {
      score += term.length > 5 ? 3 : 1;
    }
  }
  return score;
}

function containsCredentialShape(content: string): boolean {
  return /(?:api[_ -]?key|authorization|bearer|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|client[_ -]?secret)\s*[:=]\s*\S+/iu.test(content)
    || /(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u.test(content);
}
