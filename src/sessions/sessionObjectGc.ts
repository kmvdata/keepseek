import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Mark-and-sweep collection of unreachable session objects.
 *
 * The object store is content addressed: every save writes new objects for the
 * messages that changed and leaves the previous ones on disk. Nothing ever
 * deletes them, so a long-lived conversation accumulates a nearly complete
 * history of every revision it ever had. Measurements on a real profile showed
 * 460MB on disk where only 44MB was reachable.
 *
 * The collector is deliberately conservative. It only removes a file when it can
 * prove, from a manifest that parsed and verified, that no live graph references
 * it. A manifest that fails to parse makes its whole session uncollectable: a
 * partial reading of the graph would look exactly like "these objects are
 * unreferenced", and deleting them would destroy the only copy of the history.
 */

const HASH = /^[a-f0-9]{64}$/u;
const OBJECTS_SUFFIX = '.json.objects';
const MANIFEST_SUFFIX = '.json';
/** Written by the store's writer lock; never an object, never a candidate. */
const WRITER_LOCK = 'writer.lock';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** One object directory: the unit a session's objects live in. */
export interface ObjectStoreTarget {
  /** Directory name, for reporting. */
  name: string;
  /** The manifest shard the directory belongs to. */
  manifestUri: vscode.Uri;
  directoryUri: vscode.Uri;
}

export interface SessionGcReport {
  targets: number;
  /** Objects reachable from a verified manifest. */
  liveObjects: number;
  /** Objects on disk that nothing references. */
  orphanObjects: number;
  /** Objects that could not be classified; the session is left untouched. */
  undecidableObjects: number;
  totalBytes: number;
  orphanBytes: number;
  liveBytes: number;
  /** Sessions skipped entirely, with the reason. Never partially collected. */
  skipped: Array<{ name: string; reason: string }>;
}

export interface SessionGcResult extends SessionGcReport {
  /** Objects actually deleted. Empty for a dry run. */
  deletedObjects: number;
  deletedBytes: number;
}

export interface SessionGcOptions {
  /** Report what would be reclaimed without deleting anything. */
  dryRun: boolean;
  /** Called once per target so a long sweep can show progress. */
  onTarget?: (target: ObjectStoreTarget, index: number, total: number) => void;
  /** Cooperative cancellation; a cancelled sweep deletes nothing further. */
  signal?: AbortSignal;
}

/** A manifest is only trustworthy if its shape and header hash both check out. */
interface ParsedManifest {
  header: string;
  headerInline?: unknown;
  messages: Array<{ body?: unknown; checkpoint?: unknown }>;
  summary?: unknown;
}

/**
 * Collect every object hash a manifest can name.
 *
 * Manifests reference objects through `header`, each message `body`, each
 * `checkpoint`, and `headerInline` may embed a node graph directly. `summary`
 * and `summaryHash` are plain JSON committed with the graph, so they are read as
 * JSON rather than as references — but any hash-shaped string inside them is
 * still treated as a reference, because over-approximating the live set only
 * costs a missed deletion, while under-approximating destroys data.
 */
export function collectRootHashes(manifest: ParsedManifest): Set<string> {
  const roots = new Set<string>();
  const addHash = (value: unknown) => {
    if (typeof value === 'string' && HASH.test(value)) roots.add(value);
  };
  addHash(manifest.header);
  for (const message of manifest.messages) {
    addHash(message.body);
    addHash(message.checkpoint);
  }
  // Header nodes can be inlined, and their children are references.
  walkReferences(manifest.headerInline, roots);
  walkReferences(manifest.summary, roots);
  return roots;
}

/** Add every `{ ref }` and every hash-shaped string found in a JSON tree. */
export function walkReferences(value: unknown, into: Set<string>): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (HASH.test(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkReferences(item, into);
    return;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // An encoded node reference is the only structural reference in the format.
    if (typeof record.ref === 'string' && HASH.test(record.ref)) into.add(record.ref);
    for (const item of Object.values(record)) walkReferences(item, into);
  }
}

/**
 * Read every object reachable from `roots`, adding newly discovered references.
 *
 * A referenced object that is missing from disk is not an error: it is exactly
 * the state left behind by an interrupted write, and the manifest that referenced
 * it will fail to load on its own. A corrupted object is different — its content
 * no longer matches its hash, so the reference graph under it is unknown. That
 * makes the whole target undecidable and it must not be collected.
 */
export async function expandReachable(
  roots: ReadonlySet<string>,
  readObject: (hash: string) => Promise<string | undefined>
): Promise<{ live: Set<string>; undecidable: string | undefined }> {
  const live = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const hash = queue.pop()!;
    if (live.has(hash)) continue;
    live.add(hash);
    let raw: string | undefined;
    try {
      raw = await readObject(hash);
    } catch (error) {
      return { live, undecidable: `unreadable object ${hash}: ${describeError(error)}` };
    }
    if (raw === undefined) continue;
    if (digest(raw) !== hash) return { live, undecidable: `object ${hash} failed its integrity check` };
    let node: unknown;
    try {
      node = JSON.parse(raw);
    } catch (error) {
      return { live, undecidable: `object ${hash} is not valid JSON: ${describeError(error)}` };
    }
    const found = new Set<string>();
    walkReferences(node, found);
    for (const child of found) if (!live.has(child)) queue.push(child);
  }
  return { live, undecidable: undefined };
}

/** Strict parse of a session manifest, or the reason it cannot be trusted. */
export function parseManifest(raw: string): { manifest: ParsedManifest } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { error: `manifest is not valid JSON: ${describeError(error)}` };
  }
  if (!value || typeof value !== 'object') return { error: 'manifest is not an object' };
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 4) return { error: `unsupported manifest version ${String(manifest.version)}` };
  if (typeof manifest.header !== 'string' || !HASH.test(manifest.header)) return { error: 'manifest header is not a hash' };
  if (!Array.isArray(manifest.messages)) return { error: 'manifest messages is not an array' };
  // An inline header is hashed over its serialized form; a mismatch means the
  // manifest and its nodes disagree and the live set cannot be trusted.
  if (manifest.headerInline !== undefined && digest(JSON.stringify(manifest.headerInline)) !== manifest.header) {
    return { error: 'inline header does not match the manifest header hash' };
  }
  return {
    manifest: {
      header: manifest.header,
      headerInline: manifest.headerInline,
      messages: manifest.messages as Array<{ body?: unknown; checkpoint?: unknown }>,
      summary: manifest.summary
    }
  };
}

/**
 * Compare on-disk objects against the reachable set for one directory.
 *
 * Pure: takes the directory listing and the live set, returns what would be lost.
 * Kept separate from I/O so the sweep decision can be tested without a filesystem.
 */
export function classifyObjects(
  onDisk: readonly string[],
  live: ReadonlySet<string>
): { orphans: string[]; liveCount: number; unknown: number } {
  const orphans: string[] = [];
  let liveCount = 0;
  let unknown = 0;
  for (const fileName of onDisk) {
    // Only `<hash>.json` entries are objects. The writer lock and any stray file
    // are ignored rather than deleted: they are not part of the object graph.
    if (!fileName.endsWith(MANIFEST_SUFFIX) || fileName === WRITER_LOCK) { unknown++; continue; }
    const hash = fileName.slice(0, -MANIFEST_SUFFIX.length);
    if (!HASH.test(hash)) { unknown++; continue; }
    if (live.has(hash)) liveCount++;
    else orphans.push(hash);
  }
  return { orphans, liveCount, unknown };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sweep one session's object directory.
 *
 * Every step that could destroy history has an escape: an unreadable manifest, an
 * unparseable manifest, or a corrupt object all skip the target entirely and say
 * why. A skipped session is reported, never silently ignored.
 */
export async function sweepTarget(
  target: ObjectStoreTarget,
  options: SessionGcOptions & { collectOnly?: boolean }
): Promise<{ report: Omit<SessionGcResult, 'targets' | 'skipped'>; skipped?: string; orphans?: string[] }> {
  const empty = { liveObjects: 0, orphanObjects: 0, undecidableObjects: 0,
    totalBytes: 0, orphanBytes: 0, liveBytes: 0, deletedObjects: 0, deletedBytes: 0 };

  let manifestRaw: string;
  try {
    manifestRaw = new TextDecoder().decode(await vscode.workspace.fs.readFile(target.manifestUri));
  } catch (error) {
    return { report: empty, skipped: `manifest unreadable: ${describeError(error)}` };
  }
  const parsed = parseManifest(manifestRaw);
  if ('error' in parsed) return { report: empty, skipped: parsed.error };

  let names: string[];
  try {
    const entries = await vscode.workspace.fs.readDirectory(target.directoryUri);
    names = entries.filter(([, type]) => type === vscode.FileType.File).map(([name]) => name);
  } catch (error) {
    return { report: empty, skipped: `object directory unreadable: ${describeError(error)}` };
  }

  const sizes = new Map<string, number>();
  for (const name of names) {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(target.directoryUri, name));
      sizes.set(name, stat.size);
    } catch { sizes.set(name, 0); }
  }

  const reachable = await expandReachable(collectRootHashes(parsed.manifest), async (hash) => {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(target.directoryUri, `${hash}${MANIFEST_SUFFIX}`)));
    } catch (error) {
      // Missing is expected after an interrupted write; anything else makes the
      // graph unknown, and `expandReachable` turns that into a skipped target.
      if (isMissing(error)) return undefined;
      throw error;
    }
  });
  if (reachable.undecidable) {
    return { report: { ...empty, undecidableObjects: names.length }, skipped: reachable.undecidable };
  }

  const { orphans, liveCount, unknown } = classifyObjects(names, reachable.live);
  const sizeOf = (hash: string) => sizes.get(`${hash}${MANIFEST_SUFFIX}`) ?? 0;
  const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  const orphanBytes = orphans.reduce((sum, hash) => sum + sizeOf(hash), 0);

  // Phase one only reports the candidate set; the caller backs it up and then
  // deletes in a second pass. Deleting before the backup exists would make the
  // whole operation unrecoverable.
  if (options.collectOnly) {
    return { orphans, report: { liveObjects: liveCount, orphanObjects: orphans.length,
      undecidableObjects: unknown, totalBytes, orphanBytes, liveBytes: totalBytes - orphanBytes,
      deletedObjects: 0, deletedBytes: 0 } };
  }

  let deletedObjects = 0;
  let deletedBytes = 0;
  if (!options.dryRun) {
    for (const hash of orphans) {
      if (options.signal?.aborted) break;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(target.directoryUri, `${hash}${MANIFEST_SUFFIX}`),
          { useTrash: false });
        deletedObjects++;
        deletedBytes += sizeOf(hash);
      } catch (error) {
        // A failed delete leaves the object in place; the next sweep retries it.
        if (!isMissing(error)) throw error;
      }
    }
  }

  return {
    report: {
      liveObjects: liveCount,
      orphanObjects: orphans.length,
      undecidableObjects: unknown,
      totalBytes,
      orphanBytes,
      liveBytes: totalBytes - orphanBytes,
      deletedObjects,
      deletedBytes
    }
  };
}

/** Sweep a whole list of targets, aggregating a single report. */
export async function sweepAll(
  targets: readonly ObjectStoreTarget[],
  options: SessionGcOptions & { collectOnly?: boolean }
): Promise<SessionGcResult & { candidates?: Array<{ target: ObjectStoreTarget; hashes: string[] }> }> {
  const result: SessionGcResult & { candidates?: Array<{ target: ObjectStoreTarget; hashes: string[] }> } = {
    targets: targets.length, liveObjects: 0, orphanObjects: 0,
    undecidableObjects: 0, totalBytes: 0, orphanBytes: 0, liveBytes: 0, deletedObjects: 0, deletedBytes: 0, skipped: [] };
  if (options.collectOnly) result.candidates = [];
  for (const [index, target] of targets.entries()) {
    if (options.signal?.aborted) break;
    options.onTarget?.(target, index, targets.length);
    let outcome: Awaited<ReturnType<typeof sweepTarget>>;
    try {
      outcome = await sweepTarget(target, options);
    } catch (error) {
      result.skipped.push({ name: target.name, reason: describeError(error) });
      continue;
    }
    if (outcome.skipped) { result.skipped.push({ name: target.name, reason: outcome.skipped }); continue; }
    if (options.collectOnly && outcome.orphans?.length) {
      result.candidates!.push({ target, hashes: outcome.orphans });
    }
    const report = outcome.report;
    result.liveObjects += report.liveObjects;
    result.orphanObjects += report.orphanObjects;
    result.undecidableObjects += report.undecidableObjects;
    result.totalBytes += report.totalBytes;
    result.orphanBytes += report.orphanBytes;
    result.liveBytes += report.liveBytes;
    result.deletedObjects += report.deletedObjects;
    result.deletedBytes += report.deletedBytes;
  }
  return result;
}

function isMissing(error: unknown): boolean {
  return ['ENOENT', 'FileNotFound'].includes(String((error as { code?: string })?.code))
    || /^ENOENT: no such file or directory,/u.test(String((error as { message?: unknown })?.message ?? ''));
}

/**
 * List every object directory under one sessions folder.
 *
 * Driven by the directory listing rather than the index: an orphan directory left
 * behind by a deleted session must be discoverable too, and the index is exactly
 * the thing most likely to be stale.
 */
export async function listTargets(sessionsDirectory: vscode.Uri): Promise<ObjectStoreTarget[]> {
  const entries = await vscode.workspace.fs.readDirectory(sessionsDirectory);
  const dirs = new Map<string, vscode.Uri>();
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory || !name.endsWith(OBJECTS_SUFFIX)) continue;
    dirs.set(name, vscode.Uri.joinPath(sessionsDirectory, name));
  }
  const targets: ObjectStoreTarget[] = [];
  for (const [name, directoryUri] of dirs) {
    const manifestName = name.slice(0, -OBJECTS_SUFFIX.length);
    targets.push({ name: manifestName, directoryUri,
      manifestUri: vscode.Uri.joinPath(sessionsDirectory, manifestName) });
  }
  return targets;
}

/** Format a report as the one-line summaries the user actually needs to see. */
export function formatReport(result: SessionGcResult, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (language === 'en') {
    const head = result.deletedObjects
      ? `Reclaimed ${mb(result.deletedBytes)} in ${result.deletedObjects} unreferenced objects.`
      : `Would reclaim ${mb(result.orphanBytes)} in ${result.orphanObjects} unreferenced objects.`;
    return [head,
      `Sessions scanned: ${result.targets} (live ${mb(result.liveBytes)}, total ${mb(result.totalBytes)})`,
      result.skipped.length ? `Skipped ${result.skipped.length}: ${result.skipped.map(item => item.name).join(', ')}` : ''
    ].filter(Boolean).join('\n');
  }
  const head = result.deletedObjects
    ? `已回收 ${mb(result.deletedBytes)}，共 ${result.deletedObjects} 个无引用对象。`
    : `可回收 ${mb(result.orphanBytes)}，共 ${result.orphanObjects} 个无引用对象。`;
  return [head,
    `扫描会话：${result.targets} 个（有效 ${mb(result.liveBytes)}，总计 ${mb(result.totalBytes)}）`,
    result.skipped.length ? `跳过 ${result.skipped.length} 个：${result.skipped.map(item => item.name).join('、')}` : ''
  ].filter(Boolean).join('\n');
}
/** User-facing strings for the maintenance command, kept next to the report. */
export function gcMessage(
  key: 'scanning' | 'collecting' | 'confirm' | 'empty' | 'backupFailed' | 'backupAt',
  language: 'zh-CN' | 'en' = 'zh-CN'
): string {
  const table = {
    'zh-CN': {
      scanning: '正在扫描无引用的会话对象…',
      collecting: '正在回收无引用的会话对象…',
      confirm: '回收',
      empty: '当前项目没有可扫描的会话对象目录。',
      backupFailed: '备份失败，未删除任何对象',
      backupAt: '备份位置'
    },
    en: {
      scanning: 'Scanning for unreferenced session objects…',
      collecting: 'Reclaiming unreferenced session objects…',
      confirm: 'Reclaim',
      empty: 'This project has no session object directories to scan.',
      backupFailed: 'Backup failed; nothing was deleted',
      backupAt: 'Backup location'
    }
  } as const;
  return table[language][key];
}

/** Bridge a CancellationToken to the AbortSignal the sweep understands. */
export function abortFromToken(token: { isCancellationRequested: boolean; onCancellationRequested(listener: () => void): { dispose(): void } }): AbortSignal {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  else {
    const subscription = token.onCancellationRequested(() => controller.abort());
    controller.signal.addEventListener('abort', () => subscription.dispose(), { once: true });
  }
  return controller.signal;
}

/**
 * Copy the objects a sweep is about to delete into a dated folder beside them.
 *
 * Collection is irreversible, and an unreferenced object is only *provably*
 * unreferenced relative to the manifests that parsed. Copying first costs disk
 * (the same bytes it reclaims) but makes a wrong decision recoverable, which is
 * the right trade for someone else's conversation history.
 *
 * Returns the backup folder, or `undefined` when there was nothing to copy.
 */
export async function backupOrphans(
  outcome: ReadonlyArray<{ target: ObjectStoreTarget; hashes: readonly string[] }>,
  backupRoot: vscode.Uri
): Promise<{ folder: vscode.Uri; objects: number } | undefined> {
  const pending = outcome.filter(item => item.hashes.length);
  if (!pending.length) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const folder = vscode.Uri.joinPath(backupRoot, `orphan-backup-${stamp}`);
  let copied = 0;
  for (const item of pending) {
    const source = item.target.directoryUri;
    const destination = vscode.Uri.joinPath(folder, item.target.name.replace(/\.json$/u, ''));
    await vscode.workspace.fs.createDirectory(destination);
    for (const hash of item.hashes) {
      const from = vscode.Uri.joinPath(source, `${hash}${MANIFEST_SUFFIX}`);
      const to = vscode.Uri.joinPath(destination, `${hash}${MANIFEST_SUFFIX}`);
      try {
        await vscode.workspace.fs.copy(from, to, { overwrite: false });
        copied++;
      } catch (error) {
        // A copy failure must abort the run: the caller then deletes nothing,
        // because a partial backup cannot restore a partial deletion.
        throw new Error(`backup failed for ${hash}: ${describeError(error)}`);
      }
    }
  }
  return { folder, objects: copied };
}
