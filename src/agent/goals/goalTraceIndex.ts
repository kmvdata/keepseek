import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredInteractionTraceSettings, type InteractionTraceLevel } from '../../shared/config';
import { stableStringify } from '../evidence/shaping';
import type { GoalTraceSummaryV1 } from './goalTypes';

const MAX_TRACE_REFERENCES_PER_GOAL = 200;
const MAX_TRACE_REFERENCES_TOTAL = 2_000;

export interface GoalTraceReferenceV1 extends GoalTraceSummaryV1 {
  goalId: string;
  runId: string;
  traceUri: string;
}

export interface GoalTraceIndexV1 {
  version: 1;
  entries: GoalTraceReferenceV1[];
}

/** Host-only discovery index for existing InteractionTrace JSONL files. The
 * index never enters Goal contracts, checkpoints, replay, or chat messages. */
export class GoalTraceIndexStore {
  private readonly uri: vscode.Uri;
  private index: GoalTraceIndexV1 = { version: 1, entries: [] };
  private initialized = false;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(globalStorageUri: vscode.Uri) {
    this.uri = vscode.Uri.joinPath(globalStorageUri, 'goals', 'v1', 'trace-index.json');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    let needsPersist = false;
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri);
      this.index = normalizeIndex(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT' && !/not found|enoent/iu.test(String(error))) {
        this.index = { version: 1, entries: [] };
        needsPersist = true;
      }
    }
    const beforePrune = this.index.entries.length;
    this.prune();
    this.initialized = true;
    if (needsPersist || this.index.entries.length !== beforePrune) await this.persist();
  }

  public list(goalId: string): GoalTraceSummaryV1[] {
    return this.index.entries.filter((entry) => entry.goalId === goalId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.attempt - right.attempt)
      .map(({ id, kind, attempt, createdAt, level }) => ({ id, kind, attempt, createdAt, level }));
  }

  public resolve(goalId: string, id: string): GoalTraceReferenceV1 | undefined {
    const entry = this.index.entries.find((item) => item.goalId === goalId && item.id === id);
    return entry ? structuredClone(entry) : undefined;
  }

  public async register(input: {
    goalId: string;
    runId: string;
    traceUri: string;
    kind: GoalTraceReferenceV1['kind'];
    attempt: number;
    level: InteractionTraceLevel;
    createdAt?: string;
  }): Promise<GoalTraceSummaryV1> {
    await this.initialize();
    const entry: GoalTraceReferenceV1 = {
      id: createHash('sha256').update(
        `${input.goalId}:${input.runId}:${input.traceUri}:${input.kind}:${Math.max(0, Math.floor(input.attempt))}`,
        'utf8'
      ).digest('hex').slice(0, 24),
      goalId: input.goalId,
      runId: input.runId,
      traceUri: input.traceUri,
      kind: input.kind,
      attempt: Math.max(0, Math.floor(input.attempt)),
      createdAt: input.createdAt ?? new Date().toISOString(),
      level: input.level
    };
    this.index.entries = [...this.index.entries.filter((item) => item.id !== entry.id), entry];
    this.prune();
    await this.persist();
    return { id: entry.id, kind: entry.kind, attempt: entry.attempt, createdAt: entry.createdAt, level: entry.level };
  }

  public async removeGoal(goalId: string): Promise<void> {
    await this.initialize();
    const next = this.index.entries.filter((entry) => entry.goalId !== goalId);
    if (next.length === this.index.entries.length) return;
    this.index.entries = next;
    await this.persist();
  }

  private prune(): void {
    const retentionMs = getConfiguredInteractionTraceSettings().retentionDays * 24 * 60 * 60 * 1_000;
    const cutoff = Date.now() - retentionMs;
    const recent = this.index.entries.filter((entry) => {
      const timestamp = Date.parse(entry.createdAt);
      return !Number.isFinite(timestamp) || timestamp >= cutoff;
    });
    const byGoal = new Map<string, GoalTraceReferenceV1[]>();
    for (const entry of recent) {
      const entries = byGoal.get(entry.goalId) ?? [];
      entries.push(entry);
      byGoal.set(entry.goalId, entries);
    }
    this.index.entries = [...byGoal.values()].flatMap((entries) => entries
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MAX_TRACE_REFERENCES_PER_GOAL))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-MAX_TRACE_REFERENCES_TOTAL);
  }

  private async persist(): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const parent = vscode.Uri.joinPath(this.uri, '..');
      const temporary = vscode.Uri.joinPath(parent, `.trace-index-${randomUUID()}.tmp`);
      await vscode.workspace.fs.createDirectory(parent);
      try {
        await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(stableStringify(this.index)));
        await vscode.workspace.fs.rename(temporary, this.uri, { overwrite: true });
      } finally {
        await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).catch(() => undefined);
      }
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }
}

function normalizeIndex(value: unknown): GoalTraceIndexV1 {
  const index = value as GoalTraceIndexV1;
  if (!index || index.version !== 1 || !Array.isArray(index.entries)) throw new Error('Unsupported Goal trace index.');
  const entries = index.entries.filter((entry) => entry && typeof entry === 'object'
    && typeof entry.id === 'string' && typeof entry.goalId === 'string' && typeof entry.runId === 'string'
    && typeof entry.traceUri === 'string' && typeof entry.createdAt === 'string'
    && Number.isSafeInteger(entry.attempt) && entry.attempt >= 0
    && ['start', 'resume', 'attempt', 'completion_review', 'approval'].includes(entry.kind)
    && ['metadata', 'request', 'full'].includes(entry.level));
  return { version: 1, entries: structuredClone(entries) };
}
