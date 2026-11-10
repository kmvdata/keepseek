import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebviewDomHarness } from './webviewDomHarness';

function cleanupView() {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { language: 'en', activeSessionId: 'active', messages: [],
    sessionSummaries: [], startup: { interactiveReady: false }, isBusy: false } });
  const requests = (type: string) => view.posted.filter(message => message.type === type);
  const open = () => {
    view.receive({ type: 'showHistorySettingsDialog', historyRetentionDays: 7 });
    const stateRequest = requests('getHistoryCleanupState').at(-1)!;
    return stateRequest.requestId;
  };
  const fresh = () => {
    const requestId = open();
    view.receive({ type: 'historyCleanupState', requestId, operation: null });
    return requests('previewHistoryCleanup').at(-1)!;
  };
  const preview = (request: Record<string, any>, overrides = {}) => view.receive({
    type: 'historyCleanupPreview', requestId: request.requestId, previewToken: 'token-' + request.requestId,
    options: { scope: request.scope, mode: request.mode, days: request.days },
    cutoff: '2026-11-07T07:00:00.000Z', candidateCount: 12, favoriteCount: 2, protectedCount: 1,
    unknownCount: 0, includesCurrentSession: true, ...overrides
  });
  return { ...view, requests, open, fresh, preview };
}

test('history cleanup opens immediately, defaults independently, counts favorites and ignores stale previews', () => {
  const view = cleanupView();
  const request = view.fresh();
  assert.equal(view.element('historySettingsDialogOverlay').classList.contains('hidden'), false);
  assert.equal(request.scope, 'current');
  assert.equal(request.mode, 'olderThan');
  assert.equal(request.days, 3);
  assert.equal(view.element('historyRetentionDaysInput').value, '7');
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, true);
  view.preview(request);
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, false);
  assert.match(view.element('historyCleanupSummary').textContent, /12.*2.*1/u);
  assert.match(view.element('historyCleanupSummary').textContent, /last updated before/u);
  assert.match(view.element('historyCleanupSummary').textContent, /blank session/u);
  view.element('historyCleanupDays').value = '7';
  view.element('historyCleanupDays').dispatchEvent({ type: 'change' });
  const next = view.requests('previewHistoryCleanup').at(-1)!;
  assert.equal(next.days, 7);
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, true);
  view.preview(request, { candidateCount: 999 });
  assert.doesNotMatch(view.element('historyCleanupSummary').textContent, /999/u);
  view.preview(next, { candidateCount: 0, protectedCount: 0 });
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, true);
  assert.match(view.element('historyCleanupSummary').textContent, /Nothing to clear/u);
});

test('history cleanup hides days for all, sends only a token once, and keeps results with original options', () => {
  const view = cleanupView();
  view.fresh();
  view.element('historyCleanupScope').value = 'all';
  view.element('historyCleanupMode').value = 'all';
  view.element('historyCleanupMode').dispatchEvent({ type: 'change' });
  const request = view.requests('previewHistoryCleanup').at(-1)!;
  assert.equal(request.days, undefined);
  assert.equal(view.element('historyCleanupDays').disabled, true);
  assert.equal(view.element('historyCleanupDaysField').classList.contains('hidden'), true);
  view.preview(request);
  view.element('historyCleanupSubmitBtn').click();
  view.element('historyCleanupSubmitBtn').click();
  const submitted = view.requests('requestHistoryCleanup');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].confirmed, undefined);
  assert.equal(submitted[0].sessionIds, undefined);
  assert.ok(submitted[0].previewToken);
  view.receive({ type: 'historyCleanupState', operation: { requestId: request.requestId, operationId: 'op',
    status: 'running', options: { scope: 'all', mode: 'all' }, total: 12, processed: 8 } });
  assert.match(view.element('historyCleanupSummary').textContent, /8\/12/u);
  view.element('historySettingsCancelBtn').click();
  const restoreId = view.open();
  view.receive({ type: 'historyCleanupState', requestId: restoreId, operation: {
    requestId: request.requestId, operationId: 'op', status: 'completed', options: { scope: 'all', mode: 'all' },
    total: 12, processed: 12, fullyDeleted: 8, removedPendingCleanup: 2, inaccessibleLegacy: 1,
    protected: 1, failedBeforeCommit: 1 } });
  assert.equal(view.element('historyCleanupScope').value, 'all');
  assert.equal(view.element('historyCleanupScope').disabled, true);
  assert.match(view.element('historyCleanupSummary').textContent, /All projects.*any age/u);
  assert.match(view.element('historyCleanupSummary').textContent, /Fully cleared: 8; removed with data pending: 2/u);
  assert.match(view.element('historyCleanupSummary').textContent, /inaccessible legacy/u);
  view.receive({ type: 'historyCleanupState', operation: { requestId: request.requestId, operationId: 'op',
    status: 'running', options: { scope: 'all', mode: 'all' }, total: 12, processed: 1 } });
  assert.match(view.element('historyCleanupSummary').textContent, /Fully cleared: 8/u);
  view.element('historyCleanupAgainBtn').click();
  const next = view.requests('previewHistoryCleanup').at(-1)!;
  assert.equal(next.scope, 'current'); assert.equal(next.mode, 'olderThan'); assert.equal(next.days, 3);
});

test('history display save shortcut cannot clear history, Escape returns focus and errors have retry', () => {
  const view = cleanupView();
  const prompt = view.element('promptInput');
  prompt.focus();
  const request = view.fresh();
  view.preview(request, { error: 'Storage temporarily unavailable' });
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, true);
  assert.equal(view.element('historyCleanupRetryBtn').classList.contains('hidden'), false);
  assert.equal(view.element('historyCleanupSummary').getAttribute('aria-live'), 'polite');
  view.element('historyCleanupRetryBtn').click();
  assert.equal(view.requests('previewHistoryCleanup').length, 2);
  view.element('historySettingsDialogOverlay').dispatchEvent({ type: 'keydown', key: 'Enter', metaKey: true });
  assert.equal(view.requests('saveHistorySettings').length, 1);
  assert.equal(view.requests('requestHistoryCleanup').length, 0);
  assert.equal(view.element('historySettingsDialogOverlay').classList.contains('hidden'), false);
  assert.match(view.element('historySettingsSaveStatus').textContent, /Saving display settings/u);
  view.receive({ type: 'historySettingsSaved', success: true });
  assert.match(view.element('historySettingsSaveStatus').textContent, /settings saved/u);
  view.element('historySettingsDialogOverlay').dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.document.activeElement, prompt);
  view.fresh();
  view.element('historySettingsDialogOverlay').dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('historySettingsDialogOverlay').classList.contains('hidden'), true);
  assert.equal(view.requests('requestHistoryCleanup').length, 0);
});

test('a cancelled confirmation leaves no destructive defaults on reopening the form', () => {
  const view = cleanupView();
  const request = view.fresh(); view.preview(request); view.element('historyCleanupSubmitBtn').click();
  const old = { requestId: request.requestId, operationId: 'old-op', status: 'cancelled',
    options: { scope: 'all', mode: 'all' }, total: 15, processed: 0 };
  view.receive({ type: 'historyCleanupState', operation: old });
  assert.match(view.element('historyCleanupSummary').textContent, /Cancelled/u);
  view.element('historySettingsCancelBtn').click();
  const stateRequest = view.open();
  view.receive({ type: 'historyCleanupState', requestId: stateRequest, operation: old });
  const fresh = view.requests('previewHistoryCleanup').at(-1)!;
  assert.equal(fresh.scope, 'current'); assert.equal(fresh.mode, 'olderThan'); assert.equal(fresh.days, 3);
});

test('clearing the idle current session transfers unsent markup through replacement and intervening state races', () => {
  for (const ordering of ['replacement-first', 'deleted-state-replacement', 'state-deleted-replacement']) {
    const view = cleanupView();
    view.receive({ type: 'state', revision: 2, state: { activeSessionId: 'active', messages: [],
      sessionSummaries: [{ id: 'active', workspaceKey: 'workspace', title: 'old', messageCount: 1 }],
      startup: { interactiveReady: true } } });
    const prompt = view.element('promptInput');
    prompt.innerHTML = 'Keep this unsent draft';
    const deleted = () => view.receive({ type: 'historyCleanupDeleted', workspaceKey: 'workspace', sessionIds: ['active'] });
    const replacement = () => view.receive({ type: 'historyCleanupSessionReplacement', previousSessionId: 'active', sessionId: 'replacement' });
    const state = () => view.receive({ type: 'state', revision: 3, state: { activeSessionId: 'replacement', messages: [],
      sessionSummaries: [], startup: { interactiveReady: true },
      interaction: { sessionId: 'replacement', phase: 'idle', canEditDraft: true, canSubmit: true, canNavigate: true } } });
    if (ordering === 'state-deleted-replacement') { state(); deleted(); replacement(); }
    else if (ordering === 'deleted-state-replacement') {
      deleted(); state();
      assert.equal(prompt.textContent, 'Keep this unsent draft', 'the intervening blank state already preserves the draft');
      prompt.innerHTML = 'Draft edited while replacement is pending';
      replacement();
    }
    else { deleted(); replacement(); state(); }
    assert.equal(prompt.textContent, ordering === 'deleted-state-replacement'
      ? 'Draft edited while replacement is pending' : 'Keep this unsent draft', ordering);
    assert.equal(view.state.activeSessionId, 'replacement');
    assert.equal(view.state.sessionSummaries.length, 0);
    assert.equal(view.requests('sendPrompt').length, 0);
  }
});

test('history cleanup has Chinese feedback and traps keyboard focus inside the open dialog', () => {
  const view = cleanupView();
  view.receive({ type: 'state', revision: 2, state: { language: 'zh-CN' } });
  const request = view.fresh();
  view.preview(request, { candidateCount: 0, protectedCount: 4 });
  assert.match(view.element('historyCleanupSummary').textContent, /4 个会话正在使用/u);
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, true);
  const first = view.element('historyRetentionDaysInput');
  const last = view.element('historySettingsCancelBtn');
  first.focus();
  view.element('historySettingsDialogOverlay').dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: true });
  assert.equal(view.document.activeElement, last);
  view.element('historySettingsDialogOverlay').dispatchEvent({ type: 'keydown', key: 'Tab', shiftKey: false });
  assert.equal(view.document.activeElement, first);
});

test('history cleanup failures leave a durable result or retry instead of a stuck confirmation', () => {
  const view = cleanupView();
  const request = view.fresh(); view.preview(request);
  view.element('historyCleanupSubmitBtn').click();
  view.receive({ type: 'historyCleanupState', requestId: request.requestId, error: 'Preview expired. Preview again.' });
  assert.match(view.element('historyCleanupSummary').textContent, /Preview expired/u);
  assert.equal(view.element('historyCleanupScope').disabled, false);
  assert.equal(view.element('historyCleanupRetryBtn').classList.contains('hidden'), false);
  view.element('historyCleanupRetryBtn').click();
  const retry = view.requests('previewHistoryCleanup').at(-1)!;
  view.preview(retry); view.element('historyCleanupSubmitBtn').click();
  view.receive({ type: 'historyCleanupState', operation: { requestId: retry.requestId, operationId: 'partial',
    status: 'failed', options: { scope: 'current', mode: 'olderThan', days: 3 }, cutoff: '2026-11-07T07:00:00Z',
    total: 12, processed: 4, fullyDeleted: 3, removedPendingCleanup: 1, error: 'history_changed',
    reasonCounts: { unverified_legacy_logs: 1, session_storage_pending: 1, usage_ledger_failed: 1 } } });
  assert.match(view.element('historyCleanupSummary').textContent, /History has changed/u);
  assert.match(view.element('historyCleanupSummary').textContent, /Fully cleared: 3/u);
  assert.doesNotMatch(view.element('historyCleanupSummary').textContent, /history_changed|unverified_legacy_logs|usage_ledger_failed/u);
  assert.match(view.element('historyCleanupSummary').textContent, /Legacy logs lack reliable ownership/u);
  assert.match(view.element('historyCleanupSummary').textContent, /storage reclamation is pending/u);
});

test('delayed pre-delete lists and title callbacks cannot reintroduce cleared IDs into the Webview', () => {
  const view = cleanupView();
  view.receive({ type: 'state', revision: 2, state: { sessionSummaries: [
    { id: 'removed', workspaceKey: 'current-workspace', title: 'old' },
    { id: 'kept', workspaceKey: 'current-workspace', title: 'keep' }
  ] } });
  view.receive({ type: 'historyCleanupDeleted', workspaceKey: 'current-workspace', sessionIds: ['removed'] });
  view.receive({ type: 'state', revision: 3, state: { sessionSummaries: [
    { id: 'removed', workspaceKey: 'current-workspace', title: 'stale' },
    { id: 'kept', workspaceKey: 'current-workspace', title: 'keep' }
  ] } });
  view.receive({ type: 'sessionTitleRegeneration', sessionId: 'removed', requestId: 'late', running: true, restored: true });
  assert.equal(view.state.sessionSummaries.length, 1);
  assert.equal(view.state.sessionSummaries[0].id, 'kept');
  assert.equal(view.state.sessionTitleRegenerations?.removed, undefined);
});

test('display settings wait for a Host terminal and keep their feedback separate from cleanup', () => {
  const view = cleanupView();
  const request = view.fresh(); view.preview(request);
  const cleanupSummary = view.element('historyCleanupSummary').textContent;
  view.element('historySettingsSaveBtn').click();
  view.element('historySettingsSaveBtn').click();
  assert.equal(view.requests('saveHistorySettings').length, 1);
  assert.equal(view.element('historySettingsSaveBtn').disabled, true);
  assert.equal(view.element('historyCleanupSubmitBtn').disabled, false);
  assert.match(view.element('historySettingsSaveStatus').textContent, /Saving display settings/u);
  assert.doesNotMatch(view.element('historySettingsSaveStatus').textContent, /settings saved/u);
  view.receive({ type: 'historySettingsSaved', success: false, error: 'Display settings could not be saved.' });
  assert.equal(view.element('historySettingsSaveBtn').disabled, false);
  assert.equal(view.element('historySettingsSaveStatus').textContent, 'Display settings could not be saved.');
  assert.equal(view.element('historyCleanupSummary').textContent, cleanupSummary);
  assert.equal(view.element('historySettingsDialogOverlay').classList.contains('hidden'), false);
  view.element('historySettingsSaveBtn').click();
  view.receive({ type: 'historySettingsSaved', success: true });
  assert.match(view.element('historySettingsSaveStatus').textContent, /settings saved/u);
  assert.equal(view.element('historyCleanupSummary').textContent, cleanupSummary);
  assert.equal(view.requests('requestHistoryCleanup').length, 0);
});
