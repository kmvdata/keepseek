import { KEEPSEEK_CONFIGURATION_NAMESPACE } from '../../shared/identity';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DEFAULT_KEEPSEEK_LANGUAGE, normalizeKeepseekLanguage, type KeepseekLanguage } from '../../shared/i18n';
import { getMarkdownFence, getMarkdownLanguage } from '../../shared/markdown';
import { isReadableTextContent, shouldSkipTextUri } from '../../shared/textFileGuards';
import { hasUnsafeReferenceTargetCharacters, isInsideMarkdownFence, isStandaloneReferenceLine } from './referenceSyntax';

export { isReadableTextContent };

const FILE_REFERENCE_PATTERN = /<([^<>\n]+)>/gu;
const FILE_REFERENCE_LINE_PATTERN = /^(?<path>.+)#L(?<startLine>\d+)(?:C(?<startColumn>\d+))?(?:-(?:L(?<endLine>\d+))?(?:C(?<endColumn>\d+))?)?$/u;

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

export interface ExpandFileReferencesOptions {
  authorizedExternalReferenceUris?: Iterable<string>;
  language?: KeepseekLanguage;
  /**
   * Characters this message may spend inlining file-reference bodies, derived
   * from the model's declared window by `resolveReferenceInlineBudget`. The
   * decision is a budget decision only: no Skill identity, round type,
   * calibration value or observed runtime state may take part in it. Omitted
   * means unbounded, which keeps callers that were not migrated on their
   * previous inline behavior.
   */
  referenceInlineBudgetChars?: number;
}

interface ExpandedFileReference {
  heading: string;
  content: string;
  languageId: string;
}

export async function expandFileReferencesInPrompt(prompt: string, options: ExpandFileReferencesOptions = {}): Promise<string> {
  const language = normalizeKeepseekLanguage(options.language);
  const references = findPromptFileReferences(prompt, language);
  if (!references.length) {
    return prompt;
  }

  const authorizedExternalReferenceUris = new Set(options.authorizedExternalReferenceUris ?? []);
  // Read the per-file limit and the inline budget once per message: both stay
  // constant for the whole pass, so no reference can observe a value that
  // changed because of the order in which it was visited.
  const maxFileBytes = getReferenceExpansionMaxBytes();
  const totalInlineChars = normalizeReferenceInlineBudgetChars(options.referenceInlineBudgetChars);
  let remainingInlineChars = totalInlineChars;
  let expandedPrompt = '';
  let cursor = 0;

  for (const reference of references) {
    if (reference.replacementStart < cursor) {
      continue;
    }

    const expansion = await expandPromptFileReference(prompt, reference, authorizedExternalReferenceUris, {
      language,
      maxFileBytes,
      remainingInlineChars,
      totalInlineChars
    });
    if (expansion.kind === 'skip') {
      continue;
    }

    // Pointers cost nothing: they exist so a degraded reference keeps the
    // user's intent without spending the budget that caused the degradation.
    if (expansion.kind === 'inline' && remainingInlineChars !== undefined) {
      remainingInlineChars = Math.max(0, remainingInlineChars - expansion.inlineChars);
    }

    expandedPrompt += prompt.slice(cursor, reference.replacementStart);
    expandedPrompt += withPromptBlockBoundaries(prompt, reference.replacementStart, reference.matchEnd, expansion.text);
    cursor = reference.matchEnd;
  }

  return expandedPrompt + prompt.slice(cursor);
}

function findPromptFileReferences(prompt: string, language: KeepseekLanguage): PromptFileReference[] {
  const references: PromptFileReference[] = [];

  for (const match of prompt.matchAll(FILE_REFERENCE_PATTERN)) {
    const target = match[1]?.trim();
    const matchStart = match.index;
    if (!target || matchStart === undefined) {
      continue;
    }
    if (isInsideMarkdownFence(prompt, matchStart)) {
      continue;
    }

    const parsed = parseFileReferenceTarget(target);
    if (!parsed) {
      continue;
    }

    const matchEnd = matchStart + match[0].length;
    const replacementStart = getFileReferenceReplacementStart(
      prompt,
      matchStart,
      parsed.uri,
      parsed.startLine,
      parsed.endLine,
      parsed.startColumn,
      parsed.endColumn,
      language
    );
    if (replacementStart > matchStart) {
      continue;
    }
    if (!isStandaloneReferenceLine(prompt, replacementStart, matchEnd)) {
      continue;
    }
    references.push({
      matchStart,
      matchEnd,
      replacementStart,
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
  if (hasUnsafeReferenceTargetCharacters(referencePath)) {
    return undefined;
  }
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

export function getFileReferenceAuthorizationKey(uri: vscode.Uri): string {
  return uri.toString();
}

function getFileReferenceReplacementStart(
  prompt: string,
  matchStart: number,
  uri: vscode.Uri,
  startLine: number,
  endLine: number,
  startColumn: number,
  endColumn: number,
  language: KeepseekLanguage
): number {
  const bracketLabelStart = getBracketFileReferenceReplacementStart(prompt, matchStart);
  if (bracketLabelStart !== undefined) {
    return bracketLabelStart;
  }

  const fileName = getUriFileName(uri);
  const prefix = prompt.slice(0, matchStart);
  const labels = startLine > 0
    ? getReferenceLineLabelVariants(startLine, endLine, startColumn, endColumn, language).map((label) => `${fileName} (${label}) `)
    : [];
  labels.push(`${fileName} (${getFullReferenceLabel(language)}) `, `${fileName} (全文) `, `${fileName} (full file) `, `${fileName} `);

  for (const label of labels) {
    if (prefix.endsWith(label)) {
      return matchStart - label.length;
    }
  }

  return matchStart;
}

function getBracketFileReferenceReplacementStart(prompt: string, matchStart: number): number | undefined {
  const prefix = prompt.slice(0, matchStart);
  const trailingWhitespace = /[ \t]*(?:\r?\n[ \t]*)?$/u.exec(prefix)?.[0] ?? '';
  const labelEnd = prefix.length - trailingWhitespace.length;
  if (labelEnd <= 0 || prefix.charAt(labelEnd - 1) !== ']') {
    return undefined;
  }

  const lineStart = Math.max(prefix.lastIndexOf('\n', labelEnd - 1) + 1, prefix.lastIndexOf('\r', labelEnd - 1) + 1);
  const labelStart = prefix.lastIndexOf('[', labelEnd - 1);
  if (labelStart < lineStart || labelStart >= labelEnd - 1) {
    return undefined;
  }

  const beforeLabel = prefix.slice(lineStart, labelStart);
  return beforeLabel.trim() ? undefined : labelStart;
}

type PromptFileReferenceExpansion =
  | { kind: 'inline'; text: string; inlineChars: number }
  | { kind: 'pointer'; text: string }
  | { kind: 'skip' };

const SKIP_REFERENCE_EXPANSION: PromptFileReferenceExpansion = { kind: 'skip' };

interface ReferenceExpansionLimits {
  language: KeepseekLanguage;
  maxFileBytes: number;
  remainingInlineChars?: number;
  totalInlineChars?: number;
}

async function expandPromptFileReference(
  prompt: string,
  reference: PromptFileReference,
  authorizedExternalReferenceUris: ReadonlySet<string>,
  limits: ReferenceExpansionLimits
): Promise<PromptFileReferenceExpansion> {
  // Unauthorized external targets are skipped instead of pointed at: the read
  // tools enforce the same authorization, so a pointer would advertise content
  // that every follow-up call refuses.
  if (!canExpandReferenceUri(reference.uri, authorizedExternalReferenceUris)) {
    return SKIP_REFERENCE_EXPANSION;
  }

  const pointer = (reason: ReferencePointerReason): PromptFileReferenceExpansion => ({
    kind: 'pointer',
    text: formatReferencePointer({
      reference,
      reason,
      totalInlineChars: limits.totalInlineChars,
      language: limits.language
    })
  });

  // A skipped extension is still a real file the agent can reach with other
  // tools, so it degrades to a pointer. Keeping the original line would leave a
  // "(全文)" claim and a file: URI in the message while no content arrived.
  if (shouldSkipReferenceUri(reference.uri)) {
    return pointer(getUnsupportedTypeReason(limits.language));
  }

  try {
    const stat = await vscode.workspace.fs.stat(reference.uri);
    if (stat.type !== vscode.FileType.File) {
      // Directories and special provider entries have no readable text range,
      // so the previous behavior (leaving the user's text alone) still holds.
      return SKIP_REFERENCE_EXPANSION;
    }

    if (reference.startLine <= 0 && stat.size > limits.maxFileBytes) {
      return pointer(getFileSizeReason(limits.language, limits.maxFileBytes));
    }

    const document = await vscode.workspace.openTextDocument(reference.uri);
    const content = getReferenceDocumentText(document, reference.startLine, reference.endLine, reference.startColumn, reference.endColumn);
    if (!isReadableTextContent(content)) {
      return pointer(getUnreadableContentReason(limits.language));
    }
    if (getTextByteLength(content) > limits.maxFileBytes) {
      return pointer(getFileSizeReason(limits.language, limits.maxFileBytes));
    }

    // One reference is either inlined in full or described by a pointer. A
    // truncated inline block would ship partial content with no marker saying
    // so, which is worse for the agent than an honest pointer.
    const inlineChars = content.length;
    if (limits.remainingInlineChars !== undefined && inlineChars > limits.remainingInlineChars) {
      return pointer(getInlineBudgetReason(limits.language, limits.remainingInlineChars, limits.totalInlineChars));
    }

    return {
      kind: 'inline',
      text: formatExpandedFileReference({
        heading: prompt.slice(reference.replacementStart, reference.matchEnd).trim(),
        content,
        languageId: getMarkdownLanguage(document.languageId)
      }),
      inlineChars
    };
  } catch {
    // Unknown target or provider failure: keep the user's own text rather than
    // pointing at a file that could not even be stat'ed.
    return SKIP_REFERENCE_EXPANSION;
  }
}

function canExpandReferenceUri(uri: vscode.Uri, authorizedExternalReferenceUris: ReadonlySet<string>): boolean {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    return true;
  }
  return authorizedExternalReferenceUris.has(getFileReferenceAuthorizationKey(uri));
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

export function shouldSkipReferenceUri(uri: vscode.Uri): boolean {
  return shouldSkipTextUri(uri);
}

function formatExpandedFileReference(reference: ExpandedFileReference): string {
  const content = reference.content.replace(/\r\n?/gu, '\n');
  const fence = getMarkdownFence(content);
  const fencedContent = content.endsWith('\n') ? content : `${content}\n`;
  return `${reference.heading}\n${fence}${reference.languageId}\n${fencedContent}${fence}`;
}

interface ReferencePointerReason {
  text: string;
  /** True when the reason itself already states the budget in force. */
  statesBudget: boolean;
}

/**
 * Renders the degraded form of a reference: one self-contained line the agent
 * can act on. It names the file, its workspace-relative path, the line range
 * when the user asked for one, why nothing was inlined, the budget that
 * applied, and the tools that can still fetch it.
 */
function formatReferencePointer(input: {
  reference: PromptFileReference;
  reason: ReferencePointerReason;
  totalInlineChars?: number;
  language: KeepseekLanguage;
}): string {
  const fileName = getUriFileName(input.reference.uri);
  const lineLabel = input.reference.startLine > 0
    ? formatReferenceLabel(input.reference, input.language)
    : '';
  const heading = lineLabel ? `${fileName} (${lineLabel})` : fileName;
  // Only a workspace-relative path may be printed. A pointer is persisted in
  // the session and replayed to every later request, so an absolute path, a
  // file: URI, a host user name or any other session identifier would leak host
  // state into text the model reads and the user keeps.
  const relativePath = getWorkspaceRelativeReferencePath(input.reference.uri);
  const location = relativePath ? ` — ./${relativePath}` : '';
  // Every pointer states the budget in force, but a budget reason already names
  // it; repeating the same number twice would only add noise.
  const budgetClause = input.totalInlineChars === undefined || input.reason.statesBudget
    ? ''
    : input.language === 'en'
      ? `; inline budget for this message: ${formatInlineCount(input.totalInlineChars)} characters`
      : `；本轮内联预算 ${formatInlineCount(input.totalInlineChars)} 字符`;
  const reason = `${input.reason.text}${budgetClause}`;
  return input.language === 'en'
    ? `[reference not inlined] ${heading}${location} (reason: ${reason}). Call keepseek_read_workspace_file_range (preferred) or keepseek_search_workspace to read it.`
    : `[引用未内联] ${heading}${location}（原因：${reason}）。需要内容时调用 keepseek_read_workspace_file_range（优先）或 keepseek_search_workspace 读取。`;
}

function formatReferenceLabel(reference: PromptFileReference, language: KeepseekLanguage): string {
  return formatReferenceLineLabel(
    reference.startLine,
    reference.endLine,
    reference.startColumn,
    reference.endColumn,
    language
  );
}

function getWorkspaceRelativeReferencePath(uri: vscode.Uri): string | undefined {
  if (!vscode.workspace.getWorkspaceFolder(uri)) {
    return undefined;
  }
  const relativePath = vscode.workspace.asRelativePath(uri, false);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith('..')) {
    return undefined;
  }
  return relativePath.split(path.sep).join('/');
}

function getUnsupportedTypeReason(language: KeepseekLanguage): ReferencePointerReason {
  return {
    text: language === 'en' ? 'this file type is outside the inlineable text set' : '该文件类型不在可内联的文本范围内',
    statesBudget: false
  };
}

function getUnreadableContentReason(language: KeepseekLanguage): ReferencePointerReason {
  return {
    text: language === 'en' ? 'the content is not readable text' : '内容不是可读文本',
    statesBudget: false
  };
}

function getFileSizeReason(language: KeepseekLanguage, maxFileBytes: number): ReferencePointerReason {
  return {
    text: language === 'en'
      ? `the file exceeds the per-file inline limit of ${formatInlineCount(maxFileBytes)} bytes`
      : `超过单文件内联上限 ${formatInlineCount(maxFileBytes)} 字节`,
    statesBudget: false
  };
}

function getInlineBudgetReason(
  language: KeepseekLanguage,
  limitChars: number,
  totalInlineChars: number | undefined
): ReferencePointerReason {
  // Failing the whole-message budget and failing only the remaining budget are
  // different facts, and the printed number must be the limit that applied.
  const remaining = totalInlineChars !== undefined && limitChars < totalInlineChars;
  const formatted = formatInlineCount(limitChars);
  return {
    text: language === 'en'
      ? remaining
        ? `the remaining inline budget for this message is ${formatted} characters`
        : `the file exceeds the single-reference inline budget of ${formatted} characters`
      : remaining
        ? `超过本轮剩余内联预算 ${formatted} 字符`
        : `超过单次内联预算 ${formatted} 字符`,
    statesBudget: true
  };
}

function formatInlineCount(value: number): string {
  const digits = String(Math.max(0, Math.trunc(value)));
  let formatted = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) {
      formatted += ',';
    }
    formatted += digits.charAt(index);
  }
  return formatted;
}

function withPromptBlockBoundaries(prompt: string, start: number, end: number, block: string): string {
  const needsLeadingBreak = start > 0 && !isLineBreak(prompt.charAt(start - 1));
  const needsTrailingBreak = end < prompt.length && !isLineBreak(prompt.charAt(end));
  return `${needsLeadingBreak ? '\n' : ''}${block}${needsTrailingBreak ? '\n' : ''}`;
}

function isLineBreak(value: string): boolean {
  return value === '\n' || value === '\r';
}

function getTextByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function normalizeReferenceInlineBudgetChars(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.floor(value));
}

function getReferenceExpansionMaxBytes(): number {
  return vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE).get('maxFileBytes', 200_000);
}

export function getUriFileName(uri: vscode.Uri): string {
  return path.basename(uri.fsPath || uri.path) || uri.fsPath || uri.path || 'file';
}

export function formatReferenceLineLabel(
  startLine: number,
  endLine: number,
  startColumn: number,
  endColumn: number,
  _language: KeepseekLanguage = DEFAULT_KEEPSEEK_LANGUAGE
): string {
  const normalizedEndLine = Math.max(startLine, endLine || startLine);
  const normalizedStartColumn = startColumn > 0 ? startColumn : 1;
  const normalizedEndColumn = endColumn > 0 ? endColumn : normalizedStartColumn;
  const hasColumnDetail = normalizedStartColumn !== 1 || normalizedEndColumn !== 1;

  if (startLine === normalizedEndLine) {
    if (!hasColumnDetail) {
      return `L${startLine}`;
    }
    if (normalizedStartColumn === normalizedEndColumn) {
      return `L${startLine}#C${normalizedStartColumn}`;
    }
    return `L${startLine}#C${normalizedStartColumn}-L${normalizedEndLine}#C${normalizedEndColumn}`;
  }

  if (!hasColumnDetail) {
    return `L${startLine}-${normalizedEndLine}`;
  }

  return `L${startLine}#C${normalizedStartColumn}-L${normalizedEndLine}#C${normalizedEndColumn}`;
}

function getReferenceLineLabelVariants(
  startLine: number,
  endLine: number,
  startColumn: number,
  endColumn: number,
  language: KeepseekLanguage
): string[] {
  return [formatReferenceLineLabel(startLine, endLine, startColumn, endColumn, language)];
}

function getFullReferenceLabel(language: KeepseekLanguage): string {
  return language === 'en' ? 'full file' : '全文';
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
