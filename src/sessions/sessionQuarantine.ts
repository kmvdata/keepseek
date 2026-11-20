import { readdir, lstat, rename, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Corrupted store files are quarantined, never deleted on the load path.
 *
 * A load-path failure and a corrupted file are indistinguishable from inside the
 * read: a share that dropped, a writer mid-rename, a scanner holding a lock and a
 * truncated record all look like "cannot read". Deleting on that signal would
 * destroy intact history during an unrelated transient, and deletion is the one
 * outcome the user cannot undo. Moving the bytes aside keeps the window usable,
 * leaves the evidence for an operator, and stays reversible.
 *
 * Quarantine is therefore: exclude from loading, name the reason, keep the bytes.
 * Only an explicit age sweep in a background task removes entries. */
export class SessionQuarantine {
  public constructor(
    private readonly storageUri: vscode.Uri,
    /** Age after which a quarantined file is removed. Injected so tests can
     * exercise retention without waiting, and so policy stays explicit. */
    private readonly retentionMs = QUARANTINE_RETENTION_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  private get rootUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.storageUri, 'session-quarantine', 'v1');
  }

  /** Moves one store file into quarantine. Returns the quarantine path, or
   * undefined when nothing was moved (already gone). Never throws: a quarantine
   * failure must not become the new startup failure, so the caller still loads
   * without the file and the reason is logged. */
  public async quarantine(target: vscode.Uri, reason: string): Promise<vscode.Uri | undefined> {
    if (this.storageUri.scheme !== 'file' || target.scheme !== 'file') return undefined;
    const relative = path.relative(this.storageUri.fsPath, target.fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/gu, '-');
    // Keep the original relative layout so an operator can tell what the file was.
    const destination = vscode.Uri.joinPath(this.rootUri, stamp, relative);
    try {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destination, '..'));
      await rename(target.fsPath, destination.fsPath);
      console.warn('[KeepSeek] storage_quarantined', { reason, file: relative });
      return destination;
    } catch (error) {
      console.warn('[KeepSeek] storage_quarantine_failed', { reason, file: relative,
        message: String((error as { message?: unknown })?.message ?? error) });
      return undefined;
    }
  }

  /** Removes quarantine batches older than the retention window. Bounded to
   * this storage root; the caller runs it off the startup path. */
  public async sweepExpired(): Promise<number> {
    if (this.storageUri.scheme !== 'file') return 0;
    let batches: string[];
    try { batches = await readdir(this.rootUri.fsPath); }
    catch (error) { if (isMissing(error)) return 0; throw error; }
    const cutoff = this.now() - this.retentionMs;
    let removed = 0;
    for (const batch of batches) {
      const directory = path.join(this.rootUri.fsPath, batch);
      // The batch directory name is the ISO timestamp of the quarantine action.
      const created = Date.parse(batch.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/u, '$1T$2:$3:$4.$5Z'));
      if (!Number.isFinite(created) || created >= cutoff) continue;
      try {
        if ((await lstat(directory)).isSymbolicLink()) continue;
        await rm(directory, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        if (isMissing(error)) continue;
        console.warn('[KeepSeek] storage_quarantine_sweep_failed', { batch,
          message: String((error as { message?: unknown })?.message ?? error) });
      }
    }
    return removed;
  }
}

/** Seven days keeps a corrupted record long enough to report it, without
 * letting quarantine grow without bound. */
export const QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isMissing(error: unknown): boolean {
  return String((error as { code?: unknown })?.code ?? '') === 'ENOENT';
}