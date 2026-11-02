import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ModelSourceStore } from '../accounts/accountStore';
import { createImageModelCatalog, resolveImageModelSourceConfig } from '../accounts/imageModels';
import { ImageAssetStore } from '../images/imageAssetStore';
import { IMAGE_MAX_BYTES } from '../images/imageValidation';
import { ImageJobStore } from '../images/imageJobStore';
import { ImageJobService } from '../images/imageJobService';
import { OpenAIImagesAdapter } from '../images/openaiImagesAdapter';
import type { ImageJob, ImageJobScope } from '../images/types';
import { ChangeArtifactStore } from '../edits/changeArtifactStore';
import { prepareBinaryImageDraft } from '../edits/binaryImageDraft';
import { assertBinaryImageWorkspaceTarget } from '../edits/safeFileEditor';
import type { ChangeSetStore } from '../edits/changeSetStore';
import { getConfiguredAgentMaxCost, getConfiguredModelRequestTimeoutMs, getSelectedImageModelSelection, setSelectedImageModelSelection } from '../shared/config';
import type { WebviewMessage } from './webviewMessages';

type Translator = (key: string, values?: Record<string, string | number>) => string;
interface ImageControllerOptions {
  globalStorageUri: vscode.Uri;
  extensionUri: vscode.Uri;
  sources: ModelSourceStore;
  changeSets: ChangeSetStore;
  views: () => Iterable<vscode.WebviewView>;
  scope: () => ImageJobScope;
  t: Translator;
  onChange: () => void;
}

/** Independent activity coordinator. It never writes Provider messages or acquires the text run lock. */
export class ImageController {
  private readonly assets: ImageAssetStore;
  private readonly service: ImageJobService;
  private readonly initialized: Promise<void>;
  private scopeKey = '';
  private generation = 0;
  private refreshSequence = 0;
  private disposed = false;
  private suspended = false;
  private scopeTransitions = 0;
  private page = 0;
  private draftAssetId?: string;
  private readonly imagePanels = new Set<vscode.WebviewPanel>();
  private readonly preparing = new Set<string>();

  public constructor(private readonly options: ImageControllerOptions) {
    this.assets = new ImageAssetStore(options.globalStorageUri);
    const adapter = new OpenAIImagesAdapter({
      resolveSource: async (sourceId) => {
        const { source, model } = await resolveImageModelSourceConfig(
          { sourceId, modelId: 'gpt-image-2.5-sunburst' }, options.globalStorageUri, { sourceStore: options.sources }
        );
        return { sourceId: source.sourceId, apiKey: source.apiKey, baseUrl: model.endpointId };
      },
      timeoutMs: getConfiguredModelRequestTimeoutMs
    });
    this.service = new ImageJobService({
      store: new ImageJobStore(options.globalStorageUri), assets: this.assets, adapter,
      validateBeforeSubmit: async (spec) => {
        if (!vscode.workspace.isTrusted) throw new Error('image_workspace_untrusted');
        const { model } = await resolveImageModelSourceConfig(
          { sourceId: spec.sourceId, modelId: spec.model }, options.globalStorageUri, { sourceStore: options.sources }
        );
        if (model.endpointId !== spec.endpoint || model.capabilities.adapter !== spec.adapter) throw new Error('image_source_changed');
      },
      onEvent: (job) => {
        if (!this.suspended && this.sameScope(job.scope)) void this.refresh().catch(() => undefined);
      }
    });
    // Capture initialization failure for the explicit UI request; never leave an unhandled rejection.
    this.initialized = this.service.initialize();
    void this.initialized.catch(() => undefined);
  }

  public dispose(): void { this.disposed = true; this.revokeScope(); this.service.dispose(); }

  public revokeScope(): void {
    this.suspended = true;
    this.generation++;
    for (const panel of this.imagePanels) panel.dispose();
    this.imagePanels.clear();
    for (const view of this.options.views()) this.setRoots(view);
  }

  public beginScopeTransition(): void { this.scopeTransitions++; this.revokeScope(); }
  public endScopeTransition(): void { this.scopeTransitions = Math.max(0, this.scopeTransitions - 1); this.syncScope(); }

  /** Synchronously revoke the previous session before doing any async I/O. */
  public syncScope(force = false): void {
    if (this.disposed || this.scopeTransitions > 0) return;
    const key = JSON.stringify(this.options.scope());
    if (!force && !this.suspended && key === this.scopeKey) return;
    if (key !== this.scopeKey) { this.page = 0; this.draftAssetId = undefined; }
    this.revokeScope();
    this.suspended = false;
    this.scopeKey = key;
    this.generation++;
    for (const view of this.options.views()) this.setRoots(view);
    void this.refresh().catch(() => undefined);
  }

  public async handle(value: unknown): Promise<void> {
    const message = validateImageMessage(value);
    if (this.suspended || !message || !this.sameScope({ ...this.options.scope(), sessionId: message.sessionId })) {
      this.broadcast({ type: 'imageState', sessionId: this.options.scope().sessionId, error: this.options.t('imageInvalidMessage') });
      return;
    }
    const scope = { ...this.options.scope() };
    try {
      await this.initialized;
      if (this.suspended || !this.sameScope(scope)) return;
      switch (message.type) {
        case 'imageStateRequest': {
          if (message.page !== undefined) this.page = message.page;
          if (message.inputAssetId !== undefined) {
            await this.assets.getMetadata(scope, message.inputAssetId);
            this.draftAssetId = message.inputAssetId;
          }
          await this.refresh(); return;
        }
        case 'imageSelectModel': {
          const catalog = createImageModelCatalog(await this.options.sources.listSources());
          if (!catalog.some((model) => model.sourceId === message.sourceId && model.modelId === message.modelId && model.available)) throw new Error('image_model_unavailable');
          await setSelectedImageModelSelection({ sourceId: message.sourceId, modelId: message.modelId });
          await this.refresh(); return;
        }
        case 'imageImport': await this.importImage(scope); return;
        case 'imageSubmit': {
          const existing = await this.service.getByAction(scope, message.actionId);
          if (existing) {
            const spec = existing.spec;
            if (spec.sourceId !== message.sourceId || spec.model !== message.modelId
              || spec.prompt !== message.prompt.replace(/\r\n?/gu, '\n').trim() || spec.size !== message.size
              || spec.quality !== message.quality || spec.background !== message.background || spec.outputFormat !== message.outputFormat
              || spec.inputAssets[0]?.assetId !== message.inputAssetId || existing.parentJobId !== message.parentJobId) throw new Error('image_action_changed');
            this.page = 0;
            this.broadcast({ type: 'imageSubmitFeedback', sessionId: scope.sessionId, actionId: message.actionId, jobId: existing.jobId });
            await this.refresh(); return;
          }
          const { model } = await resolveImageModelSourceConfig(
            { sourceId: message.sourceId, modelId: message.modelId }, this.options.globalStorageUri, { sourceStore: this.options.sources }
          );
          const input = message.inputAssetId ? await this.assets.get(scope, message.inputAssetId) : undefined;
          const job = await this.service.submit({
            scope, actionId: message.actionId, parentJobId: message.parentJobId,
            maxCost: getConfiguredAgentMaxCost(),
            spec: {
              adapter: 'openai-images-v1', adapterVersion: 1, sourceId: model.sourceId, endpoint: model.endpointId,
              model: model.modelId, operation: input ? 'edit' : 'generate', prompt: message.prompt,
              inputAssets: input ? [{ assetId: input.asset.assetId, hash: input.asset.hash }] : [],
              size: message.size, quality: message.quality, background: message.background, outputFormat: message.outputFormat, n: 1
            }
          });
          this.page = 0;
          this.broadcast({ type: 'imageSubmitFeedback', sessionId: scope.sessionId, actionId: message.actionId, jobId: job.jobId });
          await this.refresh(); return;
        }
        case 'imageJobAction': {
          const job = await this.service.get(scope, message.jobId);
          if (!job) throw new Error('image_job_not_found');
          if (message.action === 'stop') await this.service.stop(scope, job.jobId);
          else if (message.action === 'retrieve') await this.service.retryRetrieval(scope, job.jobId);
          else if (message.action === 'prepareWrite') await this.prepareWrite(scope, job);
          else if (message.action === 'open') await this.openImage(scope, job);
          await this.refresh(); return;
        }
      }
    } catch (error) {
      const code = errorCode(error);
      if (message.type === 'imageSubmit') this.broadcast({ type: 'imageSubmitFeedback', sessionId: scope.sessionId, actionId: message.actionId, errorCode: code, error: this.errorText(code) });
      else this.broadcast({ type: 'imageState', sessionId: scope.sessionId, errorCode: code, error: this.errorText(code) });
    }
  }

  private async refresh(): Promise<void> {
    if (this.suspended || this.disposed) return;
    const scope = { ...this.options.scope() }, generation = this.generation, refreshSequence = ++this.refreshSequence;
    try {
      await this.initialized;
      const [sources, allJobs] = await Promise.all([this.options.sources.listSources(), this.service.list(scope)]);
      // Bounded UI projection; complete records remain available on disk. No image bytes travel in messages.
      const page = Math.min(this.page, Math.max(0, Math.ceil(allJobs.length / 50) - 1));
      const jobs = [...allJobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(page * 50, (page + 1) * 50);
      const assetIds = [...new Set([...jobs.flatMap((job) => [job.resultAssetId, ...job.spec.inputAssets.map((ref) => ref.assetId)]), this.draftAssetId].filter((id): id is string => !!id))];
      const projected = new Map<string, { asset: Awaited<ReturnType<ImageAssetStore['getMetadata']>>; uri: vscode.Uri }>();
      for (const id of assetIds) {
        try { const p = await this.assets.createProjection(scope, [id]); if (p.assets[0]) projected.set(id, p.assets[0]); }
        catch { /* A damaged/missing image is a card placeholder, never a dropped job. */ }
      }
      if (this.disposed || this.suspended || generation !== this.generation || refreshSequence !== this.refreshSequence || !this.sameScope(scope)) return;
      const models = createImageModelCatalog(sources), configured = getSelectedImageModelSelection();
      const selection = models.find((model) => model.sourceId === configured.sourceId && model.modelId === configured.modelId)
        ?? models.find((model) => model.available);
      const totals = summarizeImageJobs(allJobs);
      for (const view of this.options.views()) {
        this.setRoots(view, this.assets.getProjectionRoot(scope));
        const assetView = (id?: string) => {
          const p = id ? projected.get(id) : undefined;
          return p ? { ...p.asset, uri: String(view.webview.asWebviewUri(p.uri)) } : undefined;
        };
        void view.webview.postMessage({
          type: 'imageState', sessionId: scope.sessionId, models,
          page, hasOlder: (page + 1) * 50 < allJobs.length, totalJobs: allJobs.length,
          selectedSourceId: selection?.sourceId ?? '', selectedModelId: selection?.modelId ?? '',
          costLimit: getConfiguredAgentMaxCost(), totals,
          activeJobId: allJobs.find((job) => ['preparing', 'submitting', 'accepted', 'generating'].includes(job.status))?.jobId,
          assets: [...projected.keys()].map(assetView),
          jobs: jobs.map((job) => ({
            ...job, error: job.error ? { code: job.error.code, message: this.errorText(job.error.code) } : undefined,
            canRetrieve: job.status === 'generated',
            resultAsset: assetView(job.resultAssetId), inputAsset: assetView(job.spec.inputAssets[0]?.assetId),
            resultError: job.resultAssetId && !projected.has(job.resultAssetId) ? this.options.t('imageAssetUnavailable') : undefined
          }))
        });
      }
    } catch (error) {
      if (!this.suspended && generation === this.generation && refreshSequence === this.refreshSequence && this.sameScope(scope)) this.broadcast({ type: 'imageState', sessionId: scope.sessionId, error: this.errorText(errorCode(error)) });
    }
  }

  private async importImage(scope: ImageJobScope): Promise<void> {
    const generation = this.generation;
    const selected = await vscode.window.showOpenDialog({ title: this.options.t('imageImportTitle'), canSelectMany: false, canSelectFolders: false, filters: { Images: ['png', 'jpg', 'jpeg', 'webp'] } });
    if (!selected?.length) return;
    if (selected.length !== 1 || !this.interactiveScope(scope, generation)) throw new Error('image_invalid_input');
    const uri = selected[0]; // The native picker grants this exact URI, never its directory or siblings.
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File || stat.size > IMAGE_MAX_BYTES) throw new Error('image_too_large');
    const mime = mimeFromExtension(uri.path);
    const asset = await this.assets.put(scope, await vscode.workspace.fs.readFile(uri), { source: 'import', fileName: path.posix.basename(uri.path), mime });
    if (this.interactiveScope(scope, generation)) this.draftAssetId = asset.assetId;
    const projection = await this.assets.createProjection(scope, [asset.assetId]);
    if (!this.interactiveScope(scope, generation)) return;
    for (const view of this.options.views()) {
      this.setRoots(view, projection.rootUri);
      void view.webview.postMessage({ type: 'imageImported', sessionId: scope.sessionId, asset: { ...asset, uri: String(view.webview.asWebviewUri(projection.assets[0].uri)) } });
    }
  }

  private async openImage(scope: ImageJobScope, job: ImageJob): Promise<void> {
    const generation = this.generation;
    if (!job.resultAssetId) throw new Error('asset_missing');
    const projection = await this.assets.createProjection(scope, [job.resultAssetId]);
    if (!this.interactiveScope(scope, generation)) return;
    for (const previous of this.imagePanels) previous.dispose();
    this.imagePanels.clear();
    const panel = vscode.window.createWebviewPanel('keepseek.imageResult', this.options.t('imageOpen'), vscode.ViewColumn.Active, {
      enableScripts: false, localResourceRoots: [projection.rootUri]
    });
    this.imagePanels.add(panel);
    const uri = panel.webview.asWebviewUri(projection.assets[0].uri);
    const alt = this.options.t('imageResultAlt', { prompt: job.spec.prompt.slice(0, 160) });
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src 'unsafe-inline';"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{margin:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background)}img{display:block;max-width:100%;height:auto;margin:auto}p{overflow-wrap:anywhere}</style></head><body><img src="${escapeHtml(String(uri))}" alt="${escapeHtml(alt)}"><p>${projection.assets[0].asset.width} × ${projection.assets[0].asset.height} · ${projection.assets[0].asset.byteLength} B</p></body></html>`;
    panel.onDidDispose(() => this.imagePanels.delete(panel));
  }

  private async prepareWrite(scope: ImageJobScope, job: ImageJob): Promise<void> {
    if (!job.resultAssetId || this.preparing.has(job.jobId)) return;
    this.preparing.add(job.jobId);
    const generation = this.generation;
    try {
      if (!vscode.workspace.isTrusted) throw new Error('image_workspace_untrusted');
      const { asset, bytes } = await this.assets.get(scope, job.resultAssetId);
      const pending = this.options.changeSets.toWebviewState(scope.sessionId).find((change) => change.runId === job.jobId && change.files.some((file) => !['applied', 'reverted', 'discarded', 'superseded'].includes(file.status)));
      if (pending) { await this.options.changeSets.openDiff(pending.files[0].id); return; }
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      const extension = asset.mime === 'image/jpeg' ? 'jpg' : asset.mime.split('/')[1];
      const target = await vscode.window.showSaveDialog({ title: this.options.t('imageWriteTitle'), defaultUri: root ? vscode.Uri.joinPath(root, `image.${extension}`) : undefined, filters: { Images: [extension] } });
      if (!target) return;
      if (!this.interactiveScope(scope, generation) || target.scheme !== 'file' || !vscode.workspace.getWorkspaceFolder(target)) throw new Error('image_workspace_target_only');
      await assertBinaryImageWorkspaceTarget(target);
      if (mimeFromExtension(target.path) !== asset.mime) throw new Error('image_invalid_input');
      let baseBytes: Uint8Array | undefined;
      try {
        const stat = await vscode.workspace.fs.stat(target);
        if (stat.type !== vscode.FileType.File || stat.size > IMAGE_MAX_BYTES) throw new Error('image_too_large');
        baseBytes = await vscode.workspace.fs.readFile(target);
      } catch (error) { if (!isNotFound(error)) throw error; }
      const edit = await prepareBinaryImageDraft({
        uri: target.toString(), label: vscode.workspace.asRelativePath(target), reason: this.options.t('imageWriteReason'),
        bytes, mimeType: asset.mime, width: asset.width, height: asset.height,
        assetId: asset.assetId, assetHash: asset.hash, baseBytes
      }, new ChangeArtifactStore(this.options.globalStorageUri));
      if (!this.interactiveScope(scope, generation)) throw new Error('image_invalid_scope');
      this.options.changeSets.addDraftEdits({ edits: [edit], runId: job.jobId, sessionId: scope.sessionId, operationSummary: this.options.t('imageNotSaved') });
      await this.options.changeSets.flush();
      this.options.onChange();
      await this.options.changeSets.openDiff(edit.id);
    } finally { this.preparing.delete(job.jobId); }
  }

  private sameScope(scope: ImageJobScope): boolean {
    const current = this.options.scope();
    return current.workspaceId === scope.workspaceId && current.sessionId === scope.sessionId;
  }
  private interactiveScope(scope: ImageJobScope, generation: number): boolean { return !this.disposed && !this.suspended && this.generation === generation && this.sameScope(scope); }
  private setRoots(view: vscode.WebviewView, projection?: vscode.Uri): void {
    view.webview.options = { ...view.webview.options, localResourceRoots: [this.options.extensionUri, ...(projection ? [projection] : [])] };
  }
  private broadcast(message: unknown): void { if (!this.disposed) for (const view of this.options.views()) void view.webview.postMessage(message); }
  private errorText(code: string): string {
    if (/^imageWrite[A-Za-z]+$/u.test(code)) return this.options.t(code);
    const key = code === 'image_workspace_untrusted' ? 'imageWorkspaceUntrusted'
      : code === 'image_storage_scheme_unsupported' || code === 'asset_storage_unsupported' ? 'imageStorageSchemeUnsupported'
        : code === 'image_local_result_pending' ? 'imageErrorLocalPending'
          : code === 'image_job_history_limit' ? 'imageHistoryFull'
            : code === 'image_result_not_queryable' ? 'imageUnknownResult'
              : code === 'image_authentication' || code === 'missing_api_key' ? 'imageErrorAuthentication'
      : code.includes('quota') && !code.includes('asset') ? 'imageErrorQuota'
        : code.includes('rate_limit') ? 'imageErrorRateLimit'
          : code.includes('source_changed') ? 'imageErrorSourceChanged'
            : code.includes('source') || code.includes('model_unavailable') || code.includes('model_not_configured') ? 'imageNoModel'
              : code.includes('unsupported') || code.includes('invalid_spec') ? 'imageErrorUnsupported'
                : code.includes('input') || code.includes('too_large') || code.includes('image_invalid') ? 'imageErrorInput'
                  : code.includes('response') || code.includes('result_count') || code.includes('output') ? 'imageErrorResult'
                    : code.includes('save_failed') || code.includes('storage') || code === 'asset_quota' ? 'imageErrorStorage'
                      : code.includes('cost') || code.includes('budget') ? 'imageCostBlocked'
      : code.includes('active') || code === 'image_storage_busy' ? 'imageOneActive'
        : code.includes('unknown') || code === 'image_result_unrecoverable' ? 'imageUnknownResult'
          : code.includes('asset') ? 'imageAssetUnavailable'
            : code === 'image_workspace_target_only' ? 'imageWriteWorkspaceOnly'
              : 'imageHostFailure';
    return this.options.t(key);
  }
}

export function summarizeImageJobs(jobs: readonly ImageJob[]): { jobs: number; images: number; unknownCosts: number; costs: Record<string, number> } {
  const costs: Record<string, number> = Object.create(null) as Record<string, number>;
  let unknownCosts = 0;
  for (const job of jobs) {
    const cost = job.budget.settlement;
    if (cost?.status === 'calculated' && cost.amount !== undefined) costs[cost.currency] = (costs[cost.currency] ?? 0) + cost.amount;
    else if (job.budget.reservationState !== 'released') unknownCosts++;
  }
  return { jobs: jobs.length, images: jobs.filter((job) => job.status === 'saved').length, unknownCosts, costs };
}

type ImageMessage = Extract<WebviewMessage, { type: 'imageStateRequest' | 'imageImport' | 'imageSubmit' | 'imageSelectModel' | 'imageJobAction' }>;
/** Runtime boundary; a TypeScript union alone does not validate postMessage data. */
export function validateImageMessage(value: unknown): ImageMessage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const short = (key: string, limit = 256) => typeof v[key] === 'string' && !!(v[key] as string).trim() && (v[key] as string).length <= limit;
  if (!short('sessionId')) return undefined;
  if (v.type === 'imageStateRequest') return (v.page === undefined || typeof v.page === 'number' && Number.isInteger(v.page) && v.page >= 0 && v.page <= 9)
    && (v.inputAssetId === undefined || short('inputAssetId', 128)) ? v as ImageMessage : undefined;
  if (v.type === 'imageImport') return v as ImageMessage;
  if (v.type === 'imageSelectModel') return short('sourceId') && short('modelId', 512) ? v as ImageMessage : undefined;
  if (v.type === 'imageJobAction') return short('jobId', 128) && typeof v.action === 'string' && ['open', 'stop', 'prepareWrite', 'retrieve'].includes(v.action) ? v as ImageMessage : undefined;
  if (v.type !== 'imageSubmit' || !short('sourceId') || !short('modelId', 512) || !short('actionId', 128)
    || !short('prompt', 32_000) || typeof v.size !== 'string' || !['1024x1024', '1536x1024', '1024x1536'].includes(v.size)
    || typeof v.quality !== 'string' || !['low', 'medium', 'high'].includes(v.quality) || typeof v.background !== 'string' || !['opaque', 'transparent'].includes(v.background)
    || typeof v.outputFormat !== 'string' || !['png', 'jpeg', 'webp'].includes(v.outputFormat)
    || (v.inputAssetId !== undefined && !short('inputAssetId', 128)) || (v.parentJobId !== undefined && !short('parentJobId', 128))) return undefined;
  return v as ImageMessage;
}

function mimeFromExtension(file: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  throw new Error('image_invalid_input');
}
function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && /^[a-z_]+$/u.test(error.message) ? error.message : 'image_host_failure';
}
function isNotFound(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && ['FileNotFound', 'ENOENT'].includes(String(error.code)); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
