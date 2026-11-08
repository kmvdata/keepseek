import { createHash } from 'node:crypto';
import type { ContextUsageEstimate, TaskContextUsageOrigin, TaskContextUsageSnapshot } from '../shared/types';
import type { ProjectTaskCard, TaskDefaultsSnapshot } from './projectTasks';

/** Credential-free equality key. Endpoint auth/query/hash never enter metadata. */
export function taskUsageLaneFingerprint(snapshot: TaskDefaultsSnapshot): string {
  let endpoint = '';
  try { const url = new URL(snapshot.endpoint ?? ''); endpoint = `${url.protocol}//${url.host}${url.pathname}`; } catch { /* unknown endpoint */ }
  return taskUsageFingerprint({ sourceId: snapshot.sourceId, modelId: snapshot.modelId, wireModel: snapshot.wireModel,
    endpoint, protocol: snapshot.protocol, settings: snapshot.configuration?.settings, model: snapshot.configuration?.model });
}

export function taskUsageFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validOrigin(value: TaskContextUsageOrigin): boolean {
  return !!value?.identity && ['projectId', 'taskCardId', 'sessionId', 'rootTaskId', 'segmentId', 'hostId', 'runtimeId']
    .every(key => typeof value.identity[key as keyof typeof value.identity] === 'string' && value.identity[key as keyof typeof value.identity] !== '')
    && Number.isSafeInteger(value.identity.generation) && value.identity.generation >= 0
    && Number.isSafeInteger(value.projectionRevision) && value.projectionRevision > 0
    && typeof value.laneFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.laneFingerprint)
    && typeof value.configurationFingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.configurationFingerprint)
    && typeof value.capturedAt === 'string' && Number.isFinite(Date.parse(value.capturedAt));
}

export function normalizeTaskUsageSnapshot(value: unknown): TaskContextUsageSnapshot | undefined {
  const snapshot = value as TaskContextUsageSnapshot;
  if (!snapshot || snapshot.version !== 1 || !validOrigin(snapshot) || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence <= 0
    || typeof snapshot.recordedAt !== 'string' || !Number.isFinite(Date.parse(snapshot.recordedAt)) || !validTaskUsage(snapshot.usage)) return undefined;
  const identity = snapshot.identity;
  return { version: 1, identity: { projectId: identity.projectId, taskCardId: identity.taskCardId,
    sessionId: identity.sessionId, rootTaskId: identity.rootTaskId, segmentId: identity.segmentId,
    generation: identity.generation, hostId: identity.hostId, runtimeId: identity.runtimeId }, laneFingerprint: snapshot.laneFingerprint,
    configurationFingerprint: snapshot.configurationFingerprint, projectionRevision: snapshot.projectionRevision,
    capturedAt: snapshot.capturedAt, sequence: snapshot.sequence, recordedAt: snapshot.recordedAt,
    usage: { usedTokensEstimate: snapshot.usage.usedTokensEstimate, maxTokensEstimate: snapshot.usage.maxTokensEstimate,
      usedPercent: snapshot.usage.usedPercent }, status: 'last_known' };
}

export function validTaskUsage(usage: Pick<ContextUsageEstimate, 'usedTokensEstimate' | 'maxTokensEstimate' | 'usedPercent'>): boolean {
  if (!usage || !Number.isFinite(usage.usedTokensEstimate) || usage.usedTokensEstimate < 0
    || !Number.isFinite(usage.maxTokensEstimate) || usage.maxTokensEstimate <= 0
    || !Number.isFinite(usage.usedPercent) || usage.usedPercent < 0) return false;
  // Existing estimates round the percent; permit their rounding, not a mixed denominator.
  const rawPercent = usage.usedTokensEstimate / usage.maxTokensEstimate * 100;
  if (!Number.isFinite(rawPercent)) return false;
  return Math.abs(usage.usedPercent - rawPercent) <= 1.01 || rawPercent > 100 && usage.usedPercent === 100;
}

function matchesCard(origin: TaskContextUsageOrigin, card: ProjectTaskCard): boolean {
  const identity = origin.identity;
  return identity.projectId === card.projectId && identity.taskCardId === card.taskCardId && identity.sessionId === card.sessionId
    && identity.rootTaskId === card.rootTaskId && identity.segmentId === card.segmentId && identity.generation === card.generation
    && origin.configurationFingerprint === taskUsageLaneFingerprint(card.snapshot);
}

/** Display-only state: does not mutate Registry, budgets, permits or sessions.
 * A start event advances the accepted projection BEFORE any async result. */
export class TaskUsageSnapshotTracker {
  private readonly workers = new Map<string, string>();
  private readonly expected = new Map<string, TaskContextUsageOrigin>();
  private readonly snapshots = new Map<string, TaskContextUsageSnapshot>();
  constructor(private readonly projectId: string, private readonly hostId: string) {}

  bindWorker(taskCardId: string, runtimeId: string): void {
    this.workers.set(taskCardId, runtimeId); this.expected.delete(taskCardId);
    const last = this.snapshots.get(taskCardId); if (last) last.status = 'last_known';
  }
  unbindWorker(taskCardId: string): void {
    this.workers.delete(taskCardId); this.expected.delete(taskCardId);
    const last = this.snapshots.get(taskCardId); if (last) last.status = 'last_known';
  }
  begin(origin: TaskContextUsageOrigin, card: ProjectTaskCard): boolean {
    if (!validOrigin(origin) || origin.identity.projectId !== this.projectId || origin.identity.hostId !== this.hostId
      || this.workers.get(card.taskCardId) !== origin.identity.runtimeId || !matchesCard(origin, card)) return false;
    const previous = this.expected.get(card.taskCardId);
    if (previous && origin.projectionRevision <= previous.projectionRevision) return false;
    this.expected.set(card.taskCardId, structuredClone(origin));
    const last = this.snapshots.get(card.taskCardId);
    if (last && (last.laneFingerprint !== origin.laneFingerprint || !matchesCard(last, card))) this.snapshots.delete(card.taskCardId);
    else if (last) last.status = 'last_known';
    return true;
  }
  accept(origin: TaskContextUsageOrigin, sequence: number, usage: ContextUsageEstimate, card: ProjectTaskCard, recordedAt: string): boolean {
    const expected = this.expected.get(card.taskCardId);
    if (!expected || !validOrigin(origin) || !matchesCard(origin, card) || JSON.stringify(expected) !== JSON.stringify(origin)
      || !validTaskUsage(usage) || !Number.isSafeInteger(sequence) || sequence <= 0 || typeof recordedAt !== 'string' || !Number.isFinite(Date.parse(recordedAt))) return false;
    const prior = this.snapshots.get(card.taskCardId);
    if (prior?.identity.runtimeId === origin.identity.runtimeId && sequence <= prior.sequence) return false;
    this.snapshots.set(card.taskCardId, { ...structuredClone(origin), version: 1, sequence, recordedAt,
      usage: { usedTokensEstimate: usage.usedTokensEstimate, maxTokensEstimate: usage.maxTokensEstimate, usedPercent: usage.usedPercent }, status: 'current' });
    return true;
  }
  get(card: ProjectTaskCard): TaskContextUsageSnapshot | undefined {
    const snapshot = this.snapshots.get(card.taskCardId);
    // A new lane/configuration never borrows the old window denominator.
    if (!snapshot || snapshot.identity.projectId !== card.projectId || snapshot.identity.sessionId !== card.sessionId
      || snapshot.configurationFingerprint !== taskUsageLaneFingerprint(card.snapshot)) return undefined;
    return { ...structuredClone(snapshot), status: matchesCard(snapshot, card) ? snapshot.status : 'last_known' };
  }
  restore(values: unknown[], cards: readonly ProjectTaskCard[]): void {
    const byId = new Map(cards.map(card => [card.taskCardId, card]));
    const restored = new Map<string, TaskContextUsageSnapshot>();
    for (const value of values) {
      const snapshot = normalizeTaskUsageSnapshot(value);
      const card = snapshot && byId.get(snapshot.identity.taskCardId);
      if (!snapshot || !card || snapshot.identity.projectId !== this.projectId || snapshot.identity.sessionId !== card.sessionId
        || snapshot.configurationFingerprint !== taskUsageLaneFingerprint(card.snapshot)) continue;
      const prior = restored.get(card.taskCardId);
      // A malformed duplicate record cannot roll back another record from the
      // same producer. Across restarts only last-known data is restored.
      if (prior && prior.identity.runtimeId === snapshot.identity.runtimeId
        && (snapshot.projectionRevision < prior.projectionRevision
          || snapshot.projectionRevision === prior.projectionRevision && snapshot.sequence <= prior.sequence)) continue;
      restored.set(card.taskCardId, snapshot);
    }
    // Observer reloads are replacements: an owner-cleared/invalidated record
    // must disappear. A live owner's in-memory producer stays authoritative.
    for (const id of this.snapshots.keys()) if (!this.expected.has(id)) this.snapshots.delete(id);
    for (const [id, snapshot] of restored) if (!this.expected.has(id)) this.snapshots.set(id, snapshot);
  }
  records(cards: readonly ProjectTaskCard[]): TaskContextUsageSnapshot[] { return cards.flatMap(card => { const value = this.get(card); return value ? [value] : []; }); }
  prune(cards: readonly ProjectTaskCard[]): void {
    const ids = new Set(cards.map(card => card.taskCardId));
    for (const id of new Set([...this.workers.keys(), ...this.snapshots.keys()])) if (!ids.has(id)) this.remove(id);
  }
  invalidate(taskCardId: string): void { this.expected.delete(taskCardId); this.snapshots.delete(taskCardId); }
  remove(taskCardId: string): void { this.invalidate(taskCardId); this.workers.delete(taskCardId); }
  clear(): void { this.expected.clear(); this.workers.clear(); this.snapshots.clear(); }
}
