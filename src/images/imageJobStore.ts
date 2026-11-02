import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import * as vscode from 'vscode';
import { withStorageCoordinator, writeBytesAtomic, writeJsonAtomic } from '../shared/atomicStorage';
import { IMAGE_MAX_BYTES, validateImageBytes, verifyImageContainer } from './imageValidation';
import { hashImageJobSpec, normalizeImageJobSpec, validateImageScope, type ImageCost, type ImageJob, type ImageJobScope, type ImageJobStatus, type ImageUsage } from './types';

const STATUSES: ImageJobStatus[] = ['pending', 'preparing', 'submitting', 'submission_unknown', 'accepted', 'generating', 'generated', 'saved', 'failed', 'local_stopped', 'server_cancelled', 'expired'];
export interface ImageJobTransaction {
  get(scope: ImageJobScope, jobId: string): Promise<ImageJob | undefined>;
  write(job: ImageJob, expectedRevision?: number): Promise<void>;
  active(): Promise<{ scope: ImageJobScope; jobId: string } | undefined>;
  setActive(value: { scope: ImageJobScope; jobId: string } | undefined): Promise<void>;
}
export interface ImageStagedResult { bytes: Uint8Array; mimeType: string; requestId?: string; usage?: ImageUsage; cost?: ImageCost }

/** Small per-job records; the shared claim index never contains image bytes. */
export class ImageJobStore {
  public readonly root: vscode.Uri;
  public constructor(globalStorageUri: vscode.Uri) { this.root = vscode.Uri.joinPath(globalStorageUri, 'image-jobs-v1'); }

  public async transaction<T>(work: (tx: ImageJobTransaction) => Promise<T>): Promise<T> {
    return withStorageCoordinator(this.root.toString() + ':transaction', async () => {
      // An exclusive on-disk lock covers separate Extension Hosts, not only instances.
      // Dead-owner reclamation requires proof on this host; elapsed time is never authorization.
      if (this.root.scheme !== 'file') throw new Error('image_storage_scheme_unsupported');
      await mkdir(this.root.fsPath, { recursive: true });
      const lockPath = vscode.Uri.joinPath(this.root, 'claim.lock').fsPath;
      const lockId = randomUUID();
      let lock;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if (!isCode(error, 'EEXIST')) throw error;
          // Only one reclaimer may inspect/remove a dead lock. Without this
          // gate two reclaimers could remove a newly acquired live lock.
          const reaperPath = lockPath + '.recovery';
          let reaper;
          try { reaper = await open(reaperPath, 'wx', 0o600); }
          catch { throw new Error('image_storage_busy'); }
          try {
            let dead = false;
            try {
              const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { hostname?: unknown; pid?: unknown };
              if (owner.hostname === hostname() && typeof owner.pid === 'number' && owner.pid > 0) {
                try { process.kill(owner.pid, 0); } catch (probe) { dead = isCode(probe, 'ESRCH'); }
              }
            } catch { /* An incomplete or foreign lock remains fail-closed. */ }
            if (!dead) throw new Error('image_storage_busy');
            await unlink(lockPath).catch(() => undefined);
          } finally { await reaper.close(); await unlink(reaperPath); }
        }
      }
      if (!lock) throw new Error('image_storage_busy');
      try {
        await lock.writeFile(JSON.stringify({ id: lockId, hostname: hostname(), pid: process.pid }));
        return await work({
          get: (scope, id) => this.get(scope, id),
          write: async (job, expectedRevision) => {
            const current = await this.get(job.scope, job.jobId);
            if (expectedRevision === undefined ? !!current : current?.revision !== expectedRevision) throw new Error('image_revision_conflict');
            if (current && (current.specHash !== job.specHash || current.actionId !== job.actionId)) throw new Error('image_spec_immutable');
            const normalized = normalizeStoredImageJob(job);
            if (!normalized) throw new Error('image_invalid_record');
            await writeJsonAtomic(this.jobUri(job.scope, job.jobId), normalized, { durable: true });
          },
          active: async () => {
            const value = await this.readJson(vscode.Uri.joinPath(this.root, 'active.json'));
            if (!value || typeof value !== 'object' || !('jobId' in value)) return undefined;
            const active = value as { scope: ImageJobScope; jobId: string };
            validateImageScope(active.scope); this.validateId(active.jobId); return active;
          },
          setActive: (value) => writeJsonAtomic(vscode.Uri.joinPath(this.root, 'active.json'), value ?? {}, { durable: true })
        });
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    });
  }

  public async get(scope: ImageJobScope, jobId: string): Promise<ImageJob | undefined> {
    const raw = await this.readJson(this.jobUri(scope, jobId));
    if (raw === undefined) return undefined;
    const job = normalizeStoredImageJob(raw);
    if (!job || job.jobId !== jobId || job.scope.workspaceId !== scope.workspaceId || job.scope.sessionId !== scope.sessionId) throw new Error('image_record_corrupt');
    return job;
  }

  public async list(scope: ImageJobScope): Promise<ImageJob[]> {
    const directory = this.scopeUri(scope);
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const names = entries.filter(([name]) => /^ij_[a-f0-9]{64}\.json$/u.test(name));
    if (names.length > 500) throw new Error('image_job_history_limit');
    const result: ImageJob[] = [];
    for (const [name] of names) {
      const job = await this.get(scope, name.slice(0, -5));
      if (job) result.push(job);
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Private raw-byte staging permits local persistence retries without another
   * paid create. JSON contains bounded metadata only; no URLs or base64. */
  public async stageResult(scope: ImageJobScope, jobId: string, result: ImageStagedResult): Promise<void> {
    if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength > IMAGE_MAX_BYTES) throw new Error('image_result_too_large');
    const bytes = Uint8Array.from(result.bytes);
    const metadata = validateImageBytes(bytes, result.mimeType);
    const usage = result.usage ? normalizeImageUsage(result.usage) : undefined;
    const cost = normalizeImageCost(result.cost);
    const requestId = result.requestId && /^[a-zA-Z0-9_-]{1,256}$/u.test(result.requestId) ? result.requestId : undefined;
    const hash = createHash('sha256').update(bytes).digest('hex');
    await verifyImageContainer(bytes, metadata);
    await this.transaction(async (tx) => {
      if (!await tx.get(scope, jobId)) throw new Error('image_job_missing');
      const stagingRoot = vscode.Uri.joinPath(this.root, 'pending-results');
      await vscode.workspace.fs.createDirectory(stagingRoot);
      const binary = this.stagedUri(scope, jobId, '.bin');
      const entries = await vscode.workspace.fs.readDirectory(stagingRoot);
      let total = 0;
      for (const [name] of entries) {
        if (name.endsWith('.bin')) total += (await vscode.workspace.fs.stat(vscode.Uri.joinPath(stagingRoot, name))).size;
      }
      let priorSize = 0;
      try { priorSize = (await vscode.workspace.fs.stat(binary)).size; } catch (error) { if (!isMissing(error)) throw error; }
      if (total - priorSize + bytes.byteLength > 128 * 1024 * 1024) throw new Error('image_pending_result_quota');
      await writeBytesAtomic(binary, bytes, { durable: true });
      await writeJsonAtomic(this.stagedUri(scope, jobId, '.json'), {
        version: 1, scope: { ...scope }, jobId, hash, mimeType: metadata.mime, byteLength: bytes.byteLength,
        ...(requestId ? { requestId } : {}),
        ...(usage ? { usage } : {}), ...(cost ? { cost } : {})
      }, { durable: true });
    });
  }

  public async readStagedResult(scope: ImageJobScope, jobId: string): Promise<ImageStagedResult | undefined> {
    const raw = await this.readJson(this.stagedUri(scope, jobId, '.json'));
    if (raw === undefined) return undefined;
    const v = raw as { version?: unknown; scope?: ImageJobScope; jobId?: unknown; hash?: unknown; mimeType?: unknown; byteLength?: unknown; requestId?: unknown; usage?: ImageUsage; cost?: ImageCost };
    if (v.version !== 1 || v.scope?.workspaceId !== scope.workspaceId || v.scope?.sessionId !== scope.sessionId || v.jobId !== jobId
      || typeof v.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.hash) || typeof v.mimeType !== 'string'
      || typeof v.byteLength !== 'number' || v.byteLength > 20 * 1024 * 1024) throw new Error('image_pending_result_corrupt');
    const uri = this.stagedUri(scope, jobId, '.bin');
    if ((await vscode.workspace.fs.stat(uri)).size !== v.byteLength) throw new Error('image_pending_result_corrupt');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength !== v.byteLength || createHash('sha256').update(bytes).digest('hex') !== v.hash) throw new Error('image_pending_result_corrupt');
    validateImageBytes(bytes, v.mimeType);
    return { bytes, mimeType: v.mimeType,
      ...(typeof v.requestId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/u.test(v.requestId) ? { requestId: v.requestId } : {}),
      ...(v.usage ? { usage: normalizeImageUsage(v.usage) } : {}), ...(normalizeImageCost(v.cost) ? { cost: normalizeImageCost(v.cost) } : {}) };
  }

  public async clearStagedResult(scope: ImageJobScope, jobId: string): Promise<void> {
    for (const extension of ['.json', '.bin']) {
      try { await vscode.workspace.fs.delete(this.stagedUri(scope, jobId, extension), { useTrash: false }); }
      catch (error) { if (!isMissing(error)) throw error; }
    }
  }

  public actionJobId(scope: ImageJobScope, actionId: string): string {
    validateImageScope(scope);
    if (typeof actionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/u.test(actionId)) throw new Error('image_invalid_action');
    return 'ij_' + createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.sessionId, actionId])).digest('hex');
  }
  private scopeUri(scope: ImageJobScope): vscode.Uri {
    validateImageScope(scope);
    const key = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.sessionId])).digest('hex');
    return vscode.Uri.joinPath(this.root, 'sessions', key);
  }
  private jobUri(scope: ImageJobScope, id: string): vscode.Uri { this.validateId(id); return vscode.Uri.joinPath(this.scopeUri(scope), id + '.json'); }
  private stagedUri(scope: ImageJobScope, id: string, extension: string): vscode.Uri {
    validateImageScope(scope); this.validateId(id);
    const key = createHash('sha256').update(JSON.stringify([scope.workspaceId, scope.sessionId, id])).digest('hex');
    return vscode.Uri.joinPath(this.root, 'pending-results', key + extension);
  }
  private validateId(id: string): void { if (!/^ij_[a-f0-9]{64}$/u.test(id)) throw new Error('image_invalid_job'); }
  private async readJson(uri: vscode.Uri): Promise<unknown> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 256_000) throw new Error('image_record_too_large');
      return JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
    } catch (error) { if (isMissing(error)) return undefined; throw error; }
  }
}

export function normalizeStoredImageJob(value: unknown): ImageJob | undefined {
  try {
    if (!value || typeof value !== 'object') return undefined;
    const v = value as ImageJob;
    validateImageScope(v.scope);
    const spec = normalizeImageJobSpec(v.spec);
    const hash = hashImageJobSpec(spec);
    if (v.version !== 1 || !Number.isSafeInteger(v.revision) || v.revision < 0 || !/^ij_[a-f0-9]{64}$/u.test(v.jobId)
      || !/^[a-zA-Z0-9_-]{1,128}$/u.test(v.actionId) || hash !== v.specHash || !STATUSES.includes(v.status)
      || !v.authorization || v.authorization.source !== 'user_click' || v.authorization.specHash !== hash
      || !v.budget || !Number.isFinite(v.budget.limit) || v.budget.limit < 0 || typeof v.budget.domain !== 'string'
      || !validDate(v.createdAt) || !validDate(v.updatedAt) || !validDate(v.authorization.authorizedAt)) return undefined;
    const reservation = normalizeImageCost(v.budget.reservation);
    const settlement = v.budget.settlement ? normalizeImageCost(v.budget.settlement) : undefined;
    if (!reservation || (v.budget.settlement && !settlement)) return undefined;
    const owner = v.ownerRuntime;
    return {
      version: 1, revision: v.revision, jobId: v.jobId, actionId: v.actionId,
      scope: { workspaceId: v.scope.workspaceId, sessionId: v.scope.sessionId }, spec, specHash: hash,
      ...(typeof v.parentJobId === 'string' && /^ij_[a-f0-9]{64}$/u.test(v.parentJobId) ? { parentJobId: v.parentJobId } : {}),
      status: v.status, createdAt: v.createdAt, updatedAt: v.updatedAt,
      authorization: { source: 'user_click', authorizedAt: v.authorization.authorizedAt, specHash: hash },
      budget: { domain: v.budget.domain, limit: v.budget.limit, reservation,
        reservationState: ['held', 'released', 'settled'].includes(v.budget.reservationState ?? '') ? v.budget.reservationState : 'held',
        ...(settlement ? { settlement } : {}) },
      ...(typeof v.resultAssetId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/u.test(v.resultAssetId) ? { resultAssetId: v.resultAssetId } : {}),
      ...(typeof v.resultHash === 'string' && /^[a-f0-9]{64}$/u.test(v.resultHash) ? { resultHash: v.resultHash } : {}),
      ...(typeof v.requestId === 'string' && /^[a-zA-Z0-9_-]{1,256}$/u.test(v.requestId) ? { requestId: v.requestId } : {}),
      ...(v.usage ? { usage: normalizeImageUsage(v.usage) } : {}),
      ...(v.error && typeof v.error.code === 'string' && /^[a-zA-Z0-9_-]{1,100}$/u.test(v.error.code) ? { error: { code: v.error.code, message: v.error.code } } : {}),
      ...(owner && typeof owner.id === 'string' && typeof owner.hostname === 'string' && Number.isSafeInteger(owner.pid) ? { ownerRuntime: { id: owner.id, pid: owner.pid, hostname: owner.hostname } } : {}),
      ...(validDate(v.stoppedAt) ? { stoppedAt: v.stoppedAt } : {})
    };
  } catch { return undefined; }
}

export function normalizeImageCost(value: unknown): ImageCost | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ImageCost;
  if (!['unknown', 'estimated', 'calculated'].includes(v.status) || !/^[A-Z]{3}$/u.test(v.currency)
    || typeof v.pricingVersion !== 'string' || v.pricingVersion.length > 128) return undefined;
  if (v.amount !== undefined && (!Number.isFinite(v.amount) || v.amount < 0)) return undefined;
  if (v.upperBound !== undefined && (!Number.isFinite(v.upperBound) || v.upperBound < 0)) return undefined;
  if (v.status === 'unknown' && v.amount !== undefined) return undefined;
  return { status: v.status, currency: v.currency, pricingVersion: v.pricingVersion,
    ...(v.amount !== undefined ? { amount: v.amount } : {}), ...(v.upperBound !== undefined ? { upperBound: v.upperBound } : {}) };
}
export function normalizeImageUsage(value: ImageUsage): ImageUsage {
  const result: ImageUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'inputTextTokens', 'inputImageTokens']) {
    const n = value[key]; if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) result[key] = n;
  }
  return result;
}
function validDate(value: unknown): value is string { return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)); }
function isCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function isMissing(error: unknown): boolean { return isCode(error, 'ENOENT') || isCode(error, 'FileNotFound'); }
