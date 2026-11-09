/** 根级模板 fragment 的契约与确定性拼接。 */

export interface WebviewTemplateFragment {
  readonly id: string;
  readonly source: string;
}

export function composeWebviewTemplate(fragments: readonly WebviewTemplateFragment[]): string {
  const seen = new Set<string>();
  return fragments.map((fragment) => {
    if (!fragment.id || seen.has(fragment.id)) {
      throw new Error(`Duplicate or empty webview template fragment id: ${fragment.id}`);
    }
    seen.add(fragment.id);
    return fragment.source;
  }).join('');
}

export function escapeTemplateHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
