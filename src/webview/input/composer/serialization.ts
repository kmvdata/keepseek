import type { WebviewFragment } from '../composition';

export const composerSerializationFragment: WebviewFragment = {
  id: 'composer.serialization',
  source: `
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
        if (element.matches('a.rich-skill-link')) {
          parts.push(skillLinkToText(element));
          return;
        }
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
        var reference = readFileReferenceLink(link);
        if (reference.kind === 'directory') {
          var directoryLabel = getDirectoryName(reference.path);
          return makeStandaloneReferenceText(directoryLabel + ' <' + makeDirectoryHref(reference) + '>');
        }
        if (reference.startLine > 0 && reference.endLine < reference.startLine) {
          reference.endLine = reference.startLine;
        }
        return makeStandaloneReferenceText(formatFileReferenceTextLabel(reference) + String.fromCharCode(10) + '<' + makeFileHref(reference) + '>');
      }

      function skillLinkToText(link) {
        var skill = getSkillById(link.dataset.skillId || '');
        if (skill) {
          return getSkillMarkdownText(skill);
        }
        var text = String(link.textContent || '').trim();
        var label = text.charAt(0) === '$' ? text : '$' + text;
        var skillPath = String(link.dataset.skillPath || link.getAttribute('href') || '').trim();
        return skillPath ? '[' + label + '](' + skillPath + ')' : label;
      }

      function makeStandaloneReferenceText(text) {
        var lineBreak = String.fromCharCode(10);
        return lineBreak + text + lineBreak;
      }

      function collectPromptFileReferences() {
        var references = [];
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          var reference = readFileReferenceLink(link);
          if (reference.path) {
            references.push(reference);
          }
        });
        return references;
      }

      function readFileReferenceLink(link) {
        var kind = link.dataset.kind === 'directory' ? 'directory' : 'file';
        return {
          path: link.dataset.path || '',
          kind: kind,
          startLine: readPositiveInteger(link.dataset.startLine, 0),
          endLine: readPositiveInteger(link.dataset.endLine, 0),
          startColumn: readPositiveInteger(link.dataset.startColumn, 0),
          endColumn: readPositiveInteger(link.dataset.endColumn, 0)
        };
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

      function sanitizePromptContent() {
        sanitizePromptFormatting();
        sanitizePromptLinks();
      }

      function sanitizePromptFormatting() {
        sanitizePromptFormattingNode(promptInput);
      }

      function sanitizePromptFormattingNode(node) {
        var child = node.firstChild;
        while (child) {
          var next = child.nextSibling;
          if (child.nodeType === Node.COMMENT_NODE) {
            child.remove();
            child = next;
            continue;
          }
          if (child.nodeType !== Node.ELEMENT_NODE) {
            child = next;
            continue;
          }

          var element = child;
          if (element.matches('a.rich-file-link') || element.matches('a.rich-skill-link')) {
            child = next;
            continue;
          }
          if (element.tagName === 'BR') {
            clearPromptElementAttributes(element);
            child = next;
            continue;
          }
          if (isBlockElement(element)) {
            clearPromptElementAttributes(element);
            sanitizePromptFormattingNode(element);
            child = next;
            continue;
          }

          sanitizePromptFormattingNode(element);
          unwrapPromptFormattingElement(element);
          child = next;
        }
      }

      function clearPromptElementAttributes(element) {
        while (element.attributes.length) {
          element.removeAttribute(element.attributes[0].name);
        }
      }

      function unwrapPromptFormattingElement(element) {
        var parent = element.parentNode;
        if (!parent) { return; }
        while (element.firstChild) {
          parent.insertBefore(element.firstChild, element);
        }
        parent.removeChild(element);
      }

      function sanitizePromptLinks() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          if (link.dataset.kind === 'directory') {
            var directoryPath = link.dataset.path || '';
            var directoryHref = makeDirectoryHref({ path: directoryPath });
            link.className = 'rich-file-link rich-directory-link';
            link.setAttribute('href', directoryHref);
            link.setAttribute('contenteditable', 'false');
            renderFileReferenceLinkLabel(link, { path: directoryPath, kind: 'directory', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 });
            link.dataset.startLine = '0';
            link.dataset.endLine = '0';
            link.dataset.startColumn = '0';
            link.dataset.endColumn = '0';
            return;
          }
          var startLine = readPositiveInteger(link.dataset.startLine, 0);
          var endLine = startLine === 0 ? 0 : Math.max(startLine, readPositiveInteger(link.dataset.endLine, startLine));
          var startColumn = readPositiveInteger(link.dataset.startColumn, 0);
          var endColumn = readPositiveInteger(link.dataset.endColumn, 0);
          var path = link.dataset.path || '';
          var href = makeFileHref({ path: path, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn });
          link.setAttribute('href', href);
          link.setAttribute('contenteditable', 'false');
          renderFileReferenceLinkLabel(link, { path: path, startLine: startLine, endLine: endLine, startColumn: startColumn, endColumn: endColumn });
        });
        var skillLinks = promptInput.querySelectorAll('a.rich-skill-link');
        skillLinks.forEach(function(link) {
          var skillId = link.dataset.skillId || '';
          var skill = getSkillById(skillId);
          link.className = 'rich-skill-link';
          link.setAttribute('contenteditable', 'false');
          link.draggable = false;
          if (skill) {
            link.setAttribute('href', getSkillPath(skill));
            link.dataset.skillPath = getSkillPath(skill);
            renderSkillReferenceContent(link, getSkillMentionName(skill));
            link.title = skill.description || skill.name || skill.id;
          } else {
            link.setAttribute('href', link.dataset.skillPath || link.getAttribute('href') || '');
          }
        });
      }

`.slice(1)
};

