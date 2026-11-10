import * as vscode from 'vscode';
import { SessionDeletionAuthority } from './sessionDeletionAuthority';
import { withStorageCoordinator } from '../shared/atomicStorage';

/** Shared file writers and targeted recyclers take the same short cross-process
 * gate. After logical deletion every writer filters the durable authority while
 * holding this gate, so a stale process cannot recreate physically reclaimed data. */
export async function withAssociatedStoreGate<T>(root: vscode.Uri, store: string, work: () => Promise<T>): Promise<T> {
  if (root.scheme !== 'file') return withStorageCoordinator(`${root.toString()}:associated-store:${store}`, work);
  return new SessionDeletionAuthority(root).withSessionIdGate(`associated-store:${store}`, work);
}

export async function readAssociatedJson(uri: vscode.Uri): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Associated history storage is damaged.');
    return value as Record<string, unknown>;
  } catch (error) {
    if (isMissingAssociatedFile(error)) return undefined;
    throw error;
  }
}

export function isMissingAssociatedFile(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'FileNotFound';
}

export async function deleteAssociatedUri(uri: vscode.Uri, recursive = false): Promise<void> {
  try { await vscode.workspace.fs.delete(uri, { recursive, useTrash: false }); }
  catch (error) { if (!isMissingAssociatedFile(error)) throw error; }
}

export async function withoutDeletedSessions<T extends { sessionId?: string }>(root: vscode.Uri, records: readonly T[]): Promise<T[]> {
  const authority = new SessionDeletionAuthority(root);
  const removed = new Map<string, boolean>();
  const result: T[] = [];
  for (const record of records) {
    const id = record.sessionId;
    if (!id) { result.push(record); continue; }
    if (!removed.has(id)) removed.set(id, await authority.isSessionIdDeleted(id));
    if (!removed.get(id)) result.push(record);
  }
  return result;
}

/** Check every existing managed component before a reclaim operation. The
 * storage root itself is also checked; a symlink is never an ownership proof. */
export async function assertManagedStoragePath(root: vscode.Uri, target: vscode.Uri): Promise<void> {
  if (root.scheme !== 'file' || target.scheme !== 'file') throw new Error('Associated data cannot be safely reclaimed for this storage URI.');
  const { lstat } = await import('node:fs/promises');
  const path = await import('node:path');
  const relative = path.relative(root.fsPath, target.fsPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Associated storage path escaped its root.');
  let cursor = root.fsPath;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) cursor = path.join(cursor, segment);
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error('Symbolic-link associated storage is unavailable for cleanup.'); }
    catch (error) { if (isMissingAssociatedFile(error)) return; throw error; }
  }
}

const associatedOwnerSummaries = new Map<string, { mtime: number; size: number; owners: Set<string> }>();
/** Monolithic operation stores bound their read and cache only
 * ownership IDs, never command output or review text. Oversized/unknown data is
 * unavailable for a blank-history proof, rather than silently called empty. */
export async function hasAssociatedRecordOwner(uri: vscode.Uri, sessionId: string, keys: readonly string[], versions: readonly number[]): Promise<boolean> {
  let stat: vscode.FileStat;
  try { stat = await vscode.workspace.fs.stat(uri); }
  catch (error) { if (isMissingAssociatedFile(error)) return false; throw error; }
  const key = uri.toString();
  let cached = associatedOwnerSummaries.get(key);
  if (!cached || cached.mtime !== stat.mtime || cached.size !== stat.size) {
    if (stat.type !== vscode.FileType.File || stat.size > 512 * 1024) throw new Error('Operation ownership cannot be determined without a large history read.');
    const stored = await readAssociatedJson(uri);
    if (!stored || !versions.includes(stored.version as number)) throw new Error('Operation ownership metadata is damaged.');
    const owners = new Set<string>();
    for (const collection of keys) {
      if (stored[collection] === undefined) continue;
      if (!Array.isArray(stored[collection])) throw new Error('Operation ownership metadata is damaged.');
      for (const record of stored[collection] as unknown[]) {
        if (!record || typeof record !== 'object' || typeof (record as { sessionId?: unknown }).sessionId !== 'string') throw new Error('Operation ownership metadata is damaged.');
        owners.add((record as { sessionId: string }).sessionId);
      }
    }
    cached = { mtime: stat.mtime, size: stat.size, owners };
    associatedOwnerSummaries.set(key, cached);
    if (associatedOwnerSummaries.size > 100) associatedOwnerSummaries.delete(associatedOwnerSummaries.keys().next().value!);
  }
  return cached.owners.has(sessionId);
}

export async function hasAssociatedDirectoryEntries(uri: vscode.Uri): Promise<boolean> {
  try { return (await vscode.workspace.fs.readDirectory(uri)).length > 0; }
  catch (error) { if (isMissingAssociatedFile(error)) return false; throw error; }
}
