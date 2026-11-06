import './registerVscodeStub';
import { ExecutionClock } from '../src/agent/executionPolicy';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { reconcileExecutionTime, executionTimeView, UserTaskClock } from '../src/sessions/executionTimeStats';
import { createEmptySession, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ChatMessage } from '../src/shared/types';
import { usageFormattersFragment } from '../src/webview/input/usage/formatters';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { taskGoal } from '../src/sessions/userTask';
import { createUsageDetailsViewModel } from '../src/agent/subagentUsageStats';
import { createEmptySessionUsageStats } from '../src/agent/usageStats';
import { createWebviewDomHarness } from './webviewDomHarness';

function message(taskId: string, usedMs: number, status = 'running'): ChatMessage {
  return { id: taskId, role: 'assistant', content: '', createdAt: '',
    runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: {
      taskId, usedMs, status, maxExecutionMs: 1000, limitSource: 'test', attempt: 1,
      modelRequests: 1, retries: 0, steps: 0, canResume: false
    } } };
}
test('session timing uses task high-water marks across repeated snapshots, recovery and epoch changes', () => {
  const session = createEmptySession();
  for (const status of ['running', 'interrupted', 'running', 'cancelled', 'failed', 'completed']) {
    session.messages = [message('a', 65001, status), message('a', 64000, status)];
    session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
    assert.equal(executionTimeView(session).totalMs, 65001);
  }
  session.messages = [message('a', 70001), message('b', 2000)];
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(executionTimeView(session).totalMs, 72001);
  session.messages = [message('b', 0)];
  assert.equal(executionTimeView(session).totalMs, 72001);
  assert.equal(createEmptySession().executionTime?.incomplete, false);
  assert.equal(executionTimeView(createEmptySession()).totalMs, 0);
  assert.equal(session.messages[0].runCheckpointArchive?.summary.maxExecutionMs, 1000);
});
test('migration is conservative, idempotent and survives serialization with archived checkpoints', () => {
  const session = createEmptySession();
  delete session.executionTime;
  session.messages = [message('a', 90000), message('a', 50000), message('b', 10000)];
  const scope = { key: 'test', name: 'test', folderUris: [] };
  const load = (value: unknown) => normalizeStoredSessions({ sessions: [value] }, scope)[0];
  const migrated = load(session);
  assert.deepEqual(executionTimeView(migrated), { totalMs: 100000, incomplete: true });
  assert.deepEqual(executionTimeView(load(JSON.parse(JSON.stringify(migrated)))), executionTimeView(migrated));
  session.messages = [{ id: 'u', role: 'user', content: 'legacy', createdAt: '' }];
  assert.deepEqual(executionTimeView(load(session)), { totalMs: undefined, incomplete: true });
});
test('invalid durations are rejected without poisoning totals or treating unknown history as zero', () => {
  const stats = reconcileExecutionTime(undefined, [message('bad', Infinity), message('negative', -1), message('nan', NaN)]);
  assert.equal(stats.incomplete, true);
  assert.deepEqual(Object.keys(stats.byTask), []);
});
test('both time metrics share duration formatter with localized days and unknown values', () => {
  for (const language of ['zh-CN', 'en'] as const) {
    const translate = (key: string, values: Record<string, string | number> = {}) => (WEBVIEW_TRANSLATIONS[language][key] ?? key).replace(/\{(\w+)\}/gu, (_, name: string) => String(values[name] ?? ''));
    const context = { t: translate };
    const format = runInNewContext(usageFormattersFragment.source + '\nformatUsageRuntime', context) as (value: unknown) => string;
    for (const [ms, expected] of [[0, '00:00:00'], [59999, '00:00:59'], [60000, '00:01:00'], [65000, '00:01:05'], [3600000, '01:00:00'], [3661000, '01:01:01'], [86399999, '23:59:59']] as const) assert.equal(format(ms), expected);
    assert.equal(format(86400000), language === 'en' ? '1 day 00:00:00' : '1 天 00:00:00');
    assert.equal(format(90061000), language === 'en' ? '1 day 01:01:01' : '1 天 01:01:01');
    assert.equal(format(172800000), language === 'en' ? '2 days 00:00:00' : '2 天 00:00:00');
    for (const value of [undefined, null, NaN, Infinity, -1, '1000']) assert.equal(format(value), translate('usageMetricUnavailableValue'));
  }
});

test('active-scope union feeds display totals without adding child durations or idle time', async () => {
  let now = 0;
  const clock = new ExecutionClock(1000, 0, () => now);
  const parent = clock.enter();
  now = 100;
  const child = clock.enter();
  now = 200;
  parent();
  now = 300;
  child();
  now = 700; // waiting for approval / paused
  assert.equal(clock.usedMs, 300);
  const session = createEmptySession();
  session.messages = [message('parent', clock.usedMs)];
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  const resumed = new ExecutionClock(1000, clock.usedMs, () => now);
  const active = resumed.enter();
  now = 800;
  active();
  session.messages = [message('parent', resumed.usedMs, 'failed')];
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(executionTimeView(session).totalMs, 400);
  assert.equal(resumed.remainingMs, 600);
  clock.dispose(); resumed.dispose();
});


test('one user task covers model/reviewer/command/continuation scopes, excludes human wait and deduplicates children', () => {
  let now = 0;
  const clock = new UserTaskClock(() => now);
  const session = createEmptySession();
  const task = { version: 1 as const, id: 'u1', originMessageId: 'u1', reason: 'user' as const };
  const model = clock.enter(session, task);
  now += 10000; model.finish();
  now += 60000; // manual wait
  const review = clock.enter(session, { ...task, reason: 'approval' });
  now += 2000; review.finish();
  const command = clock.enter(session, task); now += 3000; command.finish();
  const continuation = clock.enter(session, { ...task, reason: 'command' }); now += 5000; continuation.finish();
  assert.equal(executionTimeView(session).currentMs, 20000);
  const parent = clock.enter(session, task), child1 = clock.enter(session, task), child2 = clock.enter(session, task);
  parent.setActive(false); now += 5000; child1.finish(); child2.finish(); parent.finish();
  assert.equal(executionTimeView(session).currentMs, 25000);
  const next = { ...task, id: 'u2', originMessageId: 'u2' };
  const newTask = clock.enter(session, next);
  assert.equal(executionTimeView(session).currentMs, 0);
  now += 1000; newTask.setActive(false); now += 60000;
  assert.equal(executionTimeView(session).currentMs, 1000);
  newTask.setActive(true); now += 1000; newTask.finish();
  assert.equal(executionTimeView(session).totalMs, 27000);
  session.messages = []; // UI history pagination never defines the current task
  assert.equal(executionTimeView(session).currentMs, 2000);
  const reloaded = JSON.parse(JSON.stringify(session));
  clock.dispose(); now += 100000;
  const newClock = new UserTaskClock(() => now);
  const resumed = newClock.enter(reloaded, next); now += 1000; resumed.finish();
  assert.equal(executionTimeView(reloaded).totalMs, 28000);
  newClock.dispose();
});

test('host measured task never sums Runner snapshots, including duplicate/old snapshots and deletion', () => {
  let now = 0;
  const clock = new UserTaskClock(() => now);
  const session = createEmptySession();
  const task = { version: 1 as const, id: 'user', originMessageId: 'user', reason: 'user' as const };
  session.messages = [{ id: 'user', role: 'user', content: 'task', createdAt: '', userTask: task }];
  const work = clock.enter(session, task);
  for (const [id, ms] of [['one', 4000], ['two', 2000], ['one', 1000]] as const) {
    const assistant = { ...message(id, ms), userTask: task };
    session.messages.push(assistant);
    now += 5000; clock.bindSegment(session, assistant);
    session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  }
  work.finish();
  assert.equal(executionTimeView(session).totalMs, 15000);
  session.messages = [];
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(executionTimeView(session).totalMs, 15000);
  assert.equal(executionTimeView(session).currentMs, 15000);
  clock.dispose();
});

test('legacy explicit continuations join only their original user task and preserve reliable totals', () => {
  const session = createEmptySession();
  session.executionTime = { version: 1, byTask: { oldMissing: 5000 }, incomplete: true };
  session.messages = [
    { id: 'first', role: 'user', content: 'first task', createdAt: '' }, message('a', 33470),
    { id: 'auto', role: 'user', content: 'host result', createdAt: '', contextMeta: { displayKind: 'delegated_auto_continue' } }, message('b', 8681),
    { id: 'new', role: 'user', content: 'continue with an independent question', createdAt: '' }, message('c', 1000)
  ];
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(session.messages[3].userTask?.id, 'first');
  assert.equal(session.messages[5].userTask?.id, 'new');
  assert.equal(executionTimeView(session).totalMs, 48151);
  assert.equal(executionTimeView(session).currentMs, 1000);
  const snapshot = JSON.stringify(session.executionTime);
  session.executionTime = reconcileExecutionTime(JSON.parse(snapshot), session.messages);
  assert.equal(JSON.stringify(session.executionTime), snapshot);
});

test('legacy supplementary user turn with the same archived execution ID cannot double the high-water mark', () => {
  const session = createEmptySession();
  session.executionTime = { version: 1, byTask: { segment: 3000 }, incomplete: true };
  session.messages = [
    { id: 'user', role: 'user', content: 'original', createdAt: '' }, message('segment', 2000),
    { id: 'supplement', role: 'user', content: 'additional requirement', createdAt: '' }, { ...message('segment', 4000), id: 'recovery' }
  ];
  const contents = session.messages.map(m => m.content);
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(executionTimeView(session).totalMs, 4000);
  assert.equal(executionTimeView(session).currentMs, 4000);
  assert.equal(session.messages[2].userTask?.id, 'user');
  assert.equal(taskGoal(session.messages, 'user'), 'original\n\nadditional requirement');
  assert.deepEqual(session.messages.map(m => m.content), contents);
  session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
  assert.equal(executionTimeView(session).totalMs, 4000);
});

test('complete webview handles timing ticks and keeps new/history session navigation working', () => {
  const view = createWebviewDomHarness();
  const a = createEmptySession('en');
  const b = createEmptySession('en');
  a.title = 'Approval diagnostics';
  b.title = 'New task';
  a.messages = [
    { id: 'question-a', role: 'user', content: 'Investigate approval failures', createdAt: a.createdAt },
    { id: 'answer-a', role: 'assistant', content: 'Inspect the approval record.', createdAt: a.createdAt }
  ];
  const sessionUsageStats = createEmptySessionUsageStats();
  const publishSession = (session: typeof a, revision: number) => view.receive({
    type: 'state', revision,
    state: {
      activeSessionId: session.id,
      sessionSummaries: [a, b].map(item => ({ id: item.id, title: item.title, messageCount: item.messages.length,
        createdAt: item.createdAt, updatedAt: item.updatedAt })),
      messages: session.messages, language: 'en', isBusy: false,
      startup: { interactiveReady: true, sideEffectsReady: true },
      usageMetrics: { executionTime: executionTimeView(session), sessionUsageStats,
        usageDetails: createUsageDetailsViewModel({ sessionUsageStats }), turnCount: session.messages.length / 2 }
    }
  });
  const tick = (sessionId: string, currentMs: number) => view.receive({
    type: 'taskTiming', sessionId, executionTime: { currentMs, totalMs: currentMs, incomplete: false }
  });

  publishSession(a, 1);
  const prompt = view.element('promptInput');
  prompt.textContent = 'Unsent draft';
  assert.doesNotThrow(() => tick(a.id, 65_000));
  assert.match(view.element('contextProgressBreakdown').textContent, /00:01:05/u);
  assert.equal(prompt.textContent, 'Unsent draft');
  assert.equal(view.element('currentSessionTitle').textContent, a.title);
  assert.match(view.element('transcript').textContent, /Inspect the approval record\./u);
  assert.equal(view.state.isBusy, false);

  view.element('newChatTab').click();
  assert.equal(view.posted.at(-1)?.type, 'newSession');
  assert.equal(prompt.textContent, 'Unsent draft', 'a navigation request cannot discard a draft before the Host commits the new session');
  view.receive({ type: 'sessionChanged' });
  publishSession(b, 2);
  assert.equal(prompt.textContent, '');
  assert.equal(view.element('currentSessionTitle').textContent, b.title);
  assert.doesNotMatch(view.element('transcript').textContent, /Inspect the approval record/u);
  const bTiming = view.state.usageMetrics.executionTime;
  const bUsage = view.element('contextProgressBreakdown').textContent;
  tick(a.id, 99_000);
  assert.equal(view.state.usageMetrics.executionTime, bTiming, 'late ticks from the previous session are ignored');
  assert.equal(view.element('contextProgressBreakdown').textContent, bUsage);

  view.element('historyTab').click();
  const menu = view.element('sessionMenu');
  const aRow = menu.querySelector(`[data-session-id="${a.id}"]`);
  assert.ok(aRow);
  menu.dispatchEvent({ type: 'click', target: aRow.querySelector('.session-menu-item-title') });
  assert.equal(view.posted.at(-1)?.type, 'selectSession');
  assert.equal(view.posted.at(-1)?.sessionId, a.id);
  view.receive({ type: 'sessionChanged' });
  publishSession(a, 3);
  assert.equal(prompt.textContent, 'Unsent draft', 'returning to a session restores its draft');
  tick(a.id, 66_000);
  assert.equal(view.element('currentSessionTitle').textContent, a.title);
  assert.match(view.element('transcript').textContent, /Inspect the approval record\./u);
  assert.match(view.element('contextProgressBreakdown').textContent, /00:01:06/u);
  const activeTiming = view.state.usageMetrics.executionTime;
  tick(b.id, 120_000);
  assert.equal(view.state.usageMetrics.executionTime, activeTiming);

  // An early/teardown tick can arrive without a mounted public input API.
  delete view.window.keepseekInputControls;
  assert.doesNotThrow(() => tick(a.id, 67_000));
  assert.equal(view.state.usageMetrics.executionTime.currentMs, 67_000);
});
