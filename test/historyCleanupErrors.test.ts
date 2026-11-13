import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyHistoryCleanupError, HistoryCleanupFailure, localizeHistoryCleanupIssue } from '../src/sessions/historyCleanupErrors';

test('cleanup errors retain typed stages and unwrap permission failures without exposing filesystem messages', () => {
  const cause = Object.assign(new Error('EACCES reading /private/user/history/index.json secret-value'), { code: 'EACCES' });
  const error = Object.assign(new Error('journal_unavailable', { cause }), { code: 'journal_unavailable' });
  const issue = classifyHistoryCleanupError(error, 'state');
  assert.deepEqual(issue, { code: 'permission_denied', phase: 'state', retryable: false, systemCode: 'EACCES' });
  for (const language of ['zh-CN', 'en']) {
    const localized = localizeHistoryCleanupIssue(issue, language);
    assert.ok(localized.message);
    assert.doesNotMatch(JSON.stringify(localized), /private|secret-value|index\.json/u);
  }
  assert.deepEqual(classifyHistoryCleanupError(new HistoryCleanupFailure('ownership_unverified', 'ownership', false), 'preview'),
    { code: 'ownership_unverified', phase: 'ownership', retryable: false });
});

test('cleanup distinguishes unsupported URI, unsafe path, damaged index and damaged journal', () => {
  assert.equal(classifyHistoryCleanupError(new Error('Associated data cannot be safely reclaimed for this storage URI.'), 'preview').code,
    'unsupported_storage');
  assert.equal(classifyHistoryCleanupError(new Error('Symbolic-link associated storage is unavailable for cleanup.'), 'catalog').code,
    'unsafe_storage_path');
  assert.equal(classifyHistoryCleanupError(new Error('Associated storage path escaped its root.'), 'catalog').code,
    'unsafe_storage_path');
  assert.equal(classifyHistoryCleanupError(new SyntaxError('unexpected body /private/user/index.json'), 'catalog').code, 'corrupt_index');
  assert.equal(classifyHistoryCleanupError(new Error('journal_unavailable', { cause: new SyntaxError('bad old result') }), 'state').code,
    'journal_corrupt');
});

test('cleanup handles known validation and readiness codes while unknown details remain bounded safe metadata', () => {
  assert.deepEqual(classifyHistoryCleanupError(new Error('loading_sessions'), 'preview'),
    { code: 'loading_sessions', phase: 'preview', retryable: true });
  for (const code of ['invalid_scope', 'invalid_mode', 'invalid_days', 'invalid_now', 'invalid_request']) {
    assert.equal(classifyHistoryCleanupError(Object.assign(new Error(code), { code }), 'preview').code, 'invalid_options');
  }
  assert.equal(classifyHistoryCleanupError(Object.assign(new Error('/private/path'), { code: 'NoPermissions' }), 'catalog').code,
    'permission_denied');
  assert.equal(classifyHistoryCleanupError(Object.assign(new Error('/private/path'), { code: 'EIO' }), 'catalog').code, 'storage_io');
  const untrusted = Object.assign(new Error('token=secret /private/path failed'), { code: 'user-controlled/path' });
  const issue = localizeHistoryCleanupIssue(classifyHistoryCleanupError(untrusted, 'preview'), 'en');
  assert.deepEqual({ code: issue.code, retryable: issue.retryable }, { code: 'storage_unavailable', retryable: true });
  assert.doesNotMatch(JSON.stringify(issue), /private|secret|user-controlled/u);
});

test('cleanup cause inspection is bounded and tolerates cyclic unknown exceptions', () => {
  const error = new Error('cyclic unsafe untrusted payload') as Error & { cause?: unknown };
  error.cause = error;
  assert.deepEqual(classifyHistoryCleanupError(error, 'execute'),
    { code: 'storage_unavailable', phase: 'execute', retryable: true });
  assert.deepEqual(classifyHistoryCleanupError(null, 'preview'),
    { code: 'storage_unavailable', phase: 'preview', retryable: true });
});
