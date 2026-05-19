export function getInputScript(): string {
  return `
    let savedPromptRange = null;

    (function setupRichPromptInput() {
      var dropZone = promptInput.closest('.composer-input-inner') || promptInput;
      var dropArea = promptInput.closest('.composer-input-wrap') || dropZone;
      var dragDepth = 0;
      var commandMenuButton = document.getElementById('commandMenuButton');
      var commandMenu = document.getElementById('commandMenu');
      var commandModelSwitch = document.getElementById('commandModelSwitch');
      var commandModelValue = document.getElementById('commandModelValue');
      var commandModelList = document.getElementById('commandModelList');
      var commandEffortSlider = document.getElementById('commandEffortSlider');
      var commandEffortValue = document.getElementById('commandEffortValue');
      var commandThinkingToggle = document.getElementById('commandThinkingToggle');
      var commandApiKeyButton = document.getElementById('commandApiKeyButton');
      var commandMenuOpen = false;
      var commandModelListOpen = false;
      var activeSlashRange = null;
      var effortLabels = {
        high: 'High',
        max: 'Max'
      };

      composer.addEventListener('submit', function(event) {
        event.preventDefault();
        var prompt = serializePrompt();
        if (!prompt.trim() || state.isBusy) return;
        closeCommandMenu();
        vscode.postMessage({
          type: 'sendPrompt',
          prompt: prompt,
          modelId: state.selectedModelId,
          settings: readAgentSettingsFromControls()
        });
        promptInput.innerHTML = '';
        savedPromptRange = null;
        updatePromptVisualState();
      });

      promptInput.addEventListener('keydown', function(event) {
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
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          composer.requestSubmit();
        }
      });

      promptInput.addEventListener('input', function() {
        sanitizePromptLinks();
        updatePromptVisualState();
        savePromptSelection();
        var slashRange = getSlashTriggerRange();
        if (slashRange) {
          activeSlashRange = slashRange;
          openCommandMenu();
        }
      });

      promptInput.addEventListener('keyup', savePromptSelection);
      promptInput.addEventListener('mouseup', savePromptSelection);
      promptInput.addEventListener('focus', savePromptSelection);

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
          setComposerStatus('已切换模型');
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
          setComposerStatus(commandThinkingToggle.checked ? 'Thinking 已开启' : 'Thinking 已关闭');
        });
      }

      if (commandApiKeyButton) {
        commandApiKeyButton.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          consumeSlashTrigger(false);
          closeCommandMenu();
          vscode.postMessage({ type: 'openSettings', query: 'keepseek' });
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

      document.addEventListener('keydown', function(event) {
        if (!commandMenuOpen || event.key !== 'Escape') { return; }
        event.preventDefault();
        closeCommandMenu();
        promptInput.focus();
      });

      document.addEventListener('selectionchange', function() {
        if (isNodeInsidePrompt(document.activeElement)) {
          savePromptSelection();
        }
      });

      promptInput.addEventListener('click', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        var link = target?.closest('a.rich-file-link');
        if (!link || !promptInput.contains(link)) { return; }

        event.preventDefault();
        event.stopPropagation();

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
        var refs = extractFileReferences(event.clipboardData);
        if (refs.length) {
          insertFileReferences(refs);
          return;
        }

        var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (text) {
          insertPlainText(text);
        }
      });

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
          commandEffortValue.textContent = settings.thinkingEnabled ? effortLabels[settings.reasoningEffort] : 'Off';
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

      function extractFileReferences(dataTransfer) {
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
          addPlainTextReferences(references, seen, text);
        }

        return references;
      }

      function addReferenceList(references, seen, value) {
        var entries = splitDragLines(value);
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i].trim();
          if (!entry || entry.charAt(0) === '#') { continue; }
          addReference(references, seen, entry);
        }
      }

      function addPlainTextReferences(references, seen, value) {
        if (!value) { return; }
        var entries = splitDragLines(value).map(function (entry) {
          return entry.trim();
        }).filter(function (entry) {
          return entry && entry.charAt(0) !== '#';
        });
        if (!entries.length) { return; }

        for (var i = 0; i < entries.length; i++) {
          var reference = normalizeDraggedReference(entries[i]);
          if (!reference) { continue; }
          var key = makeFileHref(reference);
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

      function createFileReferenceLink(reference) {
        var anchor = document.createElement('a');
        var href = makeFileHref(reference);
        anchor.className = 'rich-file-link';
        anchor.setAttribute('href', href);
        anchor.setAttribute('contenteditable', 'false');
        anchor.draggable = false;
        anchor.title = href;
        var isFullFile = reference.startLine === 0;
        var fileName = getFileName(reference.path);
        anchor.textContent = isFullFile ? fileName : fileName + ' (' + formatLineLabel(reference.startLine, reference.endLine, reference.startColumn, reference.endColumn) + ')';
        anchor.dataset.path = reference.path;
        anchor.dataset.startLine = String(reference.startLine);
        anchor.dataset.endLine = String(reference.endLine);
        anchor.dataset.startColumn = String(reference.startColumn || 0);
        anchor.dataset.endColumn = String(reference.endColumn || 0);
        return anchor;
      }

      function makeFileHref(reference) {
        if (reference.startLine === 0) {
          return reference.path;
        }
        var fragment = '#L' + reference.startLine;
        if (reference.startColumn > 0) {
          fragment += 'C' + reference.startColumn;
        }
        if (reference.endLine !== reference.startLine) {
          fragment += '-L' + reference.endLine;
          if (reference.endColumn > 0) {
            fragment += 'C' + reference.endColumn;
          }
        } else if (reference.startColumn > 0 && reference.endColumn > reference.startColumn) {
          fragment += '-C' + reference.endColumn;
        }
        return reference.path + fragment;
      }

      function getFileName(filePath) {
        var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
        var parts = normalized.split('/');
        return parts[parts.length - 1] || normalized || 'file';
      }

      function formatLineLabel(startLine, endLine, startColumn, endColumn) {
        if (startLine === endLine) {
          if (startColumn > 0) {
            var colEnd = endColumn > startColumn ? endColumn : 0;
            if (colEnd > 0) {
              return '\\u7b2c' + startLine + '\\u884c\\u7b2c' + startColumn + '-' + colEnd + '\\u5217';
            }
            return '\\u7b2c' + startLine + '\\u884c\\u7b2c' + startColumn + '\\u5217\\u8d77';
          }
          return '\\u7b2c' + startLine + '\\u884c';
        }
        if (startColumn > 0 || endColumn > 0) {
          var startCol = startColumn > 0 ? '\\u7b2c' + startColumn + '\\u5217' : '';
          var endCol = endColumn > 0 ? '\\u7b2c' + endColumn + '\\u5217' : '';
          return '\\u7b2c' + startLine + '\\u884c' + startCol + '-\\u7b2c' + endLine + '\\u884c' + endCol;
        }
        return '\\u7b2c' + startLine + '-' + endLine + '\\u884c';
      }

      function insertFileReferences(references) {
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (needsLeadingSpace(range)) {
          fragment.append(document.createTextNode(' '));
        }

        for (var i = 0; i < references.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(createFileReferenceLink(references[i]));
        }

        if (needsTrailingSpace(range)) {
          fragment.append(document.createTextNode(' '));
        }

        insertFragmentAtRange(range, fragment);
        setComposerStatus('\\u5df2\\u63d2\\u5165 ' + references.length + ' \\u4e2a\\u6587\\u4ef6\\u5f15\\u7528');
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
        var selection = window.getSelection();
        if (!selection || !selection.rangeCount) { return; }
        var range = selection.getRangeAt(0);
        if (!isRangeInsidePrompt(range)) { return; }
        savedPromptRange = range.cloneRange();
      }

      function restorePromptSelection() {
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

      function needsLeadingSpace(range) {
        var text = getTextBeforeRange(range);
        return text.length > 0 && !isWhitespace(text.charAt(text.length - 1));
      }

      function needsTrailingSpace(range) {
        var text = getTextAfterRange(range);
        return text.length > 0 && !isWhitespace(text.charAt(0));
      }

      function getTextBeforeRange(range) {
        var clone = range.cloneRange();
        clone.selectNodeContents(promptInput);
        clone.setEnd(range.startContainer, range.startOffset);
        return clone.toString();
      }

      function getTextAfterRange(range) {
        var clone = range.cloneRange();
        clone.selectNodeContents(promptInput);
        clone.setStart(range.endContainer, range.endOffset);
        return clone.toString();
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
        var reference = {
          path: link.dataset.path || '',
          startLine: readPositiveInteger(link.dataset.startLine, 0),
          endLine: readPositiveInteger(link.dataset.endLine, 0),
          startColumn: readPositiveInteger(link.dataset.startColumn, 0),
          endColumn: readPositiveInteger(link.dataset.endColumn, 0)
        };
        if (reference.startLine > 0 && reference.endLine < reference.startLine) {
          reference.endLine = reference.startLine;
        }
        var label = link.textContent || getFileName(reference.path);
        return label + ' <' + makeFileHref(reference) + '>';
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

      function sanitizePromptLinks() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
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

      function updatePromptVisualState() {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
        var isEmpty = isPromptEmpty();
        promptInput.classList.toggle('is-empty', isEmpty);
        sendButton.disabled = state.isBusy || isEmpty;
      }

      function isPromptEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !promptInput.textContent.trim();
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

      var settingsOverlay = document.getElementById('settingsDialogOverlay');
      var settingsApiKey = document.getElementById('settingsApiKey');
      var settingsApiKeyVisibilityBtn = document.getElementById('settingsApiKeyVisibilityBtn');
      var settingsBaseUrl = document.getElementById('settingsBaseUrl');
      var settingsSaveBtn = document.getElementById('settingsSaveBtn');
      var settingsCancelBtn = document.getElementById('settingsCancelBtn');
      var apiKeyVisible = false;

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
          var label = apiKeyVisible ? '隐藏 API Key' : '显示 API Key';
          settingsApiKeyVisibilityBtn.classList.toggle('is-visible', apiKeyVisible);
          settingsApiKeyVisibilityBtn.setAttribute('aria-pressed', apiKeyVisible ? 'true' : 'false');
          settingsApiKeyVisibilityBtn.setAttribute('aria-label', label);
          settingsApiKeyVisibilityBtn.title = label;
        }
      }

      function showSettingsDialog(apiKey, baseUrl) {
        if (!settingsOverlay || !settingsApiKey || !settingsBaseUrl) { return; }
        settingsApiKey.value = apiKey || '';
        settingsBaseUrl.value = baseUrl || 'https://api.deepseek.com';
        setApiKeyVisible(false, false);
        settingsOverlay.classList.remove('hidden');
        settingsApiKey.focus();
      }

      function hideSettingsDialog() {
        if (!settingsOverlay) { return; }
        settingsOverlay.classList.add('hidden');
        promptInput.focus();
      }

      if (settingsSaveBtn) {
        settingsSaveBtn.addEventListener('click', function() {
          var apiKey = settingsApiKey ? settingsApiKey.value.trim() : '';
          var baseUrl = settingsBaseUrl ? settingsBaseUrl.value.trim() : '';
          if (!baseUrl) {
            baseUrl = 'https://api.deepseek.com';
          }
          vscode.postMessage({ type: 'saveSettings', apiKey: apiKey, baseUrl: baseUrl });
          setComposerStatus('API 设置已保存');
          hideSettingsDialog();
        });
      }

      if (settingsCancelBtn) {
        settingsCancelBtn.addEventListener('click', function() {
          hideSettingsDialog();
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
        } else {
          setComposerStatus('\\u672a\\u8bc6\\u522b\\u5230\\u53ef\\u5f15\\u7528\\u7684\\u6587\\u4ef6\\u8def\\u5f84');
        }
      }, true);

      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type !== 'insertFileReference') return;
        var reference = { path: msg.path, startLine: msg.startLine, endLine: msg.endLine, startColumn: msg.startColumn || 0, endColumn: msg.endColumn || 0 };
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (needsLeadingSpace(range)) {
          fragment.append(document.createTextNode(' '));
        }
        fragment.append(createFileReferenceLink(reference));
        if (needsTrailingSpace(range)) {
          fragment.append(document.createTextNode(' '));
        }
        insertFragmentAtRange(range, fragment);
        setComposerStatus('已插入文件引用');
      });

      window.keepseekInputControls = {
        render: renderCommandMenu,
        showSettingsDialog: showSettingsDialog
      };
      renderCommandMenu();
      updatePromptVisualState();
    })();
`;
}
