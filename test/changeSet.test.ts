import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { createChangeSet } from '../src/edits/changeSet';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import type { ChangeCheckpoint, ChangeSetFile, ChatMessage, ChatSession } from '../src/shared/types';

test('creates one structured ChangeSet for multiple draft edits', () => {
  const changeSet = createChangeSet({
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    edits: [
      {
        id: 'edit-1',
        uri: 'file:///workspace/a.ts',
        label: 'a.ts',
        action: 'modify',
        newText: 'export const a = 1;\n',
        reason: 'Update A'
      },
      {
        id: 'edit-2',
        uri: 'file:///workspace/b.ts',
        label: 'b.ts',
        action: 'create',
        newText: 'export const b = 2;\n',
        reason: 'Add B'
      }
    ]
  });

  assert.ok(changeSet);
  assert.equal(changeSet.fileCount, 2);
  assert.equal(changeSet.sessionId, 'session-1');
  assert.equal(changeSet.messageId, 'message-1');
  assert.deepEqual(changeSet.files.map((file) => file.status), ['pending', 'pending']);
  assert.match(changeSet.operationSummary, /Update A/u);
});

test('keeps multiple rounds associated with their assistant message and omits newText from Webview state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-association-'));
  const fixture = createStoreFixture(root);
  const first = fixture.store.addDraftEdits({
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'assistant-1',
    edits: [draft('a', 'a.ts')]
  });
  const second = fixture.store.addDraftEdits({
    runId: 'run-2',
    sessionId: 'session-1',
    messageId: 'assistant-2',
    edits: [draft('b', 'b.ts')]
  });
  fixture.store.addDraftEdits({
    runId: 'run-other',
    sessionId: 'session-2',
    messageId: 'assistant-other',
    edits: [draft('other', 'other.ts')]
  });

  const state = fixture.store.toWebviewState('session-1');
  assert.deepEqual(state.map((changeSet) => changeSet.messageId), ['assistant-1', 'assistant-2']);
  assert.deepEqual(state.map((changeSet) => changeSet.files[0]?.label), ['a.ts', 'b.ts']);
  assert.ok(!('newText' in (state[0]?.files[0] ?? {})));

  fixture.store.discardAll(first?.id ?? '');
  const updated = fixture.store.toWebviewState('session-1');
  assert.equal(updated[0]?.id, first?.id);
  assert.equal(updated[0]?.messageId, 'assistant-1');
  assert.equal(updated[0]?.status, 'discarded');
  assert.equal(updated[1]?.id, second?.id);
});

test('reports mixed apply results per file and preserves retryable failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-partial-'));
  const fixture = createStoreFixture(root, 'b.ts');
  const changeSet = fixture.store.addDraftEdits({
    runId: 'run-partial',
    sessionId: 'session-1',
    messageId: 'assistant-partial',
    edits: [draft('a', 'a.ts'), draft('b', 'b.ts')]
  });
  assert.ok(changeSet);

  const result = await fixture.store.applyAll(changeSet.id);
  assert.deepEqual(result?.appliedEditIds, ['a']);
  assert.equal(result?.failed[0]?.editId, 'b');
  const state = fixture.store.toWebviewState('session-1')[0];
  assert.equal(state?.status, 'partially_failed');
  assert.deepEqual(state?.files.map((file) => file.status), ['applied', 'apply_failed']);
  assert.match(state?.files[1]?.error ?? '', /failed b\.ts/u);
});

test('persists discarded and reverted terminal history without source text', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-history-'));
  const fixture = createStoreFixture(root);
  const discarded = fixture.store.addDraftEdits({
    runId: 'run-discarded',
    sessionId: 'session-1',
    messageId: 'assistant-discarded',
    edits: [draft('discarded', 'discarded.ts')]
  });
  const reverted = fixture.store.addDraftEdits({
    runId: 'run-reverted',
    sessionId: 'session-1',
    messageId: 'assistant-reverted',
    edits: [draft('reverted', 'reverted.ts')]
  });
  assert.ok(discarded && reverted);

  fixture.store.discardAll(discarded.id);
  await fixture.store.applyAll(reverted.id);
  const storagePath = path.join(root, 'change-sets.json');
  await waitForStoredRuntimeChangeSet(storagePath, reverted.id);

  const afterApply = createStoreFixture(root);
  await afterApply.store.initialize();
  const appliedState = afterApply.store.toWebviewState('session-1');
  assert.deepEqual(appliedState.map((changeSet) => changeSet.status).sort(), ['applied', 'discarded']);
  await afterApply.store.revertAll(reverted.id);

  const persisted = await waitForStoredHistory(storagePath, 2);
  assert.equal(persisted.version, 2);
  assert.ok(!JSON.stringify(persisted.history).includes('"newText"'));

  const reloaded = createStoreFixture(root);
  await reloaded.store.initialize();
  const state = reloaded.store.toWebviewState('session-1');
  assert.deepEqual(state.map((changeSet) => changeSet.status).sort(), ['discarded', 'reverted']);
  assert.deepEqual(state.map((changeSet) => changeSet.messageId).sort(), ['assistant-discarded', 'assistant-reverted']);
  assert.ok(state.every((changeSet) => changeSet.files.every((file) => !('newText' in file))));
});

test('loads legacy pending ChangeSets without messageId as unlinked instead of inferring a round', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-change-legacy-'));
  const legacy = createChangeSet({
    runId: 'run-legacy',
    sessionId: 'session-1',
    edits: [draft('legacy', 'legacy.ts')]
  });
  assert.ok(legacy);
  const stored = { ...legacy } as Partial<typeof legacy>;
  delete stored.messageId;
  await writeFile(path.join(root, 'change-sets.json'), JSON.stringify({
    version: 1,
    changeSets: [stored],
    checkpoints: []
  }));

  const fixture = createStoreFixture(root);
  await fixture.store.initialize();
  const state = fixture.store.toWebviewState('session-1');
  assert.equal(state.length, 1);
  assert.equal(state[0]?.messageId, '');
  assert.equal(state[0]?.status, 'pending');
});

function draft(id: string, label: string) {
  return {
    id,
    uri: `file:///workspace/${label}`,
    label,
    action: 'modify' as const,
    newText: `source for ${label}`,
    reason: `Update ${label}`
  };
}

function createStoreFixture(root: string, failLabel?: string) {
  const now = '2026-07-21T00:00:00.000Z';
  const messages: ChatMessage[] = [];
  const activeSession = {
    id: 'session-1',
    messages,
    updatedAt: now
  } as ChatSession;
  const safeFileEditor = {
    async applyDraftEdit(file: ChangeSetFile, changeSetId: string): Promise<ChangeCheckpoint> {
      if (file.label === failLabel) throw new Error(`failed ${file.label}`);
      return {
        id: `checkpoint-${file.id}`,
        changeSetId,
        editId: file.id,
        uri: file.uri,
        label: file.label,
        action: file.action,
        originalExists: true,
        appliedExists: true,
        createdAt: now,
        appliedAt: now
      };
    },
    async revertCheckpoint(checkpoint: ChangeCheckpoint): Promise<ChangeCheckpoint> {
      return { ...checkpoint, revertedAt: now };
    }
  };
  const sessionStore = {
    getActiveSession: () => activeSession,
    async persist() { return undefined; }
  };
  const diffService = { async openDiff() { return undefined; } };
  return {
    store: new ChangeSetStore(
      safeFileEditor as never,
      diffService as never,
      sessionStore as never,
      vscode.Uri.file(root),
      (key) => key
    ),
    activeSession
  };
}

async function waitForStoredHistory(
  storagePath: string,
  count: number
): Promise<{ version?: number; history?: unknown[] }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(storagePath, 'utf8')) as { version?: number; history?: unknown[] };
      if ((parsed.history?.length ?? 0) >= count) return parsed;
    } catch {
      // Persistence is queued; retry until the terminal snapshots have been written.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for compact ChangeSet history.');
}

async function waitForStoredRuntimeChangeSet(storagePath: string, changeSetId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const parsed = JSON.parse(await readFile(storagePath, 'utf8')) as {
        changeSets?: Array<{ id?: string }>;
      };
      if (parsed.changeSets?.some((changeSet) => changeSet.id === changeSetId)) return;
    } catch {
      // Persistence is queued; retry until the applied runtime state is durable.
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for applied ChangeSet runtime state.');
}
