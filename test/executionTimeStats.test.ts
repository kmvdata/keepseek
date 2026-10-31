import './registerVscodeStub';
import { ExecutionClock } from '../src/agent/executionPolicy';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { reconcileExecutionTime, executionTimeView } from '../src/sessions/executionTimeStats';
import { createEmptySession, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ChatMessage } from '../src/shared/types';
import { usageFormattersFragment } from '../src/webview/input/usage/formatters';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';

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
  assert.equal(executionTimeView(session).totalMs, 400);
  assert.equal(resumed.remainingMs, 600);
  clock.dispose(); resumed.dispose();
});
