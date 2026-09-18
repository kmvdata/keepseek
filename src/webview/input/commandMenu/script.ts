import type { WebviewFragment } from '../composition';

export const commandMenuDeclarationFragment: WebviewFragment = {
  id: 'command-menu.declaration',
  source: `
      var commandMenuButton = document.getElementById('commandMenuButton');
      var commandMenu = document.getElementById('commandMenu');
      var commandGoalMode = document.getElementById('commandGoalMode');
      var commandGoalModeDescription = document.getElementById('commandGoalModeDescription');
`.slice(1)
};

export const commandMenuStateFragment: WebviewFragment = {
  id: 'command-menu.state',
  source: `
      var commandMenuOpen = false;
`.slice(1)
};

export const commandMenuTriggerBindingsFragment: WebviewFragment = {
  id: 'command-menu.trigger-bindings',
  source: `
      if (commandMenuButton) {
        commandMenuButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          toggleCommandMenu();
          if (commandMenuOpen) {
            promptInput.focus();
          }
        });
      }

      if (commandMenu) {
        commandMenu.addEventListener('keydown', handleCommandMenuKeydown);
      }
      commandGoalMode?.addEventListener('click', function() {
        var mode = String(state.goalUi?.mode || 'chat');
        closeCommandMenu();
        if (mode === 'goal_active' || mode === 'goal_terminal' || mode === 'proposal_review') {
          window.keepseekGoalInterface?.focusCard();
          return;
        }
        if (mode === 'workspace_goal_elsewhere') {
          var sessionId = String(state.goalUi?.goalSessionId || '');
          if (sessionId) vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
          return;
        }
        vscode.postMessage({ type: 'setGoalComposerMode', enabled: mode === 'chat' });
      });

`.slice(1)
};

export const commandMenuDismissBindingFragment: WebviewFragment = {
  id: 'command-menu.dismiss-binding',
  source: `
      document.addEventListener('mousedown', function(event) {
        if (!commandMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target) { return; }
        if ((commandMenu && commandMenu.contains(target)) || (commandMenuButton && commandMenuButton.contains(target))) {
          return;
        }
        closeCommandMenu();
      });

`.slice(1)
};

export const commandMenuEscapeBindingFragment: WebviewFragment = {
  id: 'command-menu.escape-binding',
  source: `
      document.addEventListener('keydown', function(event) {
        if (!commandMenuOpen || event.key !== 'Escape') { return; }
        event.preventDefault();
        closeCommandMenu();
        promptInput.focus();
      });

`.slice(1)
};

export const commandMenuImplementationFragment: WebviewFragment = {
  id: 'command-menu.implementation',
  source: `
      function isPromptSelectionInside() {
        var selection = window.getSelection();
        return Boolean(selection && selection.rangeCount && isRangeInsidePrompt(selection.getRangeAt(0)));
      }

      function openCommandMenu() {
        if (!commandMenu || !commandMenuButton) { return; }
        commandMenuOpen = true;
        commandMenu.classList.remove('hidden');
        commandMenuButton.classList.add('is-active');
        commandMenuButton.setAttribute('aria-expanded', 'true');
        renderCommandMenu();
      }

      function closeCommandMenu() {
        if (!commandMenu || !commandMenuButton) { return; }
        commandMenuOpen = false;
        commandModelListOpen = false;
        commandSubagentModelListOpen = false;
        commandSubagentModelProfile = '';
        commandApprovalModeListOpen = false;
        commandSkillListOpen = false;
        commandMenu.classList.add('hidden');
        commandMenuButton.classList.remove('is-active');
        commandMenuButton.setAttribute('aria-expanded', 'false');
        renderCommandMenu();
      }

      function toggleCommandMenu() {
        if (commandMenuOpen) {
          closeCommandMenu();
          return;
        }
        openCommandMenu();
      }

      function handleCommandMenuKeydown(event) {
        if (!commandMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target || !commandMenu || !commandMenu.contains(target)) { return; }

        if (event.key === 'Escape') {
          event.preventDefault();
          closeCommandMenu();
          promptInput.focus();
          return;
        }

        if (event.key === 'ArrowRight') {
          if (target === commandModelSwitch) {
            event.preventDefault();
            openCommandModelListAndFocus();
            return;
          }
          if (target === commandSubagentModelSwitch) {
            event.preventDefault();
            openCommandSubagentModelListAndFocus();
            return;
          }
          var subagentProfileButton = target.closest('button[data-subagent-profile-toggle]');
          if (subagentProfileButton) {
            event.preventDefault();
            openCommandSubagentProfileModelListAndFocus(subagentProfileButton.dataset.subagentProfileToggle || '');
            return;
          }
          if (target === commandApprovalModeSwitch) {
            event.preventDefault();
            openCommandApprovalModeListAndFocus();
            return;
          }
          if (target === commandSkillsMainButton || target === commandSkillsButton) {
            event.preventDefault();
            openCommandSkillListAndFocus();
            return;
          }
        }

        if (event.key === 'ArrowLeft') {
          if (commandModelListOpen && commandModelList && (commandModelList.contains(target) || target === commandModelSwitch)) {
            event.preventDefault();
            commandModelListOpen = false;
            renderCommandMenu();
            if (commandModelSwitch) { commandModelSwitch.focus(); }
            return;
          }
          if (commandSubagentModelListOpen && commandSubagentModelList && (commandSubagentModelList.contains(target) || target === commandSubagentModelSwitch)) {
            event.preventDefault();
            if (commandSubagentModelProfile && commandSubagentModelList.contains(target)) {
              var activeProfile = commandSubagentModelProfile;
              commandSubagentModelProfile = '';
              renderCommandMenu();
              var activeProfileButton = commandSubagentModelList.querySelector('button[data-subagent-profile-toggle="' + activeProfile + '"]');
              if (activeProfileButton instanceof HTMLElement) { activeProfileButton.focus(); }
              return;
            }
            commandSubagentModelListOpen = false;
            commandSubagentModelProfile = '';
            renderCommandMenu();
            if (commandSubagentModelSwitch) { commandSubagentModelSwitch.focus(); }
            return;
          }
          if (commandApprovalModeListOpen && commandApprovalModeList && (commandApprovalModeList.contains(target) || target === commandApprovalModeSwitch)) {
            event.preventDefault();
            commandApprovalModeListOpen = false;
            renderCommandMenu();
            if (commandApprovalModeSwitch) { commandApprovalModeSwitch.focus(); }
            return;
          }
          if (commandSkillListOpen && commandSkillList && (commandSkillList.contains(target) || target === commandSkillsMainButton || target === commandSkillsButton || target === commandCreateSkillButton)) {
            event.preventDefault();
            commandSkillListOpen = false;
            renderCommandMenu();
            if (commandSkillsMainButton) {
              commandSkillsMainButton.focus();
            } else if (commandSkillsButton) {
              commandSkillsButton.focus();
            }
            return;
          }
        }

        if (isCommandMenuNativeNavigationTarget(target)) {
          return;
        }

        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveCommandMenuFocus(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveCommandMenuFocus(-1);
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          focusCommandMenuControlAt(0);
          return;
        }
        if (event.key === 'End') {
          event.preventDefault();
          focusCommandMenuControlAt(-1);
        }
      }

      function openCommandModelListAndFocus() {
        if (!commandModelSwitch || isModelSelectionLocked()) { return; }
        commandModelListOpen = true;
        commandSubagentModelListOpen = false;
        commandSubagentModelProfile = '';
        commandApprovalModeListOpen = false;
        commandSkillListOpen = false;
        renderCommandMenu();
        focusFirstCommandMenuControl(commandModelList);
      }

      function openCommandSubagentModelListAndFocus() {
        if (!commandSubagentModelSwitch) { return; }
        commandSubagentModelListOpen = true;
        commandSubagentModelProfile = '';
        commandModelListOpen = false;
        commandApprovalModeListOpen = false;
        commandSkillListOpen = false;
        renderCommandMenu();
        focusFirstCommandMenuControl(commandSubagentModelList);
      }

      function openCommandSubagentProfileModelListAndFocus(profile) {
        if (!commandSubagentModelList || isSubagentModelSelectionLocked()
          || !['research', 'review', 'proposal'].includes(profile)) { return; }
        commandSubagentModelListOpen = true;
        commandSubagentModelProfile = profile;
        commandModelListOpen = false;
        commandApprovalModeListOpen = false;
        commandSkillListOpen = false;
        renderCommandMenu();
        var profileSection = commandSubagentModelList.querySelector('[data-subagent-profile-section="' + profile + '"]');
        var dropdown = profileSection?.querySelector('.command-subagent-profile-dropdown');
        focusFirstCommandMenuControl(dropdown);
      }

      function openCommandApprovalModeListAndFocus() {
        if (!commandApprovalModeSwitch || isApprovalModeSelectionLocked()) { return; }
        commandApprovalModeListOpen = true;
        commandModelListOpen = false;
        commandSubagentModelListOpen = false;
        commandSubagentModelProfile = '';
        commandSkillListOpen = false;
        renderCommandMenu();
        focusFirstCommandMenuControl(commandApprovalModeList);
      }

      function openCommandSkillListAndFocus() {
        if ((!commandSkillsMainButton && !commandSkillsButton) || state.isBusy) { return; }
        commandSkillListOpen = true;
        commandModelListOpen = false;
        commandSubagentModelListOpen = false;
        commandSubagentModelProfile = '';
        commandApprovalModeListOpen = false;
        vscode.postMessage({ type: 'requestSkills' });
        renderCommandMenu();
        focusFirstCommandMenuControl(commandSkillList);
      }

      function isCommandMenuNativeNavigationTarget(target) {
        if (target instanceof HTMLInputElement) {
          return target.type === 'range' || target.type === 'number' || target.type === 'text';
        }
        return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
      }

      function moveCommandMenuFocus(delta) {
        var controls = getCommandMenuFocusableControls(commandMenu);
        if (!controls.length) { return; }
        var active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        var index = controls.indexOf(active);
        if (index < 0 && active) {
          for (var i = 0; i < controls.length; i++) {
            if (controls[i].contains(active)) {
              index = i;
              break;
            }
          }
        }
        var nextIndex = index < 0
          ? (delta > 0 ? 0 : controls.length - 1)
          : (index + delta + controls.length) % controls.length;
        focusCommandMenuControlAt(nextIndex);
      }

      function focusCommandMenuControlAt(index) {
        var controls = getCommandMenuFocusableControls(commandMenu);
        if (!controls.length) { return; }
        var normalized = index < 0 ? controls.length - 1 : Math.min(index, controls.length - 1);
        focusCommandMenuControl(controls[normalized]);
      }

      function focusFirstCommandMenuControl(container) {
        var controls = getCommandMenuFocusableControls(container || commandMenu);
        if (!controls.length) { return; }
        focusCommandMenuControl(controls[0]);
      }

      function focusCommandMenuControl(control) {
        if (!control) { return; }
        control.focus();
        if (control.scrollIntoView) {
          control.scrollIntoView({ block: 'nearest' });
        }
      }

      function getCommandMenuFocusableControls(container) {
        if (!container) { return []; }
        return Array.prototype.slice.call(container.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'))
          .filter(function(control) {
            return control instanceof HTMLElement &&
              !control.closest('.hidden') &&
              control.tabIndex >= 0 &&
              control.getClientRects().length > 0;
          });
      }

`.slice(1)
};

export const commandMenuRenderFragment: WebviewFragment = {
  id: 'command-menu.render',
  source: `
      function renderCommandMenu() {
        if (!commandMenu) { return; }
        if (commandMenuButton) {
          commandMenuButton.title = t('showCommandMenuTitle') + ' · ' + t(getApprovalModeLabelKey(state.approvalMode));
        }
        commandMenu.classList.toggle('is-readonly', Boolean(state.isBusy));
        commandMenu.classList.toggle('allows-model-selection', Boolean(state.isBusy && !isModelSelectionLocked()));
        commandMenu.classList.toggle('allows-approval-selection', Boolean(state.isBusy && !isApprovalModeSelectionLocked()));
        renderCommandModel();
        renderCommandSubagentModel();
        renderCommandApprovalMode();
        renderCompressionThreshold();
        renderCommandSkillFilter();
        renderCommandSkills();
        renderCreateSkillCommand();
        renderLegacyMemoryCommand();
        renderBackgroundRunCommand();
        renderEffort();
        renderCommandGoalMode();
      }

      function renderCommandGoalMode() {
        if (!commandGoalMode) return;
        var mode = String(state.goalUi?.mode || 'chat');
        var checked = mode !== 'chat' && mode !== 'workspace_goal_elsewhere';
        commandGoalMode.setAttribute('aria-checked', checked ? 'true' : 'false');
        commandGoalMode.classList.toggle('is-checked', checked);
        commandGoalMode.disabled = !state.startup?.interactiveReady || (Boolean(state.isBusy) && mode === 'chat');
        if (commandGoalModeDescription) {
          var key = mode === 'goal_active' ? 'goalModeActiveHint'
            : mode === 'goal_terminal' ? 'goalModeTerminalHint'
              : mode === 'workspace_goal_elsewhere' ? 'goalModeElsewhereHint'
                : mode === 'proposal_generating' ? 'goalModeGeneratingHint'
                  : mode === 'proposal_review' ? 'goalModeReviewHint'
                    : mode === 'goal_armed' ? 'goalModeArmedHint'
                      : 'goalModeDescription';
          commandGoalModeDescription.textContent = t(key);
        }
      }

      function renderBackgroundRunCommand() {
        var scripts = Array.isArray(state.backgroundAvailableScripts)
          ? state.backgroundAvailableScripts.filter(function(script) {
              return script === 'compile' || script === 'lint' || script === 'test';
            })
          : [];
        if (commandBackgroundRunSection) {
          commandBackgroundRunSection.classList.add('hidden');
        }
        if (commandBackgroundRunButton) {
          commandBackgroundRunButton.disabled = state.isBusy || isBackgroundActive();
        }
        if (commandBackgroundRunValue) {
          commandBackgroundRunValue.textContent = isBackgroundActive()
            ? t('backgroundCommandActive')
            : scripts.join(' / ');
        }
      }

`.slice(1)
};
