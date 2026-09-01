import { writeJsonAtomic } from '../shared/atomicStorage';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { ChatSessionStore } from '../sessions/chatSessionStore';
import type {
  ChangeCheckpoint,
  ChangeSet,
  ChangeSetApplyFailure,
  ChangeSetApplyResult,
  ChangeSetFile,
  ChangeSetRevertResult,
  DraftEdit
} from '../shared/types';
import { getErrorMessage } from '../shared/errors';
import type { DraftDiffService } from './draftDiffService';
import type { SafeFileEditor } from './safeFileEditor';
import { createChangeSet } from './changeSet';

type Translator = (key: string, values?: Record<string, string | number>) => string;
type ChangeSetTraceHandler = (changeSet: ChangeSet, event: Record<string, unknown>) => void;
const MAX_COMPACT_HISTORY_CHANGE_SETS = 500;

type WebviewChangeSetFile = Omit<
  ChangeSetFile,
  'newText' | 'expectedOriginalTextHash' | 'expectedOriginalSize'
>;

export type WebviewChangeSet = Omit<ChangeSet, 'files'> & {
  files: WebviewChangeSetFile[];
};

export interface PendingDeleteTarget {
  id: string;
  uri: string;
  label: string;
}

export class ChangeSetStore {
  private readonly changeSets = new Map<string, ChangeSet>();
  private readonly historicalChangeSets = new Map<string, WebviewChangeSet>();
  private readonly checkpoints = new Map<string, ChangeCheckpoint>();
  private readonly storageUri: vscode.Uri;
  private persistenceError?: unknown;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  public constructor(
    private readonly safeFileEditor: SafeFileEditor,
    private readonly diffService: DraftDiffService,
    private readonly sessionStore: ChatSessionStore,
    globalStorageUri: vscode.Uri,
    private readonly t: Translator,
    private readonly onTraceEvent?: ChangeSetTraceHandler
  ) {
    this.storageUri = vscode.Uri.joinPath(globalStorageUri, 'change-sets.json');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    try {
      const content = new TextDecoder('utf-8', { fatal: false }).decode(
        await vscode.workspace.fs.readFile(this.storageUri)
      );
      const parsed = JSON.parse(content) as {
        version?: number;
        changeSets?: ChangeSet[];
        history?: WebviewChangeSet[];
        checkpoints?: ChangeCheckpoint[];
      };
      if (parsed.version !== 1 && parsed.version !== 2) {
        return;
      }
      let consolidatedStoredChangeSets = false;
      const mergedChangeSetIds = new Map<string, string>();
      const storedChangeSets = (parsed.changeSets ?? [])
        .filter(isStoredChangeSet)
        .map(normalizeStoredChangeSet)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      for (const changeSet of storedChangeSets) {
        const existing = this.findActiveChangeSetForRun(changeSet);
        if (!existing) {
          this.changeSets.set(changeSet.id, changeSet);
          continue;
        }
        this.mergeIntoActiveChangeSet(existing, changeSet);
        mergedChangeSetIds.set(changeSet.id, existing.id);
        // Even an identical cumulative snapshot must be persisted away: it was
        // a second stored ChangeSet for the same logical Agent run.
        consolidatedStoredChangeSets = true;
      }
      for (const changeSet of parsed.history ?? []) {
        if (isStoredHistoricalChangeSet(changeSet)) {
          this.historicalChangeSets.set(changeSet.id, cloneWebviewChangeSet(changeSet));
        }
      }
      for (const checkpoint of parsed.checkpoints ?? []) {
        if (isStoredCheckpoint(checkpoint)) {
          this.checkpoints.set(checkpoint.id, {
            ...checkpoint,
            changeSetId: mergedChangeSetIds.get(checkpoint.changeSetId) ?? checkpoint.changeSetId
          });
        }
      }
      if (consolidatedStoredChangeSets) {
        this.schedulePersist();
      }
    } catch {
      // Missing or malformed checkpoint storage must not block the chat view.
    }
  }

  public async flush(): Promise<void> {
    await this.persistenceQueue;
    if (this.persistenceError) throw this.persistenceError;
  }

  public add(changeSet: ChangeSet): ChangeSet | undefined {
    const existing = this.findActiveChangeSetForRun(changeSet);
    if (existing) {
      const result = this.mergeIntoActiveChangeSet(existing, changeSet);
      const mergedIdentity = existing.id !== changeSet.id;
      if (result.changed || mergedIdentity) {
        this.recordTrace(existing, {
          type: 'change_set_merged',
          changeSetId: existing.id,
          incomingChangeSetId: changeSet.id,
          addedEditIds: result.addedEditIds,
          fileCount: existing.fileCount,
          operationSummary: existing.operationSummary
        });
      }
      if (result.changed) {
        this.schedulePersist();
      }
      return cloneChangeSet(existing);
    }

    const known = this.collectKnownEditIds(changeSet.id);
    const files = changeSet.files.filter((file) => !known.has(file.id));
    if (!files.length) return undefined;
    const registered = cloneChangeSet({ ...changeSet, files, fileCount: files.length });
    this.changeSets.set(registered.id, registered);
    this.historicalChangeSets.delete(registered.id);
    this.recordTrace(registered, {
      type: 'change_set_registered',
      changeSetId: registered.id,
      fileCount: registered.fileCount,
      operationSummary: registered.operationSummary
    });
    this.schedulePersist();
    return cloneChangeSet(registered);
  }

  public addDraftEdits(input: {
    edits: readonly DraftEdit[];
    runId?: string;
    sessionId?: string;
    messageId?: string;
    traceLogUri?: string;
    operationSummary?: string;
  }): ChangeSet | undefined {
    const changeSet = createChangeSet({
      runId: input.runId ?? randomUUID(),
      sessionId: input.sessionId,
      messageId: input.messageId,
      traceLogUri: input.traceLogUri,
      edits: input.edits,
      operationSummary: input.operationSummary
    });
    return changeSet ? this.add(changeSet) : undefined;
  }

  private findActiveChangeSetForRun(changeSet: ChangeSet): ChangeSet | undefined {
    const byId = this.changeSets.get(changeSet.id);
    if (byId) {
      return byId;
    }
    return Array.from(this.changeSets.values()).find((existing) => (
      Boolean(changeSet.runId)
      && existing.runId === changeSet.runId
      && existing.sessionId === changeSet.sessionId
      && existing.messageId === changeSet.messageId
    ));
  }

  private collectKnownEditIds(excludedChangeSetId: string): Set<string> {
    return new Set([...this.changeSets.values(), ...this.historicalChangeSets.values()]
      .filter((existing) => existing.id !== excludedChangeSetId)
      .flatMap((existing) => existing.files.map((file) => file.id)));
  }

  private mergeIntoActiveChangeSet(
    target: ChangeSet,
    incoming: ChangeSet
  ): { changed: boolean; addedEditIds: string[] } {
    const knownElsewhere = this.collectKnownEditIds(target.id);
    const targetFilesById = new Map(target.files.map((file) => [file.id, file]));
    const addedEditIds: string[] = [];
    let changed = false;

    for (const incomingFile of incoming.files) {
      const existingFile = targetFilesById.get(incomingFile.id);
      if (existingFile) {
        changed = refreshStoredDraftEdit(existingFile, incomingFile) || changed;
        continue;
      }
      if (knownElsewhere.has(incomingFile.id)) {
        continue;
      }
      const nextFile = { ...incomingFile };
      target.files.push(nextFile);
      targetFilesById.set(nextFile.id, nextFile);
      addedEditIds.push(nextFile.id);
      changed = true;
    }

    if (incoming.operationSummary.trim() && incoming.operationSummary !== target.operationSummary) {
      target.operationSummary = incoming.operationSummary;
      changed = true;
    }
    if (incoming.traceLogUri && incoming.traceLogUri !== target.traceLogUri) {
      target.traceLogUri = incoming.traceLogUri;
      changed = true;
    }
    if (target.fileCount !== target.files.length) {
      target.fileCount = target.files.length;
      changed = true;
    }
    if (changed) {
      this.updateChangeSetStatus(target);
    }
    return { changed, addedEditIds };
  }

  public toWebviewState(sessionId: string): WebviewChangeSet[] {
    const merged = new Map<string, WebviewChangeSet>();
    for (const changeSet of this.historicalChangeSets.values()) {
      merged.set(changeSet.id, cloneWebviewChangeSet(changeSet));
    }
    for (const changeSet of this.changeSets.values()) {
      merged.set(changeSet.id, toWebviewChangeSet(changeSet));
    }
    return Array.from(merged.values())
      .filter((changeSet) => changeSet.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  public hasPendingForSession(sessionId: string): boolean {
    return Array.from(this.changeSets.values()).some((changeSet) =>
      changeSet.sessionId === sessionId && changeSet.files.some(isApplicable)
    );
  }

  public getLatestChangeSetId(sessionId: string): string | undefined {
    return Array.from(this.changeSets.values())
      .filter((changeSet) => changeSet.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0]?.id;
  }

  public getChangeSetStatus(changeSetId: string): ChangeSet['status'] | undefined {
    return this.changeSets.get(changeSetId)?.status ?? this.historicalChangeSets.get(changeSetId)?.status;
  }

  public getPendingDeleteTargetsForEdit(editId: string): PendingDeleteTarget[] {
    const found = this.findEdit(editId);
    return found && found.edit.action === 'delete' && isApplicable(found.edit)
      ? [toPendingDeleteTarget(found.edit)]
      : [];
  }

  public getPendingDeleteTargetsForChangeSet(changeSetId: string): PendingDeleteTarget[] {
    const changeSet = this.changeSets.get(changeSetId);
    return changeSet
      ? changeSet.files
        .filter((file) => file.action === 'delete' && isApplicable(file))
        .map(toPendingDeleteTarget)
      : [];
  }

  public isChangeSetFullyApplied(changeSetId: string): boolean {
    const changeSet = this.changeSets.get(changeSetId);
    return Boolean(changeSet?.files.length) && changeSet?.files.every((file) => file.status === 'applied') === true;
  }

  public async openDiff(editId: string): Promise<boolean> {
    const found = this.findEdit(editId);
    if (!found) {
      return false;
    }
    const checkpoint = found.edit.checkpointId
      ? this.checkpoints.get(found.edit.checkpointId)
      : undefined;
    await this.diffService.openDiff(found.edit, checkpoint);
    return true;
  }

  public async openEditFile(editId: string): Promise<boolean> {
    const found = this.findEdit(editId);
    if (!found) {
      return false;
    }
    const uri = vscode.Uri.parse(found.edit.uri);
    if (!vscode.workspace.getWorkspaceFolder(uri)) {
      throw new Error(this.t('cannotOpenDraftEditOutsideWorkspace', { label: found.edit.label }));
    }
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(this.t('draftEditFileNotFound', { label: found.edit.label }));
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
    return true;
  }

  public async applyEdit(editId: string): Promise<ChangeSetApplyResult | undefined> {
    const found = this.findEdit(editId);
    if (!found || !isApplicable(found.edit)) {
      return undefined;
    }
    const result = await this.applyFiles(found.changeSet, [found.edit]);
    if (result.appliedEditIds.length) {
      await this.recordAppliedResult(found.changeSet, result).catch(() => undefined);
    }
    return result;
  }

  public async applyAll(changeSetId: string): Promise<ChangeSetApplyResult | undefined> {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) {
      return undefined;
    }
    const files = changeSet.files.filter(isApplicable);
    if (!files.length) {
      return undefined;
    }
    const result = await this.applyFiles(changeSet, files);
    if (result.appliedEditIds.length) {
      await this.recordAppliedResult(changeSet, result).catch(() => undefined);
    }
    return result;
  }

  public discardEdit(editId: string): boolean {
    const found = this.findEdit(editId);
    if (!found || !isApplicable(found.edit)) {
      return false;
    }
    found.edit.status = 'discarded';
    found.edit.error = undefined;
    this.updateChangeSetStatus(found.changeSet);
    this.recordTrace(found.changeSet, {
      type: 'change_set_file_discarded',
      changeSetId: found.changeSet.id,
      editId: found.edit.id,
      label: found.edit.label
    });
    this.compactTerminalChangeSet(found.changeSet);
    this.schedulePersist();
    return true;
  }

  public discardAll(changeSetId: string): boolean {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) {
      return false;
    }
    let changed = false;
    for (const file of changeSet.files) {
      if (!isApplicable(file)) {
        continue;
      }
      file.status = 'discarded';
      file.error = undefined;
      changed = true;
    }
    if (!changed) {
      return false;
    }
    this.updateChangeSetStatus(changeSet);
    this.recordTrace(changeSet, {
      type: 'change_set_discarded',
      changeSetId: changeSet.id
    });
    this.compactTerminalChangeSet(changeSet);
    this.schedulePersist();
    return true;
  }

  public async revertEdit(editId: string): Promise<ChangeSetRevertResult | undefined> {
    const found = this.findEdit(editId);
    if (!found || !isRevertible(found.edit)) {
      return undefined;
    }
    const result = await this.revertFiles(found.changeSet, [found.edit]);
    if (result.revertedEditIds.length) {
      await this.recordRevertedResult(found.changeSet, result).catch(() => undefined);
    }
    return result;
  }

  public async revertAll(changeSetId: string): Promise<ChangeSetRevertResult | undefined> {
    const changeSet = this.changeSets.get(changeSetId);
    if (!changeSet) {
      return undefined;
    }
    const files = changeSet.files.filter(isRevertible).reverse();
    if (!files.length) {
      return undefined;
    }
    const result = await this.revertFiles(changeSet, files);
    if (result.revertedEditIds.length) {
      await this.recordRevertedResult(changeSet, result).catch(() => undefined);
    }
    return result;
  }

  public clearSession(sessionId: string): void {
    for (const [changeSetId, changeSet] of this.changeSets) {
      if (changeSet.sessionId !== sessionId) {
        continue;
      }
      this.changeSets.delete(changeSetId);
      this.historicalChangeSets.delete(changeSetId);
      for (const file of changeSet.files) {
        if (file.checkpointId) {
          this.checkpoints.delete(file.checkpointId);
        }
      }
    }
    for (const [changeSetId, changeSet] of this.historicalChangeSets) {
      if (changeSet.sessionId === sessionId) {
        this.historicalChangeSets.delete(changeSetId);
      }
    }
    this.schedulePersist();
  }

  public discardPendingForSession(sessionId: string): void {
    let changed = false;
    for (const changeSet of this.changeSets.values()) {
      if (changeSet.sessionId !== sessionId) {
        continue;
      }
      let changeSetChanged = false;
      for (const file of changeSet.files) {
        if (!isApplicable(file)) {
          continue;
        }
        file.status = 'discarded';
        file.error = undefined;
        changed = true;
        changeSetChanged = true;
      }
      this.updateChangeSetStatus(changeSet);
      if (changeSetChanged) {
        this.recordTrace(changeSet, {
          type: 'change_set_discarded',
          changeSetId: changeSet.id
        });
        this.compactTerminalChangeSet(changeSet);
      }
    }
    if (changed) {
      this.schedulePersist();
    }
  }

  public clear(): void {
    this.changeSets.clear();
    this.historicalChangeSets.clear();
    this.checkpoints.clear();
    this.schedulePersist();
  }

  private async applyFiles(changeSet: ChangeSet, files: ChangeSetFile[]): Promise<ChangeSetApplyResult> {
    const appliedEditIds: string[] = [];
    const failed: ChangeSetApplyFailure[] = [];
    for (const file of files) {
      try {
        const checkpoint = await this.safeFileEditor.applyDraftEdit(file, changeSet.id);
        this.checkpoints.set(checkpoint.id, checkpoint);
        file.checkpointId = checkpoint.id;
        file.status = 'applied';
        file.error = undefined;
        appliedEditIds.push(file.id);
      } catch (error) {
        const message = getErrorMessage(error);
        file.status = 'apply_failed';
        file.error = message;
        failed.push({ editId: file.id, label: file.label, error: message });
      }
    }
    const result: ChangeSetApplyResult = {
      changeSetId: changeSet.id,
      attempted: files.length,
      appliedEditIds,
      failed,
      completedAt: new Date().toISOString()
    };
    changeSet.lastApplyResult = result;
    this.updateChangeSetStatus(changeSet);
    this.recordTrace(changeSet, {
      type: 'change_set_apply_result',
      result
    });
    this.schedulePersist();
    return result;
  }

  private async revertFiles(changeSet: ChangeSet, files: ChangeSetFile[]): Promise<ChangeSetRevertResult> {
    const revertedEditIds: string[] = [];
    const failed: ChangeSetApplyFailure[] = [];
    for (const file of files) {
      const checkpoint = file.checkpointId ? this.checkpoints.get(file.checkpointId) : undefined;
      if (!checkpoint) {
        const error = this.t('changeCheckpointUnavailable', { label: file.label });
        file.status = 'revert_failed';
        file.error = error;
        failed.push({ editId: file.id, label: file.label, error });
        continue;
      }
      try {
        const revertedCheckpoint = await this.safeFileEditor.revertCheckpoint(checkpoint);
        this.checkpoints.set(revertedCheckpoint.id, revertedCheckpoint);
        file.status = 'reverted';
        file.error = undefined;
        revertedEditIds.push(file.id);
      } catch (error) {
        const message = getErrorMessage(error);
        file.status = 'revert_failed';
        file.error = message;
        failed.push({ editId: file.id, label: file.label, error: message });
      }
    }
    const result: ChangeSetRevertResult = {
      changeSetId: changeSet.id,
      attempted: files.length,
      revertedEditIds,
      failed,
      completedAt: new Date().toISOString()
    };
    this.updateChangeSetStatus(changeSet);
    this.recordTrace(changeSet, {
      type: 'change_set_revert_result',
      result
    });
    this.compactTerminalChangeSet(changeSet);
    this.schedulePersist();
    return result;
  }

  private async recordAppliedResult(changeSet: ChangeSet, result: ChangeSetApplyResult): Promise<void> {
    const session = this.sessionStore.getActiveSession();
    if (session.id !== changeSet.sessionId) {
      return;
    }
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: result.failed.length
        ? this.t('changeSetAppliedPartial', {
            applied: result.appliedEditIds.length,
            failed: result.failed.length
          })
        : this.t('changeSetApplied', { count: result.appliedEditIds.length }),
      createdAt: new Date().toISOString(),
      contextMeta: {
        isProtected: true,
        protectedReason: 'draft_edit_result'
      }
    });
    session.updatedAt = new Date().toISOString();
    await this.sessionStore.persist();
  }

  private async recordRevertedResult(changeSet: ChangeSet, result: ChangeSetRevertResult): Promise<void> {
    const session = this.sessionStore.getActiveSession();
    if (session.id !== changeSet.sessionId) {
      return;
    }
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: result.failed.length
        ? this.t('changeSetRevertedPartial', {
            reverted: result.revertedEditIds.length,
            failed: result.failed.length
          })
        : this.t('changeSetReverted', { count: result.revertedEditIds.length }),
      createdAt: new Date().toISOString(),
      contextMeta: {
        isProtected: true,
        protectedReason: 'draft_edit_result'
      }
    });
    session.updatedAt = new Date().toISOString();
    await this.sessionStore.persist();
  }

  private updateChangeSetStatus(changeSet: ChangeSet): void {
    const statuses = changeSet.files.map((file) => file.status);
    if (statuses.every((status) => status === 'discarded')) {
      changeSet.status = 'discarded';
    } else if (statuses.every((status) => status === 'reverted' || status === 'discarded')) {
      changeSet.status = 'reverted';
    } else if (statuses.every((status) => status === 'applied' || status === 'discarded')) {
      changeSet.status = 'applied';
    } else if (statuses.some((status) => status === 'apply_failed' || status === 'revert_failed')) {
      changeSet.status = 'partially_failed';
    } else if (statuses.some((status) => status === 'applied' || status === 'reverted')) {
      changeSet.status = 'partially_applied';
    } else {
      changeSet.status = 'pending';
    }
    changeSet.updatedAt = new Date().toISOString();
  }

  private findEdit(editId: string): { changeSet: ChangeSet; edit: ChangeSetFile } | undefined {
    for (const changeSet of this.changeSets.values()) {
      const edit = changeSet.files.find((file) => file.id === editId);
      if (edit) {
        return { changeSet, edit };
      }
    }
    return undefined;
  }

  private recordTrace(changeSet: ChangeSet, event: Record<string, unknown>): void {
    this.onTraceEvent?.(cloneChangeSet(changeSet), event);
  }

  private compactTerminalChangeSet(changeSet: ChangeSet): void {
    if (requiresRuntimeState(changeSet)) {
      return;
    }
    this.historicalChangeSets.set(changeSet.id, toWebviewChangeSet(changeSet));
    this.changeSets.delete(changeSet.id);
    for (const file of changeSet.files) {
      if (file.checkpointId) {
        this.checkpoints.delete(file.checkpointId);
      }
    }
  }

  private schedulePersist(): void {
    const changeSets = Array.from(this.changeSets.values())
      .filter(requiresRuntimeState)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneChangeSet);
    const historyById = new Map(this.historicalChangeSets);
    for (const changeSet of this.changeSets.values()) {
      if (requiresRuntimeState(changeSet)) {
        historyById.delete(changeSet.id);
      } else {
        historyById.set(changeSet.id, toWebviewChangeSet(changeSet));
      }
    }
    const history = Array.from(historyById.values())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_COMPACT_HISTORY_CHANGE_SETS)
      .map(cloneWebviewChangeSet);
    this.historicalChangeSets.clear();
    for (const changeSet of history) {
      this.historicalChangeSets.set(changeSet.id, changeSet);
    }
    const checkpointIds = new Set(
      changeSets.flatMap((changeSet) => changeSet.files
        .map((file) => file.checkpointId)
        .filter((id): id is string => Boolean(id)))
    );
    const checkpoints = Array.from(this.checkpoints.values())
      .filter((checkpoint) => checkpointIds.has(checkpoint.id))
      .map((checkpoint) => ({ ...checkpoint }));
    const bytes = new TextEncoder().encode(JSON.stringify({
      version: 2,
      changeSets,
      history,
      checkpoints
    }));
    this.persistenceQueue = this.persistenceQueue
      .then(async () => {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.storageUri, '..'));
        await writeJsonAtomic(this.storageUri, JSON.parse(new TextDecoder().decode(bytes)));
        this.persistenceError = undefined;
      })
      .catch((error: unknown) => {
        this.persistenceError = error; // Critical callers observe this through flush().
      });
  }
}

function isApplicable(file: ChangeSetFile): boolean {
  return file.status === 'pending' || file.status === 'apply_failed';
}

function isRevertible(file: ChangeSetFile): boolean {
  return file.status === 'applied' || file.status === 'revert_failed';
}

function requiresRuntimeState(changeSet: ChangeSet): boolean {
  return changeSet.files.some((file) => isApplicable(file) || isRevertible(file));
}

function cloneChangeSet(changeSet: ChangeSet): ChangeSet {
  return {
    ...changeSet,
    files: changeSet.files.map((file) => ({ ...file })),
    lastApplyResult: changeSet.lastApplyResult
      ? {
          ...changeSet.lastApplyResult,
          appliedEditIds: [...changeSet.lastApplyResult.appliedEditIds],
          failed: changeSet.lastApplyResult.failed.map((failure) => ({ ...failure }))
        }
      : undefined
  };
}

function refreshStoredDraftEdit(target: ChangeSetFile, incoming: ChangeSetFile): boolean {
  const next = {
    uri: incoming.uri,
    label: incoming.label,
    action: incoming.action,
    newText: incoming.newText,
    reason: incoming.reason,
    expectedOriginalTextHash: incoming.expectedOriginalTextHash ?? target.expectedOriginalTextHash,
    expectedOriginalSize: incoming.expectedOriginalSize ?? target.expectedOriginalSize
  };
  const changed = target.uri !== next.uri
    || target.label !== next.label
    || target.action !== next.action
    || target.newText !== next.newText
    || target.reason !== next.reason
    || target.expectedOriginalTextHash !== next.expectedOriginalTextHash
    || target.expectedOriginalSize !== next.expectedOriginalSize;
  if (changed) {
    Object.assign(target, next);
  }
  return changed;
}

function normalizeStoredChangeSet(changeSet: ChangeSet): ChangeSet {
  return cloneChangeSet({
    ...changeSet,
    messageId: typeof changeSet.messageId === 'string' ? changeSet.messageId : ''
  });
}

function toWebviewChangeSet(changeSet: ChangeSet): WebviewChangeSet {
  return {
    ...changeSet,
    files: changeSet.files.map(({
      newText: _newText,
      expectedOriginalTextHash: _expectedOriginalTextHash,
      expectedOriginalSize: _expectedOriginalSize,
      ...file
    }) => ({ ...file })),
    lastApplyResult: changeSet.lastApplyResult
      ? {
          ...changeSet.lastApplyResult,
          appliedEditIds: [...changeSet.lastApplyResult.appliedEditIds],
          failed: changeSet.lastApplyResult.failed.map((failure) => ({ ...failure }))
        }
      : undefined
  };
}

function toPendingDeleteTarget(file: ChangeSetFile): PendingDeleteTarget {
  return {
    id: file.id,
    uri: file.uri,
    label: file.label
  };
}

function cloneWebviewChangeSet(changeSet: WebviewChangeSet): WebviewChangeSet {
  return {
    ...changeSet,
    messageId: typeof changeSet.messageId === 'string' ? changeSet.messageId : '',
    files: changeSet.files.map((file) => ({
      id: file.id,
      uri: file.uri,
      label: file.label,
      action: file.action,
      reason: file.reason,
      status: file.status,
      error: file.error,
      checkpointId: file.checkpointId
    })),
    lastApplyResult: changeSet.lastApplyResult
      ? {
          ...changeSet.lastApplyResult,
          appliedEditIds: [...changeSet.lastApplyResult.appliedEditIds],
          failed: changeSet.lastApplyResult.failed.map((failure) => ({ ...failure }))
        }
      : undefined
  };
}

function isStoredChangeSet(value: unknown): value is ChangeSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.runId === 'string'
    && typeof record.sessionId === 'string'
    && Array.isArray(record.files);
}

function isStoredCheckpoint(value: unknown): value is ChangeCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.changeSetId === 'string'
    && typeof record.editId === 'string'
    && typeof record.uri === 'string';
}

function isStoredHistoricalChangeSet(value: unknown): value is WebviewChangeSet {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string'
    && typeof record.runId === 'string'
    && typeof record.sessionId === 'string'
    && Array.isArray(record.files);
}
