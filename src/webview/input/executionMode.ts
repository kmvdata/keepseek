import type { WebviewFragment } from './composition';

export const executionModeDeclarationFragment: WebviewFragment = {
  id: 'execution-mode.declaration',
  source: `
      var executionModeButton = document.getElementById('executionModeButton');
      var executionModeButtonLabel = document.getElementById('executionModeButtonLabel');
      var executionModeTooltip = document.getElementById('executionModeTooltip');
      var executionModeTooltipTitle = document.getElementById('executionModeTooltipTitle');
      var executionModeTooltipDescription = document.getElementById('executionModeTooltipDescription');
      var executionModeMenu = document.getElementById('executionModeMenu');
`.slice(1)
};

export const executionModeStateFragment: WebviewFragment = {
  id: 'execution-mode.state',
  source: `
      var executionModeMenuOpen = false;
`.slice(1)
};

export const executionModeBindingsFragment: WebviewFragment = {
  id: 'execution-mode.bindings',
  source: `
      if (executionModeButton) {
        executionModeButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (isExecutionModeSelectionLocked()) {
            setComposerStatus(getExecutionModeLockText());
            return;
          }
          if (executionModeMenuOpen) {
            closeExecutionModeMenu(true);
            return;
          }
          openExecutionModeMenu('selected');
        });

        executionModeButton.addEventListener('keydown', function(event) {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') { return; }
          event.preventDefault();
          if (isExecutionModeSelectionLocked()) {
            setComposerStatus(getExecutionModeLockText());
            return;
          }
          openExecutionModeMenu(event.key === 'ArrowUp' ? 'last' : 'first');
        });
      }

      if (executionModeMenu) {
        executionModeMenu.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-execution-mode]');
          if (!button || button.disabled) { return; }
          event.preventDefault();
          event.stopPropagation();
          var mode = button.dataset.executionMode === 'plan' ? 'plan' : 'normal';
          vscode.postMessage({ type: 'setExecutionMode', mode: mode });
          closeExecutionModeMenu(true);
        });

        executionModeMenu.addEventListener('keydown', function(event) {
          var options = getExecutionModeOptions();
          if (!options.length) { return; }
          var activeIndex = options.indexOf(document.activeElement);
          if (event.key === 'Escape') {
            event.preventDefault();
            closeExecutionModeMenu(true);
            return;
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            closeExecutionModeMenu(false);
            if (event.shiftKey) {
              executionModeButton?.focus();
            } else {
              contextProgress?.focus();
            }
            return;
          }
          var nextIndex = -1;
          if (event.key === 'ArrowDown') {
            nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % options.length;
          } else if (event.key === 'ArrowUp') {
            nextIndex = activeIndex < 0 ? options.length - 1 : (activeIndex - 1 + options.length) % options.length;
          } else if (event.key === 'Home') {
            nextIndex = 0;
          } else if (event.key === 'End') {
            nextIndex = options.length - 1;
          }
          if (nextIndex < 0) { return; }
          event.preventDefault();
          options[nextIndex].focus();
        });
      }

      document.addEventListener('mousedown', function(event) {
        if (!executionModeMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target) { return; }
        if ((executionModeMenu && executionModeMenu.contains(target)) || (executionModeButton && executionModeButton.contains(target))) {
          return;
        }
        closeExecutionModeMenu(false);
      });

      document.addEventListener('keydown', function(event) {
        if (!executionModeMenuOpen || event.key !== 'Escape') { return; }
        event.preventDefault();
        closeExecutionModeMenu(true);
      });

`.slice(1)
};

export const executionModeImplementationFragment: WebviewFragment = {
  id: 'execution-mode.implementation',
  source: `
      function openExecutionModeMenu(focusTarget) {
        if (!executionModeMenu || !executionModeButton || isExecutionModeSelectionLocked()) { return; }
        closeCommandMenu();
        closeReferenceMenu(false);
        executionModeMenuOpen = true;
        executionModeMenu.classList.remove('hidden');
        executionModeButton.classList.add('is-active');
        executionModeButton.setAttribute('aria-expanded', 'true');
        renderExecutionModeControl();
        var options = getExecutionModeOptions();
        if (!options.length) { return; }
        var target = focusTarget === 'last'
          ? options[options.length - 1]
          : focusTarget === 'first' ? options[0] : options.find(function(option) {
              return option.getAttribute('aria-checked') === 'true';
            }) || options[0];
        target.focus();
      }

      function closeExecutionModeMenu(restoreFocus) {
        executionModeMenuOpen = false;
        if (executionModeMenu) {
          executionModeMenu.classList.add('hidden');
        }
        if (executionModeButton) {
          executionModeButton.classList.remove('is-active');
          executionModeButton.setAttribute('aria-expanded', 'false');
          if (restoreFocus) {
            executionModeButton.focus();
          }
        }
      }

      function getExecutionModeOptions() {
        if (!executionModeMenu) { return []; }
        return Array.prototype.slice.call(executionModeMenu.querySelectorAll('button[data-execution-mode]:not(:disabled)'));
      }

      function renderExecutionModeControl() {
        var currentMode = state.executionMode === 'plan' ? 'plan' : 'normal';
        var readiness = getCommandSettingReadiness('executionMode');
        var locked = isExecutionModeSelectionLocked();
        var lockText = readiness === 'error' ? t('executionModeLoadFailed')
          : readiness === 'loading' ? t('executionModeRestoring')
            : locked ? t('executionModeReadonlyWhileBusy') : '';
        var labelKey = getExecutionModeLabelKey(currentMode);
        var descriptionKey = getExecutionModeDescriptionKey(currentMode);
        var pendingPlan = Array.isArray(state.planWorkflows) && state.planWorkflows.some(function(plan) {
          return plan && plan.status === 'pending';
        });
        var description = t(descriptionKey);
        if (pendingPlan) {
          description += '\\n' + t('executionModePendingPlan');
        }
        if (lockText) {
          description += '\\n' + lockText;
        }

        if (locked && executionModeMenuOpen) {
          closeExecutionModeMenu(false);
        }
        if (executionModeButtonLabel) {
          executionModeButtonLabel.textContent = currentMode === 'plan' ? 'P' : 'N';
        }
        if (executionModeTooltipTitle) {
          executionModeTooltipTitle.textContent = t('executionMode') + ': ' + t(labelKey);
        }
        if (executionModeTooltipDescription) {
          executionModeTooltipDescription.textContent = description;
        }
        if (executionModeTooltip) {
          executionModeTooltip.setAttribute('aria-hidden', executionModeMenuOpen ? 'true' : 'false');
        }
        if (executionModeButton) {
          executionModeButton.disabled = locked;
          executionModeButton.setAttribute('aria-disabled', locked ? 'true' : 'false');
          executionModeButton.setAttribute('aria-busy', readiness === 'loading' ? 'true' : 'false');
          executionModeButton.setAttribute('aria-expanded', executionModeMenuOpen ? 'true' : 'false');
          executionModeButton.setAttribute('aria-label', t('executionMode') + ': ' + t(labelKey) + '. ' + description);
        }
        if (!executionModeMenu) { return; }
        executionModeMenu.classList.toggle('hidden', !executionModeMenuOpen);
        executionModeMenu.querySelectorAll('button[data-execution-mode]').forEach(function(option) {
          var mode = option.dataset.executionMode === 'plan' ? 'plan' : 'normal';
          var selected = mode === currentMode;
          var optionLabelKey = getExecutionModeLabelKey(mode);
          var optionDescriptionKey = getExecutionModeDescriptionKey(mode);
          option.disabled = locked;
          option.setAttribute('aria-checked', selected ? 'true' : 'false');
          option.setAttribute('aria-label', t(optionLabelKey) + '. ' + t(optionDescriptionKey));
          var check = option.querySelector('.execution-mode-option-check');
          if (check) {
            check.textContent = selected ? '\\u2713' : '';
          }
        });
      }

      function getExecutionModeLabelKey(mode) {
        return mode === 'plan' ? 'executionPlan' : 'executionNormal';
      }

      function getExecutionModeDescriptionKey(mode) {
        return mode === 'plan' ? 'executionPlanDescription' : 'executionNormalDescription';
      }

      function isExecutionModeSelectionLocked() {
        return getCommandSettingReadiness('executionMode') !== 'ready' || Boolean(state.isBusy);
      }

      function getExecutionModeLockText() {
        var readiness = getCommandSettingReadiness('executionMode');
        return t(readiness === 'error'
          ? 'executionModeLoadFailed'
          : readiness === 'loading' ? 'executionModeRestoring' : 'executionModeReadonlyWhileBusy');
      }

`.slice(1)
};
