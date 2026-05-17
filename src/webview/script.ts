export function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const state = {
      models: [],
      selectedModelId: '',
      messages: [],
      contextFiles: [],
      draftEdits: [],
      isBusy: false
    };

    const contextBar = document.getElementById('contextBar');
    const draftRegion = document.getElementById('draftRegion');
    const draftList = document.getElementById('draftList');
    const transcript = document.getElementById('transcript');
    const composer = document.getElementById('composer');
    const promptInput = document.getElementById('promptInput');
    const status = document.getElementById('status');
    const sendButton = document.getElementById('sendButton');
    let transientStatus = '';
    let transientStatusTimer = 0;
    let savedPromptRange = null;

    draftList.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var button = target?.closest('button[data-edit-id]');
      if (!button) return;
      vscode.postMessage({ type: button.dataset.editAction, id: button.dataset.editId });
    });

    // \\u2500\\u2500 \\u5bcc\\u6587\\u672c\\u8f93\\u5165\\uff1a\\u666e\\u901a\\u6587\\u672c + \\u6587\\u4ef6\\u884c\\u7ea7\\u94fe\\u63a5 \\u2500\\u2500
    (function setupRichPromptInput() {
      var dropZone = promptInput.closest('.composer-input-inner') || promptInput;
      var dropArea = promptInput.closest('.composer-input-wrap') || dropZone;
      var dragDepth = 0;

      composer.addEventListener('submit', function(event) {
        event.preventDefault();
        var prompt = serializePrompt();
        if (!prompt.trim() || state.isBusy) return;
        vscode.postMessage({
          type: 'sendPrompt',
          prompt: prompt,
          modelId: state.selectedModelId
        });
        promptInput.innerHTML = '';
        savedPromptRange = null;
        updatePromptVisualState();
      });

      promptInput.addEventListener('keydown', function(event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          composer.requestSubmit();
        }
      });

      promptInput.addEventListener('input', function() {
        sanitizePromptLinks();
        updatePromptVisualState();
        savePromptSelection();
      });

      promptInput.addEventListener('keyup', savePromptSelection);
      promptInput.addEventListener('mouseup', savePromptSelection);
      promptInput.addEventListener('focus', savePromptSelection);

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
          endLine: readPositiveInteger(link.dataset.endLine, 0)
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

        // 1) 文件系统文件（Finder / Explorer 拖入）—— file.path 在 VSCode Webview 中可能为 undefined
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

        // 2) text/uri-list（VSCode 资源管理器 / 系统拖拽）
        if (hasType(dt, 'text/uri-list')) {
          var uriList = dt.getData('text/uri-list');
          if (uriList) {
            addReferenceList(references, seen, uriList);
          }
        }

        // 3) VSCode 自定义 MIME（资源管理器拖入）
        if (hasType(dt, 'application/vnd.code.uri-list')) {
          var codeUris = dt.getData('application/vnd.code.uri-list');
          if (codeUris) {
            addReferenceList(references, seen, codeUris);
          }
        }

        // 4) text/plain 兜底
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
          endLine: split.endLine
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
              endLine: parsed.endLine
            };
          }
        }
        return { path: value, startLine: 0, endLine: 0 };
      }

      function parseLineRange(fragment) {
        var text = String(fragment || '').trim();
        if (!text) {
          return { valid: false, startLine: 0, endLine: 0 };
        }
        if (text.charAt(0).toLowerCase() === 'l') {
          text = text.slice(1);
        }

        var start = readLeadingInteger(text);
        if (!start.valid) {
          return { valid: false, startLine: 1, endLine: 1 };
        }

        var rest = start.rest;
        if (rest.charAt(0) === '-' || rest.charAt(0) === ',' || rest.charAt(0) === ':') {
          rest = rest.slice(1);
        }
        if (rest.charAt(0).toLowerCase() === 'l') {
          rest = rest.slice(1);
        }

        var end = readLeadingInteger(rest);
        var endLine = end.valid ? end.value : start.value;
        if (endLine < start.value) {
          endLine = start.value;
        }

        return {
          valid: true,
          startLine: start.value,
          endLine: endLine
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
          if (url.hostname) {
            return { path: '//' + url.hostname + pathname, startLine: startLine, endLine: endLine };
          }
          if (pathname.charAt(0) === '/' && isWindowsDrivePath(pathname.slice(1))) {
            return { path: pathname.slice(1), startLine: startLine, endLine: endLine };
          }
          return { path: pathname, startLine: startLine, endLine: endLine };
        } catch (error) {
          var split = splitLineReference(uri);
          var fallback = split.path.split('?')[0];
          if (fallback.startsWith('file:///') && isWindowsDrivePath(fallback.slice(8))) {
            return {
              path: decodeURIComponent(fallback.slice(8)),
              startLine: split.startLine,
              endLine: split.endLine
            };
          }
          if (fallback.startsWith('file://')) {
            return {
              path: decodeURIComponent(fallback.slice(7)),
              startLine: split.startLine,
              endLine: split.endLine
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
        anchor.textContent = isFullFile ? fileName : fileName + ' (' + formatLineLabel(reference.startLine, reference.endLine) + ')';
        anchor.dataset.path = reference.path;
        anchor.dataset.startLine = String(reference.startLine);
        anchor.dataset.endLine = String(reference.endLine);
        return anchor;
      }

      function makeFileHref(reference) {
        if (reference.startLine === 0) {
          return reference.path;
        }
        return reference.path + '#L' + reference.startLine + '-L' + reference.endLine;
      }

      function getFileName(filePath) {
        var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
        var parts = normalized.split('/');
        return parts[parts.length - 1] || normalized || 'file';
      }

      function formatLineLabel(startLine, endLine) {
        if (startLine === endLine) {
          return '\\u7b2c' + startLine + '\\u884c';
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
          endLine: readPositiveInteger(link.dataset.endLine, 0)
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
          var path = link.dataset.path || '';
          var href = makeFileHref({ path: path, startLine: startLine, endLine: endLine });
          link.setAttribute('href', href);
          link.setAttribute('contenteditable', 'false');
          link.title = href;
        });
      }

      function updatePromptVisualState() {
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
        promptInput.classList.toggle('is-empty', isPromptEmpty());
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

      // document \\u7ea7 dragover\\uff08\\u6355\\u83b7\\u9636\\u6bb5\\uff09\\u2014\\u2014 \\u5fc5\\u987b\\u5148 preventDefault \\u624d\\u80fd\\u89e6\\u53d1 drop
      document.addEventListener('dragover', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'copy';
        }
      }, true);

      // document \\u7ea7 dragenter / dragleave \\u2014\\u2014 \\u53ea\\u63a7\\u5236 textarea \\u89c6\\u89c9\\u53cd\\u9988
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

      // document \\u7ea7 drop\\uff08\\u6355\\u83b7\\u9636\\u6bb5\\uff09\\u2014\\u2014 \\u5728 VSCode \\u62e6\\u622a\\u4e4b\\u524d\\u62ff\\u5230\\u4e8b\\u4ef6
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
        var reference = { path: msg.path, startLine: msg.startLine, endLine: msg.endLine };
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

      updatePromptVisualState();
    })();

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (message.type === 'state') {
        Object.assign(state, message.state);
        render();
      }
    });

    function render() {
      renderContextChips();
      renderDraftEdits();
      renderTranscript();
      renderStatus();
      sendButton.disabled = state.isBusy;
    }

    function renderStatus() {
      status.textContent = state.isBusy ? '\\u5904\\u7406\\u4e2d...' : transientStatus;
    }

    function renderContextChips() {
      var existing = contextBar.querySelectorAll('.context-chip');
      existing.forEach(function(el) { el.remove(); });

      if (!state.contextFiles.length) {
        return;
      }

      for (var i = 0; i < state.contextFiles.length; i++) {
        var file = state.contextFiles[i];
        var chip = document.createElement('span');
        chip.className = 'context-chip';

        var label = document.createElement('span');
        label.className = 'context-chip-label';
        label.textContent = file.label;
        label.title = file.fsPath;

        var remove = document.createElement('button');
        remove.className = 'context-chip-remove';
        remove.type = 'button';
        remove.textContent = '\\\\00d7';
        remove.title = '\\u79fb\\u9664 ' + file.label;
        remove.dataset.uri = file.uri;

        chip.append(label, remove);
        contextBar.append(chip);
      }
    }

    contextBar.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var removeBtn = target?.closest('.context-chip-remove');
      if (!removeBtn) return;
      event.stopPropagation();
      vscode.postMessage({ type: 'removeContextFile', uri: removeBtn.dataset.uri });
    });

    function renderDraftEdits() {
      draftList.innerHTML = '';
      draftRegion.classList.toggle('hidden', state.draftEdits.length === 0);

      for (var i = 0; i < state.draftEdits.length; i++) {
        var edit = state.draftEdits[i];
        var chip = document.createElement('div');
        chip.className = 'draft-chip';

        var label = document.createElement('span');
        label.className = 'draft-chip-label';
        label.textContent = edit.label;
        label.title = edit.reason;

        var actions = document.createElement('div');
        actions.className = 'draft-chip-actions';

        var apply = document.createElement('button');
        apply.type = 'button';
        apply.textContent = 'Apply';
        apply.dataset.editId = edit.id;
        apply.dataset.editAction = 'applyDraftEdit';

        var discard = document.createElement('button');
        discard.type = 'button';
        discard.className = 'secondary';
        discard.textContent = 'Discard';
        discard.dataset.editId = edit.id;
        discard.dataset.editAction = 'discardDraftEdit';

        actions.append(apply, discard);
        chip.append(label, actions);
        draftList.append(chip);
      }
    }

    function renderTranscript() {
      var shouldStick = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
      transcript.innerHTML = '';

      if (!state.messages.length) {
        var empty = document.createElement('div');
        empty.className = 'transcript-empty';
        var icon = document.createElement('div');
        icon.className = 'transcript-empty-icon';
        icon.textContent = '\\\\2726';
        var line1 = document.createElement('div');
        line1.textContent = '\\u5f00\\u59cb KeepSeek \\u5bf9\\u8bdd';
        var line2 = document.createElement('div');
        line2.style.cssText = 'font-size:11px;opacity:0.6';
        line2.textContent = '\\u6dfb\\u52a0\\u4e0a\\u4e0b\\u6587\\u6587\\u4ef6\\u540e\\uff0c\\u8f93\\u5165\\u6d88\\u606f\\u5e76\\u53d1\\u9001';
        empty.append(icon, line1, line2);
        transcript.append(empty);
      }

      for (var i = 0; i < state.messages.length; i++) {
        var message = state.messages[i];
        var item = document.createElement('article');
        item.className = 'message ' + message.role;

        var role = document.createElement('div');
        role.className = 'message-role';
        role.textContent = message.role === 'user' ? 'You' : 'KeepSeek';

        var content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = message.content;

        item.append(role, content);
        transcript.append(item);
      }

      if (shouldStick) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    vscode.postMessage({ type: 'ready' });`;
}
