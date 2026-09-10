import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ChatSessionStore,
  type ChatSessionStorageAdapter,
  type StoredWorkspaceSessionState,
  type WorkspaceSessionScope
} from '../src/sessions/chatSessionStore';
import {
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
  CURRENT_PROVIDER_TOOL_SCHEMA_VERSION
} from '../src/agent/providerRequestProjection';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { ChatMessage, ChatSession, WorkspaceSummary } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('trimActiveHistory preserves persisted active session messages', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:test',
    name: 'Test Workspace',
    folderUris: []
  };
  const session = createSession(
    'session-1',
    Array.from({ length: 100 }, (_value, index) => createMessage(index)),
    workspaceScope
  );
  const storage = new MemorySessionStorage({
    activeSessionId: session.id,
    sessions: [session]
  });
  session.repairLoop = {
    status: 'waiting_for_apply',
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile',
    pendingDraftEditIds: ['edit-1'],
    stopReason: 'waiting_for_apply'
  };
  session.historyArchive = [{
    id: 'archive-1', messageId: 'm1', toolCallId: 'call-1', toolName: 'read', role: 'tool',
    content: 'complete archived result', contentHash: 'hash-1', createdAt: '2026-01-01T00:00:00.000Z'
  }];
  session.requestProtocol = {
    version: 2, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: 2,
    toolNames: ['keepseek_read_workspace_file_range'], sourceId: 'source-a', createdAt: '2026-01-01T00:00:00.000Z',
    lastProviderRequestAt: '2026-01-01T00:01:00.000Z'
  };
  session.contextCompression = {
    version: 1,
    protectedMessageIds: [],
    summaries: [{
      id: 'legacy-summary',
      content: 'legacy summary content',
      coveredMessageIds: ['m1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 10,
      modelId: 'legacy-model',
      version: 1
    }]
  };
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  store.trimActiveHistory(10);
  await store.persist();

  assert.equal(store.messages.length, 100);
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.modelId, 'legacy-model');
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.sourceId, undefined);
  assert.equal(store.messages[0].id, 'm0');
  assert.equal(store.messages[99].id, 'm99');
  assert.equal(storage.saved?.sessions[0]?.messages.length, 100);
  assert.equal(storage.saved?.sessions[0]?.messages[0]?.id, 'm0');
  assert.deepEqual(storage.saved?.sessions[0]?.repairLoop?.pendingDraftEditIds, ['edit-1']);
  assert.equal(storage.saved?.sessions[0]?.historyArchive?.[0]?.content, 'complete archived result');
  assert.deepEqual(storage.saved?.sessions[0]?.requestProtocol?.toolNames, ['keepseek_read_workspace_file_range']);
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.sourceId, 'source-a');
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.version, 2);
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.serializationStrategy, 'provider-projection-v2');

  const next = await store.createNewSession('en');
  assert.equal(next.requestProtocol?.version, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION);
  assert.equal(next.requestProtocol?.toolSchemaVersion, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION);
  assert.equal(next.requestProtocol?.serializationStrategy, 'provider-projection-v2');
});

test('approval mode persists for the project and is inherited by every new or selected session', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:approval-mode',
    name: 'Approval Workspace',
    folderUris: []
  };
  const original = createSession('original', [createMessage(0)], workspaceScope);
  const older = createSession('older', [createMessage(1)], workspaceScope);
  const storage = new MemorySessionStorage({
    activeSessionId: original.id,
    sessions: [original, older]
  });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'ask');
  assert.equal(await store.setApprovalMode('model_review'), true);
  assert.equal(storage.saved?.approvalMode, 'model_review');

  const created = await store.createNewSession('en');
  assert.equal(created.approvalMode, 'model_review');

  const selected = await store.selectSession(older.id);
  assert.equal(selected?.approvalMode, 'model_review');

  const restarted = new ChatSessionStore(storage, 'en', workspaceScope);
  await restarted.initialize();
  assert.equal(restarted.approvalMode, 'model_review');
  assert.equal(restarted.getActiveSession().approvalMode, 'model_review');
});

test('legacy workspace approval mode migrates from its active session', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:legacy-approval-mode',
    name: 'Legacy Approval Workspace',
    folderUris: []
  };
  const active = createSession('active', [createMessage(0)], workspaceScope);
  active.approvalMode = 'delegate';
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active] });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'delegate');
  const created = await store.createNewSession('en');
  assert.equal(created.approvalMode, 'delegate');
  assert.equal(storage.saved?.approvalMode, 'delegate');
});

test('stored project approval mode overrides stale per-session values on load', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:stored-project-mode',
    name: 'Stored Project Mode',
    folderUris: []
  };
  const active = createSession('active', [createMessage(0)], workspaceScope);
  active.approvalMode = 'ask';
  const storage = new MemorySessionStorage({
    activeSessionId: active.id,
    approvalMode: 'model_review',
    sessions: [active]
  });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'model_review');
  assert.equal(store.getActiveSession().approvalMode, 'model_review');
});

test('global storage isolates project approval modes and copied sessions use the target project mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-approval-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const storageUri = vscode.Uri.file(root) as never;
  const storage = new GlobalSessionStorage(storageUri);
  const firstScope: WorkspaceSessionScope = {
    key: 'workspace:first', name: 'First', folderUris: ['file:///first']
  };
  const secondScope: WorkspaceSessionScope = {
    key: 'workspace:second', name: 'Second', folderUris: ['file:///second']
  };

  const first = new ChatSessionStore(storage, 'en', firstScope);
  await first.initialize();
  await first.setApprovalMode('delegate');
  const firstSessionId = first.activeSessionId;

  const second = new ChatSessionStore(storage, 'en', secondScope);
  await second.initialize();
  assert.equal(second.approvalMode, 'ask');
  await second.setApprovalMode('model_review');
  const copied = await second.copyOtherWorkspaceSession(firstScope.key, firstSessionId);
  assert.equal(copied?.approvalMode, 'model_review');

  const restartedFirst = new ChatSessionStore(new GlobalSessionStorage(storageUri), 'en', firstScope);
  await restartedFirst.initialize();
  assert.equal(restartedFirst.approvalMode, 'delegate');
  assert.equal((await restartedFirst.createNewSession('en')).approvalMode, 'delegate');

  const restartedSecond = new ChatSessionStore(new GlobalSessionStorage(storageUri), 'en', secondScope);
  await restartedSecond.initialize();
  assert.equal(restartedSecond.approvalMode, 'model_review');
});

class MemorySessionStorage implements ChatSessionStorageAdapter {
  public saved: StoredWorkspaceSessionState | undefined;

  public constructor(private state: StoredWorkspaceSessionState) {}

  public async loadWorkspace(_workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    void _workspaceScope;
    return cloneWorkspaceState(this.state);
  }

  public async saveWorkspace(
    _workspaceScope: WorkspaceSessionScope,
    state: StoredWorkspaceSessionState
  ): Promise<void> {
    void _workspaceScope;
    this.state = cloneWorkspaceState(state);
    this.saved = cloneWorkspaceState(state);
  }

  public async listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return [];
  }

  public async loadWorkspaceSessions(_workspaceKey: string): Promise<ChatSession[]> {
    void _workspaceKey;
    return [];
  }

  public async deleteWorkspaceSessions(_workspaceKey: string, _sessionIds: string[]): Promise<void> {
    void _workspaceKey;
    void _sessionIds;
    return undefined;
  }

  public async deleteEntireWorkspace(_workspaceKey: string): Promise<void> {
    void _workspaceKey;
    return undefined;
  }

  public async cleanupExpiredSessions(): Promise<boolean> {
    return false;
  }
}

function createSession(
  id: string,
  messages: ChatMessage[],
  workspaceScope: WorkspaceSessionScope
): ChatSession {
  const now = new Date(0).toISOString();
  return {
    id,
    title: 'Long Session',
    messages,
    createdAt: now,
    updatedAt: now,
    workspaceKey: workspaceScope.key,
    workspaceName: workspaceScope.name,
    workspaceFolders: workspaceScope.folderUris,
    isFavorite: false
  };
}

function createMessage(index: number): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: new Date(index * 1000).toISOString()
  };
}

function cloneWorkspaceState(state: StoredWorkspaceSessionState): StoredWorkspaceSessionState {
  return {
    activeSessionId: state.activeSessionId,
    approvalMode: state.approvalMode,
    sessions: state.sessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
      contextCompression: session.contextCompression
        ? {
            ...session.contextCompression,
            protectedMessageIds: [...session.contextCompression.protectedMessageIds],
            summaries: session.contextCompression.summaries.map((summary) => ({
              ...summary,
              coveredMessageIds: [...summary.coveredMessageIds]
            }))
          }
        : undefined,
      repairLoop: session.repairLoop
        ? { ...session.repairLoop, pendingDraftEditIds: [...session.repairLoop.pendingDraftEditIds] }
        : undefined
    }))
  };
}
