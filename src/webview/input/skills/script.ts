import type { WebviewFragment } from '../composition';

export const skillsDeclarationFragment: WebviewFragment = {
  id: 'skills.declaration',
  source: `
      var skillsBar = document.getElementById('skillsBar');
      var skillsBarList = document.getElementById('skillsBarList');
`.slice(1)
};

export const skillsBarBindingsFragment: WebviewFragment = {
  id: 'skills.bar-bindings',
  source: `
      if (skillsBarList) {
        skillsBarList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var removeButton = target?.closest('button[data-skill-id]');
          if (removeButton) {
            event.preventDefault();
            event.stopPropagation();
            if (!canChangeContext()) { return; }
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
          if (!canChangeContext()) { return; }
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
            if (!canChangeContext()) { return; }
            var skillId = pill.dataset.skillId || '';
            var skill = getSkillById(skillId);
            vscode.postMessage({ type: 'openSkill', skillId: skillId });
            setComposerStatus(t('skillOpened', { name: skill ? skill.name : skillId }));
          }
        });
      }

`.slice(1)
};

export const skillsImplementationFragment: WebviewFragment = {
  id: 'skills.implementation',
  source: `
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
        if (skill.plugin) {
          anchor.dataset.skillReferenceText = getSkillMarkdownText(skill);
          anchor.dataset.skillSelectionStamp = skill.plugin.selectionStamp || '';
        }
        return anchor;
      }

      function insertSkillChip(skill, range) {
        var fragment = document.createDocumentFragment();
        appendReferenceBoundarySpace(fragment);
        fragment.append(createSkillLink(skill));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range || getPromptInsertionRange(), fragment);
      }

      function removePromptSkillChip(skillId, skillPath) {
        var links = promptInput.querySelectorAll('a.rich-skill-link');
        links.forEach(function(link) {
          if ((link.dataset.skillId || '') !== skillId) { return; }
          if (skillPath && link.dataset.skillPath !== skillPath) { return; }
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
          if (link.dataset.skillReferenceText) {
            var current = isPluginSkillLinkCurrent(link, skill);
            link.setAttribute('aria-invalid', current ? 'false' : 'true');
            link.title = current ? (skill.description || getSkillMentionName(skill)) : t('pluginSkillStale');
            return;
          }
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
          if (!link.dataset.skillReferenceText) {
            add(link.dataset.skillId || '');
          }
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
        remove.disabled = !canChangeContext();
        remove.title = !canChangeContext() ? t('skillRemoveDisabledWhileBusy') : t('removeSkill');
        remove.setAttribute('aria-label', !canChangeContext() ? t('skillRemoveDisabledWhileBusy') : t('removeSkill'));
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
          scopeUri: skills.scopeUri,
          diagnostics: Array.isArray(skills.diagnostics) ? skills.diagnostics : [],
          configSummary: skills.configSummary,
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
        if (!getSkillsState().scopeUri) { return t('sharedScopeRequired'); }
        return '';
      }

      function getSkillItems() {
        return getSkillsState().items;
      }

      function getCommandSkillItems() {
        var activeOrder = new Map();
        getActiveSkillIds().forEach(function(skillId, index) {
          activeOrder.set(skillId, index);
        });
        var orderedSkills = getSkillItems().slice().sort(function(left, right) {
          var leftActive = activeOrder.has(left.id);
          var rightActive = activeOrder.has(right.id);
          if (leftActive && rightActive) {
            return activeOrder.get(left.id) - activeOrder.get(right.id);
          }
          if (leftActive !== rightActive) {
            return leftActive ? -1 : 1;
          }
          var leftName = String(left.name || left.id || '');
          var rightName = String(right.name || right.id || '');
          var nameOrder = leftName.localeCompare(rightName, undefined, { sensitivity: 'base', numeric: true });
          return nameOrder || String(left.id || '').localeCompare(String(right.id || ''), undefined, { sensitivity: 'base' });
        });
        return filterSkillItemsByName(orderedSkills, commandSkillFilterQuery);
      }

      function getFilteredSkillMenuItems() {
        return filterSkillItemsByName(getSkillItems().filter(isSkillUserSelectable), activeMentionQuery);
      }

      function isSkillUserSelectable(skill) {
        return Boolean(skill && skill.enabled && !skill.unavailableReason);
      }

      function filterSkillItemsByName(skills, query) {
        var normalizedQuery = normalizeReferenceQuery(query);
        if (!normalizedQuery) {
          return skills.slice();
        }
        return skills.filter(function(skill) {
          return skillNameMatchesQuery(skill, normalizedQuery);
        });
      }

      function skillNameMatchesQuery(skill, query) {
        var fields = [
          getSkillMentionName(skill),
          skill.name || ''
        ];
        if (skill.plugin) {
          fields.push(skill.plugin.name, skill.plugin.version, skill.plugin.marketplace);
        }
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

      function isPluginSkillInPrompt(skill) {
        return Array.from(promptInput.querySelectorAll('a.rich-skill-link')).some(function(link) {
          return link.dataset.skillId === skill.id && isPluginSkillLinkCurrent(link, skill);
        });
      }

      function hasStalePluginSkillInPrompt() {
        return Array.from(promptInput.querySelectorAll('a.rich-skill-link')).some(function(link) {
          return Boolean(link.dataset.skillReferenceText)
            && !isPluginSkillLinkCurrent(link, getSkillById(link.dataset.skillId || ''));
        });
      }

      function getSkillMentionName(skill) {
        var qualifiedName = getPluginSkillMentionName(skill);
        if (qualifiedName) { return qualifiedName; }
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
        var target = skill.plugin ? getPluginSkillReferenceTarget(skill, true) : getSkillPath(skill);
        return '[' + getSkillPromptText(skill) + '](' + target + ')';
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
        if (skill && skill.plugin) {
          return formatPluginSkillOrigin(skill.plugin);
        }
        return String(skill && skill.sourceLabel || skill && skill.source || t('skillsTitle')).trim() || t('skillsTitle');
      }

      function formatPluginSkillOrigin(plugin) {
        var sourceLabel = plugin.source === 'local'
          ? 'pluginSkillSourceLocal'
          : (plugin.source === 'remote' ? 'pluginSkillSourceRemote' : 'pluginSkillSourceManual');
        return t('pluginSkillOrigin', {
          plugin: plugin.name, version: plugin.version, source: t(sourceLabel), marketplace: plugin.marketplace
        });
      }

      function formatPluginSkillCapability(plugin) {
        var labels = {
          readable: 'pluginSkillReadable',
          executable: 'pluginSkillExecutable',
          partial: 'pluginSkillPartial',
          missing: 'pluginSkillMissing',
          unverified: 'pluginSkillUnverified'
        };
        var requirementLabels = {
          available: 'pluginSkillRequirementAvailable',
          missing: 'pluginSkillRequirementMissing',
          unverified: 'pluginSkillRequirementUnverified'
        };
        var details = Array.isArray(plugin.capabilityDetails) ? plugin.capabilityDetails : [];
        return [t(labels[plugin.capabilityStatus] || labels.unverified)].concat(details.map(function(requirement) {
          var name = getLanguage() === 'en' ? requirement.en : requirement.zh;
          return name + ' (' + t(requirementLabels[requirement.status] || requirementLabels.unverified) + ')';
        }));
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

`.slice(1)
};

