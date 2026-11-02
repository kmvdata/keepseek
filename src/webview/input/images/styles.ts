import type { WebviewFragment } from '../composition';

export const imageStylesFragment: WebviewFragment = {
  id: 'styles.images',
  source: `
    .image-activity { display: grid; gap: 10px; margin: 12px 0; }
    .image-card { padding: 10px; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); border-radius: 8px; min-width: 0; }
    .image-card h3 { font-size: 12px; margin: 0 0 6px; }
    .image-card p { font-size: 12px; overflow-wrap: anywhere; white-space: pre-wrap; }
    .image-card details { font-size: 11px; overflow-wrap: anywhere; margin-top: 8px; }
    .image-card details pre { white-space: pre-wrap; overflow-wrap: anywhere; }
    .image-card-preview { display: block; max-width: 100%; max-height: 220px; object-fit: contain; margin: 8px auto; border-radius: 4px; background: var(--vscode-editor-background); }
    .image-preview-button { display: block; width: 100%; padding: 0; background: transparent; border: 0; cursor: zoom-in; }
    .image-actions { display: flex; flex-wrap: wrap; gap: 6px; }
    .image-actions button { font-size: 11px; }
    .image-pagination { align-items: center; justify-content: space-between; }
    .image-pagination .image-status { margin: 0; }
    .image-parameter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .image-dialog select { width: 100%; min-width: 0; }
    .image-dialog textarea { resize: vertical; min-height: 90px; }
    .image-dialog .settings-dialog-footer { flex-wrap: wrap; }
    .image-input-preview { padding: 8px 0; font-size: 11px; overflow-wrap: anywhere; }
    .image-input-preview img { display: block; width: 72px; height: 72px; object-fit: contain; margin-bottom: 5px; }
    .image-advanced { margin: 12px 0; font-size: 12px; }
    .image-advanced summary { cursor: pointer; margin-bottom: 10px; }
    .image-status { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .image-status-error { color: var(--vscode-errorForeground); }
    .image-card .image-status { margin: 5px 0; }
    @media (max-width: 280px) { .image-parameter-grid { grid-template-columns: 1fr; } }
`.slice(1)
};
