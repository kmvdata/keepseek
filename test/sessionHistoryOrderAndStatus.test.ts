import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { WEBVIEW_TRANSLATIONS, localize } from '../src/shared/i18n';
import { conversationsStylesFragment } from '../src/webview/conversations/styles';
import { ChatSessionStore, normalizeStoredSessions, sortSessionSummariesByCreatedAt } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import {
  deriveSessionRunEvidence,
  isSessionRunDismissed,
  projectSessionRunStatuses,
  type SessionLastRunObservation,
  type SessionRunStatusDismissal
} from '../src/provider/sessionRunStatus';
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
  assert.match(script, /sessions\.sort\(compareSessionsByCreation\);/u,
    'the history list sorts by creation alone');
  assert.doesNotMatch(script, /favoriteDelta/u,
    'the favourite star is never a sort key, so starring a row cannot move it');
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
  assert.match(script,
    /item\.append\(renderSessionRunStopButton\(session\.id\)\);\s*var pinButton = document\.createElement\('button'\);[\s\S]{0,700}?item\.append\(pinButton\);\s*var renameButton = document\.createElement\('button'\);/u,
    'the pin sits between the stop square and the rename pencil, so every row action keeps its place');
  assert.match(script, /badge\.className = 'session-status-badge is-' \+ kind;/u,
    'the badge kind maps to a themed marker class');
  for (const declaration of [
    'function renderRunStatusBadge(',
    'function syncSessionStatusBadges(',
    'function sessionRunStatusKind(',
    'function sessionRunStatusLabel(',
    'function applyRunStatusBadge(',
    'function applyRunStopButton(',
    'function renderSessionRunStopButton(',
    'function sessionRunStopsLiveWork(',
    'function getSessionCreatedTimestamp(',
    'function formatSessionActivityTitle('
  ]) {
    assert.equal(script.split(declaration).length - 1, 1,
      `${declaration} must be declared exactly once in the shared script scope`);
  }

  const styles = conversationsStylesFragment.source;
  assert.match(styles, /grid-template-columns: 12px 24px minmax\(0, 1fr\) 28px 28px 28px;/u,
    'the row reserves the status column, the stop square and the pin beside the pencil');
  assert.match(styles, /grid-template-columns: 18px 12px 24px minmax\(0, 1fr\) 28px 28px 28px;/u,
    'the multi-select row keeps every trailing column, so no row collapses');
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
  assert.match(script, /var withRunOnlyButton = document\.createElement\('button'\);/u,
    'the control strip offers the has-run filter above the current project history');
  assert.match(script, /withRunOnlyButton\.dataset\.sessionAction = 'toggleWithRunOnly';/u,
    'the control strip exposes the has-run toggle');
  assert.match(script,
    /withRunOnlyButton\.setAttribute\('aria-pressed', sessionWithRunOnly \? 'true' : 'false'\);/u,
    'the pressed state follows the filter');
  assert.doesNotMatch(script, /withRunOnlyButton\.textContent/u,
    'the switch is icon-only: neither dictionary puts a word in the control strip');
  assert.match(script, /withRunOnlyButton\.setAttribute\('aria-label', t\('sessionWithRunOnly'\)\);/u,
    'the catalogue label becomes the accessible name of the icon button');
  assert.match(script, /withRunOnlyButton\.title = t\('sessionWithRunOnlyHint'\);/u,
    'the tooltip still explains what the filter hides');
  assert.match(script, /withRunOnlyButton\.innerHTML = '<svg[^']*<\/svg>';/u,
    'the switch renders an inline activity glyph instead of an installed icon font');
  assert.doesNotMatch(script, /withRunOnlyButton\.innerHTML = '[^']*<text/u,
    'the glyph never draws a word, so it stays language-neutral');
  assert.match(script,
    /trailingControls\.append\(withRunOnlyButton\);\s*trailingControls\.append\(multiSelectButton\);\s*controls\.append\(trailingControls\);/u,
    'the leading dropdowns stay left-aligned while the switches share one trailing group');
  assert.match(script,
    /if \(action === 'toggleWithRunOnly'\) \{\s*sessionWithRunOnly = !sessionWithRunOnly;/u,
    'the row action flips the has-run filter and repaints the panel');
  assert.match(script, /t\('sessionWithRunOnlyEmpty'\)/u,
    'a filtered-to-nothing list names the filter instead of claiming empty history');
  assert.doesNotMatch(script, /sessionFavoritesOnly|toggleFavoritesOnly|sessionCurrentOnly/u,
    'the favourites-only filter and its provisional name are gone');

  const styles = conversationsStylesFragment.source;
  assert.match(styles, /\.session-menu-controls-tail \{[^}]*display: flex;/u,
    'the trailing group keeps its buttons on one line');
  assert.match(styles, /\.session-menu-controls-tail \{[^}]*margin-left: auto;/u,
    'the trailing group owns the auto margin, so the switches sit at the right edge');
  assert.match(styles, /\.session-menu-with-run-toggle \{[^}]*place-items: center;/u,
    'the icon-only switch squares itself off instead of using the text padding');
  assert.doesNotMatch(styles, /\.session-menu-edit-toggle \{\s*margin-left/u,
    'the edit toggle no longer needs its own auto margin: the tail group handles it');

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

/** The history mode switch used to be a word: an icon carries the mode now,
 * while the dictionary labels survive as the accessible name and the tooltip,
 * so the control strip stays language-neutral. */
test('the history edit toggle is an icon button', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.doesNotMatch(script, /multiSelectButton\.textContent/u,
    'the edit toggle draws a glyph, never a translated word');
  assert.match(script,
    /multiSelectButton\.setAttribute\('aria-label', t\(sessionMultiSelectMode \? 'sessionExitMultiSelect' : 'sessionMultiSelect'\)\);/u,
    'the dictionary label becomes the accessible name of the icon button');
  assert.match(script,
    /multiSelectButton\.title = t\(sessionMultiSelectMode \? 'sessionExitMultiSelect' : 'sessionMultiSelect'\);/u,
    'the tooltip still names the mode switch in both directions');
  assert.match(script,
    /multiSelectButton\.innerHTML = sessionMultiSelectMode\s*\? '<svg[^']*<\/svg>'\s*: '<svg[^']*<\/svg>';/u,
    'the glyph follows the mode instead of the button switching between icon and text');
  assert.doesNotMatch(script, /multiSelectButton\.innerHTML = '[^']*<text/u,
    'the glyph never draws a word, so it stays language-neutral');

  const switchGlyph = script.slice(
    script.indexOf('multiSelectButton.innerHTML'),
    script.indexOf('trailingControls.append')
  );
  assert.doesNotMatch(switchGlyph, /M16\.5 3\.5a2\.1 2\.1 0 0 1 3 3L7 19l-4 1 1-4Z/u,
    'the mode switch never reuses the row rename pencil: the strip edits the list, a row pencil renames one conversation');
  assert.match(switchGlyph, /<path d="m3 7 2 2 4-4"\/>/u,
    'the switch draws a checklist, which reads as editing several rows at once');

  const styles = conversationsStylesFragment.source;
  assert.match(styles, /\.session-menu-edit-toggle \{[^}]*display: inline-grid;/u,
    'the icon-only switch squares itself off instead of using the text padding');
  assert.match(styles, /\.session-menu-edit-toggle \{[^}]*place-items: center;/u,
    'the glyph is centred inside the squared button');
  assert.match(styles, /\.session-menu-edit-toggle svg \{[^}]*display: block;/u,
    'the inline glyph lays out as a block inside the grid button');

  const zh = WEBVIEW_TRANSLATIONS['zh-CN'];
  const en = WEBVIEW_TRANSLATIONS.en;
  assert.ok(zh.sessionMultiSelect && en.sessionMultiSelect,
    'both dictionaries still name the mode for assistive tech');
  assert.ok(zh.sessionExitMultiSelect && en.sessionExitMultiSelect,
    'both dictionaries still name the way out of the mode');
});

/** The row stop square: a finished run is left without a prompt, a live one is
 * stopped only after a confirmation, and a row with no run keeps the column. */
test('the history row stop square follows the projected kind', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.match(script,
    /function sessionRunStopsLiveWork\(sessionId\) \{\s*var kind = sessionRunStatusKind\(sessionRunStatusEntry\(sessionId\)\);\s*return kind === 'running' \|\| kind === 'waiting';/u,
    'only a live run or a waiting session needs a confirmation');
  assert.match(script,
    /if \(!sessionHasRun\(sessionId\)\) \{\s*var spacer = document\.createElement\('span'\);/u,
    'a row with no run reserves the column with an inert spacer instead of a button');
  assert.match(script, /button\.dataset\.sessionAction = 'dismissSessionRun';/u,
    'the square is a delegated row action, so a click never selects the conversation');
  assert.match(script, /button\.dataset\.runStopShape = live \? 'solid' : 'hollow';/u,
    'a live row draws a solid square and a finished one a hollow square');
  assert.match(script, /fill="currentColor"\/><\/svg>/u, 'the solid square is filled');
  assert.match(script, /fill="none" stroke="currentColor"/u, 'the hollow square is outlined');
  assert.match(script,
    /if \(action === 'dismissSessionRun'\) \{[\s\S]{0,600}?vscode\.postMessage\(\{ type: 'dismissSessionRun', sessionId: runStopSessionId \}\);/u,
    'the row action reports the session id and nothing else');
  assert.match(script,
    /var stopButton = sessionMenu\.querySelector\('button\[data-session-stop-id="' \+ cssEscape\(sessionId\) \+ '"\]'\);/u,
    'a live status change patches the square in place instead of rebuilding the row');

  const styles = conversationsStylesFragment.source;
  assert.match(styles, /\.session-menu-run-stop\.is-empty \{\s*visibility: hidden;/u,
    'the inert spacer keeps the grid column without showing a control');
  assert.match(styles,
    /\.session-menu-item:hover \.session-menu-rename,\s*\.session-menu-item:focus-within \.session-menu-rename,\s*\.session-menu-item:hover \.session-menu-run-stop,\s*\.session-menu-item:focus-within \.session-menu-run-stop \{/u,
    'the square appears with the same hover/focus reveal as the rename pencil');

  const zh = WEBVIEW_TRANSLATIONS['zh-CN'];
  const en = WEBVIEW_TRANSLATIONS.en;
  for (const key of ['sessionRunDismissIdle', 'sessionRunDismissIdleHint', 'sessionRunDismissActive',
    'sessionRunDismissActiveHint', 'sessionRunDismissConfirm', 'sessionRunDismissConfirmAction',
    'sessionRunDismissBlocked', 'sessionRunDismissBlockedRunning', 'sessionRunDismissBlockedWaiting',
    'sessionRunDismissBlockedOther', 'sessionRunDismissStoppedByUser']) {
    assert.ok(zh[key] && en[key], `${key} exists in both dictionaries`);
    assert.notEqual(zh[key], en[key], `${key} is translated rather than copied`);
  }
  assert.match(zh.sessionRunDismissConfirm, /待确认的改动与命令/u,
    'the confirmation names the pending changes and commands it discards');

  // The host renders the same copy through localize(), which prints the key itself
  // when the extension catalog is missing it, so both catalogs must resolve it.
  for (const language of ['zh-CN', 'en'] as const) {
    for (const key of ['sessionRunDismissConfirm', 'sessionRunDismissConfirmAction',
      'sessionRunDismissBlocked', 'sessionRunDismissBlockedRunning', 'sessionRunDismissBlockedWaiting',
      'sessionRunDismissBlockedOther', 'sessionRunDismissStoppedByUser']) {
      assert.notEqual(localize(language, key), key, `localize('${language}') resolves ${key}`);
    }
  }
  const blockedZh = localize('zh-CN', 'sessionRunDismissBlocked', { reason: '原因' });
  assert.ok(blockedZh.includes('原因'), 'the blocked template receives its reason');
  assert.ok(!blockedZh.includes('{reason}'), 'the blocked template leaves no placeholder behind');
  const blockedEn = localize('en', 'sessionRunDismissBlocked', { reason: 'busy' });
  assert.ok(blockedEn.includes('busy') && !blockedEn.includes('{reason}'),
    'the English blocked template fills its reason too');

  assert.equal(zh.sessionWithRunOnly, '只看进行时', 'the filter label stays untouched');
});

/** "Leave the running list" is a session-level marker, never a history rewrite:
 * while it still describes the newest run the row has no conclusion, and any new
 * run or refreshed checkpoint brings the row back. */
test('a dismissed run stays idle until a newer proof arrives', () => {
  const completed = { id: 'run-1', role: 'assistant', content: '', createdAt: SB,
    runCheckpoint: { updatedAt: SB } } as never;
  const evidence = deriveSessionRunEvidence(completed);
  assert.deepEqual(evidence, { messageId: 'run-1', proofAt: SB },
    'the marker and the projection agree on the same message and timestamp');

  const dismissal: SessionRunStatusDismissal = { version: 1, messageId: 'run-1', proofAt: SB, dismissedAt: SB };
  assert.equal(isSessionRunDismissed(dismissal, evidence), true, 'the same proof counts as already dismissed');
  assert.equal(isSessionRunDismissed(undefined, evidence), false, 'a session without a marker keeps its status');
  assert.equal(isSessionRunDismissed(dismissal, { messageId: 'run-2', proofAt: SB }), false,
    'a new run is a new message, so the row surfaces again');
  assert.equal(isSessionRunDismissed(dismissal, { messageId: 'run-1', proofAt: '2024-03-01T00:00:00.000Z' }), false,
    'a refreshed checkpoint on the same message surfaces again');
  assert.equal(isSessionRunDismissed(dismissal, { messageId: 'run-1' }), true,
    'the archived form carries no timestamp, so the dismissal still covers it');

  const archivedOnly: SessionRunStatusDismissal = { version: 1, messageId: 'run-1', dismissedAt: SB };
  assert.equal(isSessionRunDismissed(archivedOnly, { messageId: 'run-1' }), true,
    'a dismissal recorded against the archived form still matches after a reload');
  assert.equal(isSessionRunDismissed(archivedOnly, { messageId: 'run-1', proofAt: SB }), false,
    'once that message records a timestamp it is a newer proof and the row returns');

  // A dismissed run reports no observation, which is what the Host hands to the
  // projection; live signals never consult history, so they still outrank it.
  const statuses = projectSessionRunStatuses({
    sessionIds: ['done', 'live', 'owed'],
    runningSessionIds: ['live'],
    awaitingUserSessionIds: new Set(['owed']),
    readLastRun: () => undefined
  });
  assert.equal(statuses.done.kind, 'idle', 'a dismissed run leaves the running list');
  assert.equal(statuses.live.kind, 'running', 'a live run is unaffected by a dismissal');
  assert.equal(statuses.owed.kind, 'waiting', 'pending work still waits for the user');
});

/** The marker lives in the session header, so it has to survive the current
 * protocol normalizer and never invent a status for data that predates it. */
test('the dismissal marker is normalized and persisted with the session header', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-run-dismiss-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  const scope = { key: SCOPE_KEY, name: 'dismiss', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();

  const session = store.getActiveSession();
  session.messages.push({ id: 'm-1', role: 'user', content: 'task', createdAt: SA } as never);
  await store.persist();
  const marked = await store.markSessionRunStatusDismissed(session.id,
    { version: 1, messageId: 'm-1', proofAt: SB, dismissedAt: SB });
  assert.equal(marked?.runStatusDismissal?.messageId, 'm-1', 'the header keeps the marker');
  assert.equal(store.getSessionById(session.id)?.runStatusDismissal?.proofAt, SB,
    'the loaded session carries the marker after the write');
  assert.equal(session.messages.length, 1, 'the marker never touches the append-only history');

  const normalized = normalizeStoredSessions({
    sessions: [
      { id: 'kept', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [],
        runStatusDismissal: { version: 1, messageId: 'm-1', proofAt: SB, dismissedAt: SB } },
      { id: 'legacy', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [] },
      { id: 'broken', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [],
        runStatusDismissal: { version: 2, messageId: 'm-1', dismissedAt: SB } }
    ]
  }, scope);
  const byId = new Map(normalized.map(item => [item.id, item]));
  assert.equal(byId.get('kept')?.runStatusDismissal?.messageId, 'm-1', 'a valid marker round-trips');
  assert.equal(byId.get('legacy')?.runStatusDismissal, undefined, 'old data has no marker instead of a guess');
  assert.equal(byId.get('broken')?.runStatusDismissal, undefined, 'an unknown shape is dropped instead of throwing');
});

/** Pinning is the only user action that moves a row, and it stays an order
 * change: the pinned group leads, both groups keep the creation order, and an
 * unpinned row lands exactly where its `createdAt` says. */
test('a pinned row leads the history list without rewriting its creation', () => {
  const base = {
    title: 'task', updatedAt: SB, messageCount: 1,
    workspaceKey: SCOPE_KEY, workspaceName: 'order', isFavorite: false
  };
  const oldest = { ...base, id: 'oldest', createdAt: SA };
  const middle = { ...base, id: 'middle', createdAt: '2024-01-15T00:00:00.000Z' };
  const newest = { ...base, id: 'newest', createdAt: SB };

  assert.deepEqual(sortSessionSummariesByCreatedAt([newest, oldest, middle]).map(row => row.id),
    ['newest', 'middle', 'oldest'], 'while nothing is pinned, creation still decides the order');

  assert.deepEqual(
    sortSessionSummariesByCreatedAt([newest, { ...oldest, isPinned: true }, { ...middle, isPinned: true }])
      .map(row => row.id),
    ['middle', 'oldest', 'newest'],
    'pinning lifts the rows, and the pinned group keeps the creation order');

  assert.deepEqual(
    sortSessionSummariesByCreatedAt([{ ...newest, isPinned: false }, { ...oldest, isPinned: true }])
      .map(row => row.id),
    ['oldest', 'newest'], 'only `isPinned === true` counts, so an explicit false is unpinned');

  const tie = { ...base, createdAt: '2024-03-01T00:00:00.000Z' };
  assert.deepEqual(
    sortSessionSummariesByCreatedAt([{ ...tie, id: 'b', isPinned: true }, { ...tie, id: 'a', isPinned: true }])
      .map(row => row.id),
    ['a', 'b'], 'the id still breaks a tie inside the pinned group');
});

/** The pin lives in the session header and in the workspace index entry, so a
 * reload and a second window both read the same order, and neither write touches
 * the last-activity timestamp that retention ranks by. */
test('the pin round-trips through the shard and the index without touching activity', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-pin-order-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  const scope = { key: SCOPE_KEY, name: 'pin', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();

  const session = store.getActiveSession();
  session.messages.push({ id: 'pin-1', role: 'user', content: 'task', createdAt: SA } as never);
  await store.persist();
  assert.equal(store.getSessionSummaries().find(row => row.id === session.id)?.isPinned, false,
    'a new conversation is not pinned');

  const updatedAtBefore = session.updatedAt;
  const pinned = await store.toggleSessionPinned(session.id);
  assert.equal(pinned?.isPinned, true, 'the header keeps the flag');
  assert.equal(pinned?.updatedAt, updatedAtBefore,
    'pinning never refreshes the last-activity timestamp, so retention is unchanged');
  assert.equal(store.getSessionSummaries().find(row => row.id === session.id)?.isPinned, true,
    'the row is pinned as soon as the header is written');

  const indexed = (await storage.listWorkspaceSessionSummaries(scope.key))
    .find(row => row.id === session.id);
  assert.equal(indexed?.isPinned, true, 'the workspace index entry carries the pin');

  const reloaded = await storage.loadSession(scope.key, session.id);
  assert.equal(reloaded?.isPinned, true, 'the shard body keeps the pin across a reload');

  const unpinned = await store.toggleSessionPinned(session.id);
  assert.equal(unpinned?.isPinned, false, 'a second click clears the flag again');
  assert.equal(unpinned?.updatedAt, updatedAtBefore, 'unpinning leaves the activity timestamp alone');
  assert.equal(session.messages.length, 1, 'the pin never touches the append-only history');

  const normalized = new Map(normalizeStoredSessions({
    sessions: [
      { id: 'pinned', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [], isPinned: true },
      { id: 'unknown', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [], isPinned: 'yes' },
      { id: 'legacy', createdAt: SA, updatedAt: SA, workspaceKey: SCOPE_KEY, messages: [] }
    ]
  }, scope).map(item => [item.id, item]));
  assert.equal(normalized.get('pinned')?.isPinned, true, 'a stored pin round-trips');
  assert.equal(normalized.get('unknown')?.isPinned, false, 'an unknown pin value degrades to unpinned');
  assert.equal(normalized.get('legacy')?.isPinned, false, 'old data is unpinned instead of throwing');
});

/** The row pin is a request, never an authority: it posts one message, the Host
 * owns the flag, and the order lives in the shared comparator. */
test('the history row pin requests the order instead of deciding it', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.ok(script.includes('var byPinned = (b.isPinned === true ? 1 : 0) - (a.isPinned === true ? 1 : 0);'),
    'the shared comparator lifts pinned rows before it compares creation dates');
  const comparator = script.slice(
    script.indexOf('function compareSessionsByCreation(a, b) {'),
    script.indexOf('function formatSessionActivityTitle(')
  );
  assert.ok(comparator.indexOf('if (byPinned) return byPinned;')
    < comparator.indexOf('getSessionCreatedTimestamp(b)'),
  'a pin decides before creation, and creation still decides inside each group');

  for (const expected of [
    "pinButton.dataset.sessionAction = 'togglePin';",
    'pinButton.dataset.sessionId = session.id;',
    "pinButton.className = 'session-menu-pin' + (isPinned ? ' is-active' : '');",
    "pinButton.setAttribute('aria-pressed', isPinned ? 'true' : 'false');",
    "pinButton.setAttribute('aria-label', t(isPinned ? 'unpinSession' : 'pinSession'));",
    "pinButton.title = t(isPinned ? 'unpinSession' : 'pinSession');",
    "+ (isPinned ? ' is-pinned' : '');"
  ]) {
    assert.ok(script.includes(expected), `${expected} is part of the row pin`);
  }

  const pinGlyph = script.slice(script.indexOf('pinButton.innerHTML'), script.indexOf('item.append(pinButton)'));
  assert.ok(pinGlyph.includes('M12 17v5'), 'the pin draws a pushpin, not another action glyph');
  assert.ok(pinGlyph.includes('stroke="currentColor"'), 'the glyph follows the theme colour');
  assert.ok(!pinGlyph.includes('M16.5 3.5a2.1'), 'the pin never reuses the rename pencil path');
  assert.ok(!pinGlyph.includes('<text'), 'the glyph never draws a word, so it stays language-neutral');
  assert.ok(!script.includes('pinButton.textContent'),
    'the pin is icon-only, so no dictionary word lands in the row');

  assert.ok(script.includes("vscode.postMessage({ type: 'toggleSessionPinned', sessionId: pinSessionId });"),
    'the row action reports the session id and nothing else');
  const pinBranch = script.slice(
    script.indexOf("if (action === 'togglePin')"),
    script.indexOf("if (action === 'toggleMultiSelect')")
  );
  assert.ok(!pinBranch.includes('state.sessionSummaries'),
    'the pin waits for the Host projection instead of reordering locally');

  const styles = conversationsStylesFragment.source;
  assert.ok(styles.includes('/* [status] [favourite] [main] [stop] [pin] [rename] */'),
    'the grid comment names the column the pin occupies');
  const pinRule = styles.slice(styles.indexOf('.session-menu-pin {'), styles.indexOf('.session-menu-pin:hover'));
  assert.ok(pinRule.includes('display: grid;') && pinRule.includes('opacity: 0;'),
    'the pin stays hidden until the row is hovered, exactly like the rename pencil');
  const pinnedRule = styles.slice(styles.indexOf('.session-menu-pin.is-active'),
    styles.indexOf('.session-menu-item-main'));
  assert.ok(pinnedRule.includes('opacity: 1;'), 'a pinned row keeps its pin visible without a hover');
  assert.ok(styles.includes('.session-menu-item:focus-within .session-menu-pin,'),
    'the pin joins the same hover/focus reveal group as the pencil and the stop square');

  const zh = WEBVIEW_TRANSLATIONS['zh-CN'];
  const en = WEBVIEW_TRANSLATIONS.en;
  assert.equal(zh.pinSession, '置顶会话', 'zh-CN names the pin action');
  assert.equal(zh.unpinSession, '取消置顶', 'zh-CN names the way back');
  assert.ok(en.pinSession && en.unpinSession, 'en names both states too');
  assert.notEqual(zh.pinSession, en.pinSession, 'the pin label is translated rather than copied');
  assert.notEqual(zh.unpinSession, en.unpinSession, 'the unpin label is translated rather than copied');
});
/** The history row used to carry a queue badge. The projection behind it never
 * carried a mode, so every row printed the same plan marker, and the tooltip keys
 * it asked for do not exist. The queue still orders approve-all and serializes
 * writes, but a row shows only its meta and its action order. */
test('the history row has no queue badge and keeps its creation order', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  for (const removed of ['renderQueueBadge', 'session-queue-badge', 'projectQueue',
    'queuePositionHint', 'queueHeadHint']) {
    assert.equal(script.includes(removed), false,
      `${removed} belonged to the display-only queue badge and must stay gone`);
  }

  assert.match(script, /function compareSessionsByCreation\(a, b\) \{/u,
    'the history list still sorts through one named creation comparator');
  assert.match(script, /sessions\.sort\(compareSessionsByCreation\);/u,
    'creation stays the only sort key, so dropping the badge reorders nothing');
  assert.match(script, /meta\.textContent = formatSessionMeta\(session\);/u,
    'the row meta is still the creation time and the message count');

  assert.match(script,
    /item\.append\(renderRunStatusBadge\(session\.id\)\);\s*var favoriteButton = document\.createElement\('button'\);/u,
    'the status marker still sits immediately before the favourite star');
  assert.match(script,
    /item\.append\(renderSessionRunStopButton\(session\.id\)\);\s*var pinButton = document\.createElement\('button'\);/u,
    'the stop square still comes first among the row actions');
  assert.match(script,
    /item\.append\(pinButton\);\s*var renameButton = document\.createElement\('button'\);/u,
    'the pin still sits between the stop square and the rename pencil');

  const styles = conversationsStylesFragment.source;
  assert.equal(styles.includes('.session-queue-badge'), false,
    'the badge rules left with the badge');
  assert.match(styles, /\.session-status-badge\.is-completed \{\s*background: var\(--vscode-charts-green/u,
    'the run status marker keeps its themed colour, so only the queue badge was removed');
});
