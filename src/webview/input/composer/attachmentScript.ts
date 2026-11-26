import type { WebviewFragment } from '../composition';

/**
 * Composer attachment state.
 *
 * Images live only in this array until the composer submits, so no base64 ever
 * reaches a host state snapshot. Every entry remembers the session it was added
 * in: switching sessions must not leak an image into another task.
 */
export const attachmentStateFragment: WebviewFragment = {
  id: 'composer.attachment-state',
  source: `
      var composerAttachments = [];
      var composerAttachmentSeq = 0;
`.slice(1)
};

/** Collection, rendering and rejection reporting for composer attachments. */
export const attachmentCollectionFragment: WebviewFragment = {
  id: 'composer.attachment-collection',
  source: `
      function attachmentFormatBytes(value) {
        var bytes = Number(value) || 0;
        if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
        if (bytes >= 1024) { return Math.round(bytes / 1024) + ' KB'; }
        return bytes + ' B';
      }

      function attachmentStatusReason(code) {
        if (code === 'too_many_images' || code === 'image_too_large'
          || code === 'request_too_large' || code === 'too_large'
          || code === 'store_quota_exceeded') {
          return t('droppedFilesTooLarge');
        }
        return t('droppedFilesUnreadable');
      }

      function attachmentEnsureUi() {
        var existing = document.getElementById('composerAttachments');
        if (existing) { return existing; }
        if (!promptInput || !promptInput.parentNode) { return null; }
        var host = document.createElement('div');
        host.id = 'composerAttachments';
        host.className = 'composer-attachments hidden';
        host.setAttribute('role', 'list');
        host.title = t('imageLaneDegraded');
        promptInput.parentNode.insertBefore(host, promptInput);
        return host;
      }

      /** Only the active conversation's images are visible or counted: an
       * entry remembers the session it was added in, so switching sessions
       * must not show, number or send another task's images. */
      function attachmentSessionEntries() {
        var entries = [];
        for (var i = 0; i < composerAttachments.length; i++) {
          if (composerAttachments[i].sessionId === state.activeSessionId) { entries.push(composerAttachments[i]); }
        }
        return entries;
      }

      function attachmentHasImages() {
        return attachmentSessionEntries().length > 0;
      }

      function attachmentCollect() {
        var payload = [];
        for (var i = 0; i < composerAttachments.length; i++) {
          var entry = composerAttachments[i];
          if (entry.sessionId !== state.activeSessionId) { continue; }
          // A staged image is already stored for this session: submitting carries
          // its id, never a second copy of the bytes.
          if (entry.stagedId) {
            payload.push({ stagedId: entry.stagedId });
            continue;
          }
          payload.push({
            dataUrl: entry.dataUrl,
            declaredMimeType: entry.mimeType,
            sourceName: entry.sourceName,
            originalBytes: entry.originalBytes,
            originalWidth: entry.originalWidth,
            originalHeight: entry.originalHeight,
            reportedWidth: entry.width,
            reportedHeight: entry.height
          });
        }
        return payload;
      }

      function attachmentClear() {
        if (!composerAttachments.length) { return; }
        composerAttachments = [];
        attachmentRender();
      }

      function attachmentRemove(id) {
        if (!id) { return; }
        var next = [];
        for (var i = 0; i < composerAttachments.length; i++) {
          if (composerAttachments[i].id !== id) { next.push(composerAttachments[i]); }
        }
        if (next.length === composerAttachments.length) { return; }
        composerAttachments = next;
        attachmentRender();
      }

      function attachmentCreateChip(entry, position) {
        var template = document.getElementById('composerAttachmentChipTemplate');
        var chip = template && template.content && template.content.firstElementChild
          ? template.content.firstElementChild.cloneNode(true)
          : null;
        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'composer-attachment-chip';
          var fallbackIndex = document.createElement('span');
          fallbackIndex.className = 'composer-attachment-index';
          fallbackIndex.setAttribute('aria-hidden', 'true');
          chip.appendChild(fallbackIndex);
          var fallbackThumb = document.createElement('img');
          fallbackThumb.className = 'composer-attachment-thumb';
          chip.appendChild(fallbackThumb);
          var fallbackName = document.createElement('span');
          fallbackName.className = 'composer-attachment-name';
          chip.appendChild(fallbackName);
          var fallbackRemove = document.createElement('button');
          fallbackRemove.type = 'button';
          fallbackRemove.className = 'composer-attachment-remove';
          chip.appendChild(fallbackRemove);
        }
        var index = chip.querySelector('.composer-attachment-index');
        if (index) {
          index.textContent = String(position + 1);
        }
        chip.setAttribute('data-attachment-index', String(position + 1));
        chip.setAttribute('aria-label', t('imageAttachmentOrdinal', { index: position + 1 }) + ': ' + entry.sourceName);
        var thumb = chip.querySelector('.composer-attachment-thumb');
        if (thumb) {
          thumb.src = entry.dataUrl;
          thumb.alt = entry.sourceName;
        }
        var name = chip.querySelector('.composer-attachment-name');
        if (name) {
          name.textContent = entry.sourceName;
          name.title = entry.sourceName;
        }
        var size = chip.querySelector('.composer-attachment-size');
        if (size) {
          var stored = attachmentFormatBytes(entry.bytes) + ' \u00b7 ' + entry.width + '\u00d7' + entry.height;
          size.textContent = Number(entry.originalBytes) > Number(entry.bytes) && Number(entry.bytes) > 0
            ? attachmentFormatBytes(entry.originalBytes) + ' \u2192 ' + stored
            : stored;
        }
        var remove = chip.querySelector('.composer-attachment-remove');
        if (remove) {
          remove.setAttribute('data-attachment-id', entry.id);
          remove.setAttribute('aria-label', entry.sourceName);
          remove.title = entry.sourceName;
          remove.textContent = '\u00d7';
        }
        return chip;
      }

      function attachmentRender() {
        var host = attachmentEnsureUi();
        if (!host) { return; }
        while (host.firstChild) { host.removeChild(host.firstChild); }
        var visibleEntries = attachmentSessionEntries();
        if (!visibleEntries.length) {
          host.classList.add('hidden');
          return;
        }
        host.classList.remove('hidden');
        for (var i = 0; i < visibleEntries.length; i++) {
          host.appendChild(attachmentCreateChip(visibleEntries[i], i));
        }
      }

      function attachmentAddFiles(files) {
        var candidates = [];
        var total = files ? files.length : 0;
        var known = Object.create(null);
        var existing = attachmentSessionEntries();
        for (var e = 0; e < existing.length; e++) {
          if (existing[e].fileKey) { known[existing[e].fileKey] = true; }
        }
        for (var i = 0; i < total; i++) {
          var file = files[i];
          if (!attachmentLooksLikeImage(file)) { continue; }
          var fileKey = attachmentFileKey(file);
          // One file, one thumbnail: the same image added twice (drag, paste,
          // re-drag) keeps the entry it already has.
          if (fileKey && known[fileKey]) { continue; }
          if (fileKey) { known[fileKey] = true; }
          candidates.push({ file: file, fileKey: fileKey });
        }
        if (!candidates.length) { return Promise.resolve(0); }
        attachmentEnsureUi();
        var visibleCount = attachmentSessionEntries().length;
        var tasks = [];
        for (var j = 0; j < candidates.length; j++) {
          if (visibleCount + tasks.length >= ATTACHMENT_MAX_COUNT) {
            setComposerStatus(t('imageAttachmentRejected', { reason: attachmentStatusReason('too_many_images') }));
            break;
          }
          tasks.push(attachmentTranscode(candidates[j].file));
        }
        return Promise.all(tasks).then(function(results) {
          var added = 0;
          for (var k = 0; k < results.length; k++) {
            var result = results[k];
            if (!result || !result.ok) {
              setComposerStatus(t('imageAttachmentRejected', {
                reason: attachmentStatusReason(result && result.code)
              }));
              continue;
            }
            composerAttachmentSeq += 1;
            var entry = {
              id: 'attachment-' + composerAttachmentSeq,
              dataUrl: result.dataUrl,
              mimeType: result.mimeType,
              bytes: result.bytes,
              originalBytes: result.originalBytes,
              width: result.width,
              height: result.height,
              originalWidth: result.originalWidth,
              originalHeight: result.originalHeight,
              sourceName: result.sourceName,
              fileKey: candidates[k] ? candidates[k].fileKey : '',
              stagedId: '',
              sessionId: state.activeSessionId
            };
            composerAttachments.push(entry);
            // Copied into the session right away: from here on the image no
            // longer depends on the source file existing.
            attachmentStageEntry(entry);
            added += 1;
          }
          attachmentRender();
          return added;
        });
      }

      function attachmentClipboardImageFiles(clipboardData) {
        var files = [];
        if (!clipboardData) { return files; }
        var items = clipboardData.items || [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (!item || item.kind !== 'file' || !item.getAsFile) { continue; }
          var file = item.getAsFile();
          if (file && attachmentLooksLikeImage(file)) { files.push(file); }
        }
        if (!files.length && clipboardData.files) {
          for (var j = 0; j < clipboardData.files.length; j++) {
            var fallback = clipboardData.files[j];
            if (fallback && attachmentLooksLikeImage(fallback)) { files.push(fallback); }
          }
        }
        return files;
      }

      function attachmentDropNameKey(value) {
        var text = String(value || '').split(String.fromCharCode(92)).join('/');
        var index = text.lastIndexOf('/');
        return (index >= 0 ? text.slice(index + 1) : text).toLowerCase();
      }

      function attachmentDroppedImageFiles(dataTransfer) {
        var files = [];
        var names = Object.create(null);
        if (!dataTransfer) { return { files: files, names: names }; }
        var candidates = [];
        if (dataTransfer.files) {
          for (var i = 0; i < dataTransfer.files.length; i++) { candidates.push(dataTransfer.files[i]); }
        }
        if (dataTransfer.items) {
          for (var j = 0; j < dataTransfer.items.length; j++) {
            var item = dataTransfer.items[j];
            if (!item || item.kind !== 'file' || !item.getAsFile) { continue; }
            candidates.push(item.getAsFile());
          }
        }
        for (var k = 0; k < candidates.length; k++) {
          var file = candidates[k];
          if (!file || !attachmentLooksLikeImage(file)) { continue; }
          var key = attachmentDropNameKey(file.name);
          if (key && names[key]) { continue; }
          if (key) { names[key] = true; }
          files.push(file);
        }
        return { files: files, names: names };
      }

      /** Absolute paths of dropped images: they are what keeps one file to one
       * representation in the composer. */
      function attachmentDroppedFilePaths(files) {
        var paths = [];
        for (var i = 0; i < (files ? files.length : 0); i++) {
          if (files[i] && files[i].path) { paths.push(files[i].path); }
        }
        return paths;
      }

      /** Identity of a source file, so the same image cannot become two chips. */
      function attachmentFileKey(file) {
        if (!file) { return ''; }
        if (file.path) { return 'path:' + String(file.path).split(String.fromCharCode(92)).join('/'); }
        return 'name:' + [String(file.name || ''), String(file.size || 0), String(file.lastModified || 0)].join(':');
      }

      function attachmentStageEntry(entry) {
        if (!entry || !entry.dataUrl) { return; }
        vscode.postMessage({
          type: 'stageComposerImage',
          clientId: entry.id,
          sessionId: entry.sessionId,
          image: {
            dataUrl: entry.dataUrl,
            declaredMimeType: entry.mimeType,
            sourceName: entry.sourceName,
            originalBytes: entry.originalBytes,
            originalWidth: entry.originalWidth,
            originalHeight: entry.originalHeight,
            reportedWidth: entry.width,
            reportedHeight: entry.height
          }
        });
      }

      /** The host is authoritative for the stored copy: its byte count and
       * geometry replace what the browser reported. */
      function attachmentApplyStaged(msg) {
        if (!msg || !msg.clientId) { return; }
        var entry = null;
        for (var i = 0; i < composerAttachments.length; i++) {
          if (composerAttachments[i].id === msg.clientId) { entry = composerAttachments[i]; break; }
        }
        if (!entry) { return; }
        if (msg.error) {
          attachmentRemove(entry.id);
          if (entry.sessionId === state.activeSessionId) {
            setComposerStatus(t('imageAttachmentRejected', { reason: attachmentStatusReason(msg.error) }));
          }
          return;
        }
        var stagedId = String(msg.stagedId || '');
        if (!stagedId) { return; }
        entry.stagedId = stagedId;
        if (Number(msg.bytes) > 0) { entry.bytes = Number(msg.bytes); }
        if (Number(msg.width) > 0 && Number(msg.height) > 0) {
          entry.width = Number(msg.width);
          entry.height = Number(msg.height);
        }
        if (entry.sessionId === state.activeSessionId) { attachmentRender(); }
      }
`.slice(1)
};

/** Chip removal binding; one listener on the lazily created container. */
export const attachmentBindingsFragment: WebviewFragment = {
  id: 'composer.attachment-bindings',
  source: `
      var attachmentHostElement = attachmentEnsureUi();
      if (attachmentHostElement) {
        attachmentHostElement.addEventListener('click', function(event) {
          var target = event.target;
          if (!target || !target.closest) { return; }
          var button = target.closest('.composer-attachment-remove');
          if (!button) { return; }
          event.preventDefault();
          attachmentRemove(button.getAttribute('data-attachment-id'));
        });
      }
`.slice(1)
};

/**
 * One-shot bridge for a host-picked image.
 *
 * The host sniffs the picked bytes and hands them over exactly once; this
 * handler rebuilds a `File` and drops it into the identical pipeline paste and
 * drop use. Nothing is written into the composer text, so the caret never moves
 * and a picked image can never become a file reference.
 */
export const attachmentHostMessageFragment: WebviewFragment = {
  id: 'composer.attachment-host-message',
  source: `
      window.addEventListener('message', function(event) {
        var msg = event.data;
        if (msg && msg.type === 'composerImageStaged') {
          attachmentApplyStaged(msg);
          return;
        }
        if (!msg || msg.type !== 'insertComposerImage') { return; }
        if (!canChangeContext()) { return; }
        var bytes = null;
        try {
          var binary = atob(String(msg.dataBase64 || ''));
          bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
        } catch (error) {
          bytes = null;
        }
        if (!bytes || !bytes.length) { return; }
        var file = new File([bytes], String(msg.name || 'image'), { type: String(msg.mimeType || '') });
        attachmentAddFiles([file]);
      });
`.slice(1)
};
