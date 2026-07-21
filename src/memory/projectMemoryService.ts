import { randomUUID } from 'node:crypto';
import { getConfiguredProjectMemoryContextBudgetTokens } from '../shared/config';
import type {
  ProjectMemory,
  ProjectMemoryCategory,
  ProjectMemoryContext,
  ProjectMemoryEntry,
  ProjectMemorySource,
  ProjectMemoryStateView,
  ProjectMemoryUpdate
} from '../shared/types';
import { estimateTokenCount } from '../agent/tokenEstimate';
import { ProjectMemoryStore } from './projectMemoryStore';

const MAX_MEMORY_CONTENT_CHARS = 2_000;
const MAX_PENDING_UPDATES = 20;
const SENSITIVE_MEMORY_PATTERN = /(?:api[_ -]?key|authorization|bearer|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|client[_ -]?secret)\s*[:=]\s*\S+/iu;
const CREDENTIAL_SHAPED_PATTERN = /(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const CREDENTIAL_URI_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^@\s]+@/iu;

export class ProjectMemoryService {
  private memory: ProjectMemory = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    entries: []
  };
  private pendingUpdates: ProjectMemoryUpdate[] = [];
  private stateView: ProjectMemoryStateView = {
    configuredMode: 'auto',
    entries: [],
    pendingUpdates: []
  };

  public constructor(private readonly store: ProjectMemoryStore) {}

  public async initialize(): Promise<void> {
    const snapshot = await this.store.load();
    this.memory = snapshot.memory;
    this.updateStateView(snapshot.error);
  }

  public async refresh(): Promise<void> {
    await this.initialize();
  }

  public getStateView(): ProjectMemoryStateView {
    return {
      ...this.stateView,
      entries: this.stateView.entries.map(cloneEntry),
      pendingUpdates: this.stateView.pendingUpdates.map(cloneUpdate)
    };
  }

  public createContext(prompt: string): ProjectMemoryContext | undefined {
    const snapshot = this.store.getSnapshot();
    if (!snapshot.actualMode || snapshot.configuredMode === 'disabled') {
      return undefined;
    }
    const budgetTokens = getConfiguredProjectMemoryContextBudgetTokens();
    if (budgetTokens <= 0) {
      return undefined;
    }
    const normalizedPrompt = normalizeSearchText(prompt);
    const terms = new Set(normalizedPrompt.split(/[^\p{L}\p{N}_./-]+/u).filter((term) => term.length > 1));
    const ranked = this.memory.entries
      .filter((entry) => entry.enabled)
      .map((entry) => ({ entry, score: scoreEntry(entry, normalizedPrompt, terms) }))
      .sort((left, right) => right.score - left.score || right.entry.updatedAt.localeCompare(left.entry.updatedAt));
    const selected: ProjectMemoryEntry[] = [];
    let content = '';
    for (const { entry } of ranked) {
      const line = `- [${entry.category}] ${entry.content}`;
      const next = content ? `${content}\n${line}` : line;
      if (estimateTokenCount(next) > budgetTokens) {
        continue;
      }
      selected.push(entry);
      content = next;
    }
    if (!selected.length) {
      return undefined;
    }
    return {
      content,
      entryIds: selected.map((entry) => entry.id),
      tokenEstimate: estimateTokenCount(content),
      storageMode: snapshot.actualMode
    };
  }

  public suggestFromPrompt(prompt: string): ProjectMemoryUpdate[] {
    const normalized = prompt.replace(/\s+/gu, ' ').trim();
    if (!normalized || containsSensitiveMaterial(normalized)) {
      return [];
    }
    const suggestions: ProjectMemoryUpdate[] = [];
    if (/(?:忘记|删除.{0,8}记忆|不要再记|forget|remove (?:this )?memory)/iu.test(normalized)) {
      const target = this.findBestForgetTarget(normalized);
      if (target) {
        suggestions.push(this.proposeDelete(target.id, 'Explicit request to forget project memory.', 'agent_suggestion'));
      }
      return suggestions.filter(Boolean);
    }
    if (!/(?:记住|以后(?:都|请)|今后(?:都|请)|不要再碰|始终|务必|remember|from now on|always|never touch)/iu.test(normalized)) {
      return [];
    }
    const content = normalized.slice(0, MAX_MEMORY_CONTENT_CHARS);
    suggestions.push(this.proposeAdd({
      content,
      category: inferCategory(content),
      source: 'agent_suggestion',
      confidence: 0.92,
      tags: inferTags(content)
    }, 'The current request explicitly asks KeepSeek to remember this for the project.'));
    return suggestions;
  }

  public proposeAdd(input: {
    content: string;
    category: ProjectMemoryCategory;
    source?: ProjectMemorySource;
    confidence?: number;
    tags?: string[];
  }, reason = 'User proposed a new project memory.'): ProjectMemoryUpdate {
    const content = normalizeMemoryContent(input.content);
    assertSafeMemoryContent(content);
    const now = new Date().toISOString();
    const entry: ProjectMemoryEntry = {
      id: randomUUID(),
      category: normalizeMemoryCategory(input.category),
      content,
      source: input.source ?? 'manual',
      confidence: clampConfidence(input.confidence),
      tags: normalizeTags(input.tags),
      enabled: true,
      createdAt: now,
      updatedAt: now
    };
    return this.enqueue({
      id: randomUUID(),
      action: 'add',
      proposedEntry: entry,
      reason,
      source: input.source ?? 'manual',
      createdAt: now
    });
  }

  public proposeUpdate(
    entryId: string,
    input: { content: string; category: ProjectMemoryCategory; tags?: string[] },
    reason = 'User proposed editing project memory.'
  ): ProjectMemoryUpdate {
    const previous = this.requireEntry(entryId);
    const content = normalizeMemoryContent(input.content);
    assertSafeMemoryContent(content);
    const proposed: ProjectMemoryEntry = {
      ...previous,
      category: normalizeMemoryCategory(input.category),
      content,
      tags: normalizeTags(input.tags),
      updatedAt: new Date().toISOString()
    };
    return this.enqueue({
      id: randomUUID(),
      action: 'update',
      entryId: previous.id,
      previousEntry: previous,
      proposedEntry: proposed,
      reason,
      source: 'manual',
      createdAt: new Date().toISOString()
    });
  }

  public proposeDelete(
    entryId: string,
    reason = 'User proposed deleting project memory.',
    source: ProjectMemorySource = 'manual'
  ): ProjectMemoryUpdate {
    const previous = this.requireEntry(entryId);
    return this.enqueue({
      id: randomUUID(),
      action: 'delete',
      entryId: previous.id,
      previousEntry: previous,
      reason,
      source,
      createdAt: new Date().toISOString()
    });
  }

  public proposeToggle(entryId: string, enabled: boolean): ProjectMemoryUpdate {
    const previous = this.requireEntry(entryId);
    return this.enqueue({
      id: randomUUID(),
      action: enabled ? 'enable' : 'disable',
      entryId: previous.id,
      previousEntry: previous,
      proposedEntry: { ...previous, enabled, updatedAt: new Date().toISOString() },
      reason: enabled ? 'User proposed enabling project memory.' : 'User proposed disabling project memory.',
      source: 'manual',
      createdAt: new Date().toISOString()
    });
  }

  public async applyUpdate(updateId: string): Promise<ProjectMemoryUpdate> {
    const update = this.requirePendingUpdate(updateId);
    const nextMemory: ProjectMemory = {
      ...this.memory,
      entries: this.memory.entries.map(cloneEntry)
    };
    switch (update.action) {
      case 'add':
        if (update.proposedEntry) {
          nextMemory.entries.push(cloneEntry(update.proposedEntry));
        }
        break;
      case 'update':
      case 'enable':
      case 'disable': {
        const index = nextMemory.entries.findIndex((entry) => entry.id === update.entryId);
        if (index >= 0 && update.proposedEntry) {
          nextMemory.entries[index] = cloneEntry(update.proposedEntry);
        }
        break;
      }
      case 'delete':
        nextMemory.entries = nextMemory.entries.filter((entry) => entry.id !== update.entryId);
        break;
    }
    nextMemory.updatedAt = new Date().toISOString();
    await this.store.save(nextMemory);
    this.memory = nextMemory;
    this.pendingUpdates = this.pendingUpdates.filter((item) => item.id !== updateId);
    this.updateStateView();
    return cloneUpdate(update);
  }

  public rejectUpdate(updateId: string): ProjectMemoryUpdate {
    const update = this.requirePendingUpdate(updateId);
    this.pendingUpdates = this.pendingUpdates.filter((item) => item.id !== updateId);
    this.updateStateView();
    return cloneUpdate(update);
  }

  private enqueue(update: ProjectMemoryUpdate): ProjectMemoryUpdate {
    const duplicate = this.pendingUpdates.find((item) =>
      item.action === update.action
      && item.entryId === update.entryId
      && item.proposedEntry?.content === update.proposedEntry?.content);
    if (duplicate) {
      return cloneUpdate(duplicate);
    }
    this.pendingUpdates.unshift(update);
    this.pendingUpdates = this.pendingUpdates.slice(0, MAX_PENDING_UPDATES);
    this.updateStateView();
    return cloneUpdate(update);
  }

  private requireEntry(entryId: string): ProjectMemoryEntry {
    const entry = this.memory.entries.find((item) => item.id === entryId);
    if (!entry) {
      throw new Error('Project Memory entry was not found.');
    }
    return cloneEntry(entry);
  }

  private requirePendingUpdate(updateId: string): ProjectMemoryUpdate {
    const update = this.pendingUpdates.find((item) => item.id === updateId);
    if (!update) {
      throw new Error('Pending Project Memory change was not found.');
    }
    return update;
  }

  private findBestForgetTarget(prompt: string): ProjectMemoryEntry | undefined {
    const normalized = normalizeSearchText(prompt)
      .replace(/(?:忘记|删除|这条|记忆|不要再记|forget|remove|this|memory)/giu, ' ');
    const terms = new Set(normalized.split(/[^\p{L}\p{N}_./-]+/u).filter((term) => term.length > 1));
    return this.memory.entries
      .map((entry) => ({ entry, score: scoreEntry(entry, normalized, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)[0]?.entry;
  }

  private updateStateView(error?: string): void {
    const snapshot = this.store.getSnapshot();
    this.stateView = {
      configuredMode: snapshot.configuredMode,
      actualMode: snapshot.actualMode,
      location: snapshot.location,
      entries: this.memory.entries.map(cloneEntry),
      pendingUpdates: this.pendingUpdates.map(cloneUpdate),
      error: error ?? snapshot.error
    };
  }
}

export function containsSensitiveMaterial(content: string): boolean {
  return SENSITIVE_MEMORY_PATTERN.test(content)
    || CREDENTIAL_SHAPED_PATTERN.test(content)
    || CREDENTIAL_URI_PATTERN.test(content);
}

function assertSafeMemoryContent(content: string): void {
  if (!content) {
    throw new Error('Project Memory content cannot be empty.');
  }
  if (containsSensitiveMaterial(content)) {
    throw new Error('Project Memory cannot store API keys, tokens, passwords, secrets, or private credentials.');
  }
}

function normalizeMemoryContent(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, MAX_MEMORY_CONTENT_CHARS);
}

function normalizeTags(tags: string[] | undefined): string[] {
  return Array.from(new Set((tags ?? [])
    .map((tag) => String(tag).trim().toLocaleLowerCase().slice(0, 64))
    .filter(Boolean)))
    .slice(0, 20);
}

function normalizeMemoryCategory(value: ProjectMemoryCategory): ProjectMemoryCategory {
  return value === 'architecture'
    || value === 'preference'
    || value === 'command'
    || value === 'testing'
    || value === 'restriction'
    || value === 'workflow'
    ? value
    : 'project_note';
}

function clampConfidence(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1, Math.max(0, value))
    : 1;
}

function inferCategory(content: string): ProjectMemoryCategory {
  if (/(?:不要|禁止|不得|别碰|never|do not|forbid)/iu.test(content)) return 'restriction';
  if (/(?:test|测试|lint|compile|验证)/iu.test(content)) return 'testing';
  if (/(?:npm|pnpm|yarn|命令|command)/iu.test(content)) return 'command';
  if (/(?:架构|模块|分层|architecture)/iu.test(content)) return 'architecture';
  if (/(?:流程|workflow|习惯|每次|以后)/iu.test(content)) return 'workflow';
  return 'preference';
}

function inferTags(content: string): string[] {
  const tags: string[] = [];
  if (/(?:test|测试)/iu.test(content)) tags.push('testing');
  if (/(?:lint)/iu.test(content)) tags.push('lint');
  if (/(?:compile|编译)/iu.test(content)) tags.push('compile');
  if (/(?:目录|文件|directory|folder|file)/iu.test(content)) tags.push('files');
  return tags;
}

function scoreEntry(entry: ProjectMemoryEntry, normalizedPrompt: string, terms: Set<string>): number {
  const haystack = normalizeSearchText(`${entry.category} ${entry.tags.join(' ')} ${entry.content}`);
  let score = entry.confidence * 2;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length > 5 ? 3 : 1;
    }
  }
  if (normalizedPrompt && haystack.includes(normalizedPrompt)) {
    score += 8;
  }
  if (entry.category === 'restriction' || entry.category === 'architecture') {
    score += 1.5;
  }
  return score;
}

function normalizeSearchText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function cloneEntry(entry: ProjectMemoryEntry): ProjectMemoryEntry {
  return { ...entry, tags: [...entry.tags] };
}

function cloneUpdate(update: ProjectMemoryUpdate): ProjectMemoryUpdate {
  return {
    ...update,
    previousEntry: update.previousEntry ? cloneEntry(update.previousEntry) : undefined,
    proposedEntry: update.proposedEntry ? cloneEntry(update.proposedEntry) : undefined
  };
}
