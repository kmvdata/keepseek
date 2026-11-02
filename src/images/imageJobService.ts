import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { ImageAssetStore } from './imageAssetStore';
import { ImageJobStore, normalizeImageCost, normalizeImageUsage, type ImageStagedResult } from './imageJobStore';
import { validateImageBytes } from './imageValidation';
import { hashImageJobSpec, normalizeImageJobSpec, validateImageScope, type ImageCost, type ImageJob, type ImageJobScope, type ImageJobSpec, type ImageUsage } from './types';

export interface ImageAdapterResult {
  bytes: Uint8Array;
  mimeType: string;
  requestId?: string;
  usage?: ImageUsage;
  cost?: ImageCost;
}
export interface ImageJobAdapter {
  create(spec: ImageJobSpec, input?: { bytes: Uint8Array; mimeType: string }, signal?: AbortSignal, onRequestId?: (requestId: string) => Promise<void>): Promise<ImageAdapterResult>;
  quote?(spec: ImageJobSpec): ImageCost;
}
export interface ImageJobServiceOptions {
  store: ImageJobStore;
  assets: ImageAssetStore;
  adapter: ImageJobAdapter;
  validateBeforeSubmit(spec: ImageJobSpec): Promise<void>;
  onEvent?(job: ImageJob): void;
  now?(): number;
}
const IN_FLIGHT = new Set(['preparing', 'submitting', 'accepted', 'generating']);
const LIVE_RUNTIMES = new Set<string>();

/**
 * Invariants: each action claims one immutable job; only an in-memory one-shot
 * permit can enter the paid adapter; durable submitting precedes that call.
 * Recovery never issues a permit. Unknown outcomes retain their reservation.
 * Asset bytes and owner references commit before saved becomes visible.
 */
export class ImageJobService {
  private readonly runtime = { id: randomUUID(), pid: process.pid, hostname: hostname() };
  private readonly controllers = new Map<string, AbortController>();
  private readonly permits = new Map<string, { specHash: string; expiresAt: number }>();
  private readonly pending = new Set<Promise<void>>();
  private readonly unsavedResults = new Map<string, ImageStagedResult>();
  private initialized?: Promise<void>;
  private disposed = false;
  public constructor(private readonly options: ImageJobServiceOptions) { LIVE_RUNTIMES.add(this.runtime.id); }

  public initialize(): Promise<void> {
    this.initialized ??= this.recoverActive();
    return this.initialized;
  }
  public async list(scope: ImageJobScope): Promise<ImageJob[]> {
    const jobs = await this.options.store.list(scope);
    for (const job of jobs) {
      if (job.status === 'pending') {
        // A pending record can survive failure before the active index or
        // preparing state committed. Re-check under the claim mutex: a live
        // submit completes preparing while holding that same mutex.
        await this.options.store.transaction(async (tx) => {
          const current = await tx.get(scope, job.jobId);
          if (!current || current.status !== 'pending') return;
          const repaired: ImageJob = { ...current, revision: current.revision + 1, status: 'failed', updatedAt: this.timestamp(),
            budget: { ...current.budget, reservationState: 'released' },
            error: { code: 'image_interrupted_before_submission', message: 'image_interrupted_before_submission' } };
          await tx.write(repaired, current.revision);
          const active = await tx.active();
          if (active?.jobId === job.jobId) await tx.setActive(undefined);
        });
      }
      if (job.status === 'generated') await this.retryRetrieval(scope, job.jobId).catch(() => undefined);
    }
    return jobs.some((j) => j.status === 'generated' || j.status === 'pending') ? this.options.store.list(scope) : jobs;
  }
  public get(scope: ImageJobScope, id: string): Promise<ImageJob | undefined> { return this.options.store.get(scope, id); }
  public getByAction(scope: ImageJobScope, actionId: string): Promise<ImageJob | undefined> {
    return this.options.store.get(scope, this.options.store.actionJobId(scope, actionId));
  }

  public async submit(input: { scope: ImageJobScope; actionId: string; spec: unknown; parentJobId?: string; maxCost: number }): Promise<ImageJob> {
    await this.initialize();
    if (this.disposed) throw new Error('image_service_disposed');
    validateImageScope(input.scope);
    const scope = { ...input.scope };
    const spec = normalizeImageJobSpec(input.spec);
    const specHash = hashImageJobSpec(spec);
    const jobId = this.options.store.actionJobId(scope, input.actionId);
    const existing = await this.options.store.get(scope, jobId);
    if (existing) {
      if (existing.specHash !== specHash || existing.parentJobId !== input.parentJobId) throw new Error('image_action_changed');
      return existing;
    }
    if (this.unsavedResults.size) throw new Error('image_local_result_pending');
    if (!Number.isFinite(input.maxCost) || input.maxCost < 0) throw new Error('image_invalid_budget');
    const quote = normalizeImageCost(this.options.adapter.quote?.(spec) ?? unknownCost());
    if (!quote) throw new Error('image_invalid_pricing');
    if (input.maxCost > 0 && (quote.upperBound === undefined || quote.upperBound > input.maxCost)) throw new Error('image_budget_unpriced');
    await this.options.validateBeforeSubmit(spec);
    await this.validateInput(scope, spec);
    if (input.parentJobId) {
      const parent = await this.options.store.get(scope, input.parentJobId);
      if (!parent) throw new Error('image_parent_scope');
    }
    let created = false;
    const job = await this.options.store.transaction(async (tx) => {
      const repeated = await tx.get(scope, jobId);
      if (repeated) {
        if (repeated.specHash !== specHash || repeated.parentJobId !== input.parentJobId) throw new Error('image_action_changed');
        return repeated;
      }
      const active = await tx.active();
      if (active) {
        const running = await tx.get(active.scope, active.jobId);
        if (!running || IN_FLIGHT.has(running.status)) throw new Error('image_active_job');
      }
      if ((await this.options.store.list(scope)).length >= 500) throw new Error('image_job_history_limit');
      const now = this.timestamp();
      const record: ImageJob = {
        version: 1, revision: 0, jobId, actionId: input.actionId, scope, spec, specHash,
        ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}), status: 'pending', createdAt: now, updatedAt: now,
        authorization: { source: 'user_click', authorizedAt: now, specHash },
        budget: { domain: 'manual-image:' + jobId, limit: input.maxCost, reservation: quote, reservationState: 'held' }, ownerRuntime: { ...this.runtime }
      };
      await tx.write(record);
      await tx.setActive({ scope, jobId });
      const preparing = { ...record, revision: 1, status: 'preparing' as const };
      await tx.write(preparing, 0);
      created = true;
      return preparing;
    });
    if (created) {
      this.permits.set(jobId, { specHash, expiresAt: this.now() + 60_000 });
      this.emit(job);
      const work = this.execute(job).catch(() => undefined);
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }
    return structuredClone(job);
  }

  public async stop(scope: ImageJobScope, jobId: string): Promise<ImageJob> {
    const job = await this.options.store.transaction(async (tx) => {
      const current = await tx.get(scope, jobId);
      if (!current) throw new Error('image_job_missing');
      if (!IN_FLIGHT.has(current.status)) return current;
      this.permits.delete(jobId);
      const next: ImageJob = { ...current, revision: current.revision + 1, status: 'local_stopped', stoppedAt: this.timestamp(), updatedAt: this.timestamp(),
        budget: { ...current.budget, reservationState: current.status === 'preparing' ? 'released' : current.budget.reservationState },
        error: { code: current.status === 'preparing' ? 'image_stopped_before_submission' : 'image_stopped_may_charge', message: 'image_stopped_may_charge' } };
      await tx.write(next, current.revision);
      const active = await tx.active();
      if (active?.jobId === jobId) await tx.setActive(undefined);
      return next;
    });
    this.controllers.get(jobId)?.abort();
    this.emit(job); return job;
  }

  public async retryRetrieval(scope: ImageJobScope, jobId: string): Promise<ImageJob> {
    const job = await this.options.store.get(scope, jobId);
    if (!job) throw new Error('image_job_missing');
    // The selected synchronous Images API has no documented task query.
    // Retry only a retained local result; never call create from this path.
    let found = await this.options.assets.findByJob(scope, jobId);
    const staged = await this.retainedResult(scope, jobId, !!found);
    if (!found && staged) {
      found = await this.options.assets.put(scope, staged.bytes, { source: 'generated', jobId, mime: staged.mimeType,
        parentAssetId: job.spec.inputAssets[0]?.assetId, fileName: 'image.' + job.spec.outputFormat });
    }
    if (found) {
      const saved = await this.saveResultReference(job, found.assetId, found.hash, staged);
      this.unsavedResults.delete(jobId);
      await this.options.store.clearStagedResult(scope, jobId).catch(() => undefined);
      return saved;
    }
    throw new Error('image_result_not_queryable');
  }

  public async waitForIdle(): Promise<void> { await Promise.all([...this.pending]); }
  public dispose(): void {
    this.disposed = true;
    LIVE_RUNTIMES.delete(this.runtime.id);
    this.permits.clear();
    for (const controller of this.controllers.values()) controller.abort();
  }

  private async execute(initial: ImageJob): Promise<void> {
    const { scope, jobId, spec, specHash } = initial;
    let submitted = false;
    let received: ImageAdapterResult | undefined;
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      await this.options.validateBeforeSubmit(spec);
      const input = await this.validateInput(scope, spec);
      const claimed = await this.options.store.transaction(async (tx) => {
        const current = await tx.get(scope, jobId);
        if (!current || current.status !== 'preparing') return undefined;
        const permit = this.permits.get(jobId);
        if (!permit || permit.specHash !== specHash || permit.expiresAt < this.now() || this.disposed || controller.signal.aborted) throw new Error('image_permit_invalid');
        if (hashImageJobSpec(current.spec) !== specHash) throw new Error('image_spec_changed');
        const next: ImageJob = { ...current, revision: current.revision + 1, status: 'submitting', updatedAt: this.timestamp() };
        await tx.write(next, current.revision);
        // A failure of any pre-send persistence keeps the permit unconsumed but
        // this execution still exits without making a paid request.
        this.permits.delete(jobId);
        return next;
      });
      if (!claimed) return;
      if (controller.signal.aborted || this.disposed) throw new Error('image_stopped_before_submission');
      submitted = true;
      this.emit(claimed);
      const result = await this.options.adapter.create(spec, input, controller.signal, async (requestId) => {
        const safeId = safeRequestId(requestId);
        if (safeId) await this.update(scope, jobId, (current) => current.requestId === safeId ? current : { ...current, requestId: safeId });
      });
      validateImageBytes(result.bytes, result.mimeType);
      received = result;
      this.unsavedResults.set(jobId, result);
      await this.options.store.stageResult(scope, jobId, result);
      this.unsavedResults.delete(jobId);
      // Even after local stop, retain a late successful response and its bytes.
      await this.update(scope, jobId, (current) => current.status === 'saved' ? current : ({ ...current, status: 'generated',
        requestId: safeRequestId(result.requestId), usage: result.usage ? normalizeImageUsage(result.usage) : undefined,
        budget: { ...current.budget, ...(normalizeImageCost(result.cost) ? { settlement: normalizeImageCost(result.cost)!,
          reservationState: result.cost?.status === 'calculated' ? 'settled' as const : 'held' as const } : {}) }, error: undefined }));
      const asset = await this.options.assets.put(scope, result.bytes, {
        source: 'generated', jobId, mime: result.mimeType, parentAssetId: spec.inputAssets[0]?.assetId,
        fileName: 'image.' + (spec.outputFormat === 'jpeg' ? 'jpg' : spec.outputFormat)
      });
      await this.saveResultReference(initial, asset.assetId, asset.hash);
      await this.options.store.clearStagedResult(scope, jobId).catch(() => undefined);
    } catch (error) {
      const definitive = !submitted || isDefinitiveRejection(error);
      await this.update(scope, jobId, (current) => {
        if (current.status === 'saved') return current;
        const code = received || current.status === 'generated' ? 'image_asset_save_failed' : safeErrorCode(error, definitive ? 'image_generation_failed' : 'image_submission_unknown');
        return { ...current,
          requestId: safeRequestId(error && typeof error === 'object' && 'requestId' in error ? error.requestId : undefined) ?? current.requestId,
          budget: { ...current.budget, reservationState: definitive ? 'released' : current.budget.reservationState },
          status: received || current.status === 'generated' ? 'generated' : current.status === 'local_stopped' ? 'local_stopped' : definitive ? 'failed' : 'submission_unknown',
          error: { code, message: code } };
      }).catch(() => undefined);
    } finally {
      this.permits.delete(jobId);
      this.controllers.delete(jobId);
      await this.options.store.transaction(async (tx) => {
        const active = await tx.active();
        if (active?.jobId !== jobId) return;
        const current = await tx.get(scope, jobId);
        // A failed catch-state write can leave a durable submitting claim.
        // Keep its index so a future owner can classify it as unknown; clearing
        // it here would strand a stale in-flight card with no recovery entry.
        if (current && !IN_FLIGHT.has(current.status) && current.status !== 'pending') await tx.setActive(undefined);
      }).catch(() => undefined);
    }
  }

  private async validateInput(scope: ImageJobScope, spec: ImageJobSpec): Promise<{ bytes: Uint8Array; mimeType: string } | undefined> {
    if (!spec.inputAssets.length) return undefined;
    const selected = spec.inputAssets[0];
    const { asset, bytes } = await this.options.assets.get(scope, selected.assetId);
    if (asset.hash !== selected.hash) throw new Error('image_input_hash_mismatch');
    return { bytes, mimeType: asset.mime };
  }
  private async saveResultReference(job: ImageJob, assetId: string, hash: string, result?: ImageStagedResult): Promise<ImageJob> {
    return this.update(job.scope, job.jobId, (current) => {
      if (current.status === 'saved') {
        if (current.resultAssetId !== assetId || current.resultHash !== hash) throw new Error('image_result_conflict');
        return current;
      }
      return { ...current, ...resultMetadata(current, result), status: 'saved', resultAssetId: assetId, resultHash: hash, error: undefined };
    });
  }
  private async update(scope: ImageJobScope, id: string, change: (job: ImageJob) => ImageJob): Promise<ImageJob> {
    const next = await this.options.store.transaction(async (tx) => {
      const current = await tx.get(scope, id);
      if (!current) throw new Error('image_job_missing');
      const changed = change(current);
      if (changed === current) return current;
      const record = { ...changed, revision: current.revision + 1, updatedAt: this.timestamp() };
      await tx.write(record, current.revision); return record;
    });
    this.emit(next); return next;
  }
  private async recoverActive(): Promise<void> {
    await this.options.store.transaction(async (tx) => {
      const active = await tx.active();
      if (!active) return;
      const current = await tx.get(active.scope, active.jobId);
      if (!current) throw new Error('image_active_record_missing');
      if (!IN_FLIGHT.has(current.status) && current.status !== 'pending' && current.status !== 'generated') { await tx.setActive(undefined); return; }
      const owner = current.ownerRuntime;
      // Another live host owns the task. It remains visible but cannot be stolen.
      if (owner && owner.pid === process.pid && owner.hostname === hostname()) {
        if (LIVE_RUNTIMES.has(owner.id)) return;
      } else if (owner && owner.id !== this.runtime.id && owner.hostname === hostname()) {
        try { process.kill(owner.pid, 0); return; } catch (error) { if (!hasCode(error, 'ESRCH')) return; }
      } else if (owner && owner.hostname !== hostname()) return;
      let found = await this.options.assets.findByJob(current.scope, current.jobId);
      const staged = await this.retainedResult(current.scope, current.jobId, !!found);
      if (!found && staged) {
        found = await this.options.assets.put(current.scope, staged.bytes, { source: 'generated', jobId: current.jobId,
          mime: staged.mimeType, parentAssetId: current.spec.inputAssets[0]?.assetId, fileName: 'image.' + current.spec.outputFormat });
      }
      const next: ImageJob = { ...current, revision: current.revision + 1, updatedAt: this.timestamp(),
        budget: { ...current.budget, reservationState: current.status === 'preparing' || current.status === 'pending' ? 'released' : current.budget.reservationState },
        ...(staged ? resultMetadata(current, staged) : {}),
        status: found ? 'saved' : current.status === 'preparing' || current.status === 'pending' ? 'failed' : current.status === 'generated' ? 'generated' : 'submission_unknown',
        ...(found ? { resultAssetId: found.assetId, resultHash: found.hash, error: undefined }
          : { error: { code: current.status === 'preparing' ? 'image_interrupted_before_submission' : 'image_submission_unknown', message: 'image_submission_unknown' } }) };
      await tx.write(next, current.revision);
      await tx.setActive(undefined);
      if (found) await this.options.store.clearStagedResult(current.scope, current.jobId).catch(() => undefined);
      this.emit(next);
    });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private async retainedResult(scope: ImageJobScope, jobId: string, hasVerifiedAsset: boolean): Promise<ImageStagedResult | undefined> {
    try { return await this.options.store.readStagedResult(scope, jobId) ?? this.unsavedResults.get(jobId); }
    catch (error) {
      // Another retrieval may already have committed the asset and removed its
      // temporary bytes. A verified owner-linked result remains authoritative.
      if (!hasVerifiedAsset) throw error;
      return this.unsavedResults.get(jobId);
    }
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private emit(job: ImageJob): void { try { this.options.onEvent?.(structuredClone(job)); } catch { /* View delivery never changes execution. */ } }
}

function unknownCost(): ImageCost { return { status: 'unknown', currency: 'USD', pricingVersion: 'openai-images-2026-11-02' }; }
function safeRequestId(value: unknown): string | undefined { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,256}$/u.test(value) ? value : undefined; }
function safeErrorCode(error: unknown, fallback: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined;
  return typeof code === 'string' && /^image_[a-zA-Z0-9_-]{1,90}$/u.test(code) ? code : fallback;
}
function isDefinitiveRejection(error: unknown): boolean { return !!error && typeof error === 'object' && 'submissionUnknown' in error && error.submissionUnknown === false; }
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
function resultMetadata(current: ImageJob, result?: ImageStagedResult): Partial<ImageJob> {
  if (!result) return {};
  const cost = normalizeImageCost(result.cost);
  return {
    requestId: safeRequestId(result.requestId) ?? current.requestId,
    usage: result.usage ? normalizeImageUsage(result.usage) : current.usage,
    budget: { ...current.budget, ...(cost ? { settlement: cost, reservationState: cost.status === 'calculated' ? 'settled' as const : 'held' as const } : {}) }
  };
}
