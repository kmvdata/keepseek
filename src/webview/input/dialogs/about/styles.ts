import type { WebviewFragment } from '../../composition';

export const aboutStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.about',
  source: `
    .about-details {
      display: grid;
      margin: 0;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .about-row {
      display: grid;
      grid-template-columns: minmax(88px, 0.42fr) minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .about-label,
    .about-value {
      min-width: 0;
      font-size: 12px;
      line-height: 1.35;
    }

    .about-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
    }

    .about-value {
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
      text-align: right;
    }

`.slice(1)
};

