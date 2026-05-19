import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const FILE_REFERENCE_PATTERN = /<([^<>\n]+)>/gu;
const FILE_REFERENCE_LINE_PATTERN = /^(?<path>.+)#L(?<startLine>\d+)(?:C(?<startColumn>\d+))?(?:-(?:L(?<endLine>\d+))?(?:C(?<endColumn>\d+))?)?$/u;
const SKIPPED_REFERENCE_EXTENSIONS = new Set([
  '.3gp',
  '.7z',
  '.aac',
  '.ai',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.dylib',
  '.eot',
  '.exe',
  '.fig',
  '.flac',
  '.flv',
  '.gif',
  '.gz',
  '.heic',
  '.heif',
  '.icns',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.sketch',
  '.so',
  '.svg',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.wmv',
  '.woff',
  '.woff2',
  '.xz',
  '.zip'
]);

export interface PromptFileReference {
  matchStart: number;
  matchEnd: number;
  replacementStart: number;
  target: string;
  uri: vscode.Uri;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
}

interface ExpandedFileReference {
  heading: string;
  content: string;
  languageId: string;
}

export async function expandFileReferencesInPrompt(prompt: string): Promise<string> {
  const references = findPromptFileReferences(prompt);
  if (!references.length) {
    return prompt;
  }

  let expandedPrompt = '';
  let cursor = 0;

  for (const reference of references) {
    if (reference.replacementStart < cursor) {
      continue;
    }

    const expandedReference = await expandPromptFileReference(prompt, reference);
    if (!expandedReference) {
      continue;
    }

    expandedPrompt += prompt.slice(cursor, reference.replacementStart);
    expandedPrompt += withPromptBlockBoundaries(prompt, reference.replacementStart, reference.matchEnd, expandedReference);
    cursor = reference.matchEnd;
  }

  return expandedPrompt + prompt.slice(cursor);
}

function findPromptFileReferences(prompt: string): PromptFileReference[] {
  const references: PromptFileReference[] = [];

  for (const match of prompt.matchAll(FILE_REFERENCE_PATTERN)) {
    const target = match[1]?.trim();
    const matchStart = match.index;
    if (!target || matchStart === undefined) {
      continue;
    }

    const parsed = parseFileReferenceTarget(target);
    if (!parsed) {
      continue;
    }

    const matchEnd = matchStart + match[0].length;
    references.push({
      matchStart,
      matchEnd,
      replacementStart: getFileReferenceReplacementStart(prompt, matchStart, parsed.uri, parsed.startLine, parsed.endLine, parsed.startColumn, parsed.endColumn),
      target,
      uri: parsed.uri,
      startLine: parsed.startLine,
      endLine: parsed.endLine,
      startColumn: parsed.startColumn,
      endColumn: parsed.endColumn
    });
  }

  return references;
}

function parseFileReferenceTarget(target: string): { uri: vscode.Uri; startLine: number; endLine: number; startColumn: number; endColumn: number } | undefined {
  const lineMatch = FILE_REFERENCE_LINE_PATTERN.exec(target);
  const referencePath = lineMatch?.groups?.path ?? target;
  const uri = resolveFileReferenceUri(referencePath);
  if (!uri) {
    return undefined;
  }

  const startLine = Number(lineMatch?.groups?.startLine ?? 0);
  const startColumn = Number(lineMatch?.groups?.startColumn ?? 0);
  const parsedEndLine = Number(lineMatch?.groups?.endLine ?? startLine);
  const endLine = startLine > 0 ? Math.max(startLine, parsedEndLine) : 0;
  const parsedEndColumn = Number(lineMatch?.groups?.endColumn ?? 0);
  const endColumn = startColumn > 0 ? Math.max(startColumn, parsedEndColumn || startColumn) : 0;

  return { uri, startLine, endLine, startColumn, endColumn };
}

export function resolveFileReferenceUri(referencePath: string): vscode.Uri | undefined {
  const trimmedPath = referencePath.trim();
  if (!trimmedPath) {
    return undefined;
  }

  try {
    if (/^file:/iu.test(trimmedPath) || /^[a-z][a-z\d+.-]*:\/\//iu.test(trimmedPath)) {
      return vscode.Uri.parse(trimmedPath);
    }
  } catch {
    return undefined;
  }

  const expandedPath = trimmedPath.replace(/^~(?=$|[/\\])/, os.homedir());
  if (path.isAbsolute(expandedPath)) {
    return vscode.Uri.file(expandedPath);
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspaceRoot) {
    return vscode.Uri.joinPath(workspaceRoot, ...expandedPath.split(/[\\/]+/).filter(Boolean));
  }

  return vscode.Uri.file(path.resolve(expandedPath));
}

function getFileReferenceReplacementStart(
  prompt: string,
  matchStart: number,
  uri: vscode.Uri,
  startLine: number,
  endLine: number,
  startColumn: number,
  endColumn: number
): number {
  const fileName = getUriFileName(uri);
  const prefix = prompt.slice(0, matchStart);
  const labels = startLine > 0 ? [`${fileName} (${formatReferenceLineLabel(startLine, endLine, startColumn, endColumn)}) `] : [];
  labels.push(`${fileName} (全文) `, `${fileName} `);

  for (const label of labels) {
    if (prefix.endsWith(label)) {
      return matchStart - label.length;
    }
  }

  return matchStart;
}

async function expandPromptFileReference(
  prompt: string,
  reference: PromptFileReference
): Promise<string | undefined> {
  if (shouldSkipReferenceUri(reference.uri)) {
    return undefined;
  }

  try {
    const stat = await vscode.workspace.fs.stat(reference.uri);
    if (stat.type !== vscode.FileType.File) {
      return undefined;
    }

    if (reference.startLine <= 0 && stat.size > getReferenceExpansionMaxBytes()) {
      return undefined;
    }

    const document = await vscode.workspace.openTextDocument(reference.uri);
    const content = getReferenceDocumentText(document, reference.startLine, reference.endLine, reference.startColumn, reference.endColumn);
    if (!isReadableTextContent(content) || exceedsReferenceExpansionLimit(content)) {
      return undefined;
    }

    return formatExpandedFileReference({
      heading: prompt.slice(reference.replacementStart, reference.matchEnd).trim(),
      content,
      languageId: getMarkdownFenceLanguage(document)
    });
  } catch {
    return undefined;
  }
}

export function getReferenceDocumentText(document: vscode.TextDocument, rawStartLine: number, rawEndLine: number, rawStartColumn: number, rawEndColumn: number): string {
  if (rawStartLine <= 0) {
    return document.getText();
  }

  const startLine = clampLine(rawStartLine, 1, document.lineCount);
  const endLine = clampLine(rawEndLine, startLine, document.lineCount);
  const startLineMaxCol = document.lineAt(startLine - 1).range.end.character;
  const endLineMaxCol = document.lineAt(endLine - 1).range.end.character;
  const startCol = rawStartColumn > 0 ? clampColumn(rawStartColumn - 1, startLineMaxCol) : 0;
  const endCol = rawEndColumn > 0 ? clampColumn(rawEndColumn - 1, endLineMaxCol) : endLineMaxCol;
  const start = new vscode.Position(startLine - 1, startCol);
  const end = new vscode.Position(endLine - 1, endCol);
  return document.getText(new vscode.Range(start, end));
}

function shouldSkipReferenceUri(uri: vscode.Uri): boolean {
  return SKIPPED_REFERENCE_EXTENSIONS.has(path.extname(uri.fsPath || uri.path).toLowerCase());
}

function getMarkdownFenceLanguage(document: vscode.TextDocument): string {
  const languageById: Record<string, string> = {
    bat: 'batch',
    javascriptreact: 'jsx',
    plaintext: 'text',
    shellscript: 'bash',
    typescriptreact: 'tsx'
  };
  const language = languageById[document.languageId] ?? document.languageId;
  return language.replace(/[^\w+.-]/gu, '') || 'text';
}

function formatExpandedFileReference(reference: ExpandedFileReference): string {
  const content = reference.content.replace(/\r\n?/gu, '\n');
  const fence = getMarkdownFence(content);
  const fencedContent = content.endsWith('\n') ? content : `${content}\n`;
  return `${reference.heading}\n${fence}${reference.languageId}\n${fencedContent}${fence}`;
}

function getMarkdownFence(content: string): string {
  const runs = content.match(/`+/gu) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function withPromptBlockBoundaries(prompt: string, start: number, end: number, block: string): string {
  const needsLeadingBreak = start > 0 && !isLineBreak(prompt.charAt(start - 1));
  const needsTrailingBreak = end < prompt.length && !isLineBreak(prompt.charAt(end));
  return `${needsLeadingBreak ? '\n' : ''}${block}${needsTrailingBreak ? '\n' : ''}`;
}

function isLineBreak(value: string): boolean {
  return value === '\n' || value === '\r';
}

function isReadableTextContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  if (!sample) {
    return true;
  }

  let suspiciousCharacters = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0 || code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)) {
      suspiciousCharacters += 1;
    }
  }

  return suspiciousCharacters / sample.length < 0.03;
}

function exceedsReferenceExpansionLimit(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > getReferenceExpansionMaxBytes();
}

function getReferenceExpansionMaxBytes(): number {
  return vscode.workspace.getConfiguration('keepseek').get('maxFileBytes', 200_000);
}

export function getUriFileName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath || uri.path) || uri.fsPath || uri.path || 'file';
}

export function formatReferenceLineLabel(startLine: number, endLine: number, startColumn: number, endColumn: number): string {
  if (startLine === endLine) {
    if (startColumn > 0) {
      const colEnd = endColumn > startColumn ? endColumn : 0;
      if (colEnd > 0) {
        return `第${startLine}行第${startColumn}-${colEnd}列`;
      }
      return `第${startLine}行第${startColumn}列起`;
    }
    return `第${startLine}行`;
  }
  if (startColumn > 0 || endColumn > 0) {
    const startCol = startColumn > 0 ? `第${startColumn}列` : '';
    const endCol = endColumn > 0 ? `第${endColumn}列` : '';
    return `第${startLine}行${startCol}-第${endLine}行${endCol}`;
  }
  return `第${startLine}-${endLine}行`;
}

export function clampLine(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function clampColumn(value: number, max: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), max);
}

export function getExplorerFileUris(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): vscode.Uri[] {
  const sourceUris = selectedUris?.length ? selectedUris : uri ? [uri] : [];
  const seen = new Set<string>();
  const fileUris: vscode.Uri[] = [];

  for (const sourceUri of sourceUris) {
    if (!(sourceUri instanceof vscode.Uri)) {
      continue;
    }

    const key = sourceUri.toString();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    fileUris.push(sourceUri);
  }

  return fileUris;
}
