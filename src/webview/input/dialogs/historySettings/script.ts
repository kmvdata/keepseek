import type { WebviewFragment } from '../../composition';

export const historySettingsDeclarationFragment: WebviewFragment = {
  id: 'dialogs.history-settings.declaration',
  source: `
      var historySettingsOverlay = document.getElementById('historySettingsDialogOverlay');
      var historyRetentionDaysInput = document.getElementById('historyRetentionDaysInput');
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

`.slice(1)
};

export const historySettingsOpenFragment: WebviewFragment = {
  id: 'dialogs.history-settings.open',
  source: `
      function showHistorySettingsDialog(settings) {
        if (!historySettingsOverlay) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        if (historyRetentionDaysInput) {
          historyRetentionDaysInput.value = String(normalizeIntegerInRange(values.historyRetentionDays, 1, maxHistoryRetentionDays, defaultHistoryRetentionDays));
        }
        historySettingsOverlay.classList.remove('hidden');
        if (historyRetentionDaysInput) {
          historyRetentionDaysInput.focus();
          historyRetentionDaysInput.select();
        }
      }

`.slice(1)
};

export const dialogIntegerNormalizerFragment: WebviewFragment = {
  id: 'dialogs.integer-normalizer',
  source: `
      function normalizeIntegerInRange(value, min, max, fallback) {
        var number = Number(value);
        if (!Number.isFinite(number)) {
          return fallback;
        }
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
        promptInput.focus();
      }

`.slice(1)
};

export const historySettingsSaveBindingFragment: WebviewFragment = {
  id: 'dialogs.history-settings.save-binding',
  source: `
      if (historySettingsSaveBtn) {
        historySettingsSaveBtn.addEventListener('click', function() {
          var historyRetentionDays = normalizeIntegerInRange(
            historyRetentionDaysInput ? historyRetentionDaysInput.value : defaultHistoryRetentionDays,
            1,
            maxHistoryRetentionDays,
            defaultHistoryRetentionDays
          );
          if (historyRetentionDaysInput) {
            historyRetentionDaysInput.value = String(historyRetentionDays);
          }
          vscode.postMessage({
            type: 'saveHistorySettings',
            historyRetentionDays: historyRetentionDays
          });
          setComposerStatus(t('historySettingsSaved'));
          hideHistorySettingsDialog();
        });
      }

`.slice(1)
};

export const historySettingsCancelBindingFragment: WebviewFragment = {
  id: 'dialogs.history-settings.cancel-binding',
  source: `
      if (historySettingsCancelBtn) {
        historySettingsCancelBtn.addEventListener('click', function() {
          hideHistorySettingsDialog();
        });
      }

`.slice(1)
};

export const historySettingsOverlayBindingsFragment: WebviewFragment = {
  id: 'dialogs.history-settings.overlay-bindings',
  source: `
      if (historySettingsOverlay) {
        historySettingsOverlay.addEventListener('click', function(event) {
          if (event.target === historySettingsOverlay) {
            hideHistorySettingsDialog();
          }
        });

        historySettingsOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideHistorySettingsDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (historySettingsSaveBtn) { historySettingsSaveBtn.click(); }
          }
        });
      }

`.slice(1)
};

