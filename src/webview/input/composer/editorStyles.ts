import type { WebviewFragment } from '../composition';

export const editorStylesFragment: WebviewFragment = {
  id: 'styles.composer.editor',
  source: `
    .rich-input {
      position: relative;
      min-height: 56px;
      /* 必须与 updatePromptVisualState() 的 autogrow 上限（200）保持一致：
         不一致时 height='auto' 会被钳到 max-height、随后收缩回固定值，
         导致 scrollTop 被 clamp，滚动条出现后每次输入视口跳动（闪烁）。 */
      max-height: 200px;
      padding: 10px 12px 6px;
      line-height: 1.45;
      font-size: 13px;
      border: none;
      background: transparent;
      outline: none;
      display: block;
      width: 100%;
      flex: 0 0 auto;
      overflow-y: auto;
      color: var(--vscode-input-foreground);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
      caret-color: var(--vscode-input-foreground);
    }

    .rich-input:focus {
      outline: none;
    }

    .rich-input span,
    .rich-input font,
    .rich-input code,
    .rich-input pre {
      color: inherit !important;
      background: transparent !important;
      font: inherit !important;
    }

    .rich-input.is-empty::before {
      content: attr(data-placeholder);
      position: absolute;
      top: 10px;
      left: 12px;
      right: 12px;
      color: var(--vscode-input-placeholderForeground);
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rich-input.drag-over,
    .composer-input-inner.drag-over {
      outline: 2px dashed var(--vscode-focusBorder);
      outline-offset: -2px;
      background: var(--vscode-list-dropBackground, var(--vscode-editor-selectionBackground));
    }

`.slice(1)
};

