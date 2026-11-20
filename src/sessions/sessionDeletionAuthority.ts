import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, lstat, unlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { withStorageCoordinator, writeJsonAtomic } from '../shared/atomicStorage';

export interface SessionDeletionRecord {
  version: 1; workspaceKey: string; sessionId: string; operationId: string; confirmedAt: string;
  phase: 'committed' | 'reclaimed'; pendingReasons?: string[];
}
interface Participant { version: 1; pid: number; token: string; choosing: boolean; ticket: number }
interface UseRecord { version: 1; pid: number; token: string; workspaceKey: string; sessionId: string }
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Only a vanished path is missing. VS Code's FileNotFound also wraps
 * permission, sharing and network failures, so treating it as absent would make
 * an unreadable tombstone or use record look like clean history. */
export const missing = (error: unknown) => {
  const code = String((error as { code?: string })?.code ?? '');
  if (code === 'ENOENT') return true;
  // VS Code's FileNotFound wraps several distinct conditions, so its code alone
  // proves nothing either way: only the ENOENT marker does. Returning early here
  // was the reported bug — a FileNotFound whose message carried
  // "ENOENT: no such file or directory, stat '<tombstone>'" with no `cause` and
  // no `errno` (the common shape) fell through to `false`, so one absent
  // tombstone aborted whole-history recovery and disabled the composer.
  const detail = (error as { cause?: unknown; errno?: unknown })?.cause ?? error;
  const errnoCode = String((detail as { code?: unknown })?.code ?? '');
  const errno = String((detail as { errno?: unknown })?.errno ?? (error as { errno?: unknown })?.errno ?? '');
  if (code === 'FileNotFound' && (/^-?2$|^ENOENT$/u.test(errno) || errnoCode === 'ENOENT')) return true;
  // The node FileSystemProvider implementation, which backs `file:` storage on
  // every desktop host, rethrows raw node errors without `code`: a missing path
  // is then described only by its message. Startup probes a tombstone for every
  // listed session, so an ordinary absent record must stay "not deleted".
  // The ENOENT marker is matched anywhere in the message or its cause chain:
  // VS Code wraps it as "cannot be found (Error: ENOENT: ...)" or as
  // "EntryNotFound (FileSystemError): ENOENT: ...". Only a vanished path is
  // absent; a permission or sharing failure without the marker stays an error.
  return /ENOENT: no such file or directory,/u.test(describeErrorChain(error));
};
/** Message plus cause chain of an I/O failure, as VS Code and node report it. */
export function describeErrorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    parts.push(String((current as { message?: unknown })?.message ?? current));
    current = (current as { cause?: unknown })?.cause;
  }
  return parts.join(' ');
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** A snapshot of the gate raced another participant's write. Retried, not fatal. */
class GateObservationRace extends Error {}
const GATE_OBSERVE_ATTEMPTS = 20;
const GATE_OBSERVE_BACKOFF_MS = 5;

/** Lock-wait observation. An injected hook keeps this storage module free of
 * the agent logging layer, which imports it back. */
type GateWaitObserver = (sessionId: string, gateWaitMs: number) => void;
let gateWaitObserver: GateWaitObserver | undefined;
export function setGateWaitObserver(observer: GateWaitObserver | undefined): void { gateWaitObserver = observer; }


/** Shared deletion authority. Lock order: session gate -> object writer lock;
 * index/manifest gates are acquired separately, never while a session gate is held.
 * Bakery participants have unique names; dead owners are ignored only after ESRCH.
 * No TTL, heartbeat or unlink/recreate of another owner's lock establishes death. */
export class SessionDeletionAuthority {
  private readonly root: vscode.Uri;
  public constructor(private readonly storageUri: vscode.Uri) {
    this.root = vscode.Uri.joinPath(storageUri, 'session-deletions', 'v1');
  }
  public async withSessionGate<T>(workspaceKey: string, sessionId: string, work: () => Promise<T>): Promise<T> {
    this.validate(workspaceKey, sessionId);
    return this.withSessionIdGate(sessionId, work);
  }
  public async withSessionIdGate<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    if (!sessionId || sessionId.length > 4096) throw new Error('Invalid session identity');
    // Gate wait is the user-visible 'cannot send' window on slow shares.
    const started = performance.now();
    const result = await this.withGate(`session:${sessionId}`, work);
    gateWaitObserver?.(sessionId, performance.now() - started);
    return result;
  }
  public async withIndexGate<T>(workspaceKey: string, work: () => Promise<T>): Promise<T> {
    return this.withGate(`index:${workspaceKey}`, work);
  }
  public async withManifestGate<T>(work: () => Promise<T>): Promise<T> { return this.withGate('manifest', work); }
  private recordUri(sessionId: string): vscode.Uri { return vscode.Uri.joinPath(this.root, 'deleted', `${hash(sessionId)}.json`); }
  private useDirectory(sessionId: string): vscode.Uri { return vscode.Uri.joinPath(this.root, 'uses', hash(sessionId)); }
  private validate(workspaceKey: string, sessionId: string): void {
    if (!workspaceKey || !sessionId || workspaceKey.length > 16384 || sessionId.length > 4096) throw new Error('Invalid session identity');
  }
  public async readRecord(sessionId: string): Promise<SessionDeletionRecord | undefined> {
    try {
      await this.verifyLocalPath(this.recordUri(sessionId));
      const type = (await vscode.workspace.fs.stat(this.recordUri(sessionId))).type;
      if (type !== vscode.FileType.File) throw new Error('Unsafe session deletion record');
      const value = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.recordUri(sessionId)))) as SessionDeletionRecord;
      if (value?.version !== 1 || value.sessionId !== sessionId || !value.workspaceKey || !value.operationId
        || !Number.isFinite(Date.parse(value.confirmedAt)) || !['committed', 'reclaimed'].includes(value.phase)) {
        throw new Error('Session deletion record is damaged; session is unavailable');
      }
      return value;
    } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  public async isDeleted(workspaceKey: string, sessionId: string): Promise<boolean> {
    this.validate(workspaceKey, sessionId);
    const record = await this.readRecord(sessionId);
    if (record && record.workspaceKey !== workspaceKey) throw new Error('Session identity exists in a different workspace deletion domain');
    return !!record;
  }
  public async isSessionIdDeleted(sessionId: string): Promise<boolean> { return !!await this.readRecord(sessionId); }
  /** Presence only. A missing tombstone is the ordinary case for live history,
   * so readers must not turn an unrelated I/O failure into a damaged record. */
  public async hasRecord(sessionId: string): Promise<boolean> {
    try { await this.verifyLocalPath(this.recordUri(sessionId)); await vscode.workspace.fs.stat(this.recordUri(sessionId)); return true; }
    catch (error) { if (missing(error)) return false; throw error; }
  }
  public async assertWritable(workspaceKey: string, sessionId: string): Promise<void> {
    this.validate(workspaceKey, sessionId);
    if (await this.isDeleted(workspaceKey, sessionId)) throw new Error('This session has been permanently deleted');
  }
  public async assertSessionIdWritable(sessionId: string): Promise<void> {
    if (await this.isSessionIdDeleted(sessionId)) throw new Error('This session has been permanently deleted');
  }
  /** Caller holds the session gate and has performed final identity/version/use checks. */
  public async commitDeletion(record: SessionDeletionRecord): Promise<void> {
    this.validate(record.workspaceKey, record.sessionId);
    const old = await this.readRecord(record.sessionId);
    if (old && old.workspaceKey !== record.workspaceKey) throw new Error('Deleted session scope conflict');
    // The safety layout is created on first use; until then its absence is the
    // ordinary "nothing deleted yet" state for every reader.
    await this.ensureLocalDirectory(this.root);
    await this.ensureLocalDirectory(this.useDirectory(record.sessionId));
    await this.ensureLocalDirectory(vscode.Uri.joinPath(this.recordUri(record.sessionId), '..'));
    await this.verifyLocalPath(this.recordUri(record.sessionId));
    await writeJsonAtomic(this.recordUri(record.sessionId), old ?? record, { durable: true });
  }
  public async updateDeletion(sessionId: string, phase: SessionDeletionRecord['phase'], pendingReasons?: string[]): Promise<void> {
    await this.withSessionIdGate(sessionId, async () => {
      const record = await this.readRecord(sessionId);
      if (!record) throw new Error('Deletion intent missing');
      if (phase === 'reclaimed' && this.storageUri.scheme === 'file') {
        if (await this.inspectUse(record.workspaceKey, sessionId)) throw new Error('Session use ownership prevents final reclamation');
        await this.verifyLocalPath(this.useDirectory(sessionId));
        await Promise.resolve(vscode.workspace.fs.delete(this.useDirectory(sessionId), { recursive: true, useTrash: false })).catch(error => { if (!missing(error)) throw error; });
      }
      await writeJsonAtomic(this.recordUri(sessionId), { ...record, phase, pendingReasons }, { durable: true });
    });
  }
  /** A read reports what is there: the absence of the journal directory means
   * no deletion was ever recorded, never a damaged journal. */
  public async listPending(): Promise<SessionDeletionRecord[]> {
    const directory = vscode.Uri.joinPath(this.root, 'deleted');
    // Symbolic-link and escape verification stay authoritative: an unreadable
    // journal directory is a real fault and is still reported.
    try { await this.verifyLocalPath(directory); }
    catch (error) { if (missing(error)) return []; throw error; }
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(directory); }
    catch (error) { if (missing(error)) return []; throw error; }
    const result: SessionDeletionRecord[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const value = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, name)))) as SessionDeletionRecord;
      if (!value.sessionId || name !== `${hash(value.sessionId)}.json`) throw new Error('Damaged deletion journal');
      const record = await this.readRecord(value.sessionId);
      if (record?.phase === 'committed') result.push(record);
    }
    return result;
  }
  public async acquireUse(workspaceKey: string, sessionId: string): Promise<{ release(): Promise<void> }> {
    if (this.storageUri.scheme !== 'file') {
      await this.assertWritable(workspaceKey, sessionId);
      return { release: async () => undefined };
    }
    return this.withSessionGate(workspaceKey, sessionId, async () => {
      await this.assertWritable(workspaceKey, sessionId);
      const token = randomUUID(), uri = vscode.Uri.joinPath(this.useDirectory(sessionId), `${token}.json`);
      await this.ensureLocalDirectory(this.useDirectory(sessionId));
      const record: UseRecord = { version: 1, pid: process.pid, token, workspaceKey, sessionId };
      await writeJsonAtomic(uri, record);
      let released = false;
      return { release: async () => { if (released) return; await unlink(uri.fsPath).catch(error => { if (!missing(error)) throw error; }); released = true; } };
    });
  }
  /** Read-only; unknown/corrupt ownership is protected, never treated as idle. */
  public async inspectUse(workspaceKey: string, sessionId: string): Promise<boolean> {
    this.validate(workspaceKey, sessionId);
    if (this.storageUri.scheme !== 'file') throw new Error('This storage URI cannot provide cross-process cleanup safety');
    let names: string[];
    await this.verifyLocalPath(this.useDirectory(sessionId));
    try { names = await readdir(this.useDirectory(sessionId).fsPath); }
    catch (error) { if (missing(error)) return false; throw error; }
    for (const name of names.filter(item => item.endsWith('.json'))) {
      let value: UseRecord;
      try {
        const file = path.join(this.useDirectory(sessionId).fsPath, name);
        if (!(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) return true;
        value = JSON.parse(await readFile(file, 'utf8')) as UseRecord;
      }
      catch (error) { if (missing(error)) continue; return true; }
      if (value.version !== 1 || value.sessionId !== sessionId || !value.workspaceKey || !value.token || !Number.isSafeInteger(value.pid)) return true;
      if (this.alive(value.pid)) return true;
    }
    return false;
  }
  private alive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  }
  /** Read-only ownership check: previews never create safety directories. */
  private async verifyLocalPath(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') return;
    const relative = path.relative(this.storageUri.fsPath, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Storage path escaped its root');
    let cursor = this.storageUri.fsPath;
    for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (segment) cursor = path.join(cursor, segment);
      try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic-link deletion authority is unavailable'); }
      catch (error) { if (missing(error)) return; throw error; }
    }
  }
  private async ensureLocalDirectory(uri: vscode.Uri): Promise<void> {
    if (uri.scheme !== 'file') throw new Error('This storage URI cannot provide cross-process cleanup safety');
    const relative = path.relative(this.storageUri.fsPath, uri.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Storage path escaped its root');
    await mkdir(this.storageUri.fsPath, { recursive: true });
    let cursor = this.storageUri.fsPath;
    if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic-link storage root is unavailable for cleanup');
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      await mkdir(cursor).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe storage directory');
    }
  }
  private async withGate<T>(key: string, work: () => Promise<T>): Promise<T> {
    if (this.storageUri.scheme !== 'file') return withStorageCoordinator(`${this.root.toString()}:${key}`, work);
    const directory = vscode.Uri.joinPath(this.root, 'gates', hash(key));
    await this.ensureLocalDirectory(directory);
    const token = randomUUID(), uri = vscode.Uri.joinPath(directory, `${token}.json`);
    const own: Participant = { version: 1, pid: process.pid, token, choosing: true, ticket: 0 };
    // Other windows and processes enter and leave this same gate continuously.
    // A snapshot can land between another owner's write and its rename, observe
    // a half-written record, or lose a participant to a racing unlink. Those
    // are transient observations of a racing *other* participant, never
    // evidence that this gate is damaged, so they are retried briefly.
    const participants = async (): Promise<Participant[]> => {
      const result: Participant[] = [];
      for (const name of (await readdir(directory.fsPath)).filter(item => item.endsWith('.json'))) {
        const file = path.join(directory.fsPath, name);
        let value: Participant;
        try {
          const stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe storage gate participant');
          value = JSON.parse(await readFile(file, 'utf8')) as Participant;
        }
        catch (error) {
          if (missing(error)) continue;
          throw new GateObservationRace(error instanceof Error ? error.message : 'Storage gate participant is unreadable');
        }
        if (value?.version !== 1 || value.token !== name.slice(0, -5) || !Number.isSafeInteger(value.pid)
          || !Number.isSafeInteger(value.ticket) || value.ticket < 0 || typeof value.choosing !== 'boolean') {
          throw new GateObservationRace('Storage gate participant is not yet committed');
        }
        if (this.alive(value.pid)) result.push(value);
        else await unlink(file).catch(error => { if (!missing(error)) throw error; });
      }
      return result;
    };
    const observe = async (): Promise<Participant[]> => {
      let lastError: unknown;
      for (let attempt = 0; attempt < GATE_OBSERVE_ATTEMPTS; attempt += 1) {
        try { return await participants(); }
        catch (error) {
          if (!(error instanceof GateObservationRace)) throw error;
          lastError = error;
          if (attempt + 1 < GATE_OBSERVE_ATTEMPTS) await pause(GATE_OBSERVE_BACKOFF_MS * (attempt + 1));
        }
      }
      throw new Error('Storage gate ownership cannot be verified: '
        + String((lastError as { message?: unknown })?.message ?? lastError));
    };
    await writeJsonAtomic(uri, own);
    try {
      own.ticket = Math.max(0, ...(await observe()).map(item => item.ticket)) + 1;
      own.choosing = false;
      await writeJsonAtomic(uri, own);
      const deadline = Date.now() + 30_000;
      // Back off instead of polling every 10 ms: each attempt costs a readdir
      // plus one lstat/readFile per participant, which is expensive on shares.
      let backoffMs = 10;
      while ((await observe()).some(other => other.token !== token && (other.choosing
        || other.ticket < own.ticket || (other.ticket === own.ticket && other.token < token)))) {
        if (Date.now() > deadline) throw new Error('Storage gate is busy; retry cleanup later');
        await pause(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 200);
      }
      return await work();
    } finally { await unlink(uri.fsPath).catch(error => { if (!missing(error)) throw error; }); }
  }
}
