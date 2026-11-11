import { getRichTextContextMenuScript } from './richTextContextMenu';

export function getRichTextShortcutsScript(): string {
  return `
    window.keepseekRichTextShortcuts = (function() {
      var clipboardRequestSequence = 0;
      var clipboardRequests = Object.create(null);
      var clipboardWrites = Object.create(null);
      var pendingClipboardWrite = null;
      var clipboardWriteVersion = 0;
      // Shared only by this Webview's editors; never serialized into a session or request.
      var killRing = [];
      var commandGeneration = 0;
      var killRingLimit = 60;
      var focusedEditor = null;

      ${getRichTextContextMenuScript()}

      function rememberKill(text) {
        if (!text) { return; }
        if (killRing[0] !== text) {
          killRing.unshift(text);
          if (killRing.length > killRingLimit) { killRing.length = killRingLimit; }
        }
      }

      function writeClipboardText(text) {
        var version = ++clipboardWriteVersion;
        function write() {
          if (version !== clipboardWriteVersion) { return Promise.resolve(); }
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            return navigator.clipboard.writeText(text).catch(function() {
              return requestClipboardWrite(text);
            });
          }
          return requestClipboardWrite(text);
        }
        // Preserve command order when a second kill/copy arrives before the first write settles.
        var operation = pendingClipboardWrite ? pendingClipboardWrite.catch(function() {}).then(write) : write();
        pendingClipboardWrite = operation;
        function settled() { if (pendingClipboardWrite === operation) { pendingClipboardWrite = null; } }
        operation.then(settled, settled);
        return operation;
      }

      function requestClipboardWrite(text) {
        clipboardRequestSequence += 1;
        var requestId = 'clipboardWrite:' + clipboardRequestSequence + ':' + Date.now();
        return new Promise(function(resolve, reject) {
          var timeout = setTimeout(function() {
            delete clipboardWrites[requestId];
            reject(new Error('Clipboard write timed out'));
          }, 5000);
          clipboardWrites[requestId] = { resolve: resolve, reject: reject, timeout: timeout };
          vscode.postMessage({ type: 'writeClipboardText', text: text, requestId: requestId });
        });
      }

      function readClipboardText(callback) {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          navigator.clipboard.readText().then(callback).catch(function() {
            requestClipboardText(callback);
          });
          return;
        }
        requestClipboardText(callback);
      }

      function requestClipboardText(callback) {
        clipboardRequestSequence += 1;
        var requestId = 'clipboardText:' + clipboardRequestSequence + ':' + Date.now();
        clipboardRequests[requestId] = callback;
        vscode.postMessage({ type: 'requestClipboardText', requestId: requestId });
      }

      window.addEventListener('message', function(event) {
        var message = event.data;
        if (message && message.type === 'clipboardWriteResult') {
          var pendingWrite = clipboardWrites[message.requestId];
          if (pendingWrite) {
            clearTimeout(pendingWrite.timeout);
            delete clipboardWrites[message.requestId];
            if (message.ok === true) { pendingWrite.resolve(); }
            else { pendingWrite.reject(new Error('Clipboard write failed')); }
          }
          return;
        }
        if (!message || message.type !== 'clipboardText') { return; }
        var requestId = message.requestId || '';
        var callback = clipboardRequests[requestId];
        delete clipboardRequests[requestId];
        if (callback) {
          callback(message.text || '', Boolean(message.error));
        }
      });

      function createController(options) {
        var markActive = false;
        var lastYank = null;
        var contextMenu = null;

        function getEditor() {
          return options.getEditor ? options.getEditor() : null;
        }

        function handleKeydown(event) {
          if (!event || event.isComposing || event.keyCode === 229) { return false; }
          var isYank = !event.metaKey && !event.shiftKey &&
            ((event.ctrlKey && !event.altKey) || (event.altKey && !event.ctrlKey)) && isShortcutKey(event, 'y');
          if (!isYank && !['Control', 'Alt', 'Meta', 'Shift'].includes(event.key)) { invalidateYank(); }
          return handleSystemShortcut(event) || handleEmacsShortcut(event);
        }

        function handleContextMenu(event) {
          var editor = getEditor();
          if (!editor) { return; }
          if (!contextMenu) { contextMenu = createEmacsContextMenu(controller, options); }
          contextMenu.open(event, editor);
        }

        function closeContextMenu() {
          if (contextMenu) { contextMenu.close(false); }
        }

        function invalidateYank() {
          lastYank = null;
          commandGeneration += 1;
        }

        function handleFocus() {
          var editor = getEditor();
          if (focusedEditor && focusedEditor !== editor) { invalidateYank(); }
          focusedEditor = editor;
        }

        function getContextId() {
          return options.getContextId ? options.getContextId() : '';
        }

        function canRunCommand(command) {
          var editor = getEditor();
          if (!editor) { return false; }
          if (command === 'copy') {
            var selection = getSelection(editor);
            return Boolean(selection && !selection.isCollapsed);
          }
          if (editor.getAttribute('contenteditable') === 'false') { return false; }
          if (command === 'cut') {
            var cutSelection = getSelection(editor);
            return Boolean(cutSelection && !cutSelection.isCollapsed);
          }
          if (command === 'yank') { return true; }
          if (command === 'yank-pop') {
            var caret = getSelection(editor);
            return Boolean(lastYank && lastYank.editor === editor && lastYank.contextId === getContextId() &&
              lastYank.generation === commandGeneration && editor.innerHTML === lastYank.snapshot &&
              isRangeInside(lastYank.range, editor) && caret && caret.isCollapsed &&
              caret.focusNode === lastYank.caretNode && caret.focusOffset === lastYank.caretOffset && killRing.length);
          }
          return false;
        }

        function runCommand(command) {
          if (!canRunCommand(command)) { return false; }
          if (command === 'yank-pop') { return yankPop(); }
          invalidateYank();
          if (command === 'cut') { cutSelection(); }
          else if (command === 'copy') { copySelection(); }
          else if (command === 'yank') { pasteClipboardText(); }
          else { return false; }
          return true;
        }

        function handleSystemShortcut(event) {
          if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !isShortcutKey(event, 'a')) {
            return false;
          }
          return runShortcut(event, selectContents);
        }

        function handleEmacsShortcut(event) {
          if (event.metaKey) { return false; }
          if (isAltShiftBoundaryShortcut(event, '<', 'Comma')) {
            return runShortcut(event, function() { moveSelectionToEditorBoundary('backward'); });
          }
          if (isAltShiftBoundaryShortcut(event, '>', 'Period')) {
            return runShortcut(event, function() { moveSelectionToEditorBoundary('forward'); });
          }
          if (isCtrlShiftAsciiShortcut(event, '_')) {
            return runShortcut(event, undoEdit);
          }
          if (isSetMarkShortcut(event)) {
            return runShortcut(event, setMark);
          }
          if (event.altKey && !event.ctrlKey && !event.shiftKey && isShortcutKey(event, 'w')) {
            return runShortcut(event, function() { runCommand('copy'); });
          }
          if (event.altKey && !event.ctrlKey && !event.shiftKey && isShortcutKey(event, 'y')) {
            return runShortcut(event, function() { runCommand('yank-pop'); });
          }
          if (!event.ctrlKey || event.altKey || event.shiftKey) { return false; }

          if (isShortcutKey(event, 'g')) {
            return runShortcut(event, cancelMark);
          }
          if (isShortcutKey(event, 'f')) {
            return runShortcut(event, function() { moveSelection('forward', 'character'); });
          }
          if (isShortcutKey(event, 'b')) {
            return runShortcut(event, function() { moveSelection('backward', 'character'); });
          }
          if (isShortcutKey(event, 'n')) {
            return runShortcut(event, function() { moveSelection('forward', 'line'); });
          }
          if (isShortcutKey(event, 'p')) {
            return runShortcut(event, function() { moveSelection('backward', 'line'); });
          }
          if (isShortcutKey(event, 'a')) {
            return runShortcut(event, function() { moveSelection('backward', 'lineboundary'); });
          }
          if (isShortcutKey(event, 'e')) {
            return runShortcut(event, function() { moveSelection('forward', 'lineboundary'); });
          }
          if (isShortcutKey(event, 'v')) {
            return runShortcut(event, pageDownSelection);
          }
          if (isShortcutKey(event, 'd')) {
            return runShortcut(event, function() { deleteSelectionOrCharacter('forward'); });
          }
          if (isShortcutKey(event, 'h') || event.key === 'Backspace') {
            return runShortcut(event, function() { deleteSelectionOrCharacter('backward'); });
          }
          if (isShortcutKey(event, 'k')) {
            return runShortcut(event, killLine);
          }
          if (isShortcutKey(event, 'w')) {
            return runShortcut(event, function() { runCommand('cut'); });
          }
          if (isShortcutKey(event, 'y')) {
            return runShortcut(event, function() { runCommand('yank'); });
          }
          return false;
        }

        function runShortcut(event, action) {
          event.preventDefault();
          event.stopPropagation();
          action();
          return true;
        }

        function isShortcutKey(event, key) {
          return String(event.key || '').toLowerCase() === key || event.code === 'Key' + key.toUpperCase();
        }

        function isCtrlShiftAsciiShortcut(event, key) {
          return Boolean(event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key === key);
        }

        function isAltShiftBoundaryShortcut(event, key, code) {
          return Boolean(event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey &&
            (event.code === code || event.key === key));
        }

        function isSetMarkShortcut(event) {
          if (!event.ctrlKey || event.metaKey || event.altKey) { return false; }
          return event.code === 'Space' ||
            event.key === ' ' ||
            event.key === 'Spacebar' ||
            event.key === String.fromCharCode(0) ||
            event.key === '@' ||
            (event.shiftKey && event.code === 'Digit2');
        }

        function getSelection(editor) {
          var selection = window.getSelection();
          if (!selection || !selection.rangeCount) { return null; }
          return isRangeInside(selection.getRangeAt(0), editor) ? selection : null;
        }

        function isSelectionInside() {
          var editor = getEditor();
          return Boolean(editor && getSelection(editor));
        }

        function isRangeInside(range, editor) {
          return Boolean(editor && range && options.isRangeInside && options.isRangeInside(range, editor));
        }

        function isNodeInside(node, editor) {
          return Boolean(editor && node && options.isNodeInside && options.isNodeInside(node, editor));
        }

        function setSelectionRange(editor, range) {
          if (!editor || !range || !options.setSelectionRange) { return; }
          options.setSelectionRange(editor, range);
        }

        function saveSelection(editor) {
          if (editor && options.saveSelection) {
            options.saveSelection(editor);
          }
        }

        function restoreSelection(editor) {
          if (editor && options.restoreSelection) {
            options.restoreSelection(editor);
          }
        }

        function notifySelectionChanged(editor) {
          saveSelection(editor);
          if (editor && options.onSelectionChanged) {
            options.onSelectionChanged(editor);
          }
        }

        function notifyEdited(editor) {
          invalidateYank();
          deactivateMark();
          if (editor && options.onEdited) {
            options.onEdited(editor);
          }
        }

        function moveSelection(direction, granularity) {
          var editor = getEditor();
          if (!editor) { return; }
          var alter = markActive ? 'extend' : 'move';
          var moved = granularity === 'lineboundary'
            ? moveSelectionToLogicalLineBoundary(editor, alter, direction)
            : moveSelectionWithModify(editor, alter, direction, granularity);
          if (moved) {
            if (granularity === 'line') {
              scrollSelectionFocusIntoView(editor);
            }
            notifySelectionChanged(editor);
          }
        }

        function moveSelectionToEditorBoundary(direction) {
          var editor = getEditor();
          if (!editor) { return; }
          var boundary = document.createRange();
          boundary.selectNodeContents(editor);
          boundary.collapse(direction === 'backward');
          if (!moveSelectionToBoundaryRange(editor, markActive ? 'extend' : 'move', boundary)) {
            return;
          }
          editor.scrollTop = direction === 'backward'
            ? 0
            : Math.max(0, (Number(editor.scrollHeight) || 0) - (Number(editor.clientHeight) || 0));
          notifySelectionChanged(editor);
        }

        function scrollSelectionFocusIntoView(editor) {
          var selection = getSelection(editor);
          if (!selection || !isNodeInside(selection.focusNode, editor) ||
            typeof editor.getBoundingClientRect !== 'function') {
            return;
          }
          var focusRange = document.createRange();
          try {
            focusRange.setStart(selection.focusNode, selection.focusOffset);
            focusRange.collapse(true);
          } catch (error) {
            return;
          }
          var caretRect = getVisibleRangeRect(focusRange);
          if (!caretRect) { return; }

          var editorRect = editor.getBoundingClientRect();
          var viewportTop = editorRect.top + (Number(editor.clientTop) || 0);
          var viewportBottom = viewportTop + (Number(editor.clientHeight) || 0);
          if (!Number.isFinite(viewportTop) || !Number.isFinite(viewportBottom) || viewportBottom <= viewportTop) {
            return;
          }

          var edgePadding = 2;
          var scrollDelta = 0;
          if (caretRect.top < viewportTop + edgePadding) {
            scrollDelta = caretRect.top - viewportTop - edgePadding;
          } else if (caretRect.bottom > viewportBottom - edgePadding) {
            scrollDelta = caretRect.bottom - viewportBottom + edgePadding;
          }
          if (!scrollDelta) { return; }

          var maximumScrollTop = Math.max(0,
            (Number(editor.scrollHeight) || 0) - (Number(editor.clientHeight) || 0));
          var nextScrollTop = Math.max(0, Math.min(maximumScrollTop,
            (Number(editor.scrollTop) || 0) + scrollDelta));
          editor.scrollTop = nextScrollTop;
        }

        function getVisibleRangeRect(range) {
          var rect = null;
          if (range && typeof range.getBoundingClientRect === 'function') {
            try {
              rect = range.getBoundingClientRect();
            } catch (error) {
              rect = null;
            }
          }
          if (!isUsableVerticalRect(rect) && range && typeof range.getClientRects === 'function') {
            try {
              var rects = range.getClientRects();
              if (rects && rects.length) {
                rect = rects[rects.length - 1];
              }
            } catch (error) {
              rect = null;
            }
          }
          return isUsableVerticalRect(rect) ? rect : null;
        }

        function isUsableVerticalRect(rect) {
          return Boolean(rect && Number.isFinite(rect.top) && Number.isFinite(rect.bottom) && rect.bottom > rect.top);
        }

        function pageDownSelection() {
          var editor = getEditor();
          if (!editor) { return; }
          var moved = moveSelectionWithModify(editor, markActive ? 'extend' : 'move', 'forward', 'page');
          editor.scrollTop = Math.min(editor.scrollHeight, editor.scrollTop + Math.max(editor.clientHeight, 120));
          if (moved) {
            notifySelectionChanged(editor);
          } else {
            saveSelection(editor);
          }
        }

        function deleteSelectionOrCharacter(direction) {
          var editor = getEditor();
          var selection = getSelection(editor);
          if (!editor || !selection) { return; }
          if (selection.isCollapsed && !moveSelectionWithModify(editor, 'extend', direction, 'character')) {
            return;
          }
          selection = getSelection(editor);
          if (!selection || selection.isCollapsed) { return; }
          execEditCommand(editor, 'delete');
        }

        function undoEdit() {
          var editor = getEditor();
          if (!editor) { return; }
          execEditCommand(editor, 'undo');
        }

        function killLine() {
          var editor = getEditor();
          if (!editor || !collapseSelectionToFocus(editor)) { return; }
          if (!moveSelectionToLogicalLineBoundary(editor, 'extend', 'forward')) {
            return;
          }
          var selection = getSelection(editor);
          if (!selection || selection.isCollapsed) { return; }
          cutSelection();
        }

        function cutSelection() {
          var editor = getEditor();
          var selection = getSelection(editor);
          if (!editor || !selection || selection.isCollapsed) { return; }
          var text = selection.toString();
          if (!text) { return; }
          // The full text is recoverable from the ring before removing any selection.
          rememberKill(text);
          execEditCommand(editor, 'delete');
          writeClipboardText(text).catch(function() {});
        }

        function copySelection() {
          var editor = getEditor();
          var selection = getSelection(editor);
          if (!editor || !selection || selection.isCollapsed) { return; }
          rememberKill(selection.toString());
          writeClipboardText(selection.toString()).catch(function() {});
        }

        function pasteClipboardText() {
          var editor = getEditor();
          if (!editor || !options.getInsertionRange || !options.insertText) { return; }
          var range = options.getInsertionRange(editor).cloneRange();
          var generation = commandGeneration;
          var contextId = getContextId();
          var snapshot = editor.innerHTML;
          var caret = getSelection(editor);
          var caretNode = caret && caret.focusNode;
          var caretOffset = caret && caret.focusOffset;
          var fallback = killRing[0] || '';
          function accept(text, failed) {
            var currentSelection = getSelection(editor);
            var value = !failed && text ? text : fallback;
            if (!value || generation !== commandGeneration || editor !== getEditor() || contextId !== getContextId() ||
                editor.innerHTML !== snapshot || !currentSelection || currentSelection.focusNode !== caretNode ||
                currentSelection.focusOffset !== caretOffset) { return; }
            rememberKill(value);
            insertYankAtRange(editor, range, value, 0);
          }
          function read() { readClipboardText(accept); }
          if (pendingClipboardWrite) { pendingClipboardWrite.then(read, function() { accept('', true); }); }
          else { read(); }
        }

        function insertYankAtRange(editor, range, text, index) {
          if (!text || editor !== getEditor() || !isRangeInside(range, editor)) { return; }
          var start = range.cloneRange();
          start.collapse(true);
          setSelectionRange(editor, range);
          saveSelection(editor);
          deactivateMark();
          options.insertText(editor, text);
          var selection = getSelection(editor);
          if (!selection || !selection.isCollapsed) { return; }
          var end = selection.getRangeAt(0);
          start.setEnd(end.endContainer, end.endOffset);
          if (!isRangeInside(start, editor)) { return; }
          lastYank = { editor: editor, range: start.cloneRange(), index: index,
            snapshot: editor.innerHTML, caretNode: selection.focusNode, caretOffset: selection.focusOffset,
            contextId: getContextId(), generation: commandGeneration };
        }

        function yankPop() {
          if (!canRunCommand('yank-pop')) { return false; }
          var previous = lastYank;
          var index = (previous.index + 1) % killRing.length;
          insertYankAtRange(previous.editor, previous.range.cloneRange(), killRing[index], index);
          return true;
        }

        function setMark() {
          var editor = getEditor();
          if (!editor) { return; }
          if (!getSelection(editor)) {
            restoreSelection(editor);
          }
          if (!collapseSelectionToFocus(editor)) { return; }
          markActive = true;
          notifySelectionChanged(editor);
        }

        function cancelMark() {
          var editor = getEditor();
          deactivateMark();
          if (!editor) { return; }
          collapseSelectionToFocus(editor);
          notifySelectionChanged(editor);
        }

        function deactivateMark() {
          markActive = false;
          // Background empty-editor normalization must not invalidate a sibling's yank.
          lastYank = null;
        }

        function collapseSelectionToFocus(editor) {
          var selection = getSelection(editor);
          if (!selection || !isNodeInside(selection.focusNode, editor)) { return false; }
          var range = document.createRange();
          range.setStart(selection.focusNode, selection.focusOffset);
          range.collapse(true);
          setSelectionRange(editor, range);
          return true;
        }

        function moveSelectionWithModify(editor, alter, direction, granularity) {
          var selection = getSelection(editor);
          if (!selection || typeof selection.modify !== 'function') { return false; }
          var previous = selection.getRangeAt(0).cloneRange();
          try {
            selection.modify(alter, direction, granularity);
          } catch (error) {
            setSelectionRange(editor, previous);
            saveSelection(editor);
            return false;
          }
          if (!isSelectionInside()) {
            setSelectionRange(editor, previous);
            saveSelection(editor);
            return false;
          }
          return true;
        }

        function moveSelectionToLogicalLineBoundary(editor, alter, direction) {
          var selection = getSelection(editor);
          if (!selection || !isNodeInside(selection.focusNode, editor)) { return false; }
          var boundary = direction === 'backward'
            ? findLogicalLineStart(editor, selection.focusNode, selection.focusOffset)
            : findLogicalLineEnd(editor, selection.focusNode, selection.focusOffset);
          return moveSelectionToBoundaryRange(editor, alter, boundary);
        }

        function moveSelectionToBoundaryRange(editor, alter, boundary) {
          var selection = getSelection(editor);
          if (!selection || !boundary || !isRangeInside(boundary, editor)) { return false; }
          var previous = {
            anchorNode: selection.anchorNode,
            anchorOffset: selection.anchorOffset,
            focusNode: selection.focusNode,
            focusOffset: selection.focusOffset,
            range: selection.getRangeAt(0).cloneRange()
          };
          var didSetSelection = alter === 'extend'
            ? setDirectionalSelection(
              editor,
              selection.anchorNode,
              selection.anchorOffset,
              boundary.startContainer,
              boundary.startOffset
            )
            : setCollapsedSelection(editor, boundary);
          if (!didSetSelection || !isSelectionInside()) {
            restoreSelectionSnapshot(editor, previous);
            return false;
          }
          return true;
        }

        function findLogicalLineStart(editor, focusNode, focusOffset) {
          var point = normalizeDomPoint(editor, focusNode, focusOffset);
          if (!point) { return null; }

          if (point.node.nodeType === Node.ELEMENT_NODE && point.offset < point.node.childNodes.length) {
            var nextChild = point.node.childNodes[point.offset];
            if (isLogicalLineBoundaryElement(nextChild) && nextChild.tagName !== 'BR') {
              return createLogicalLineBoundaryRange(editor, point, 'backward');
            }
          }

          while (point) {
            if (point.node.nodeType === Node.TEXT_NODE) {
              var textBefore = point.node.nodeValue || '';
              var previousLineBreak = point.offset > 0
                ? textBefore.lastIndexOf(String.fromCharCode(10), point.offset - 1)
                : -1;
              if (previousLineBreak >= 0) {
                return createLogicalLineBoundaryRange(editor, {
                  node: point.node,
                  offset: previousLineBreak + 1
                }, 'backward');
              }
              point = getPointBeforeNode(point.node);
              continue;
            }
            if (point.offset > 0) {
              var previousChild = point.node.childNodes[point.offset - 1];
              if (isLogicalLineBoundaryElement(previousChild)) {
                return createLogicalLineBoundaryRange(editor, point, 'backward');
              }
              point = { node: previousChild, offset: getNodeEndOffset(previousChild) };
              continue;
            }
            if (point.node === editor || isBlockElement(point.node)) {
              return createLogicalLineBoundaryRange(editor, point, 'backward');
            }
            point = getPointBeforeNode(point.node);
          }
          return null;
        }

        function findLogicalLineEnd(editor, focusNode, focusOffset) {
          var point = normalizeDomPoint(editor, focusNode, focusOffset);
          if (!point) { return null; }
          var canEnterFollowingBlock = point.node.nodeType === Node.ELEMENT_NODE;

          while (point) {
            if (point.node.nodeType === Node.TEXT_NODE) {
              var textAfter = point.node.nodeValue || '';
              var nextLineBreak = textAfter.indexOf(String.fromCharCode(10), point.offset);
              if (nextLineBreak >= 0) {
                return createLogicalLineBoundaryRange(editor, {
                  node: point.node,
                  offset: nextLineBreak
                }, 'forward');
              }
              canEnterFollowingBlock = false;
              point = getPointAfterNode(point.node);
              continue;
            }
            if (point.offset < point.node.childNodes.length) {
              var nextChild = point.node.childNodes[point.offset];
              if (isLogicalLineBoundaryElement(nextChild)) {
                if (nextChild.tagName !== 'BR' && canEnterFollowingBlock) {
                  point = { node: nextChild, offset: 0 };
                  continue;
                }
                return createLogicalLineBoundaryRange(editor, point, 'forward');
              }
              point = { node: nextChild, offset: 0 };
              continue;
            }
            if (point.node === editor || isBlockElement(point.node)) {
              return createLogicalLineBoundaryRange(editor, point, 'forward');
            }
            point = getPointAfterNode(point.node);
          }
          return null;
        }

        function isLogicalLineBoundaryElement(node) {
          return Boolean(node && node.nodeType === Node.ELEMENT_NODE &&
            (node.tagName === 'BR' || isBlockElement(node)));
        }

        function isBlockElement(node) {
          if (!node || node.nodeType !== Node.ELEMENT_NODE) { return false; }
          if (options.isBlockElement) {
            return Boolean(options.isBlockElement(node));
          }
          return node.tagName === 'DIV' || node.tagName === 'P' || node.tagName === 'LI' ||
            node.tagName === 'UL' || node.tagName === 'OL';
        }

        function normalizeDomPoint(editor, node, offset) {
          if (!node || !isNodeInside(node, editor)) { return null; }
          if (node.nodeType === Node.TEXT_NODE) {
            return {
              node: node,
              offset: clampOffset(offset, (node.nodeValue || '').length)
            };
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            return {
              node: node,
              offset: clampOffset(offset, node.childNodes.length)
            };
          }
          var parent = node.parentNode;
          if (!parent || !isNodeInside(parent, editor)) { return null; }
          var index = getNodeIndex(node);
          return {
            node: parent,
            offset: index + (Number(offset) > 0 ? 1 : 0)
          };
        }

        function clampOffset(offset, maximum) {
          var value = Number(offset);
          if (!Number.isFinite(value)) { value = 0; }
          return Math.max(0, Math.min(maximum, Math.floor(value)));
        }

        function getNodeEndOffset(node) {
          return node.nodeType === Node.TEXT_NODE
            ? (node.nodeValue || '').length
            : node.childNodes.length;
        }

        function getPointBeforeNode(node) {
          var parent = node && node.parentNode;
          if (!parent) { return null; }
          return { node: parent, offset: getNodeIndex(node) };
        }

        function getPointAfterNode(node) {
          var parent = node && node.parentNode;
          if (!parent) { return null; }
          return { node: parent, offset: getNodeIndex(node) + 1 };
        }

        function getNodeIndex(node) {
          return Array.prototype.indexOf.call(node.parentNode.childNodes, node);
        }

        function createLogicalLineBoundaryRange(editor, point, direction) {
          var safePoint = movePointOutsideNonEditable(editor, point, direction);
          if (!safePoint) { return null; }
          var range = document.createRange();
          try {
            range.setStart(safePoint.node, safePoint.offset);
            range.collapse(true);
          } catch (error) {
            return null;
          }
          return isRangeInside(range, editor) ? range : null;
        }

        function movePointOutsideNonEditable(editor, point, direction) {
          var element = point.node.nodeType === Node.ELEMENT_NODE ? point.node : point.node.parentNode;
          var nonEditable = null;
          while (element && element !== editor) {
            if (element.nodeType === Node.ELEMENT_NODE &&
              String(element.getAttribute('contenteditable') || '').toLowerCase() === 'false') {
              nonEditable = element;
            }
            element = element.parentNode;
          }
          if (!nonEditable || !nonEditable.parentNode) { return point; }
          var index = getNodeIndex(nonEditable);
          return {
            node: nonEditable.parentNode,
            offset: direction === 'backward' ? index : index + 1
          };
        }

        function setCollapsedSelection(editor, range) {
          setSelectionRange(editor, range);
          var selection = getSelection(editor);
          return Boolean(selection && selection.isCollapsed &&
            selection.focusNode === range.startContainer && selection.focusOffset === range.startOffset);
        }

        function setDirectionalSelection(editor, anchorNode, anchorOffset, focusNode, focusOffset) {
          if (!isNodeInside(anchorNode, editor) || !isNodeInside(focusNode, editor)) { return false; }
          var anchorRange = document.createRange();
          var focusRange = document.createRange();
          try {
            anchorRange.setStart(anchorNode, anchorOffset);
            anchorRange.collapse(true);
            focusRange.setStart(focusNode, focusOffset);
            focusRange.collapse(true);
          } catch (error) {
            return false;
          }
          if (!isRangeInside(anchorRange, editor) || !isRangeInside(focusRange, editor)) { return false; }

          var selection = window.getSelection();
          if (!selection) { return false; }
          try {
            editor.focus();
            if (typeof selection.setBaseAndExtent === 'function') {
              selection.setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset);
            } else if (typeof selection.extend === 'function') {
              setSelectionRange(editor, anchorRange);
              selection = window.getSelection();
              if (!selection) { return false; }
              selection.extend(focusNode, focusOffset);
            } else {
              return false;
            }
          } catch (error) {
            return false;
          }
          return Boolean(selection.anchorNode === anchorNode && selection.anchorOffset === anchorOffset &&
            selection.focusNode === focusNode && selection.focusOffset === focusOffset &&
            selection.rangeCount && isRangeInside(selection.getRangeAt(0), editor));
        }

        function restoreSelectionSnapshot(editor, snapshot) {
          if (!setDirectionalSelection(
            editor,
            snapshot.anchorNode,
            snapshot.anchorOffset,
            snapshot.focusNode,
            snapshot.focusOffset
          )) {
            setSelectionRange(editor, snapshot.range);
          }
          saveSelection(editor);
        }

        function execEditCommand(editor, command) {
          var didRun = execClipboardCommand(command);
          if (didRun) {
            notifyEdited(editor);
            return true;
          }
          if (command === 'delete') {
            return deleteSelectionContents(editor);
          }
          return false;
        }

        function execClipboardCommand(command) {
          try {
            return document.execCommand(command);
          } catch (error) {
            return false;
          }
        }

        function selectContents() {
          var editor = getEditor();
          if (!editor) { return; }
          deactivateMark();
          var range = document.createRange();
          range.selectNodeContents(editor);
          setSelectionRange(editor, range);
          notifySelectionChanged(editor);
        }

        function deleteSelectionContents(editor) {
          var selection = getSelection(editor);
          if (!selection || selection.isCollapsed) { return false; }
          var range = selection.getRangeAt(0);
          range.deleteContents();
          range.collapse(true);
          setSelectionRange(editor, range);
          notifyEdited(editor);
          return true;
        }

        var controller = {
          handleKeydown: handleKeydown,
          handleContextMenu: handleContextMenu,
          handleFocus: handleFocus,
          closeContextMenu: closeContextMenu,
          runCommand: runCommand,
          canRunCommand: canRunCommand,
          invalidateYank: invalidateYank,
          deactivateMark: deactivateMark,
          isMarkActive: function() { return markActive; }
        };
        return controller;
      }

      return {
        createController: createController,
        writeClipboardText: writeClipboardText,
        readClipboardText: readClipboardText
      };
    })();
`;
}
