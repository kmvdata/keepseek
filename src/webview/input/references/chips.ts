import type { WebviewFragment } from '../composition';

export const referenceButtonDeclarationFragment: WebviewFragment = {
  id: 'references.button-declaration',
  source: `
      var referenceMenuButton = document.getElementById('referenceMenuButton');
`.slice(1)
};

export const referenceChipClickBindingFragment: WebviewFragment = {
  id: 'references.chips.click-binding',
  source: `
      promptInput.addEventListener('click', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        var skillLink = target?.closest('a.rich-skill-link');
        if (skillLink && promptInput.contains(skillLink)) {
          event.preventDefault();
          event.stopPropagation();
          if (event.detail > 1) { return; }
          vscode.postMessage({
            type: 'openSkill',
            skillId: skillLink.dataset.skillId || ''
          });
          return;
        }
        var link = target?.closest('a.rich-file-link');
        if (!link || !promptInput.contains(link)) { return; }

        event.preventDefault();
        event.stopPropagation();
        if (event.detail > 1) { return; }

        if (link.dataset.kind === 'directory') {
          vscode.postMessage({
            type: 'openDirectoryReference',
            path: link.dataset.path || ''
          });
          return;
        }

        vscode.postMessage({
          type: 'openFileReference',
          path: link.dataset.path || '',
          startLine: readPositiveInteger(link.dataset.startLine, 0),
          endLine: readPositiveInteger(link.dataset.endLine, 0),
          startColumn: readPositiveInteger(link.dataset.startColumn, 0),
          endColumn: readPositiveInteger(link.dataset.endColumn, 0)
        });
      });

`.slice(1)
};

export const referenceChipFactoriesFragment: WebviewFragment = {
  id: 'references.chips.factories',
  source: `
      function createReferenceLink(reference) {
        return reference.kind === 'directory'
          ? createDirectoryReferenceLink(reference)
          : createFileReferenceLink(reference);
      }

      function createFileReferenceLink(reference) {
        return createReferenceLinkElement(reference, { kind: 'file' });
      }

      function createDirectoryReferenceLink(reference) {
        return createReferenceLinkElement(reference, { kind: 'directory' });
      }

`.slice(1)
};

export const referenceInsertionFragment: WebviewFragment = {
  id: 'references.chips.insertion',
  source: `
      function makeFileHref(reference) {
        return makeFileReferenceHref(reference);
      }

      function makeDirectoryHref(reference) {
        return 'keepseek-dir:' + reference.path;
      }

      function getFileName(filePath) {
        var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
        var parts = normalized.split('/');
        return parts[parts.length - 1] || normalized || 'file';
      }

      function getDirectoryName(directoryPath) {
        var name = getFileName(directoryPath);
        return name.charAt(name.length - 1) === '/' ? name : name + '/';
      }

      function insertFileReferences(references) {
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (isPromptRangeInsideMarkdownFence(range)) {
          appendReferenceBoundarySpace(fragment);
          appendPlainReferenceText(fragment, references);
          appendReferenceBoundarySpace(fragment);
          insertFragmentAtRange(range, fragment);
          setComposerStatus(t('insertedFileReferences', { count: references.length }));
          return;
        }
        appendReferenceBoundarySpace(fragment);

        for (var i = 0; i < references.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(createReferenceLink(references[i]));
        }

        appendReferenceBoundarySpace(fragment);

        insertFragmentAtRange(range, fragment);
        setComposerStatus(t('insertedFileReferences', { count: references.length }));
      }

      function appendReferenceBoundarySpace(fragment) {
        fragment.append(document.createTextNode(' '));
      }

      function appendPlainReferenceText(fragment, references) {
        for (var i = 0; i < references.length; i++) {
          if (i > 0) {
            fragment.append(document.createElement('br'));
          }
          fragment.append(document.createTextNode(referenceToPlainText(references[i])));
        }
      }

      function referenceToPlainText(reference) {
        return '<' + (reference.kind === 'directory' ? makeDirectoryHref(reference) : makeFileHref(reference)) + '>';
      }

`.slice(1)
};

export const referenceLabelRefreshFragment: WebviewFragment = {
  id: 'references.chips.label-refresh',
  source: `
      function refreshPromptFileLinkLabels() {
        var links = promptInput.querySelectorAll('a.rich-file-link');
        links.forEach(function(link) {
          var reference = readFileReferenceLink(link);
          if (!reference.path) { return; }
          renderFileReferenceLinkLabel(link, reference);
        });
      }

`.slice(1)
};

export const referenceHostMessageFragment: WebviewFragment = {
  id: 'references.host-message',
  source: `
      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg.type === 'referenceResources') {
          handleReferenceResourcesMessage(msg);
          return;
        }
        if (msg.type !== 'insertFileReference' && msg.type !== 'insertDirectoryReference') return;
        if (
          window.keepseekInlineEditorControls &&
          window.keepseekInlineEditorControls.insertFileReference &&
          window.keepseekInlineEditorControls.insertFileReference(msg)
        ) {
          return;
        }
        var reference = {
          path: msg.path,
          kind: msg.type === 'insertDirectoryReference' ? 'directory' : 'file',
          startLine: msg.startLine || 0,
          endLine: msg.endLine || 0,
          startColumn: msg.startColumn || 0,
          endColumn: msg.endColumn || 0
        };
        var range = getPromptInsertionRange();
        var fragment = document.createDocumentFragment();
        if (isPromptRangeInsideMarkdownFence(range)) {
          appendReferenceBoundarySpace(fragment);
          fragment.append(document.createTextNode(referenceToPlainText(reference)));
          appendReferenceBoundarySpace(fragment);
          insertFragmentAtRange(range, fragment);
          setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
          return;
        }
        appendReferenceBoundarySpace(fragment);
        fragment.append(createReferenceLink(reference));
        appendReferenceBoundarySpace(fragment);
        insertFragmentAtRange(range, fragment);
        setComposerStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
      });
`.slice(1)
};
