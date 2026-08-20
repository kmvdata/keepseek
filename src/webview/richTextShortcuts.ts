export function getRichTextShortcutsScript(): string {
  return `
    window.keepseekRichTextShortcuts = (function() {
      var clipboardRequestSequence = 0;
      var clipboardRequests = Object.create(null);

      function writeClipboardText(text) {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).catch(function() {
            vscode.postMessage({ type: 'writeClipboardText', text: text });
          });
        }
        vscode.postMessage({ type: 'writeClipboardText', text: text });
        return Promise.resolve();
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
        if (!message || message.type !== 'clipboardText') { return; }
        var requestId = message.requestId || '';
        var callback = clipboardRequests[requestId];
        delete clipboardRequests[requestId];
        if (callback) {
          callback(message.text || '');
        }
      });

      function createController(options) {
        var markActive = false;

        function getEditor() {
          return options.getEditor ? options.getEditor() : null;
        }

        function handleKeydown(event) {
          return handleSystemShortcut(event) || handleEmacsShortcut(event);
        }

        function handleSystemShortcut(event) {
          if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !isShortcutKey(event, 'a')) {
            return false;
          }
          return runShortcut(event, selectContents);
        }

        function handleEmacsShortcut(event) {
          if (event.metaKey) { return false; }
          if (isSetMarkShortcut(event)) {
            return runShortcut(event, setMark);
          }
          if (event.altKey && !event.ctrlKey && !event.shiftKey && isShortcutKey(event, 'w')) {
            return runShortcut(event, copySelection);
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
            return runShortcut(event, cutSelection);
          }
          if (isShortcutKey(event, 'y')) {
            return runShortcut(event, pasteClipboardText);
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
          if (execEditCommand(editor, 'cut')) { return; }

          var range = selection.getRangeAt(0).cloneRange();
          var text = selection.toString();
          writeClipboardText(text).then(function() {
            if (editor !== getEditor() || !isRangeInside(range, editor)) { return; }
            setSelectionRange(editor, range);
            saveSelection(editor);
            execEditCommand(editor, 'delete');
          }).catch(function() {});
        }

        function copySelection() {
          var editor = getEditor();
          var selection = getSelection(editor);
          if (!editor || !selection || selection.isCollapsed) { return; }
          if (execClipboardCommand('copy')) { return; }
          writeClipboardText(selection.toString()).catch(function() {});
        }

        function pasteClipboardText() {
          var editor = getEditor();
          if (!editor || !options.getInsertionRange || !options.insertText) { return; }
          var range = options.getInsertionRange(editor).cloneRange();
          readClipboardText(function(text) {
            insertClipboardTextAtRange(editor, range, text);
          });
        }

        function insertClipboardTextAtRange(editor, range, text) {
          if (!text || editor !== getEditor()) { return; }
          if (range && isRangeInside(range, editor)) {
            setSelectionRange(editor, range);
            saveSelection(editor);
          }
          deactivateMark();
          options.insertText(editor, text);
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
          var previous = {
            anchorNode: selection.anchorNode,
            anchorOffset: selection.anchorOffset,
            focusNode: selection.focusNode,
            focusOffset: selection.focusOffset,
            range: selection.getRangeAt(0).cloneRange()
          };
          var boundary = direction === 'backward'
            ? findLogicalLineStart(editor, selection.focusNode, selection.focusOffset)
            : findLogicalLineEnd(editor, selection.focusNode, selection.focusOffset);
          if (!boundary || !isRangeInside(boundary, editor)) { return false; }

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

        return {
          handleKeydown: handleKeydown,
          deactivateMark: deactivateMark,
          isMarkActive: function() { return markActive; }
        };
      }

      return {
        createController: createController,
        writeClipboardText: writeClipboardText,
        readClipboardText: readClipboardText
      };
    })();
`;
}
