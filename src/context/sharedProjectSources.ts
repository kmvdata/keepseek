import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { ProjectInstructionsResolver, type ProjectInstructionsResolution } from '../agent/projectInstructions';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { loadSharedCodexConfig, type SharedCodexConfigSnapshot } from './sharedCodexConfig';
import { canonicalUri, codexHomeUri, projectSkillsUri, userSkillsUri } from './sharedConfigPaths';

const MAX_SOURCE_SNAPSHOTS = 4;
interface SourceSnapshot {
  config: SharedCodexConfigSnapshot;
  instructions: ProjectInstructionsResolution;
}

/** Project-local immutable read backend. It contains no selected session,
 * Skill activation, authorization, credential or mutable execution state. */
export class SharedProjectSourceCache {
  public revision = 0;
  public readonly snapshots = new Map<string, SourceSnapshot>();
  public readonly pending = new Map<string, Promise<SourceSnapshot>>();
  public readonly instructionSnapshots = new WeakMap<SharedCodexConfigSnapshot, ProjectInstructionsResolution>();
  private watchers: vscode.FileSystemWatcher[] = [];
  private readers = 0;
  public retain(): void { this.readers++; }
  public release(): void {
    if (--this.readers > 0) return;
    this.revision++; this.disposeWatchers(); this.snapshots.clear(); this.pending.clear();
  }
  public invalidate(): void { this.revision++; this.snapshots.clear(); }
  public watch(): void {
    this.disposeWatchers();
    if (!vscode.workspace.createFileSystemWatcher) return;
    const specs: Array<{ base: vscode.Uri; pattern: string }> = [];
    for (const { config } of this.snapshots.values()) {
      specs.push(...config.watchedUris.map(uri => ({ base: vscode.Uri.joinPath(vscode.Uri.parse(uri), '..'), pattern: vscode.Uri.parse(uri).path.split('/').at(-1)! })));
      for (const directory of config.scope?.chain ?? []) specs.push({ base: directory, pattern: '.git' });
      for (const directory of [config.codexHome, ...(config.scope?.chain ?? [])]) {
        for (const pattern of ['.codex', '.agents', '.agents/skills']) specs.push({ base: directory, pattern });
      }
      specs.push({ base: vscode.Uri.joinPath(config.codexHome, '..'), pattern: config.codexHome.path.split('/').at(-1)! });
      for (const root of [userSkillsUri(), ...(config.scope?.trusted ? config.scope.chain.map(projectSkillsUri) : []),
        ...(process.platform !== 'win32' ? [vscode.Uri.file('/etc/codex/skills')] : [])]) specs.push({ base: root, pattern: '**/*' });
    }
    const seen = new Set<string>();
    for (const spec of specs) {
      const key = `${spec.base.toString()}\0${spec.pattern}`;
      if (seen.has(key)) continue; seen.add(key);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(spec.base, spec.pattern));
      const dirty = () => { this.invalidate(); };
      watcher.onDidChange(dirty); watcher.onDidCreate(dirty); watcher.onDidDelete(dirty); this.watchers.push(watcher);
    }
  }
  private disposeWatchers(): void { for (const watcher of this.watchers) watcher.dispose(); this.watchers = []; }
}

/** Only immutable source reads are shared. Session activation and authorization never enter this cache. */
export class SharedProjectSources implements vscode.Disposable {
  public snapshot?: SharedCodexConfigSnapshot;
  public instructions: ProjectInstructionsResolution = { instructions: [], discarded: [] };
  public sessionId?: string;
  public readonly diagnostics = { hits: 0, misses: 0, merged: 0, stale: 0 };
  private invalidated = true;
  private publishedRevision = -1;
  private get sourceRevision(): number { return this.cache.revision; }
  private selection = 0;
  private disposed = false;
  public constructor(private readonly cache = new SharedProjectSourceCache()) { this.cache.retain(); }
  public createSibling(): SharedProjectSources {
    if (this.disposed) throw new Error('Project sources facade is disposed');
    return new SharedProjectSources(this.cache);
  }

  public get dirty(): boolean { return this.invalidated || this.publishedRevision !== this.sourceRevision; }
  public set dirty(value: boolean) {
    if (!value) return;
    this.invalidated = true;
    this.cache.invalidate();
    // Existing readers may finish, but their revision can no longer be published or cached.
  }

  public async refresh(sessionId: string, cwd?: string, options: { force?: boolean } = {}): Promise<SharedCodexConfigSnapshot> {
    if (options.force) this.dirty = true;
    const selection = ++this.selection;
    const revision = this.sourceRevision;
    const identity = await this.measure('source-identity', sessionId, () => this.identity(cwd));
    const key = `${revision}:${identity}`;
    let entry = this.cache.snapshots.get(key);
    if (entry) {
      this.diagnostics.hits++;
      this.cache.snapshots.delete(key); this.cache.snapshots.set(key, entry);
    } else {
      let task = this.cache.pending.get(key);
      if (task) this.diagnostics.merged++;
      else {
        this.diagnostics.misses++;
        task = this.read(cwd, sessionId);
        this.cache.pending.set(key, task);
      }
      try {
        entry = await task;
        if (this.disposed || revision !== this.sourceRevision || identity !== await this.identity(cwd)) {
          this.diagnostics.stale++;
          throw new Error('Project sources changed while loading; refresh to retry / 项目来源在加载期间变化，请刷新重试');
        }
        if (!this.disposed && revision === this.sourceRevision && !this.cache.snapshots.has(key)) {
          this.cache.snapshots.set(key, entry);
          while (this.cache.snapshots.size > MAX_SOURCE_SNAPSHOTS) this.cache.snapshots.delete(this.cache.snapshots.keys().next().value!);
          this.cache.watch();
        }
      } finally { if (this.cache.pending.get(key) === task) this.cache.pending.delete(key); }
    }
    if (!this.disposed && revision === this.sourceRevision && selection === this.selection) {
      this.snapshot = entry.config;
      this.instructions = entry.instructions;
      this.sessionId = sessionId;
      this.invalidated = false; this.publishedRevision = revision;
    } else this.diagnostics.stale++;
    return entry.config;
  }

  /** Constant-size path validation, never a recursive scan or file-body hash on a warm read. */
  private async identity(cwd?: string): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const target = cwd ? vscode.Uri.parse(cwd) : folders.length === 1 ? folders[0].uri : undefined;
    const real = async (uri?: vscode.Uri) => {
      if (!uri) return undefined;
      try { return (await canonicalUri(uri)).toString(); }
      catch { return `unavailable:${uri.toString()}`; }
    };
    const roots = await Promise.all(folders.map(async folder => [folder.uri.toString(), await real(folder.uri)]));
    const home = codexHomeUri();
    return createHash('sha256').update(JSON.stringify({ cwd: target?.toString(), realCwd: await real(target), roots,
      trusted: vscode.workspace.isTrusted, codexHome: home.toString(), realCodexHome: await real(home),
      maxFileBytes: getConfiguredMaxFileBytes() })).digest('hex');
  }

  private async read(cwd: string | undefined, sessionId: string): Promise<SourceSnapshot> {
    const config = await this.measure('shared-config', sessionId, () => loadSharedCodexConfig({ cwd: cwd ? vscode.Uri.parse(cwd) : undefined }));
    const instructions = await this.measure('project-instructions', sessionId, () => new ProjectInstructionsResolver().resolve({ snapshot: config }));
    // Resolution adds all candidate filenames, including missing overrides/fallbacks, before freezing.
    const result = freezeSourceData({ config, instructions });
    this.cache.instructionSnapshots.set(config, instructions);
    return result;
  }

  private async measure<T>(stage: string, sessionId: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const session = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
    const sourceRevision = this.sourceRevision;
    console.info('[KeepSeek] interaction_stage', { stage, session, sourceRevision, event: 'begin' });
    try {
      const value = await work();
      console.info('[KeepSeek] interaction_stage', { stage, session, sourceRevision,
        event: sourceRevision === this.sourceRevision && !this.disposed ? 'end' : 'stale', elapsedMs: Math.max(0, performance.now() - started) });
      return value;
    } catch (error) {
      console.info('[KeepSeek] interaction_stage', { stage, session, sourceRevision, event: 'failed', elapsedMs: Math.max(0, performance.now() - started) });
      throw error;
    }
  }

  /** Bind consumers to their owned read result rather than the mutable selected-session facade. */
  public getInstructions(snapshot: SharedCodexConfigSnapshot): ProjectInstructionsResolution {
    const instructions = this.cache.instructionSnapshots.get(snapshot);
    if (!instructions) throw new Error('Project source snapshot unavailable / 项目来源快照不可用');
    return instructions;
  }

  public matches(uri: string): boolean {
    const path = vscode.Uri.parse(uri).path;
    return Boolean(this.snapshot?.watchedUris.includes(uri)) || /\/(?:SKILL\.md|agents\/openai\.yaml|\.codex\/config\.toml|AGENTS(?:\.override)?\.md|\.git)$/u.test(path)
      || path.includes('/.agents/skills/');
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.selection++; this.cache.release();
  }
}

/** Freeze owned arrays/plain records; URI instances keep their implementation's lazy caches. */
function freezeSourceData<T>(value: T): T {
  if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const item of Object.values(value)) freezeSourceData(item);
    Object.freeze(value);
  }
  return value;
}
