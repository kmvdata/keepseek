import type { WebviewFragment } from '../../composition';

export const accountSettingsDeclarationFragment: WebviewFragment = {
  id: 'dialogs.account-settings.declaration',
  source: `
      var settingsOverlay = document.getElementById('settingsDialogOverlay');
      var settingsDialog = settingsOverlay ? settingsOverlay.querySelector('.settings-dialog') : null;
      var settingsDialogTitle = document.getElementById('settingsDialogTitle');
      var settingsDialogDesc = document.getElementById('settingsDialogDesc');
      var settingsDialogStatus = document.getElementById('settingsDialogStatus');
      var settingsAccountSidebar = settingsOverlay ? settingsOverlay.querySelector('.settings-account-sidebar') : null;
      var settingsAccountEditor = document.getElementById('settingsAccountEditor');
      var settingsAccountsTitle = document.getElementById('settingsAccountsTitle');
      var settingsCreateAccountBtn = document.getElementById('settingsCreateAccountBtn');
      var settingsAccountList = document.getElementById('settingsAccountList');
      var settingsAccountEmpty = document.getElementById('settingsAccountEmpty');
      var settingsCurrentAccountTitle = document.getElementById('settingsCurrentAccountTitle');
      var settingsCurrentProvider = document.getElementById('settingsCurrentProvider');
      var settingsDeleteAccountBtn = document.getElementById('settingsDeleteAccountBtn');
      var settingsAccountEditorEmpty = document.getElementById('settingsAccountEditorEmpty');
      var settingsAccountFields = document.getElementById('settingsAccountFields');
      var settingsAccountNameLabel = document.getElementById('settingsAccountNameLabel');
      var settingsAccountName = document.getElementById('settingsAccountName');
      var settingsApiKey = document.getElementById('settingsApiKey');
      var settingsApiKeyVisibilityBtn = document.getElementById('settingsApiKeyVisibilityBtn');
      var settingsBaseUrl = document.getElementById('settingsBaseUrl');
      var settingsModelsTitle = document.getElementById('settingsModelsTitle');
      var settingsModelsHint = document.getElementById('settingsModelsHint');
      var settingsRefreshModelsBtn = document.getElementById('settingsRefreshModelsBtn');
      var settingsModelList = document.getElementById('settingsModelList');
      var settingsModelEmpty = document.getElementById('settingsModelEmpty');
      var settingsManualModelIdLabel = document.getElementById('settingsManualModelIdLabel');
      var settingsManualModelId = document.getElementById('settingsManualModelId');
      var settingsManualContextWindowLabel = document.getElementById('settingsManualContextWindowLabel');
      var settingsManualContextWindow = document.getElementById('settingsManualContextWindow');
      var settingsManualMaxOutputLabel = document.getElementById('settingsManualMaxOutputLabel');
      var settingsManualMaxOutput = document.getElementById('settingsManualMaxOutput');
      var settingsAddModelBtn = document.getElementById('settingsAddModelBtn');
      var settingsConfirmAddModelBtn = document.getElementById('settingsConfirmAddModelBtn');
      var settingsManualModelBox = document.querySelector('.settings-manual-model');
`.slice(1)
};

export const accountSettingsButtonsFragment: WebviewFragment = {
  id: 'dialogs.account-settings.buttons',
  source: `
      var settingsSaveBtn = document.getElementById('settingsSaveBtn');
      var settingsCancelBtn = document.getElementById('settingsCancelBtn');
`.slice(1)
};

export const accountSettingsStateFragment: WebviewFragment = {
  id: 'dialogs.account-settings.state',
  source: `
      var apiKeyVisible = false;
      var settingsSources = [];
      var settingsSelectedSourceId = '';
      var settingsDialogBusyAction = '';
      var settingsDialogBusyTimer = null;
      var settingsDialogDirty = false;
      var settingsSaveCompleted = false;
      var settingsDefaultModelSelection = null;
      var settingsOriginalFormSignature = '';
      var settingsRunBusyStatusVisible = false;
`.slice(1)
};

export const accountSettingsHelpersFragment: WebviewFragment = {
  id: 'dialogs.account-settings.helpers',
  source: `
      function setApiKeyVisible(isVisible, shouldFocus) {
        apiKeyVisible = Boolean(isVisible);
        if (settingsApiKey) {
          var selectionStart = settingsApiKey.selectionStart;
          var selectionEnd = settingsApiKey.selectionEnd;
          settingsApiKey.type = apiKeyVisible ? 'text' : 'password';
          if (shouldFocus) {
            settingsApiKey.focus();
            if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
              settingsApiKey.setSelectionRange(selectionStart, selectionEnd);
            }
          }
        }
        if (settingsApiKeyVisibilityBtn) {
          var label = apiKeyVisible ? t('hideApiKey') : t('showApiKey');
          settingsApiKeyVisibilityBtn.classList.toggle('is-visible', apiKeyVisible);
          settingsApiKeyVisibilityBtn.setAttribute('aria-pressed', apiKeyVisible ? 'true' : 'false');
          settingsApiKeyVisibilityBtn.setAttribute('aria-label', label);
          settingsApiKeyVisibilityBtn.title = label;
        }
      }

      function readSettingsString(value, fallback) {
        return typeof value === 'string' ? value : fallback;
      }

      function readOptionalCapabilityInput(input, max) {
        var raw = input ? input.value.trim() : '';
        if (!raw) { return undefined; }
        var value = Number(raw);
        return Number.isInteger(value) && value > 0 && value <= max ? value : null;
      }

      function readOptionalContextWindowKTokens(input) {
        var raw = input ? input.value.trim() : '';
        if (!raw) { return undefined; }
        var kiloTokens = Number(raw);
        if (!Number.isFinite(kiloTokens) || kiloTokens <= 0 || kiloTokens > 10000) {
          return null;
        }
        var binaryKVariants = [8, 16, 32, 64];
        var tokens = Number.isInteger(kiloTokens) && binaryKVariants.indexOf(kiloTokens) >= 0
          ? kiloTokens * 1024
          : Math.round(kiloTokens * 1000);
        return tokens > 0 && tokens <= 10000000 ? tokens : null;
      }

      function getEditableContextWindowKTokens(tokens) {
        var tokenCount = Math.max(1, Math.round(Number(tokens) || 0));
        var binaryKVariants = [8192, 16384, 32768, 65536];
        var kiloTokens = binaryKVariants.indexOf(tokenCount) >= 0
          ? tokenCount / 1024
          : tokenCount / 1000;
        return String(Math.round(kiloTokens * 1000) / 1000);
      }

      function formatContextWindowTokens(tokens) {
        var tokenCount = Math.max(1, Math.round(Number(tokens) || 0));
        if (tokenCount === 1048576) { return '1M tokens'; }
        if (tokenCount >= 1000000) {
          var millions = Math.round((tokenCount / 1000000) * 1000) / 1000;
          return millions.toLocaleString() + 'M tokens';
        }
        var binaryKVariants = [8192, 16384, 32768, 65536];
        if (binaryKVariants.indexOf(tokenCount) >= 0) {
          return String(tokenCount / 1024) + 'K tokens';
        }
        if (tokenCount >= 1000) {
          var thousands = Math.round((tokenCount / 1000) * 1000) / 1000;
          return thousands.toLocaleString() + 'K tokens';
        }
        return tokenCount.toLocaleString() + ' tokens';
      }

      function normalizeSettingsProvider(value) {
        return value === 'kimi' || value === 'glm' || value === 'qwencloud' || value === 'ollama' || value === 'openai-compatible' || value === 'openai-responses' || value === 'anthropic-compatible'
          ? value
          : 'deepseek';
      }

      function getSettingsProviderLabel(provider) {
        return provider === 'anthropic-compatible' ? t('anthropicMessagesCompatible')
          : provider === 'openai-responses' ? t('openAiResponsesCompatible')
          : provider === 'kimi' ? t('kimiOfficial')
          : provider === 'glm' ? t('glmOfficial')
          : provider === 'qwencloud' ? t('qwenCloud')
          : provider === 'openai-compatible' ? 'OpenAI compatible'
          : provider === 'ollama' ? 'Ollama'
          : 'DeepSeek';
      }

      function getModelProtocolLogoUri(provider) {
        return readSettingsString(modelProtocolLogoUris[normalizeSettingsProvider(provider)], '');
      }

      function getSettingsProviderLogoUri(provider) {
        return getModelProtocolLogoUri(provider);
      }

      function getSettingsDefaultBaseUrl(provider) {
        return provider === 'deepseek' ? 'https://api.deepseek.com'
          : provider === 'kimi' ? 'https://api.moonshot.cn/v1'
          : provider === 'glm' ? 'https://open.bigmodel.cn/api/paas/v4'
          : provider === 'qwencloud' ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          : provider === 'ollama' ? 'http://localhost:11434/v1'
          : provider === 'openai-responses' ? 'https://api.openai.com/v1'
          : provider === 'anthropic-compatible' ? 'https://api.anthropic.com/v1'
          : '';
      }

      function normalizeSettingsSource(rawSource, index) {
        if (!rawSource || typeof rawSource !== 'object') { return null; }
        var id = readSettingsString(rawSource.id, '').trim();
        if (!id) { return null; }
        var provider = normalizeSettingsProvider(rawSource.provider);
        var explicitModels = Array.isArray(rawSource.models) ? rawSource.models : [];
        var explicitModelIds = explicitModels.map(function(model) {
          return typeof model === 'string' ? model.trim() : readSettingsString(model.id, '').trim();
        }).filter(Boolean);
        var disabledModelIds = (Array.isArray(rawSource.disabledModelIds) ? rawSource.disabledModelIds : [])
          .map(function(modelId) { return readSettingsString(modelId, '').trim(); })
          .filter(function(modelId, modelIndex, modelIds) {
            return Boolean(modelId) && modelIds.indexOf(modelId) === modelIndex;
          });
        return {
          id: id,
          name: readSettingsString(rawSource.name, '').trim() || getSettingsProviderLabel(provider),
          provider: provider,
          apiKey: readSettingsString(rawSource.apiKey, ''),
          baseUrl: readSettingsString(rawSource.baseUrl, ''),
          modelCache: rawSource.modelCache && typeof rawSource.modelCache === 'object' ? rawSource.modelCache : null,
          models: Array.isArray(rawSource.availableModels) ? rawSource.availableModels : explicitModels,
          manualModelIds: explicitModelIds,
          disabledModelIds: disabledModelIds,
          enabled: rawSource.enabled !== false,
          isOfficialDeepSeek: rawSource.isOfficialDeepSeek === true,
          sortIndex: index
        };
      }

      function getSettingsActiveAccount() {
        for (var i = 0; i < settingsSources.length; i++) {
          if (settingsSources[i].id === settingsSelectedSourceId) {
            return settingsSources[i];
          }
        }
        return null;
      }

      function getSettingsAccountModels(account) {
        if (!account) { return []; }
        var modelsById = {};
        var modelOrder = [];
        function addModel(rawModel) {
          var source = typeof rawModel === 'string' ? { id: rawModel } : rawModel;
          if (!source || typeof source !== 'object') { return; }
          var id = readSettingsString(source.id, '').trim();
          if (!id) { return; }
          if (!modelsById[id]) {
            modelsById[id] = { id: id, fetchedName: '', label: '' };
            modelOrder.push(id);
          }
          var model = modelsById[id];
          model.fetchedName = readSettingsString(source.fetchedName || source.name, model.fetchedName);
          model.label = readSettingsString(source.label, model.label);
          if (Number.isInteger(source.contextWindowTokens) && source.contextWindowTokens > 0) {
            model.contextWindowTokens = source.contextWindowTokens;
          }
          if (source.contextWindowSource === 'manual'
            || source.contextWindowSource === 'discovered'
            || source.contextWindowSource === 'built-in'
            || source.contextWindowSource === 'guessed'
            || source.contextWindowSource === 'fallback') {
            model.contextWindowSource = source.contextWindowSource;
          }
          if (Number.isInteger(source.maxOutputTokens) && source.maxOutputTokens > 0) {
            model.maxOutputTokens = source.maxOutputTokens;
          }
          if (source.maxOutputSource === 'manual'
            || source.maxOutputSource === 'discovered'
            || source.maxOutputSource === 'built-in'
            || source.maxOutputSource === 'guessed'
            || source.maxOutputSource === 'fallback') {
            model.maxOutputSource = source.maxOutputSource;
          }
          if (source.agentCompatible === false) {
            model.agentCompatible = false;
          }
          if (source.nonTextModelKind === 'image-generation'
            || source.nonTextModelKind === 'speech-synthesis') {
            model.nonTextModelKind = source.nonTextModelKind;
          }
        }
        var cachedModels = account.modelCache && Array.isArray(account.modelCache.models)
          ? account.modelCache.models
          : [];
        cachedModels.forEach(addModel);
        account.models.forEach(addModel);
        if (Array.isArray(state.models)) {
          state.models.forEach(function(model) {
            if (!model || typeof model !== 'object') { return; }
            if (model.sourceId !== account.id) { return; }
            addModel(model);
          });
        }
        var disabledModelIds = Array.isArray(account.disabledModelIds) ? account.disabledModelIds : [];
        return modelOrder.map(function(modelId) {
          var model = modelsById[modelId];
          model.enabled = model.agentCompatible !== false && disabledModelIds.indexOf(modelId) < 0;
          return model;
        });
      }

      function getSettingsFormSignature() {
        return JSON.stringify({
          name: settingsAccountName ? settingsAccountName.value.trim() : '',
          apiKey: settingsApiKey ? settingsApiKey.value.trim() : '',
          baseUrl: settingsBaseUrl ? settingsBaseUrl.value.trim() : ''
        });
      }

      function updateSettingsDialogDirtyState() {
        settingsDialogDirty = getSettingsFormSignature() !== settingsOriginalFormSignature;
      }

      function blockSettingsActionForUnsavedChanges() {
        updateSettingsDialogDirtyState();
        if (!settingsDialogDirty) { return false; }
        setSettingsDialogStatus(t('modelSourceUnsavedChanges'));
        if (settingsSaveBtn) {
          settingsSaveBtn.focus();
        }
        return true;
      }

      function setSettingsDialogStatus(message) {
        if (!settingsDialogStatus) { return; }
        settingsDialogStatus.textContent = message || '';
        settingsDialogStatus.classList.toggle('hidden', !message);
      }

      function blockAccountSettingsWhileRunBusy() {
        if (!state.isBusy && !isModelSelectionLocked()) { return false; }
        settingsRunBusyStatusVisible = true;
        setSettingsDialogStatus(t(isModelSelectionLocked()
          ? 'modelSelectionLockedByBackground'
          : 'modelSettingsReadonlyWhileBusy'));
        if (settingsDialogStatus) { settingsDialogStatus.focus(); }
        return true;
      }

      function syncAccountSettingsRunBusyStatus(runBusy, operationBusy) {
        if (runBusy && !operationBusy) {
          settingsRunBusyStatusVisible = true;
          setSettingsDialogStatus(t(isModelSelectionLocked()
            ? 'modelSelectionLockedByBackground'
            : 'modelSettingsReadonlyWhileBusy'));
          return;
        }
        if (settingsRunBusyStatusVisible) {
          settingsRunBusyStatusVisible = false;
          setSettingsDialogStatus('');
        }
      }

      function clearSettingsDialogBusy() {
        settingsDialogBusyAction = '';
        if (settingsDialogBusyTimer) {
          clearTimeout(settingsDialogBusyTimer);
          settingsDialogBusyTimer = null;
        }
      }

      function beginSettingsDialogAction(action, statusMessage) {
        clearSettingsDialogBusy();
        settingsDialogBusyAction = action;
        settingsRunBusyStatusVisible = false;
        setSettingsDialogStatus(statusMessage);
        renderAccountSettings();
        if (settingsDialogStatus) { settingsDialogStatus.focus(); }
        settingsDialogBusyTimer = setTimeout(function() {
          settingsDialogBusyTimer = null;
          setSettingsDialogStatus(t('modelOperationStillPending'));
        }, 15000);
      }

`.slice(1)
};

export const accountSettingsOpenFragment: WebviewFragment = {
  id: 'dialogs.account-settings.open',
  source: `
      function showSettingsDialog(settings) {
        if (!settingsOverlay || !settingsApiKey || !settingsBaseUrl) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        var rawSources = Array.isArray(values.sources) ? values.sources : [];
        settingsDefaultModelSelection = values.defaultModelSelection || null;
        settingsSources = rawSources.map(normalizeSettingsSource).filter(Boolean);
        var requestedSourceId = readSettingsString(values.selectedSourceId, '').trim();
        if (settingsOverlay.classList.contains('hidden')) {
          settingsSelectedSourceId = settingsSources.some(function(source) { return source.id === requestedSourceId; })
            ? requestedSourceId
            : settingsSources.length ? settingsSources[0].id : '';
        } else if (!settingsSources.some(function(source) { return source.id === settingsSelectedSourceId; })) {
          if (settingsSources.length) { settingsSelectedSourceId = settingsSources[0].id; }
        }
        clearSettingsDialogBusy();
        settingsSaveCompleted = values.settingsSaved === true;
        if (values.defaultModelPending) { settingsDialogBusyAction = 'set-default-model'; }
        settingsRunBusyStatusVisible = false;
        setSettingsDialogStatus('');
        populateSettingsAccount(getSettingsActiveAccount());
        if (settingsModelList) { settingsModelList.innerHTML = ''; }
        setApiKeyVisible(false, false);
        renderAccountSettings();
        settingsOverlay.classList.remove('hidden');
        if (state.isBusy && settingsDialogStatus) {
          settingsDialogStatus.focus();
        } else if (settingsAccountName && getSettingsActiveAccount()) {
          settingsAccountName.focus();
          settingsAccountName.select();
        } else if (settingsCreateAccountBtn) {
          settingsCreateAccountBtn.focus();
        }
      }

`.slice(1)
};

export const accountSettingsCloseFragment: WebviewFragment = {
  id: 'dialogs.account-settings.close',
  source: `
      function hideSettingsDialog() {
        if (!settingsOverlay) { return; }
        if (settingsDialogBusyAction) {
          setSettingsDialogStatus(t('modelOperationStillPending'));
          return;
        }
        clearSettingsDialogBusy();
        settingsSaveCompleted = false;
        settingsRunBusyStatusVisible = false;
        setSettingsDialogStatus('');
        settingsOverlay.classList.add('hidden');
        promptInput.focus();
      }

      function trapSettingsDialogFocus(event) {
        if (!settingsDialog || event.key !== 'Tab') { return; }
        var controls = Array.from(settingsDialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (!controls.length) { return; }
        var first = controls[0];
        var last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !settingsDialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

`.slice(1)
};

export const accountSettingsBindingsFragment: WebviewFragment = {
  id: 'dialogs.account-settings.bindings',
  source: `

      if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', function() {
          if (settingsSaveCompleted && !settingsDialogBusyAction) {
            hideSettingsDialog();
            return;
          }
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (settingsDialogBusyAction) { return; }
          var name = settingsAccountName ? settingsAccountName.value.trim() : '';
          var apiKey = settingsApiKey ? settingsApiKey.value.trim() : '';
          var baseUrl = settingsBaseUrl ? settingsBaseUrl.value.trim() : '';
          var provider = source ? source.provider : 'deepseek';
          var modelId = settingsManualModelId ? settingsManualModelId.value.trim() : '';
          if (!name) {
            setSettingsDialogStatus(t('modelSourceNameRequired'));
            if (settingsAccountName) { settingsAccountName.focus(); }
            return;
          }
          var duplicateName = settingsSources.some(function(candidate) {
            return candidate.id !== (source ? source.id : '')
              && candidate.name.trim().toLowerCase() === name.toLowerCase();
          });
          if (duplicateName) {
            setSettingsDialogStatus(t('modelSourceNameDuplicate'));
            if (settingsAccountName) { settingsAccountName.focus(); }
            return;
          }
          if (!baseUrl) { baseUrl = getSettingsDefaultBaseUrl(provider); }
          if (!baseUrl) {
            setSettingsDialogStatus(t('baseUrlRequired'));
            if (settingsBaseUrl) { settingsBaseUrl.focus(); }
            return;
          }
          if (source) {
            vscode.postMessage({
              type: 'saveModelSource',
              sourceId: source.id,
              name: name,
              apiKey: apiKey,
              baseUrl: baseUrl
            });
            beginSettingsDialogAction('save-source', t('savingModelSource'));
          } else {
            vscode.postMessage({
              type: 'addModel',
              provider: provider,
              name: name,
              apiKey: apiKey,
              baseUrl: baseUrl,
              modelId: modelId
            });
            beginSettingsDialogAction('add-model', t('savingModelSource'));
          }
        });
      }

      if (settingsAccountList) {
        settingsAccountList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-source-id]');
          if (!button || blockAccountSettingsWhileRunBusy() || settingsDialogBusyAction) { return; }
          var sourceId = button.dataset.sourceId || '';
          if (!sourceId || sourceId === settingsSelectedSourceId) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          settingsSelectedSourceId = sourceId;
          settingsSaveCompleted = false;
          populateSettingsAccount(getSettingsActiveAccount());
          if (settingsModelList) { settingsModelList.innerHTML = ''; }
          renderAccountSettings();
        });
      }

      if (settingsCreateAccountBtn) {
        settingsCreateAccountBtn.addEventListener('click', function() {
          if (blockAccountSettingsWhileRunBusy() || settingsDialogBusyAction) { return; }
          if (getSettingsActiveAccount() && blockSettingsActionForUnsavedChanges()) { return; }
          if (window.keepseekNewAccountDialog && typeof window.keepseekNewAccountDialog.open === 'function') {
            window.keepseekNewAccountDialog.open();
          }
        });
      }

      if (settingsDeleteAccountBtn) {
        settingsDeleteAccountBtn.addEventListener('click', function() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          vscode.postMessage({ type: 'deleteModelSource', sourceId: source.id });
          beginSettingsDialogAction('delete', t('deleteConfirmationInVsCode'));
        });
      }

      if (settingsRefreshModelsBtn) {
        settingsRefreshModelsBtn.addEventListener('click', function() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          vscode.postMessage({ type: 'refreshSourceModels', sourceId: source.id });
          beginSettingsDialogAction('refresh-models', t('refreshingModels'));
        });
      }

      if (settingsAddModelBtn) {
        settingsAddModelBtn.addEventListener('click', function() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          if (settingsManualModelBox) { settingsManualModelBox.classList.remove('hidden'); }
          if (settingsManualModelId) {
            settingsManualModelId.focus();
            settingsManualModelId.select();
          }
        });
      }

      if (settingsConfirmAddModelBtn) {
        settingsConfirmAddModelBtn.addEventListener('click', function() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          var modelId = settingsManualModelId ? settingsManualModelId.value.trim() : '';
          if (!modelId) {
            setSettingsDialogStatus(t('manualModelIdRequired'));
            if (settingsManualModelId) { settingsManualModelId.focus(); }
            return;
          }
          var contextWindowTokens = readOptionalContextWindowKTokens(settingsManualContextWindow);
          var maxOutputTokens = readOptionalCapabilityInput(settingsManualMaxOutput, 1048576);
          if (contextWindowTokens === null || maxOutputTokens === null) {
            setSettingsDialogStatus(t('manualModelCapabilityInvalid'));
            (contextWindowTokens === null ? settingsManualContextWindow : settingsManualMaxOutput)?.focus();
            return;
          }
          vscode.postMessage({
            type: 'addModel',
            sourceId: source.id,
            provider: source.provider,
            apiKey: source.apiKey,
            baseUrl: source.baseUrl,
            modelId: modelId,
            contextWindowTokens: contextWindowTokens,
            maxOutputTokens: maxOutputTokens
          });
          if (settingsManualModelBox) { settingsManualModelBox.classList.add('hidden'); }
          beginSettingsDialogAction('add-model', t('savingModelSource'));
        });
      }

      [settingsManualModelId, settingsManualContextWindow, settingsManualMaxOutput].forEach(function(input) {
        if (!input) { return; }
        input.addEventListener('keydown', function(event) {
          if (event.key !== 'Enter' || event.metaKey || event.ctrlKey) { return; }
          event.preventDefault();
          if (settingsConfirmAddModelBtn) { settingsConfirmAddModelBtn.click(); }
        });
      });

      [settingsAccountName, settingsApiKey, settingsBaseUrl].forEach(function(input) {
        if (!input) { return; }
        input.addEventListener('input', function() {
          settingsSaveCompleted = false;
          updateSettingsDialogDirtyState();
          if (!settingsDialogBusyAction) {
            setSettingsDialogStatus('');
          }
        });
      });

`.slice(1)
};

export const accountSettingsCancelBindingFragment: WebviewFragment = {
  id: 'dialogs.account-settings.cancel-binding',
  source: `
      if (settingsCancelBtn) {
        settingsCancelBtn.addEventListener('click', function() {
          hideSettingsDialog();
        });
      }

`.slice(1)
};

export const accountSettingsOverlayBindingsFragment: WebviewFragment = {
  id: 'dialogs.account-settings.overlay-bindings',
  source: `
      if (settingsApiKeyVisibilityBtn) {
        settingsApiKeyVisibilityBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (blockAccountSettingsWhileRunBusy()) { return; }
          setApiKeyVisible(!apiKeyVisible, true);
        });
      }

      if (settingsOverlay) {
        settingsOverlay.addEventListener('click', function(event) {
          if (event.target === settingsOverlay) {
            hideSettingsDialog();
          }
        });

        settingsOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideSettingsDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (settingsSaveBtn) { settingsSaveBtn.click(); }
          } else {
            trapSettingsDialogFocus(event);
          }
        });
      }

`.slice(1)
};

