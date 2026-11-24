import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { ChatSessionStore, sortSessionSummariesByCreatedAt } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { projectSessionRunStatuses, type SessionLastRunObservation } from '../src/provider/sessionRunStatus';
import * as vscode from './stubs/vscode';

const SA = '2024-01-01T00:00:00.000Z';
const SB = '2024-02-01T00:00:00.000Z';
const SCOPE_KEY = 'folders:file:///tmp/keepseek-history-order';

/** The history list is the record of what the user created: only `createdAt`
 * decides a row's position, so browsing, streaming or saving a conversation can
 * never reshuffle the panel under the cursor. */
test('history summaries are ordered by creation, not by last activity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-history-order-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  const scope = { key: SCOPE_KEY, name: 'order', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();

  const older = store.getActiveSession();
  older.createdAt = SA;
  older.updatedAt = SA;
  older.messages.push({ id: 'older-1', role: 'user', content: 'older task', createdAt: SA } as never);
  await store.persist();

  const newer = await store.createNewSession('en');
  assert.notEqual(newer.id, older.id, 'a submitted conversation starts a separate history entry');
  newer.createdAt = SB;
  newer.updatedAt = SB;
  newer.messages.push({ id: 'newer-1', role: 'user', content: 'newer task', createdAt: SB } as never);

  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [newer.id, older.id],
    'the newest creation is listed first');

  // Browsing, streaming and saving only touch `updatedAt`. The order must not move.
  older.updatedAt = new Date().toISOString();
  newer.updatedAt = SB;
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [newer.id, older.id],
    'a newer last-activity timestamp never reorders the list');
});

/** Two conversations created in the same millisecond must not swap places
 * between renders, so the id is the explicit tie-break. */
test('same-millisecond creations fall back to the id', () => {
  const base = {
    title: 'task', createdAt: SA, updatedAt: SB, messageCount: 1,
    workspaceKey: SCOPE_KEY, workspaceName: 'order', isFavorite: false
  };
  const ordered = sortSessionSummariesByCreatedAt([{ ...base, id: 'b' }, { ...base, id: 'a' }])
    .map(summary => summary.id);
  assert.deepEqual(ordered, ['a', 'b'], 'the id keeps the order deterministic');
});

/** One row shows at most one status; the first matching rule wins. */
test('each session resolves to exactly one status by priority', () => {
  const observations: Record<string, SessionLastRunObservation> = {
    running: { status: 'completed', source: 'checkpoint' },
    waiting: { status: 'blocked', blocker: 'draft pending', source: 'checkpoint' },
    failed: { status: 'interrupted', error: 'provider exploded', source: 'checkpoint' },
    stopped: { status: 'interrupted', source: 'checkpoint' },
    completed: { status: 'completed', source: 'checkpoint' },
    idle: {}
  };
  const statuses = projectSessionRunStatuses({
    sessionIds: Object.keys(observations),
    runningSessionIds: ['running'],
    readLastRun: sessionId => observations[sessionId]
  });

  assert.deepEqual(statuses.running, { kind: 'running', source: 'live' },
    'a registered run outranks every durable conclusion');
  assert.equal(statuses.waiting.kind, 'waiting', 'a blocker waits for the user');
  assert.equal(statuses.failed.kind, 'failed', 'an error outranks the interrupted status it was recorded with');
  assert.equal(statuses.failed.detail, 'provider exploded');
  assert.equal(statuses.stopped.kind, 'stopped');
  assert.equal(statuses.completed.kind, 'completed');
  assert.equal(statuses.idle.kind, 'idle', 'a session with no run has no conclusion');
});

/** A checkpoint still marked `running` outlived the process that wrote it, so it
 * must never claim a live run forever; the background coordinator can outrank a
 * finished checkpoint while it waits for the user. */
test('a stale checkpoint degrades and a waiting background run outranks it', () => {
  const stale = projectSessionRunStatuses({
    sessionIds: ['stale'],
    readLastRun: () => ({ status: 'running', source: 'checkpoint' })
  });
  assert.equal(stale.stale.kind, 'stopped', 'an orphaned running checkpoint is reported as interrupted');

  const waiting = projectSessionRunStatuses({
    sessionIds: ['waiting'],
    backgroundRun: { sessionId: 'waiting', status: 'waiting_for_apply' },
    readLastRun: () => ({ status: 'completed', source: 'checkpoint' })
  });
  assert.equal(waiting.waiting.kind, 'waiting', 'the background run decides while it waits for the user');
});

/** A live failure mark wins over a stale completed checkpoint, and the archived
 * summary is still usable after a reload. */
test('live failures and archived summaries both explain a failed session', () => {
  const live = projectSessionRunStatuses({
    sessionIds: ['live'],
    liveFailures: new Map([['live', { at: SB, detail: 'network down' }]]),
    readLastRun: () => ({ status: 'completed', source: 'checkpoint' })
  });
  assert.equal(live.live.kind, 'failed');
  assert.equal(live.live.source, 'live');
  assert.equal(live.live.detail, 'network down');

  const archived = projectSessionRunStatuses({
    sessionIds: ['archived', 'absent'],
    readLastRun: sessionId => sessionId === 'archived' ? { status: 'completed', source: 'archive' } : undefined
  });
  assert.deepEqual(archived.archived, { kind: 'completed', source: 'archive' },
    'an archived summary still explains the last run after a reload');
  assert.deepEqual(archived.absent, { kind: 'idle', source: 'checkpoint' },
    'an unloaded session gets no invented status');
});

/** The panel side of the same contract: creation order, creation time in the
 * meta line, and one live status badge per row. */
test('the webview orders history by creation and shows a status badge', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.match(script, /function compareSessionsByCreation\(a, b\) \{/u,
    'creation order must be a named comparator so both tabs share it');
  assert.match(script, /return compareSessionsByCreation\(a, b\);/u,
    'the favourite group keeps its priority and only its inner order changes');
  assert.match(script, /sessions\.sort\(compareSessionsByCreation\);/u,
    'the other-workspace tab sorts by creation too');
  assert.doesNotMatch(script, /return getSessionTimestamp\(b\) - getSessionTimestamp\(a\);\)?;\s*return sessions\.filter/u,
    'no visible list may be ordered by last activity');
  assert.match(script, /var timeLabel = formatSessionTime\(session\.createdAt \|\| session\.updatedAt\);/u,
    'the meta line shows the stable creation time');
  assert.match(script, /var lastActive = formatSessionTime\(session\.updatedAt\);/u,
    'the last activity moves into the tooltip instead of the order');

  assert.match(script, /function getSessionStatusRenderKey\(sessions\) \{/u,
    'a live status change must reach the panel');
  assert.match(script, /editingSessionTitleId \? '' : getSessionStatusRenderKey\(sessions\)/u,
    'a status change never rebuilds the row while a rename input owns the caret');
  assert.match(script, /syncSessionStatusBadges\(sessions\);/u,
    'the early return patches badges in place');
  assert.match(script, /sessionRunStatuses: \{\},/u, 'the default state carries the status map');
  assert.match(script, /badge\.className = 'session-status-badge is-' \+ kind;/u,
    'the badge kind maps to a themed marker class');
  for (const declaration of [
    'function renderRunStatusBadge(',
    'function syncSessionStatusBadges(',
    'function sessionRunStatusKind(',
    'function sessionRunStatusLabel(',
    'function applyRunStatusBadge('
  ]) {
    assert.equal(script.split(declaration).length - 1, 1,
      `${declaration} must be declared exactly once in the shared script scope`);
  }
});