/** Shared popup UI. Editing commands and keyboard policy remain in richTextShortcuts.ts. */
export function getRichTextContextMenuScript(): string {
  return `
      var activeEmacsContextMenuClose = null;

      function createEmacsContextMenu(controller, options) {
        var menu = null;
        var editor = null;
        var contextId = '';
        var items = [];
        var commands = [
          ['cut', 'editorCut', 'Cut', 'C-w', 'kill-region'],
          ['copy', 'editorCopy', 'Copy', 'M-w', 'kill-ring-save'],
          ['yank', 'editorYank', 'Paste', 'C-y', 'yank'],
          ['yank-pop', 'editorYankPop', 'Cycle kill ring', 'M-y', 'yank-pop']
        ];

        function translate(key, fallback) {
          var translator = options.translate || options.t;
          var value = translator ? translator(key) : '';
          return value && value !== key ? value : fallback;
        }

        function close(restoreFocus) {
          if (!menu) { return; }
          var target = editor;
          var sameContext = !options.getContextId || options.getContextId() === contextId;
          menu.remove();
          menu = null;
          editor = null;
          items = [];
          document.removeEventListener('mousedown', dismissOutside);
          document.removeEventListener('focusin', dismissOnFocus);
          window.removeEventListener('blur', dismiss);
          window.removeEventListener('resize', dismiss);
          window.removeEventListener('scroll', dismiss, true);
          if (activeEmacsContextMenuClose === close) { activeEmacsContextMenuClose = null; }
          if (restoreFocus && sameContext && target && target.isConnected !== false &&
              (!options.getEditor || options.getEditor() === target)) {
            target.focus();
            if (options.restoreSelection) { options.restoreSelection(target); }
          }
        }

        function dismiss() { close(false); }

        function dismissOutside(event) {
          if (menu && !menu.contains(event.target)) { close(false); }
        }

        function dismissOnFocus(event) {
          if (menu && !menu.contains(event.target) && event.target !== editor) { close(false); }
        }

        function focusItem(direction, boundary) {
          var enabled = items.filter(function(item) { return !item.disabled; });
          if (!enabled.length) { return; }
          var index = enabled.indexOf(document.activeElement);
          if (boundary === 'start') { index = 0; }
          else if (boundary === 'end') { index = enabled.length - 1; }
          else if (index < 0) { index = direction < 0 ? enabled.length - 1 : 0; }
          else { index = (index + direction + enabled.length) % enabled.length; }
          enabled[index].focus();
        }

        function execute(command) {
          if (!editor || editor.isConnected === false ||
              (options.getEditor && options.getEditor() !== editor) ||
              (options.getContextId && options.getContextId() !== contextId)) {
            close(false);
            return;
          }
          // Restore the saved region before rechecking capability and dispatching.
          close(true);
          if (controller.canRunCommand(command)) { controller.runCommand(command); }
        }

        function open(event, target) {
          if (!target) { return false; }
          event.preventDefault();
          event.stopPropagation();
          if (activeEmacsContextMenuClose) { activeEmacsContextMenuClose(false); }
          editor = target;
          contextId = options.getContextId ? options.getContextId() : '';
          if (options.saveSelection) { options.saveSelection(editor); }
          menu = document.createElement('div');
          menu.id = 'keepseek-editor-context-menu';
          menu.className = 'emacs-editor-context-menu';
          menu.setAttribute('role', 'menu');
          menu.setAttribute('aria-label', 'Emacs');
          activeEmacsContextMenuClose = close;

          commands.forEach(function(command) {
            var item = document.createElement('button');
            item.type = 'button';
            item.className = 'emacs-editor-context-item';
            item.dataset.emacsCommand = command[0];
            item.setAttribute('role', 'menuitem');
            item.setAttribute('aria-keyshortcuts', command[3].replace('C-', 'Control+').replace('M-', 'Alt+'));
            item.disabled = !controller.canRunCommand(command[0]);
            item.setAttribute('aria-disabled', String(item.disabled));
            item.tabIndex = -1;
            item.title = command[4];
            var label = document.createElement('span');
            label.textContent = translate(command[1], command[2]);
            var shortcut = document.createElement('kbd');
            shortcut.textContent = command[3];
            item.append(label, shortcut);
            item.addEventListener('click', function() { execute(command[0]); });
            items.push(item);
            menu.append(item);
          });
          var hint = document.createElement('div');
          hint.className = 'emacs-editor-context-hint';
          hint.textContent = translate('editorEmacsKeysHint', 'C = Ctrl · M = Alt / Option');
          menu.append(hint);
          // A mouse press must preserve the original editor region.
          menu.addEventListener('mousedown', function(e) { e.preventDefault(); e.stopPropagation(); });
          menu.addEventListener('contextmenu', function(e) { e.preventDefault(); e.stopPropagation(); });
          menu.addEventListener('keydown', function(e) {
            if (e.isComposing || e.keyCode === 229) { return; }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
              e.preventDefault(); e.stopPropagation();
              focusItem(e.key === 'ArrowUp' ? -1 : 1, e.key === 'Home' ? 'start' : e.key === 'End' ? 'end' : '');
            } else if (e.key === 'Escape') {
              e.preventDefault(); e.stopPropagation(); close(true);
            } else if (e.key === 'Enter' || e.key === ' ') {
              var item = document.activeElement;
              if (item && items.indexOf(item) >= 0 && !item.disabled) {
                e.preventDefault(); e.stopPropagation(); execute(item.dataset.emacsCommand);
              }
            } else if (e.key === 'Tab') {
              e.preventDefault(); e.stopPropagation(); close(true);
            }
          });
          document.body.append(menu);
          var bounds = menu.getBoundingClientRect();
          var anchor = target.getBoundingClientRect();
          var x = Number(event.clientX) || anchor.left;
          var y = Number(event.clientY) || anchor.bottom;
          var width = bounds.width || 240;
          var height = bounds.height || 156;
          menu.style.left = Math.max(4, Math.min(x, window.innerWidth - width - 4)) + 'px';
          menu.style.top = Math.max(4, Math.min(y, window.innerHeight - height - 4)) + 'px';
          document.addEventListener('mousedown', dismissOutside);
          document.addEventListener('focusin', dismissOnFocus);
          window.addEventListener('blur', dismiss);
          window.addEventListener('resize', dismiss);
          window.addEventListener('scroll', dismiss, true);
          focusItem(1, 'start');
          return true;
        }

        return { open: open, close: close };
      }
`;
}
