import { getInputScript } from './input/script';

export function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const state = {
      models: [],
      selectedModelId: '',
      agentSettings: {
        thinkingEnabled: true,
        reasoningEffort: 'high'
      },
      messages: [],
      activeSessionId: '',
      sessionSummaries: [],
      contextFiles: [],
      draftEdits: [],
      isBusy: false
    };

    const historyTab = document.getElementById('historyTab');
    const newChatTab = document.getElementById('newChatTab');
    const sessionMenu = document.getElementById('sessionMenu');
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
    let sessionMenuOpen = false;

    transcript.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var link = target?.closest('a.message-file-link');
      if (!link || !transcript.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
      vscode.postMessage({
        type: 'openFileReference',
        path: link.dataset.path || '',
        startLine: readReferenceInteger(link.dataset.startLine, 0),
        endLine: readReferenceInteger(link.dataset.endLine, 0),
        startColumn: readReferenceInteger(link.dataset.startColumn, 0),
        endColumn: readReferenceInteger(link.dataset.endColumn, 0)
      });
    });

    draftList.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var button = target?.closest('button[data-edit-id]');
      if (!button) return;
      vscode.postMessage({ type: button.dataset.editAction, id: button.dataset.editId });
    });

    if (newChatTab) {
      newChatTab.addEventListener('click', function() {
        if (state.isBusy) return;
        closeSessionMenu();
        clearPromptDraft();
        vscode.postMessage({ type: 'newSession' });
      });
    }

    if (historyTab) {
      historyTab.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.isBusy) return;
        toggleSessionMenu();
      });
    }

    if (sessionMenu) {
      sessionMenu.addEventListener('click', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        var button = target?.closest('button[data-session-id]');
        if (!button) return;
        var sessionId = button.dataset.sessionId || '';
        if (!sessionId || sessionId === state.activeSessionId) {
          closeSessionMenu();
          return;
        }
        clearPromptDraft();
        closeSessionMenu();
        vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
      });
    }

    document.addEventListener('mousedown', function(event) {
      if (!sessionMenuOpen) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if ((sessionMenu && sessionMenu.contains(target)) || (historyTab && historyTab.contains(target))) {
        return;
      }
      closeSessionMenu();
    });

    document.addEventListener('keydown', function(event) {
      if (!sessionMenuOpen || event.key !== 'Escape') return;
      event.preventDefault();
      closeSessionMenu();
    });

    ${getInputScript()}

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (message.type === 'state') {
        Object.assign(state, message.state);
        render();
      } else if (message.type === 'sessionChanged') {
        clearPromptDraft();
      } else if (message.type === 'showSettingsDialog') {
        if (window.keepseekInputControls && window.keepseekInputControls.showSettingsDialog) {
          window.keepseekInputControls.showSettingsDialog(message.apiKey, message.baseUrl);
        }
      }
    });

    function render() {
      renderSessionControls();
      renderContextChips();
      renderDraftEdits();
      renderTranscript();
      renderStatus();
      if (window.keepseekInputControls) {
        window.keepseekInputControls.render();
      }
      sendButton.disabled = state.isBusy || promptInput.classList.contains('is-empty');
    }

    function renderSessionControls() {
      if (newChatTab) {
        newChatTab.disabled = state.isBusy;
      }
      if (historyTab) {
        historyTab.disabled = state.isBusy;
        historyTab.classList.toggle('active', sessionMenuOpen);
        historyTab.setAttribute('aria-expanded', sessionMenuOpen ? 'true' : 'false');
      }
      renderSessionMenu();
    }

    function toggleSessionMenu() {
      if (sessionMenuOpen) {
        closeSessionMenu();
      } else {
        openSessionMenu();
      }
    }

    function openSessionMenu() {
      sessionMenuOpen = true;
      renderSessionControls();
    }

    function closeSessionMenu() {
      sessionMenuOpen = false;
      renderSessionControls();
    }

    function renderSessionMenu() {
      if (!sessionMenu) return;
      sessionMenu.classList.toggle('hidden', !sessionMenuOpen);
      sessionMenu.innerHTML = '';

      var sessions = Array.isArray(state.sessionSummaries) ? state.sessionSummaries : [];
      if (!sessions.length) {
        var empty = document.createElement('div');
        empty.className = 'session-menu-empty';
        empty.textContent = '\\u6682\\u65e0\\u5386\\u53f2\\u4f1a\\u8bdd';
        sessionMenu.append(empty);
        return;
      }

      var title = document.createElement('div');
      title.className = 'session-menu-title';
      title.textContent = '\\u5386\\u53f2\\u4f1a\\u8bdd';
      sessionMenu.append(title);

      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        var item = document.createElement('button');
        var isActive = session.id === state.activeSessionId;
        item.type = 'button';
        item.className = 'session-menu-item' + (isActive ? ' is-active' : '');
        item.dataset.sessionId = session.id;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', isActive ? 'true' : 'false');

        var itemTitle = document.createElement('span');
        itemTitle.className = 'session-menu-item-title';
        itemTitle.textContent = session.title || '\\u65b0\\u4f1a\\u8bdd';
        itemTitle.title = itemTitle.textContent;

        var meta = document.createElement('span');
        meta.className = 'session-menu-item-meta';
        meta.textContent = formatSessionMeta(session);

        item.append(itemTitle, meta);
        sessionMenu.append(item);
      }
    }

    function formatSessionMeta(session) {
      var count = Number(session.messageCount) || 0;
      var countLabel = count > 0 ? count + ' \\u6761\\u6d88\\u606f' : '\\u7a7a\\u4f1a\\u8bdd';
      var timeLabel = formatSessionTime(session.updatedAt || session.createdAt);
      return timeLabel ? timeLabel + ' · ' + countLabel : countLabel;
    }

    function formatSessionTime(value) {
      var time = Date.parse(value || '');
      if (!Number.isFinite(time)) return '';
      return new Date(time).toLocaleString([], {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function clearPromptDraft() {
      if (window.keepseekInputControls && window.keepseekInputControls.clearPrompt) {
        window.keepseekInputControls.clearPrompt();
      } else if (promptInput) {
        promptInput.innerHTML = '';
        promptInput.classList.add('is-empty');
      }
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
        renderMessageContent(content, message.content, message.role === 'user');

        item.append(role);
        if (message.role === 'assistant' && message.reasoningContent) {
          var reasoning = document.createElement('details');
          reasoning.className = 'reasoning-block';
          var summary = document.createElement('summary');
          summary.textContent = 'Thinking';
          var reasoningContent = document.createElement('pre');
          reasoningContent.textContent = message.reasoningContent;
          reasoning.append(summary, reasoningContent);
          item.append(reasoning);
        }
        item.append(content);
        transcript.append(item);
      }

      if (shouldStick) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    }

    function renderMessageContent(container, value, hideExpandedReferences) {
      var text = String(value || '');
      var pattern = /<([^<>\\n]+)>/g;
      var cursor = 0;
      var match;

      while ((match = pattern.exec(text)) !== null) {
        var target = (match[1] || '').trim();
        var reference = parseMessageFileReference(target);
        if (!reference) {
          continue;
        }

        var label = getMessageReferenceLabel(text, match.index, reference);
        if (label.start < cursor) {
          continue;
        }

        appendMessageText(container, text.slice(cursor, label.start));
        container.append(createMessageFileLink(reference, label.text));
        cursor = match.index + match[0].length;
        if (hideExpandedReferences) {
          var hiddenBlockEnd = getExpandedReferenceBlockEnd(text, cursor);
          if (hiddenBlockEnd > cursor) {
            cursor = hiddenBlockEnd;
            if (cursor < text.length) {
              appendMessageText(container, String.fromCharCode(10));
            }
          }
        }
      }

      appendMessageText(container, text.slice(cursor));
    }

    function getExpandedReferenceBlockEnd(text, start) {
      var cursor = start;
      if (text.charAt(cursor) === String.fromCharCode(13)) {
        cursor += 1;
      }
      if (text.charAt(cursor) !== String.fromCharCode(10)) {
        return start;
      }
      cursor += 1;

      var fenceLineEnd = getLineEndIndex(text, cursor);
      var fenceLine = text.slice(cursor, fenceLineEnd).trim();
      var fenceMatch = /^(\`{3,}|~{3,})[\\w+.-]*$/.exec(fenceLine);
      if (!fenceMatch) {
        return start;
      }

      var fence = fenceMatch[1];
      cursor = getNextLineStart(text, fenceLineEnd);
      while (cursor < text.length) {
        var lineEnd = getLineEndIndex(text, cursor);
        var line = text.slice(cursor, lineEnd).trim();
        if (line === fence) {
          return getNextLineStart(text, lineEnd);
        }
        cursor = getNextLineStart(text, lineEnd);
      }

      return start;
    }

    function getLineEndIndex(text, start) {
      var lineFeed = text.indexOf(String.fromCharCode(10), start);
      var carriageReturn = text.indexOf(String.fromCharCode(13), start);
      if (lineFeed < 0) return carriageReturn < 0 ? text.length : carriageReturn;
      if (carriageReturn < 0) return lineFeed;
      return Math.min(lineFeed, carriageReturn);
    }

    function getNextLineStart(text, lineEnd) {
      var cursor = lineEnd;
      if (text.charAt(cursor) === String.fromCharCode(13)) {
        cursor += 1;
      }
      if (text.charAt(cursor) === String.fromCharCode(10)) {
        cursor += 1;
      }
      return cursor;
    }

    function appendMessageText(container, text) {
      if (!text) return;
      container.append(document.createTextNode(text));
    }

    function createMessageFileLink(reference, label) {
      var anchor = document.createElement('a');
      var href = makeMessageFileHref(reference);
      anchor.className = 'rich-file-link message-file-link';
      anchor.href = href;
      anchor.title = href;
      anchor.draggable = false;
      anchor.textContent = label;
      anchor.dataset.path = reference.path;
      anchor.dataset.startLine = String(reference.startLine);
      anchor.dataset.endLine = String(reference.endLine);
      anchor.dataset.startColumn = String(reference.startColumn || 0);
      anchor.dataset.endColumn = String(reference.endColumn || 0);
      return anchor;
    }

    function parseMessageFileReference(target) {
      if (hasNonFileUriScheme(target)) {
        return null;
      }
      var reference = target.toLowerCase().indexOf('file:') === 0
        ? parseMessageFileUri(target)
        : splitMessageLineReference(target);
      if (!reference || !isLikelyMessageFilePath(reference.path, target)) {
        return null;
      }
      if (reference.startLine > 0 && reference.endLine < reference.startLine) {
        reference.endLine = reference.startLine;
      }
      return reference;
    }

    function hasNonFileUriScheme(value) {
      var match = /^[a-z][a-z\\d+.-]*:\\/\\//i.exec(String(value || '').trim());
      return Boolean(match && match[0].toLowerCase().indexOf('file:') !== 0);
    }

    function parseMessageFileUri(target) {
      try {
        var url = new URL(target);
        if (url.protocol !== 'file:') {
          return null;
        }
        var parsed = parseMessageLineRange(url.hash ? url.hash.slice(1) : '');
        var pathName = decodeURIComponent(url.pathname);
        var filePath = url.hostname ? '//' + url.hostname + pathName : pathName;
        if (filePath.charAt(0) === '/' && isMessageWindowsDrivePath(filePath.slice(1))) {
          filePath = filePath.slice(1);
        }
        return {
          path: filePath,
          startLine: parsed.valid ? parsed.startLine : 0,
          endLine: parsed.valid ? parsed.endLine : 0,
          startColumn: parsed.valid ? parsed.startColumn : 0,
          endColumn: parsed.valid ? parsed.endColumn : 0
        };
      } catch {
        return splitMessageLineReference(target);
      }
    }

    function splitMessageLineReference(value) {
      var text = String(value || '').trim();
      for (var i = text.length - 1; i >= 0; i--) {
        if (text.charAt(i) !== '#') continue;
        var parsed = parseMessageLineRange(text.slice(i + 1));
        if (parsed.valid) {
          return {
            path: text.slice(0, i),
            startLine: parsed.startLine,
            endLine: parsed.endLine,
            startColumn: parsed.startColumn,
            endColumn: parsed.endColumn
          };
        }
      }
      return { path: text, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
    }

    function parseMessageLineRange(fragment) {
      var text = String(fragment || '').trim();
      if (!text) {
        return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }
      if (text.charAt(0).toLowerCase() === 'l') {
        text = text.slice(1);
      }

      var start = readLeadingReferenceInteger(text);
      if (!start.valid) {
        return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }

      var startLine = start.value;
      var startColumn = 0;
      var rest = start.rest;

      if (rest.charAt(0).toLowerCase() === 'c') {
        var col = readLeadingReferenceInteger(rest.slice(1));
        if (col.valid) {
          startColumn = col.value;
          rest = col.rest;
        }
      }

      if (rest.charAt(0) !== '-' && rest.charAt(0) !== ',' && rest.charAt(0) !== ':') {
        return { valid: true, startLine: startLine, endLine: startLine, startColumn: startColumn, endColumn: startColumn };
      }

      rest = rest.slice(1);
      var endLine = startLine;
      var endColumn = 0;

      if (rest.charAt(0).toLowerCase() === 'l') {
        var endLineResult = readLeadingReferenceInteger(rest.slice(1));
        if (endLineResult.valid) {
          endLine = endLineResult.value;
          rest = endLineResult.rest;
          if (rest.charAt(0).toLowerCase() === 'c') {
            var endColResult = readLeadingReferenceInteger(rest.slice(1));
            if (endColResult.valid) {
              endColumn = endColResult.value;
            }
          }
        }
      } else if (rest.charAt(0).toLowerCase() === 'c') {
        var sameLineCol = readLeadingReferenceInteger(rest.slice(1));
        if (sameLineCol.valid) {
          endColumn = sameLineCol.value;
        }
      } else {
        var endResult = readLeadingReferenceInteger(rest);
        if (endResult.valid) {
          endLine = endResult.value;
        }
      }

      return {
        valid: true,
        startLine: startLine,
        endLine: Math.max(startLine, endLine),
        startColumn: startColumn,
        endColumn: endColumn
      };
    }

    function readLeadingReferenceInteger(value) {
      var digits = '';
      for (var i = 0; i < value.length; i++) {
        var code = value.charCodeAt(i);
        if (code < 48 || code > 57) break;
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

    function getMessageReferenceLabel(text, matchStart, reference) {
      var fileName = getMessageFileName(reference.path);
      var labels = reference.startLine > 0
        ? [fileName + ' (' + formatMessageLineLabel(reference.startLine, reference.endLine, reference.startColumn, reference.endColumn) + ')']
        : [];
      labels.push(fileName + ' (全文)', fileName);

      var prefix = text.slice(0, matchStart);
      for (var i = 0; i < labels.length; i++) {
        var labelWithSpace = labels[i] + ' ';
        if (prefix.endsWith(labelWithSpace)) {
          return {
            start: matchStart - labelWithSpace.length,
            text: labels[i]
          };
        }
      }

      return {
        start: matchStart,
        text: reference.startLine > 0
          ? fileName + ' (' + formatMessageLineLabel(reference.startLine, reference.endLine, reference.startColumn, reference.endColumn) + ')'
          : fileName
      };
    }

    function makeMessageFileHref(reference) {
      if (reference.startLine <= 0) {
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

    function formatMessageLineLabel(startLine, endLine, startColumn, endColumn) {
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

    function getMessageFileName(filePath) {
      var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
      var parts = normalized.split('/');
      return parts[parts.length - 1] || normalized || 'file';
    }

    function isLikelyMessageFilePath(path, rawTarget) {
      var value = String(path || '').trim();
      var target = String(rawTarget || '').trim();
      if (!value) return false;
      if (target.toLowerCase().indexOf('file:') === 0) return true;
      if (value.charAt(0) === '/' || value.charAt(0) === '~') return true;
      if (value.indexOf('./') === 0 || value.indexOf('../') === 0) return true;
      if (isMessageWindowsDrivePath(value)) return true;
      return value.indexOf('/') >= 0 || value.indexOf(String.fromCharCode(92)) >= 0;
    }

    function isMessageWindowsDrivePath(value) {
      if (value.length < 3 || value.charAt(1) !== ':') return false;
      var firstCode = value.charCodeAt(0);
      var isLetter = (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
      var separator = value.charAt(2);
      return isLetter && (separator === '/' || separator === String.fromCharCode(92));
    }

    function readReferenceInteger(value, fallback) {
      var number = Number(value);
      if (!Number.isFinite(number) || number < 1) {
        return fallback;
      }
      return Math.floor(number);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    vscode.postMessage({ type: 'ready' });`;
}
