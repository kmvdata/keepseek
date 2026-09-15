import type { WebviewFragment } from '../composition';

export const dragDropDeclarationFragment: WebviewFragment = {
  id: 'references.drag-drop.declaration',
  source: `
      var dropZone = promptInput.closest('.composer-input-inner') || promptInput;
      var dropArea = promptInput.closest('.composer-input-wrap') || dropZone;
      var dragDepth = 0;
`.slice(1)
};

export const dragDropExtractionFragment: WebviewFragment = {
  id: 'references.drag-drop.extraction',
  source: `
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

      function extractFileReferences(dataTransfer, allowPlainTextPaths) {
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
          addPlainTextReferences(references, seen, text, allowPlainTextPaths !== false);
        }

        return references;
      }

      function extractDroppedFilesWithoutPath(dataTransfer) {
        var files = [];
        var dt = dataTransfer;
        var seen = Object.create(null);
        if (!dt) { return files; }

        function addFile(file) {
          if (!file || file.path) { return; }
          var key = [
            file.name || '',
            String(file.size || 0),
            String(file.lastModified || 0)
          ].join(':');
          if (seen[key]) { return; }
          seen[key] = true;
          files.push(file);
        }

        if (dt.files && dt.files.length) {
          for (var i = 0; i < dt.files.length; i++) {
            addFile(dt.files[i]);
          }
        }

        if (dt.items && dt.items.length) {
          for (var i1 = 0; i1 < dt.items.length; i1++) {
            var item = dt.items[i1];
            if (item.kind !== 'file' || !item.getAsFile) { continue; }
            addFile(item.getAsFile());
          }
        }

        return files;
      }

      function importDroppedFilesWithoutPath(files) {
        setComposerStatus(t('importingDroppedFiles'));
        readDroppedFilePayloads(files).then(function(result) {
          if (result.files.length) {
            vscode.postMessage({ type: 'insertDroppedFileReferences', files: result.files });
            return;
          }
          setComposerStatus(result.skipped > 0
            ? t('droppedFilesTooLarge')
            : t('noReferencePath'));
        }).catch(function() {
          setComposerStatus(t('droppedFilesUnreadable'));
        });
      }

      function readDroppedFilePayloads(files) {
        var skipped = 0;
        var tasks = [];
        var maxBytes = getMaxDroppedFileBytes();
        for (var i = 0; i < files.length; i++) {
          var file = files[i];
          if (!file || !file.name || file.size > maxBytes || !file.arrayBuffer) {
            skipped += 1;
            continue;
          }
          tasks.push(readDroppedFilePayload(file).catch(function() {
            skipped += 1;
            return null;
          }));
        }

        return Promise.all(tasks).then(function(payloads) {
          return {
            files: payloads.filter(function(payload) { return Boolean(payload); }),
            skipped: skipped
          };
        });
      }

      function getMaxDroppedFileBytes() {
        var configured = Number(state.maxFileBytes);
        if (!Number.isFinite(configured) || configured <= 0) {
          return 200000;
        }
        return configured;
      }

      function readDroppedFilePayload(file) {
        return file.arrayBuffer().then(function(buffer) {
          var bytes = new Uint8Array(buffer);
          return {
            name: file.name || 'dropped-file',
            type: file.type || '',
            size: bytes.byteLength,
            lastModified: Number(file.lastModified) || 0,
            dataBase64: bytesToBase64(bytes)
          };
        });
      }

      function bytesToBase64(bytes) {
        var chunkSize = 32768;
        var binary = '';
        for (var i = 0; i < bytes.length; i += chunkSize) {
          var chunk = bytes.subarray(i, i + chunkSize);
          binary += String.fromCharCode.apply(null, Array.from(chunk));
        }
        return btoa(binary);
      }

      function addReferenceList(references, seen, value) {
        var entries = splitDragLines(value);
        for (var i = 0; i < entries.length; i++) {
          var entry = entries[i].trim();
          if (!entry || entry.charAt(0) === '#') { continue; }
          addReference(references, seen, entry);
        }
      }

`.slice(1)
};

export const dragDropAreaFragment: WebviewFragment = {
  id: 'references.drag-drop.area',
  source: `
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

`.slice(1)
};

export const dragDropBindingsFragment: WebviewFragment = {
  id: 'references.drag-drop.bindings',
  source: `
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
          return;
        }

        var droppedFiles = extractDroppedFilesWithoutPath(e.dataTransfer);
        if (droppedFiles.length) {
          importDroppedFilesWithoutPath(droppedFiles);
          return;
        }

        setComposerStatus(t('noReferencePath'));
      }, true);

`.slice(1)
};

