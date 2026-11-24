import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { conversationsStylesFragment } from '../src/webview/conversations/styles';
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

/** Regression: an approve-all round applies the pending drafts by itself, so
 * nothing is left to settle. The checkpoint may still say `blocked` and still name
 * the drafts it waited for; neither may keep the row blue forever. */
test('a settled auto-approved round turns green instead of staying waiting', () => {
  const blockedRun: SessionLastRunObservation = { status: 'blocked', source: 'checkpoint' };

  const pending = projectSessionRunStatuses({
    sessionIds: ['a'],
    awaitingUserSessionIds: new Set(['a']),
    readLastRun: () => blockedRun
  });
  assert.equal(pending.a.kind, 'waiting', 'work the user must still settle keeps the row waiting');

  const settled = projectSessionRunStatuses({
    sessionIds: ['a'],
    awaitingUserSessionIds: new Set<string>(),
    readLastRun: () => blockedRun
  });
  assert.equal(settled.a.kind, 'completed',
    'once approve-all applied the drafts the run is finished, so the row is green');

  const commandPending = projectSessionRunStatuses({
    sessionIds: ['a'],
    awaitingUserSessionIds: new Set(['a']),
    readLastRun: () => ({ status: 'completed', source: 'checkpoint' })
  });
  assert.equal(commandPending.a.kind, 'waiting', 'a pending command approval is live waiting work');

  const commandSettled = projectSessionRunStatuses({
    sessionIds: ['a'],
    readLastRun: () => ({ status: 'completed', source: 'checkpoint' })
  });
  assert.equal(commandSettled.a.kind, 'completed', 'a settled command approval does not linger');

  const durableOnly = projectSessionRunStatuses({
    sessionIds: ['a'],
    readLastRun: () => ({ status: 'blocked', stopReason: 'waiting_for_user', source: 'checkpoint' })
  });
  assert.equal(durableOnly.a.kind, 'completed',
    'a durable blocked checkpoint alone never proves the user still owes an answer');
});

/** The panel side of the same contract: creation order, one live status marker
 * per row placed beside the favourite star, and the themed colours it relies on. */
test('the webview orders history by creation and marks each row status', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.match(script, /function compareSessionsByCreation\(a, b\) \{/u,
    'creation order must be a named comparator so both tabs share it');
  assert.match(script, /return compareSessionsByCreation\(a, b\);/u,
    'the favourite group keeps its priority and only its inner order changes');
  assert.match(script, /sessions\.sort\(compareSessionsByCreation\);/u,
    'the other-workspace tab sorts by creation too');
  assert.doesNotMatch(script, /getSessionTimestamp\(b\) - getSessionTimestamp\(a\)/u,
    'no visible list may be ordered by last activity');
  assert.match(script, /t\('sessionCreatedAt', \{ time: created \}\)/u,
    'the tooltip names the creation time that decides the position');
  assert.match(script, /var lastActive = formatSessionTime\(session\.updatedAt\);/u,
    'the last activity stays available as a hint instead of driving the order');

  assert.match(script, /function getSessionStatusRenderKey\(sessions\) \{/u,
    'a live status change must reach the panel');
  assert.match(script, /editingSessionTitleId \? '' : getSessionStatusRenderKey\(sessions\)/u,
    'a status change never rebuilds the row while a rename input owns the caret');
  assert.match(script, /syncSessionStatusBadges\(sessions\);/u,
    'the early return patches markers in place');
  assert.match(script, /sessionRunStatuses: \{\},/u, 'the default state carries the status map');
  assert.match(script,
    /item\.append\(renderRunStatusBadge\(session\.id\)\);\s*var favoriteButton = document\.createElement\('button'\);/u,
    'the status marker is placed immediately before the favourite button');
  assert.match(script, /badge\.className = 'session-status-badge is-' \+ kind;/u,
    'the badge kind maps to a themed marker class');
  for (const declaration of [
    'function renderRunStatusBadge(',
    'function syncSessionStatusBadges(',
    'function sessionRunStatusKind(',
    'function sessionRunStatusLabel(',
    'function applyRunStatusBadge(',
    'function getSessionCreatedTimestamp(',
    'function formatSessionActivityTitle('
  ]) {
    assert.equal(script.split(declaration).length - 1, 1,
      `${declaration} must be declared exactly once in the shared script scope`);
  }

  const styles = conversationsStylesFragment.source;
  assert.match(styles, /grid-template-columns: 12px 24px minmax\(0, 1fr\) 28px;/u,
    'the row reserves a leading column for the status marker');
  assert.match(styles, /grid-template-columns: 18px 12px 24px minmax\(0, 1fr\) 28px;/u,
    'the multi-select row keeps the marker column');
  assert.match(styles, /\.session-status-badge\.is-failed \{\s*background: var\(--vscode-charts-red/u,
    'a failed run is red');
  assert.match(styles, /\.session-status-badge\.is-running \{\s*background: var\(--vscode-charts-orange/u,
    'a running run is orange');
  assert.match(styles, /animation: session-status-pulse/u, 'a running run flashes');
  assert.match(styles, /\.session-status-badge\.is-completed \{\s*background: var\(--vscode-charts-green/u,
    'a completed run is green');
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u,
    'the pulse is disabled when the user asks for reduced motion');
});

/** The history control strip filters to rows with a recorded run: a row counts
 * when the Host projected a run for it, so the hollow idle ring is exactly what
 * the filter hides. Another project's rows carry no projected status at all, so
 * that tab is never filtered and never offers the button. */
test('the history filter keeps only rows with a recorded run', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.equal(script.split('function sessionHasRun(').length - 1, 1,
    'the has-run predicate is declared exactly once in the shared script scope');
  assert.match(script,
    /function sessionHasRun\(sessionId\) \{\s*return sessionRunStatusKind\(sessionRunStatusEntry\(sessionId\)\) !== 'idle';/u,
    'an unprojected or unknown kind is the idle ring, so no run is recorded');

  const currentTabList = script.slice(
    script.indexOf('function getCurrentVisibleSessions()'),
    script.indexOf('function getVisibleOtherWorkspaceSessions(')
  );
  assert.ok(currentTabList.includes('sessionWithRunOnly && !sessionHasRun(session.id)'),
    'the current-project tab hides rows without a recorded run');
  assert.ok(currentTabList.indexOf('sessionHasRun(session.id)')
    < currentTabList.indexOf('sessionRangeDays <= 0'),
  'the has-run filter runs before the date range, so the range never re-adds a row');

  const otherTabList = script.slice(
    script.indexOf('function getVisibleOtherWorkspaceSessions('),
    script.indexOf('function getActiveVisibleSessions(')
  );
  assert.doesNotMatch(otherTabList, /sessionWithRunOnly/u,
    'the other-project tab carries no projected status, so the filter cannot apply there');

  assert.match(script,
    /sessionMultiSelectMode, sessionRangeDays, sessionWithRunOnly, Array\.from\(selectedSessionIds\),/u,
    'the filter state stays in the render key so toggling it repaints the panel');
  assert.match(script, /if \(currentTab\) \{\s*var withRunOnlyButton = document\.createElement\('button'\);/u,
    'the filter is only offered where a status is projected');
  assert.match(script, /withRunOnlyButton\.dataset\.sessionAction = 'toggleWithRunOnly';/u,
    'the control strip exposes the has-run toggle');
  assert.match(script,
    /withRunOnlyButton\.setAttribute\('aria-pressed', sessionWithRunOnly \? 'true' : 'false'\);/u,
    'the pressed state follows the filter');
  assert.match(script, /withRunOnlyButton\.textContent = t\('sessionWithRunOnly'\);/u,
    'the label comes from the catalogue, never from the raw key');
  assert.match(script, /controls\.append\(withRunOnlyButton\);\s*\}\s*controls\.append\(multiSelectButton\);/u,
    'the filter sits between the range select and the edit toggle');
  assert.match(script,
    /if \(action === 'toggleWithRunOnly'\) \{\s*if \(!isCurrentWorkspaceTab\(\)\) return;/u,
    'toggling from another project tab is ignored');
  assert.match(script, /t\('sessionWithRunOnlyEmpty'\)/u,
    'a filtered-to-nothing list names the filter instead of claiming empty history');
  assert.doesNotMatch(script, /sessionFavoritesOnly|toggleFavoritesOnly|sessionCurrentOnly/u,
    'the favourites-only filter and its provisional name are gone');

  const zh = WEBVIEW_TRANSLATIONS['zh-CN'];
  const en = WEBVIEW_TRANSLATIONS.en;
  assert.equal(zh.sessionWithRunOnly, '只看进行时', 'zh-CN labels the filter in Chinese');
  assert.ok(en.sessionWithRunOnly && en.sessionWithRunOnly.length > 0, 'en labels the filter too');
  assert.ok(zh.sessionWithRunOnlyHint && en.sessionWithRunOnlyHint,
    'both dictionaries explain what the filter hides');
  assert.ok(zh.sessionWithRunOnlyEmpty && en.sessionWithRunOnlyEmpty,
    'both dictionaries explain a filtered-to-nothing list');
  assert.equal(zh.sessionFavoritesOnly, undefined, 'zh-CN drops the favourites-only label');
  assert.equal(en.sessionFavoritesOnly, undefined, 'en drops the favourites-only label');
  assert.equal(zh.sessionCurrentOnly, undefined, 'the provisional current-only label is gone');
});
