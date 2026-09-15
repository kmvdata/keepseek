import type { WebviewFragment } from '../composition';

export const editorControllerFragment: WebviewFragment = {
  id: 'editor.controller',
  source: `
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

`.slice(1)
};

export const editorBindingsFragment: WebviewFragment = {
  id: 'editor.bindings',
  source: `
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
          // 推理期间引用菜单只读：放行默认行为（Enter 换行 / Tab 移焦），不吞键。
          if (state.isBusy) {
            return;
          }
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

`.slice(1)
};

export const editorSelectionBindingFragment: WebviewFragment = {
  id: 'editor.selection-binding',
  source: `
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

`.slice(1)
};

export const editorPasteBindingFragment: WebviewFragment = {
  id: 'editor.paste-binding',
  source: `
      promptInput.addEventListener('paste', function(event) {
        event.preventDefault();
        var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
        if (text) {
          insertPlainText(text);
        }
      });

`.slice(1)
};

export const editorTextRangeFragment: WebviewFragment = {
  id: 'editor.text-range',
  source: `
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

`.slice(1)
};

export const editorSelectionFragment: WebviewFragment = {
  id: 'editor.selection',
  source: `
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

`.slice(1)
};

export const editorVisualStateFragment: WebviewFragment = {
  id: 'editor.visual-state',
  source: `
      function updatePromptVisualState() {
        var isEmpty = isPromptEmpty();
        if (isEmpty) {
          normalizeEmptyPrompt();
        }
        // 上限 200 必须与 .rich-input 的 CSS max-height 保持一致；
        // 高度重置会让浏览器 clamp scrollTop（尤其滚动条出现、位于最后一行时），
        // 这里显式恢复滚动位置，避免每次输入视口跳动。
        var prevScrollTop = promptInput.scrollTop;
        promptInput.style.height = 'auto';
        promptInput.style.height = Math.min(promptInput.scrollHeight, 200) + 'px';
        promptInput.scrollTop = Math.min(prevScrollTop, Math.max(0, promptInput.scrollHeight - promptInput.clientHeight));
        promptInput.classList.toggle('is-empty', isEmpty);
        renderSendButton(isEmpty);
        renderContextProgress();
      }

      function isPromptEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !promptInput.querySelector('a.rich-skill-link') && !promptInput.textContent.trim();
      }

      function isPromptSubmittableEmpty() {
        return !promptInput.querySelector('a.rich-file-link') && !getPromptTextWithoutSkillLinks().trim();
      }

      function getPromptTextWithoutSkillLinks() {
        var clone = promptInput.cloneNode(true);
        if (clone.querySelectorAll) {
          clone.querySelectorAll('a.rich-skill-link').forEach(function(link) {
            link.remove();
          });
        }
        return clone.textContent || '';
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

`.slice(1)
};
