import type { WebviewFragment } from '../composition';

export const commandSkillsDeclarationFragment: WebviewFragment = {
  id: 'command-menu.skills.declaration',
  source: `
      var commandSkillsMainButton = document.getElementById('commandSkillsMainButton');
      var commandSkillsButton = document.getElementById('commandSkillsButton');
      var commandSkillList = document.getElementById('commandSkillList');
      var commandSkillFilterControl = document.getElementById('commandSkillFilterControl');
      var commandSkillFilterButton = document.getElementById('commandSkillFilterButton');
      var commandSkillFilterInput = document.getElementById('commandSkillFilterInput');
      var commandCreateSkillButton = document.getElementById('commandCreateSkillButton');
      var commandBackgroundRunSection = document.getElementById('commandBackgroundRunSection');
      var commandBackgroundRunButton = document.getElementById('commandBackgroundRunButton');
      var commandBackgroundRunValue = document.getElementById('commandBackgroundRunValue');
      var commandEffortSlider = document.getElementById('commandEffortSlider');
      var commandEffortValue = document.getElementById('commandEffortValue');
`.slice(1)
};

export const commandSkillsStateFragment: WebviewFragment = {
  id: 'command-menu.skills.state',
  source: `
      var commandSkillListOpen = false;
      var commandSkillFilterOpen = false;
      var commandSkillFilterQuery = '';
`.slice(1)
};

export const commandSkillsBindingsFragment: WebviewFragment = {
  id: 'command-menu.skills.bindings',
  source: `
      [commandSkillsMainButton, commandSkillsButton].forEach(function(toggleButton) {
        if (!toggleButton) { return; }
        toggleButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (state.isBusy) { return; }
          commandSkillListOpen = !commandSkillListOpen;
          if (commandSkillListOpen) {
            commandModelListOpen = false;
            commandSubagentModelListOpen = false;
            commandApprovalModeListOpen = false;
            vscode.postMessage({ type: 'requestSkills' });
          }
          renderCommandMenu();
        });
      });

      if (commandSkillFilterButton) {
        commandSkillFilterButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (state.isBusy || !commandSkillListOpen) { return; }
          setCommandSkillFilterOpen(!commandSkillFilterOpen, true);
        });
      }

      if (commandSkillFilterInput) {
        commandSkillFilterInput.addEventListener('input', function() {
          commandSkillFilterQuery = commandSkillFilterInput.value;
          renderCommandSkills();
        });
        commandSkillFilterInput.addEventListener('keydown', function(event) {
          if (event.key !== 'Escape') { return; }
          event.preventDefault();
          event.stopPropagation();
          setCommandSkillFilterOpen(false, true);
        });
      }

      if (commandSkillList) {
        commandSkillList.addEventListener('mousedown', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          if (target?.closest('button[data-skill-action]')) {
            event.preventDefault();
          }
        });

        commandSkillList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var control = target?.closest('button[data-skill-action][data-skill-id]');
          if (!control) { return; }
          event.preventDefault();
          event.stopPropagation();
          handleSkillAction(control.dataset.skillAction || '', control.dataset.skillId || '');
        });

        commandSkillList.addEventListener('change', function(event) {
          var target = event.target instanceof HTMLInputElement ? event.target : null;
          if (!target || target.type !== 'checkbox' || target.dataset.skillAction !== 'toggle-use') { return; }
          event.stopPropagation();
          handleSkillAction('toggle-use', target.dataset.skillId || '', target.checked);
        });
      }

      if (commandCreateSkillButton) {
        commandCreateSkillButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          closeCommandMenu();
          showCreateSkillDialog();
        });
      }





      if (commandBackgroundRunButton) {
        commandBackgroundRunButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (commandBackgroundRunButton.disabled) { return; }
          closeCommandMenu();
          if (typeof window.keepseekOpenBackgroundRunDialog === 'function') {
            window.keepseekOpenBackgroundRunDialog();
          }
        });
      }

`.slice(1)
};

export const commandSkillsImplementationFragment: WebviewFragment = {
  id: 'command-menu.skills.implementation',
  source: `
      function setCommandSkillFilterOpen(open, shouldFocus) {
        commandSkillFilterOpen = Boolean(open && commandSkillListOpen);
        if (!commandSkillFilterOpen) {
          commandSkillFilterQuery = '';
        }
        renderCommandSkillFilter();
        renderCommandSkills();
        if (!shouldFocus) { return; }
        if (commandSkillFilterOpen && commandSkillFilterInput) {
          commandSkillFilterInput.focus();
          commandSkillFilterInput.select();
        } else if (commandSkillFilterButton) {
          commandSkillFilterButton.focus();
        }
      }

      function renderCommandSkillFilter() {
        if (!commandSkillListOpen) {
          commandSkillFilterOpen = false;
          commandSkillFilterQuery = '';
        }
        if (commandSkillFilterControl) {
          commandSkillFilterControl.classList.toggle('hidden', !commandSkillListOpen);
          commandSkillFilterControl.classList.toggle('is-open', commandSkillFilterOpen);
        }
        if (commandSkillFilterButton) {
          var filterButtonLabel = t(commandSkillFilterOpen ? 'skillsFilterClose' : 'skillsFilter');
          commandSkillFilterButton.disabled = Boolean(state.isBusy) || !commandSkillListOpen;
          commandSkillFilterButton.setAttribute('aria-expanded', commandSkillFilterOpen ? 'true' : 'false');
          commandSkillFilterButton.setAttribute('aria-label', filterButtonLabel);
          commandSkillFilterButton.title = state.isBusy ? t('commandMenuReadonlyWhileBusy') : filterButtonLabel;
        }
        if (commandSkillFilterInput) {
          if (commandSkillFilterInput.value !== commandSkillFilterQuery) {
            commandSkillFilterInput.value = commandSkillFilterQuery;
          }
          commandSkillFilterInput.disabled = Boolean(state.isBusy) || !commandSkillListOpen || !commandSkillFilterOpen;
          commandSkillFilterInput.tabIndex = commandSkillFilterOpen ? 0 : -1;
          commandSkillFilterInput.setAttribute('aria-hidden', commandSkillFilterOpen ? 'false' : 'true');
        }
      }

      function renderCommandSkills() {
        var skills = getCommandSkillItems();
        var toggleLabel = t(commandSkillListOpen ? 'skillsCollapse' : 'skillsExpand');
        [commandSkillsMainButton, commandSkillsButton].forEach(function(toggleButton) {
          if (!toggleButton) { return; }
          toggleButton.disabled = Boolean(state.isBusy);
          toggleButton.setAttribute('aria-expanded', commandSkillListOpen ? 'true' : 'false');
          toggleButton.setAttribute('aria-label', toggleButton === commandSkillsMainButton
            ? t('skillsCommandToggle', { action: toggleLabel })
            : toggleLabel);
          toggleButton.title = state.isBusy ? t('commandMenuReadonlyWhileBusy') : toggleLabel;
        });
        if (!commandSkillList) { return; }

        commandSkillList.classList.toggle('hidden', !commandSkillListOpen);
        commandSkillList.innerHTML = '';
        if (!commandSkillListOpen) { return; }
        var scopeButton = document.createElement('button');
        scopeButton.type = 'button';
        scopeButton.className = 'command-skill-action';
        scopeButton.textContent = t('sharedScopeSelect');
        scopeButton.disabled = Boolean(state.isBusy);
        scopeButton.title = getSkillsState().scopeUri || t('sharedScopeRequired');
        scopeButton.addEventListener('click', function() { vscode.postMessage({ type: 'selectProjectScope' }); });
        var refreshButton = document.createElement('button');
        refreshButton.type = 'button';
        refreshButton.className = 'command-skill-action';
        refreshButton.textContent = t('skillsRefresh');
        refreshButton.disabled = Boolean(state.isBusy);
        refreshButton.addEventListener('click', function() { vscode.postMessage({ type: 'requestSkills' }); });
        var controls = document.createElement('div');
        controls.className = 'command-skill-actions';
        controls.append(scopeButton, refreshButton);
        commandSkillList.append(controls);
        var scopeInfo = document.createElement('div');
        scopeInfo.className = 'command-row-description';
        scopeInfo.textContent = getSkillsState().scopeUri || t('sharedScopeRequired');
        commandSkillList.append(scopeInfo);
        var configSummary = getSkillsState().configSummary;
        if (configSummary) {
          var configInfo = document.createElement('div');
          configInfo.className = 'command-row-description';
          configInfo.textContent = 'project_doc_max_bytes: ' + configSummary.projectDocMaxBytes + ' · project_doc_fallback_filenames: ' + configSummary.fallbackFilenames.join(', ');
          configInfo.title = Object.keys(configSummary.origins).map(function(key) { return key + ': ' + configSummary.origins[key]; }).join('\\n');
          commandSkillList.append(configInfo);
        }
        (getSkillsState().diagnostics || []).forEach(function(message) {
          var diagnostic = document.createElement('div');
          diagnostic.className = 'reference-menu-empty';
          diagnostic.textContent = message;
          commandSkillList.append(diagnostic);
        });
        if (!skills.length) {
          var empty = document.createElement('div');
          empty.className = 'reference-menu-empty';
          empty.textContent = commandSkillFilterQuery.trim() ? t('noMatchingSkills') : t('skillsNone');
          commandSkillList.append(empty);
          return;
        }

        for (var i = 0; i < skills.length; i++) {
          commandSkillList.append(createCommandSkillItem(skills[i]));
        }
      }

      function renderCreateSkillCommand() {
        if (!commandCreateSkillButton) { return; }
        var disabledReason = getCreateSkillDisabledReason();
        commandCreateSkillButton.classList.toggle('hidden', !commandSkillListOpen);
        commandCreateSkillButton.disabled = Boolean(state.isBusy) || Boolean(disabledReason);
        commandCreateSkillButton.title = state.isBusy
          ? t('commandMenuReadonlyWhileBusy')
          : (disabledReason || t('createSkill'));
      }

      function createCommandSkillItem(skill) {
        var active = skill.plugin ? isPluginSkillInPrompt(skill) : isSkillActive(skill.id);
        var canUse = Boolean(skill.enabled && !skill.unavailableReason);
        var item = document.createElement('div');
        item.className = 'command-skill-item' + (active ? ' is-active' : '') + (!canUse ? ' is-disabled' : '');

        var main = document.createElement('label');
        main.className = 'command-skill-main';

        var copy = document.createElement('span');
        copy.className = 'command-row-main';

        var name = document.createElement('span');
        name.className = 'command-skill-name';
        var referenceName = skill.plugin ? getSkillMentionName(skill) : (skill.name || skill.id);
        name.textContent = skill.interface && skill.interface.display_name ? skill.interface.display_name + ' (' + referenceName + ')' : referenceName;
        name.title = name.textContent;

        var description = document.createElement('span');
        description.className = 'command-skill-description';
        description.textContent = skill.description || skill.sourceLabel || skill.source || '';
        description.title = description.textContent;

        var meta = document.createElement('span');
        meta.className = 'command-skill-meta';
        meta.textContent = formatSkillMeta(skill);
        meta.title = meta.textContent;

        copy.append(name, description, meta);
        if (skill.plugin) {
          var capability = document.createElement('span');
          capability.className = 'command-plugin-capability';
          capability.textContent = formatPluginSkillCapability(skill.plugin).join(' · ');
          capability.title = capability.textContent;
          copy.append(capability);
        }

        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'command-skill-checkbox';
        checkbox.dataset.skillAction = 'toggle-use';
        checkbox.dataset.skillId = skill.id;
        checkbox.checked = active;
        checkbox.disabled = !canUse || Boolean(state.isBusy);
        checkbox.setAttribute('aria-label', t(active ? 'skillsDeselect' : 'skillsSelect', {
          name: referenceName
        }));
        checkbox.title = canUse
          ? t(active ? 'skillsDeselect' : 'skillsSelect', { name: referenceName })
          : getSkillUnavailableText(skill);

        main.append(copy, checkbox);

        var actions = document.createElement('div');
        actions.className = 'command-skill-actions';
        actions.append(createSkillActionButton(skill, 'open', t('skillsOpen'), Boolean(skill.plugin && !canUse)));
        if (!skill.plugin) {
          actions.append(createSkillActionButton(skill, 'workspace-default',
            skill.workspaceDefault ? t('skillsUnsetWorkspaceDefault') : t('skillsSetWorkspaceDefault'), !skill.enabled));
        }

        item.append(main, actions);
        return item;
      }

      function createSkillActionButton(skill, action, label, disabled) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'command-skill-action';
        button.dataset.skillAction = action;
        button.dataset.skillId = skill.id;
        button.textContent = label;
        button.disabled = Boolean(disabled) || Boolean(state.isBusy);
        return button;
      }

      function formatSkillMeta(skill) {
        var parts = [
          skill.plugin ? formatPluginSkillOrigin(skill.plugin) : (skill.sourceLabel || skill.source || ''),
          skill.plugin
            ? t(skill.enabled ? 'pluginSkillEnabled' : 'pluginSkillDisabled')
            : t(skill.enabled ? 'skillsEnabled' : 'skillsDisabled'),
          skill.plugin ? t('pluginSkillTaskOnly') : t(skill.allowImplicit ? 'skillsAllowAuto' : 'skillsManualOnly'),
          skill.policySource || '',
          skill.workspaceDefault ? t('skillsWorkspaceDefault') : ''
        ];
        if (skill.hasScripts) {
          parts.push(t('skillsScriptsPresent'));
        }
        if (skill.loadError) {
          parts.push(t('skillLoadError', { message: skill.loadError }));
        } else if (skill.unavailableReason) {
          parts.push(skill.unavailableReason);
        }
        return parts.filter(Boolean).join(' · ');
      }

      function getSkillUnavailableText(skill) {
        if (skill.unavailableReason || skill.loadError) {
          return skill.unavailableReason || skill.loadError;
        }
        if (!skill.enabled) {
          return t('skillsDisabled');
        }
        return t('skillsUnavailable');
      }

      function handleSkillAction(action, skillId, selected) {
        if (state.isBusy) { return; }
        var skill = getSkillById(skillId);
        if (!skill) { return; }
        if (action === 'toggle-use') {
          if (!skill.enabled || skill.unavailableReason) {
            return;
          }
          if (skill.plugin) {
            if (selected && !isPluginSkillInPrompt(skill)) {
              insertSkillChip(skill);
              setComposerStatus(t('pluginSkillInserted', { name: getSkillMentionName(skill) }));
            } else if (!selected) {
              removePromptSkillChip(skillId, getSkillPath(skill));
              setComposerStatus(t('skillRemoved', { name: getSkillMentionName(skill) }));
            }
            return;
          }
          if (selected) {
            vscode.postMessage({ type: 'useSkill', skillId: skillId });
            setComposerStatus(t('skillInserted', { name: skill.name || skillId }));
          } else {
            vscode.postMessage({ type: 'removeActiveSkill', skillId: skillId });
            setComposerStatus(t('skillRemoved', { name: skill.name || skillId }));
          }
          return;
        }
        if (action === 'open') {
          vscode.postMessage({ type: 'openSkill', skillId: skillId });
          return;
        }
        if (action === 'workspace-default' && !skill.plugin) {
          vscode.postMessage({ type: 'setSkillWorkspaceDefault', skillId: skillId, enabled: !skill.workspaceDefault });
        }
      }

`.slice(1)
};

