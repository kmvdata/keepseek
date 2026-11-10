import * as vscode from 'vscode';
import { GlobalSessionStorage } from '../sessions/globalSessionStorage';
import { SessionAssociatedDataCleanup } from '../sessions/sessionAssociatedDataCleanup';
import { FileHistoryCleanupJournal, SessionHistoryCleanupService, type HistoryCleanupTarget, type HistoryCleanupTargetResult } from '../sessions/sessionHistoryCleanup';
import { HistoryCleanupFailure } from '../sessions/historyCleanupErrors';

/** Store ownership and local UI bookkeeping are callbacks, never disk paths
 * supplied by the Webview. The storage gate performs the final destructive check. */
export function createHistoryCleanupController(storageUri: vscode.Uri, workspaceKey: string,
  associated: SessionAssociatedDataCleanup, hooks: {
    currentSessionId(): string;
    currentWorkspaceKey(): string;
    protectedReason(target: HistoryCleanupTarget): string | undefined;
    settle(target: HistoryCleanupTarget): Promise<void>;
    removed(target: HistoryCleanupTarget): Promise<void>;
  }): SessionHistoryCleanupService {
  const storage = new GlobalSessionStorage(storageUri);
  const finish = async (target: HistoryCleanupTarget, operationId: string, base: HistoryCleanupTargetResult): Promise<HistoryCleanupTargetResult> => {
    // Detach stale in-memory proposals before any optional physical reclamation.
    await hooks.removed(target);
    const result = await associated.cleanup(target.id, target.workspaceKey);
    const pendingReasons = [...result.pendingReasons];
    if (base.reason && base.reason !== 'associated_cleanup_required') pendingReasons.push('session_storage_pending');
    if (result.unverifiedSources) pendingReasons.push('unverified_logs');
    const pending = pendingReasons.length > 0;
    const record = await storage.deletionAuthority.readRecord(target.id);
    if (!record || record.operationId !== operationId) throw new Error('Deletion operation identity changed');
    await storage.deletionAuthority.updateDeletion(target.id, pending ? 'committed' : 'reclaimed', pendingReasons);
    return { status: pending ? 'removedPendingCleanup' : 'fullyDeleted',
      reason: pendingReasons.join(';') || undefined };
  };
  return new SessionHistoryCleanupService({
    readCatalog: async (scope, current) => {
      // A broken old result is independent of preview. The durable deletion
      // authority remains a mandatory read-only safety boundary.
      try { await storage.deletionAuthority.listPending(); }
      catch (error) { throw new HistoryCleanupFailure('deletion_authority_unavailable', 'preview', false, { cause: error }); }
      const catalog = await storage.readHistoryCleanupCatalog(scope === 'current' ? current : undefined);
      for (const target of catalog.entries) {
        if (!target.hasHistory) {
          try { target.hasHistory = await associated.hasSessionHistory(target.id, target.workspaceKey); }
          catch { target.unknownReason = 'associated_history_unavailable'; }
        }
        target.protectedReason ??= hooks.protectedReason(target);
      }
      return catalog;
    },
    revalidateTarget: async target => hooks.currentWorkspaceKey() === workspaceKey
      && !hooks.protectedReason(target) && await storage.revalidateHistoryCleanupTarget(target),
    deleteTarget: async (target, operationId) => {
      if (hooks.currentWorkspaceKey() !== workspaceKey) return { status: 'skippedChanged', reason: 'history_changed' };
      if (hooks.protectedReason(target)) return { status: 'protected' };
      await hooks.settle(target);
      if (hooks.protectedReason(target)) return { status: 'protected' };
      return storage.deleteHistoryCleanupTarget(target, operationId);
    },
    finishTarget: finish,
    recoverCommittedTarget: async (target, operationId) => {
      const record = await storage.deletionAuthority.readRecord(target.id);
      if (!record || record.operationId !== operationId || record.workspaceKey !== target.workspaceKey) return undefined;
      if (record.phase === 'reclaimed') { await hooks.removed(target); return { status: 'fullyDeleted' }; }
      const base = await storage.recoverHistoryCleanupTarget(target, operationId);
      if (!base) return undefined;
      return finish(target, operationId, base);
    }
  }, { journal: new FileHistoryCleanupJournal(storageUri, workspaceKey), currentSessionId: hooks.currentSessionId });
}
