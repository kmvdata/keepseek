import * as vscode from 'vscode';
import { ProjectInstructionsResolver, type ProjectInstructionsResolution } from '../agent/projectInstructions';
import { loadSharedCodexConfig, type SharedCodexConfigSnapshot } from './sharedCodexConfig';
import { projectSkillsUri, userSkillsUri } from './sharedConfigPaths';

/** One read-only source snapshot per selected session/scope. Only the host refresh boundary replaces it. */
export class SharedProjectSources implements vscode.Disposable {
  public snapshot?: SharedCodexConfigSnapshot;
  public instructions: ProjectInstructionsResolution = { instructions: [], discarded: [] };
  public sessionId?: string;
  public dirty = true;
  private watchers: vscode.FileSystemWatcher[] = [];
  private pending?: Promise<SharedCodexConfigSnapshot>;

  public async refresh(sessionId: string, cwd?: string): Promise<SharedCodexConfigSnapshot> {
    if (this.pending) await this.pending;
    const task = this.read(sessionId, cwd);
    this.pending = task;
    try { return await task; }
    finally { if (this.pending === task) this.pending = undefined; }
  }

  private async read(sessionId: string, cwd?: string): Promise<SharedCodexConfigSnapshot> {
    const snapshot = await loadSharedCodexConfig({ cwd: cwd ? vscode.Uri.parse(cwd) : undefined });
    const instructions = await new ProjectInstructionsResolver().resolve({ snapshot });
    this.snapshot = snapshot;
    this.instructions = instructions;
    this.sessionId = sessionId;
    this.dirty = false;
    this.watch(snapshot);
    return snapshot;
  }

  private watch(snapshot: SharedCodexConfigSnapshot): void {
    this.dispose();
    if (!vscode.workspace.createFileSystemWatcher) return;
    const specs = snapshot.watchedUris.map(uri => ({ base: vscode.Uri.joinPath(vscode.Uri.parse(uri), '..'), pattern: vscode.Uri.parse(uri).path.split('/').at(-1)! }));
    for (const root of [userSkillsUri(), ...(snapshot.scope?.trusted ? snapshot.scope.chain.map(projectSkillsUri) : []),
      ...(process.platform !== 'win32' ? [vscode.Uri.file('/etc/codex/skills')] : [])]) {
      specs.push({ base: root, pattern: '**/*' });
    }
    const seen = new Set<string>();
    for (const spec of specs) {
      const key = `${spec.base.toString()}\0${spec.pattern}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(spec.base, spec.pattern));
      const dirty = () => { this.dirty = true; };
      watcher.onDidChange(dirty); watcher.onDidCreate(dirty); watcher.onDidDelete(dirty);
      this.watchers.push(watcher);
    }
  }

  public matches(uri: string): boolean {
    const path = vscode.Uri.parse(uri).path;
    return Boolean(this.snapshot?.watchedUris.includes(uri)) || /\/(?:SKILL\.md|agents\/openai\.yaml|\.codex\/config\.toml|AGENTS(?:\.override)?\.md)$/u.test(path)
      || path.includes('/.agents/skills/');
  }

  public dispose(): void { for (const watcher of this.watchers) watcher.dispose(); this.watchers = []; }
}
