import type { WebviewFragment } from '../../composition';

export const historySettingsDeclarationFragment: WebviewFragment = {
  id: 'dialogs.history-settings.declaration',
  source: `
      var historySettingsOverlay = document.getElementById('historySettingsDialogOverlay');
      var historyRetentionDaysInput = document.getElementById('historyRetentionDaysInput');
      var historySettingsSaveStatus = document.getElementById('historySettingsSaveStatus');
      var historyCleanupScope = document.getElementById('historyCleanupScope');
      var historyCleanupMode = document.getElementById('historyCleanupMode');
      var historyCleanupDays = document.getElementById('historyCleanupDays');
      var historyCleanupDaysField = document.getElementById('historyCleanupDaysField');
      var historyCleanupSummary = document.getElementById('historyCleanupSummary');
      var historyCleanupSubmitBtn = document.getElementById('historyCleanupSubmitBtn');
      var historyCleanupRetryBtn = document.getElementById('historyCleanupRetryBtn');
      var historyCleanupAgainBtn = document.getElementById('historyCleanupAgainBtn');
`.slice(1)
};

export const historySettingsButtonsFragment: WebviewFragment = {
  id: 'dialogs.history-settings.buttons',
  source: `
      var historySettingsSaveBtn = document.getElementById('historySettingsSaveBtn');
      var historySettingsCancelBtn = document.getElementById('historySettingsCancelBtn');
`.slice(1)
};

export const historySettingsStateFragment: WebviewFragment = {
  id: 'dialogs.history-settings.state',
  source: `
      var defaultHistoryRetentionDays = 7;
      var maxHistoryRetentionDays = 60;
      var historyCleanupSequence = 0;
      var historyCleanupRequestId = '';
      var historyCleanupStateRequestId = '';
      var historyCleanupPreview = null;
      var historyCleanupOperation = null;
      var historyCleanupCompletedOperationId = '';
      var historyCleanupSubmitting = false;
      var historySettingsReturnFocus = null;
      var historySettingsSavePending = false;

      function onHistorySettingsSaved(message) {
        if (!historySettingsSavePending) return;
        historySettingsSavePending = false;
        if (historySettingsSaveBtn) historySettingsSaveBtn.disabled = false;
        if (historySettingsSaveStatus) historySettingsSaveStatus.textContent = message.success
          ? t('historySettingsSaved') : String(message.error || t('historySettingsSaveFailed'));
      }

      function nextHistoryCleanupRequestId() {
        historyCleanupSequence += 1;
        return 'history-cleanup-' + Date.now() + '-' + historyCleanupSequence;
      }

      function historyCleanupErrorText(error) {
        var code = String(error || '');
        if (code === 'history_changed') return t('historyCleanupHistoryChanged');
        if (['invalid_preview', 'expired_preview', 'stale_preview'].includes(code)) return t('historyCleanupPreviewExpired');
        if (code === 'cleanup_busy') return t('historyCleanupBusy');
        if (code === 'nothing_to_clean') return t('historyCleanupNoCandidates');
        if (['journal_corrupt', 'journal_unavailable', 'storage_failed', 'cleanup_failed'].includes(code)) return t('historyCleanupStorageFailed');
        if (/^[a-z_]+$/.test(code)) return t('historyCleanupStorageFailed');
        return code || t('historyCleanupStorageFailed');
      }

      function historyCleanupOptions(value) {
        return value && value.options ? value.options : value || {};
      }

      function historyCleanupRuleText(value) {
        var options = historyCleanupOptions(value);
        var scope = t(options.scope === 'all' ? 'historyCleanupScopeAll' : 'historyCleanupScopeCurrent');
        if (options.mode === 'all') return scope + ' · ' + t('historyCleanupModeAll');
        var cutoff = value && value.cutoff;
        var zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        var date = new Date(cutoff);
        var formatted = Number.isFinite(date.getTime())
          ? new Intl.DateTimeFormat(state.language === 'en' ? 'en-GB' : 'zh-CN', {
              year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
              second: '2-digit', hourCycle: 'h23', timeZone: zone
            }).format(date) + ' (' + zone + ')' : t('historyCleanupTimeUnknown');
        return scope + ' · ' + t('historyCleanupCutoff', { days: options.days || 3, cutoff: formatted });
      }

      function setHistoryCleanupReadonly(readonly) {
        [historyCleanupScope, historyCleanupMode, historyCleanupDays].forEach(function(element) {
          if (element) element.disabled = readonly;
        });
        if (historyCleanupDays) historyCleanupDays.disabled = readonly || historyCleanupMode.value === 'all';
        if (historyCleanupDaysField) historyCleanupDaysField.classList.toggle('hidden', historyCleanupMode.value === 'all');
      }

      function resetHistoryCleanupForm() {
        historyCleanupPreview = null;
        historyCleanupOperation = null;
        historyCleanupSubmitting = false;
        if (historyCleanupScope) historyCleanupScope.value = 'current';
        if (historyCleanupMode) historyCleanupMode.value = 'olderThan';
        if (historyCleanupDays) historyCleanupDays.value = '3';
        setHistoryCleanupReadonly(false);
        if (historyCleanupSubmitBtn) { historyCleanupSubmitBtn.disabled = true; historyCleanupSubmitBtn.classList.remove('hidden'); }
        if (historyCleanupAgainBtn) historyCleanupAgainBtn.classList.add('hidden');
        if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.add('hidden');
        if (historyCleanupSummary) historyCleanupSummary.textContent = t('historyCleanupLoading');
      }

      function invalidateHistoryCleanupPreview() {
        if (historyCleanupRequestId) vscode.postMessage({ type: 'dismissHistoryCleanupPreview', requestId: historyCleanupRequestId });
        historyCleanupRequestId = '';
        historyCleanupPreview = null;
        if (historyCleanupSubmitBtn) historyCleanupSubmitBtn.disabled = true;
      }

      function requestHistoryCleanupPreview() {
        if (historyCleanupSubmitting || historyCleanupOperation) return;
        invalidateHistoryCleanupPreview();
        historyCleanupStateRequestId = '';
        historyCleanupRequestId = nextHistoryCleanupRequestId();
        if (historyCleanupSummary) historyCleanupSummary.textContent = t('historyCleanupLoading');
        if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.add('hidden');
        setHistoryCleanupReadonly(false);
        var options = { type: 'previewHistoryCleanup', requestId: historyCleanupRequestId,
          scope: historyCleanupScope.value, mode: historyCleanupMode.value };
        if (options.mode === 'olderThan') options.days = Number(historyCleanupDays.value);
        vscode.postMessage(options);
      }

      function renderHistoryCleanupOperation(operation) {
        historyCleanupOperation = operation;
        historyCleanupPreview = null;
        var options = historyCleanupOptions(operation);
        if (historyCleanupScope) historyCleanupScope.value = options.scope;
        if (historyCleanupMode) historyCleanupMode.value = options.mode;
        if (historyCleanupDays) historyCleanupDays.value = String(options.days || 3);
        var active = operation.status === 'confirming' || operation.status === 'running';
        historyCleanupSubmitting = active;
        setHistoryCleanupReadonly(true);
        if (historyCleanupSubmitBtn) { historyCleanupSubmitBtn.disabled = true; historyCleanupSubmitBtn.classList.add('hidden'); }
        if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.add('hidden');
        if (historyCleanupAgainBtn) historyCleanupAgainBtn.classList.toggle('hidden', active);
        var text = historyCleanupRuleText(operation) + '\\n';
        if (operation.status === 'confirming') text += t('historyCleanupConfirming');
        else if (operation.status === 'running') text += t('historyCleanupProgress', { processed: operation.processed || 0, total: operation.total || 0 });
        else if (operation.status === 'cancelled') text += t('historyCleanupCancelled');
        else {
          if (operation.status === 'failed') text += historyCleanupErrorText(operation.error) + '\\n';
          text += t('historyCleanupResult', { deleted: operation.fullyDeleted || 0,
          pending: operation.removedPendingCleanup || 0, protected: operation.protected || 0,
          changed: operation.skippedChanged || 0, unknown: operation.unknown || 0,
          failed: operation.failedBeforeCommit || 0 });
        }
        var genericReasons = 0;
        Object.entries(operation.reasonCounts || {}).forEach(function(entry) {
          var reasonKeys = {
            unverified_legacy_logs: 'historyCleanupReasonLegacyLogs',
            session_storage_pending: 'historyCleanupReasonSessionStorage',
            workspace_state_cleanup_failed: 'historyCleanupReasonWorkspaceState',
            inaccessible_legacy_source: 'historyCleanupReasonLegacySource'
          };
          var count = Number(entry[1]) || 0;
          if (reasonKeys[entry[0]]) text += '\\n' + t(reasonKeys[entry[0]], { count: count });
          else genericReasons += count;
        });
        if (genericReasons) text += '\\n' + t('historyCleanupReasonAssociated', { count: genericReasons });
        if (operation.inaccessibleLegacy) text += '\\n' + t('historyCleanupLegacyPending', { count: operation.inaccessibleLegacy });
        if (operation.error && operation.status !== 'failed') text += '\\n' + historyCleanupErrorText(operation.error);
        if (historyCleanupSummary) historyCleanupSummary.textContent = text;
        if (!active) historyCleanupCompletedOperationId = operation.operationId || '';
      }

      function onHistoryCleanupMessage(message) {
        if (message.type === 'historyCleanupPreview') {
          if (message.requestId !== historyCleanupRequestId || historyCleanupOperation || historyCleanupSubmitting) return;
          historyCleanupPreview = message;
          if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.remove('hidden');
          if (historyCleanupSubmitBtn) historyCleanupSubmitBtn.disabled = !!message.error || !message.previewToken || !(message.candidateCount > 0);
          if (historyCleanupSummary) {
            var text = message.error || historyCleanupRuleText(message) + '\\n' + t('historyCleanupPreviewCounts', {
              count: message.candidateCount || 0, favorites: message.favoriteCount || 0,
              protected: message.protectedCount || 0, unknown: message.unknownCount || 0 });
            if (!message.error && !(message.candidateCount > 0)) text += '\\n' + t(message.protectedCount > 0 ? 'historyCleanupAllProtected' : 'historyCleanupNoCandidates', { count: message.protectedCount || 0 });
            if (!message.error && (message.includesCurrentSession || message.includesCurrent)) text += '\\n' + t('historyCleanupIncludesCurrent');
            historyCleanupSummary.textContent = text;
          }
          return;
        }
        var operation = Object.prototype.hasOwnProperty.call(message, 'operation') ? message.operation : (message.status ? message : null);
        var restoring = !!historyCleanupStateRequestId && message.requestId === historyCleanupStateRequestId;
        if (restoring && operation && operation.status === 'cancelled') operation = null;
        if (!operation) {
          if (message.error && (restoring || message.requestId === historyCleanupRequestId)) {
            historyCleanupStateRequestId = '';
            historyCleanupSubmitting = false;
            historyCleanupPreview = null;
            setHistoryCleanupReadonly(false);
            if (historyCleanupSummary) historyCleanupSummary.textContent = historyCleanupErrorText(message.error);
            if (historyCleanupSubmitBtn) historyCleanupSubmitBtn.disabled = true;
            if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.remove('hidden');
            return;
          }
          if (!restoring) return;
          historyCleanupStateRequestId = '';
          resetHistoryCleanupForm();
          requestHistoryCleanupPreview();
          return;
        }
        if (!restoring && operation.requestId !== historyCleanupRequestId
          && (!historyCleanupOperation || historyCleanupOperation.operationId !== operation.operationId)) return;
        if (!restoring && operation.operationId === historyCleanupCompletedOperationId
          && (operation.status === 'confirming' || operation.status === 'running')) return;
        historyCleanupStateRequestId = '';
        renderHistoryCleanupOperation(operation);
      }

`.slice(1)
};

export const historySettingsOpenFragment: WebviewFragment = {
  id: 'dialogs.history-settings.open',
  source: `
      function showHistorySettingsDialog(settings) {
        if (!historySettingsOverlay) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        if (historySettingsSaveStatus && !historySettingsSavePending) historySettingsSaveStatus.textContent = '';
        if (historyRetentionDaysInput) {
          historyRetentionDaysInput.value = String(normalizeIntegerInRange(values.historyRetentionDays, 1, maxHistoryRetentionDays, defaultHistoryRetentionDays));
        }
        historySettingsReturnFocus = document.activeElement;
        if (historyCleanupOperation && historyCleanupOperation.status === 'cancelled') historyCleanupOperation = null;
        historySettingsOverlay.classList.remove('hidden');
        invalidateHistoryCleanupPreview();
        if (historyCleanupOperation) renderHistoryCleanupOperation(historyCleanupOperation);
        else resetHistoryCleanupForm();
        historyCleanupStateRequestId = nextHistoryCleanupRequestId();
        vscode.postMessage({ type: 'getHistoryCleanupState', requestId: historyCleanupStateRequestId });
        if (historyRetentionDaysInput) {
          historyRetentionDaysInput.focus();
          if (historyRetentionDaysInput.select) historyRetentionDaysInput.select();
        }
      }

`.slice(1)
};

export const dialogIntegerNormalizerFragment: WebviewFragment = {
  id: 'dialogs.integer-normalizer',
  source: `
      function normalizeIntegerInRange(value, min, max, fallback) {
        var number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, Math.floor(number)));
      }

`.slice(1)
};

export const historySettingsCloseFragment: WebviewFragment = {
  id: 'dialogs.history-settings.close',
  source: `
      function hideHistorySettingsDialog() {
        if (!historySettingsOverlay) { return; }
        historySettingsOverlay.classList.add('hidden');
        if (!historyCleanupSubmitting) invalidateHistoryCleanupPreview();
        historyCleanupStateRequestId = '';
        if (historySettingsReturnFocus && historySettingsReturnFocus.isConnected && !historySettingsReturnFocus.closest('.hidden') && historySettingsReturnFocus.focus) historySettingsReturnFocus.focus();
        else promptInput.focus();
      }

`.slice(1)
};

export const historySettingsSaveBindingFragment: WebviewFragment = {
  id: 'dialogs.history-settings.save-binding',
  source: `
      if (historySettingsSaveBtn) {
        historySettingsSaveBtn.addEventListener('click', function() {
          if (historySettingsSavePending) return;
          var historyRetentionDays = normalizeIntegerInRange(
            historyRetentionDaysInput ? historyRetentionDaysInput.value : defaultHistoryRetentionDays,
            1, maxHistoryRetentionDays, defaultHistoryRetentionDays
          );
          if (historyRetentionDaysInput) historyRetentionDaysInput.value = String(historyRetentionDays);
          historySettingsSavePending = true;
          historySettingsSaveBtn.disabled = true;
          if (historySettingsSaveStatus) historySettingsSaveStatus.textContent = t('historySettingsSaving');
          vscode.postMessage({ type: 'saveHistorySettings', historyRetentionDays: historyRetentionDays });
        });
      }
      [historyCleanupScope, historyCleanupMode, historyCleanupDays].forEach(function(element) {
        if (element) element.addEventListener('change', function() { requestHistoryCleanupPreview(); });
      });
      if (historyCleanupRetryBtn) historyCleanupRetryBtn.addEventListener('click', requestHistoryCleanupPreview);
      if (historyCleanupAgainBtn) historyCleanupAgainBtn.addEventListener('click', function() {
        if (historyCleanupSubmitting) return;
        resetHistoryCleanupForm();
        requestHistoryCleanupPreview();
        if (historyCleanupScope) historyCleanupScope.focus();
      });
      if (historyCleanupSubmitBtn) historyCleanupSubmitBtn.addEventListener('click', function() {
        if (historyCleanupSubmitting || !historyCleanupPreview || !historyCleanupPreview.previewToken || historyCleanupSubmitBtn.disabled) return;
        historyCleanupSubmitting = true;
        setHistoryCleanupReadonly(true);
        historyCleanupSubmitBtn.disabled = true;
        if (historyCleanupSummary) historyCleanupSummary.textContent = historyCleanupRuleText(historyCleanupPreview) + '\\n' + t('historyCleanupConfirming');
        vscode.postMessage({ type: 'requestHistoryCleanup', requestId: historyCleanupRequestId, previewToken: historyCleanupPreview.previewToken });
      });

`.slice(1)
};

export const historySettingsCancelBindingFragment: WebviewFragment = {
  id: 'dialogs.history-settings.cancel-binding',
  source: `
      if (historySettingsCancelBtn) historySettingsCancelBtn.addEventListener('click', hideHistorySettingsDialog);

`.slice(1)
};

export const historySettingsOverlayBindingsFragment: WebviewFragment = {
  id: 'dialogs.history-settings.overlay-bindings',
  source: `
      if (historySettingsOverlay) {
        historySettingsOverlay.addEventListener('click', function(event) {
          if (event.target === historySettingsOverlay) hideHistorySettingsDialog();
        });
        historySettingsOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault(); hideHistorySettingsDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (historySettingsSaveBtn) historySettingsSaveBtn.click();
          } else if (event.key === 'Tab') {
            var focusable = Array.from(historySettingsOverlay.querySelectorAll('input, select, button')).filter(function(element) {
              return !element.disabled && !element.closest('.hidden');
            });
            var first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); if (last) last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); if (first) first.focus(); }
          }
        });
      }

`.slice(1)
};
