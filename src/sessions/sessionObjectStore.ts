import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import * as vscode from 'vscode';
import { writeBytesAtomic, writeJsonAtomic } from '../shared/atomicStorage';
import type { ChatMessage, ChatSession } from '../shared/types';
import { getVisibleMessages } from './chatSessionStore';
import { freezeTree } from './persistenceSnapshot';
import { recordLocalPerformance } from '../agent/logging/performanceTrace';

type Encoded = null | string | number | boolean | { ref: string };
type ObjectNode = { kind: 'array'; values: Encoded[] } | { kind: 'object'; entries: Array<[string, Encoded]> } | { kind: 'text'; text: string };
interface SessionManifest {
  version: 3;
  workspaceKey: string;
  sessionId: string;
  revision: number;
  header: string;
  messages: Array<{ body: string; checkpoint?: string; pendingTool?: boolean; summary?: NonNullable<ChatMessage['runState']> }>;
}
const HASH = /^[a-f0-9]{64}$/u;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Per-session immutable graph. Objects are durable BEFORE the manifest switch.
 * No object GC while a session exists: old manifests and recovery references
 * remain valid, including failed writes and legacy rollback copies. */
export class SessionObjectStore {
  private readonly frozenRefs = new WeakMap<object, string>();
  private readonly written = new Set<string>();
  private readonly pendingNodes = new Map<string, Promise<string>>();
  private ioActive = 0;
  private readonly ioWaiters: Array<() => void> = [];
  private revision?: number;
  private writeBytes = 0;
  private writeObjects = 0;
  public constructor(private readonly shard: vscode.Uri, private readonly offlineRecoveryCopy = false) {}
  private directory(): vscode.Uri { return vscode.Uri.joinPath(this.shard, '..', `${this.shard.path.split('/').at(-1)}.objects`); }
  private objectUri(hash: string): vscode.Uri {
    if (!HASH.test(hash)) throw new Error('Invalid session object hash');
    return vscode.Uri.joinPath(this.directory(), `${hash}.json`);
  }
  private async putNode(node: ObjectNode): Promise<string> {
    const serialized = JSON.stringify(node);
    const hash = digest(serialized);
    if (this.written.has(hash)) return hash;
    const pending = this.pendingNodes.get(hash);
    if (pending) return pending;
    const write = this.withObjectIo(async () => {
      const uri = this.objectUri(hash);
      try {
        const existing = await vscode.workspace.fs.readFile(uri);
        if (digest(new TextDecoder().decode(existing)) !== hash) throw new Error('Session object integrity mismatch');
      } catch (error) {
        if (!isMissing(error)) throw error;
        await writeJsonAtomic(uri, node, { durable: true });
        this.writeBytes += Buffer.byteLength(serialized); this.writeObjects++;
      }
      this.written.add(hash);
      return hash;
    });
    this.pendingNodes.set(hash, write);
    try { return await write; } finally { this.pendingNodes.delete(hash); }
  }
  private async withObjectIo<T>(work: () => Promise<T>): Promise<T> {
    if (this.ioActive >= 4) await new Promise<void>(resolve => this.ioWaiters.push(resolve));
    else this.ioActive++;
    try { return await work(); } finally {
      const next = this.ioWaiters.shift();
      if (next) next(); else this.ioActive--;
    }
  }
  private async encode(value: unknown): Promise<Encoded> {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.length > 4096 ? { ref: await this.putNode({ kind: 'text', text: value }) } : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value !== 'object') throw new Error('Non-JSON session value');
    const cached = Object.isFrozen(value) ? this.frozenRefs.get(value) : undefined;
    if (cached) return { ref: cached };
    let node: ObjectNode;
    if (Array.isArray(value)) {
      const values: Encoded[] = new Array(value.length);
      let cursor = 0;
      // Preserve array order while batching independent immutable leaves. The
      // four-I/O gate bounds file descriptors and permits group fsync on disk.
      const encoded = await Promise.allSettled(Array.from({ length: Math.min(4, value.length) }, async () => {
        while (cursor < value.length) { const index = cursor++; values[index] = await this.encode(value[index]); }
      }));
      const failure = encoded.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      node = { kind: 'array', values };
    } else {
      const entries: Array<[string, Encoded]> = [];
      for (const [key, child] of Object.entries(value)) if (child !== undefined) entries.push([key, await this.encode(child)]);
      node = { kind: 'object', entries };
    }
    const hash = await this.putNode(node);
    if (Object.isFrozen(value)) this.frozenRefs.set(value, hash);
    return { ref: hash };
  }
  private async object(value: unknown): Promise<string> {
    const encoded = await this.encode(value);
    if (!encoded || typeof encoded !== 'object') throw new Error('Expected session object');
    return encoded.ref;
  }
  private async decode(hash: string, cache: Map<string, unknown>, stack = new Set<string>()): Promise<unknown> {
    if (stack.has(hash)) throw new Error('Cyclic session object');
    if (cache.has(hash)) return cache.get(hash);
    const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(this.objectUri(hash)));
    if (digest(raw) !== hash) throw new Error('Session object integrity mismatch');
    const node = JSON.parse(raw) as ObjectNode;
    const nextStack = new Set(stack).add(hash);
    const child = async (value: Encoded): Promise<unknown> => value && typeof value === 'object'
      ? this.decode(value.ref, cache, nextStack) : value;
    let value: unknown;
    if (node.kind === 'text') value = node.text;
    else if (node.kind === 'array') {
      const values: unknown[] = [];
      for (const item of node.values) values.push(await child(item));
      value = values;
    } else if (node.kind === 'object') {
      const entries: Array<[string, unknown]> = [];
      for (const [key, item] of node.entries) entries.push([key, await child(item)]);
      value = Object.fromEntries(entries);
    } else throw new Error('Invalid session object kind');
    freezeTree(value);
    cache.set(hash, value);
    if (value && typeof value === 'object') this.frozenRefs.set(value, hash);
    this.written.add(hash);
    return value;
  }
  public async load(manifest: unknown): Promise<ChatSession> {
    const m = manifest as SessionManifest;
    if (m?.version !== 3 || !Number.isSafeInteger(m.revision) || !Array.isArray(m.messages)) throw new Error('Invalid session manifest');
    const cache = new Map<string, unknown>();
    const header = await this.decode(m.header, cache) as Omit<ChatSession, 'messages'>;
    if (header.id !== m.sessionId || header.workspaceKey !== m.workspaceKey) throw new Error('Session scope mismatch');
    const messages: ChatMessage[] = [];
    for (let i = 0; i < m.messages.length; i++) {
      const entry = m.messages[i];
      const message = { ...await this.decode(entry.body, cache) as ChatMessage };
      if (entry.checkpoint) {
        if (!HASH.test(entry.checkpoint)) throw new Error('Invalid checkpoint reference');
        // Only the final, resumable checkpoint is loaded on ordinary startup.
        if (i === m.messages.length - 1 && entry.summary?.status !== 'completed') {
          message.runCheckpoint = structuredClone(await this.decode(entry.checkpoint, cache)) as ChatMessage['runCheckpoint'];
        } else if (entry.summary) {
          message.runCheckpointArchive = { version: 1, objectHash: entry.checkpoint,
            pendingTool: typeof entry.pendingTool === 'boolean' ? entry.pendingTool : undefined,
            summary: { ...entry.summary, canResume: false } };
        } else throw new Error('Missing checkpoint metadata');
      }
      messages.push(message);
    }
    this.revision = m.revision;
    return { ...structuredClone(header), messages };
  }
  public async save(session: ChatSession): Promise<number> {
    const started = performance.now(), bytesBefore = this.writeBytes, objectsBefore = this.writeObjects;
    return this.withWriterLock(async () => {
      let previous: unknown, previousBytes: Uint8Array | undefined;
      try { previousBytes = await vscode.workspace.fs.readFile(this.shard); previous = JSON.parse(new TextDecoder().decode(previousBytes)); }
      catch (error) { if (!isMissing(error)) throw error; }
      let prior: { version: number; revision: number; sessionId?: string; workspaceKey?: string } | undefined;
      if (previous) {
        const value = previous as SessionManifest & { session?: ChatSession };
        if (value.version !== 3 && Number(value.version) !== 2) throw new Error('Unsupported session storage version');
        if (!this.offlineRecoveryCopy && value.version !== 3 && value.session?.messages.some(message => message.runCheckpoint?.status === 'running')) {
          throw new Error('Legacy session still marked running; migration requires a stopped writer and an offline recovery copy');
        }
        prior = { version: value.version, revision: value.revision ?? 0,
          sessionId: value.sessionId ?? value.session?.id, workspaceKey: value.workspaceKey ?? value.session?.workspaceKey };
        if (prior.sessionId !== session.id || prior.workspaceKey !== session.workspaceKey) throw new Error('Session writer scope mismatch');
      }
      // Keep the legacy bytes for rollback, not a second 224 MB parsed tree
      // throughout object encoding and graph verification.
      previous = undefined;
      const revision = prior?.version === 3 ? prior.revision : 0;
      if (revision && this.revision === undefined) throw new Error('Existing session must be loaded before saving');
      if (this.revision !== undefined && revision !== this.revision) throw new Error('Stale session writer; reload before saving');
      const { messages, ...header } = session;
      const entries: SessionManifest['messages'] = [];
      for (const message of messages) {
        const { runCheckpoint, runCheckpointArchive, ...body } = message;
        delete body.runState;
        if (!runCheckpoint && runCheckpointArchive && !this.written.has(runCheckpointArchive.objectHash)) {
          const hash = runCheckpointArchive.objectHash;
          const bytes = await vscode.workspace.fs.readFile(this.objectUri(hash));
          if (digest(new TextDecoder().decode(bytes)) !== hash) throw new Error('Archived checkpoint integrity mismatch');
          this.written.add(hash);
        }
        entries.push({ body: await this.object(body),
          checkpoint: runCheckpoint ? await this.object(runCheckpoint) : runCheckpointArchive?.objectHash,
          pendingTool: runCheckpoint ? Boolean(runCheckpoint.state?.pending) : runCheckpointArchive?.pendingTool,
          summary: runCheckpoint ? getVisibleMessages([message])[0].runState : runCheckpointArchive?.summary });
      }
      const manifest: SessionManifest = { version: 3, workspaceKey: session.workspaceKey, sessionId: session.id,
        revision: revision + 1, header: await this.object(header), messages: entries };
      // Verify the new graph before replacing a legacy authority. Keep its exact
      // bytes permanently until explicit session deletion (rollback support).
      if (previousBytes && prior?.version !== 3) {
        const verificationCache = new Map<string, unknown>();
        for (const entry of entries) {
          await this.decode(entry.body, verificationCache);
          if (entry.checkpoint) await this.decode(entry.checkpoint, verificationCache);
        }
        await writeBytesAtomic(vscode.Uri.joinPath(this.directory(), 'legacy-v2.json'), previousBytes!, { durable: true });
        this.writeBytes += previousBytes!.byteLength;
        // Older writers cannot honor the new lock. Refuse a concurrent legacy
        // change detected during migration rather than overwriting its authority.
        const latest = await vscode.workspace.fs.readFile(this.shard);
        if (Buffer.compare(previousBytes, latest) !== 0) throw new Error('Legacy session changed during migration');
      }
      const encoded = performance.now();
      await writeJsonAtomic(this.shard, manifest, { durable: true });
      this.revision = manifest.revision;
      messages.forEach((message, index) => {
        const entry = entries[index];
        if (entry.summary?.canResume && index === messages.length - 1) { delete message.runCheckpointArchive; return; }
        if (entry.checkpoint && entry.summary) message.runCheckpointArchive = {
          version: 1, objectHash: entry.checkpoint, pendingTool: entry.pendingTool, summary: { ...entry.summary, canResume: false }
        };
      });
      const bytes = Buffer.byteLength(JSON.stringify(manifest));
      recordLocalPerformance({ type: 'checkpoint_store', sessionId: session.id,
        durationMs: performance.now() - started, encodeMs: encoded - started, commitMs: performance.now() - encoded,
        bytesWritten: this.writeBytes - bytesBefore + bytes, objectsWritten: this.writeObjects - objectsBefore });
      return bytes;
    });
  }
  /** Scope comes from this session directory, never a caller-provided path. */
  public async loadCheckpoint(hash: string): Promise<unknown> { return this.decode(hash, new Map()); }
  public async deleteObjects(): Promise<void> { await Promise.resolve(vscode.workspace.fs.delete(this.directory(), { recursive: true, useTrash: false })).catch(error => { if (!isMissing(error)) throw error; }); }
  private async withWriterLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.shard.scheme !== 'file') return work(); // outer URI coordinator serializes provider writes
    await vscode.workspace.fs.createDirectory(this.directory());
    const lock = vscode.Uri.joinPath(this.directory(), 'writer.lock').fsPath;
    let handle;
    try { handle = await open(lock, 'wx'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(lock)))) as { pid: number };
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Session writer lock needs inspection');
      try { process.kill(owner.pid, 0); throw new Error('Session already has an active writer'); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe; }
      await unlink(lock);
      handle = await open(lock, 'wx');
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.sync(); return await work(); }
    finally { await handle.close(); await unlink(lock); }
  }
}
function isMissing(error: unknown): boolean { return ['ENOENT', 'FileNotFound'].includes(String((error as { code?: string })?.code)); }
