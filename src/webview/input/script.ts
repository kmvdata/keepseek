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
      var commandEffortSlider = document.getElementById('commandEffortSlider');
      var commandEffortValue = document.getElementById('commandEffortValue');
      var commandThinkingToggle = document.getElementById('commandThinkingToggle');
      var contextProgress = document.getElementById('contextProgress');
      var contextProgressTitle = document.getElementById('contextProgressTitle');
      var contextProgressPercent = document.getElementById('contextProgressPercent');
      var contextProgressTokens = document.getElementById('contextProgressTokens');
      var contextProgressBreakdown = document.getElementById('contextProgressBreakdown');
      var referenceMenu = document.getElementById('referenceMenu');
      var commandMenuOpen = false;
      var commandModelListOpen = false;
      var referenceMenuOpen = false;
      var referenceMenuSource = '';
      var activeSlashRange = null;
      var activeMentionRange = null;
      var activeMentionQuery = '';
      var activeReferenceIndex = 0;
      var referenceResources = [];
      var referenceResourcesLoading = false;
      var referenceResourcesLoaded = false;
      var referenceResourcesError = '';
      var referenceResourceRequestSequence = 0;
      var referenceResourceRequestId = '';
      var promptUsageRequestSequence = 0;
      var promptUsageRequestId = '';
      var promptUsageRequestPrompt = '';
      var promptUsageRequestTimer = null;
      var promptUsageOverride = null;
      var promptUsageBaseKey = '';
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
          references: collectPromptFileReferences()
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
          activeSlashRange = null;
          toggleCommandMenu();
          if (commandMenuOpen) {
            promptInput.focus();
          }
        });
      }

      if (commandModelSwitch) {
        commandModelSwitch.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          consumeSlashTrigger(false);
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
          consumeSlashTrigger(false);
          commandModelListOpen = false;
          renderCommandMenu();
          setComposerStatus(t('modelSwitched'));
        });
      }

      if (commandEffortSlider) {
        commandEffortSlider.addEventListener('input', function() {
          consumeSlashTrigger(false);
          updateAgentSettingsFromControls();
          renderCommandMenu();
        });
      }

      if (commandThinkingToggle) {
        commandThinkingToggle.addEventListener('change', function() {
          consumeSlashTrigger(false);
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
        activeSlashRange = null;
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

      function syncReferenceMenuFromPrompt() {
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
          referenceMenuButton.classList.add('is-active');
          referenceMenuButton.setAttribute('aria-expanded', 'true');
        }
        requestReferenceResources();
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
        title.textContent = t('referenceFilesTitle');
        var count = document.createElement('span');
        count.className = 'reference-menu-count';
        header.append(title, count);
        referenceMenu.append(header);

        if (referenceResourcesLoading && !referenceResourcesLoaded) {
          count.textContent = t('loading');
          var loadingEntries = referenceMenuSource === 'button' ? [createExternalPickerReferenceEntry()] : [];
          if (loadingEntries.length) {
            appendReferenceMenuEntries(loadingEntries);
          }
          appendReferenceMenuNotice(t('loadingWorkspaceFiles'));
          return;
        }

        if (referenceResourcesError) {
          var errorEntries = referenceMenuSource === 'button' ? [createExternalPickerReferenceEntry()] : [];
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
          appendReferenceMenuNotice(activeMentionQuery ? t('noMatchingFiles') : t('noReferenceFiles'));
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
        for (var i = 0; i < entries.length; i++) {
          list.append(createReferenceMenuEntryButton(entries[i], i));
        }
        referenceMenu.append(list);
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
        return createReferenceResourceButton(entry.resource, index);
      }

      function createExternalPickerReferenceButton(index) {
        var option = document.createElement('button');
        option.type = 'button';
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

      function getFilteredReferenceResources() {
        var query = normalizeReferenceQuery(activeMentionQuery);
        if (!query) {
          return referenceResources.slice();
        }
        return referenceResources.filter(function(resource) {
          return resourceMatchesReferenceQuery(resource, query);
        });
      }

      function getReferenceMenuEntries() {
        var resources = getFilteredReferenceResources().map(function(resource) {
          return { kind: 'resource', resource: resource };
        });
        if (!shouldShowExternalPickerReferenceEntry()) {
          return resources;
        }

        var picker = createExternalPickerReferenceEntry();
        if (referenceMenuSource === 'button') {
          return [picker].concat(resources);
        }
        return resources.concat(picker);
      }

      function shouldShowExternalPickerReferenceEntry() {
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
        var entries = getReferenceMenuEntries();
        if (!entries.length) { return; }
        activeReferenceIndex = (activeReferenceIndex + delta + entries.length) % entries.length;
        renderReferenceMenu();
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
        syncPromptUsageBase();
        refreshPromptFileLinkLabels();
        schedulePromptUsageEstimate();
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
        sendButton.disabled = !isAbortMode && (typeof isEmpty === 'boolean' ? isEmpty : isPromptEmpty());
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
        var usage = getContextUsageWithPrompt();
        var usedPercent = clampNumber(usage.usedPercent, 0, 100);
        var remainingPercent = clampNumber(usage.remainingPercent, 0, 100);
        var displayUsedPercent = formatPercent(usedPercent);
        var displayRemainingPercent = formatPercent(remainingPercent);
        var angle = usedPercent * 3.6;
        var title = t('contextWindowEstimateTitle');
        var percentLine = t('contextWindowPercentLine', {
          usedPercent: displayUsedPercent,
          remainingPercent: displayRemainingPercent
        });
        var tokensLine = t('contextWindowTokensLine', {
          usedTokens: formatTokenCount(usage.usedTokensEstimate),
          maxTokens: formatTokenCount(usage.maxTokensEstimate)
        });
        var label = t('contextWindowProgressLabel', {
          usedPercent: displayUsedPercent,
          remainingPercent: displayRemainingPercent,
          usedTokens: formatTokenCount(usage.usedTokensEstimate),
          maxTokens: formatTokenCount(usage.maxTokensEstimate)
        });

        contextProgress.style.setProperty('--context-progress-angle', angle + 'deg');
        contextProgress.classList.toggle('is-warning', usedPercent >= 70 && usedPercent < 90);
        contextProgress.classList.toggle('is-danger', usedPercent >= 90);
        contextProgress.setAttribute('aria-label', label);
        if (contextProgressTitle) { contextProgressTitle.textContent = title; }
        if (contextProgressPercent) { contextProgressPercent.textContent = percentLine; }
        if (contextProgressTokens) { contextProgressTokens.textContent = tokensLine; }
        if (contextProgressBreakdown) {
          contextProgressBreakdown.textContent = formatContextUsageBreakdown(usage.breakdown || {});
          contextProgressBreakdown.classList.toggle('hidden', !contextProgressBreakdown.textContent);
        }
      }

      function getContextUsageWithPrompt() {
        var usage = normalizeContextUsage(state.contextUsage);
        if ((state.contextUsageSessionId || state.activeSessionId || '') !== (state.activeSessionId || '')) {
          usage = normalizeContextUsage({ maxTokensEstimate: usage.maxTokensEstimate });
        }
        if (state.isBusy) {
          return usage;
        }
        var prompt = serializePrompt();
        if (
          promptUsageOverride &&
          promptUsageOverride.prompt === prompt &&
          promptUsageOverride.activeSessionId === (state.activeSessionId || '') &&
          promptUsageOverride.modelId === (state.selectedModelId || '')
        ) {
          return normalizeContextUsage(promptUsageOverride.contextUsage);
        }
        var inputTokensEstimate = estimatePromptTokens(serializePrompt());
        var usedTokensEstimate = Math.max(0, usage.usedTokensEstimate + inputTokensEstimate);
        var maxTokensEstimate = Math.max(1, usage.maxTokensEstimate);
        var usedPercent = Math.min(100, (usedTokensEstimate / maxTokensEstimate) * 100);
        var breakdown = Object.assign({}, usage.breakdown || {}, {
          inputTokensEstimate: inputTokensEstimate
        });
        return {
          usedTokensEstimate: usedTokensEstimate,
          maxTokensEstimate: maxTokensEstimate,
          remainingTokensEstimate: Math.max(0, maxTokensEstimate - usedTokensEstimate),
          usedPercent: usedPercent,
          remainingPercent: Math.max(0, 100 - usedPercent),
          breakdown: breakdown
        };
      }

      function syncPromptUsageBase() {
        var nextKey = getPromptUsageBaseKey();
        if (nextKey === promptUsageBaseKey) { return; }
        promptUsageBaseKey = nextKey;
        resetPromptUsageEstimate();
      }

      function getPromptUsageBaseKey() {
        var usage = normalizeContextUsage(state.contextUsage);
        return [
          state.activeSessionId || '',
          state.contextUsageSessionId || '',
          state.selectedModelId || '',
          usage.usedTokensEstimate,
          usage.maxTokensEstimate,
          JSON.stringify(usage.breakdown || {})
        ].join('|');
      }

      function resetPromptUsageEstimate() {
        promptUsageOverride = null;
        promptUsageRequestId = '';
        promptUsageRequestPrompt = '';
        if (promptUsageRequestTimer) {
          clearTimeout(promptUsageRequestTimer);
          promptUsageRequestTimer = null;
        }
      }

      function schedulePromptUsageEstimate() {
        if (state.isBusy) { return; }
        var prompt = serializePrompt();
        if (!shouldRequestExpandedPromptUsage(prompt)) {
          resetPromptUsageEstimate();
          return;
        }
        if (promptUsageOverride && promptUsageOverride.prompt === prompt) { return; }
        if (promptUsageRequestPrompt === prompt && promptUsageRequestId) { return; }
        if (promptUsageRequestTimer) {
          clearTimeout(promptUsageRequestTimer);
        }
        promptUsageRequestTimer = setTimeout(function() {
          promptUsageRequestTimer = null;
          var currentPrompt = serializePrompt();
          if (!shouldRequestExpandedPromptUsage(currentPrompt)) { return; }
          promptUsageRequestSequence += 1;
          promptUsageRequestId = 'prompt-usage-' + promptUsageRequestSequence;
          promptUsageRequestPrompt = currentPrompt;
          vscode.postMessage({
            type: 'estimatePromptContextUsage',
            requestId: promptUsageRequestId,
            prompt: currentPrompt,
            modelId: state.selectedModelId,
            activeSessionId: state.activeSessionId,
            references: collectPromptFileReferences()
          });
        }, 180);
      }

      function shouldRequestExpandedPromptUsage(prompt) {
        if (!String(prompt || '').trim()) { return false; }
        if (promptInput.querySelector('a.rich-file-link')) { return true; }
        return /<[^<>\\n]+>/u.test(String(prompt || ''));
      }

      function handlePromptContextUsageEstimate(message) {
        if (!message || message.requestId !== promptUsageRequestId) { return; }
        if ((message.activeSessionId || '') !== (state.activeSessionId || '')) { return; }
        var currentPrompt = serializePrompt();
        if (currentPrompt !== promptUsageRequestPrompt || currentPrompt !== message.prompt) { return; }
        promptUsageOverride = {
          prompt: currentPrompt,
          activeSessionId: state.activeSessionId || '',
          modelId: state.selectedModelId || '',
          contextUsage: message.contextUsage
        };
        renderContextProgress();
      }

      function formatContextUsageBreakdown(breakdown) {
        var parts = [
          formatBreakdownPart('contextUsageSystem', breakdown.systemTokensEstimate),
          formatBreakdownPart('contextUsageContextFiles', breakdown.contextFileTokensEstimate),
          formatBreakdownPart('contextUsageHistory', breakdown.historyTokensEstimate),
          formatBreakdownPart('contextUsageInput', breakdown.inputTokensEstimate),
          formatBreakdownPart('contextUsageToolSchema', breakdown.toolSchemaTokensEstimate),
          formatBreakdownPart('contextUsageToolCalls', breakdown.toolCallTokensEstimate),
          formatBreakdownPart('contextUsageToolResults', breakdown.toolResultTokensEstimate),
          formatBreakdownPart('contextUsageReasoning', breakdown.reasoningTokensEstimate),
          formatBreakdownPart('contextUsageOutputReserve', breakdown.outputReserveTokensEstimate),
          formatBreakdownPart('contextUsageSafetyReserve', breakdown.safetyReserveTokensEstimate)
        ].filter(Boolean);
        return parts.join(' · ');
      }

      function formatBreakdownPart(labelKey, value) {
        var tokens = Math.max(0, Math.floor(Number(value) || 0));
        if (!tokens) { return ''; }
        return t(labelKey) + ' ' + formatTokenCount(tokens);
      }

      function estimatePromptTokens(value) {
        var text = String(value || '').trim();
        return text ? estimateTokenCount('user\\n' + text) + 4 : 0;
      }

      function normalizeContextUsage(value) {
        var usage = value && typeof value === 'object' ? value : {};
        var maxTokensEstimate = readFiniteNumber(usage.maxTokensEstimate, 1000000);
        var usedTokensEstimate = readFiniteNumber(usage.usedTokensEstimate, 0);
        return {
          usedTokensEstimate: Math.max(0, Math.floor(usedTokensEstimate)),
          maxTokensEstimate: Math.max(1, Math.floor(maxTokensEstimate)),
          remainingTokensEstimate: Math.max(0, Math.floor(readFiniteNumber(usage.remainingTokensEstimate, maxTokensEstimate - usedTokensEstimate))),
          usedPercent: readFiniteNumber(usage.usedPercent, maxTokensEstimate ? (usedTokensEstimate / maxTokensEstimate) * 100 : 0),
          remainingPercent: readFiniteNumber(usage.remainingPercent, 100),
          breakdown: usage.breakdown && typeof usage.breakdown === 'object' ? usage.breakdown : {}
        };
      }

      function readBreakdownTokenEstimate(usage, key) {
        return readFiniteNumber(usage.breakdown ? usage.breakdown[key] : 0, 0);
      }

      function readFiniteNumber(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) ? number : fallback;
      }

      function clampNumber(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
      }

      function estimateTokenCount(value) {
        var estimate = 0;
        var text = String(value || '');
        for (var character of text) {
          var codePoint = character.codePointAt(0) || 0;
          if (codePoint <= 0x7f) {
            estimate += 0.3;
          } else if (isCjkCodePoint(codePoint)) {
            estimate += 1;
          } else {
            estimate += 0.75;
          }
        }
        return Math.ceil(estimate);
      }

      function formatPercent(value) {
        var percent = clampNumber(value, 0, 100);
        if (percent === 0 || percent === 100) {
          return String(percent);
        }
        if (percent > 0 && percent < 0.1) {
          return '<0.1';
        }
        if (percent < 10) {
          return percent.toFixed(1);
        }
        return String(Math.round(percent));
      }

      function isCjkCodePoint(codePoint) {
        return (codePoint >= 0x3400 && codePoint <= 0x4dbf)
          || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
          || (codePoint >= 0xf900 && codePoint <= 0xfaff)
          || (codePoint >= 0x20000 && codePoint <= 0x2ebef)
          || (codePoint >= 0x3000 && codePoint <= 0x303f)
          || (codePoint >= 0xff00 && codePoint <= 0xffef);
      }

      function formatTokenCount(value) {
        var tokens = Math.max(0, Math.round(Number(value) || 0));
        if (tokens < 1000) {
          return String(tokens);
        }
        if (tokens >= 1000000) {
          return (Math.round((tokens / 1000000) * 10) / 10).toFixed(1).replace(/\\.0$/u, '') + 'M';
        }
        var thousands = tokens / 1000;
        if (thousands >= 10) {
          return Math.round(thousands) + 'k';
        }
        return (Math.round(thousands * 10) / 10).toFixed(1).replace(/\\.0$/u, '') + 'k';
      }

      function renderCommandMenu() {
        if (!commandMenu) { return; }
        renderCommandModel();
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

      function consumeSlashTrigger(restoreFocus) {
        if (!activeSlashRange || !isRangeInsidePrompt(activeSlashRange)) { return; }
        var range = activeSlashRange.cloneRange();
        range.deleteContents();
        if (restoreFocus === false) {
          savedPromptRange = range.cloneRange();
        } else {
          setPromptSelectionRange(range);
          savePromptSelection();
        }
        updatePromptVisualState();
        activeSlashRange = null;
      }

      function getSlashTriggerRange() {
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount || !selection.isCollapsed) { return null; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range)) { return null; }
        var textBefore = getTextBeforeRange(range);
        if (!textBefore || textBefore.charAt(textBefore.length - 1) !== '/') { return null; }
        var previous = textBefore.charAt(textBefore.length - 2);
        if (previous && !isWhitespace(previous)) { return null; }
        return getCharacterRangeBeforeCaret(range, '/');
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
        var anchor = document.createElement('a');
        var href = makeFileHref(reference);
        anchor.className = 'rich-file-link';
        anchor.setAttribute('href', href);
        anchor.setAttribute('contenteditable', 'false');
        anchor.draggable = false;
        anchor.title = href;
        anchor.textContent = formatFileReferenceLabel(reference);
        anchor.dataset.path = reference.path;
        anchor.dataset.kind = 'file';
        anchor.dataset.startLine = String(reference.startLine);
        anchor.dataset.endLine = String(reference.endLine);
        anchor.dataset.startColumn = String(reference.startColumn || 0);
        anchor.dataset.endColumn = String(reference.endColumn || 0);
        return anchor;
      }

      function createDirectoryReferenceLink(reference) {
        var anchor = document.createElement('a');
        var href = makeDirectoryHref(reference);
        anchor.className = 'rich-file-link rich-directory-link';
        anchor.setAttribute('href', href);
        anchor.setAttribute('contenteditable', 'false');
        anchor.draggable = false;
        anchor.title = href;
        anchor.textContent = getDirectoryName(reference.path);
        anchor.dataset.path = reference.path;
        anchor.dataset.kind = 'directory';
        anchor.dataset.startLine = '0';
        anchor.dataset.endLine = '0';
        anchor.dataset.startColumn = '0';
        anchor.dataset.endColumn = '0';
        return anchor;
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
          var directoryLabel = link.textContent || getDirectoryName(reference.path);
          return directoryLabel + ' <' + makeDirectoryHref(reference) + '>';
        }
        if (reference.startLine > 0 && reference.endLine < reference.startLine) {
          reference.endLine = reference.startLine;
        }
        return formatFileReferenceTextLabel(reference) + String.fromCharCode(10) + '<' + makeFileHref(reference) + '>';
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
          if (element.matches('a.rich-file-link')) {
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
            link.title = directoryHref;
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
          link.title = href;
        });
      }

      function refreshPromptFileLinkLabels() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          var reference = readFileReferenceLink(link);
          if (!reference.path) { return; }
          if (reference.kind === 'directory') {
            link.textContent = getDirectoryName(reference.path);
            return;
          }
          link.textContent = formatFileReferenceLabel(reference);
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
        schedulePromptUsageEstimate();
        renderContextProgress();
      }

      function isPromptEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !promptInput.textContent.trim();
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
        resetPromptUsageEstimate();
        promptInput.innerHTML = '';
        promptShortcutController.deactivateMark();
        savedPromptRange = null;
        updatePromptVisualState();
      }

      var settingsOverlay = document.getElementById('settingsDialogOverlay');
      var settingsApiKey = document.getElementById('settingsApiKey');
      var settingsApiKeyVisibilityBtn = document.getElementById('settingsApiKeyVisibilityBtn');
      var settingsBaseUrl = document.getElementById('settingsBaseUrl');
      var agentBudgetOverlay = document.getElementById('agentBudgetDialogOverlay');
      var agentBudgetMaxTokens = document.getElementById('agentBudgetMaxTokens');
      var agentBudgetMaxToolIterations = document.getElementById('agentBudgetMaxToolIterations');
      var agentBudgetMaxToolCalls = document.getElementById('agentBudgetMaxToolCalls');
      var agentBudgetMaxRunSeconds = document.getElementById('agentBudgetMaxRunSeconds');
      var agentBudgetStreamIdleSeconds = document.getElementById('agentBudgetStreamIdleSeconds');
      var agentBudgetToolResultTokenBudget = document.getElementById('agentBudgetToolResultTokenBudget');
      var historySettingsOverlay = document.getElementById('historySettingsDialogOverlay');
      var historyRetentionDaysInput = document.getElementById('historyRetentionDaysInput');
      var settingsClearApiKeyBtn = document.getElementById('settingsClearApiKeyBtn');
      var settingsSaveBtn = document.getElementById('settingsSaveBtn');
      var settingsCancelBtn = document.getElementById('settingsCancelBtn');
      var agentBudgetSaveBtn = document.getElementById('agentBudgetSaveBtn');
      var agentBudgetCancelBtn = document.getElementById('agentBudgetCancelBtn');
      var historySettingsSaveBtn = document.getElementById('historySettingsSaveBtn');
      var historySettingsCancelBtn = document.getElementById('historySettingsCancelBtn');
      var apiKeyVisible = false;
      var defaultMaxTokens = 64000;
      var maxGenerationTokens = 384000;
      var tokensPerBudgetKb = 1000;
      var defaultMaxToolIterations = 8;
      var defaultMaxToolCalls = 24;
      var defaultMaxRunMs = 600000;
      var defaultMaxRunSeconds = 600;
      var defaultStreamIdleTimeoutMs = 0;
      var defaultStreamIdleSeconds = 0;
      var defaultToolResultTokenBudget = 0;
      var maxToolResultTokenBudget = 1000000;
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

      function showAgentBudgetDialog(settings) {
        if (!agentBudgetOverlay) { return; }
        var values = settings && typeof settings === 'object' ? settings : {};
        if (agentBudgetMaxTokens) {
          agentBudgetMaxTokens.value = formatBudgetKbFromTokens(normalizeMaxTokens(values.maxTokens));
        }
        if (agentBudgetMaxToolIterations) {
          agentBudgetMaxToolIterations.value = String(normalizeIntegerInRange(values.maxToolIterations, 0, 64, defaultMaxToolIterations));
        }
        if (agentBudgetMaxToolCalls) {
          agentBudgetMaxToolCalls.value = String(normalizeIntegerInRange(values.maxToolCalls, 0, 256, defaultMaxToolCalls));
        }
        if (agentBudgetMaxRunSeconds) {
          agentBudgetMaxRunSeconds.value = String(normalizeRunMsToSeconds(values.maxRunMs));
        }
        if (agentBudgetStreamIdleSeconds) {
          agentBudgetStreamIdleSeconds.value = String(normalizeStreamIdleMsToSeconds(values.streamIdleTimeoutMs));
        }
        if (agentBudgetToolResultTokenBudget) {
          agentBudgetToolResultTokenBudget.value = formatBudgetKbFromTokens(normalizeIntegerInRange(values.toolResultTokenBudget, 0, maxToolResultTokenBudget, defaultToolResultTokenBudget));
        }
        agentBudgetOverlay.classList.remove('hidden');
        if (agentBudgetMaxTokens) {
          agentBudgetMaxTokens.focus();
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

      function normalizeMaxTokens(value) {
        return normalizeIntegerInRange(value, 0, maxGenerationTokens, defaultMaxTokens);
      }

      function normalizeMaxTokensKb(value) {
        return normalizeNumberInRange(value, 0, maxGenerationTokens / tokensPerBudgetKb, defaultMaxTokens / tokensPerBudgetKb);
      }

      function normalizeToolResultBudgetKb(value) {
        return normalizeNumberInRange(value, 0, maxToolResultTokenBudget / tokensPerBudgetKb, defaultToolResultTokenBudget / tokensPerBudgetKb);
      }

      function budgetKbToTokens(value) {
        return Math.round(Number(value) * tokensPerBudgetKb);
      }

      function formatBudgetKbFromTokens(value) {
        var kb = Number(value) / tokensPerBudgetKb;
        if (!Number.isFinite(kb)) {
          return '0';
        }
        var rounded = Math.round(kb * 100) / 100;
        return String(rounded).replace(/\\.00$/u, '').replace(/(\\.\\d)0$/u, '$1');
      }

      function normalizeRunMsToSeconds(value) {
        var normalizedMs = normalizeIntegerInRange(value, 0, 3600000, defaultMaxRunMs);
        return normalizeIntegerInRange(Math.round(normalizedMs / 1000), 0, 3600, defaultMaxRunSeconds);
      }

      function normalizeStreamIdleMsToSeconds(value) {
        var normalizedMs = normalizeIntegerInRange(value, 0, 3600000, defaultStreamIdleTimeoutMs);
        return normalizeIntegerInRange(Math.round(normalizedMs / 1000), 0, 3600, defaultStreamIdleSeconds);
      }

      function normalizeNumberInRange(value, min, max, fallback) {
        var number = Number(value);
        if (!Number.isFinite(number)) {
          return fallback;
        }
        return Math.min(max, Math.max(min, number));
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

      function hideAgentBudgetDialog() {
        if (!agentBudgetOverlay) { return; }
        agentBudgetOverlay.classList.add('hidden');
        promptInput.focus();
      }

      function hideHistorySettingsDialog() {
        if (!historySettingsOverlay) { return; }
        historySettingsOverlay.classList.add('hidden');
        promptInput.focus();
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

      if (agentBudgetSaveBtn) {
        agentBudgetSaveBtn.addEventListener('click', function() {
          var maxTokensKb = normalizeMaxTokensKb(agentBudgetMaxTokens ? agentBudgetMaxTokens.value : defaultMaxTokens / tokensPerBudgetKb);
          var maxTokens = normalizeMaxTokens(budgetKbToTokens(maxTokensKb));
          var maxToolIterations = normalizeIntegerInRange(agentBudgetMaxToolIterations ? agentBudgetMaxToolIterations.value : defaultMaxToolIterations, 0, 64, defaultMaxToolIterations);
          var maxToolCalls = normalizeIntegerInRange(agentBudgetMaxToolCalls ? agentBudgetMaxToolCalls.value : defaultMaxToolCalls, 0, 256, defaultMaxToolCalls);
          var maxRunSeconds = normalizeIntegerInRange(agentBudgetMaxRunSeconds ? agentBudgetMaxRunSeconds.value : defaultMaxRunSeconds, 0, 3600, defaultMaxRunSeconds);
          var maxRunMs = maxRunSeconds * 1000;
          var streamIdleSeconds = normalizeIntegerInRange(agentBudgetStreamIdleSeconds ? agentBudgetStreamIdleSeconds.value : defaultStreamIdleSeconds, 0, 3600, defaultStreamIdleSeconds);
          var streamIdleTimeoutMs = streamIdleSeconds * 1000;
          var toolResultBudgetKb = normalizeToolResultBudgetKb(agentBudgetToolResultTokenBudget ? agentBudgetToolResultTokenBudget.value : defaultToolResultTokenBudget / tokensPerBudgetKb);
          var toolResultTokenBudget = normalizeIntegerInRange(budgetKbToTokens(toolResultBudgetKb), 0, maxToolResultTokenBudget, defaultToolResultTokenBudget);
          if (agentBudgetMaxTokens) {
            agentBudgetMaxTokens.value = formatBudgetKbFromTokens(maxTokens);
          }
          if (agentBudgetMaxToolIterations) {
            agentBudgetMaxToolIterations.value = String(maxToolIterations);
          }
          if (agentBudgetMaxToolCalls) {
            agentBudgetMaxToolCalls.value = String(maxToolCalls);
          }
          if (agentBudgetMaxRunSeconds) {
            agentBudgetMaxRunSeconds.value = String(maxRunSeconds);
          }
          if (agentBudgetStreamIdleSeconds) {
            agentBudgetStreamIdleSeconds.value = String(streamIdleSeconds);
          }
          if (agentBudgetToolResultTokenBudget) {
            agentBudgetToolResultTokenBudget.value = formatBudgetKbFromTokens(toolResultTokenBudget);
          }
          vscode.postMessage({
            type: 'saveAgentBudgetSettings',
            maxTokens: maxTokens,
            maxToolIterations: maxToolIterations,
            maxToolCalls: maxToolCalls,
            maxRunMs: maxRunMs,
            streamIdleTimeoutMs: streamIdleTimeoutMs,
            toolResultTokenBudget: toolResultTokenBudget
          });
          setComposerStatus(t('agentBudgetSettingsSaved'));
          hideAgentBudgetDialog();
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

      if (agentBudgetCancelBtn) {
        agentBudgetCancelBtn.addEventListener('click', function() {
          hideAgentBudgetDialog();
        });
      }

      if (historySettingsCancelBtn) {
        historySettingsCancelBtn.addEventListener('click', function() {
          hideHistorySettingsDialog();
        });
      }

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

      if (agentBudgetOverlay) {
        agentBudgetOverlay.addEventListener('click', function(event) {
          if (event.target === agentBudgetOverlay) {
            hideAgentBudgetDialog();
          }
        });

        agentBudgetOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideAgentBudgetDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (agentBudgetSaveBtn) { agentBudgetSaveBtn.click(); }
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
        if (msg.type === 'promptContextUsageEstimate') {
          handlePromptContextUsageEstimate(msg);
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
        showAgentBudgetDialog: showAgentBudgetDialog,
        showHistorySettingsDialog: showHistorySettingsDialog,
        resetPromptUsageEstimate: resetPromptUsageEstimate,
        clearPrompt: clearPrompt
      };
      renderInputControls();
      updatePromptVisualState();
    })();
`;
}
