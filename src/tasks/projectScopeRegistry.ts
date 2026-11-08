import { lstat, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { LocalKernelMutex } from './localKernelMutex';
import { ProjectOperationJournal, writeDurableLocalJson } from './projectOperationJournal';

export interface ActiveProjectScope {
  version: 1;
  projectId: string;
  canonicalRoot: string;
  dev: number;
  ino: number;
  hostname: string;
  generation: string;
}
export class ProjectScopeConflictError extends Error {}

/** Small active-only scope registry, separate from historical sessions. Global
 * claim serialization closes the race where an ancestor Git marker changes
 * project grouping while an older child-root owner is still running work.
 */
export class ProjectScopeRegistry {
  private readonly directory: string;
  public constructor(private readonly lockRoot: string, private readonly nativeOnly = false) { this.directory = path.join(lockRoot, 'active-scopes'); }

  public async claim<T>(candidate: ActiveProjectScope, publish: () => Promise<T>): Promise<T> {
    const global = await this.acquireMutex('project-active-scope-registry', 3000);
    if (!global) throw new ProjectScopeConflictError('Project scope coordination is busy; retry ownership check. / 项目范围协调繁忙，请重试所有权检查。');
    try {
      await this.prepareDirectory();
      const entries = await readdir(this.directory, { withFileTypes: true });
      if (entries.length > 256) throw new ProjectScopeConflictError('Active project scope registry needs inspection; no history has been loaded. / 活跃项目范围记录过多，须检查协调记录；未加载历史。');
      for (const entry of entries) {
        if (entry.isFile() && /^[a-f0-9]{64}\.json\.[a-f0-9-]{36}\.tmp$/u.test(entry.name)) {
          // An uncommitted registry replacement cannot publish an owner. The
          // global kernel mutex proves its writer is no longer committing it.
          await unlink(path.join(this.directory, entry.name)); continue;
        }
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) throw new ProjectScopeConflictError('Active project scope record cannot be verified. / 无法验证活跃项目范围记录。');
        const file = path.join(this.directory, entry.name);
        const previous = parseScope(await readFile(file, 'utf8'));
        if (previous.projectId !== entry.name.slice(0, -5) || previous.hostname !== os.hostname()) throw new ProjectScopeConflictError('Active project scope identity belongs to another host or record. / 活跃项目范围身份属于其他主机或记录。');
        if (previous.projectId === candidate.projectId) continue;
        const relevant = overlaps(previous.canonicalRoot, candidate.canonicalRoot) || !await physicalPathStillMatches(previous);
        const other = await this.acquireMutex(`project:${previous.projectId}`);
        if (!other) {
          if (relevant) throw scopeConflict();
          continue;
        }
        try {
          const journal = new ProjectOperationJournal(path.join(this.lockRoot, `${previous.projectId}.operations.json`), previous.projectId);
          let clean = false;
          try { clean = await journal.load() && (await journal.recover()).length === 0; }
          catch { /* Damaged/missing recovery evidence never means clean. */ }
          if (clean) await unlink(file);
          else if (relevant) throw new ProjectScopeConflictError('An overlapping or moved project has unsettled operation evidence. Check its operation diagnostics before retrying. / 重叠或已移动的项目存在未结算操作证据；请先检查其操作诊断再重试。');
        } finally { await other.release(); }
      }
      const result = await publish();
      await writeDurableLocalJson(path.join(this.directory, `${candidate.projectId}.json`), JSON.stringify(candidate));
      return result;
    } finally { await global.release(); }
  }

  /** Clean drain removes an active record. Unknown work keeps the scope record
   * so a differently grouped owner also has to honor its journal isolation. */
  public async release(scope: ActiveProjectScope, clean: boolean): Promise<void> {
    if (!clean) return;
    const global = await this.acquireMutex('project-active-scope-registry', 3000);
    if (!global) throw new ProjectScopeConflictError('Project scope release is busy. / 项目范围释放繁忙。');
    try {
      const file = path.join(this.directory, `${scope.projectId}.json`);
      try {
        const saved = parseScope(await readFile(file, 'utf8'));
        if (saved.generation === scope.generation) await unlink(file);
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    } finally { await global.release(); }
  }

  private acquireMutex(key: string, timeoutMs = 0) {
    return this.nativeOnly ? LocalKernelMutex.acquireNative(key, { timeoutMs }) : LocalKernelMutex.acquire(key, { timeoutMs });
  }
  private async prepareDirectory(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink() || process.platform !== 'win32' && (info.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new ProjectScopeConflictError('Active project scope directory is not private. / 活跃项目范围目录不可信。');
  }
}

function overlaps(a: string, b: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const left = normalize(a); const right = normalize(b);
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep)
    || left === path.parse(left).root || right === path.parse(right).root;
}
async function physicalPathStillMatches(scope: ActiveProjectScope): Promise<boolean> {
  try { const info = await stat(scope.canonicalRoot); return info.isDirectory() && info.dev === scope.dev && info.ino === scope.ino; }
  catch { return false; }
}
function scopeConflict(): ProjectScopeConflictError {
  return new ProjectScopeConflictError('Another live execution owner overlaps this project scope, or its physical root moved. Wait for that host to drain and check ownership again. / 另一个存活执行宿主与此项目范围重叠，或其物理根已移动；请待该宿主结算后重新检查所有权。');
}
function parseScope(value: string): ActiveProjectScope {
  const scope = JSON.parse(value) as Partial<ActiveProjectScope>;
  if (scope.version !== 1 || typeof scope.projectId !== 'string' || !/^[a-f0-9]{64}$/u.test(scope.projectId)
    || typeof scope.canonicalRoot !== 'string' || !path.isAbsolute(scope.canonicalRoot)
    || !Number.isFinite(scope.dev) || !Number.isFinite(scope.ino) || typeof scope.hostname !== 'string' || typeof scope.generation !== 'string') {
    throw new ProjectScopeConflictError('Active project scope record is damaged. / 活跃项目范围记录损坏。');
  }
  return scope as ActiveProjectScope;
}
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
