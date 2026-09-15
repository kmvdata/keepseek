import type { WebviewFragment } from '../composition';

export const referenceMenuDeclarationFragment: WebviewFragment = {
  id: 'references.menu.declaration',
  source: `
      var referenceMenu = document.getElementById('referenceMenu');
`.slice(1)
};

export const referenceMenuStateFragment: WebviewFragment = {
  id: 'references.menu.state',
  source: `
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
`.slice(1)
};

export const referenceMenuButtonBindingsFragment: WebviewFragment = {
  id: 'references.menu.button-bindings',
  source: `
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

`.slice(1)
};

export const referenceMenuBindingsFragment: WebviewFragment = {
  id: 'references.menu.bindings',
  source: `
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

`.slice(1)
};

export const referenceMenuDismissBindingFragment: WebviewFragment = {
  id: 'references.menu.dismiss-binding',
  source: `
      document.addEventListener('mousedown', function(event) {
        if (!referenceMenuOpen) { return; }
        var target = event.target instanceof Element ? event.target : null;
        if (!target) { return; }
        if ((referenceMenu && referenceMenu.contains(target)) || (referenceMenuButton && referenceMenuButton.contains(target)) || promptInput.contains(target)) {
          return;
        }
        closeReferenceMenu(false);
      });

`.slice(1)
};

export const referenceMenuImplementationFragment: WebviewFragment = {
  id: 'references.menu.implementation',
  source: `
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

`.slice(1)
};
