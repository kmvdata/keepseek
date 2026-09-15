import type { WebviewFragment } from '../composition';

export const skillChipStylesFragment: WebviewFragment = {
  id: 'styles.skills.chips',
  source: `
    .rich-skill-link,
    .skill-pill {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 20px;
      margin: 0 2px 2px 0;
      padding: 1px 6px;
      border: 1px solid var(--vscode-inputOption-activeBorder, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-inputOption-activeBackground, var(--vscode-editor-background));
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      line-height: 18px;
      vertical-align: baseline;
      white-space: nowrap;
      cursor: default;
    }

    .rich-skill-link {
      gap: 4px;
      min-width: 0;
      cursor: pointer;
    }

    .rich-skill-link:hover {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .rich-skill-link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .rich-skill-link-icon {
      display: inline-flex;
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
      color: currentColor;
    }

    .rich-skill-link-icon img,
    .skill-pill-icon img {
      display: block;
      width: 100%;
      height: 100%;
    }

    .skill-pill-icon {
      display: inline-flex;
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
    }

    .rich-skill-link-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

`.slice(1)
};

export const skillsBarStylesFragment: WebviewFragment = {
  id: 'styles.skills.bar',
  source: `
    .skills-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      min-height: 28px;
      padding: 4px 4px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .skills-bar-label {
      flex: 0 0 auto;
      font-weight: 600;
    }

    .skills-bar-list {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      min-width: 0;
    }

    .skill-pill {
      gap: 4px;
      margin: 0;
      padding-right: 3px;
      cursor: pointer;
    }

    .skill-pill:hover {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .skill-pill:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .skill-pill-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .skill-pill-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      min-width: 16px;
      height: 16px;
      min-height: 16px;
      padding: 0;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      line-height: 1;
    }

    .skill-pill-remove:hover,
    .skill-pill-remove:focus-visible {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
      outline: none;
    }

`.slice(1)
};

