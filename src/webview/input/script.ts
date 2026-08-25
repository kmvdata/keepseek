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
      var commandCompressionTabs = document.getElementById('commandCompressionTabs');
      var commandCompressionDescription = document.getElementById('commandCompressionDescription');
      var commandSkillsButton = document.getElementById('commandSkillsButton');
      var commandSkillsValue = document.getElementById('commandSkillsValue');
      var commandSkillList = document.getElementById('commandSkillList');
      var commandCreateSkillButton = document.getElementById('commandCreateSkillButton');
      var commandLegacyMemorySection = document.getElementById('commandLegacyMemorySection');
      var commandLegacyMemoryMigrateButton = document.getElementById('commandLegacyMemoryMigrateButton');
      var commandLegacyMemoryExportButton = document.getElementById('commandLegacyMemoryExportButton');
      var commandLegacyMemoryCompleteButton = document.getElementById('commandLegacyMemoryCompleteButton');
      var commandLegacyMemoryRollbackButton = document.getElementById('commandLegacyMemoryRollbackButton');
      var commandLegacyMemoryValue = document.getElementById('commandLegacyMemoryValue');
      var commandBackgroundRunSection = document.getElementById('commandBackgroundRunSection');
      var commandBackgroundRunButton = document.getElementById('commandBackgroundRunButton');
      var commandBackgroundRunValue = document.getElementById('commandBackgroundRunValue');
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
          sourceId: state.selectedSourceId,
          modelId: state.selectedModelId,
          settings: readAgentSettingsFromControls(),
          references: collectPromptFileReferences(),
          skillIds: collectActiveSkillIds()
        });
        state.isBusy = true;
        renderInputControls();
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

      if (contextProgress) {
        // 用量统计界面(popover)通过 hover/focus 弹出;弹出时请求一次余额,
        // 由扩展端 60s 限流保证 1 分钟内只真正发起一次请求。
        contextProgress.addEventListener('mouseenter', function() {
          vscode.postMessage({ type: 'refreshBalance' });
        });
        contextProgress.addEventListener('focus', function() {
          vscode.postMessage({ type: 'refreshBalance' });
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
          // 推理期间引用菜单只读：放行默认行为（Enter 换行 / Tab 移焦），不吞键。
          if (state.isBusy) {
            return;
          }
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
          if (state.isBusy) { return; }
          commandModelListOpen = !commandModelListOpen;
          renderCommandMenu();
        });
      }

      if (commandModelList) {
        commandModelList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-model-id]');
          if (!button || state.isBusy) { return; }
          event.preventDefault();
          event.stopPropagation();
          var modelId = button.dataset.modelId || '';
          var sourceId = button.dataset.sourceId || '';
          if (sourceId && modelId) {
            state.selectedSourceId = sourceId;
            state.selectedModelId = modelId;
            vscode.postMessage({ type: 'setSelectedModel', sourceId: sourceId, modelId: modelId });
          }
          commandModelListOpen = false;
          renderCommandMenu();
          setComposerStatus(t('modelSwitched'));
        });
      }

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

      if (commandSkillsButton) {
        commandSkillsButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (state.isBusy) { return; }
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

      if (commandLegacyMemoryMigrateButton) {
        commandLegacyMemoryMigrateButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (commandLegacyMemoryMigrateButton.disabled) { return; }
          closeCommandMenu();
          vscode.postMessage({ type: 'createLegacyMemoryMigrationDraft' });
        });
      }

      if (commandLegacyMemoryExportButton) {
        commandLegacyMemoryExportButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (commandLegacyMemoryExportButton.disabled) { return; }
          closeCommandMenu();
          vscode.postMessage({ type: 'exportLegacyMemory' });
        });
      }

      if (commandLegacyMemoryCompleteButton) {
        commandLegacyMemoryCompleteButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (commandLegacyMemoryCompleteButton.disabled) { return; }
          closeCommandMenu();
          vscode.postMessage({ type: 'completeLegacyMemoryMigration' });
        });
      }

      if (commandLegacyMemoryRollbackButton) {
        commandLegacyMemoryRollbackButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (commandLegacyMemoryRollbackButton.disabled) { return; }
          closeCommandMenu();
          vscode.postMessage({ type: 'rollbackLegacyMemoryMigration' });
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

      if (skillsBarList) {
        skillsBarList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var removeButton = target?.closest('button[data-skill-id]');
          if (removeButton) {
            event.preventDefault();
            event.stopPropagation();
            if (state.isBusy) { return; }
            var skillId = removeButton.dataset.skillId || '';
            var skill = getSkillById(skillId);
            vscode.postMessage({ type: 'removeActiveSkill', skillId: skillId });
            removePromptSkillChip(skillId);
            setComposerStatus(t('skillRemoved', { name: skill ? skill.name : skillId }));
            return;
          }
          var pill = target?.closest('[data-skill-id]');
          if (!pill) { return; }
          event.preventDefault();
          event.stopPropagation();
          if (state.isBusy) { return; }
          var pillSkillId = pill.dataset.skillId || '';
          var pillSkill = getSkillById(pillSkillId);
          vscode.postMessage({ type: 'openSkill', skillId: pillSkillId });
          setComposerStatus(t('skillOpened', { name: pillSkill ? pillSkill.name : pillSkillId }));
        });
        skillsBarList.addEventListener('keydown', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var pill = target?.closest('[data-skill-id]');
          if (!pill || pill.matches('button')) { return; }
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            if (state.isBusy) { return; }
            var skillId = pill.dataset.skillId || '';
            var skill = getSkillById(skillId);
            vscode.postMessage({ type: 'openSkill', skillId: skillId });
            setComposerStatus(t('skillOpened', { name: skill ? skill.name : skillId }));
          }
        });
      }

      if (commandEffortSlider) {
        commandEffortSlider.addEventListener('input', function() {
          if (state.isBusy) { return; }
          updateAgentSettingsFromControls();
          renderCommandMenu();
        });
      }

      if (commandThinkingToggle) {
        commandThinkingToggle.addEventListener('change', function() {
          if (state.isBusy) { return; }
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
          if (state.isBusy) {
            setComposerStatus(t('referenceFileDisabledWhileBusy'));
            return;
          }
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
          if (event.detail > 1) { return; }
          vscode.postMessage({
            type: 'openSkill',
            skillId: skillLink.dataset.skillId || ''
          });
          return;
        }
        var link = target?.closest('a.rich-file-link');
        if (!link || !promptInput.contains(link)) { return; }

        event.preventDefault();
        event.stopPropagation();
        if (event.detail > 1) { return; }

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
        if (!commandModelSwitch || state.isBusy) { return; }
        commandModelListOpen = true;
        commandSkillListOpen = false;
        renderCommandMenu();
        focusFirstCommandMenuControl(commandModelList);
      }

      function openCommandSkillListAndFocus() {
        if (!commandSkillsButton || state.isBusy) { return; }
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
        // 推理期间引用菜单保持可见但只读，与 "+" 按钮禁用保持一致。
        var isBusy = Boolean(state.isBusy);
        list.querySelectorAll('button[data-reference-index]').forEach(function(button) {
          button.disabled = isBusy;
        });
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

        var icon = createSkillReferenceIcon('reference-menu-item-icon reference-menu-skill-icon');

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
        if (state.isBusy) {
          setComposerStatus(t('referenceFileDisabledWhileBusy'));
          return;
        }
        insertReferenceResourceAtIndex(activeReferenceIndex);
      }

      function insertReferenceResourceAtIndex(index) {
        if (state.isBusy) { return; }
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
        consumeActiveMentionRangeForPicker();
        if (!isSkillActive(skill.id)) {
          vscode.postMessage({ type: 'useSkill', skillId: skill.id });
        }
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
        renderReferenceMenuButton();
        renderSendButton();
        setApiKeyVisible(apiKeyVisible, false);
        if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
          renderAccountSettings();
        }
      }

      function renderReferenceMenuButton() {
        if (!referenceMenuButton) { return; }
        var busy = Boolean(state.isBusy);
        referenceMenuButton.disabled = busy;
        referenceMenuButton.title = busy ? t('referenceFileDisabledWhileBusy') : t('referenceFileTitle');
        referenceMenuButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
        referenceMenuButton.setAttribute('aria-label', busy ? t('referenceFileDisabledWhileBusy') : t('referenceFile'));
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
        var primaryLine = metrics.supportsBilling
          ? ['usageMetricSessionCost', formatMetricCost(
              metrics.sessionUsageStats && metrics.sessionUsageStats.sessionCost,
              getUsageCurrency(metrics.sessionUsageStats, metrics.lastTurnUsage),
              hasUsageData(metrics.sessionUsageStats)
            )]
          : ['usageMetricSessionTokens', formatMetricTokens(
              metrics.sessionUsageStats && metrics.sessionUsageStats.totalTokens,
              hasUsageData(metrics.sessionUsageStats)
            )];
        var items = [
          ['usageMetricTurnHit', formatMetricPercent(calculateHitRate(metrics.lastTurnUsage))],
          ['usageMetricAverageHit', formatMetricPercent(calculateHitRate(metrics.sessionUsageStats))],
          ['usageMetricTurnTokens', formatMetricTokens(metrics.lastTurnUsage && metrics.lastTurnUsage.totalTokens, hasUsageData(metrics.lastTurnUsage))],
          ['usageMetricTurnCount', metrics.turnCount > 0 ? formatMetricInteger(metrics.turnCount) : '-'],
          ['usageMetricCompactThreshold', formatMetricPercent(metrics.contextCompressionTriggerRatio * 100)]
        ];
        if (metrics.supportsBilling) {
          items.splice(2, 0,
            ['usageMetricSessionTokens', formatMetricTokens(metrics.sessionUsageStats && metrics.sessionUsageStats.totalTokens, hasUsageData(metrics.sessionUsageStats))],
            ['usageMetricTurnCost', formatMetricCost(metrics.lastTurnUsage && metrics.lastTurnUsage.cost, getUsageCurrency(metrics.lastTurnUsage, metrics.sessionUsageStats), hasUsageData(metrics.lastTurnUsage))]
          );
          items.push(['usageMetricBalance', formatMetricBalance(metrics.balance)]);
        }
        var label = title + '。' + [contextLine, primaryLine].concat(items).map(function(item) {
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
          renderMetricLineInto(contextProgressTokens, t(primaryLine[0]), primaryLine[1]);
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
          supportsBilling: metrics.supportsBilling === true,
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
        return formatCompactTokenCount(readNonNegativeNumber(value, 0));
      }

      function formatCompactTokenCount(value) {
        var tokens = Math.max(0, Math.floor(Number(value) || 0));
        if (tokens >= 1000000) {
          var millions = Math.floor(tokens / 10000) / 100;
          return millions.toFixed(2) + 'm';
        }
        if (tokens >= 1000) {
          return Math.floor(tokens / 1000) + 'k';
        }
        return String(tokens);
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
        commandMenu.classList.toggle('is-readonly', Boolean(state.isBusy));
        renderCommandModel();
        renderCompressionThreshold();
        renderCommandSkills();
        renderCreateSkillCommand();
        renderLegacyMemoryCommand();
        renderBackgroundRunCommand();
        renderEffort();
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

      function renderCommandModel() {
        var models = Array.isArray(state.models) ? state.models : [];
        var selected = getSelectedModel(models);
        if (commandModelValue) {
          commandModelValue.textContent = selected
            ? getModelSourceLabel(selected.model) + ' / ' + getModelDisplayLabel(selected.model)
            : t('addModel');
          commandModelValue.title = selected && selected.model.id ? selected.model.id : commandModelValue.textContent;
        }

        if (commandModelSwitch) {
          commandModelSwitch.disabled = Boolean(state.isBusy);
          commandModelSwitch.setAttribute('aria-expanded', commandModelListOpen ? 'true' : 'false');
        }
        if (!commandModelList) { return; }

        commandModelList.classList.toggle('hidden', !commandModelListOpen);
        commandModelList.innerHTML = '';
        if (!models.length) {
          var empty = document.createElement('div');
          empty.className = 'command-model-option command-model-empty';
          empty.textContent = t('modelsEmpty');
          commandModelList.append(empty);
          return;
        }

        var previousSourceId = '';
        for (var i = 0; i < models.length; i++) {
          var model = models[i];
          if (model.sourceId !== previousSourceId) {
            var groupLabel = document.createElement('div');
            groupLabel.className = 'command-model-option command-model-empty';
            groupLabel.textContent = getModelSourceLabel(model);
            commandModelList.append(groupLabel);
            previousSourceId = model.sourceId || '';
          }
          var option = document.createElement('button');
          var isSelected = model.sourceId === state.selectedSourceId
            && model.id === state.selectedModelId;
          option.type = 'button';
          option.className = 'command-model-option';
          option.dataset.sourceId = model.sourceId || '';
          option.dataset.modelId = model.id;
          option.disabled = Boolean(state.isBusy);
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', isSelected ? 'true' : 'false');

          var check = document.createElement('span');
          check.className = 'command-model-check';
          check.textContent = isSelected ? '\\u2713' : '';

          var label = document.createElement('span');
          label.className = 'command-model-name';
          label.textContent = getModelDisplayLabel(model);
          label.title = model.id || getModelDisplayLabel(model);
          option.title = model.id || getModelDisplayLabel(model);

          option.append(check, label);
          commandModelList.append(option);
        }
      }

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

      function renderCommandSkills() {
        var skills = getSkillItems();
        var activeIds = getActiveSkillIds();
        if (commandSkillsValue) {
          commandSkillsValue.textContent = String(activeIds.length);
        }
        if (commandSkillsButton) {
          commandSkillsButton.disabled = Boolean(state.isBusy);
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
        commandCreateSkillButton.disabled = Boolean(state.isBusy) || Boolean(disabledReason);
        commandCreateSkillButton.title = state.isBusy ? t('commandMenuReadonlyWhileBusy') : (disabledReason || '');
      }

      function renderLegacyMemoryCommand() {
        var migration = state.legacyMemoryMigration && typeof state.legacyMemoryMigration === 'object'
          ? state.legacyMemoryMigration
          : { detected: false, status: 'pending', entryCount: 0 };
        var visible = migration.detected === true;
        if (commandLegacyMemorySection) {
          commandLegacyMemorySection.classList.toggle('hidden', !visible);
        }
        if (!visible) { return; }
        if (commandLegacyMemoryValue) {
          commandLegacyMemoryValue.textContent = String(Number(migration.entryCount) || 0);
        }
        if (commandLegacyMemoryMigrateButton) {
          commandLegacyMemoryMigrateButton.classList.toggle('hidden', migration.status !== 'pending');
          commandLegacyMemoryMigrateButton.disabled = state.isBusy || migration.canCreateDraft === false;
          commandLegacyMemoryMigrateButton.title = migration.error || '';
        }
        if (commandLegacyMemoryExportButton) {
          commandLegacyMemoryExportButton.disabled = state.isBusy || migration.exportAvailable === false;
        }
        if (commandLegacyMemoryCompleteButton) {
          commandLegacyMemoryCompleteButton.classList.toggle('hidden', migration.status !== 'draft-created');
          commandLegacyMemoryCompleteButton.disabled = state.isBusy || migration.canComplete === false;
          commandLegacyMemoryCompleteButton.title = migration.completeDisabledReason || '';
        }
        if (commandLegacyMemoryRollbackButton) {
          commandLegacyMemoryRollbackButton.classList.toggle(
            'hidden',
            migration.status !== 'completed' && migration.canRollback !== true
          );
          commandLegacyMemoryRollbackButton.disabled = state.isBusy || migration.canRollback === false;
          commandLegacyMemoryRollbackButton.title = migration.rollbackDisabledReason || '';
        }
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
        main.disabled = !canUse || Boolean(state.isBusy);

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
          createSkillActionButton(skill, 'implicit', skill.allowImplicit ? t('skillsManualOnly') : t('skillsAllowAuto'), !skill.enabled),
          createSkillActionButton(skill, 'workspace-default', skill.workspaceDefault ? t('skillsUnsetWorkspaceDefault') : t('skillsSetWorkspaceDefault'), !skill.enabled)
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
        button.disabled = Boolean(disabled) || Boolean(state.isBusy);
        return button;
      }

      function formatSkillMeta(skill) {
        var parts = [
          skill.sourceLabel || skill.source || '',
          skill.enabled ? t('skillsEnabled') : t('skillsDisabled'),
          skill.allowImplicit ? t('skillsAllowAuto') : t('skillsManualOnly'),
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
          return t('skillsUnavailable');
        }
        if (!skill.enabled) {
          return t('skillsDisabled');
        }
        return t('skillsUnavailable');
      }

      function handleSkillAction(action, skillId) {
        if (state.isBusy) { return; }
        var skill = getSkillById(skillId);
        if (!skill) { return; }
        if (action === 'use') {
          if (!skill.enabled || !skill.userInvocable || skill.unavailableReason) {
            return;
          }
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
          return;
        }
        if (action === 'workspace-default') {
          vscode.postMessage({ type: 'setSkillWorkspaceDefault', skillId: skillId, enabled: !skill.workspaceDefault });
        }
      }

      function getSelectedModel(models) {
        if (!models.length) { return null; }
        for (var i = 0; i < models.length; i++) {
          if (models[i].sourceId === state.selectedSourceId && models[i].id === state.selectedModelId) {
            return { model: models[i], index: i };
          }
        }
        return { model: models[0], index: 0 };
      }

      function getModelDisplayLabel(model) {
        if (!model) { return 'DeepSeek-V4-Flash'; }
        return model.fetchedName || model.label || model.id || 'Model';
      }

      function getModelSourceLabel(model) {
        if (!model) { return 'Model'; }
        return model.sourceName || (model.provider === 'anthropic-compatible' ? t('anthropicMessagesCompatible')
          : model.provider === 'openai-responses' ? t('openAiResponsesCompatible')
          : model.provider === 'kimi' ? t('kimiOfficial')
          : model.provider === 'glm' ? t('glmOfficial')
          : model.provider === 'openai-compatible' ? 'OpenAI Compatible'
          : model.provider === 'ollama' ? 'Ollama'
          : 'DeepSeek');
      }

      function renderEffort() {
        var settings = getAgentSettings();
        if (commandThinkingToggle) {
          commandThinkingToggle.checked = settings.thinkingEnabled;
          commandThinkingToggle.disabled = Boolean(state.isBusy);
        }
        if (commandEffortSlider) {
          commandEffortSlider.value = settings.reasoningEffort === 'max' ? '2' : '1';
          commandEffortSlider.disabled = Boolean(state.isBusy) || !settings.thinkingEnabled;
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
        var selectedCompressionTab = commandCompressionTabs
          ? commandCompressionTabs.querySelector('button[data-threshold][aria-selected="true"]')
          : null;
        return {
          thinkingEnabled: commandThinkingToggle ? commandThinkingToggle.checked : getAgentSettings().thinkingEnabled,
          reasoningEffort: commandEffortSlider && Number(commandEffortSlider.value) >= 2 ? 'max' : 'high',
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
        renderSkillReferenceContent(anchor, getSkillMentionName(skill));
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
          renderSkillReferenceContent(link, getSkillMentionName(skill));
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
        promptInput.querySelectorAll('a.rich-skill-link').forEach(function(link) {
          add(link.dataset.skillId || '');
        });
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
        pill.dataset.skillId = skill.id;
        pill.setAttribute('role', 'button');
        pill.tabIndex = 0;
        pill.setAttribute('aria-label', t('openSkillInstruction', { name: skill.name || skill.id }));

        var icon = createSkillReferenceIcon('skill-pill-icon');

        var name = document.createElement('span');
        name.className = 'skill-pill-name';
        name.textContent = getSkillMentionName(skill);

        var remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'skill-pill-remove';
        remove.dataset.skillId = skill.id;
        remove.disabled = Boolean(state.isBusy);
        remove.title = state.isBusy ? t('skillRemoveDisabledWhileBusy') : t('removeSkill');
        remove.setAttribute('aria-label', state.isBusy ? t('skillRemoveDisabledWhileBusy') : t('removeSkill'));
        remove.textContent = '×';

        pill.append(icon, name, remove);
        return pill;
      }

      function getSkillsState() {
        var skills = state.skills && typeof state.skills === 'object' ? state.skills : {};
        return {
          items: Array.isArray(skills.items) ? skills.items : [],
          activeSkillIds: Array.isArray(skills.activeSkillIds) ? skills.activeSkillIds : [],
          workspaceDefaultSkillIds: Array.isArray(skills.workspaceDefaultSkillIds) ? skills.workspaceDefaultSkillIds : [],
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
            renderSkillReferenceContent(link, getSkillMentionName(skill));
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
        // 上限 200 必须与 .rich-input 的 CSS max-height 保持一致；
        // 高度重置会让浏览器 clamp scrollTop（尤其滚动条出现、位于最后一行时），
        // 这里显式恢复滚动位置，避免每次输入视口跳动。
        var prevScrollTop = promptInput.scrollTop;
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
        promptInput.scrollTop = Math.min(prevScrollTop, Math.max(0, promptInput.scrollHeight - promptInput.clientHeight));
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
      var settingsSaveBtn = document.getElementById('settingsSaveBtn');
      var settingsCancelBtn = document.getElementById('settingsCancelBtn');
      var historySettingsSaveBtn = document.getElementById('historySettingsSaveBtn');
      var historySettingsCancelBtn = document.getElementById('historySettingsCancelBtn');
      var aboutCloseBtn = document.getElementById('aboutCloseBtn');
      var createSkillCreateBtn = document.getElementById('createSkillCreateBtn');
      var createSkillCancelBtn = document.getElementById('createSkillCancelBtn');
      var apiKeyVisible = false;
      var settingsSources = [];
      var settingsSelectedSourceId = '';
      var settingsDialogBusyAction = '';
      var settingsDialogBusyTimer = null;
      var settingsDialogDirty = false;
      var settingsOriginalFormSignature = '';
      var settingsRunBusyStatusVisible = false;
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
        return value === 'kimi' || value === 'glm' || value === 'ollama' || value === 'openai-compatible' || value === 'openai-responses' || value === 'anthropic-compatible'
          ? value
          : 'deepseek';
      }

      function getSettingsProviderLabel(provider) {
        return provider === 'anthropic-compatible' ? t('anthropicMessagesCompatible')
          : provider === 'openai-responses' ? t('openAiResponsesCompatible')
          : provider === 'kimi' ? t('kimiOfficial')
          : provider === 'glm' ? t('glmOfficial')
          : provider === 'openai-compatible' ? 'OpenAI compatible'
          : provider === 'ollama' ? 'Ollama'
          : 'DeepSeek';
      }

      function getSettingsProviderLogoUri(provider) {
        return readSettingsString(modelProtocolLogoUris[normalizeSettingsProvider(provider)], '');
      }

      function getSettingsDefaultBaseUrl(provider) {
        return provider === 'deepseek' ? 'https://api.deepseek.com'
          : provider === 'kimi' ? 'https://api.moonshot.cn/v1'
          : provider === 'glm' ? 'https://open.bigmodel.cn/api/paas/v4'
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
          model.enabled = disabledModelIds.indexOf(modelId) < 0;
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
        if (!state.isBusy) { return false; }
        settingsRunBusyStatusVisible = true;
        setSettingsDialogStatus(t('modelSettingsReadonlyWhileBusy'));
        if (settingsDialogStatus) { settingsDialogStatus.focus(); }
        return true;
      }

      function syncAccountSettingsRunBusyStatus(runBusy, operationBusy) {
        if (runBusy && !operationBusy) {
          settingsRunBusyStatusVisible = true;
          setSettingsDialogStatus(t('modelSettingsReadonlyWhileBusy'));
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

      function populateSettingsAccount(account) {
        if (settingsAccountName) {
          settingsAccountName.value = account ? account.name : '';
        }
        if (settingsApiKey) {
          settingsApiKey.value = account ? account.apiKey : '';
        }
        if (settingsBaseUrl) {
          settingsBaseUrl.value = account
            ? account.baseUrl || getSettingsDefaultBaseUrl(account.provider)
            : 'https://api.deepseek.com';
        }
        if (settingsManualModelId) { settingsManualModelId.value = ''; }
        if (settingsManualContextWindow) { settingsManualContextWindow.value = ''; }
        if (settingsManualMaxOutput) { settingsManualMaxOutput.value = ''; }
        if (settingsManualModelBox) { settingsManualModelBox.classList.add('hidden'); }
        settingsOriginalFormSignature = getSettingsFormSignature();
        settingsDialogDirty = false;
      }

      function renderSettingsAccountList(controlsDisabled) {
        if (!settingsAccountList) { return; }
        settingsAccountList.innerHTML = '';
        settingsSources.forEach(function(account) {
          var button = document.createElement('button');
          var selected = account.id === settingsSelectedSourceId;
          var providerLabel = getSettingsProviderLabel(account.provider);
          button.type = 'button';
          button.className = 'settings-account-item';
          button.dataset.sourceId = account.id;
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.setAttribute('aria-label', account.name + ', ' + providerLabel);
          button.disabled = controlsDisabled || !account.enabled;
          button.title = account.name + ' · ' + providerLabel;
          var identity = document.createElement('span');
          identity.className = 'settings-account-item-identity';
          var logoBox = document.createElement('span');
          logoBox.className = 'settings-account-item-logo-box';
          logoBox.setAttribute('aria-hidden', 'true');
          var logoUri = getSettingsProviderLogoUri(account.provider);
          if (logoUri) {
            var logo = document.createElement('img');
            logo.className = 'settings-account-item-logo';
            logo.dataset.provider = account.provider;
            logo.src = logoUri;
            logo.alt = '';
            logo.draggable = false;
            logoBox.append(logo);
          }
          var name = document.createElement('span');
          name.className = 'settings-account-item-name';
          name.textContent = account.name + (account.enabled ? '' : ' (' + t('modelSourceDisabled') + ')');
          identity.append(logoBox, name);
          var check = document.createElement('span');
          check.className = 'settings-account-item-check';
          check.setAttribute('aria-hidden', 'true');
          check.textContent = selected ? '\\u2713' : '';
          button.append(identity, check);
          settingsAccountList.append(button);
        });
      }

      function renderSettingsModelContextEditor(container, model) {
        container.innerHTML = '';
        container.classList.add('is-editing');
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-model-context-input';
        input.min = '0.004';
        input.max = '10000';
        input.step = '0.001';
        input.value = getEditableContextWindowKTokens(model.contextWindowTokens);
        input.setAttribute('aria-label', t('editContextWindowKTokens', { modelId: model.id }));
        var unit = document.createElement('span');
        unit.className = 'settings-model-context-unit';
        unit.textContent = 'K tokens';
        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'settings-model-context-edit-action is-save';
        saveBtn.textContent = '\u2713';
        saveBtn.title = t('saveContextWindow');
        saveBtn.setAttribute('aria-label', t('saveContextWindow'));
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-model-context-edit-action';
        cancelBtn.textContent = '\u00d7';
        cancelBtn.title = t('cancel');
        cancelBtn.setAttribute('aria-label', t('cancel'));

        function cancelEdit() {
          renderAccountSettings();
        }

        function saveEdit() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          var contextWindowTokens = readOptionalContextWindowKTokens(input);
          if (contextWindowTokens === undefined || contextWindowTokens === null) {
            setSettingsDialogStatus(t('contextWindowKTokensInvalid'));
            input.focus();
            input.select();
            return;
          }
          vscode.postMessage({
            type: 'setModelContextWindow',
            sourceId: source.id,
            modelId: model.id,
            contextWindowTokens: contextWindowTokens
          });
          beginSettingsDialogAction('set-model-context-window', t('updatingContextWindow'));
        }

        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', cancelEdit);
        input.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
          }
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            saveEdit();
          }
        });
        container.append(input, unit, saveBtn, cancelBtn);
        input.focus();
        input.select();
      }

      function renderSettingsModelList(account, controlsDisabled) {
        if (!settingsModelList) { return; }
        var models = getSettingsAccountModels(account);
        settingsModelList.innerHTML = '';
        var manualModelIds = account && Array.isArray(account.manualModelIds) ? account.manualModelIds : [];
        models.forEach(function(model) {
          var row = document.createElement('div');
          row.className = 'settings-model-row';
          row.dataset.modelId = model.id;
          var identity = document.createElement('div');
          identity.className = 'settings-model-identity';
          identity.title = model.id;
          var name = document.createElement('span');
          name.className = 'settings-model-name';
          name.textContent = model.id;
          identity.append(name);
          var capabilities = document.createElement('span');
          capabilities.className = 'settings-model-capabilities settings-field-hint';
          if (model.contextWindowTokens) {
            var contextCapability = document.createElement('span');
            contextCapability.className = 'settings-model-capability settings-model-context-capability';
            var contextLabel = document.createElement('span');
            var isEstimated = model.contextWindowSource === 'guessed' || model.contextWindowSource === 'fallback';
            contextLabel.textContent = t('contextWindowTokens')
              + (isEstimated ? ' (' + t('estimatedValue') + ')' : '')
              + ': ';
            var contextValue = document.createElement('button');
            contextValue.type = 'button';
            contextValue.className = 'settings-model-context-value';
            contextValue.textContent = formatContextWindowTokens(model.contextWindowTokens);
            contextValue.disabled = controlsDisabled;
            contextValue.title = t('editContextWindowKTokens', { modelId: model.id });
            contextValue.setAttribute('aria-label', contextValue.title);
            contextValue.addEventListener('click', function() {
              if (blockAccountSettingsWhileRunBusy()) { return; }
              if (settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              renderSettingsModelContextEditor(contextCapability, model);
            });
            contextCapability.append(contextLabel, contextValue);
            capabilities.append(contextCapability);
          }
          if (model.maxOutputTokens) {
            var outputCapability = document.createElement('span');
            outputCapability.className = 'settings-model-capability';
            outputCapability.textContent = t('manualMaxOutputTokens') + ': ' + String(model.maxOutputTokens);
            capabilities.append(outputCapability);
          }
          if (capabilities.childNodes.length) {
            identity.append(capabilities);
          }
          row.append(identity);
          row.classList.toggle('is-disabled', model.enabled === false);
          var actions = document.createElement('div');
          actions.className = 'settings-model-actions';
          var enableLabel = document.createElement('label');
          enableLabel.className = 'settings-model-enable';
          enableLabel.title = t('enableModel', { modelId: model.id });
          var enableCheckbox = document.createElement('input');
          enableCheckbox.type = 'checkbox';
          enableCheckbox.checked = model.enabled !== false;
          enableCheckbox.disabled = controlsDisabled;
          enableCheckbox.setAttribute('aria-label', t('enableModel', { modelId: model.id }));
          enableCheckbox.addEventListener('change', function() {
            var nextEnabled = enableCheckbox.checked;
            function restoreCheckedState() {
              enableCheckbox.checked = !nextEnabled;
            }
            if (blockAccountSettingsWhileRunBusy()) {
              restoreCheckedState();
              return;
            }
            var source = getSettingsActiveAccount();
            if (!source || settingsDialogBusyAction) {
              restoreCheckedState();
              return;
            }
            if (blockSettingsActionForUnsavedChanges()) {
              restoreCheckedState();
              return;
            }
            var disabledModelIds = Array.isArray(source.disabledModelIds)
              ? source.disabledModelIds.slice()
              : [];
            var disabledIndex = disabledModelIds.indexOf(model.id);
            if (nextEnabled && disabledIndex >= 0) {
              disabledModelIds.splice(disabledIndex, 1);
            } else if (!nextEnabled && disabledIndex < 0) {
              disabledModelIds.push(model.id);
            }
            source.disabledModelIds = disabledModelIds;
            vscode.postMessage({
              type: 'setModelEnabled',
              sourceId: source.id,
              modelId: model.id,
              enabled: nextEnabled
            });
            beginSettingsDialogAction('set-model-enabled', t('updatingModelAvailability'));
          });
          enableLabel.append(enableCheckbox);
          actions.append(enableLabel);
          if (manualModelIds.indexOf(model.id) >= 0) {
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'settings-model-delete';
            removeBtn.disabled = controlsDisabled;
            removeBtn.setAttribute('aria-label', t('deleteModel') + ' ' + model.id);
            removeBtn.title = t('deleteModel');
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', function() {
              if (blockAccountSettingsWhileRunBusy()) { return; }
              var source = getSettingsActiveAccount();
              if (!source || settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              vscode.postMessage({
                type: 'deleteModel',
                sourceId: source.id,
                modelId: model.id
              });
              beginSettingsDialogAction('delete-model', t('deletingModel'));
            });
            actions.append(removeBtn);
          }
          row.append(actions);
          settingsModelList.append(row);
        });
        if (settingsModelEmpty) {
          settingsModelEmpty.classList.toggle('hidden', models.length > 0);
        }
      }

      function renderAccountSettings() {
        var account = getSettingsActiveAccount();
        var operationBusy = Boolean(settingsDialogBusyAction);
        var runBusy = Boolean(state.isBusy);
        var controlsDisabled = operationBusy || runBusy;
        if (settingsDialog) {
          settingsDialog.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
        }
        if (settingsAccountSidebar) {
          settingsAccountSidebar.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
          settingsAccountSidebar.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        if (settingsAccountEditor) {
          settingsAccountEditor.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
          settingsAccountEditor.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        syncAccountSettingsRunBusyStatus(runBusy, operationBusy);
        if (settingsDialogTitle) { settingsDialogTitle.textContent = t('modelSettingsDialogTitle'); }
        if (settingsDialogDesc) { settingsDialogDesc.textContent = t('modelSettingsDialogDesc'); }
        if (settingsOverlay) { settingsOverlay.querySelector('.settings-dialog')?.setAttribute('aria-label', t('modelSettingsDialogLabel')); }
        if (settingsAccountsTitle) { settingsAccountsTitle.textContent = t('modelsTitle'); }
        if (settingsCreateAccountBtn) {
          settingsCreateAccountBtn.textContent = t('addAccount');
          settingsCreateAccountBtn.disabled = controlsDisabled;
        }
        if (settingsAccountList) {
          settingsAccountList.setAttribute('aria-label', t('modelSourceListLabel'));
          settingsAccountList.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        if (settingsAccountEmpty) {
          settingsAccountEmpty.textContent = t('modelSourceListEmpty');
          settingsAccountEmpty.classList.toggle('hidden', settingsSources.length > 0);
        }
        if (settingsCurrentAccountTitle) {
          settingsCurrentAccountTitle.textContent = account ? t('modelSourceTitle') : t('addAccount');
        }
        if (settingsCurrentProvider) { settingsCurrentProvider.textContent = account ? getSettingsProviderLabel(account.provider) : ''; }
        if (settingsDeleteAccountBtn) {
          settingsDeleteAccountBtn.textContent = settingsDialogBusyAction === 'delete' ? t('waitingForDeleteConfirmation') : t('deleteModelSource');
          settingsDeleteAccountBtn.disabled = !account || controlsDisabled;
        }
        if (settingsAccountEditorEmpty) { settingsAccountEditorEmpty.classList.add('hidden'); }
        if (settingsAccountFields) { settingsAccountFields.classList.remove('hidden'); }
        if (settingsAccountNameLabel) { settingsAccountNameLabel.textContent = t('modelSourceName'); }
        if (settingsAccountName) {
          var sourceNameField = settingsAccountName.closest('label');
          if (sourceNameField) { sourceNameField.classList.remove('hidden'); }
        }
        if (settingsModelsTitle) { settingsModelsTitle.textContent = t('modelListTitle'); }
        if (settingsModelsHint) { settingsModelsHint.textContent = t('modelListHint'); }
        if (settingsRefreshModelsBtn) {
          settingsRefreshModelsBtn.textContent = settingsDialogBusyAction === 'refresh-models' ? t('refreshingModels') : t('refreshModels');
          settingsRefreshModelsBtn.disabled = !account || controlsDisabled;
        }
        if (settingsModelEmpty) { settingsModelEmpty.textContent = t('modelsEmpty'); }
        if (settingsManualModelIdLabel) { settingsManualModelIdLabel.textContent = t('manualModelId'); }
        if (settingsManualContextWindowLabel) { settingsManualContextWindowLabel.textContent = t('manualContextWindowTokens'); }
        if (settingsManualMaxOutputLabel) { settingsManualMaxOutputLabel.textContent = t('manualMaxOutputTokens'); }
        if (settingsAddModelBtn) {
          settingsAddModelBtn.disabled = !account || controlsDisabled;
        }
        if (settingsConfirmAddModelBtn) {
          settingsConfirmAddModelBtn.disabled = !account || controlsDisabled;
        }
        [settingsAccountName, settingsApiKey, settingsBaseUrl, settingsApiKeyVisibilityBtn, settingsSaveBtn, settingsManualModelId, settingsManualContextWindow, settingsManualMaxOutput, settingsConfirmAddModelBtn].forEach(function(control) {
          if (control) { control.disabled = controlsDisabled; }
        });
        if (settingsSaveBtn) { settingsSaveBtn.textContent = account ? t('save') : t('addAccount'); }
        if (settingsCancelBtn) { settingsCancelBtn.disabled = operationBusy; }
        renderSettingsAccountList(controlsDisabled);
        renderSettingsModelList(account, controlsDisabled);
      }

      function showSettingsDialog(settings) {
        if (!settingsOverlay || !settingsApiKey || !settingsBaseUrl) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        var rawSources = Array.isArray(values.sources) ? values.sources : [];
        var rawSources = Array.isArray(values.sources) ? values.sources : [];
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
        if (settingsDialogBusyAction) {
          setSettingsDialogStatus(t('modelOperationStillPending'));
          return;
        }
        clearSettingsDialogBusy();
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
        if (state.isBusy) {
          setCreateSkillDialogStatus(t('commandMenuReadonlyWhileBusy'));
          return;
        }
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
          var maxOutputTokens = readOptionalCapabilityInput(settingsManualMaxOutput, 1000000);
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
          updateSettingsDialogDirtyState();
          if (!settingsDialogBusyAction) {
            setSettingsDialogStatus('');
          }
        });
      });

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
