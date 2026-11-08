import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, realpath, mkdir, stat, statfs, lstat } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { promisify } from 'node:util';
import type * as vscode from 'vscode';
import { LocalKernelMutex, type LocalMutexLease } from './localKernelMutex';
import { ProjectOperationJournal, readMachineBootTime, readProcessIdentity, writeDurableLocalJson, type ProjectOperationHandle, type ProjectOperationInput, type ProjectOperationRecord } from './projectOperationJournal';
import { ProjectScopeRegistry, ProjectScopeConflictError, type ActiveProjectScope } from './projectScopeRegistry';

export interface ProjectOwnerIdentity {
  version: 1 | 2;
  projectId: string;
  canonicalRoot: string;
  processId: number;
  nonce: string;
  acquiredAt: string;
  hostname: string;
  processIdentity?: string;
  backend?: 'loopback-exclusive-v1';
}
export type ProjectOwnerStatus = 'checking' | 'owned' | 'owned_elsewhere' | 'recovering' | 'blocked' | 'unsupported' | 'error';
export interface ProjectOwnerState { status: ProjectOwnerStatus; reasonCode: string; reason: string; revision: number; generation?: string }
export interface ProjectOwnerDiagnostics {
  state: ProjectOwnerState;
  legacy: boolean;
  operations: ProjectOperationRecord[];
  checks: string[];
}
export interface ProjectOwnerOptions {
  projectUri: string | vscode.Uri;
  /** Shared machine-local directory; never a workspace-keyed storage directory. */
  lockRoot?: string;
  /** Trusted test seam for OS boot-evidence failure and clock fixtures. */
  bootTimeProbe?: () => Promise<number | undefined>;
  /** Integration tests bypass the controlled harness to test the actual OS. */
  mutexBackend?: 'native';
}

/** The kernel socket is the election authority. The durable file is an audit
 * identity and legacy guard, never a lock that is stolen through unlink.
 * A successor holds exclusion before inspecting the previous journal, and is
 * not published as owned until live/unknown side effects have been isolated.
 */
export class ProjectExecutionOwner {
  private physicalProjectId: string;
  private physicalRoot: string;
  private current: ProjectOwnerState = { status: 'checking', reasonCode: 'checking', reason: 'Checking project ownership. / 正在检查项目执行所有权。', revision: 0 };
  private identity?: ProjectOwnerIdentity;
  private metadataInode?: { dev: number; ino: number };
  private previousIdentity?: ProjectOwnerIdentity;
  private lockPath?: string;
  private journal?: ProjectOperationJournal;
  private scopeRegistry?: ProjectScopeRegistry;
  private registeredScope?: ActiveProjectScope;
  private mutex?: LocalMutexLease;
  private projectScope?: { selectionPath: string; dev: number; ino: number; gitMarker: string | null };
  private options?: ProjectOwnerOptions;
  private legacy = false;
  private closed = false;
  private disposal?: Promise<void>;
  private pendingCheck?: Promise<ProjectExecutionOwner>;
  private pendingWrites: Promise<void> = Promise.resolve();
  private readonly uncertainOperations = new Set<string>();
  private activeOperations = 0;
  private readonly listeners = new Set<(state: ProjectOwnerState) => void>();

  private constructor(root: string, id: string) { this.physicalRoot = root; this.physicalProjectId = id; }
  public get projectId(): string { return this.physicalProjectId; }
  public get canonicalRoot(): string { return this.physicalRoot; }
  public get isOwner(): boolean { return !this.closed && this.current.status === 'owned' && Boolean(this.mutex?.isHeld); }
  /** Audit/result saves remain legal for the fenced current host after an
   * unknown outcome disables further execution. A recovering successor does
   * not acquire this capability until its own identity is published. */
  public get canWriteStorage(): boolean { return !this.closed && Boolean(this.identity && this.mutex?.isHeld); }
  public get reason(): string | undefined { return this.isOwner ? undefined : this.current.reason; }
  public get state(): ProjectOwnerState { return { ...this.current }; }
  public get hasUncertainOperations(): boolean {
    return this.uncertainOperations.size > 0 || Boolean(this.journal?.snapshot().some((operation) =>
      operation.state !== 'completed' && operation.state !== 'not_dispatched' && operation.processState !== 'ended'));
  }
  public onDidChange(listener: (state: ProjectOwnerState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public markUncertainOperation(operationId: string): void {
    this.uncertainOperations.add(operationId);
    if (this.journal && this.identity) {
      this.pendingWrites = this.pendingWrites.then(() => this.journal!.recordUnknown(operationId, this.identity!.nonce));
      void this.pendingWrites.catch((error) => this.setState('error', 'journal_write_failed', error instanceof Error ? error.message : 'Operation journal write failed. / 操作日志写入失败。'));
    }
    this.setState('blocked', 'operation_unknown', 'Project has an unsettled side effect; inspect operation diagnostics. / 项目有未结算副作用，请检查操作诊断。');
  }
  public beginOperation(): () => void {
    this.assertOwner(); this.activeOperations += 1;
    let released = false;
    return () => { if (!released) { released = true; this.activeOperations -= 1; } };
  }
  public async beginDurableOperation(input: ProjectOperationInput): Promise<ProjectOperationHandle> {
    await this.verify();
    if (!this.journal || !this.identity) throw new Error('Project operation journal is unavailable.');
    return this.journal.begin(input, this.identity.nonce, () => this.verify(), () => {
      if (this.hasUncertainOperations) this.setState('blocked', 'operation_unknown', 'Project has an unsettled side effect; inspect operation diagnostics. / 项目有未结算副作用，请检查操作诊断。');
    });
  }

  public static async acquire(options: ProjectOwnerOptions): Promise<ProjectExecutionOwner> {
    return this.startAcquire(options).ready;
  }
  /** Registration and account/edit UI can use the stable checking handle
   * immediately. Its provisional project identity is replaced exactly once
   * before ownership is published; no task may execute before ready. */
  public static startAcquire(options: ProjectOwnerOptions): { owner: ProjectExecutionOwner; ready: Promise<ProjectExecutionOwner> } {
    const raw = typeof options.projectUri === 'string' ? options.projectUri : options.projectUri.toString();
    const owner = new ProjectExecutionOwner(raw, hash(raw));
    const ready = ProjectExecutionOwner.acquireChecked(options, owner).catch(error => {
      owner.setState('error', 'ownership_initialization_failed', error instanceof Error ? error.message : 'Project ownership initialization failed. / 项目所有权初始化失败。');
      return owner;
    });
    return { owner, ready };
  }
  private static async acquireChecked(options: ProjectOwnerOptions, owner: ProjectExecutionOwner): Promise<ProjectExecutionOwner> {
    const raw = typeof options.projectUri === 'string' ? options.projectUri : options.projectUri.toString();
    let root: string;
    try {
      if (path.isAbsolute(raw)) throw new Error('absolute-path');
      const uri = new URL(raw);
      if (uri.protocol !== 'file:' || uri.hostname && uri.hostname !== 'localhost') {
        owner.setState('unsupported', 'remote_authority', 'Project execution coordination is unavailable for this remote authority. Accounts, drafts and history remain available. / 此远端环境无法验证项目执行协调；账号、草稿及历史仍可用。');
        return owner;
      }
      root = decodeURIComponent(uri.pathname);
      if (process.platform === 'win32' && /^\/[a-z]:/iu.test(root)) root = root.slice(1);
    } catch {
      if (!path.isAbsolute(raw)) throw new Error('Project ownership requires an absolute project URI or path.');
      root = raw;
    }
    const selectionPath = root;
    root = await canonicalProjectRoot(root);
    const physicalRoot = await stat(root);
    const id = hash(`file\0${physicalRoot.dev}\0${physicalRoot.ino}`);
    owner.physicalRoot = root; owner.physicalProjectId = id;
    owner.options = options;
    owner.projectScope = { selectionPath, dev: physicalRoot.dev, ino: physicalRoot.ino, gitMarker: await projectGitMarkerIdentity(root) };
    const lockRoot = options.lockRoot ?? path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', `keepseek-project-owners-${typeof process.getuid === 'function' ? process.getuid() : os.userInfo().username}`);
    await mkdir(lockRoot, { recursive: true, mode: 0o700 });
    const lockStat = await lstat(lockRoot);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()
      || (process.platform !== 'win32' && (lockStat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && lockStat.uid !== process.getuid())) {
      owner.setState('unsupported', 'untrusted_lock_directory', 'Project lock directory is not a private local directory. / 项目锁目录不可信。'); return owner;
    }
    if (!await supportsLocalLocks(root) || !await supportsLocalLocks(lockRoot)) {
      owner.setState('unsupported', 'filesystem_unverified', 'This filesystem has no verified local ownership backend. / 此文件系统没有经过验证的本地所有权锁。'); return owner;
    }
    owner.lockPath = path.join(lockRoot, `${id}.lock`);
    owner.journal = new ProjectOperationJournal(path.join(lockRoot, `${id}.operations.json`), id);
    owner.scopeRegistry = new ProjectScopeRegistry(lockRoot, options.mutexBackend === 'native');
    return owner.retryAcquire();
  }

  /** Explicit/user-dispatch triggered, bounded and merged; no heartbeat loop. */
  public retryAcquire(): Promise<ProjectExecutionOwner> {
    if (this.pendingCheck) return this.pendingCheck;
    this.pendingCheck = Promise.resolve().then(() => this.checkAndAcquire()).finally(() => { this.pendingCheck = undefined; });
    return this.pendingCheck;
  }
  private async checkAndAcquire(): Promise<ProjectExecutionOwner> {
    if (this.closed || !this.options || !this.lockPath || !this.journal) return this;
    if (this.isOwner) { await this.verify(); return this; }
    if (this.activeOperations > 0) {
      this.setState('blocked', 'operation_active', 'Current operations must settle before ownership can be checked again. / 当前操作须结算后才能重新检查所有权。');
      return this;
    }
    this.setState('checking', 'checking', 'Checking project ownership. / 正在检查项目执行所有权。');
    try {
      await this.pendingWrites;
      this.mutex ??= await (this.options.mutexBackend === 'native' ? LocalKernelMutex.acquireNative : LocalKernelMutex.acquire).call(LocalKernelMutex, `project:${this.projectId}`);
      if (!this.mutex) {
        this.setState('owned_elsewhere', 'live_owner_or_port_conflict', 'Another window owns project execution, or the local coordination endpoint is occupied. Check again after that window exits. / 其他窗口拥有项目执行权，或本地协调端点被占用；对方退出后可重新检查。'); return this;
      }
      this.setState('recovering', 'journal_check', 'Checking unsettled project operations. / 正在核对项目未结算操作。');
      let saved: ProjectOwnerIdentity | undefined;
      try {
        const recordInfo = await lstat(this.lockPath);
        if (recordInfo.isSymbolicLink() || !recordInfo.isFile()) throw new Error('Project owner record is not a regular private file. / 项目所有权记录不是私有普通文件。');
        saved = parseOwner(await readFile(this.lockPath, 'utf8'));
      }
      catch (error) {
        if (code(error) !== 'ENOENT') {
          const recordInfo = await lstat(this.lockPath).catch(() => undefined);
          const bootTime = await (this.options.bootTimeProbe ?? readMachineBootTime)();
          if (recordInfo?.isFile() && !recordInfo.isSymbolicLink() && bootTime !== undefined && recordInfo.mtimeMs < bootTime) {
            const original = await readFile(this.lockPath);
            await writeDurableLocalJson(`${this.lockPath}.damaged-${hash(original.toString('base64')).slice(0, 16)}.json`, JSON.stringify({ recovery: 'machine_reboot_verified', originalBytesBase64: original.toString('base64') }));
          } else throw new Error('Project lock is incomplete or unreadable. Inspect records, or restart the computer then Check ownership; confirmation alone cannot release isolation. / 项目锁不完整或不可读。请检查记录，或重启计算机后点击检查所有权；单纯确认不能解除隔离。');
        }
      }
      const loaded = await this.journal.load();
      if (saved && (saved.projectId !== this.projectId || saved.hostname !== os.hostname())) {
        this.setState('blocked', 'identity_mismatch', 'Project ownership identity belongs to a different scope or host. / 项目所有权身份属于其他范围或主机。'); return this;
      }
      this.previousIdentity = saved;
      this.legacy = saved?.version === 1;
      if (this.legacy) {
        const bootTime = await (this.options.bootTimeProbe ?? readMachineBootTime)();
        const acquiredAt = Date.parse(saved!.acquiredAt);
        if (bootTime !== undefined && Number.isFinite(acquiredAt) && acquiredAt < bootTime) {
          // A verified whole-machine restart proves even detached/escaped
          // descendants ended. Preserve the original v1 record before upgrade.
          await writeDurableLocalJson(`${this.lockPath}.legacy-${hash(saved!.nonce).slice(0, 16)}.json`, JSON.stringify(saved));
          await this.journal.initialize(randomUUID());
          await this.journal.recordRecovery(saved!.nonce, 'legacy_machine_reboot_verified_result_unknown_no_replay');
          this.legacy = false;
          saved = undefined;
        }
      }
      if (this.legacy) {
        let alive = true;
        try { process.kill(saved!.processId, 0); } catch (error) { if (code(error) === 'ESRCH') alive = false; }
        if (alive) {
          await this.mutex.release(); this.mutex = undefined;
          this.setState('owned_elsewhere', 'legacy_owner_live_or_unverifiable', 'A legacy execution owner remains alive or cannot be verified. / 旧版执行宿主仍存活或无法验证。');
        } else this.setState('blocked', 'legacy_evidence_required', 'Previous legacy host stopped; detached-process identities are missing. Inspect existing operation records, or restart the computer then Check ownership to prove old processes ended. Confirmation alone cannot release isolation. / 旧宿主已退出，但缺少遗留进程身份；请核对操作记录，或重启计算机后点击检查所有权，以证实旧进程已结束。单纯确认不能解除隔离。');
        return this;
      }
      if (saved && (!loaded || !this.journal.recognizesGeneration(saved.nonce))) {
        this.setState('blocked', 'journal_identity_mismatch', 'Operation journal and owner generation do not match. / 操作日志与宿主代次不匹配。'); return this;
      }
      const blockers = loaded ? await this.journal.recover() : [];
      const recovered = this.journal.snapshot();
      for (const id of this.uncertainOperations) {
        if (recovered.some((operation) => (operation.id === id || operation.id.startsWith(`apply-${id}-`) || operation.id.startsWith(`revert-${id}-`)) && operation.processState === 'ended')) this.uncertainOperations.delete(id);
      }
      if (blockers.length) { this.setState('blocked', 'operation_unsettled', 'Recorded processes or unknown dispatches require inspection; no operation will be replayed. / 已记录的进程或未知派发须核对；不会重放操作。'); return this; }
      if (this.uncertainOperations.size) { this.setState('blocked', 'operation_unknown', 'Project side effects require operation evidence. / 项目副作用须核对操作证据。'); return this; }
      const identity: ProjectOwnerIdentity = {
        version: 2, backend: 'loopback-exclusive-v1', projectId: this.projectId, canonicalRoot: this.canonicalRoot,
        processId: process.pid, processIdentity: await readProcessIdentity(process.pid), nonce: randomUUID(),
        acquiredAt: new Date().toISOString(), hostname: os.hostname()
      };
      await this.journal.initialize(identity.nonce, saved?.nonce);
      await this.journal.recordRecovery(identity.nonce, saved ? 'recovered_without_live_operations' : 'fresh_owner');
      const scope = this.projectScope!;
      const registration: ActiveProjectScope = { version: 1, projectId: this.projectId, canonicalRoot: this.canonicalRoot,
        dev: scope.dev, ino: scope.ino, hostname: os.hostname(), generation: identity.nonce };
      await this.scopeRegistry!.claim(registration, () => writeDurableLocalJson(this.lockPath!, JSON.stringify(identity)));
      this.registeredScope = registration;
      const metadata = await lstat(this.lockPath);
      this.metadataInode = { dev: metadata.dev, ino: metadata.ino };
      this.identity = identity;
      if (this.closed) return this;
      this.setState('owned', 'owned', '', identity.nonce);
      await this.verify();
    } catch (error) {
      if (error instanceof ProjectScopeConflictError) {
        // No runtime can be active during election. Two overlapping candidates
        // must not retain each other's project mutexes after a rejected claim.
        await this.mutex?.release(); this.mutex = undefined; this.identity = undefined;
      }
      this.setState(error instanceof ProjectScopeConflictError ? 'blocked' : 'error', error instanceof ProjectScopeConflictError ? 'overlapping_project_scope' : 'ownership_check_failed', error instanceof Error ? error.message : 'Ownership check failed. / 所有权检查失败。');
    }
    return this;
  }

  public async diagnostics(): Promise<ProjectOwnerDiagnostics> {
    if (this.mutex?.isHeld && !this.isOwner && !this.legacy) await this.retryAcquire();
    return { state: this.state, legacy: this.legacy, operations: this.journal?.snapshot() ?? [], checks: [
      this.mutex?.isHeld ? 'kernel_mutex_held' : 'kernel_mutex_not_held',
      this.previousIdentity ? `previous_owner_v${this.previousIdentity.version}` : 'no_previous_owner',
      this.legacy ? 'legacy_no_durable_dispatch_identity: inspect DraftRun/ChangeSet records; confirmation alone cannot settle an unknown process' : 'journal_checked'
    ] };
  }
  public assertOwner(): void { if (!this.isOwner) throw new Error(this.reason ?? 'Project execution ownership was lost. / 项目执行所有权已失效。'); }

  /** The exclusive socket remains continuously held across verify→dispatch and
   * throughout active work. No nonce read or heartbeat is used as exclusion. */
  public async verify(): Promise<void> {
    this.assertOwner();
    try {
      const scope = this.projectScope;
      if (!scope) throw new Error('Project physical identity is unavailable. / 无法验证项目物理身份。');
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
      if (!saved || saved.nonce !== this.identity?.nonce || saved.processId !== process.pid || info.isSymbolicLink()
        || info.dev !== this.metadataInode?.dev || info.ino !== this.metadataInode?.ino || !this.mutex?.isHeld) {
        throw new Error('Project execution ownership changed. / 项目执行所有权已变更。');
      }
    } catch (error) { this.setState('blocked', 'fence_invalidated', error instanceof Error ? error.message : 'Project owner fence is invalid.'); throw error; }
  }

  /** Idempotent after runtime drain. Unknown receipts remain durable even when
   * shutdown releases the kernel mutex; the successor must inspect them. */
  public dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    if (this.activeOperations > 0) return Promise.reject(new Error('Project operations have not settled; ownership lock is retained. / 项目操作尚未结算，保留所有权锁。'));
    this.closed = true;
    this.disposal = this.releaseAfterDrain();
    return this.disposal;
  }
  private async releaseAfterDrain(): Promise<void> {
    await this.pendingCheck;
    await this.pendingWrites; await this.journal?.flush();
    if (this.registeredScope) await this.scopeRegistry?.release(this.registeredScope, !this.hasUncertainOperations);
    await this.mutex?.release(); this.mutex = undefined;
    this.setState('blocked', 'shutdown', 'Project execution host stopped. / 项目执行宿主已停止。');
  }
  private setState(status: ProjectOwnerStatus, reasonCode: string, reason: string, generation = this.identity?.nonce): void {
    this.current = { status, reasonCode, reason, generation, revision: this.current.revision + 1 };
    for (const listener of this.listeners) { try { listener(this.state); } catch { /* Observers cannot change election. */ } }
  }
}

export async function canonicalProjectRoot(projectPath: string): Promise<string> {
  const canonical = await realpath(projectPath);
  let cursor = (await stat(canonical)).isDirectory() ? canonical : path.dirname(canonical);
  const selected = cursor;
  for (;;) {
    try { const marker = await stat(path.join(cursor, '.git')); if (marker.isFile() || marker.isDirectory()) return normalizeRoot(cursor); }
    catch (error) { if (code(error) !== 'ENOENT' && code(error) !== 'ENOTDIR') throw error; }
    const parent = path.dirname(cursor);
    if (parent === cursor) return normalizeRoot(selected);
    cursor = parent;
  }
}
function normalizeRoot(root: string): string { return process.platform === 'win32' ? root.toLowerCase() : root; }
async function projectGitMarkerIdentity(root: string): Promise<string | null> {
  try {
    const marker = path.join(root, '.git'); const link = await lstat(marker); const target = await stat(marker);
    return JSON.stringify([link.dev, link.ino, target.dev, target.ino, target.isDirectory() ? 'directory' : target.isFile() ? 'file' : 'other']);
  } catch (error) { if (code(error) === 'ENOENT' || code(error) === 'ENOTDIR') return null; throw error; }
}
async function supportsLocalLocks(root: string): Promise<boolean> {
  try {
    const type = Number((await statfs(root)).type) >>> 0;
    if (process.platform === 'win32') {
      if (root.startsWith('\\\\') || !/^[a-z]:[\\/]/iu.test(root)) return false;
      // A mapped drive can look like a local drive letter to statfs. Check the
      // OS drive type too: SMB/remote media cannot use machine-local exclusion.
      const drive = root.slice(0, 2).toUpperCase();
      let verified = windowsVolumes.get(drive);
      if (!verified) {
        verified = promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `$v=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; if($v.DriveType -eq 3 -and @('NTFS','ReFS') -contains $v.FileSystem){'local-supported'}`],
        { timeout: 3000, windowsHide: true }).then(result => result.stdout.trim() === 'local-supported').catch(() => false);
        windowsVolumes.set(drive, verified);
      }
      return await verified && (type === 0 || type === 0x5346544e || type === 0x2011bab0);
    }
    const supported = process.platform === 'darwin'
      ? new Set([26, 17, 0x4253584e, 0x482b, 0x61706673])
      : new Set([0xef53, 0x01021994, 0x58465342, 0x9123683e, 0x794c7630, 0x2fc12fc1]);
    return supported.has(type);
  } catch { return false; }
}
const windowsVolumes = new Map<string, Promise<boolean>>();
function parseOwner(value: string): ProjectOwnerIdentity | undefined {
  const record = JSON.parse(value) as Partial<ProjectOwnerIdentity>;
  if ((record.version !== 1 && record.version !== 2) || typeof record.projectId !== 'string' || typeof record.canonicalRoot !== 'string'
    || !Number.isSafeInteger(record.processId) || record.processId! <= 0 || typeof record.nonce !== 'string' || typeof record.hostname !== 'string') throw new Error('Project lock is incomplete or unreadable. / 项目锁不完整或不可读。');
  return record as ProjectOwnerIdentity;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function code(error: unknown): string { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
