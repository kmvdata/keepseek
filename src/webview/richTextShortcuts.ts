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
          if (moveSelectionWithModify(editor, markActive ? 'extend' : 'move', direction, granularity)) {
            notifySelectionChanged(editor);
          }
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
          if (!moveSelectionWithModify(editor, 'extend', 'forward', 'lineboundary')) {
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
