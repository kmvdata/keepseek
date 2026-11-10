import * as vscode from 'vscode';
import { ToolEvidenceStore } from '../agent/evidence/store';
import { SubagentStore } from '../agent/subagents/store';
import { UsageLedgerStore } from '../agent/usageLedgerStore';
import { InteractionTraceCleanup } from '../agent/logging/interactionTrace';
import { ApprovalReviewStore } from '../approvals/approvalReviewStore';
import { ChangeSetStore, deleteStoredChangeSetsForSession, hasStoredChangeSetsForSession } from '../edits/changeSetStore';
import { DraftRunStore } from '../runs/draftRunStore';
import { SessionDeletionAuthority } from './sessionDeletionAuthority';
import { assertManagedStoragePath } from './sessionAssociatedPersistence';

export interface SessionAssociatedCleanupStores {
  changeSets?: ChangeSetStore;
  draftRuns?: DraftRunStore;
  approvalReviews?: ApprovalReviewStore;
  usageLedgerStore?: UsageLedgerStore;
}
export interface SessionAssociatedCleanupResult {
  pendingReasons: string[];
  completedStores: string[];
  unverifiedSources: number;
}

/** Session-owned physical cleanup. Call after the durable tombstone, outside
 * the session gate. Every store serializes recycling with its own writers.
 * Shared artifacts are reclaimed exclusively by the existing reference GC. */
export class SessionAssociatedDataCleanup {
  private readonly traces: InteractionTraceCleanup;
  public constructor(private readonly root: vscode.Uri, private readonly live: SessionAssociatedCleanupStores = {}) { this.traces = new InteractionTraceCleanup(root); }

  public async hasSessionHistory(sessionId: string, workspaceKey: string): Promise<boolean> {
    const stores = [
      () => new ToolEvidenceStore(this.root).hasSessionHistory(sessionId),
      () => new SubagentStore(this.root, workspaceKey).hasSessionHistory(sessionId),
      () => this.traces.hasSessionHistory(sessionId),
      () => (this.live.usageLedgerStore ?? new UsageLedgerStore(this.root)).hasSessionHistory(sessionId),
      () => hasStoredChangeSetsForSession(this.root, sessionId),
      () => (this.live.draftRuns ?? new DraftRunStore(this.root)).hasSessionHistory(sessionId),
      () => (this.live.approvalReviews ?? new ApprovalReviewStore(this.root)).hasSessionHistory(sessionId)
    ];
    for (const has of stores) if (await has()) return true;
    return false;
  }

  public async cleanup(sessionId: string, workspaceKey: string): Promise<SessionAssociatedCleanupResult> {
    const record = await new SessionDeletionAuthority(this.root).readRecord(sessionId);
    if (!record || record.workspaceKey !== workspaceKey) throw new Error('A matching durable deletion intent is required.');
    const result: SessionAssociatedCleanupResult = { pendingReasons: [], completedStores: [], unverifiedSources: 0 };
    const evidence = new ToolEvidenceStore(this.root), subagents = new SubagentStore(this.root, workspaceKey);
    const runs = this.live.draftRuns ?? new DraftRunStore(this.root);
    const reviews = this.live.approvalReviews ?? new ApprovalReviewStore(this.root);
    const ledger = this.live.usageLedgerStore ?? new UsageLedgerStore(this.root);
    const stores: Array<[string, string[], () => Promise<unknown>]> = [
      ['evidence', ['chat-sessions'], () => evidence.deleteSessionEvidence(sessionId)],
      ['subagents', ['chat-sessions'], () => subagents.deleteSession(sessionId)],
      ['usage-ledger', ['usage-ledger'], () => ledger.deleteSession(sessionId)],
      ['change-sets', ['change-sets', 'change-sets.json'], () => this.live.changeSets
        ? this.live.changeSets.deleteSession(sessionId) : deleteStoredChangeSetsForSession(this.root, sessionId)],
      ['draft-runs', ['draft-runs.json'], () => runs.deleteSession(sessionId)],
      ['approval-reviews', ['approval-reviews.json'], () => reviews.deleteSession(sessionId)],
      ['interaction-traces', ['interaction-logs'], async () => {
        const traces = await this.traces.cleanup(sessionId);
        if (traces.unverifiedSources) {
          result.unverifiedSources += traces.unverifiedSources;
          result.pendingReasons.push('interaction-traces:ownership_unverified');
        }
      }]
    ];
    for (const [name, paths, reclaim] of stores) {
      try {
        for (const path of paths) await assertManagedStoragePath(this.root, vscode.Uri.joinPath(this.root, path));
        await reclaim();
        result.completedStores.push(name);
      } catch (error) {
        const code = typeof error === 'object' && error ? String((error as { code?: unknown }).code ?? 'unavailable') : 'unavailable';
        result.pendingReasons.push(`${name}:${/^[A-Za-z_]+$/u.test(code) ? code : 'unavailable'}`);
      }
    }
    return result;
  }
}
