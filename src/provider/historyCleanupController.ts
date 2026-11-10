import * as vscode from 'vscode';
import { GlobalSessionStorage } from '../sessions/globalSessionStorage';
import { SessionAssociatedDataCleanup } from '../sessions/sessionAssociatedDataCleanup';
import { FileHistoryCleanupJournal, SessionHistoryCleanupService, type HistoryCleanupTarget, type HistoryCleanupTargetResult } from '../sessions/sessionHistoryCleanup';
import { SESSION_STORAGE_KEY } from '../sessions/chatSessionStore';

/** Store ownership and local UI bookkeeping are callbacks, never disk paths
 * supplied by the Webview. The storage gate performs the final destructive check. */
export function createHistoryCleanupController(storageUri: vscode.Uri, workspaceKey: string,
  associated: SessionAssociatedDataCleanup, hooks: {
    currentSessionId(): string;
    currentWorkspaceKey(): string;
    protectedReason(target: HistoryCleanupTarget): string | undefined;
    settle(target: HistoryCleanupTarget): Promise<void>;
    removed(target: HistoryCleanupTarget): Promise<void>;
    workspaceState?: vscode.Memento;
  }): SessionHistoryCleanupService {
  const storage = new GlobalSessionStorage(storageUri);
  const finish = async (target: HistoryCleanupTarget, operationId: string, base: HistoryCleanupTargetResult): Promise<HistoryCleanupTargetResult> => {
    // Detach stale in-memory proposals before any optional physical reclamation.
    await hooks.removed(target);
    const result = await associated.cleanup(target.id, target.workspaceKey);
    const pendingReasons = [...result.pendingReasons];
    if (base.reason && base.reason !== 'associated_cleanup_required') pendingReasons.push('session_storage_pending');
    let inaccessibleLegacySource = base.inaccessibleLegacySource === true;
    if (target.workspaceKey === workspaceKey && hooks.workspaceState) {
      try {
        const raw = hooks.workspaceState.get<Record<string, unknown>>(SESSION_STORAGE_KEY);
        if (raw && typeof raw === 'object' && Array.isArray(raw.sessions)) {
          const sessions = raw.sessions.filter(item => !item || typeof item !== 'object' || (item as { id?: unknown }).id !== target.id);
          const selections = raw.activeSessionIdsByWorkspace;
          const activeSessionIdsByWorkspace = selections && typeof selections === 'object' && !Array.isArray(selections)
            ? Object.fromEntries(Object.entries(selections).filter(([key, id]) => key !== target.workspaceKey || id !== target.id)) : selections;
          if (sessions.length !== raw.sessions.length || raw.activeSessionId === target.id
            || JSON.stringify(activeSessionIdsByWorkspace) !== JSON.stringify(selections)) await hooks.workspaceState.update(SESSION_STORAGE_KEY,
            { ...raw, sessions, activeSessionIdsByWorkspace, ...(raw.activeSessionId === target.id ? { activeSessionId: '' } : {}) });
        }
        inaccessibleLegacySource = false;
      } catch { pendingReasons.push('workspace_state_cleanup_failed'); }
    }
    if (inaccessibleLegacySource) pendingReasons.push('inaccessible_legacy_source');
    if (result.inaccessibleLegacySources) pendingReasons.push('unverified_legacy_logs');
    const pending = pendingReasons.length > 0;
    const record = await storage.deletionAuthority.readRecord(target.id);
    if (!record || record.operationId !== operationId) throw new Error('Deletion operation identity changed');
    await storage.deletionAuthority.updateDeletion(target.id, pending ? 'committed' : 'reclaimed', pendingReasons);
    return { status: pending ? 'removedPendingCleanup' : 'fullyDeleted',
      reason: pendingReasons.join(';') || undefined, inaccessibleLegacySource };
  };
  return new SessionHistoryCleanupService({
    readCatalog: async (scope, current) => {
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
