export function getInputScript(): string {
  return `
    let savedPromptRange = null;

    (function setupRichPromptInput() {
      var dropZone = promptInput.closest('.composer-input-inner') || promptInput;
      var dropArea = promptInput.closest('.composer-input-wrap') || dropZone;
      var dragDepth = 0;
      var referenceMenuButton = document.getElementById('referenceMenuButton');
      var commandMenuButton = document.getElementById('commandMenuButton');
      var commandMenu = document.getElementById('commandMenu');
      var commandModelSwitch = document.getElementById('commandModelSwitch');
      var commandModelValue = document.getElementById('commandModelValue');
      var commandModelList = document.getElementById('commandModelList');
      var commandSkillsButton = document.getElementById('commandSkillsButton');
      var commandSkillsValue = document.getElementById('commandSkillsValue');
      var commandSkillList = document.getElementById('commandSkillList');
      var commandCreateSkillButton = document.getElementById('commandCreateSkillButton');
      var commandEffortSlider = document.getElementById('commandEffortSlider');
      var commandEffortValue = document.getElementById('commandEffortValue');
      var commandThinkingToggle = document.getElementById('commandThinkingToggle');
      var contextProgress = document.getElementById('contextProgress');
      var contextProgressTitle = document.getElementById('contextProgressTitle');
      var contextProgressPercent = document.getElementById('contextProgressPercent');
      var contextProgressTokens = document.getElementById('contextProgressTokens');
      var contextProgressBreakdown = document.getElementById('contextProgressBreakdown');
      var referenceMenu = document.getElementById('referenceMenu');
      var skillsBar = document.getElementById('skillsBar');
      var skillsBarList = document.getElementById('skillsBarList');
      var commandMenuOpen = false;
      var commandModelListOpen = false;
      var commandSkillListOpen = false;
      var referenceMenuOpen = false;
      var referenceMenuSource = '';
      var activeMentionRange = null;
      var activeMentionQuery = '';
      var activeReferenceIndex = 0;
      var referenceResources = [];
      var referenceResourcesLoading = false;
      var referenceResourcesLoaded = false;
      var referenceResourcesError = '';
      var referenceResourceRequestSequence = 0;
      var referenceResourceRequestId = '';
      var effortLabels = {
        high: 'High',
        max: 'Max'
      };
      var sendIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.75V3.75M4.75 7 8 3.75 11.25 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var stopIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" fill="currentColor"/></svg>';
      var promptShortcutController = window.keepseekRichTextShortcuts.createController({
        getEditor: function() { return promptInput; },
        isRangeInside: function(range) { return isRangeInsidePrompt(range); },
        isNodeInside: function(node) { return isNodeInsidePrompt(node); },
        setSelectionRange: function(_editor, range) { setPromptSelectionRange(range); },
        saveSelection: function() { savePromptSelection(); },
        restoreSelection: function() { restorePromptSelection(); },
        getInsertionRange: function() { return getPromptInsertionRange(); },
        insertText: function(_editor, text) { insertPlainText(text); },
        onSelectionChanged: function() { syncReferenceMenuFromPrompt(); },
        onEdited: function() {
          sanitizePromptContent();
          updatePromptVisualState();
          savePromptSelection();
          syncReferenceMenuFromPrompt();
        }
      });

      composer.addEventListener('submit', function(event) {
        event.preventDefault();
        if (state.isBusy) {
          closeCommandMenu();
          closeReferenceMenu(false);
          setComposerStatus(t('taskAlreadyRunning'));
          promptInput.focus();
          return;
        }
        sanitizePromptContent();
        var prompt = serializePrompt();
        if (!prompt.trim()) return;
        closeCommandMenu();
        closeReferenceMenu(false);
        vscode.postMessage({
          type: 'sendPrompt',
          prompt: prompt,
          modelId: state.selectedModelId,
          settings: readAgentSettingsFromControls(),
          references: collectPromptFileReferences(),
          skillIds: collectActiveSkillIds()
        });
        state.isBusy = true;
        clearPrompt();
      });

      if (sendButton) {
        sendButton.addEventListener('click', function(event) {
          if (!state.isBusy) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          closeCommandMenu();
          closeReferenceMenu(false);
          vscode.postMessage({ type: 'abortPrompt' });
          setComposerStatus(t('stoppingTask'));
        });
      }

      promptInput.addEventListener('keydown', function(event) {
        if (event.isComposing || event.keyCode === 229) {
          return;
        }
        if (referenceMenuOpen && event.key === 'Escape') {
          event.preventDefault();
          closeReferenceMenu(false);
          promptInput.focus();
          return;
        }
        if (referenceMenuOpen && event.key === 'ArrowDown') {
          event.preventDefault();
          moveReferenceSelection(1);
          return;
        }
        if (referenceMenuOpen && event.key === 'ArrowUp') {
          event.preventDefault();
          moveReferenceSelection(-1);
          return;
        }
        if (referenceMenuOpen && (event.key === 'Enter' || event.key === 'Tab')) {
          event.preventDefault();
          insertActiveReferenceResource();
          return;
        }
        if (commandMenuOpen && event.key === 'Escape') {
          event.preventDefault();
          closeCommandMenu();
          promptInput.focus();
          return;
        }
        if (commandMenuOpen && event.key === 'ArrowDown') {
          var first = commandMenu ? commandMenu.querySelector('button, input') : null;
          if (first) {
            event.preventDefault();
            first.focus();
            return;
          }
        }
        if (promptShortcutController.handleKeydown(event)) {
          return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          composer.requestSubmit();
          return;
        }
        if (event.key === 'Enter') {
          setComposerStatus(getSendShortcutHint());
        }
      });

      promptInput.addEventListener('input', function() {
        sanitizePromptContent();
        updatePromptVisualState();
        savePromptSelection();
        syncReferenceMenuFromPrompt();
      });

      promptInput.addEventListener('keyup', savePromptSelection);
      promptInput.addEventListener('mouseup', function() {
        promptShortcutController.deactivateMark();
        savePromptSelection();
      });
      promptInput.addEventListener('focus', savePromptSelection);

      if (referenceMenuButton) {
        referenceMenuButton.addEventListener('mousedown', function(event) {
          event.preventDefault();
          savePromptSelection();
        });

        referenceMenuButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (referenceMenuOpen) {
            closeReferenceMenu(true);
            return;
          }
          openReferenceMenuFromButton();
        });
      }

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

      if (commandModelSwitch) {
        commandModelSwitch.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          commandModelListOpen = !commandModelListOpen;
          renderCommandMenu();
        });
      }

      if (commandModelList) {
        commandModelList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-model-id]');
          if (!button) { return; }
          event.preventDefault();
          event.stopPropagation();
          var modelId = button.dataset.modelId || '';
          if (modelId) {
            state.selectedModelId = modelId;
            vscode.postMessage({ type: 'setSelectedModel', modelId: modelId });
          }
          commandModelListOpen = false;
          renderCommandMenu();
          setComposerStatus(t('modelSwitched'));
        });
      }

      if (commandSkillsButton) {
        commandSkillsButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          commandSkillListOpen = !commandSkillListOpen;
          if (commandSkillListOpen) {
            commandModelListOpen = false;
            vscode.postMessage({ type: 'requestSkills' });
          }
          renderCommandMenu();
        });
      }

      if (commandSkillList) {
        commandSkillList.addEventListener('mousedown', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          if (target?.closest('[data-skill-action]')) {
            event.preventDefault();
          }
        });

        commandSkillList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var control = target?.closest('[data-skill-action][data-skill-id]');
          if (!control) { return; }
          event.preventDefault();
          event.stopPropagation();
          handleSkillAction(control.dataset.skillAction || '', control.dataset.skillId || '');
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

      if (skillsBarList) {
        skillsBarList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-skill-id]');
          if (!button) { return; }
          event.preventDefault();
          event.stopPropagation();
          var skillId = button.dataset.skillId || '';
          var skill = getSkillById(skillId);
          vscode.postMessage({ type: 'removeActiveSkill', skillId: skillId });
          removePromptSkillChip(skillId);
          setComposerStatus(t('skillRemoved', { name: skill ? skill.name : skillId }));
        });
      }

      if (commandEffortSlider) {
        commandEffortSlider.addEventListener('input', function() {
          updateAgentSettingsFromControls();
          renderCommandMenu();
        });
      }

      if (commandThinkingToggle) {
        commandThinkingToggle.addEventListener('change', function() {
          updateAgentSettingsFromControls();
          renderCommandMenu();
          setComposerStatus(commandThinkingToggle.checked ? t('thinkingOn') : t('thinkingOff'));
        });
      }

      if (referenceMenu) {
        referenceMenu.addEventListener('mousedown', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          if (target?.closest('button[data-reference-index]')) {
            event.preventDefault();
          }
        });

        referenceMenu.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-reference-index]');
          if (!button) { return; }
          event.preventDefault();
          event.stopPropagation();
          var index = readPositiveInteger(button.dataset.referenceIndex, 1) - 1;
          insertReferenceResourceAtIndex(index);
        });

        referenceMenu.addEventListener('focusin', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-reference-index]');
          if (!button || !referenceMenu.contains(button)) { return; }
          var index = readPositiveInteger(button.dataset.referenceIndex, 1) - 1;
          if (index >= 0) {
            activeReferenceIndex = index;
            syncReferenceMenuActiveOption();
          }
        });

        referenceMenu.addEventListener('keydown', handleReferenceMenuKeydown);
      }

      document.addEventListener('mousedown', function(event) {
        if (!commandMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target) { return; }
        if ((commandMenu && commandMenu.contains(target)) || (commandMenuButton && commandMenuButton.contains(target))) {
          return;
        }
        closeCommandMenu();
      });

      document.addEventListener('mousedown', function(event) {
        if (!referenceMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target) { return; }
        if ((referenceMenu && referenceMenu.contains(target)) || (referenceMenuButton && referenceMenuButton.contains(target)) || promptInput.contains(target)) {
          return;
        }
        closeReferenceMenu(false);
      });

      document.addEventListener('keydown', function(event) {
        if (!commandMenuOpen || event.key !== 'Escape') { return; }
        event.preventDefault();
        closeCommandMenu();
        promptInput.focus();
      });

      document.addEventListener('selectionchange', function() {
        if (isNodeInsidePrompt(document.activeElement)) {
          if (promptShortcutController.isMarkActive() && !isPromptSelectionInside()) {
            promptShortcutController.deactivateMark();
          }
          savePromptSelection();
          if (referenceMenuOpen) {
            syncReferenceMenuFromPrompt();
          }
        }
      });

      promptInput.addEventListener('click', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        var skillLink = target?.closest('a.rich-skill-link');
        if (skillLink && promptInput.contains(skillLink)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        var link = target?.closest('a.rich-file-link');
        if (!link || !promptInput.contains(link)) { return; }

        event.preventDefault();
        event.stopPropagation();

        if (link.dataset.kind === 'directory') {
          vscode.postMessage({
            type: 'openDirectoryReference',
            path: link.dataset.path || ''
          });
          return;
        }

        vscode.postMessage({
          type: 'openFileReference',
          path: link.dataset.path || '',
          startLine: readPositiveInteger(link.dataset.startLine, 0),
          endLine: readPositiveInteger(link.dataset.endLine, 0),
          startColumn: readPositiveInteger(link.dataset.startColumn, 0),
          endColumn: readPositiveInteger(link.dataset.endColumn, 0)
        });
      });

      promptInput.addEventListener('paste', function(event) {
        event.preventDefault();
        var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (text) {
          insertPlainText(text);
        }
      });

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
          if (target === commandSkillsButton) {
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
          if (commandSkillListOpen && commandSkillList && (commandSkillList.contains(target) || target === commandSkillsButton)) {
            event.preventDefault();
            commandSkillListOpen = false;
            renderCommandMenu();
            if (commandSkillsButton) { commandSkillsButton.focus(); }
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
        if (!commandModelSwitch) { return; }
        commandModelListOpen = true;
        commandSkillListOpen = false;
        renderCommandMenu();
        focusFirstCommandMenuControl(commandModelList);
      }

      function openCommandSkillListAndFocus() {
        if (!commandSkillsButton) { return; }
        commandSkillListOpen = true;
        commandModelListOpen = false;
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

      function syncReferenceMenuFromPrompt() {
        var skillTrigger = getSkillTrigger();
        if (skillTrigger) {
          var previousSkillQuery = referenceMenuSource === 'skill' ? activeMentionQuery : '';
          referenceMenuSource = 'skill';
          activeMentionRange = skillTrigger.range;
          activeMentionQuery = skillTrigger.query;
          if (previousSkillQuery !== activeMentionQuery) {
            activeReferenceIndex = 0;
          }
          if (!referenceMenuOpen) {
            openReferenceMenu('skill');
            return;
          }
          renderReferenceMenu();
          return;
        }
        if (referenceMenuOpen && referenceMenuSource === 'skill') {
          closeReferenceMenu(false);
          return;
        }

        var mention = getMentionTrigger();
        if (!mention) {
          if (referenceMenuOpen && referenceMenuSource === 'button') {
            activeMentionRange = null;
            activeMentionQuery = '';
            renderReferenceMenu();
            return;
          }
          closeReferenceMenu(false);
          return;
        }

        var previousQuery = activeMentionQuery;
        referenceMenuSource = 'mention';
        activeMentionRange = mention.range;
        activeMentionQuery = mention.query;
        if (previousQuery !== activeMentionQuery) {
          activeReferenceIndex = 0;
        }
        if (!referenceMenuOpen) {
          openReferenceMenu('mention');
          return;
        }
        renderReferenceMenu();
      }

      function openReferenceMenu(source) {
        if (!referenceMenu) { return; }
        closeCommandMenu();
        referenceMenuOpen = true;
        referenceMenuSource = source || referenceMenuSource || 'mention';
        referenceMenu.classList.remove('hidden');
        if (referenceMenuButton) {
          referenceMenuButton.classList.toggle('is-active', referenceMenuSource !== 'skill');
          referenceMenuButton.setAttribute('aria-expanded', 'true');
        }
        promptInput.setAttribute('aria-controls', 'referenceMenu');
        if (referenceMenuSource === 'skill') {
          vscode.postMessage({ type: 'requestSkills' });
        } else {
          requestReferenceResources();
        }
        renderReferenceMenu();
      }

      function openReferenceMenuFromButton() {
        activeMentionRange = null;
        activeMentionQuery = '';
        activeReferenceIndex = 0;
        openReferenceMenu('button');
        restorePromptSelection();
      }

      function closeReferenceMenu(restoreFocus) {
        if (!referenceMenu) { return; }
        referenceMenuOpen = false;
        referenceMenuSource = '';
        activeMentionRange = null;
        activeMentionQuery = '';
        activeReferenceIndex = 0;
        referenceMenu.classList.add('hidden');
        referenceMenu.innerHTML = '';
        if (referenceMenuButton) {
          referenceMenuButton.classList.remove('is-active');
          referenceMenuButton.setAttribute('aria-expanded', 'false');
        }
        promptInput.removeAttribute('aria-controls');
        promptInput.removeAttribute('aria-activedescendant');
        if (restoreFocus) {
          promptInput.focus();
        }
      }

      function requestReferenceResources() {
        if (referenceResourcesLoading) { return; }
        referenceResourcesLoading = true;
        referenceResourcesError = '';
        referenceResourceRequestSequence += 1;
        referenceResourceRequestId = 'referenceResources:' + referenceResourceRequestSequence + ':' + Date.now();
        vscode.postMessage({ type: 'requestReferenceResources', requestId: referenceResourceRequestId });
      }

      function handleReferenceResourcesMessage(message) {
        if (message.requestId && referenceResourceRequestId && message.requestId !== referenceResourceRequestId) {
          return;
        }
        referenceResourcesLoading = false;
        referenceResourcesLoaded = true;
        referenceResourcesError = typeof message.error === 'string' ? message.error : '';
        referenceResources = Array.isArray(message.resources) ? message.resources : [];
        renderReferenceMenu();
      }

      function renderReferenceMenu() {
        if (!referenceMenu || !referenceMenuOpen) { return; }
        referenceMenu.innerHTML = '';

        var header = document.createElement('div');
        header.className = 'reference-menu-header';
        var title = document.createElement('span');
        title.className = 'reference-menu-title';
        title.textContent = referenceMenuSource === 'skill' ? t('skillsTitle') : t('referenceFilesTitle');
        var count = document.createElement('span');
        count.className = 'reference-menu-count';
        header.append(title, count);
        referenceMenu.append(header);

        if (referenceResourcesLoading && !referenceResourcesLoaded) {
          count.textContent = t('loading');
          var loadingEntries = shouldShowExternalPickerReferenceEntry() ? [createExternalPickerReferenceEntry()] : [];
          if (loadingEntries.length) {
            appendReferenceMenuEntries(loadingEntries);
          }
          appendReferenceMenuNotice(t('loadingWorkspaceFiles'));
          return;
        }

        if (referenceResourcesError) {
          var errorEntries = shouldShowExternalPickerReferenceEntry() ? [createExternalPickerReferenceEntry()] : [];
          count.textContent = String(errorEntries.length);
          if (errorEntries.length) {
            appendReferenceMenuEntries(errorEntries);
          }
          appendReferenceMenuNotice(referenceResourcesError);
          return;
        }

        var entries = getReferenceMenuEntries();
        count.textContent = String(entries.length);
        if (!entries.length) {
          appendReferenceMenuNotice(referenceMenuSource === 'skill'
            ? (activeMentionQuery ? t('noMatchingSkills') : t('skillsNone'))
            : (activeMentionQuery ? t('noMatchingFiles') : t('noReferenceFiles')));
          return;
        }

        if (activeReferenceIndex >= entries.length) {
          activeReferenceIndex = entries.length - 1;
        }
        if (activeReferenceIndex < 0) {
          activeReferenceIndex = 0;
        }

        appendReferenceMenuEntries(entries);
        scrollActiveReferenceIntoView();
      }

      function appendReferenceMenuEntries(entries) {
        var list = document.createElement('div');
        list.className = 'reference-menu-list';
        if (referenceMenuSource === 'skill') {
          appendSkillReferenceMenuEntries(list, entries);
        } else {
          for (var i = 0; i < entries.length; i++) {
            list.append(createReferenceMenuEntryButton(entries[i], i));
          }
        }
        referenceMenu.append(list);
        syncReferenceMenuActiveOption();
      }

      function appendSkillReferenceMenuEntries(list, entries) {
        var previousGroup = '';
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i];
          var group = entry.kind === 'skill' ? getSkillSourceGroupLabel(entry.skill) : '';
          if (group && group !== previousGroup) {
            previousGroup = group;
            list.append(createReferenceMenuGroupLabel(group));
          }
          list.append(createReferenceMenuEntryButton(entry, i));
        }
      }

      function createReferenceMenuGroupLabel(label) {
        var group = document.createElement('div');
        group.className = 'reference-menu-group';
        group.textContent = label;
        return group;
      }

      function appendReferenceMenuNotice(message) {
        if (!referenceMenu) { return; }
        var notice = document.createElement('div');
        notice.className = 'reference-menu-empty';
        notice.textContent = message;
        referenceMenu.append(notice);
      }

      function createReferenceMenuEntryButton(entry, index) {
        if (entry.kind === 'externalPicker') {
          return createExternalPickerReferenceButton(index);
        }
        if (entry.kind === 'skill') {
          return createSkillReferenceButton(entry.skill, index);
        }
        return createReferenceResourceButton(entry.resource, index);
      }

      function createExternalPickerReferenceButton(index) {
        var option = document.createElement('button');
        option.type = 'button';
        option.id = getReferenceMenuOptionId(index);
        option.className = 'reference-menu-item reference-menu-action' + (index === activeReferenceIndex ? ' is-active' : '');
        option.dataset.referenceIndex = String(index + 1);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === activeReferenceIndex ? 'true' : 'false');

        var name = document.createElement('span');
        name.className = 'reference-menu-item-name';
        name.textContent = t('chooseExternalFiles');

        var pathLabel = document.createElement('span');
        pathLabel.className = 'reference-menu-item-path';
        pathLabel.textContent = t('chooseExternalFilesDescription');

        option.append(name, pathLabel);
        return option;
      }

      function createReferenceResourceButton(resource, index) {
        var option = document.createElement('button');
        option.type = 'button';
        option.id = getReferenceMenuOptionId(index);
        option.className = 'reference-menu-item' + (resource.kind === 'directory' ? ' is-directory' : '') + (index === activeReferenceIndex ? ' is-active' : '');
        option.dataset.referenceIndex = String(index + 1);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === activeReferenceIndex ? 'true' : 'false');

        var name = document.createElement('span');
        name.className = 'reference-menu-item-name';
        name.textContent = getReferenceResourceName(resource);
        name.title = name.textContent;

        var pathLabel = document.createElement('span');
        pathLabel.className = 'reference-menu-item-path';
        pathLabel.textContent = resource.description || resource.path || '';
        pathLabel.title = pathLabel.textContent;

        option.append(name, pathLabel);
        return option;
      }

      function createSkillReferenceButton(skill, index) {
        var option = document.createElement('button');
        option.type = 'button';
        option.id = getReferenceMenuOptionId(index);
        option.className = 'reference-menu-item is-skill' + (index === activeReferenceIndex ? ' is-active' : '');
        option.dataset.referenceIndex = String(index + 1);
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === activeReferenceIndex ? 'true' : 'false');

        var icon = document.createElement('span');
        icon.className = 'reference-menu-item-icon reference-menu-skill-icon';
        icon.textContent = '$';
        icon.setAttribute('aria-hidden', 'true');

        var body = document.createElement('span');
        body.className = 'reference-menu-item-body';

        var name = document.createElement('span');
        name.className = 'reference-menu-item-name';
        name.textContent = getSkillMentionName(skill);
        name.title = name.textContent;

        var pathLabel = document.createElement('span');
        pathLabel.className = 'reference-menu-item-path';
        pathLabel.textContent = skill.description || getSkillPath(skill) || skill.sourceLabel || skill.source || '';
        pathLabel.title = pathLabel.textContent;

        body.append(name, pathLabel);
        option.append(icon, body);
        return option;
      }

      function getFilteredReferenceResources() {
        if (referenceMenuSource === 'skill') {
          return [];
        }
        var query = normalizeReferenceQuery(activeMentionQuery);
        if (!query) {
          return referenceResources.slice();
        }
        return referenceResources.filter(function(resource) {
          return resourceMatchesReferenceQuery(resource, query);
        });
      }

      function getReferenceMenuEntries() {
        if (referenceMenuSource === 'skill') {
          return getFilteredSkillMenuItems().map(function(skill) {
            return { kind: 'skill', skill: skill };
          });
        }
        var resources = getFilteredReferenceResources().map(function(resource) {
          return { kind: 'resource', resource: resource };
        });
        if (!shouldShowExternalPickerReferenceEntry()) {
          return resources;
        }

        return [createExternalPickerReferenceEntry()].concat(resources);
      }

      function shouldShowExternalPickerReferenceEntry() {
        if (referenceMenuSource === 'skill') {
          return false;
        }
        if (referenceMenuSource === 'button') {
          return true;
        }
        return !normalizeReferenceQuery(activeMentionQuery);
      }

      function createExternalPickerReferenceEntry() {
        return { kind: 'externalPicker' };
      }

      function normalizeReferenceQuery(value) {
        return String(value || '').trim().toLocaleLowerCase();
      }

      function getReferenceResourceName(resource) {
        var name = resource.label || getFileName(resource.path || '') || 'file';
        return resource.kind === 'directory' && name.charAt(name.length - 1) !== '/' ? name + '/' : name;
      }

      function getReferenceResourceSearchName(resource) {
        var name = String(resource.label || '').trim();
        if (!name) {
          name = getReferencePathBasename(resource.path || resource.uri || resource.description || '');
        }
        while (name.charAt(name.length - 1) === '/' || name.charAt(name.length - 1) === String.fromCharCode(92)) {
          name = name.slice(0, -1);
        }
        return name || 'file';
      }

      function getReferencePathBasename(value) {
        var normalized = String(value || '').trim().split(String.fromCharCode(92)).join('/');
        while (normalized.charAt(normalized.length - 1) === '/') {
          normalized = normalized.slice(0, -1);
        }
        var parts = normalized.split('/');
        return parts[parts.length - 1] || normalized || 'file';
      }

      function resourceMatchesReferenceQuery(resource, query) {
        var normalizedName = normalizeReferenceQuery(getReferenceResourceSearchName(resource));
        return normalizedName.indexOf(query) >= 0;
      }

      function moveReferenceSelection(delta) {
        setReferenceSelection(activeReferenceIndex + delta, false);
      }

      function setReferenceSelection(index, shouldFocus) {
        var entries = getReferenceMenuEntries();
        if (!entries.length) { return; }
        activeReferenceIndex = (index + entries.length) % entries.length;
        renderReferenceMenu();
        if (shouldFocus) {
          focusActiveReferenceMenuItem();
        }
      }

      function syncReferenceMenuActiveOption() {
        if (!referenceMenu) { return; }
        var activeId = '';
        var buttons = referenceMenu.querySelectorAll('button[data-reference-index]');
        buttons.forEach(function(button) {
          var index = readPositiveInteger(button.dataset.referenceIndex, 1) - 1;
          var isActive = index === activeReferenceIndex;
          button.classList.toggle('is-active', isActive);
          button.setAttribute('aria-selected', isActive ? 'true' : 'false');
          if (isActive) {
            activeId = button.id || getReferenceMenuOptionId(index);
          }
        });
        if (activeId) {
          referenceMenu.setAttribute('aria-activedescendant', activeId);
          promptInput.setAttribute('aria-activedescendant', activeId);
        } else {
          referenceMenu.removeAttribute('aria-activedescendant');
          promptInput.removeAttribute('aria-activedescendant');
        }
      }

      function getReferenceMenuOptionId(index) {
        return 'referenceMenuOption' + String(index + 1);
      }

      function focusActiveReferenceMenuItem() {
        if (!referenceMenu) { return; }
        var active = referenceMenu.querySelector('button[data-reference-index="' + String(activeReferenceIndex + 1) + '"]');
        if (active instanceof HTMLElement) {
          active.focus();
          if (active.scrollIntoView) {
            active.scrollIntoView({ block: 'nearest' });
          }
        }
      }

      function handleReferenceMenuKeydown(event) {
        if (!referenceMenuOpen) { return; }
        if (event.key === 'Escape') {
          event.preventDefault();
          closeReferenceMenu(true);
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setReferenceSelection(activeReferenceIndex + 1, true);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setReferenceSelection(activeReferenceIndex - 1, true);
          return;
        }
        if (event.key === 'Home') {
          event.preventDefault();
          setReferenceSelection(0, true);
          return;
        }
        if (event.key === 'End') {
          var entries = getReferenceMenuEntries();
          if (!entries.length) { return; }
          event.preventDefault();
          setReferenceSelection(entries.length - 1, true);
        }
      }

      function insertActiveReferenceResource() {
        insertReferenceResourceAtIndex(activeReferenceIndex);
      }

      function insertReferenceResourceAtIndex(index) {
        var entries = getReferenceMenuEntries();
        var entry = entries[index];
        if (!entry) { return; }
        if (entry.kind === 'externalPicker') {
          pickExternalFileReferences();
          return;
        }
        if (entry.kind === 'skill') {
          insertSkillFromReferenceMenu(entry.skill);
          return;
        }

        var resource = entry.resource;
        if (!resource) { return; }

        var reference = {
          path: resource.path || resource.uri || '',
          kind: resource.kind === 'directory' ? 'directory' : 'file',
          startLine: 0,
          endLine: 0,
          startColumn: 0,
          endColumn: 0
        };
        if (!reference.path) { return; }

        var range = activeMentionRange && isRangeInsidePrompt(activeMentionRange)
          ? activeMentionRange.cloneRange()
          : getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (isPromptRangeInsideMarkdownFence(range)) {
          appendReferenceBoundarySpace(fragment);
          fragment.append(document.createTextNode(referenceToPlainText(reference)));
          appendReferenceBoundarySpace(fragment);
          insertFragmentAtRange(range, fragment);
          closeReferenceMenu(true);
          setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
          return;
        }
        appendReferenceBoundarySpace(fragment);
        fragment.append(createReferenceLink(reference));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range, fragment);
        closeReferenceMenu(true);
        setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
      }

      function insertSkillFromReferenceMenu(skill) {
        if (!skill || !skill.id) { return; }
        if (!skill.enabled || !skill.userInvocable || skill.unavailableReason) {
          return;
        }
        var range = activeMentionRange && isRangeInsidePrompt(activeMentionRange)
          ? activeMentionRange.cloneRange()
          : getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        appendReferenceBoundarySpace(fragment);
        fragment.append(createSkillLink(skill));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range, fragment);
        closeReferenceMenu(true);
        setComposerStatus(t('skillInserted', { name: skill.name || skill.id }));
      }

      function pickExternalFileReferences() {
        consumeActiveMentionRangeForPicker();
        closeReferenceMenu(false);
        vscode.postMessage({ type: 'pickExternalFileReferences' });
      }

      function consumeActiveMentionRangeForPicker() {
        if (!activeMentionRange || !isRangeInsidePrompt(activeMentionRange)) { return; }
        var range = activeMentionRange.cloneRange();
        range.deleteContents();
        savedPromptRange = range.cloneRange();
        updatePromptVisualState();
      }

      function scrollActiveReferenceIntoView() {
        if (!referenceMenu) { return; }
        var active = referenceMenu.querySelector('.reference-menu-item.is-active');
        if (active && active.scrollIntoView) {
          active.scrollIntoView({ block: 'nearest' });
        }
      }

      function renderInputControls() {
        refreshPromptFileLinkLabels();
        refreshPromptSkillLinkLabels();
        renderActiveSkillsBar();
        renderContextProgress();
        renderCommandMenu();
        renderSendButton();
        setApiKeyVisible(apiKeyVisible, false);
      }

      function renderSendButton(isEmpty) {
        if (!sendButton) { return; }
        var isAbortMode = Boolean(state.isBusy);
        var mode = isAbortMode ? 'abort' : 'send';
        var label = t(isAbortMode ? 'stop' : 'send');
        sendButton.disabled = !isAbortMode && isPromptSubmittableEmpty();
        sendButton.classList.toggle('is-abort', isAbortMode);
        sendButton.title = label;
        sendButton.setAttribute('aria-label', label);
        if (sendButton.dataset.mode !== mode) {
          sendButton.dataset.mode = mode;
          sendButton.innerHTML = isAbortMode ? stopIconSvg : sendIconSvg;
        }
      }

      function renderContextProgress() {
        if (!contextProgress) { return; }
        var metrics = normalizeUsageMetrics(state.usageMetrics);
        var usedPercent = clampNumber(metrics.contextPercent, 0, 100);
        var angle = usedPercent * 3.6;
        var title = t('usageStatsTitle');
        var contextLine = ['usageMetricContextPercent', formatMetricPercent(usedPercent)];
        var costLine = ['usageMetricSessionCost', formatMetricCost(
          metrics.sessionUsageStats && metrics.sessionUsageStats.sessionCost,
          getUsageCurrency(metrics.sessionUsageStats, metrics.lastTurnUsage),
          hasUsageData(metrics.sessionUsageStats)
        )];
        var items = [
          ['usageMetricTurnHit', formatMetricPercent(calculateHitRate(metrics.lastTurnUsage))],
          ['usageMetricAverageHit', formatMetricPercent(calculateHitRate(metrics.sessionUsageStats))],
          ['usageMetricSessionTokens', formatMetricTokens(metrics.sessionUsageStats && metrics.sessionUsageStats.totalTokens, hasUsageData(metrics.sessionUsageStats))],
          ['usageMetricTurnTokens', formatMetricTokens(metrics.lastTurnUsage && metrics.lastTurnUsage.totalTokens, hasUsageData(metrics.lastTurnUsage))],
          ['usageMetricTurnCost', formatMetricCost(metrics.lastTurnUsage && metrics.lastTurnUsage.cost, getUsageCurrency(metrics.lastTurnUsage, metrics.sessionUsageStats), hasUsageData(metrics.lastTurnUsage))],
          ['usageMetricTurnCount', metrics.turnCount > 0 ? formatMetricInteger(metrics.turnCount) : '-'],
          ['usageMetricCompactThreshold', formatMetricPercent(metrics.contextCompressionTriggerRatio * 100)]
        ];
        var label = title + '。' + [contextLine, costLine].concat(items).map(function(item) {
          return t(item[0]) + item[1];
        }).join('；');

        contextProgress.style.setProperty('--context-progress-angle', angle + 'deg');
        contextProgress.classList.toggle('is-warning', usedPercent >= metrics.contextSoftCompactRatio * 100 && usedPercent < metrics.contextCompactForceRatio * 100);
        contextProgress.classList.toggle('is-danger', usedPercent >= metrics.contextCompactForceRatio * 100);
        contextProgress.setAttribute('aria-label', label);
        if (contextProgressTitle) { contextProgressTitle.textContent = title; }
        if (contextProgressPercent) {
          renderMetricLineInto(contextProgressPercent, t(contextLine[0]), contextLine[1]);
        }
        if (contextProgressTokens) {
          renderMetricLineInto(contextProgressTokens, t(costLine[0]), costLine[1]);
        }
        if (contextProgressBreakdown) {
          contextProgressBreakdown.innerHTML = '';
          items.forEach(function(item) {
            contextProgressBreakdown.append(createMetricLine(t(item[0]), item[1]));
          });
          contextProgressBreakdown.classList.remove('hidden');
        }
      }

      function createMetricLine(labelText, valueText) {
        var row = document.createElement('span');
        row.className = 'context-progress-metric';

        var label = document.createElement('span');
        label.className = 'context-progress-metric-label';
        label.textContent = labelText;

        var value = document.createElement('span');
        value.className = 'context-progress-metric-value';
        value.textContent = valueText;

        row.append(label, value);
        return row;
      }

      function renderMetricLineInto(container, labelText, valueText) {
        container.innerHTML = '';
        container.append(createMetricLine(labelText, valueText));
      }

      function normalizeUsageMetrics(value) {
        var metrics = value && typeof value === 'object' ? value : {};
        return {
          sessionUsageStats: normalizeUsageStats(metrics.sessionUsageStats, 'sessionCost'),
          lastTurnUsage: normalizeUsageStats(metrics.lastTurnUsage, 'cost'),
          balance: normalizeBalance(metrics.balance),
          promptCacheDiagnostics: metrics.promptCacheDiagnostics || null,
          turnCount: readNonNegativeNumber(metrics.turnCount, 0),
          contextPercent: readNonNegativeNumber(metrics.contextPercent, 0),
          contextCompressionTriggerRatio: readRatio(metrics.contextCompressionTriggerRatio, 0.8),
          contextSoftCompactRatio: readRatio(metrics.contextSoftCompactRatio, 0.5),
          toolResultSnipRatio: readRatio(metrics.toolResultSnipRatio, 0.6),
          contextCompactForceRatio: readRatio(metrics.contextCompactForceRatio, 0.9),
          slimToolModeEnabled: metrics.slimToolModeEnabled !== false
        };
      }

      function normalizeUsageStats(value, costKey) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        return {
          promptTokens: readNonNegativeNumber(value.promptTokens, 0),
          completionTokens: readNonNegativeNumber(value.completionTokens, 0),
          totalTokens: readNonNegativeNumber(value.totalTokens, 0),
          cacheHitTokens: readNonNegativeNumber(value.cacheHitTokens, 0),
          cacheMissTokens: readNonNegativeNumber(value.cacheMissTokens, 0),
          requestCount: readNonNegativeNumber(value.requestCount, 0),
          cost: readNonNegativeNumber(value[costKey], 0),
          sessionCost: readNonNegativeNumber(value.sessionCost, 0),
          currency: typeof value.currency === 'string' && value.currency.trim() ? value.currency.trim() : '¥'
        };
      }

      function normalizeBalance(value) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        var totalBalance = Number(value.totalBalance);
        return {
          totalBalance: Number.isFinite(totalBalance) ? totalBalance : null,
          currency: typeof value.currency === 'string' && value.currency.trim() ? value.currency.trim() : '¥',
          error: typeof value.error === 'string' ? value.error : ''
        };
      }

      function hasUsageData(usage) {
        return Boolean(usage && (usage.requestCount > 0 || usage.totalTokens > 0));
      }

      function calculateHitRate(usage) {
        if (!usage) {
          return null;
        }
        var denominator = Math.max(0, usage.cacheHitTokens) + Math.max(0, usage.cacheMissTokens);
        return denominator > 0 ? (Math.max(0, usage.cacheHitTokens) / denominator) * 100 : null;
      }

      function formatMetricPercent(value) {
        var number = Number(value);
        return Number.isFinite(number) ? number.toFixed(2) + '%' : '-';
      }

      function formatMetricTokens(value, hasData) {
        if (!hasData) {
          return '-';
        }
        return formatMetricInteger(readNonNegativeNumber(value, 0));
      }

      function formatMetricInteger(value) {
        return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString();
      }

      function formatMetricCost(value, currency, hasData) {
        if (!hasData) {
          return '-';
        }
        var number = Number(value);
        if (!Number.isFinite(number)) {
          return '-';
        }
        var truncated = Math.trunc(number * 100) / 100;
        return (currency || '¥') + truncated.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      }

      function formatMetricBalance(balance) {
        if (!balance || balance.totalBalance === null) {
          return '-';
        }
        return (balance.currency || '¥') + Number(balance.totalBalance).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      }

      function getUsageCurrency(primary, fallback) {
        return primary && primary.currency ? primary.currency : fallback && fallback.currency ? fallback.currency : '¥';
      }

      function readNonNegativeNumber(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
      }

      function readRatio(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
      }

      function clampNumber(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
      }

      function renderCommandMenu() {
        if (!commandMenu) { return; }
        renderCommandModel();
        renderCommandSkills();
        renderCreateSkillCommand();
        renderEffort();
      }

      function renderCommandModel() {
        var models = Array.isArray(state.models) ? state.models : [];
        var selected = getSelectedModel(models);
        if (commandModelValue) {
          commandModelValue.textContent = selected ? getModelDisplayLabel(selected.model) : 'DeepSeek-V4-Flash';
          commandModelValue.title = commandModelValue.textContent;
        }

        if (commandModelSwitch) {
          commandModelSwitch.setAttribute('aria-expanded', commandModelListOpen ? 'true' : 'false');
        }
        if (!commandModelList) { return; }

        commandModelList.classList.toggle('hidden', !commandModelListOpen);
        commandModelList.innerHTML = '';
        if (!models.length) {
          var empty = document.createElement('div');
          empty.className = 'command-model-option command-model-empty';
          empty.textContent = 'DeepSeek-V4-Flash';
          commandModelList.append(empty);
          return;
        }

        for (var i = 0; i < models.length; i++) {
          var model = models[i];
          var option = document.createElement('button');
          var isSelected = model.id === state.selectedModelId || (!state.selectedModelId && i === 0);
          option.type = 'button';
          option.className = 'command-model-option';
          option.dataset.modelId = model.id;
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', isSelected ? 'true' : 'false');

          var check = document.createElement('span');
          check.className = 'command-model-check';
          check.textContent = isSelected ? '\\u2713' : '';

          var label = document.createElement('span');
          label.className = 'command-model-name';
          label.textContent = getModelDisplayLabel(model);
          label.title = model.label || model.id;

          option.append(check, label);
          commandModelList.append(option);
        }
      }

      function renderCommandSkills() {
        var skills = getSkillItems();
        var activeIds = getActiveSkillIds();
        if (commandSkillsValue) {
          commandSkillsValue.textContent = String(activeIds.length);
        }
        if (commandSkillsButton) {
          commandSkillsButton.setAttribute('aria-expanded', commandSkillListOpen ? 'true' : 'false');
        }
        if (!commandSkillList) { return; }

        commandSkillList.classList.toggle('hidden', !commandSkillListOpen);
        commandSkillList.innerHTML = '';
        if (!commandSkillListOpen) { return; }
        if (!skills.length) {
          var empty = document.createElement('div');
          empty.className = 'reference-menu-empty';
          empty.textContent = t('skillsNone');
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
        commandCreateSkillButton.disabled = Boolean(disabledReason);
        commandCreateSkillButton.title = disabledReason || '';
      }

      function createCommandSkillItem(skill) {
        var active = isSkillActive(skill.id);
        var canUse = Boolean(skill.enabled && skill.userInvocable && !skill.unavailableReason);
        var item = document.createElement('div');
        item.className = 'command-skill-item' + (active ? ' is-active' : '') + (!canUse ? ' is-disabled' : '');

        var main = document.createElement('button');
        main.type = 'button';
        main.className = 'command-skill-main';
        main.dataset.skillAction = 'use';
        main.dataset.skillId = skill.id;
        main.disabled = !canUse;

        var copy = document.createElement('span');
        copy.className = 'command-row-main';

        var name = document.createElement('span');
        name.className = 'command-skill-name';
        name.textContent = skill.name || skill.id;
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

        var status = document.createElement('span');
        status.className = 'command-skill-status';
        status.textContent = active
          ? t('skillsActive')
          : canUse ? t('skillsUse') : getSkillUnavailableText(skill);

        main.append(copy, status);

        var actions = document.createElement('div');
        actions.className = 'command-skill-actions';
        actions.append(
          createSkillActionButton(skill, 'open', t('skillsOpen'), false),
          createSkillActionButton(skill, skill.enabled ? 'disable' : 'enable', skill.enabled ? t('skillsDisable') : t('skillsEnable'), false),
          createSkillActionButton(skill, 'implicit', skill.allowImplicit ? t('skillsManualOnly') : t('skillsAllowAuto'), !skill.enabled)
        );

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
        button.disabled = Boolean(disabled);
        return button;
      }

      function formatSkillMeta(skill) {
        var parts = [
          skill.sourceLabel || skill.source || '',
          skill.enabled ? t('skillsEnabled') : t('skillsDisabled'),
          skill.allowImplicit ? t('skillsAllowAuto') : t('skillsManualOnly')
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
          return t('skillsUnavailable');
        }
        if (!skill.enabled) {
          return t('skillsDisabled');
        }
        return t('skillsUnavailable');
      }

      function handleSkillAction(action, skillId) {
        var skill = getSkillById(skillId);
        if (!skill) { return; }
        if (action === 'use') {
          if (!skill.enabled || !skill.userInvocable || skill.unavailableReason) {
            return;
          }
          insertSkillChip(skill);
          if (!isSkillActive(skillId)) {
            vscode.postMessage({ type: 'useSkill', skillId: skillId });
          }
          setComposerStatus(t('skillInserted', { name: skill.name || skillId }));
          closeCommandMenu();
          return;
        }
        if (action === 'open') {
          vscode.postMessage({ type: 'openSkill', skillId: skillId });
          return;
        }
        if (action === 'enable' || action === 'disable') {
          vscode.postMessage({ type: 'setSkillEnabled', skillId: skillId, enabled: action === 'enable' });
          return;
        }
        if (action === 'implicit') {
          vscode.postMessage({ type: 'setSkillAllowImplicit', skillId: skillId, allowImplicit: !skill.allowImplicit });
        }
      }

      function getSelectedModel(models) {
        if (!models.length) { return null; }
        for (var i = 0; i < models.length; i++) {
          if (models[i].id === state.selectedModelId) {
            return { model: models[i], index: i };
          }
        }
        return { model: models[0], index: 0 };
      }

      function getModelDisplayLabel(model) {
        if (!model) { return 'DeepSeek-V4-Flash'; }
        return model.label || model.id || 'Model';
      }

      function renderEffort() {
        var settings = getAgentSettings();
        if (commandThinkingToggle) {
          commandThinkingToggle.checked = settings.thinkingEnabled;
        }
        if (commandEffortSlider) {
          commandEffortSlider.value = settings.reasoningEffort === 'max' ? '2' : '1';
          commandEffortSlider.disabled = !settings.thinkingEnabled;
        }
        if (commandEffortValue) {
          commandEffortValue.textContent = settings.thinkingEnabled ? effortLabels[settings.reasoningEffort] : t('off');
        }
      }

      function updateAgentSettingsFromControls() {
        var settings = readAgentSettingsFromControls();
        state.agentSettings = settings;
        vscode.postMessage({ type: 'setAgentSettings', settings: settings });
      }

      function readAgentSettingsFromControls() {
        return {
          thinkingEnabled: commandThinkingToggle ? commandThinkingToggle.checked : getAgentSettings().thinkingEnabled,
          reasoningEffort: commandEffortSlider && Number(commandEffortSlider.value) >= 2 ? 'max' : 'high'
        };
      }

      function getAgentSettings() {
        var configured = state.agentSettings || {};
        return {
          thinkingEnabled: typeof configured.thinkingEnabled === 'boolean' ? configured.thinkingEnabled : true,
          reasoningEffort: configured.reasoningEffort === 'max' ? 'max' : 'high'
        };
      }

      function getSkillTrigger() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) { return null; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range) || isPromptRangeInsideMarkdownFence(range)) { return null; }
        var textBefore = getTextBeforeRange(range);
        var triggerIndex = findSkillTriggerIndex(textBefore);
        if (triggerIndex < 0) { return null; }
        var skillRange = getPromptTextRange(triggerIndex, textBefore.length);
        if (!skillRange) { return null; }
        return {
          range: skillRange,
          query: textBefore.slice(triggerIndex + 1)
        };
      }

      function findSkillTriggerIndex(textBefore) {
        for (var i = textBefore.length - 1; i >= 0; i--) {
          var character = textBefore.charAt(i);
          if (character === '$') {
            var previous = i > 0 ? textBefore.charAt(i - 1) : '';
            return !previous || isWhitespace(previous) ? i : -1;
          }
          if (isSkillTerminator(character)) {
            return -1;
          }
        }
        return -1;
      }

      function isSkillTerminator(character) {
        return character === '<' || character === '>' || character === String.fromCharCode(10) || character === String.fromCharCode(13) || isWhitespace(character);
      }

      function getMentionTrigger() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) { return null; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range)) { return null; }
        var textBefore = getTextBeforeRange(range);
        var triggerIndex = findMentionTriggerIndex(textBefore);
        if (triggerIndex < 0) { return null; }
        var mentionRange = getPromptTextRange(triggerIndex, textBefore.length);
        if (!mentionRange) { return null; }
        return {
          range: mentionRange,
          query: textBefore.slice(triggerIndex + 1)
        };
      }

      function findMentionTriggerIndex(textBefore) {
        for (var i = textBefore.length - 1; i >= 0; i--) {
          var character = textBefore.charAt(i);
          if (character === '@') {
            return i;
          }
          if (isMentionTerminator(character)) {
            return -1;
          }
        }
        return -1;
      }

      function isMentionTerminator(character) {
        return character === '<' || character === '>' || character === String.fromCharCode(10) || character === String.fromCharCode(13) || isWhitespace(character);
      }

      function getPromptTextRange(startOffset, endOffset) {
        var range = document.createRange();
        var cursor = 0;
        var startSet = false;
        var endSet = false;

        function visit(node) {
          if (endSet) { return; }
          if (node.nodeType === Node.TEXT_NODE) {
            var text = node.nodeValue || '';
            var nextCursor = cursor + text.length;
            if (!startSet && startOffset <= nextCursor) {
              range.setStart(node, Math.max(0, startOffset - cursor));
              startSet = true;
            }
            if (!endSet && endOffset <= nextCursor) {
              range.setEnd(node, Math.max(0, endOffset - cursor));
              endSet = true;
            }
            cursor = nextCursor;
            return;
          }

          if (node.nodeType !== Node.ELEMENT_NODE) { return; }
          var element = node;
          if (element.tagName === 'BR') {
            if (!startSet && startOffset <= cursor) {
              range.setStartBefore(element);
              startSet = true;
            }
            if (!endSet && endOffset <= cursor) {
              range.setEndBefore(element);
              endSet = true;
            }
            cursor += 1;
            return;
          }

          var child = node.firstChild;
          while (child) {
            visit(child);
            if (endSet) { return; }
            child = child.nextSibling;
          }
        }

        visit(promptInput);
        if (!startSet) {
          range.selectNodeContents(promptInput);
          range.collapse(false);
        }
        if (!endSet) {
          range.setEnd(range.startContainer, range.startOffset);
        }
        return range;
      }

      function getCharacterRangeBeforeCaret(caretRange, character) {
        if (caretRange.startContainer.nodeType === Node.TEXT_NODE && caretRange.startOffset > 0) {
          var text = caretRange.startContainer.nodeValue || '';
          if (text.charAt(caretRange.startOffset - 1) === character) {
            var range = document.createRange();
            range.setStart(caretRange.startContainer, caretRange.startOffset - 1);
            range.setEnd(caretRange.startContainer, caretRange.startOffset);
            return range;
          }
        }

        var previousTextNode = getPreviousTextNode(caretRange.startContainer, caretRange.startOffset);
        if (!previousTextNode) { return null; }
        var previousText = previousTextNode.nodeValue || '';
        if (!previousText || previousText.charAt(previousText.length - 1) !== character) { return null; }
        var previousRange = document.createRange();
        previousRange.setStart(previousTextNode, previousText.length - 1);
        previousRange.setEnd(previousTextNode, previousText.length);
        return previousRange;
      }

      function getPreviousTextNode(container, offset) {
        if (container.nodeType === Node.ELEMENT_NODE && offset > 0) {
          var child = container.childNodes[offset - 1];
          var last = getLastTextNode(child);
          if (last) { return last; }
        }

        var node = container.nodeType === Node.TEXT_NODE ? container : container.childNodes[offset] || container;
        while (node && node !== promptInput) {
          var sibling = node.previousSibling;
          while (sibling) {
            var textNode = getLastTextNode(sibling);
            if (textNode) { return textNode; }
            sibling = sibling.previousSibling;
          }
          node = node.parentNode;
        }
        return null;
      }

      function getLastTextNode(node) {
        if (!node) { return null; }
        if (node.nodeType === Node.TEXT_NODE) { return node; }
        var child = node.lastChild;
        while (child) {
          var found = getLastTextNode(child);
          if (found) { return found; }
          child = child.previousSibling;
        }
        return null;
      }

      function hasType(dt, name) {
        if (!dt.types) { return false; }
        var expected = name.toLowerCase();
        if (dt.types.contains) {
          return dt.types.contains(name) || dt.types.contains(expected);
        }
        for (var i = 0; i < dt.types.length; i++) {
          if (String(dt.types[i]).toLowerCase() === expected) { return true; }
        }
        return false;
      }

      function addReference(references, seen, value) {
        var reference = normalizeDraggedReference(value);
        if (!reference) { return; }
        var key = makeFileHref(reference);
        if (seen[key]) { return; }
        seen[key] = true;
        references.push(reference);
      }

      function extractFileReferences(dataTransfer, allowPlainTextPaths) {
        var references = [];
        var dt = dataTransfer;
        var seen = Object.create(null);
        if (!dt) { return references; }

        if (dt.files && dt.files.length) {
          for (var i = 0; i < dt.files.length; i++) {
            var filePath = dt.files[i].path;
            if (filePath) {
              addReference(references, seen, filePath);
            }
          }
        }

        if (dt.items && dt.items.length) {
          for (var i1 = 0; i1 < dt.items.length; i1++) {
            var item = dt.items[i1];
            if (item.kind !== 'file' || !item.getAsFile) { continue; }
            var file = item.getAsFile();
            if (file && file.path) {
              addReference(references, seen, file.path);
            }
          }
        }

        if (hasType(dt, 'text/uri-list')) {
          var uriList = dt.getData('text/uri-list');
          if (uriList) {
            addReferenceList(references, seen, uriList);
          }
        }

        if (hasType(dt, 'application/vnd.code.uri-list')) {
          var codeUris = dt.getData('application/vnd.code.uri-list');
          if (codeUris) {
            addReferenceList(references, seen, codeUris);
          }
        }

        if (hasType(dt, 'text/plain')) {
          var text = dt.getData('text/plain');
          addPlainTextReferences(references, seen, text, allowPlainTextPaths !== false);
        }

        return references;
      }

      function extractDroppedFilesWithoutPath(dataTransfer) {
        var files = [];
        var dt = dataTransfer;
        var seen = Object.create(null);
        if (!dt) { return files; }

        function addFile(file) {
          if (!file || file.path) { return; }
          var key = [
            file.name || '',
            String(file.size || 0),
            String(file.lastModified || 0)
          ].join(':');
          if (seen[key]) { return; }
          seen[key] = true;
          files.push(file);
        }

        if (dt.files && dt.files.length) {
          for (var i = 0; i < dt.files.length; i++) {
            addFile(dt.files[i]);
          }
        }

        if (dt.items && dt.items.length) {
          for (var i1 = 0; i1 < dt.items.length; i1++) {
            var item = dt.items[i1];
            if (item.kind !== 'file' || !item.getAsFile) { continue; }
            addFile(item.getAsFile());
          }
        }

        return files;
      }

      function importDroppedFilesWithoutPath(files) {
        setComposerStatus(t('importingDroppedFiles'));
        readDroppedFilePayloads(files).then(function(result) {
          if (result.files.length) {
            vscode.postMessage({ type: 'insertDroppedFileReferences', files: result.files });
            return;
          }
          setComposerStatus(result.skipped > 0
            ? t('droppedFilesTooLarge')
            : t('noReferencePath'));
        }).catch(function() {
          setComposerStatus(t('droppedFilesUnreadable'));
        });
      }

      function readDroppedFilePayloads(files) {
        var skipped = 0;
        var tasks = [];
        var maxBytes = getMaxDroppedFileBytes();
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (!file || !file.name || file.size > maxBytes || !file.arrayBuffer) {
            skipped += 1;
            continue;
          }
          tasks.push(readDroppedFilePayload(file).catch(function() {
            skipped += 1;
            return null;
          }));
        }

        return Promise.all(tasks).then(function(payloads) {
          return {
            files: payloads.filter(function(payload) { return Boolean(payload); }),
            skipped: skipped
          };
        });
      }

      function getMaxDroppedFileBytes() {
        var configured = Number(state.maxFileBytes);
        if (!Number.isFinite(configured) || configured <= 0) {
          return 200000;
        }
        return configured;
      }

      function readDroppedFilePayload(file) {
        return file.arrayBuffer().then(function(buffer) {
          var bytes = new Uint8Array(buffer);
          return {
            name: file.name || 'dropped-file',
            type: file.type || '',
            size: bytes.byteLength,
            lastModified: Number(file.lastModified) || 0,
            dataBase64: bytesToBase64(bytes)
          };
        });
      }

      function bytesToBase64(bytes) {
        var chunkSize = 32768;
        var binary = '';
        for (var i = 0; i < bytes.length; i += chunkSize) {
          var chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        return btoa(binary);
      }

      function addReferenceList(references, seen, value) {
        var entries = splitDragLines(value);
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i].trim();
          if (!entry || entry.charAt(0) === '#') { continue; }
          addReference(references, seen, entry);
        }
      }

      function addPlainTextReferences(references, seen, value, allowPlainTextPaths) {
        if (!value) { return; }
        var entries = splitDragLines(value).map(function (entry) {
          return entry.trim();
        }).filter(function (entry) {
          return entry && entry.charAt(0) !== '#';
        });
        if (!entries.length) { return; }

        for (var i = 0; i < entries.length; i++) {
          var reference = normalizePlainTextReference(entries[i], allowPlainTextPaths);
          if (!reference) { continue; }
          var key = reference.kind === 'directory' ? makeDirectoryHref(reference) : makeFileHref(reference);
          if (seen[key]) { continue; }
          seen[key] = true;
          references.push(reference);
        }
      }

      function splitDragLines(value) {
        return String(value || '')
          .split(String.fromCharCode(13)).join('')
          .split(String.fromCharCode(10));
      }

      function normalizePlainTextReference(value, allowPlainTextPaths) {
        var text = String(value || '').trim().split(String.fromCharCode(0)).join('');
        if (!text) { return null; }
        if (startsWithFileScheme(text)) {
          return fileUriToReference(text);
        }

        var target = getStandaloneBracketReferenceTarget(text);
        if (!target) {
          return allowPlainTextPaths ? normalizeDraggedReference(text) : null;
        }
        if (!isSafePlainFileReferenceTarget(target)) { return null; }
        var directoryPrefix = 'keepseek-dir:';
        if (target.toLowerCase().indexOf(directoryPrefix) === 0) {
          var directoryPath = target.slice(directoryPrefix.length).trim();
          if (!directoryPath) { return null; }
          return { path: directoryPath, kind: 'directory', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
        }
        if (startsWithFileScheme(target)) {
          return fileUriToReference(target);
        }

        var split = splitLineReference(target);
        if (!split.path || isSingleSegmentClosingTagPath(split.path)) { return null; }
        return {
          path: split.path,
          startLine: split.startLine,
          endLine: split.endLine,
          startColumn: split.startColumn,
          endColumn: split.endColumn
        };
      }

      function getStandaloneBracketReferenceTarget(value) {
        var text = String(value || '').trim();
        if (text.length < 3 || text.charAt(0) !== '<' || text.charAt(text.length - 1) !== '>') {
          return '';
        }
        var target = text.slice(1, -1).trim();
        if (!target || target.indexOf('<') >= 0 || target.indexOf('>') >= 0) {
          return '';
        }
        return target;
      }

      function isSafePlainFileReferenceTarget(value) {
        var text = String(value || '').trim();
        if (!text) { return false; }
        if (text.indexOf('"') >= 0 || text.indexOf("'") >= 0 || text.indexOf(String.fromCharCode(96)) >= 0 || /\\s+\\S+=/.test(text)) {
          return false;
        }
        for (var i = 0; i < text.length; i++) {
          var code = text.charCodeAt(i);
          if (code < 32 || code === 127) { return false; }
        }
        return true;
      }

      function normalizeDraggedReference(value) {
        var text = String(value || '').trim().split(String.fromCharCode(0)).join('');
        if (!text) { return null; }
        if (startsWithFileScheme(text)) {
          return fileUriToReference(text);
        }

        var split = splitLineReference(text);
        if (!isAbsolutePath(split.path)) { return null; }
        return {
          path: split.path,
          startLine: split.startLine,
          endLine: split.endLine,
          startColumn: split.startColumn,
          endColumn: split.endColumn
        };
      }

      function startsWithFileScheme(value) {
        return value.toLowerCase().indexOf('file:') === 0;
      }

      function isSingleSegmentClosingTagPath(value) {
        var text = String(value || '').trim();
        if (text.charAt(0) !== '/' || text.indexOf('/', 1) >= 0 || text.indexOf('.') >= 0) {
          return false;
        }
        var name = text.slice(1);
        if (!name) { return false; }
        for (var i = 0; i < name.length; i++) {
          var code = name.charCodeAt(i);
          var allowed = (code >= 48 && code <= 57) ||
            (code >= 65 && code <= 90) ||
            (code >= 97 && code <= 122) ||
            name.charAt(i) === '_' ||
            name.charAt(i) === '-' ||
            name.charAt(i) === ':';
          if (!allowed) { return false; }
        }
        return true;
      }

      function splitLineReference(value) {
        for (var i = value.length - 1; i >= 0; i--) {
          if (value.charAt(i) !== '#') { continue; }
          var parsed = parseLineRange(value.slice(i + 1));
          if (parsed.valid) {
            return {
              path: value.slice(0, i),
              startLine: parsed.startLine,
              endLine: parsed.endLine,
              startColumn: parsed.startColumn,
              endColumn: parsed.endColumn
            };
          }
        }
        return { path: value, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }

      function parseLineRange(fragment) {
        var text = String(fragment || '').trim();
        if (!text) {
          return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
        }
        if (text.charAt(0).toLowerCase() === 'l') {
          text = text.slice(1);
        }

        var start = readLeadingInteger(text);
        if (!start.valid) {
          return { valid: false, startLine: 1, endLine: 1, startColumn: 0, endColumn: 0 };
        }

        var startLine = start.value;
        var startColumn = 0;
        var rest = start.rest;

        if (rest.charAt(0).toLowerCase() === 'c') {
          var col = readLeadingInteger(rest.slice(1));
          if (col.valid) {
            startColumn = col.value;
            rest = col.rest;
          }
        }

        if (rest.charAt(0) === '-' || rest.charAt(0) === ',' || rest.charAt(0) === ':') {
          rest = rest.slice(1);
        } else {
          return { valid: true, startLine: startLine, endLine: startLine, startColumn: startColumn, endColumn: startColumn };
        }

        var endLine = startLine;
        var endColumn = 0;

        if (rest.charAt(0).toLowerCase() === 'l') {
          var endLineResult = readLeadingInteger(rest.slice(1));
          if (endLineResult.valid) {
            endLine = endLineResult.value;
            rest = endLineResult.rest;
            if (rest.charAt(0).toLowerCase() === 'c') {
              var endColResult = readLeadingInteger(rest.slice(1));
              if (endColResult.valid) {
                endColumn = endColResult.value;
              }
            }
          }
        } else if (rest.charAt(0).toLowerCase() === 'c') {
          var endColResult = readLeadingInteger(rest.slice(1));
          if (endColResult.valid) {
            endColumn = endColResult.value;
          }
        } else {
          var endResult = readLeadingInteger(rest);
          if (endResult.valid) {
            endLine = endResult.value;
          }
        }

        if (endLine < startLine) {
          endLine = startLine;
        }

        return {
          valid: true,
          startLine: startLine,
          endLine: endLine,
          startColumn: startColumn,
          endColumn: endColumn
        };
      }

      function readLeadingInteger(value) {
        var digits = '';
        for (var i = 0; i < value.length; i++) {
          var code = value.charCodeAt(i);
          if (code < 48 || code > 57) { break; }
          digits += value.charAt(i);
        }
        if (!digits) {
          return { valid: false, value: 0, rest: value };
        }
        return {
          valid: true,
          value: Math.max(1, Number(digits)),
          rest: value.slice(digits.length)
        };
      }

      function isAbsolutePath(value) {
        var slash = '/';
        var backslash = String.fromCharCode(92);
        var first = value.charAt(0);
        var second = value.charAt(1);
        var third = value.charAt(2);
        return (first === slash && second !== slash) ||
          (first === slash && second === slash && third !== slash) ||
          (first === backslash && second === backslash && third !== backslash) ||
          isWindowsDrivePath(value);
      }

      function isWindowsDrivePath(value) {
        if (value.length < 3 || value.charAt(1) !== ':') { return false; }
        var firstCode = value.charCodeAt(0);
        var isLetter = (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
        var separator = value.charAt(2);
        return isLetter && (separator === '/' || separator === String.fromCharCode(92));
      }

      function fileUriToReference(uri) {
        try {
          var url = new URL(uri);
          if (url.protocol !== 'file:') { return null; }
          var pathname = decodeURIComponent(url.pathname);
          var parsed = parseLineRange(url.hash ? url.hash.slice(1) : '');
          var startLine = parsed.valid ? parsed.startLine : 0;
          var endLine = parsed.valid ? parsed.endLine : startLine;
          var startColumn = parsed.valid ? parsed.startColumn : 0;
          var endColumn = parsed.valid ? parsed.endColumn : 0;
          if (url.hostname) {
            return { path: '//' + url.hostname + pathname, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
          }
          if (pathname.charAt(0) === '/' && isWindowsDrivePath(pathname.slice(1))) {
            return { path: pathname.slice(1), startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
          }
          return { path: pathname, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn };
        } catch (error) {
          var split = splitLineReference(uri);
          var fallback = split.path.split('?')[0];
          if (fallback.startsWith('file:///') && isWindowsDrivePath(fallback.slice(8))) {
            return {
              path: decodeURIComponent(fallback.slice(8)),
              startLine: split.startLine,
              endLine: split.endLine,
              startColumn: split.startColumn,
              endColumn: split.endColumn
            };
          }
          if (fallback.startsWith('file://')) {
            return {
              path: decodeURIComponent(fallback.slice(7)),
              startLine: split.startLine,
              endLine: split.endLine,
              startColumn: split.startColumn,
              endColumn: split.endColumn
            };
          }
        }
        return null;
      }

      function createReferenceLink(reference) {
        return reference.kind === 'directory'
          ? createDirectoryReferenceLink(reference)
          : createFileReferenceLink(reference);
      }

      function createFileReferenceLink(reference) {
        return createReferenceLinkElement(reference, { kind: 'file' });
      }

      function createDirectoryReferenceLink(reference) {
        return createReferenceLinkElement(reference, { kind: 'directory' });
      }

      function createSkillLink(skill) {
        var anchor = document.createElement('a');
        anchor.className = 'rich-skill-link';
        anchor.setAttribute('href', getSkillPath(skill));
        anchor.setAttribute('contenteditable', 'false');
        anchor.draggable = false;
        anchor.title = skill.description || skill.name || skill.id;
        anchor.textContent = getSkillPromptText(skill);
        anchor.dataset.skillId = skill.id;
        anchor.dataset.skillPath = getSkillPath(skill);
        return anchor;
      }

      function insertSkillChip(skill) {
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        appendReferenceBoundarySpace(fragment);
        fragment.append(createSkillLink(skill));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range, fragment);
      }

      function removePromptSkillChip(skillId) {
        var links = promptInput.querySelectorAll('a.rich-skill-link');
        links.forEach(function(link) {
          if ((link.dataset.skillId || '') !== skillId) { return; }
          var previous = link.previousSibling;
          var next = link.nextSibling;
          link.remove();
          if (previous && previous.nodeType === Node.TEXT_NODE && !previous.nodeValue.trim()) {
            previous.remove();
          }
          if (next && next.nodeType === Node.TEXT_NODE && !next.nodeValue.trim()) {
            next.remove();
          }
        });
        updatePromptVisualState();
      }

      function refreshPromptSkillLinkLabels() {
        var links = promptInput.querySelectorAll('a.rich-skill-link');
        links.forEach(function(link) {
          var skill = getSkillById(link.dataset.skillId || '');
          if (!skill) {
            link.remove();
            return;
          }
          link.setAttribute('href', getSkillPath(skill));
          link.dataset.skillPath = getSkillPath(skill);
          link.textContent = getSkillPromptText(skill);
          link.title = skill.description || skill.name || skill.id;
        });
      }

      function collectActiveSkillIds() {
        var ids = [];
        var seen = new Set();
        function add(id) {
          var normalized = String(id || '').trim();
          if (!normalized || seen.has(normalized)) { return; }
          seen.add(normalized);
          ids.push(normalized);
        }
        getActiveSkillIds().forEach(add);
        return ids;
      }

      function renderActiveSkillsBar() {
        if (!skillsBar || !skillsBarList) { return; }
        var activeIds = getActiveSkillIds();
        skillsBar.classList.toggle('hidden', activeIds.length === 0);
        skillsBarList.innerHTML = '';
        for (var i = 0; i < activeIds.length; i++) {
          var skill = getSkillById(activeIds[i]);
          if (!skill) { continue; }
          skillsBarList.append(createSkillPill(skill));
        }
      }

      function createSkillPill(skill) {
        var pill = document.createElement('span');
        pill.className = 'skill-pill';
        pill.title = skill.description || skill.name || skill.id;

        var name = document.createElement('span');
        name.className = 'skill-pill-name';
        name.textContent = getSkillPromptText(skill);

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'skill-pill-remove';
        remove.dataset.skillId = skill.id;
        remove.title = t('removeSkill');
        remove.setAttribute('aria-label', t('removeSkill'));
        remove.textContent = '×';

        pill.append(name, remove);
        return pill;
      }

      function getSkillsState() {
        var skills = state.skills && typeof state.skills === 'object' ? state.skills : {};
        return {
          items: Array.isArray(skills.items) ? skills.items : [],
          activeSkillIds: Array.isArray(skills.activeSkillIds) ? skills.activeSkillIds : [],
          workspaceTrusted: skills.workspaceTrusted !== false
        };
      }

      function getCreateSkillDisabledReason() {
        if (!getSkillsState().workspaceTrusted) {
          return t('createSkillWorkspaceUntrusted');
        }
        if (!Array.isArray(state.workspaceFolders) || !state.workspaceFolders.length) {
          return t('createSkillWorkspaceRequired');
        }
        return '';
      }

      function getSkillItems() {
        return getSkillsState().items;
      }

      function getFilteredSkillMenuItems() {
        var query = normalizeReferenceQuery(activeMentionQuery);
        return getSkillItems().filter(function(skill) {
          if (!isSkillUserSelectable(skill)) { return false; }
          if (!query) { return true; }
          return skillMatchesQuery(skill, query);
        });
      }

      function isSkillUserSelectable(skill) {
        return Boolean(skill && skill.enabled && skill.userInvocable && !skill.unavailableReason);
      }

      function skillMatchesQuery(skill, query) {
        var fields = [
          getSkillMentionName(skill),
          skill.name || '',
          skill.description || '',
          skill.sourceLabel || '',
          skill.source || ''
        ];
        for (var i = 0; i < fields.length; i++) {
          if (normalizeReferenceQuery(fields[i]).indexOf(query) >= 0) {
            return true;
          }
        }
        return false;
      }

      function getActiveSkillIds() {
        var seen = new Set();
        var ids = [];
        getSkillsState().activeSkillIds.forEach(function(id) {
          var normalized = String(id || '').trim();
          if (!normalized || seen.has(normalized)) { return; }
          seen.add(normalized);
          ids.push(normalized);
        });
        return ids;
      }

      function getSkillById(skillId) {
        var skills = getSkillItems();
        for (var i = 0; i < skills.length; i++) {
          if (skills[i].id === skillId) {
            return skills[i];
          }
        }
        return null;
      }

      function isSkillActive(skillId) {
        return getActiveSkillIds().indexOf(skillId) >= 0;
      }

      function getSkillMentionName(skill) {
        var name = String(skill && skill.name || '').trim();
        if (isSafeSkillMentionName(name)) {
          return name;
        }
        var fallback = getSkillDirectoryName(skill);
        if (isSafeSkillMentionName(fallback)) {
          return fallback;
        }
        return 'skill';
      }

      function getSkillPromptText(skill) {
        return '$' + getSkillMentionName(skill);
      }

      function getSkillMarkdownText(skill) {
        return '[' + getSkillPromptText(skill) + '](' + getSkillPath(skill) + ')';
      }

      function getSkillPath(skill) {
        var skillPath = String(skill && skill.skillPath || '').trim();
        if (skillPath) {
          return skillPath;
        }
        var skillUri = String(skill && skill.skillUri || '').trim();
        if (!skillUri) {
          return '';
        }
        try {
          if (skillUri.indexOf('file:') === 0) {
            var url = new URL(skillUri);
            var pathname = decodeURIComponent(url.pathname || '');
            if (url.hostname) {
              return '//' + url.hostname + pathname;
            }
            if (/^\\/[A-Za-z]:\\//.test(pathname)) {
              return pathname.slice(1);
            }
            return pathname || skillUri;
          }
        } catch (error) {
          return skillUri;
        }
        return skillUri;
      }

      function getSkillSourceGroupLabel(skill) {
        return String(skill && skill.sourceLabel || skill && skill.source || t('skillsTitle')).trim() || t('skillsTitle');
      }

      function getSkillDirectoryName(skill) {
        var rootUri = String(skill && skill.rootUri || '');
        var rootPath = rootUri;
        try {
          if (rootUri.indexOf('file:') === 0) {
            rootPath = decodeURIComponent(new URL(rootUri).pathname || rootUri);
          }
        } catch (error) {
          rootPath = rootUri;
        }
        return getReferencePathBasename(rootPath);
      }

      function isSafeSkillMentionName(value) {
        return /^[A-Za-z0-9_-]+$/u.test(String(value || ''));
      }

      function makeFileHref(reference) {
        return makeFileReferenceHref(reference);
      }

      function makeDirectoryHref(reference) {
        return 'keepseek-dir:' + reference.path;
      }

      function getFileName(filePath) {
        var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
        var parts = normalized.split('/');
        return parts[parts.length - 1] || normalized || 'file';
      }

      function getDirectoryName(directoryPath) {
        var name = getFileName(directoryPath);
        return name.charAt(name.length - 1) === '/' ? name : name + '/';
      }

      function insertFileReferences(references) {
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (isPromptRangeInsideMarkdownFence(range)) {
          appendReferenceBoundarySpace(fragment);
          appendPlainReferenceText(fragment, references);
          appendReferenceBoundarySpace(fragment);
          insertFragmentAtRange(range, fragment);
          setComposerStatus(t('insertedFileReferences', { count: references.length }));
          return;
        }
        appendReferenceBoundarySpace(fragment);

        for (var i = 0; i < references.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(createReferenceLink(references[i]));
        }

        appendReferenceBoundarySpace(fragment);

        insertFragmentAtRange(range, fragment);
        setComposerStatus(t('insertedFileReferences', { count: references.length }));
      }

      function appendReferenceBoundarySpace(fragment) {
        fragment.append(document.createTextNode(' '));
      }

      function appendPlainReferenceText(fragment, references) {
        for (var i = 0; i < references.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(document.createTextNode(referenceToPlainText(references[i])));
        }
      }

      function referenceToPlainText(reference) {
        return '<' + (reference.kind === 'directory' ? makeDirectoryHref(reference) : makeFileHref(reference)) + '>';
      }

      function insertPlainText(text) {
        var lines = splitDragLines(text);
        var fragment = document.createDocumentFragment();
        for (var i = 0; i < lines.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(document.createTextNode(lines[i]));
        }
        insertFragmentAtRange(getPromptInsertionRange(), fragment);
      }

      function insertFragmentAtRange(range, fragment) {
        if (!fragment.firstChild) { return; }
        promptShortcutController.deactivateMark();
        var lastNode = fragment.lastChild;
        range.deleteContents();
        range.insertNode(fragment);
        if (lastNode) {
          range.setStartAfter(lastNode);
          range.setEndAfter(lastNode);
        }
        setPromptSelectionRange(range);
        savePromptSelection();
        updatePromptVisualState();
        promptInput.dispatchEvent(new Event('input', { bubbles: true }));
      }

      function getPromptInsertionRange() {
        restorePromptSelection();
        var selection = window.getSelection();
        if (selection && selection.rangeCount) {
          var range = selection.getRangeAt(0);
          if (isRangeInsidePrompt(range)) {
            return range;
          }
        }
        return getPromptEndRange();
      }

      function getPromptStartRange() {
        var range = document.createRange();
        range.selectNodeContents(promptInput);
        range.collapse(true);
        return range;
      }

      function getPromptEndRange() {
        var range = document.createRange();
        range.selectNodeContents(promptInput);
        range.collapse(false);
        return range;
      }

      function setPromptSelectionRange(range) {
        promptInput.focus();
        var selection = window.getSelection();
        if (!selection) { return; }
        selection.removeAllRanges();
        selection.addRange(range);
      }

      function savePromptSelection() {
        if (isPromptEmpty()) {
          var emptyRange = getPromptStartRange();
          savedPromptRange = emptyRange.cloneRange();
          if (isNodeInsidePrompt(document.activeElement) && !isSelectionAtPromptStart()) {
            setPromptSelectionRange(emptyRange);
          }
          return;
        }
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount) { return; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range)) { return; }
        savedPromptRange = range.cloneRange();
      }

      function restorePromptSelection() {
        if (isPromptEmpty()) {
          setPromptSelectionRange(getPromptStartRange());
          return;
        }
        if (!savedPromptRange || !isRangeInsidePrompt(savedPromptRange)) {
          setPromptSelectionRange(getPromptEndRange());
          return;
        }
        setPromptSelectionRange(savedPromptRange);
      }

      function isRangeInsidePrompt(range) {
        return isNodeInsidePrompt(range.commonAncestorContainer);
      }

      function isNodeInsidePrompt(node) {
        if (!node) { return false; }
        if (node === promptInput) { return true; }
        return promptInput.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
      }

      function isSelectionAtPromptStart() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount) { return false; }
        var range = selection.getRangeAt(0);
        return range.collapsed && range.startContainer === promptInput && range.startOffset === 0;
      }

      function getTextBeforeRange(range) {
        var clone = range.cloneRange();
        clone.selectNodeContents(promptInput);
        clone.setEnd(range.startContainer, range.startOffset);
        return clone.toString();
      }

      function isPromptRangeInsideMarkdownFence(range) {
        return isMarkdownFenceOpenAtTextEnd(getTextBeforeRange(range));
      }

      function isMarkdownFenceOpenAtTextEnd(value) {
        var text = String(value || '')
          .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10))
          .split(String.fromCharCode(13)).join(String.fromCharCode(10));
        var lines = text.split(String.fromCharCode(10));
        var openFence = null;
        for (var i = 0; i < lines.length; i++) {
          var fence = parsePlainMarkdownFenceLine(lines[i]);
          if (!openFence) {
            if (fence) {
              openFence = fence;
            }
            continue;
          }
          if (fence && fence.marker === openFence.marker && fence.length >= openFence.length && !fence.language) {
            openFence = null;
          }
        }
        return Boolean(openFence);
      }

      function parsePlainMarkdownFenceLine(line) {
        var text = String(line || '');
        var index = 0;
        while (index < text.length && index < 3 && text.charAt(index) === ' ') {
          index += 1;
        }
        var marker = text.charAt(index);
        var tick = String.fromCharCode(96);
        if (marker !== tick && marker !== '~') {
          return null;
        }
        var length = 0;
        while (text.charAt(index + length) === marker) {
          length += 1;
        }
        if (length < 3) {
          return null;
        }
        return {
          marker: marker,
          length: length,
          language: text.slice(index + length).trim()
        };
      }

      function isWhitespace(value) {
        return !value || value.trim() === '';
      }

      function isInsideDropArea(target) {
        return target instanceof Node && (target === dropArea || dropArea.contains(target));
      }

      function setDragOver(active) {
        dropZone.classList.toggle('drag-over', active);
        promptInput.classList.toggle('drag-over', active);
      }

      function placeCaretFromDropPoint(event) {
        var range = null;
        if (document.caretRangeFromPoint) {
          range = document.caretRangeFromPoint(event.clientX, event.clientY);
        } else if (document.caretPositionFromPoint) {
          var position = document.caretPositionFromPoint(event.clientX, event.clientY);
          if (position) {
            range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
            range.collapse(true);
          }
        }

        if (!range || !isRangeInsidePrompt(range)) {
          range = getPromptEndRange();
        }
        setPromptSelectionRange(range);
        savePromptSelection();
      }

      function serializePrompt() {
        var parts = [];
        appendPromptNode(promptInput, parts);
        return trimLineBreaks(parts.join(''));
      }

      function appendPromptNode(node, parts) {
        if (node.nodeType === Node.TEXT_NODE) {
          parts.push(node.nodeValue || '');
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) { return; }

        var element = node;
        if (element.matches('a.rich-skill-link')) {
          parts.push(skillLinkToText(element));
          return;
        }
        if (element.matches('a.rich-file-link')) {
          parts.push(fileReferenceLinkToText(element));
          return;
        }
        if (element.tagName === 'BR') {
          parts.push(String.fromCharCode(10));
          return;
        }

        var isBlock = element !== promptInput && isBlockElement(element);
        if (isBlock && parts.length && !endsWithLineBreak(parts)) {
          parts.push(String.fromCharCode(10));
        }

        var child = element.firstChild;
        while (child) {
          appendPromptNode(child, parts);
          child = child.nextSibling;
        }

        if (isBlock && !endsWithLineBreak(parts)) {
          parts.push(String.fromCharCode(10));
        }
      }

      function fileReferenceLinkToText(link) {
        var reference = readFileReferenceLink(link);
        if (reference.kind === 'directory') {
          var directoryLabel = getDirectoryName(reference.path);
          return makeStandaloneReferenceText(directoryLabel + ' <' + makeDirectoryHref(reference) + '>');
        }
        if (reference.startLine > 0 && reference.endLine < reference.startLine) {
          reference.endLine = reference.startLine;
        }
        return makeStandaloneReferenceText(formatFileReferenceTextLabel(reference) + String.fromCharCode(10) + '<' + makeFileHref(reference) + '>');
      }

      function skillLinkToText(link) {
        var skill = getSkillById(link.dataset.skillId || '');
        if (skill) {
          return getSkillMarkdownText(skill);
        }
        var text = String(link.textContent || '').trim();
        var label = text.charAt(0) === '$' ? text : '$' + text;
        var skillPath = String(link.dataset.skillPath || link.getAttribute('href') || '').trim();
        return skillPath ? '[' + label + '](' + skillPath + ')' : label;
      }

      function makeStandaloneReferenceText(text) {
        var lineBreak = String.fromCharCode(10);
        return lineBreak + text + lineBreak;
      }

      function collectPromptFileReferences() {
        var references = [];
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          var reference = readFileReferenceLink(link);
          if (reference.path) {
            references.push(reference);
          }
        });
        return references;
      }

      function readFileReferenceLink(link) {
        var kind = link.dataset.kind === 'directory' ? 'directory' : 'file';
        return {
          path: link.dataset.path || '',
          kind: kind,
          startLine: readPositiveInteger(link.dataset.startLine, 0),
          endLine: readPositiveInteger(link.dataset.endLine, 0),
          startColumn: readPositiveInteger(link.dataset.startColumn, 0),
          endColumn: readPositiveInteger(link.dataset.endColumn, 0)
        };
      }

      function isBlockElement(element) {
        var tag = element.tagName;
        return tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'UL' || tag === 'OL';
      }

      function endsWithLineBreak(parts) {
        if (!parts.length) { return false; }
        var last = parts[parts.length - 1];
        return last.charAt(last.length - 1) === String.fromCharCode(10);
      }

      function trimLineBreaks(value) {
        var text = String(value || '');
        while (text.length && isWhitespace(text.charAt(0))) {
          text = text.slice(1);
        }
        while (text.length && isWhitespace(text.charAt(text.length - 1))) {
          text = text.slice(0, -1);
        }
        return text;
      }

      function readPositiveInteger(value, fallback) {
        var number = Number(value);
        if (!Number.isFinite(number) || number < 1) {
          return fallback;
        }
        return Math.floor(number);
      }

      function sanitizePromptContent() {
        sanitizePromptFormatting();
        sanitizePromptLinks();
      }

      function sanitizePromptFormatting() {
        sanitizePromptFormattingNode(promptInput);
      }

      function sanitizePromptFormattingNode(node) {
        var child = node.firstChild;
        while (child) {
          var next = child.nextSibling;
          if (child.nodeType === Node.COMMENT_NODE) {
            child.remove();
            child = next;
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) {
            child = next;
            continue;
          }

          var element = child;
          if (element.matches('a.rich-file-link') || element.matches('a.rich-skill-link')) {
            child = next;
            continue;
          }
          if (element.tagName === 'BR') {
            clearPromptElementAttributes(element);
            child = next;
            continue;
          }
          if (isBlockElement(element)) {
            clearPromptElementAttributes(element);
            sanitizePromptFormattingNode(element);
            child = next;
            continue;
          }

          sanitizePromptFormattingNode(element);
          unwrapPromptFormattingElement(element);
          child = next;
        }
      }

      function clearPromptElementAttributes(element) {
        while (element.attributes.length) {
          element.removeAttribute(element.attributes[0].name);
        }
      }

      function unwrapPromptFormattingElement(element) {
        var parent = element.parentNode;
        if (!parent) { return; }
        while (element.firstChild) {
          parent.insertBefore(element.firstChild, element);
        }
        parent.removeChild(element);
      }

      function sanitizePromptLinks() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          if (link.dataset.kind === 'directory') {
            var directoryPath = link.dataset.path || '';
            var directoryHref = makeDirectoryHref({ path: directoryPath });
            link.className = 'rich-file-link rich-directory-link';
            link.setAttribute('href', directoryHref);
            link.setAttribute('contenteditable', 'false');
            renderFileReferenceLinkLabel(link, { path: directoryPath, kind: 'directory', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 });
            link.dataset.startLine = '0';
            link.dataset.endLine = '0';
            link.dataset.startColumn = '0';
            link.dataset.endColumn = '0';
            return;
          }
          var startLine = readPositiveInteger(link.dataset.startLine, 0);
          var endLine = startLine === 0 ? 0 : Math.max(startLine, readPositiveInteger(link.dataset.endLine, startLine));
          var startColumn = readPositiveInteger(link.dataset.startColumn, 0);
          var endColumn = readPositiveInteger(link.dataset.endColumn, 0);
          var path = link.dataset.path || '';
          var href = makeFileHref({ path: path, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn });
          link.setAttribute('href', href);
          link.setAttribute('contenteditable', 'false');
          renderFileReferenceLinkLabel(link, { path: path, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn });
        });
        var skillLinks = promptInput.querySelectorAll('a.rich-skill-link');
        skillLinks.forEach(function(link) {
          var skillId = link.dataset.skillId || '';
          var skill = getSkillById(skillId);
          link.className = 'rich-skill-link';
          link.setAttribute('contenteditable', 'false');
          link.draggable = false;
          if (skill) {
            link.setAttribute('href', getSkillPath(skill));
            link.dataset.skillPath = getSkillPath(skill);
            link.textContent = getSkillPromptText(skill);
            link.title = skill.description || skill.name || skill.id;
          } else {
            link.setAttribute('href', link.dataset.skillPath || link.getAttribute('href') || '');
          }
        });
      }

      function refreshPromptFileLinkLabels() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          var reference = readFileReferenceLink(link);
          if (!reference.path) { return; }
          renderFileReferenceLinkLabel(link, reference);
        });
      }

      function updatePromptVisualState() {
        var isEmpty = isPromptEmpty();
        if (isEmpty) {
          normalizeEmptyPrompt();
        }
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
        promptInput.classList.toggle('is-empty', isEmpty);
        renderSendButton(isEmpty);
        renderContextProgress();
      }

      function isPromptEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !promptInput.querySelector('a.rich-skill-link') && !promptInput.textContent.trim();
      }

      function isPromptSubmittableEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !getPromptTextWithoutSkillLinks().trim();
      }

      function getPromptTextWithoutSkillLinks() {
        var clone = promptInput.cloneNode(true);
        if (clone.querySelectorAll) {
          clone.querySelectorAll('a.rich-skill-link').forEach(function(link) {
            link.remove();
          });
        }
        return clone.textContent || '';
      }

      function normalizeEmptyPrompt() {
        if (promptInput.childNodes.length) {
          promptInput.innerHTML = '';
        }
        promptShortcutController.deactivateMark();
        savedPromptRange = null;
        if (isNodeInsidePrompt(document.activeElement) && !isSelectionAtPromptStart()) {
          setPromptSelectionRange(getPromptStartRange());
          savePromptSelection();
        }
      }

      function setComposerStatus(message) {
        transientStatus = message;
        renderStatus();
        if (transientStatusTimer) {
          clearTimeout(transientStatusTimer);
        }
        transientStatusTimer = setTimeout(function() {
          transientStatus = '';
          renderStatus();
        }, 2200);
      }

      function clearPrompt() {
        closeCommandMenu();
        closeReferenceMenu(false);
        promptInput.innerHTML = '';
        promptShortcutController.deactivateMark();
        savedPromptRange = null;
        updatePromptVisualState();
      }

      var settingsOverlay = document.getElementById('settingsDialogOverlay');
      var settingsApiKey = document.getElementById('settingsApiKey');
      var settingsApiKeyVisibilityBtn = document.getElementById('settingsApiKeyVisibilityBtn');
      var settingsBaseUrl = document.getElementById('settingsBaseUrl');
      var historySettingsOverlay = document.getElementById('historySettingsDialogOverlay');
      var historyRetentionDaysInput = document.getElementById('historyRetentionDaysInput');
      var aboutOverlay = document.getElementById('aboutDialogOverlay');
      var aboutProductValue = document.getElementById('aboutProductValue');
      var aboutVersionValue = document.getElementById('aboutVersionValue');
      var aboutAuthorValue = document.getElementById('aboutAuthorValue');
      var aboutLicenseValue = document.getElementById('aboutLicenseValue');
      var aboutRepositoryValue = document.getElementById('aboutRepositoryValue');
      var aboutCopyrightValue = document.getElementById('aboutCopyrightValue');
      var createSkillOverlay = document.getElementById('createSkillDialogOverlay');
      var createSkillDialogStatus = document.getElementById('createSkillDialogStatus');
      var createSkillNameInput = document.getElementById('createSkillNameInput');
      var createSkillDescriptionInput = document.getElementById('createSkillDescriptionInput');
      var createSkillAllowImplicitInput = document.getElementById('createSkillAllowImplicitInput');
      var createSkillUserInvocableInput = document.getElementById('createSkillUserInvocableInput');
      var settingsClearApiKeyBtn = document.getElementById('settingsClearApiKeyBtn');
      var settingsSaveBtn = document.getElementById('settingsSaveBtn');
      var settingsCancelBtn = document.getElementById('settingsCancelBtn');
      var historySettingsSaveBtn = document.getElementById('historySettingsSaveBtn');
      var historySettingsCancelBtn = document.getElementById('historySettingsCancelBtn');
      var aboutCloseBtn = document.getElementById('aboutCloseBtn');
      var createSkillCreateBtn = document.getElementById('createSkillCreateBtn');
      var createSkillCancelBtn = document.getElementById('createSkillCancelBtn');
      var apiKeyVisible = false;
      var defaultHistoryRetentionDays = 7;
      var maxHistoryRetentionDays = 60;

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

      function showSettingsDialog(settings) {
        if (!settingsOverlay || !settingsApiKey || !settingsBaseUrl) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        settingsApiKey.value = values.apiKey || '';
        settingsBaseUrl.value = values.baseUrl || 'https://api.deepseek.com';
        setApiKeyVisible(false, false);
        settingsOverlay.classList.remove('hidden');
        settingsApiKey.focus();
      }

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

      function showAboutDialog() {
        if (!aboutOverlay) { return; }
        var info = getExtensionInfo();
        if (aboutProductValue) {
          aboutProductValue.textContent = info.displayName;
        }
        if (aboutVersionValue) {
          aboutVersionValue.textContent = formatExtensionVersion(info.version);
        }
        if (aboutAuthorValue) {
          aboutAuthorValue.textContent = info.author;
        }
        if (aboutLicenseValue) {
          aboutLicenseValue.textContent = info.license;
        }
        if (aboutRepositoryValue) {
          aboutRepositoryValue.textContent = info.repositoryUrl;
        }
        if (aboutCopyrightValue) {
          aboutCopyrightValue.textContent = 'Copyright (c) 2026 ' + info.author;
        }
        aboutOverlay.classList.remove('hidden');
        if (aboutCloseBtn) {
          aboutCloseBtn.focus();
        }
      }

      function showCreateSkillDialog() {
        var disabledReason = getCreateSkillDisabledReason();
        if (disabledReason) {
          setComposerStatus(disabledReason);
          return;
        }
        if (!createSkillOverlay) { return; }
        if (createSkillNameInput) {
          createSkillNameInput.value = '';
        }
        if (createSkillDescriptionInput) {
          createSkillDescriptionInput.value = '';
        }
        if (createSkillAllowImplicitInput) {
          createSkillAllowImplicitInput.checked = false;
        }
        if (createSkillUserInvocableInput) {
          createSkillUserInvocableInput.checked = true;
        }
        setCreateSkillDialogStatus(t('createSkillDialogDesc'));
        createSkillOverlay.classList.remove('hidden');
        if (createSkillNameInput) {
          createSkillNameInput.focus();
        }
      }

      function setCreateSkillDialogStatus(message) {
        if (createSkillDialogStatus) {
          createSkillDialogStatus.textContent = message || t('createSkillDialogDesc');
        }
      }

      function normalizeIntegerInRange(value, min, max, fallback) {
        var number = Number(value);
        if (!Number.isFinite(number)) {
          return fallback;
        }
        return Math.min(max, Math.max(min, Math.floor(number)));
      }

      function hideSettingsDialog() {
        if (!settingsOverlay) { return; }
        settingsOverlay.classList.add('hidden');
        promptInput.focus();
      }

      function hideHistorySettingsDialog() {
        if (!historySettingsOverlay) { return; }
        historySettingsOverlay.classList.add('hidden');
        promptInput.focus();
      }

      function hideAboutDialog() {
        if (!aboutOverlay) { return; }
        aboutOverlay.classList.add('hidden');
        promptInput.focus();
      }

      function hideCreateSkillDialog(shouldFocusPrompt) {
        if (!createSkillOverlay) { return; }
        createSkillOverlay.classList.add('hidden');
        if (shouldFocusPrompt !== false) {
          promptInput.focus();
        }
      }

      function submitCreateSkillDraft() {
        var disabledReason = getCreateSkillDisabledReason();
        if (disabledReason) {
          setCreateSkillDialogStatus(disabledReason);
          setComposerStatus(disabledReason);
          return;
        }
        var name = createSkillNameInput ? createSkillNameInput.value.trim() : '';
        var description = createSkillDescriptionInput ? createSkillDescriptionInput.value.trim() : '';
        if (!name) {
          setCreateSkillDialogStatus(t('createSkillNameRequired'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        if (/[\\\\x00-\\\\x1f\\\\x7f]/u.test(name) || name.indexOf('..') >= 0 || name.indexOf('/') >= 0 || name.indexOf('\\\\\\\\') >= 0) {
          setCreateSkillDialogStatus(t('createSkillNameInvalid'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        var normalizedName = name.replace(/\\\\s+/gu, '-').replace(/-+/gu, '-').toLowerCase();
        if (!/^[a-z0-9_-]+$/u.test(normalizedName) || !/[a-z0-9]/u.test(normalizedName)) {
          setCreateSkillDialogStatus(t('createSkillNameInvalid'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        if (!description) {
          setCreateSkillDialogStatus(t('createSkillDescriptionRequired'));
          if (createSkillDescriptionInput) { createSkillDescriptionInput.focus(); }
          return;
        }
        vscode.postMessage({
          type: 'createSkillDraft',
          name: name,
          description: description,
          allowImplicit: createSkillAllowImplicitInput ? createSkillAllowImplicitInput.checked : false,
          userInvocable: createSkillUserInvocableInput ? createSkillUserInvocableInput.checked : true
        });
        setCreateSkillDialogStatus(t('createSkillDraftRequested'));
        setComposerStatus(t('createSkillDraftRequested'));
      }

      function onSkillDraftCreated(message) {
        var label = message && typeof message.label === 'string' ? message.label : '';
        hideCreateSkillDialog();
        setComposerStatus(t('createSkillDraftCreatedStatus', { label: label }));
      }

      if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', function() {
          var apiKey = settingsApiKey ? settingsApiKey.value.trim() : '';
          var baseUrl = settingsBaseUrl ? settingsBaseUrl.value.trim() : '';
          if (!baseUrl) {
            baseUrl = 'https://api.deepseek.com';
          }
          vscode.postMessage({
            type: 'saveApiSettings',
            apiKey: apiKey,
            baseUrl: baseUrl
          });
          setComposerStatus(t('apiSettingsSaved'));
          hideSettingsDialog();
        });
      }

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

      if (createSkillCreateBtn) {
        createSkillCreateBtn.addEventListener('click', function() {
          submitCreateSkillDraft();
        });
      }

      if (settingsClearApiKeyBtn) {
        settingsClearApiKeyBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (settingsApiKey) {
            settingsApiKey.value = '';
            settingsApiKey.focus();
          }
          setComposerStatus(t('apiKeyCleared'));
        });
      }

      if (settingsCancelBtn) {
        settingsCancelBtn.addEventListener('click', function() {
          hideSettingsDialog();
        });
      }

      if (historySettingsCancelBtn) {
        historySettingsCancelBtn.addEventListener('click', function() {
          hideHistorySettingsDialog();
        });
      }

      if (aboutCloseBtn) {
        aboutCloseBtn.addEventListener('click', function() {
          hideAboutDialog();
        });
      }

      if (createSkillCancelBtn) {
        createSkillCancelBtn.addEventListener('click', function() {
          hideCreateSkillDialog();
        });
      }

      [createSkillNameInput, createSkillDescriptionInput].forEach(function(input) {
        if (!input) { return; }
        input.addEventListener('input', function() {
          setCreateSkillDialogStatus(t('createSkillDialogDesc'));
        });
      });

      if (settingsApiKeyVisibilityBtn) {
        settingsApiKeyVisibilityBtn.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
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
          }
        });
      }

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

      if (aboutOverlay) {
        aboutOverlay.addEventListener('click', function(event) {
          if (event.target === aboutOverlay) {
            hideAboutDialog();
          }
        });

        aboutOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideAboutDialog();
          }
        });
      }

      if (createSkillOverlay) {
        createSkillOverlay.addEventListener('click', function(event) {
          if (event.target === createSkillOverlay) {
            hideCreateSkillDialog();
          }
        });

        createSkillOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideCreateSkillDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submitCreateSkillDraft();
          }
        });
      }

      document.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }, true);

      document.addEventListener('dragenter', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (isInsideDropArea(e.target)) {
          dragDepth += 1;
          setDragOver(true);
        }
      }, true);

      document.addEventListener('dragleave', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (isInsideDropArea(e.target)) {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0 || !isInsideDropArea(e.relatedTarget)) {
            dragDepth = 0;
            setDragOver(false);
          }
        }
      }, true);

      document.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setDragOver(false);
        dragDepth = 0;

        if (!isInsideDropArea(e.target)) { return; }

        placeCaretFromDropPoint(e);
        var references = extractFileReferences(e.dataTransfer);
        if (references.length) {
          insertFileReferences(references);
          return;
        }

        var droppedFiles = extractDroppedFilesWithoutPath(e.dataTransfer);
        if (droppedFiles.length) {
          importDroppedFilesWithoutPath(droppedFiles);
          return;
        }

        setComposerStatus(t('noReferencePath'));
      }, true);

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'referenceResources') {
          handleReferenceResourcesMessage(msg);
          return;
        }
        if (msg.type !== 'insertFileReference' && msg.type !== 'insertDirectoryReference') return;
        if (
          window.keepseekInlineEditorControls &&
          window.keepseekInlineEditorControls.insertFileReference &&
          window.keepseekInlineEditorControls.insertFileReference(msg)
        ) {
          return;
        }
        var reference = {
          path: msg.path,
          kind: msg.type === 'insertDirectoryReference' ? 'directory' : 'file',
          startLine: msg.startLine || 0,
          endLine: msg.endLine || 0,
          startColumn: msg.startColumn || 0,
          endColumn: msg.endColumn || 0
        };
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (isPromptRangeInsideMarkdownFence(range)) {
          appendReferenceBoundarySpace(fragment);
          fragment.append(document.createTextNode(referenceToPlainText(reference)));
          appendReferenceBoundarySpace(fragment);
          insertFragmentAtRange(range, fragment);
          setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
          return;
        }
        appendReferenceBoundarySpace(fragment);
        fragment.append(createReferenceLink(reference));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range, fragment);
        setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
      });

      window.keepseekInputControls = {
        render: renderInputControls,
        showSettingsDialog: showSettingsDialog,
        showHistorySettingsDialog: showHistorySettingsDialog,
        showAboutDialog: showAboutDialog,
        onSkillDraftCreated: onSkillDraftCreated,
        isPromptSubmittableEmpty: isPromptSubmittableEmpty,
        clearPrompt: clearPrompt
      };
      renderInputControls();
      updatePromptVisualState();
    })();
`;
}
