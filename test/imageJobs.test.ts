import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import * as vscode from './stubs/vscode';
import { ImageAssetStore } from '../src/images/imageAssetStore';
import { ImageJobStore, type ImageJobTransaction } from '../src/images/imageJobStore';
import { ImageJobService, type ImageJobAdapter } from '../src/images/imageJobService';
import { hashImageJobSpec, normalizeImageJobSpec, type ImageJob, type ImageJobSpec } from '../src/images/types';

const SCOPE = { workspaceId: 'file:///project', sessionId: 'session-one' };
const PNG = validPng();
function spec(overrides: Partial<ImageJobSpec> = {}): ImageJobSpec {
  return { adapter: 'openai-images-v1', adapterVersion: 1, sourceId: 'openai-account', endpoint: 'https://api.openai.com/v1',
    model: 'gpt-image-2.5-sunburst', operation: 'generate', prompt: 'A small blue icon', inputAssets: [],
    size: '1024x1024', quality: 'medium', background: 'opaque', outputFormat: 'png', n: 1, ...overrides };
}
interface Fixture { root: string; assets: ImageAssetStore; store: ImageJobStore; service: ImageJobService; calls: ImageJobSpec[] }
async function fixture(work: (f: Fixture) => Promise<void>, customize: { adapter?: ImageJobAdapter; validate?: (s: ImageJobSpec) => Promise<void>; store?: (root: import('vscode').Uri) => ImageJobStore } = {}): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-image-jobs-'));
  const uri = vscode.Uri.file(root) as unknown as import('vscode').Uri;
  const assets = new ImageAssetStore(uri);
  const store = customize.store?.(uri) ?? new ImageJobStore(uri);
  const calls: ImageJobSpec[] = [];
  const service = new ImageJobService({ store, assets, adapter: customize.adapter ?? {
    create: async (s) => { calls.push(s); return { bytes: PNG, mimeType: 'image/png', requestId: 'req_test', usage: { inputTokens: 4, outputTokens: 3 } }; }
  }, validateBeforeSubmit: customize.validate ?? (async () => undefined) });
  try { await work({ root, assets, store, service, calls }); }
  finally { service.dispose(); await service.waitForIdle(); await rm(root, { recursive: true, force: true }); }
}

test('image spec canonicalizes LF and trim; meaningful parameters change hash and malformed capabilities reject', () => {
  const normalized = normalizeImageJobSpec(spec({ prompt: ' \r\n icon\r\n detail \r\n' }));
  assert.equal(normalized.prompt, 'icon\n detail');
  assert.equal(hashImageJobSpec(spec({ prompt: '\r\nicon\r\n' })), hashImageJobSpec(spec({ prompt: 'icon' })));
  assert.notEqual(hashImageJobSpec(spec()), hashImageJobSpec(spec({ quality: 'high' })));
  assert.notEqual(hashImageJobSpec(spec()), hashImageJobSpec(spec({ sourceId: 'another-account' })));
  assert.throws(() => normalizeImageJobSpec(spec({ operation: 'edit' })), /input_count/u);
  assert.throws(() => normalizeImageJobSpec(spec({ endpoint: 'https://custom.example/v1' })), /endpoint/u);
  assert.throws(() => normalizeImageJobSpec(spec({ prompt: 'x'.repeat(32_001) })), /prompt_limit/u);
  assert.throws(() => normalizeImageJobSpec(spec({ background: 'transparent', outputFormat: 'jpeg' })), /transparency/u);
  assert.throws(() => normalizeImageJobSpec(spec({ model: 'gpt-image-1' })), /model/u);
  assert.throws(() => normalizeImageJobSpec({ ...spec(), size: ['1024x1024'] }), /size/u);
  assert.throws(() => normalizeImageJobSpec({ ...spec(), seed: 42 }), /unsupported_parameter/u);
});

test('duplicate image action submits once; a new action with the same spec creates another paid task', async () => {
  await fixture(async ({ service, calls }) => {
    const input = { scope: SCOPE, actionId: 'same-click', spec: spec(), maxCost: 0 };
    const [first, duplicate] = await Promise.all([service.submit(input), service.submit(input)]);
    assert.equal(first.jobId, duplicate.jobId);
    await service.waitForIdle();
    assert.equal(calls.length, 1);
    assert.equal((await service.get(SCOPE, first.jobId))?.status, 'saved');
    await service.submit(input);
    assert.equal(calls.length, 1);
    await assert.rejects(service.submit({ ...input, spec: spec({ quality: 'high' }) }), /action_changed/u);
    const next = await service.submit({ ...input, actionId: 'new-click' });
    await service.waitForIdle();
    assert.notEqual(first.jobId, next.jobId);
    assert.equal(first.specHash, next.specHash);
    assert.equal(calls.length, 2);
  });
});

test('lookup by original action remains available after credentials become unavailable', async () => {
  let sourceEnabled = true;
  await fixture(async ({ service, calls }) => {
    const input = { scope: SCOPE, actionId: 'existing-action', spec: spec(), maxCost: 0 };
    const original = await service.submit(input);
    await service.waitForIdle();
    sourceEnabled = false;
    const found = await service.getByAction(SCOPE, input.actionId);
    assert.equal(found?.jobId, original.jobId);
    assert.equal((await service.submit(input)).jobId, original.jobId);
    assert.equal(await service.getByAction({ ...SCOPE, sessionId: 'other' }, input.actionId), undefined);
    assert.equal(calls.length, 1);
  }, { validate: async () => { if (!sourceEnabled) throw new Error('image_authentication'); } });
});

test('positive image cap rejects unpriceable upper bounds without creating or submitting a job', async () => {
  await fixture(async ({ service, calls }) => {
    await assert.rejects(service.submit({ scope: SCOPE, actionId: 'price', spec: spec(), maxCost: 1 }), /budget_unpriced/u);
    assert.equal(calls.length, 0);
    assert.deepEqual(await service.list(SCOPE), []);
  });
});

test('selected edit uploads exact original bytes; other-session assets and wrong hashes reject before submit', async () => {
  let received: Uint8Array | undefined;
  await fixture(async ({ service, assets }) => {
    const input = await assets.put(SCOPE, PNG, { source: 'import' });
    const edit = spec({ operation: 'edit', inputAssets: [{ assetId: input.assetId, hash: input.hash }] });
    await assert.rejects(service.submit({ scope: SCOPE, actionId: 'wrong-hash', spec: { ...edit, inputAssets: [{ assetId: input.assetId, hash: '0'.repeat(64) }] }, maxCost: 0 }), /hash_mismatch/u);
    await assert.rejects(service.submit({ scope: { ...SCOPE, sessionId: 'another' }, actionId: 'cross-session', spec: edit, maxCost: 0 }));
    await service.submit({ scope: SCOPE, actionId: 'edit', spec: edit, maxCost: 0 });
    await service.waitForIdle();
    assert.deepEqual(received, PNG);
  }, { adapter: { create: async (_s, input) => { received = input?.bytes; return { bytes: PNG, mimeType: 'image/png' }; } } });
});

test('configuration changes after authorization stop before the paid call', async () => {
  let validation = 0;
  await fixture(async ({ service, calls }) => {
    await service.submit({ scope: SCOPE, actionId: 'changed-source', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    assert.equal(calls.length, 0);
    assert.equal((await service.list(SCOPE))[0]?.status, 'failed');
  }, { validate: async () => { if (++validation > 1) throw new Error('image_source_changed'); } });
});

test('a failed durable submitting write never sends the paid request', async () => {
  class FailingStore extends ImageJobStore {
    public override transaction<T>(work: (tx: ImageJobTransaction) => Promise<T>): Promise<T> {
      return super.transaction((tx) => work({ ...tx, write: (job, revision) => {
        if (job.status === 'submitting') throw new Error('disk failed');
        return tx.write(job, revision);
      } }));
    }
  }
  await fixture(async ({ service, calls }) => {
    await service.submit({ scope: SCOPE, actionId: 'disk-failure', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    assert.equal(calls.length, 0);
    assert.equal((await service.list(SCOPE))[0]?.status, 'failed');
  }, { store: (root) => new FailingStore(root) });
});

test('failure to persist unknown outcome retains active claim for conservative recovery after reload', async () => {
  let rejectOutcomeWrite = true;
  class FailedOutcomeStore extends ImageJobStore {
    public override transaction<T>(work: (tx: ImageJobTransaction) => Promise<T>): Promise<T> {
      return super.transaction((tx) => work({ ...tx, write: (job, revision) => {
        if (rejectOutcomeWrite && job.status === 'submission_unknown') throw new Error('outcome disk write failed');
        return tx.write(job, revision);
      } }));
    }
  }
  let calls = 0;
  await fixture(async ({ store, assets, service }) => {
    const original = await service.submit({ scope: SCOPE, actionId: 'outcome-write-failed', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    assert.equal((await service.get(SCOPE, original.jobId))?.status, 'submitting');
    assert.equal((await store.transaction((tx) => tx.active()))?.jobId, original.jobId);
    service.dispose();
    rejectOutcomeWrite = false;
    const reloaded = new ImageJobService({ store, assets, adapter: { create: async () => { throw new Error('must not resubmit'); } }, validateBeforeSubmit: async () => undefined });
    await reloaded.initialize();
    assert.equal((await reloaded.get(SCOPE, original.jobId))?.status, 'submission_unknown');
    assert.equal(calls, 1);
    reloaded.dispose();
  }, { store: (root) => new FailedOutcomeStore(root), adapter: { create: async () => { calls++; throw new Error('network lost'); } } });
});

test('stopping an older in-flight task cannot clear the active identity of a newer task', async () => {
  await fixture(async ({ service, store }) => {
    const older = createStoredJob(store, 'submitting');
    const newer = { ...older, actionId: 'newer-active', jobId: store.actionJobId(SCOPE, 'newer-active') };
    await store.transaction(async (tx) => {
      await tx.write(older); await tx.write(newer); await tx.setActive({ scope: SCOPE, jobId: newer.jobId });
    });
    await service.stop(SCOPE, older.jobId);
    assert.equal((await store.transaction((tx) => tx.active()))?.jobId, newer.jobId);
  });
});

test('one active image task has a clear refusal and does not share text task state', async () => {
  let resolve!: () => void;
  const gate = new Promise<void>((r) => { resolve = r; });
  await fixture(async ({ service }) => {
    const first = await service.submit({ scope: SCOPE, actionId: 'active', spec: spec(), maxCost: 0 });
    await assert.rejects(service.submit({ scope: SCOPE, actionId: 'second', spec: spec(), maxCost: 0 }), /active_job/u);
    resolve(); await service.waitForIdle();
    assert.equal((await service.get(SCOPE, first.jobId))?.status, 'saved');
  }, { adapter: { create: async () => { await gate; return { bytes: PNG, mimeType: 'image/png' }; } } });
});

test('stopping before submission never sends; stopping after submission retains late successful image', async () => {
  let gateResolve!: () => void;
  const gate = new Promise<void>((resolve) => { gateResolve = resolve; });
  let validations = 0;
  await fixture(async ({ service, calls }) => {
    const job = await service.submit({ scope: SCOPE, actionId: 'stop-before', spec: spec(), maxCost: 0 });
    await service.stop(SCOPE, job.jobId);
    gateResolve(); await service.waitForIdle();
    assert.equal(calls.length, 0);
    assert.equal((await service.get(SCOPE, job.jobId))?.status, 'local_stopped');
  }, { validate: async () => { if (++validations > 1) await gate; } });
  let started!: () => void;
  const start = new Promise<void>((resolve) => { started = resolve; });
  let finish!: () => void;
  const finishGate = new Promise<void>((resolve) => { finish = resolve; });
  await fixture(async ({ service }) => {
    const job = await service.submit({ scope: SCOPE, actionId: 'stop-after', spec: spec(), maxCost: 0 });
    await start;
    assert.equal((await service.stop(SCOPE, job.jobId)).status, 'local_stopped');
    finish(); await service.waitForIdle();
    const result = await service.get(SCOPE, job.jobId);
    assert.equal(result?.status, 'saved');
    assert.ok(result?.resultAssetId);
    assert.equal(result?.budget.reservation.status, 'unknown');
  }, { adapter: { create: async () => { started(); await finishGate; return { bytes: PNG, mimeType: 'image/png' }; } } });
});

test('network creation outcome stays unknown and retry retrieval never generates again', async () => {
  let count = 0;
  await fixture(async ({ service }) => {
    const job = await service.submit({ scope: SCOPE, actionId: 'unknown', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    assert.equal((await service.get(SCOPE, job.jobId))?.status, 'submission_unknown');
    await assert.rejects(service.retryRetrieval(SCOPE, job.jobId), /not_queryable/u);
    assert.equal(count, 1);
  }, { adapter: { create: async () => { count++; throw new Error('network closed'); } } });
});

test('stale persisted claims recover conservatively with no permit or paid create', async () => {
  await fixture(async ({ store, assets, calls }) => {
    for (const status of ['preparing', 'submitting', 'generating'] as const) {
      const job = createStoredJob(store, status);
      await store.transaction(async (tx) => { await tx.write(job); await tx.setActive({ scope: SCOPE, jobId: job.jobId }); });
      const service = new ImageJobService({ store, assets, adapter: { create: async (s) => { calls.push(s); return { bytes: PNG, mimeType: 'image/png' }; } }, validateBeforeSubmit: async () => undefined });
      await service.initialize();
      const recovered = await store.get(SCOPE, job.jobId);
      assert.equal(recovered?.status, status === 'preparing' ? 'failed' : 'submission_unknown');
      assert.deepEqual(recovered?.budget, { ...job.budget, reservationState: status === 'preparing' ? 'released' : 'held' });
      assert.equal(calls.length, 0);
      service.dispose();
    }
  });
});

test('recovery attaches a durable result written before the job result reference', async () => {
  await fixture(async ({ store, assets, service, calls }) => {
    const job = createStoredJob(store, 'submitting');
    await store.transaction(async (tx) => { await tx.write(job); await tx.setActive({ scope: SCOPE, jobId: job.jobId }); });
    const asset = await assets.put(SCOPE, PNG, { source: 'generated', jobId: job.jobId });
    await service.initialize();
    const recovered = await service.get(SCOPE, job.jobId);
    assert.equal(recovered?.status, 'saved'); assert.equal(recovered?.resultAssetId, asset.assetId);
    assert.equal(calls.length, 0);
  });
});

test('generated bytes survive asset-store failure and reload retrieval never sends another create', async () => {
  await fixture(async ({ store, assets, service, calls }) => {
    const originalPut = assets.put.bind(assets);
    assets.put = async () => { throw new Error('asset disk temporarily full'); };
    const job = await service.submit({ scope: SCOPE, actionId: 'asset-retry', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    assert.equal((await service.get(SCOPE, job.jobId))?.status, 'generated');
    assert.deepEqual(Buffer.from((await store.readStagedResult(SCOPE, job.jobId))!.bytes), PNG);
    service.dispose();
    assets.put = originalPut;
    const reloaded = new ImageJobService({ store, assets, adapter: { create: async () => { throw new Error('must not generate'); } }, validateBeforeSubmit: async () => undefined });
    await reloaded.initialize();
    const recovered = await reloaded.retryRetrieval(SCOPE, job.jobId);
    assert.equal(recovered.status, 'saved');
    assert.equal(calls.length, 1);
    assert.equal(await store.readStagedResult(SCOPE, job.jobId), undefined);
    reloaded.dispose();
  });
});

test('verified saved assets remain retrievable when obsolete staging disappears or is corrupt', async () => {
  await fixture(async ({ store, service, calls }) => {
    const job = await service.submit({ scope: SCOPE, actionId: 'staging-race', spec: spec(), maxCost: 0 });
    await service.waitForIdle();
    const saved = await service.get(SCOPE, job.jobId);
    assert.equal(saved?.status, 'saved');
    store.readStagedResult = async () => { throw new Error('image_pending_result_corrupt'); };
    const retrieved = await service.retryRetrieval(SCOPE, job.jobId);
    assert.equal(retrieved.status, 'saved');
    assert.equal(retrieved.resultAssetId, saved?.resultAssetId);
    assert.equal(calls.length, 1);
  });
});

test('an orphan pending record is repaired without creating; staged recovery retains usage and calculated cost', async () => {
  await fixture(async ({ store, assets, service, calls }) => {
    const pending = createStoredJob(store, 'pending');
    await store.transaction(async (tx) => { await tx.write(pending); });
    const repaired = await service.list(SCOPE);
    assert.equal(repaired[0]?.status, 'failed');
    assert.equal(repaired[0]?.budget.reservationState, 'released');
    const generated = createStoredJob(store, 'generated');
    await store.transaction(async (tx) => { await tx.write(generated); });
    await store.stageResult(SCOPE, generated.jobId, { bytes: PNG, mimeType: 'image/png', requestId: 'req_staged',
      usage: { inputTokens: 4, outputTokens: 5, secret: 'must-be-removed' },
      cost: { status: 'calculated', currency: 'USD', amount: 0.1, pricingVersion: 'published-test' } });
    const reloaded = new ImageJobService({ store, assets, adapter: { create: async () => { throw new Error('must not generate'); } }, validateBeforeSubmit: async () => undefined });
    const jobs = await reloaded.list(SCOPE);
    const result = jobs.find((j) => j.jobId === generated.jobId);
    assert.equal(result?.status, 'saved');
    assert.equal(result?.requestId, 'req_staged');
    assert.deepEqual(result?.usage, { inputTokens: 4, outputTokens: 5 });
    assert.equal(result?.budget.reservationState, 'settled');
    assert.equal(result?.budget.settlement?.amount, 0.1);
    assert.equal(calls.length, 0);
    reloaded.dispose();
  });
});

test('definitive provider rejection releases reservation while network uncertainty retains it and request ID', async () => {
  for (const definitive of [true, false]) {
    await fixture(async ({ service }) => {
      const job = await service.submit({ scope: SCOPE, actionId: 'rejected', spec: spec(), maxCost: 0 });
      await service.waitForIdle();
      const result = await service.get(SCOPE, job.jobId);
      assert.equal(result?.status, definitive ? 'failed' : 'submission_unknown');
      assert.equal(result?.budget.reservationState, definitive ? 'released' : 'held');
      assert.equal(result?.requestId, 'req_observed');
      assert.equal(result?.budget.settlement, undefined);
    }, { adapter: { create: async () => { throw { code: 'image_authentication_failed', submissionUnknown: !definitive, requestId: 'req_observed' }; } } });
  }
});

test('observed provider request identity persists before response body processing completes', async () => {
  let observed!: () => void;
  const header = new Promise<void>((resolve) => { observed = resolve; });
  let release!: () => void;
  const body = new Promise<void>((resolve) => { release = resolve; });
  await fixture(async ({ service }) => {
    const job = await service.submit({ scope: SCOPE, actionId: 'header', spec: spec(), maxCost: 0 });
    await header;
    const pending = await service.get(SCOPE, job.jobId);
    assert.equal(pending?.requestId, 'req_header');
    assert.equal(pending?.status, 'submitting');
    release(); await service.waitForIdle();
    assert.equal((await service.get(SCOPE, job.jobId))?.requestId, 'req_header');
  }, { adapter: { create: async (_s, _input, _signal, onRequestId) => {
    await onRequestId?.('req_header'); observed(); await body;
    return { bytes: PNG, mimeType: 'image/png', requestId: 'req_header' };
  } } });
});

test('job serialization keeps only validated metadata and compare-and-swap rejects stale writers', async () => {
  await fixture(async ({ store }) => {
    const job = createStoredJob(store, 'submitting');
    job.usage = { inputTokens: 3, arbitrary: 'data:image/png;base64,secret', key: 'sk-secret' };
    await store.transaction(async (tx) => { await tx.write(job); });
    const reloaded = await store.get(SCOPE, job.jobId);
    assert.deepEqual(reloaded?.usage, { inputTokens: 3 });
    const scopeHash = await import('node:crypto').then(({ createHash }) => createHash('sha256').update(JSON.stringify([SCOPE.workspaceId, SCOPE.sessionId])).digest('hex'));
    const serialized = await readFile(path.join(store.root.fsPath, 'sessions', scopeHash, job.jobId + '.json'), 'utf8');
    assert.doesNotMatch(serialized, /base64|sk-secret|arbitrary/u);
    await store.transaction(async (tx) => { await tx.write({ ...job, revision: 1 }, 0); });
    await assert.rejects(store.transaction(async (tx) => { await tx.write({ ...job, revision: 1 }, 0); }), /revision_conflict/u);
    await assert.rejects(store.get({ ...SCOPE, sessionId: 'wrong-owner' }, job.jobId).then((v) => { if (!v) throw new Error('not found'); }), /not found/u);
  });
});

function createStoredJob(store: ImageJobStore, status: ImageJob['status']): ImageJob {
  const actionId = status;
  const s = spec(); const hash = hashImageJobSpec(s); const now = new Date().toISOString();
  return { version: 1, revision: 0, jobId: store.actionJobId(SCOPE, actionId), actionId, scope: SCOPE, spec: s, specHash: hash, status,
    createdAt: now, updatedAt: now, authorization: { source: 'user_click', authorizedAt: now, specHash: hash },
    budget: { domain: 'manual-image:test', limit: 0, reservationState: 'held', reservation: { status: 'unknown', currency: 'USD', pricingVersion: 'test' } },
    ownerRuntime: { id: 'dead-runtime', pid: 2147483647, hostname: hostname() } };
}

function validPng(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  const chunk = (type: string, body: Buffer): Buffer => {
    const output = Buffer.alloc(body.length + 12); output.writeUInt32BE(body.length); output.write(type, 4, 'ascii'); body.copy(output, 8);
    let crc = 0xffffffff;
    for (const byte of output.subarray(4, output.length - 4)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; }
    output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4); return output;
  };
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND', Buffer.alloc(0))]);
}
