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
      var historyCleanupNotice = document.getElementById('historyCleanupNotice');
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
      var historyCleanupAwaitingReady = false;
      var historyCleanupReadyRetried = false;
      var historyCleanupAwaitingProtection = false;
      var historyCleanupProtectionRetried = false;
      var historyCleanupProtectionReady = false;
      var historyCleanupRetryState = false;
      var historyCleanupRecordNotice = '';

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
        var structured = error && typeof error === 'object';
        var code = structured ? String(error.code || '') : String(error || '');
        var keys = {
          loading_sessions: 'historyCleanupLoadingSessions', initialization_failed: 'historyCleanupInitializationFailed',
          permission_denied: 'historyCleanupPermissionDenied', unsupported_storage: 'historyCleanupUnsupportedStorage',
          unsafe_storage_path: 'historyCleanupUnsafeStoragePath', corrupt_index: 'historyCleanupCorruptIndex',
          ownership_unverified: 'historyCleanupOwnershipUnverified', deletion_authority_unavailable: 'historyCleanupAuthorityUnavailable',
          journal_corrupt: 'historyCleanupJournalCorrupt', journal_unavailable: 'historyCleanupJournalUnavailable',
          storage_unavailable: 'historyCleanupStorageUnavailable', storage_io: 'historyCleanupStorageIO',
          invalid_options: 'historyCleanupInvalidOptions', unavailable: 'historyCleanupUnavailable'
        };
        if (keys[code]) return t(keys[code]);
        if (code === 'history_changed') return t('historyCleanupHistoryChanged');
        if (['invalid_preview', 'expired_preview', 'stale_preview'].includes(code)) return t('historyCleanupPreviewExpired');
        if (code === 'cleanup_busy') return t('historyCleanupBusy');
        if (code === 'nothing_to_clean') return t('historyCleanupNoCandidates');
        if (['journal_corrupt', 'journal_unavailable', 'storage_failed', 'cleanup_failed'].includes(code)) return t('historyCleanupStorageFailed');
        if (/^[a-z_]+$/.test(code)) return t('historyCleanupStorageFailed');
        return !structured && code || t('historyCleanupStorageFailed');
      }

      function setHistoryCleanupNotice(text) {
        if (!historyCleanupNotice) return;
        historyCleanupNotice.textContent = text || '';
        historyCleanupNotice.classList.toggle('hidden', !text);
      }

      function historyCleanupHasActiveOperation() {
        return historyCleanupOperation && (historyCleanupOperation.status === 'confirming' || historyCleanupOperation.status === 'running');
      }

      function requestHistoryCleanupState() {
        historyCleanupStateRequestId = nextHistoryCleanupRequestId();
        vscode.postMessage({ type: 'getHistoryCleanupState', requestId: historyCleanupStateRequestId });
      }

      function retryHistoryCleanup() {
        if (historyCleanupSubmitting || historyCleanupHasActiveOperation()) return;
        if (historyCleanupRetryState) {
          if (historyCleanupSummary) historyCleanupSummary.textContent = t('historyCleanupLoading');
          if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.add('hidden');
          requestHistoryCleanupState();
        } else requestHistoryCleanupPreview();
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
        historyCleanupAwaitingReady = false;
        historyCleanupReadyRetried = false;
        historyCleanupAwaitingProtection = false;
        historyCleanupProtectionRetried = false;
        historyCleanupProtectionReady = false;
        historyCleanupRetryState = false;
        historyCleanupRecordNotice = '';
        setHistoryCleanupNotice('');
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

      function requestHistoryCleanupPreview(automatic) {
        if (historyCleanupSubmitting || historyCleanupOperation) return;
        if (automatic !== true) {
          historyCleanupReadyRetried = false;
          historyCleanupProtectionRetried = false;
        }
        historyCleanupAwaitingReady = false;
        historyCleanupAwaitingProtection = false;
        historyCleanupRetryState = false;
        invalidateHistoryCleanupPreview();
        historyCleanupStateRequestId = '';
        historyCleanupRequestId = nextHistoryCleanupRequestId();
        if (historyCleanupSummary) historyCleanupSummary.textContent = t('historyCleanupLoading');
        if (historyCleanupRetryBtn) { historyCleanupRetryBtn.classList.add('hidden'); historyCleanupRetryBtn.textContent = t('historyCleanupRetry'); }
        setHistoryCleanupReadonly(false);
        var options = { type: 'previewHistoryCleanup', requestId: historyCleanupRequestId,
          scope: historyCleanupScope.value, mode: historyCleanupMode.value };
        if (options.mode === 'olderThan') options.days = Number(historyCleanupDays.value);
        vscode.postMessage(options);
      }

      function renderHistoryCleanupOperation(operation) {
        historyCleanupOperation = operation;
        historyCleanupPreview = null;
        historyCleanupAwaitingReady = false;
        historyCleanupAwaitingProtection = false;
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
            unverified_logs: 'historyCleanupReasonUnverifiedLogs',
            session_storage_pending: 'historyCleanupReasonSessionStorage',
          };
          var count = Number(entry[1]) || 0;
          if (reasonKeys[entry[0]]) text += '\\n' + t(reasonKeys[entry[0]], { count: count });
          else genericReasons += count;
        });
        if (genericReasons) text += '\\n' + t('historyCleanupReasonAssociated', { count: genericReasons });
        if (operation.error && operation.status !== 'failed') text += '\\n' + historyCleanupErrorText(operation.error);
        if (historyCleanupSummary) historyCleanupSummary.textContent = text;
        if (!active) historyCleanupCompletedOperationId = operation.operationId || '';
      }

      function onHistoryCleanupMessage(message) {
        if (message.type === 'historyCleanupReady') {
          var protectionReady = message.phase === 'protection';
          if (protectionReady) historyCleanupProtectionReady = message.available === true;
          if (!(protectionReady ? historyCleanupAwaitingProtection : historyCleanupAwaitingReady)
            || historyCleanupSubmitting || historyCleanupOperation || !historySettingsOverlay || historySettingsOverlay.classList.contains('hidden')) return;
          if (message.available === false) {
            historyCleanupAwaitingReady = false;
            historyCleanupAwaitingProtection = false;
            onHistoryCleanupMessage({ type: 'historyCleanupPreview', requestId: historyCleanupRequestId,
              error: message.error || { code: 'initialization_failed', phase: 'initialization', retryable: false } });
            return;
          }
          if (message.available !== true || (protectionReady ? historyCleanupProtectionRetried : historyCleanupReadyRetried)) return;
          if (protectionReady) historyCleanupProtectionRetried = true;
          else historyCleanupReadyRetried = true;
          requestHistoryCleanupPreview(true);
          return;
        }
        if (message.type === 'historyCleanupPreview') {
          if (message.requestId !== historyCleanupRequestId || historyCleanupOperation || historyCleanupSubmitting) return;
          historyCleanupPreview = message;
          historyCleanupAwaitingReady = !!message.error && typeof message.error === 'object' && message.error.code === 'loading_sessions';
          historyCleanupAwaitingProtection = !message.error && message.protectionReady === false && message.protectedCount > 0;
          if (message.protectionReady === true) historyCleanupProtectionReady = true;
          var reasons = Array.isArray(message.diagnostics)
            ? Array.from(new Set(message.diagnostics.map(function(item) { return historyCleanupErrorText(item); }))) : [];
          setHistoryCleanupNotice([historyCleanupRecordNotice].concat(reasons).filter(Boolean).join('\\n'));
          if (historyCleanupRetryBtn) historyCleanupRetryBtn.classList.remove('hidden');
          if (historyCleanupSubmitBtn) historyCleanupSubmitBtn.disabled = !!message.error || !message.previewToken || !(message.candidateCount > 0);
          if (historyCleanupSummary) {
            var text = message.error ? historyCleanupErrorText(message.error) : historyCleanupRuleText(message) + '\\n' + t('historyCleanupPreviewCounts', {
              count: message.candidateCount || 0, favorites: message.favoriteCount || 0,
              protected: message.protectedCount || 0, unknown: message.unknownCount || 0 });
            if (!message.error && !(message.candidateCount > 0)) text += '\\n' + t(message.protectedCount > 0 ? 'historyCleanupAllProtected' : 'historyCleanupNoCandidates', { count: message.protectedCount || 0 });
            if (!message.error && (message.includesCurrentSession || message.includesCurrent)) text += '\\n' + t('historyCleanupIncludesCurrent');
            historyCleanupSummary.textContent = text;
          }
          if (historyCleanupAwaitingProtection && historyCleanupProtectionReady) {
            onHistoryCleanupMessage({ type: 'historyCleanupReady', available: true, phase: 'protection' });
          }
          return;
        }
        var operation = Object.prototype.hasOwnProperty.call(message, 'operation') ? message.operation : (message.status ? message : null);
        var restoring = !!historyCleanupStateRequestId && message.requestId === historyCleanupStateRequestId;
        if (restoring && operation && operation.status === 'cancelled') operation = null;
        if (!operation) {
          if (message.error && (restoring || message.requestId === historyCleanupRequestId)) {
            historyCleanupStateRequestId = '';
            if (historyCleanupHasActiveOperation()) {
              setHistoryCleanupNotice(historyCleanupErrorText(message.error));
              return;
            }
            // A terminal cached result cannot own the next retry after its
            // readonly refresh failed. A confirmed live operation still can.
            historyCleanupOperation = null;
            historyCleanupSubmitting = false;
            historyCleanupPreview = null;
            historyCleanupAwaitingReady = false;
            historyCleanupAwaitingProtection = false;
            if (restoring && message.allowPreview === true) {
              resetHistoryCleanupForm();
              historyCleanupRecordNotice = t('historyCleanupSavedStateNotice', { reason: historyCleanupErrorText(message.error) });
              setHistoryCleanupNotice(historyCleanupRecordNotice);
              requestHistoryCleanupPreview();
              return;
            }
            historyCleanupRetryState = restoring;
            setHistoryCleanupReadonly(restoring);
            if (historyCleanupSummary) historyCleanupSummary.textContent = historyCleanupErrorText(message.error);
            if (historyCleanupSubmitBtn) { historyCleanupSubmitBtn.disabled = true; historyCleanupSubmitBtn.classList.remove('hidden'); }
            if (historyCleanupAgainBtn) historyCleanupAgainBtn.classList.add('hidden');
            if (historyCleanupRetryBtn) { historyCleanupRetryBtn.classList.remove('hidden'); historyCleanupRetryBtn.textContent = t(restoring ? 'historyCleanupRetryState' : 'historyCleanupRetry'); }
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
        requestHistoryCleanupState();
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
      if (historyCleanupRetryBtn) historyCleanupRetryBtn.addEventListener('click', retryHistoryCleanup);
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
