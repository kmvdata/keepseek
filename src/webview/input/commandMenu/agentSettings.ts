import type { WebviewFragment } from '../composition';

export const agentSettingsDeclarationFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.declaration',
  source: `
      var commandCompressionTabs = document.getElementById('commandCompressionTabs');
      var commandCompressionDescription = document.getElementById('commandCompressionDescription');
`.slice(1)
};

export const agentSettingsStateFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.state',
  source: `
      var modelSelectionRequestSequence = 0;
      var effortLabels = {
        high: 'High',
        max: 'Max'
      };
`.slice(1)
};

export const compressionBindingsFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.compression-bindings',
  source: `
      if (commandCompressionTabs) {
        commandCompressionTabs.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-threshold]');
          if (!button) { return; }
          event.preventDefault();
          event.stopPropagation();
          if (state.isBusy) { return; }
          var threshold = normalizeCompressionThreshold(button.dataset.threshold);
          var settings = getAgentSettings();
          settings.compressionThreshold = threshold;
          state.agentSettings = settings;
          vscode.postMessage({ type: 'setAgentSettings', settings: settings });
          renderCommandMenu();
        });
      }

`.slice(1)
};

export const agentEffortBindingFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.effort-binding',
  source: `
      if (commandEffortSlider) {
        commandEffortSlider.addEventListener('input', function() {
          if (state.isBusy) { return; }
          var effortValue = Number(commandEffortSlider.value);
          updateAgentSettingsFromControls();
          renderCommandMenu();
          setComposerStatus(effortValue <= 0 ? t('thinkingOff') : effortLabels[effortValue >= 2 ? 'max' : 'high']);
        });
      }

`.slice(1)
};

export const agentSettingsRenderFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.render',
  source: `
      function renderCompressionThreshold() {
        var threshold = getAgentSettings().compressionThreshold;
        var selectedTabId = '';
        if (commandCompressionTabs) {
          commandCompressionTabs.setAttribute('aria-disabled', state.isBusy ? 'true' : 'false');
          commandCompressionTabs.title = t('compressionThresholdDescription');
          var tabs = commandCompressionTabs.querySelectorAll('button[data-threshold]');
          for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            var tabThreshold = normalizeCompressionThreshold(tab.dataset.threshold);
            var selected = tabThreshold === threshold;
            tab.disabled = Boolean(state.isBusy);
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.textContent = t(getCompressionThresholdTabLabelKey(tabThreshold));
            tab.title = t(getCompressionThresholdDescriptionKey(tabThreshold));
            if (selected) {
              selectedTabId = tab.id;
            }
          }
        }
        if (commandCompressionDescription) {
          commandCompressionDescription.textContent = t(getCompressionThresholdDescriptionKey(threshold));
          if (selectedTabId) {
            commandCompressionDescription.setAttribute('aria-labelledby', selectedTabId);
          }
        }
      }

      function getCompressionThresholdTabLabelKey(threshold) {
        return threshold === 'aggressive'
          ? 'compressionEarlyTab'
          : threshold === 'cache'
            ? 'compressionCacheFirstTab'
            : 'compressionBalancedTab';
      }

      function getCompressionThresholdDescriptionKey(threshold) {
        return threshold === 'aggressive'
          ? 'compressionEarlyDescription'
          : threshold === 'cache'
            ? 'compressionCacheFirstDescription'
            : 'compressionBalancedDescription';
      }

`.slice(1)
};

export const agentSettingsHelpersFragment: WebviewFragment = {
  id: 'command-menu.agent-settings.helpers',
  source: `
      function renderEffort() {
        var settings = getAgentSettings();
        var effortValue = settings.thinkingEnabled ? (settings.reasoningEffort === 'max' ? '2' : '1') : '0';
        var effortText = settings.thinkingEnabled ? effortLabels[settings.reasoningEffort] : t('off');
        if (commandEffortSlider) {
          commandEffortSlider.value = effortValue;
          commandEffortSlider.disabled = Boolean(state.isBusy);
          commandEffortSlider.setAttribute('aria-valuetext', effortText);
        }
        if (commandEffortValue) {
          commandEffortValue.textContent = effortText;
        }
      }

      function updateAgentSettingsFromControls() {
        var settings = readAgentSettingsFromControls();
        state.agentSettings = settings;
        vscode.postMessage({ type: 'setAgentSettings', settings: settings });
      }

      function readAgentSettingsFromControls() {
        var selectedCompressionTab = commandCompressionTabs
          ? commandCompressionTabs.querySelector('button[data-threshold][aria-selected="true"]')
          : null;
        var effortValue = commandEffortSlider ? Number(commandEffortSlider.value) : 1;
        return {
          thinkingEnabled: effortValue > 0,
          reasoningEffort: effortValue >= 2 ? 'max' : 'high',
          compressionThreshold: normalizeCompressionThreshold(
            selectedCompressionTab?.dataset.threshold || getAgentSettings().compressionThreshold
          )
        };
      }

      function getAgentSettings() {
        var configured = state.agentSettings || {};
        return {
          thinkingEnabled: typeof configured.thinkingEnabled === 'boolean' ? configured.thinkingEnabled : true,
          reasoningEffort: configured.reasoningEffort === 'max' ? 'max' : 'high',
          compressionThreshold: normalizeCompressionThreshold(configured.compressionThreshold)
        };
      }

      function normalizeCompressionThreshold(value) {
        return value === 'aggressive' || value === 'cache' ? value : 'balanced';
      }

`.slice(1)
};

