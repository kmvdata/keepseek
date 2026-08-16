/**
 * 独立"添加账号"对话框。
 *
 * 与账号管理对话框（settingsDialogOverlay）完全解耦：
 * - 自己的 HTML 模板（getNewAccountDialogTemplate）
 * - 自己的 CSS（getNewAccountDialogStyles，类名前缀 new-account-*）
 * - 自己的脚本（getNewAccountDialogScript，独立 IIFE，自带状态/事件/消息监听）
 *
 * 对外只暴露 window.keepseekNewAccountDialog.open()，由账号管理对话框的
 * "添加账号"按钮调用。保存走 addModel 消息（复用 Provider 的账号创建能力），
 * 测试连接走 testSourceConnection 消息，结果通过 sourceConnectionTestResult
 * 回传后由本对话框自己监听处理；保存走 addModel 消息，结果通过
 * addModelResult 回传：新建成功时关闭，复用已有账号或保存失败时保持
 * 打开并展示提示。
 */

export function getNewAccountDialogTemplate(): string {
  return `
    <div id="newAccountDialogOverlay" class="new-account-dialog-overlay hidden">
      <div class="new-account-dialog" role="dialog" aria-modal="true" aria-label="添加账号" data-i18n-aria-label="newAccountDialogLabel">
        <div class="new-account-dialog-header">
          <span class="new-account-dialog-title" data-i18n="newAccountDialogTitle">添加账号</span>
        </div>
        <div class="new-account-dialog-body">
          <p class="new-account-dialog-desc" data-i18n="newAccountDialogDesc">填写服务商、API Key 与 Base URL；保存后账号与第一个模型会一起创建。</p>
          <div id="newAccountDialogStatus" class="new-account-dialog-status hidden" role="status" aria-live="polite" tabindex="-1"></div>
          <label class="new-account-field">
            <span class="new-account-field-label" data-i18n="modelProviderLabel">模型服务商</span>
            <select id="newAccountProvider" class="new-account-input" aria-label="模型服务商" data-i18n-aria-label="modelProviderLabel">
              <option value="deepseek">DeepSeek</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI compatible</option>
            </select>
          </label>
          <label class="new-account-field">
            <span class="new-account-field-label" data-i18n="modelSourceName">账号名称</span>
            <input id="newAccountName" class="new-account-input" type="text" autocomplete="off" />
          </label>
          <div class="new-account-field">
            <span class="new-account-field-label">API Key</span>
            <div class="new-account-secret">
              <input id="newAccountApiKey" class="new-account-input" type="password" placeholder="sk-..." autocomplete="off" />
              <button
                id="newAccountApiKeyVisibilityBtn"
                class="new-account-secret-toggle"
                type="button"
                aria-label="显示 API Key"
                aria-pressed="false"
                title="显示 API Key"
                data-i18n-title="showApiKey"
                data-i18n-aria-label="showApiKey"
              >
                <svg class="new-account-secret-icon new-account-secret-icon-show" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.75 8s2.25-4 6.25-4 6.25 4 6.25 4-2.25 4-6.25 4S1.75 8 1.75 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                  <circle cx="8" cy="8" r="1.75" fill="none" stroke="currentColor" stroke-width="1.3"/>
                </svg>
                <svg class="new-account-secret-icon new-account-secret-icon-hide" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.25 2.25l11.5 11.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M6.55 4.28A6.7 6.7 0 0 1 8 4c4 0 6.25 4 6.25 4a10.7 10.7 0 0 1-1.67 2.08M9.42 11.82A6.7 6.7 0 0 1 8 12c-4 0-6.25-4-6.25-4a10.2 10.2 0 0 1 2.8-3.01" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
          <label class="new-account-field">
            <span class="new-account-field-label">Base URL</span>
            <input id="newAccountBaseUrl" class="new-account-input" type="text" placeholder="https://api.deepseek.com" autocomplete="off" />
          </label>
        </div>
        <div class="new-account-dialog-footer">
          <button id="newAccountTestBtn" type="button" class="new-account-btn secondary" data-i18n="testConnection">测试连接</button>
          <button id="newAccountCancelBtn" type="button" class="new-account-btn secondary" data-i18n="cancel">取消</button>
          <button id="newAccountSaveBtn" type="button" class="new-account-btn primary" data-i18n="newAccountSave">添加</button>
        </div>
      </div>
    </div>`;
}

export function getNewAccountDialogStyles(): string {
  return `
    .new-account-dialog-overlay {
      position: fixed;
      inset: 0;
      z-index: 120;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }

    .new-account-dialog {
      width: min(420px, calc(100vw - var(--keepseek-edge-padding-double, 8px)));
      max-height: min(720px, calc(100vh - 24px));
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 10px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 12px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }

    .new-account-dialog-header {
      display: flex;
      align-items: center;
      padding: 14px 16px 0;
    }

    .new-account-dialog-title {
      font-size: 14px;
      font-weight: 600;
    }

    .new-account-dialog-body {
      padding: 10px 16px 16px;
      overflow-y: auto;
    }

    .new-account-dialog-desc {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

    .new-account-dialog-status {
      margin: -4px 0 12px;
      padding: 7px 9px;
      border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-infoBackground, var(--vscode-textBlockQuote-background));
      font-size: 11px;
      line-height: 1.35;
    }

    .new-account-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0 0 12px;
    }

    .new-account-field-label {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .new-account-input {
      padding: 5px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-size: 12px;
      line-height: 1.4;
    }

    .new-account-input:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .new-account-input:disabled {
      opacity: 0.55;
    }

    .new-account-field-hint {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.35;
    }

    .new-account-secret {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .new-account-secret .new-account-input {
      flex: 1 1 auto;
      min-width: 0;
    }

    .new-account-secret-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      flex: 0 0 auto;
      border: 1px solid transparent;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }

    .new-account-secret-toggle:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));
    }

    .new-account-secret-icon-hide {
      display: none;
    }

    .new-account-secret-toggle.is-visible .new-account-secret-icon-show {
      display: none;
    }

    .new-account-secret-toggle.is-visible .new-account-secret-icon-hide {
      display: inline;
    }

    .new-account-dialog-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
      padding: 0 16px 16px;
    }

    .new-account-btn {
      padding: 5px 12px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
      cursor: pointer;
    }

    .new-account-btn.secondary {
      border: 1px solid var(--vscode-button-secondaryBorder, var(--vscode-panel-border));
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .new-account-btn.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .new-account-btn.primary {
      border: 1px solid transparent;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .new-account-btn.primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .new-account-btn:disabled {
      opacity: 0.55;
      cursor: default;
    }`;
}

export function getNewAccountDialogScript(): string {
  return `
    (function setupNewAccountDialog() {
      var overlay = document.getElementById('newAccountDialogOverlay');
      var dialog = overlay ? overlay.querySelector('.new-account-dialog') : null;
      var statusEl = document.getElementById('newAccountDialogStatus');
      var providerSelect = document.getElementById('newAccountProvider');
      var nameInput = document.getElementById('newAccountName');
      var apiKeyInput = document.getElementById('newAccountApiKey');
      var apiKeyVisibilityBtn = document.getElementById('newAccountApiKeyVisibilityBtn');
      var baseUrlInput = document.getElementById('newAccountBaseUrl');
      var testBtn = document.getElementById('newAccountTestBtn');
      var cancelBtn = document.getElementById('newAccountCancelBtn');
      var saveBtn = document.getElementById('newAccountSaveBtn');
      var busyAction = '';
      var busyTimer = null;
      var apiKeyVisible = false;

      function normalizeProvider(value) {
        return value === 'ollama' || value === 'openai-compatible' ? value : 'deepseek';
      }

      function setStatus(message) {
        if (!statusEl) { return; }
        statusEl.textContent = message || '';
        statusEl.classList.toggle('hidden', !message);
      }

      function clearBusy() {
        busyAction = '';
        if (busyTimer) {
          clearTimeout(busyTimer);
          busyTimer = null;
        }
      }

      function beginBusy(action, statusMessage) {
        clearBusy();
        busyAction = action;
        setStatus(statusMessage);
        render();
        if (statusEl) { statusEl.focus(); }
        busyTimer = setTimeout(function() {
          busyTimer = null;
          setStatus(t('modelOperationStillPending'));
        }, 15000);
      }

      function render() {
        var busy = Boolean(busyAction);
        [providerSelect, nameInput, apiKeyInput, apiKeyVisibilityBtn, baseUrlInput].forEach(function(control) {
          if (control) { control.disabled = busy; }
        });
        if (testBtn) {
          testBtn.textContent = busyAction === 'test-connection' ? t('testingConnection') : t('testConnection');
          testBtn.disabled = busy;
        }
        if (saveBtn) { saveBtn.disabled = busy; }
        if (cancelBtn) { cancelBtn.disabled = busy; }
        if (dialog) {
          dialog.setAttribute('aria-busy', busy ? 'true' : 'false');
        }
      }

      function setApiKeyVisible(isVisible, shouldFocus) {
        apiKeyVisible = Boolean(isVisible);
        if (apiKeyInput) {
          var selectionStart = apiKeyInput.selectionStart;
          var selectionEnd = apiKeyInput.selectionEnd;
          apiKeyInput.type = apiKeyVisible ? 'text' : 'password';
          if (shouldFocus) {
            apiKeyInput.focus();
            if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
              apiKeyInput.setSelectionRange(selectionStart, selectionEnd);
            }
          }
        }
        if (apiKeyVisibilityBtn) {
          var label = apiKeyVisible ? t('hideApiKey') : t('showApiKey');
          apiKeyVisibilityBtn.classList.toggle('is-visible', apiKeyVisible);
          apiKeyVisibilityBtn.setAttribute('aria-pressed', apiKeyVisible ? 'true' : 'false');
          apiKeyVisibilityBtn.setAttribute('aria-label', label);
          apiKeyVisibilityBtn.title = label;
        }
      }

      function trapFocus(event) {
        if (!dialog || event.key !== 'Tab') { return; }
        var controls = Array.from(dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (!controls.length) { return; }
        var first = controls[0];
        var last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      function open() {
        if (!overlay) { return; }
        clearBusy();
        if (providerSelect) { providerSelect.value = 'deepseek'; }
        if (nameInput) { nameInput.value = ''; }
        if (apiKeyInput) { apiKeyInput.value = ''; }
        if (baseUrlInput) { baseUrlInput.value = 'https://api.deepseek.com'; }
        setApiKeyVisible(false, false);
        setStatus('');
        render();
        overlay.classList.remove('hidden');
        if (nameInput) { nameInput.focus(); }
      }

      function close() {
        if (!overlay) { return; }
        clearBusy();
        setStatus('');
        overlay.classList.add('hidden');
      }

      function testConnection() {
        if (busyAction) { return; }
        var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
        var baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
        var provider = normalizeProvider(providerSelect ? providerSelect.value : 'deepseek');
        if (!baseUrl && provider === 'deepseek') { baseUrl = 'https://api.deepseek.com'; }
        if (!baseUrl && provider === 'ollama') { baseUrl = 'http://localhost:11434/v1'; }
        if (!baseUrl) {
          setStatus(t('baseUrlRequired'));
          if (baseUrlInput) { baseUrlInput.focus(); }
          return;
        }
        vscode.postMessage({
          type: 'testSourceConnection',
          provider: provider,
          apiKey: apiKey,
          baseUrl: baseUrl
        });
        beginBusy('test-connection', t('testingConnection'));
      }

      function submit() {
        if (busyAction) { return; }
        var name = nameInput ? nameInput.value.trim() : '';
        var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';
        var baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
        var provider = normalizeProvider(providerSelect ? providerSelect.value : 'deepseek');
        if (!name) {
          setStatus(t('modelSourceNameRequired'));
          if (nameInput) { nameInput.focus(); }
          return;
        }
        if (!baseUrl && provider === 'deepseek') { baseUrl = 'https://api.deepseek.com'; }
        if (!baseUrl && provider === 'ollama') { baseUrl = 'http://localhost:11434/v1'; }
        if (!baseUrl) {
          setStatus(t('baseUrlRequired'));
          if (baseUrlInput) { baseUrlInput.focus(); }
          return;
        }
        vscode.postMessage({
          type: 'addModel',
          provider: provider,
          name: name,
          apiKey: apiKey,
          baseUrl: baseUrl,
        });
        beginBusy('add-account', t('newAccountSaving'));
      }

      window.addEventListener('message', function(event) {
        var message = event.data;
        if (!message || typeof message !== 'object') { return; }
        if (message.type === 'sourceConnectionTestResult') {
          if (busyAction !== 'test-connection') { return; }
          clearBusy();
          render();
          if (message.ok) {
            setStatus(t('connectionTestSucceeded'));
          } else {
            var reason = typeof message.error === 'string' ? message.error : '';
            setStatus(t('connectionTestFailed', { message: reason || t('connectionTestUnknownReason') }));
          }
        } else if (message.type === 'addModelResult') {
          if (busyAction !== 'add-account') { return; }
          clearBusy();
          if (message.ok) {
            if (message.reusedSource) {
              setStatus(t('newAccountReused'));
              render();
            } else {
              close();
            }
          } else {
            var reason = typeof message.error === 'string' ? message.error : '';
            setStatus(t('modelOperationFailed', { message: reason || t('connectionTestUnknownReason') }));
            render();
          }
        }
      });

      if (providerSelect) {
        providerSelect.addEventListener('change', function() {
          if (busyAction) { return; }
          var selectedProvider = normalizeProvider(providerSelect.value);
          if (baseUrlInput) {
            baseUrlInput.value = selectedProvider === 'deepseek'
              ? 'https://api.deepseek.com'
              : selectedProvider === 'ollama'
                ? 'http://localhost:11434/v1'
                : '';
          }
          if (apiKeyInput && selectedProvider === 'ollama') {
            apiKeyInput.value = '';
          }
          setStatus('');
        });
      }

      if (apiKeyVisibilityBtn) {
        apiKeyVisibilityBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (busyAction) { return; }
          setApiKeyVisible(!apiKeyVisible, true);
        });
      }

      if (testBtn) {
        testBtn.addEventListener('click', function() {
          testConnection();
        });
      }

      if (saveBtn) {
        saveBtn.addEventListener('click', function() {
          submit();
        });
      }

      if (cancelBtn) {
        cancelBtn.addEventListener('click', function() {
          close();
        });
      }

      [nameInput, apiKeyInput, baseUrlInput].forEach(function(input) {
        if (!input) { return; }
        input.addEventListener('input', function() {
          if (!busyAction) { setStatus(''); }
        });
      });

      if (overlay) {
        overlay.addEventListener('click', function(event) {
          if (event.target === overlay) { close(); }
        });
        overlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (saveBtn) { saveBtn.click(); }
          } else {
            trapFocus(event);
          }
        });
      }

      window.keepseekNewAccountDialog = {
        open: open
      };
    })();`;
}
