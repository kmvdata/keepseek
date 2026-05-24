const MARKDOWN_LANGUAGE_BY_ID: Record<string, string> = {
  bat: 'batch',
  javascriptreact: 'jsx',
  plaintext: 'text',
  shellscript: 'bash',
  typescriptreact: 'tsx'
};

export function getMarkdownFence(content: string): string {
  const runs = content.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

export function getMarkdownLanguage(languageId: string): string {
  const language = MARKDOWN_LANGUAGE_BY_ID[languageId] ?? languageId;
  return language.replace(/[^\w+.-]/gu, '') || 'text';
}
