import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, readFile, rename, unlink, mkdir, stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
let testIdentityProbe: ((pid: number) => Promise<string | undefined>) | undefined;
/** Controlled PID-reuse fixtures; production uses the OS adapter below. */
export function configureProcessIdentityTestProbe(probe?: typeof testIdentityProbe): void { testIdentityProbe = probe; }
export type ProjectOperationKind = 'command' | 'validation' | 'apply';
export type ProjectOperationSettlement = 'completed' | 'not_dispatched' | 'result_unknown';
export interface ProjectOperationInput {
  id: string;
  kind: ProjectOperationKind;
  specHash?: string;
  resourceScope?: string;
  targetUri?: string;
  baseHash?: string;
  resultHash?: string;
  /** A launch gate cannot receive GO until its PID has been durably recorded. */
  gated?: boolean;
}
export interface ProjectOperationRecord extends ProjectOperationInput {
  generation: string;
  bootIdentity?: string;
  state: 'intent' | 'dispatched' | ProjectOperationSettlement;
  createdAt: string;
  settledAt?: string;
  processId?: number;
  processGroup?: number;
  processIdentity?: string;
  processState?: 'running' | 'ended' | 'unknown';
  reason?: string;
}
export interface ProjectOperationHandle {
  dispatched(process: { pid?: number; processGroup?: number; processIdentity?: string }): Promise<void>;
  settle(state: ProjectOperationSettlement): Promise<void>;
}
interface JournalData {
  version: 1;
  projectId: string;
  generation: string;
  generations?: string[];
  hostname: string;
  operations: ProjectOperationRecord[];
  recovery: { at: string; generation: string; outcome: string }[];
}

/** The caller holds the process-lifetime kernel mutex for every journal write.
 * This deliberately does not depend on VS Code, session bodies or Memento.
 */
export class ProjectOperationJournal {
  private data?: JournalData;
  private writing: Promise<void> = Promise.resolve();
  public constructor(private readonly file: string, private readonly projectId: string,
    private readonly bootIdentityProbe: () => Promise<string | undefined> = readMachineBootIdentity) {}

  public async load(): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<JournalData>;
      if (raw.version !== 1 || raw.projectId !== this.projectId || typeof raw.generation !== 'string'
        || raw.hostname !== os.hostname() || !Array.isArray(raw.operations) || !Array.isArray(raw.recovery)
        || (raw.generations !== undefined && (!Array.isArray(raw.generations) || raw.generations.some((generation) => typeof generation !== 'string')))
        || raw.operations.some((op) => !validOperation(op))) throw new Error('Project operation journal is damaged or belongs to a different host. / 项目操作日志损坏或来自其他主机。');
      this.data = raw as JournalData;
      return true;
    } catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
  }

  public async initialize(generation: string, priorPublished?: string): Promise<void> {
    if (!this.data) this.data = { version: 1, projectId: this.projectId, generation, generations: [generation], hostname: os.hostname(), operations: [], recovery: [] };
    // Retain the disk owner's generation across any number of crashes between
    // journal prepare and owner-record publish, without an unbounded history.
    this.data.generations = [...new Set([generation, priorPublished ?? this.data.generation])];
    this.data.generation = generation;
    await this.persist();
  }

  public snapshot(): ProjectOperationRecord[] { return this.data?.operations.map((operation) => ({ ...operation })) ?? []; }
  public get generation(): string | undefined { return this.data?.generation; }
  public recognizesGeneration(generation: string): boolean { return this.data?.generation === generation || Boolean(this.data?.generations?.includes(generation)); }

  public async recover(): Promise<ProjectOperationRecord[]> {
    if (!this.data) return [];
    const probedBootIdentity = await this.bootIdentityProbe();
    const bootIdentity = isCurrentHostBootIdentity(probedBootIdentity) ? probedBootIdentity : undefined;
    let changed = false;
    for (const operation of this.data.operations) {
      if (operation.state === 'completed' || operation.state === 'not_dispatched') continue;
      if (operation.kind === 'apply' && !operation.processId && operation.targetUri) {
        // Apply is performed by the fenced host itself, never a detached
        // process. Once the predecessor's kernel mutex has been released no
        // further host syscall can be dispatched. Preserve the target outcome
        // as unknown; continuation still restores its prepared ChangeSet.
        operation.state = 'result_unknown'; operation.processState = 'ended';
        operation.reason = 'Apply host ended; restore its ChangeSet before continuing this operation. Independent work may proceed with fresh hash checks. / Apply 宿主已结束；继续此操作前须恢复 ChangeSet。独立工作可重新核验 hash 后进行。';
        operation.settledAt ??= new Date().toISOString(); changed = true; continue;
      }
      if (bootIdentity && operation.bootIdentity && operation.bootIdentity !== bootIdentity) {
        operation.state = 'result_unknown'; operation.processState = 'ended'; operation.settledAt ??= new Date().toISOString();
        operation.reason = 'Machine restarted after this operation; no old process survives, and its result will not be replayed. / 此操作后计算机已重启；旧进程不再存活，结果不会重放。';
        changed = true; continue;
      }
      // An ungranted launch-gate cannot dispatch the target. Losing the parent
      // closes IPC; an orphan wrapper exits without ever receiving a payload.
      if (operation.state === 'intent' && operation.gated && !operation.processId) {
        operation.state = 'not_dispatched'; operation.processState = 'ended';
        operation.reason = 'Launch gate was never granted. / 启动门禁尚未放行。';
        operation.settledAt = new Date().toISOString(); changed = true; continue;
      }
      const result = await probeOperation(operation);
      operation.processState = result.state; operation.reason = result.reason;
      if (result.state === 'ended') {
        // Result delivery may have been lost. Preserve the receipt and never
        // replay it; absence of the verified process group permits new work.
        operation.state = 'result_unknown'; operation.settledAt ??= new Date().toISOString();
      }
      changed = true;
    }
    if (changed) await this.persist();
    return this.snapshot().filter((operation) => operation.state !== 'completed' && operation.state !== 'not_dispatched' && operation.processState !== 'ended');
  }

  public async begin(input: ProjectOperationInput, generation: string, verify: () => Promise<void>, changed: () => void): Promise<ProjectOperationHandle> {
    await verify();
    if (!this.data || this.data.generation !== generation) throw new Error('Operation journal generation changed.');
    if (this.data.operations.some((operation) => operation.id === input.id)) throw new Error('An operation identifier cannot be reused. / 操作标识不得复用。');
    try { await stat(this.receiptPath(input.id)); throw new Error('An archived operation identifier cannot be replayed. / 已归档的操作标识不得重放。'); }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    const bootIdentity = await this.bootIdentityProbe();
    const operation: ProjectOperationRecord = { ...input, generation, bootIdentity: isCurrentHostBootIdentity(bootIdentity) ? bootIdentity : undefined, state: 'intent', createdAt: new Date().toISOString() };
    this.data.operations.push(operation);
    await this.persist();
    return {
      dispatched: async (process) => {
        await verify();
        if (operation.state !== 'intent') throw new Error('Operation dispatch was already recorded.');
        operation.state = 'dispatched'; operation.processId = process.pid; operation.processGroup = process.processGroup;
        operation.processIdentity = process.processIdentity ?? (process.pid ? await readProcessIdentity(process.pid) : undefined);
        operation.processState = process.pid ? 'running' : 'unknown';
        await this.persist();
      },
      settle: async (state) => {
        if (operation.state === 'completed' || operation.state === 'not_dispatched') return;
        // Settlement is allowed after cancellation/fence loss, but may only
        // update the same journal while the kernel mutex is still held.
        operation.state = state; operation.settledAt = new Date().toISOString();
        if (state === 'completed' && operation.processId) {
          const result = await probeOperation(operation);
          operation.processState = result.state; operation.reason = result.reason;
          if (result.state !== 'ended') operation.state = 'result_unknown';
        } else if (state === 'not_dispatched') operation.processState = 'ended';
        else if (state === 'result_unknown') {
          const result = await probeOperation(operation); operation.processState = result.state; operation.reason = result.reason;
        }
        await this.persist(); changed();
      }
    };
  }

  public async recordUnknown(id: string, generation: string): Promise<void> {
    if (!this.data) return;
    const existing = this.data.operations.find((operation) => operation.id === id || operation.id.startsWith(`apply-${id}-`) || operation.id.startsWith(`revert-${id}-`));
    if (existing) { existing.state = 'result_unknown'; }
    else {
      const bootIdentity = await this.bootIdentityProbe();
      this.data.operations.push({ id, generation, bootIdentity: isCurrentHostBootIdentity(bootIdentity) ? bootIdentity : undefined, kind: 'command', state: 'result_unknown', processState: 'unknown', createdAt: new Date().toISOString(), reason: 'Operation result cannot be verified. / 无法验证操作结果。' });
    }
    await this.persist();
  }

  public async recordRecovery(generation: string, outcome: string): Promise<void> {
    if (!this.data) return;
    this.data.recovery.push({ at: new Date().toISOString(), generation, outcome });
    await this.persist();
  }

  public async flush(): Promise<void> { await this.writing; }

  private async persist(): Promise<void> {
    const previous = this.writing;
    this.writing = previous.then(async () => {
      if (!this.data) return;
      const settled = this.data.operations.filter(operation => operation.state === 'completed' || operation.state === 'not_dispatched' || operation.processState === 'ended');
      const archived = settled.slice(0, Math.max(0, settled.length - 64));
      if (archived.length) {
        await mkdir(`${this.file}.receipts`, { recursive: true, mode: 0o700 });
        // Each receipt is durable before it leaves the active journal. A crash
        // can duplicate a receipt but cannot erase the no-replay evidence.
        for (const operation of archived) await writeDurableLocalJson(this.receiptPath(operation.id), JSON.stringify(operation));
        const ids = new Set(archived.map(operation => operation.id));
        this.data.operations = this.data.operations.filter(operation => !ids.has(operation.id));
      }
      if (this.data.recovery.length > 64) {
        await mkdir(`${this.file}.receipts`, { recursive: true, mode: 0o700 });
        for (const event of this.data.recovery.slice(0, -64)) {
          const id = createHash('sha256').update(JSON.stringify(event)).digest('hex');
          await writeDurableLocalJson(path.join(`${this.file}.receipts`, `recovery-${id}.json`), JSON.stringify(event));
        }
        this.data.recovery = this.data.recovery.slice(-64);
      }
      await writeDurableLocalJson(this.file, JSON.stringify(this.data));
    });
    await this.writing;
  }
  private receiptPath(id: string): string { return path.join(`${this.file}.receipts`, `${createHash('sha256').update(id).digest('hex')}.json`); }
}

async function probeOperation(operation: ProjectOperationRecord): Promise<{ state: 'running' | 'ended' | 'unknown'; reason: string }> {
  if (!operation.processId) return { state: 'unknown', reason: 'Dispatch or Apply settlement requires its durable target evidence. / 派发或 Apply 结算须核对耐久目标证据。' };
  if (process.platform !== 'win32' && operation.processGroup) {
    try { process.kill(-operation.processGroup, 0); return { state: 'running', reason: 'The recorded process group still exists. / 已记录的进程组仍存在。' }; }
    catch (error) { if (errorCode(error) !== 'ESRCH') return { state: 'unknown', reason: 'Process-group access was denied or unavailable. / 无法验证进程组。' }; }
  }
  try { process.kill(operation.processId, 0); }
  catch (error) {
    return errorCode(error) === 'ESRCH'
      ? { state: 'ended', reason: 'Recorded process/group ended; result remains unknown and will not be replayed. / 已记录的进程和进程组已结束；结果未知且不会重放。' }
      : { state: 'unknown', reason: 'Process liveness cannot be verified. / 无法验证进程状态。' };
  }
  const identity = await readProcessIdentity(operation.processId);
  if (identity && operation.processIdentity && identity !== operation.processIdentity) {
    return { state: 'ended', reason: 'PID was reused; the recorded process has ended. / PID 已复用；原进程已结束。' };
  }
  return { state: identity ? 'running' : 'unknown', reason: identity ? 'Recorded process remains alive. / 已记录的进程仍存活。' : 'Process start identity cannot be verified. / 无法验证进程启动身份。' };
}

export async function readProcessIdentity(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (testIdentityProbe) return testIdentityProbe(pid);
  try {
    if (process.platform === 'linux') {
      const value = await readFile(`/proc/${pid}/stat`, 'utf8');
      return `linux:${os.hostname()}:${value.slice(value.lastIndexOf(')') + 2).split(' ')[19]}`;
    }
    const result = process.platform === 'win32'
      ? await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().Ticks`], { timeout: 3000, windowsHide: true })
      : await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 3000 });
    const value = result.stdout.trim();
    return value ? `${process.platform}:${os.hostname()}:${value}` : undefined;
  } catch { return undefined; }
}

/** A kernel boot-session identity cannot move with wall-clock corrections.
 * Windows currently has no independently verified adapter, so reboot recovery
 * there remains unavailable rather than inferring it from boot timestamps.
 */
export async function readMachineBootIdentity(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') {
      const value = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value) ? `${process.platform}:${os.hostname()}:${value.toLowerCase()}` : undefined;
    }
    if (process.platform === 'darwin') {
      const result = await execute('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 3000 });
      const value = result.stdout.trim();
      return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value) ? `${process.platform}:${os.hostname()}:${value.toLowerCase()}` : undefined;
    }
  } catch { /* Missing/denied boot evidence must keep legacy isolation. */ }
  return undefined;
}
export function isCurrentHostBootIdentity(value: unknown): value is string {
  const prefix = `${process.platform}:${os.hostname()}:`;
  return typeof value === 'string' && value.startsWith(prefix)
    && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu.test(value.slice(prefix.length));
}

function validOperation(value: unknown): value is ProjectOperationRecord {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Partial<ProjectOperationRecord>;
  return typeof operation.id === 'string' && typeof operation.generation === 'string'
    && typeof operation.createdAt === 'string' && Number.isFinite(Date.parse(operation.createdAt))
    && (operation.bootIdentity === undefined || isCurrentHostBootIdentity(operation.bootIdentity))
    && (operation.gated === undefined || typeof operation.gated === 'boolean')
    && (operation.processId === undefined || Number.isSafeInteger(operation.processId) && operation.processId > 0)
    && (operation.processGroup === undefined || Number.isSafeInteger(operation.processGroup) && operation.processGroup > 0)
    && ['command', 'validation', 'apply'].includes(operation.kind!)
    && ['intent', 'dispatched', 'completed', 'not_dispatched', 'result_unknown'].includes(operation.state!);
}

/** Same-directory durable replacement; no VS Code dependency during activation. */
export async function writeDurableLocalJson(file: string, bytes: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporary, file);
    if (process.platform !== 'win32') {
      const parent = await open(path.dirname(file), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
  } finally { await unlink(temporary).catch(() => undefined); }
}
function errorCode(error: unknown): string { return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''; }
