import type { WebviewFragment } from '../composition';

/** Styles for the composer attachment chips. */
export const attachmentStylesFragment: WebviewFragment = {
  id: 'composer.attachment-styles',
  source: `
      .composer-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 6px 2px 2px;
      }
      .composer-attachments.hidden {
        display: none;
      }
      .composer-attachment-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        max-width: 220px;
        padding: 3px 6px 3px 3px;
        border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.35));
        border-radius: 6px;
        background: var(--vscode-input-background, transparent);
        color: var(--vscode-foreground, inherit);
        font-size: 11px;
      }
      .composer-attachment-thumb {
        width: 28px;
        height: 28px;
        flex: 0 0 auto;
        border-radius: 4px;
        object-fit: cover;
      }
      .composer-attachment-meta {
        display: flex;
        flex-direction: column;
        min-width: 0;
        line-height: 1.3;
      }
      .composer-attachment-name,
      .composer-attachment-size {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .composer-attachment-size {
        color: var(--vscode-descriptionForeground, inherit);
      }
      .composer-attachment-remove {
        flex: 0 0 auto;
        padding: 0 3px;
        border: none;
        background: transparent;
        color: var(--vscode-descriptionForeground, inherit);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
      }
      .composer-attachment-remove:hover {
        color: var(--vscode-foreground, inherit);
      }
`.slice(1)
};
