import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { getImageModelCapabilities } from '../src/accounts/imageCapabilities';
import { ImageAssetStore } from '../src/images/imageAssetStore';
import { ImageJobStore, normalizeStoredImageJob } from '../src/images/imageJobStore';
import { ImageJobService } from '../src/images/imageJobService';
import type { ImageJobSpec, ImageJobScope } from '../src/images/types';
import { ImageController, summarizeImageJobs, validateImageMessage } from '../src/provider/imageController';
import type { ChangeSetStore } from '../src/edits/changeSetStore';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';

const SCOPE = { workspaceId: 'workspace:image-integration', sessionId: 'session-a' };
const SPEC: ImageJobSpec = {
  adapter: 'openai-images-v1', adapterVersion: 1, sourceId: 'images', endpoint: 'https://api.openai.com/v1',
  model: 'gpt-image-2.5-sunburst', operation: 'generate', prompt: 'A blue icon', inputAssets: [],
  size: '1024x1024', quality: 'medium', background: 'opaque', outputFormat: 'png', n: 1
};

test('image host validates bounded message types before entering any task or file operation', () => {
  const valid = { type: 'imageSubmit', sessionId: SCOPE.sessionId, actionId: 'click-1', sourceId: 'images', modelId: SPEC.model,
    prompt: SPEC.prompt, size: SPEC.size, quality: SPEC.quality, background: SPEC.background, outputFormat: SPEC.outputFormat };
  assert.ok(validateImageMessage(valid));
  for (const invalid of [
    null, [], {}, { ...valid, sessionId: '' }, { ...valid, prompt: 'x'.repeat(32_001) },
    { ...valid, size: ['1024x1024'] }, { ...valid, quality: { toString: () => 'medium' } },
    { ...valid, inputAssetId: ['asset'] }, { ...valid, parentJobId: 7 },
    { type: 'imageJobAction', sessionId: SCOPE.sessionId, jobId: 'job', action: ['open'] }
  ]) assert.equal(validateImageMessage(invalid), undefined);
});

test('persisted image activity restores through host with only the current session resource root and bounded metadata', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-image-integration-'));
  let controller: ImageController | undefined;
  let service: ImageJobService | undefined;
  try {
    const uri = vscode.Uri.file(directory), assets = new ImageAssetStore(uri), store = new ImageJobStore(uri);
    let creates = 0;
    service = new ImageJobService({ store, assets, validateBeforeSubmit: async () => undefined,
      adapter: { create: async () => {
        creates++;
        return { bytes: png(), mimeType: 'image/png', requestId: 'req_restore', usage: { inputTokens: 2, outputTokens: 3, apiKey: 'must-be-discarded' },
          cost: { status: 'calculated', currency: 'USD', amount: 0.5, pricingVersion: 'test-v1' } };
      } }
    });
    await assert.rejects(service.submit({ scope: SCOPE, actionId: 'invalid', spec: { ...SPEC, apiKey: 'must-be-rejected' }, maxCost: 0 }), /unsupported_parameter/u);
    assert.equal(creates, 0);
    const job = await service.submit({ scope: SCOPE, actionId: 'click-restore', spec: SPEC, maxCost: 0 });
    await service.waitForIdle();
    const saved = (await store.get(SCOPE, job.jobId))!;
    assert.equal(saved.status, 'saved');
    assert.equal(creates, 1);
    const clean = normalizeStoredImageJob({ ...saved, apiKey: 'must-be-discarded', b64_json: 'must-be-discarded',
      signedUrl: 'https://cdn.example/image?signature=must-be-discarded' })!;
    assert.equal('apiKey' in clean, false);
    assert.equal('b64_json' in clean, false);
    assert.equal('signedUrl' in clean, false);
    assert.equal('apiKey' in clean.spec, false);
    assert.equal('apiKey' in clean.usage!, false);
    assert.deepEqual(Object.keys(clean.spec).sort(), ['adapter', 'adapterVersion', 'background', 'endpoint', 'inputAssets', 'model', 'n', 'operation', 'outputFormat', 'prompt', 'quality', 'size', 'sourceId'].sort());
    const scopesDir = path.join(directory, 'image-jobs-v1', 'sessions');
    const [scopeDir] = await readdir(scopesDir);
    const disk = JSON.parse(await readFile(path.join(scopesDir, scopeDir, job.jobId + '.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('bytes' in disk, false);
    assert.equal('b64_json' in disk, false);
    assert.equal('apiKey' in disk, false);

    let scope: ImageJobScope = { ...SCOPE };
    const messages: Record<string, unknown>[] = [];
    const extensionUri = vscode.Uri.file(path.join(directory, 'extension'));
    const view = { webview: {
      options: { localResourceRoots: [extensionUri] },
      postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; },
      asWebviewUri: (resource: vscode.Uri) => resource
    } } as unknown as vscode.WebviewView;
    controller = new ImageController({ globalStorageUri: uri, extensionUri, sources: new ModelSourceStore(uri),
      changeSets: {} as ChangeSetStore, views: () => [view], scope: () => scope, t: (key) => key, onChange: () => undefined });
    controller.syncScope();
    await controller.handle({ type: 'imageStateRequest', sessionId: SCOPE.sessionId });
    const state = messages.filter((message) => message.type === 'imageState' && Array.isArray(message.jobs)).at(-1)!;
    const jobs = state.jobs as Array<Record<string, unknown>>;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, job.jobId);
    const result = jobs[0].resultAsset as Record<string, unknown>;
    assert.equal(typeof result.uri, 'string');
    assert.equal('bytes' in result, false);
    assert.equal('b64_json' in result, false);
    assert.equal(creates, 1, 'restoring cards must never call paid creation');
    // A repeated click is an inspection of the original action, even if the
    // account was removed after submission; it must not resolve new credentials.
    await controller.handle({ type: 'imageSubmit', sessionId: SCOPE.sessionId, actionId: saved.actionId,
      sourceId: SPEC.sourceId, modelId: SPEC.model, prompt: SPEC.prompt, size: SPEC.size,
      quality: SPEC.quality, background: SPEC.background, outputFormat: SPEC.outputFormat });
    assert.equal(messages.filter((message) => message.type === 'imageSubmitFeedback').at(-1)?.jobId, saved.jobId);
    assert.equal(creates, 1);
    const released = { ...saved, budget: { ...saved.budget, settlement: undefined, reservationState: 'released' as const } };
    const cny = { ...saved, budget: { ...saved.budget, settlement: { status: 'calculated' as const, currency: 'CNY', amount: 2, pricingVersion: 'test' } } };
    const unknown = { ...saved, budget: { ...saved.budget, settlement: undefined, reservationState: 'held' as const } };
    assert.deepEqual({ ...summarizeImageJobs([saved, cny, unknown, released]).costs }, { USD: 0.5, CNY: 2 });
    assert.equal(summarizeImageJobs([saved, cny, unknown, released]).unknownCosts, 1);
    const rootsA = view.webview.options.localResourceRoots!.map(String);
    assert.deepEqual(rootsA, [extensionUri.toString(), assets.getProjectionRoot(SCOPE).toString()]);
    assert.equal(rootsA.includes(uri.toString()), false, 'globalStorage must never become a webview resource root');

    const mutableWindow = vscode.window as unknown as { createWebviewPanel?: (...args: unknown[]) => unknown };
    const previousCreate = mutableWindow.createWebviewPanel;
    let previewOptions: { enableScripts?: boolean; localResourceRoots?: vscode.Uri[] } | undefined;
    let closed = false;
    let onClose: (() => void) | undefined;
    const panel = { webview: { html: '', cspSource: 'vscode-webview:', asWebviewUri: (resource: vscode.Uri) => resource },
      onDidDispose: (listener: () => void) => { onClose = listener; return { dispose: () => undefined }; },
      dispose: () => { closed = true; onClose?.(); }, reveal: () => undefined };
    mutableWindow.createWebviewPanel = (_type, _title, _column, options) => { previewOptions = options as typeof previewOptions; return panel; };
    try {
      await controller.handle({ type: 'imageJobAction', sessionId: SCOPE.sessionId, jobId: saved.jobId, action: 'open' });
      assert.equal(previewOptions?.enableScripts, false, 'full-size viewing must never expose an editable original blob');
      assert.deepEqual(previewOptions?.localResourceRoots?.map(String), [assets.getProjectionRoot(SCOPE).toString()]);
      assert.match(panel.webview.html, /default-src 'none'/u);
      assert.match(panel.webview.html, /<img\b/u);
      assert.equal(panel.webview.html.includes('<script'), false);
      assert.equal(panel.webview.html.includes(png().toString('base64')), false);
      assert.equal(panel.webview.html.includes('/blobs/'), false);
      scope = { ...SCOPE, sessionId: 'session-b' };
      controller.syncScope();
      assert.equal(closed, true, 'session change closes an already opened private image viewer');
    } finally {
      if (previousCreate) mutableWindow.createWebviewPanel = previousCreate;
      else delete mutableWindow.createWebviewPanel;
    }

    assert.deepEqual(view.webview.options.localResourceRoots!.map(String), [extensionUri.toString()], 'session change revokes previous access synchronously');
    await controller.handle({ type: 'imageStateRequest', sessionId: SCOPE.sessionId });
    assert.equal(messages.at(-1)?.error, 'imageInvalidMessage');
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId });
    const rootsB = view.webview.options.localResourceRoots!.map(String);
    assert.equal(rootsB.includes(assets.getProjectionRoot(SCOPE).toString()), false);
    assert.deepEqual((messages.filter((message) => message.sessionId === 'session-b' && Array.isArray(message.jobs)).at(-1)?.jobs), []);
    const summary = summarizeImageJobs([saved]);
    assert.deepEqual({ ...summary, costs: { ...summary.costs } }, { jobs: 1, images: 1, unknownCosts: 0, costs: { USD: 0.5 } });

    await store.transaction(async (tx) => {
      for (let index = 1; index <= 50; index++) {
        const actionId = 'history-' + index, jobId = store.actionJobId(SCOPE, actionId);
        await tx.write({ ...saved, revision: 0, actionId, jobId, createdAt: new Date(Date.parse(saved.createdAt) + index).toISOString(),
          budget: { ...saved.budget, domain: 'manual-image:' + jobId } });
      }
    });
    scope = { ...SCOPE };
    controller.syncScope();
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId, page: 0 });
    const firstPage = messages.filter((message) => message.sessionId === scope.sessionId && Array.isArray(message.jobs)).at(-1)!;
    assert.equal(firstPage.totalJobs, 51);
    assert.equal(firstPage.hasOlder, true);
    assert.equal((firstPage.jobs as unknown[]).length, 50);
    assert.equal((firstPage.jobs as Array<{ actionId: string }>)[0].actionId, 'history-50');
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId, page: 1 });
    const olderPage = messages.filter((message) => message.sessionId === scope.sessionId && Array.isArray(message.jobs)).at(-1)!;
    assert.equal(olderPage.page, 1);
    assert.equal(olderPage.hasOlder, false);
    assert.deepEqual((olderPage.jobs as Array<{ jobId: string }>).map((entry) => entry.jobId), [saved.jobId], 'oldest durable result remains reachable through a bounded page');
    assert.equal(creates, 1);
  } finally {
    controller?.dispose(); service?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('image-capable account metadata preserves all three pure-text projection bytes and tool schemas', () => {
  const base = { id: 'gpt-text', label: 'Text', provider: 'openai-compatible', sourceId: 'text', contextWindowTokens: 128_000, maxOutputTokens: 8192 };
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
    const input = { model: { ...base, provider }, agentSettings: { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const },
      contextFiles: [], history: [{ id: 'u1', role: 'user' as const, content: 'Keep my exact text.', createdAt: '2026-11-02T00:00:00.000Z' }],
      language: 'en' as const, prompt: 'Continue', contextInstructions: 'Stable project instructions.', provider, sourceId: 'text', baseUrl: provider === 'anthropic-compatible' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1' };
    const before = buildProviderRequestProjection(input);
    const withImageCatalogMetadata = buildProviderRequestProjection({ ...input, model: { ...input.model, imageCapabilities: getImageModelCapabilities(SPEC.model) } });
    assert.equal(JSON.stringify(withImageCatalogMetadata), JSON.stringify(before));
    assert.equal(before.messages.some((message) => String(message.content).includes(SPEC.prompt)), false);
    assert.equal(before.toolNames.some((name) => /image|generate/iu.test(name)), false);
  }
});

test('nested scope transitions revoke immediately and reject late state delivery until the final transition ends', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-image-scope-transition-'));
  let controller: ImageController | undefined;
  let release!: () => void;
  let entered!: () => void;
  let delayed = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  try {
    const uri = vscode.Uri.file(directory), extensionUri = vscode.Uri.file(path.join(directory, 'extension'));
    class DelayedSources extends ModelSourceStore {
      public override async listSources() {
        if (delayed) { entered(); await gate; }
        return [];
      }
    }
    let scope = { ...SCOPE };
    const messages: Record<string, unknown>[] = [];
    const view = { webview: { options: { localResourceRoots: [extensionUri] },
      postMessage: async (message: Record<string, unknown>) => { messages.push(message); return true; }, asWebviewUri: (resource: vscode.Uri) => resource } } as unknown as vscode.WebviewView;
    controller = new ImageController({ globalStorageUri: uri, extensionUri, sources: new DelayedSources(uri), changeSets: {} as ChangeSetStore,
      views: () => [view], scope: () => scope, t: (key) => key, onChange: () => undefined });
    controller.syncScope();
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId });
    delayed = true;
    const stale = controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId });
    await started;
    controller.beginScopeTransition();
    controller.beginScopeTransition();
    assert.deepEqual(view.webview.options.localResourceRoots!.map(String), [extensionUri.toString()]);
    controller.syncScope(true);
    controller.endScopeTransition();
    assert.deepEqual(view.webview.options.localResourceRoots!.map(String), [extensionUri.toString()], 'an inner transition must not reauthorize the pending outer transition');
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId });
    const count = messages.length;
    delayed = false;
    release();
    await stale;
    assert.equal(messages.length, count, 'the pre-transition async refresh must not deliver its old scope');
    assert.deepEqual(view.webview.options.localResourceRoots!.map(String), [extensionUri.toString()]);
    scope = { ...SCOPE, sessionId: 'session-b' };
    controller.endScopeTransition();
    await controller.handle({ type: 'imageStateRequest', sessionId: scope.sessionId });
    assert.deepEqual(view.webview.options.localResourceRoots!.map(String), [extensionUri.toString(), new ImageAssetStore(uri).getProjectionRoot(scope).toString()]);
    assert.equal(messages.at(-1)?.sessionId, 'session-b');
  } finally {
    release(); controller?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

function png(): Buffer {
  const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 255, 255]))), chunk('IEND', Buffer.alloc(0))]);
}
function chunk(type: string, bytes: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), bytes]); let crc = 0xffffffff;
  for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  const result = Buffer.alloc(bytes.length + 12); result.writeUInt32BE(bytes.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
}
