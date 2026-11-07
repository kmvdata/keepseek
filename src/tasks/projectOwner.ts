import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, realpath, mkdir, stat, statfs, unlink, lstat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type * as vscode from 'vscode';

export interface ProjectOwnerIdentity {
  version: 1;
  projectId: string;
  canonicalRoot: string;
  processId: number;
  nonce: string;
  acquiredAt: string;
  hostname: string;
}

export interface ProjectOwnerOptions {
  projectUri: string | vscode.Uri;
  /** Shared machine-local directory; never a workspace-keyed storage directory. */
  lockRoot?: string;
}

/** Lifetime execution lock, distinct from a short session writer transaction.
 * Stale files deliberately need inspection: a dead host does not prove that a
 * detached process it started has stopped. Neither timestamps nor heartbeats
 * permit stealing this lock.
 */
export class ProjectExecutionOwner {
  public readonly projectId: string;
  public readonly canonicalRoot: string;
  public readonly reason?: string;
  private owned = false;
  private identity?: ProjectOwnerIdentity;
  private lockPath?: string;
  private inode?: { dev: number; ino: number };
  private projectScope?: { selectionPath: string; dev: number; ino: number; gitMarker: string | null };
  private readonly uncertainOperations = new Set<string>();
  private activeOperations = 0;

  private constructor(root: string, id: string, reason?: string) {
    this.canonicalRoot = root;
    this.projectId = id;
    this.reason = reason;
  }

  public get isOwner(): boolean { return this.owned; }
  public get hasUncertainOperations(): boolean { return this.uncertainOperations.size > 0; }
  public markUncertainOperation(operationId: string): void { this.uncertainOperations.add(operationId); }
  public beginOperation(): () => void {
    this.assertOwner();
    this.activeOperations += 1;
    let released = false;
    return () => { if (released) return; released = true; this.activeOperations -= 1; };
  }

  public static async acquire(options: ProjectOwnerOptions): Promise<ProjectExecutionOwner> {
    const raw = typeof options.projectUri === 'string' ? options.projectUri : options.projectUri.toString();
    let root: string;
    try {
      if (path.isAbsolute(raw)) throw new Error('absolute-path');
      const uri = new URL(raw);
      if (uri.protocol !== 'file:' || uri.hostname && uri.hostname !== 'localhost') {
        return new ProjectExecutionOwner(raw, hash(raw), 'Project ownership is unavailable for this remote authority. / 此远端环境无法验证项目执行所有权。');
      }
      root = decodeURIComponent(uri.pathname);
      if (process.platform === 'win32' && /^\/[a-z]:/iu.test(root)) root = root.slice(1);
    } catch {
      if (!path.isAbsolute(raw)) throw new Error('Project ownership requires an absolute project URI or path.');
      root = raw;
    }
    const selectionPath = root;
    root = await canonicalProjectRoot(root);
    // A physical directory identity also covers case aliases on case-insensitive
    // volumes whose realpath implementation preserves the caller's spelling.
    const physicalRoot = await stat(root);
    const gitMarker = await projectGitMarkerIdentity(root);
    const id = hash(`file\0${physicalRoot.dev}\0${physicalRoot.ino}`);
    // Do not use TMPDIR on POSIX: two windows with different inherited TMPDIR
    // values must still contend for the same machine/user execution owner.
    const lockRoot = options.lockRoot ?? path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `keepseek-project-owners-${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockStat = await lstat(lockRoot);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()
      || (process.platform !== 'win32' && (lockStat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && lockStat.uid !== process.getuid())) {
      return new ProjectExecutionOwner(root, id, 'Project lock directory is not a private local directory. / 项目锁目录不可信。');
    }
    if (!await supportsLocalLocks(root) || !await supportsLocalLocks(lockRoot)) {
      return new ProjectExecutionOwner(root, id, 'This filesystem has no verified local ownership backend. / 此文件系统没有经过验证的本地所有权锁。');
    }
    const lock = path.join(lockRoot, `${id}.lock`);
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(lock, 'wx', 0o600); }
    catch (error) {
      if (code(error) !== 'EEXIST') throw error;
      let reason = 'Another window owns project execution. / 其他窗口拥有此项目执行权限。';
      try {
        const saved = parseOwner(await readFile(lock, 'utf8'));
        if (!saved || saved.projectId !== id || saved.canonicalRoot !== root) {
          reason = 'Project owner cannot be verified; inspect the existing lock before takeover. / 无法验证项目锁，接管前须检查。';
        } else {
          try { process.kill(saved.processId, 0); }
          catch (probe) {
            reason = code(probe) === 'ESRCH'
              ? 'Previous owner stopped; inspect detached operations before removing its lock. / 原宿主已退出，须核对遗留进程后清理锁。'
              : 'Project owner liveness cannot be verified. / 无法验证原宿主是否仍在运行。';
          }
        }
      } catch { reason = 'Project lock is incomplete or unreadable; takeover is disabled. / 项目锁不完整或不可读，禁止接管。'; }
      return new ProjectExecutionOwner(root, id, reason);
    }
    const owner = new ProjectExecutionOwner(root, id);
    const identity: ProjectOwnerIdentity = {
      version: 1, projectId: id, canonicalRoot: root, processId: process.pid,
      nonce: randomUUID(), acquiredAt: new Date().toISOString(), hostname: os.hostname()
    };
    try {
      await file.writeFile(JSON.stringify(identity));
      await file.sync();
      const info = await file.stat();
      owner.inode = { dev: info.dev, ino: info.ino };
      owner.identity = identity;
      owner.lockPath = lock;
      owner.projectScope = { selectionPath, dev: physicalRoot.dev, ino: physicalRoot.ino, gitMarker };
      owner.owned = true;
    } catch (error) {
      // Keep an incomplete lock after failed durability: fail closed on restart.
      await file.close();
      throw error;
    }
    await file.close();
    // The root/marker may have changed while the durable lock was prepared.
    // A successful lock-file write alone does not establish current scope.
    await owner.verify();
    return owner;
  }

  public assertOwner(): void {
    if (!this.owned) throw new Error(this.reason ?? 'Project execution ownership was lost. / 项目执行所有权已失效。');
  }

  /** Revalidate immediately before dispatching an actual request or side effect. */
  public async verify(): Promise<void> {
    this.assertOwner();
    try {
      const scope = this.projectScope;
      if (!scope) throw new Error('Project physical identity is unavailable. / 无法验证项目物理身份。');
      // This follows only the selected path and its finite ancestor chain. It
      // never scans project files, AGENTS or Skills. Re-resolving the original
      // selection also detects alias retargeting and a new/removed Git root.
      const currentRoot = await canonicalProjectRoot(scope.selectionPath);
      const [physicalRoot, currentGrouping, resolvedRoot, gitMarker] = await Promise.all([
        stat(this.canonicalRoot), stat(currentRoot), realpath(this.canonicalRoot), projectGitMarkerIdentity(this.canonicalRoot)
      ]);
      if (!physicalRoot.isDirectory() || physicalRoot.dev !== scope.dev || physicalRoot.ino !== scope.ino
        || currentGrouping.dev !== scope.dev || currentGrouping.ino !== scope.ino
        || normalizeRoot(resolvedRoot) !== normalizeRoot(this.canonicalRoot) || gitMarker !== scope.gitMarker) {
        throw new Error('Physical project root or Git scope changed; execution ownership is invalid. / 项目物理根或 Git 范围已变化，执行所有权失效。');
      }
      const saved = parseOwner(await readFile(this.lockPath!, 'utf8'));
      const info = await lstat(this.lockPath!);
      if (!saved || saved.nonce !== this.identity?.nonce || saved.processId !== process.pid
        || info.isSymbolicLink() || info.dev !== this.inode?.dev || info.ino !== this.inode?.ino) {
        throw new Error('Project execution ownership changed. / 项目执行所有权已变更。');
      }
    } catch (error) { this.owned = false; throw error; }
  }

  /** Only call after every owned runtime and dispatched operation has settled. */
  public async dispose(): Promise<void> {
    if (!this.owned) return;
    if (this.activeOperations > 0) throw new Error('Project operations have not settled; ownership lock is retained. / 项目操作尚未结算，保留所有权锁。');
    if (this.hasUncertainOperations) throw new Error('Project has unsettled or unknown side effects; ownership lock is retained for inspection. / 项目副作用结果未知，保留所有权锁待核对。');
    await this.verify();
    await unlink(this.lockPath!);
    this.owned = false;
  }
}

export async function canonicalProjectRoot(projectPath: string): Promise<string> {
  const canonical = await realpath(projectPath);
  let cursor = (await stat(canonical)).isDirectory() ? canonical : path.dirname(canonical);
  const selected = cursor;
  for (;;) {
    try {
      const marker = await stat(path.join(cursor, '.git'));
      if (marker.isFile() || marker.isDirectory()) return normalizeRoot(cursor);
    } catch (error) { if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return normalizeRoot(selected);
    cursor = parent;
  }
}

function normalizeRoot(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

async function projectGitMarkerIdentity(root: string): Promise<string | null> {
  try {
    const marker = path.join(root, '.git');
    const link = await lstat(marker);
    const target = await stat(marker);
    return JSON.stringify([link.dev, link.ino, target.dev, target.ino, target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other']);
  } catch (error) {
    if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null;
    throw error;
  }
}

async function supportsLocalLocks(root: string): Promise<boolean> {
  // No verified Windows volume-identity adapter is installed yet; UNC/local
  // drive labels alone cannot prove the atomic backend used by a provider.
  if (process.platform === 'win32') return false;
  try {
    const type = Number((await statfs(root)).type) >>> 0;
    const supported = process.platform === 'darwin'
      ? new Set([26, 17, 0x4253584e, 0x482b, 0x61706673]) // Darwin APFS / HFS types and variants
      : new Set([0xef53, 0x01021994, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1]); // ext, tmpfs, xfs, btrfs, overlay, zfs
    return supported.has(type);
  } catch { return false; }
}

function parseOwner(value: string): ProjectOwnerIdentity | undefined {
  const record = JSON.parse(value) as Partial<ProjectOwnerIdentity>;
  return record.version === 1 && typeof record.projectId === 'string' && typeof record.canonicalRoot === 'string'
    && Number.isSafeInteger(record.processId) && record.processId! > 0 && typeof record.nonce === 'string'
    ? record as ProjectOwnerIdentity : undefined;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function code(error: unknown): string { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
