import type { WebviewFragment } from '../composition';

/**
 * Markup template for one composer attachment chip.
 *
 * It stays a `<template>` so the composer script can clone it into
 * `#composerAttachments`; the container itself is created lazily next to the
 * prompt input, which keeps the existing composer template byte-identical.
 */
export const attachmentTemplateFragment: WebviewFragment = {
  id: 'template.composer-attachments',
  source: `
    <template id="composerAttachmentChipTemplate">
      <div class="composer-attachment-chip" role="listitem">
        <img class="composer-attachment-thumb" alt="" />
        <span class="composer-attachment-meta">
          <span class="composer-attachment-name"></span>
          <span class="composer-attachment-size"></span>
        </span>
        <button class="composer-attachment-remove" type="button"></button>
      </div>
    </template>
`.slice(1)
};
