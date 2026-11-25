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

      function attachmentHasImages() {
        return composerAttachments.length > 0;
      }

      function attachmentCollect() {
        var payload = [];
        for (var i = 0; i < composerAttachments.length; i++) {
          var entry = composerAttachments[i];
          if (entry.sessionId !== state.activeSessionId) { continue; }
          payload.push({
            dataUrl: entry.dataUrl,
            declaredMimeType: entry.mimeType,
            sourceName: entry.sourceName,
            originalBytes: entry.bytes,
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

      function attachmentCreateChip(entry) {
        var template = document.getElementById('composerAttachmentChipTemplate');
        var chip = template && template.content && template.content.firstElementChild
          ? template.content.firstElementChild.cloneNode(true)
          : null;
        if (!chip) {
          chip = document.createElement('div');
          chip.className = 'composer-attachment-chip';
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
          size.textContent = attachmentFormatBytes(entry.bytes) + ' \u00b7 ' + entry.width + '\u00d7' + entry.height;
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
        if (!composerAttachments.length) {
          host.classList.add('hidden');
          return;
        }
        host.classList.remove('hidden');
        for (var i = 0; i < composerAttachments.length; i++) {
          host.appendChild(attachmentCreateChip(composerAttachments[i]));
        }
      }

      function attachmentAddFiles(files) {
        var candidates = [];
        var total = files ? files.length : 0;
        for (var i = 0; i < total; i++) {
          if (attachmentLooksLikeImage(files[i])) { candidates.push(files[i]); }
        }
        if (!candidates.length) { return Promise.resolve(0); }
        attachmentEnsureUi();
        var tasks = [];
        for (var j = 0; j < candidates.length; j++) {
          if (composerAttachments.length + tasks.length >= ATTACHMENT_MAX_COUNT) {
            setComposerStatus(t('imageAttachmentRejected', { reason: attachmentStatusReason('too_many_images') }));
            break;
          }
          tasks.push(attachmentTranscode(candidates[j]));
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
            composerAttachments.push({
              id: 'attachment-' + composerAttachmentSeq,
              dataUrl: result.dataUrl,
              mimeType: result.mimeType,
              bytes: result.originalBytes,
              width: result.width,
              height: result.height,
              originalWidth: result.originalWidth,
              originalHeight: result.originalHeight,
              sourceName: result.sourceName,
              sessionId: state.activeSessionId
            });
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
