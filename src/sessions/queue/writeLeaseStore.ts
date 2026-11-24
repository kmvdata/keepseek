import * as vscode from 'vscode';
import { missing } from '../sessionDeletionAuthority';
import { withAssociatedStoreGate } from '../sessionAssociatedPersistence';
import { writeJsonAtomic } from '../../shared/atomicStorage';
import {
  forceRelease,
  heartbeat,
  isProcessAlive,
  normalizeWriteLease,
  release,
  tryAcquire,
  type AcquireRequest,
  type WriteLeaseRecord
} from './writeLease';

/**
 * Durable per-project write lease.
 *
 * One lease record per workspace, stored beside `queue.json`. Every read-modify-
 * write runs inside the shared associated-store gate, so two windows cannot
 * interleave an acquire/release. Atomic rename alone is not compare-and-swap.
 *
 * The gate is a short cross-process critical section. It must never wrap the
 * guarded work itself: it has a hard 30 s deadline, while `npm test` may hold
 * the lease for minutes. Long ownership is expressed by the lease record and
 * its heartbeat, not by holding the gate.
 */

export type LeaseSaveStatus = 'saved' | 'conflict';

export interface LeaseSaveResult {
  status: LeaseSaveStatus;
  lease: WriteLeaseRecord;
}

export type LivenessProbe = (pid: number) => boolean;

export class ProjectWriteLeaseStore {
  public constructor(private readonly leaseUri: vscode.Uri) {}

  public get uri(): vscode.Uri {
    return this.leaseUri;
  }

  /**
   * Read the lease.
   *
   * A read never takes the cross-process gate: it is a single atomic file read,
   * and taking a gate to read would let an unrelated storage fault turn the only
   * startup read into a wait. The gate is reserved for read-modify-write.
   */
  public async load(workspaceKey: string): Promise<WriteLeaseRecord> {
    return normalizeWriteLease(await this.readRaw(), workspaceKey);
  }

  /**
   * Compare-and-set save of a whole lease record.
   *
   * `expectedEpoch` is the epoch the caller based its transition on. A record
   * that moved on since then is a conflict, never an overwrite.
   */
  public async save(lease: WriteLeaseRecord, expectedEpoch: number): Promise<LeaseSaveResult> {
    return this.withGate(async () => {
      const current = normalizeWriteLease(await this.readRaw(), lease.workspaceKey);
      if (current.epoch !== expectedEpoch) return { status: 'conflict', lease: current };
      await writeJsonAtomic(this.leaseUri, lease, { durable: true });
      return { status: 'saved', lease };
    });
  }

  /**
   * Acquire inside one critical section: read, decide, write.
   *
   * Returning the refused lease (instead of a boolean) is what lets the caller
   * name the current holder in the UI.
   */
  public async acquire(
    workspaceKey: string,
    request: AcquireRequest,
    alive: LivenessProbe = isProcessAlive,
    now: Date = new Date()
  ): Promise<{ acquired: boolean; lease: WriteLeaseRecord }> {
    return this.withGate(async () => {
      const current = normalizeWriteLease(await this.readRaw(), workspaceKey);
      const outcome = tryAcquire(current, request, now, alive);
      if (!outcome.applied) {
        // Already mine: report success without rewriting the record, so a
        // repeated acquire inside one batch keeps the same epoch.
        const mine = current.state === 'held' && current.holderSessionId === request.sessionId;
        return { acquired: mine, lease: mine ? current : outcome.lease };
      }
      await writeJsonAtomic(this.leaseUri, outcome.lease, { durable: true });
      return { acquired: true, lease: outcome.lease };
    });
  }

  /** Extend the lease. A stale epoch is ignored: it belongs to a finished claim. */
  public async renew(
    workspaceKey: string,
    sessionId: string,
    epoch: number,
    now: Date = new Date()
  ): Promise<{ renewed: boolean; lease: WriteLeaseRecord }> {
    return this.withGate(async () => {
      const current = normalizeWriteLease(await this.readRaw(), workspaceKey);
      const outcome = heartbeat(current, sessionId, epoch, now);
      if (!outcome.applied) return { renewed: false, lease: current };
      await writeJsonAtomic(this.leaseUri, outcome.lease, { durable: true });
      return { renewed: true, lease: outcome.lease };
    });
  }

  /** Release at the epoch that acquired it; never a foreign holder's claim. */
  public async release(
    workspaceKey: string,
    sessionId: string,
    epoch: number
  ): Promise<{ released: boolean; lease: WriteLeaseRecord }> {
    return this.withGate(async () => {
      const current = normalizeWriteLease(await this.readRaw(), workspaceKey);
      const outcome = release(current, sessionId, epoch);
      if (!outcome.applied) return { released: false, lease: current };
      await writeJsonAtomic(this.leaseUri, outcome.lease, { durable: true });
      return { released: true, lease: outcome.lease };
    });
  }

  /** Audited emergency release. Used only by an explicit user action. */
  public async forceRelease(workspaceKey: string): Promise<WriteLeaseRecord> {
    return this.withGate(async () => {
      const current = normalizeWriteLease(await this.readRaw(), workspaceKey);
      const outcome = forceRelease(current);
      if (!outcome.applied) return current;
      await writeJsonAtomic(this.leaseUri, outcome.lease, { durable: true });
      return outcome.lease;
    });
  }

  private withGate<T>(work: () => Promise<T>): Promise<T> {
    return withAssociatedStoreGate(vscode.Uri.joinPath(this.leaseUri, '..'), 'write-lease', work);
  }

  private async readRaw(): Promise<unknown | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.leaseUri);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!bytes.byteLength) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      // A damaged lock file must never block the project: treat it as free.
      return undefined;
    }
  }
}