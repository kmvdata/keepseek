import * as vscode from 'vscode';
import { getConfiguredWorkspaceToolFileLimit } from './config';
import { getFileReferenceAuthorizationKey, resolveFileReferenceUri } from './fileReference';
import { normalizeKeepseekLanguage, type KeepseekLanguage } from './i18n';
import { isStandaloneReferenceLine } from './referenceSyntax';
import {
  getWorkspaceDirectoryName,
  getWorkspaceResourcePath,
  listWorkspaceDirectoryEntries,
  type WorkspaceDirectoryEntry
} from './workspaceDirectory';

export const DIRECTORY_REFERENCE_TARGET_PREFIX = 'keepseek-dir:';

const DIRECTORY_REFERENCE_PATTERN = /<([^<>\n]+)>/gu;
const DIRECTORY_REFERENCE_PREVIEW_LIMIT = 100;

interface PromptDirectoryReference {
  matchStart: number;
  matchEnd: number;
  replacementStart: number;
  target: string;
  uri: vscode.Uri;
}

export interface ExpandDirectoryReferencesOptions {
  authorizedExternalReferenceUris?: Iterable<string>;
  language?: KeepseekLanguage;
}

export async function expandDirectoryReferencesInPrompt(
  prompt: string,
  options: ExpandDirectoryReferencesOptions = {}
): Promise<string> {
  const language = normalizeKeepseekLanguage(options.language);
  const references = findPromptDirectoryReferences(prompt, language);
  if (!references.length) {
    return prompt;
  }

  const authorizedExternalReferenceUris = new Set(options.authorizedExternalReferenceUris ?? []);
  let expandedPrompt = '';
  let cursor = 0;

  for (const reference of references) {
    if (reference.replacementStart < cursor) {
      continue;
    }

    const expandedReference = await expandPromptDirectoryReference(reference, authorizedExternalReferenceUris, language);
    if (!expandedReference) {
      continue;
    }

    expandedPrompt += prompt.slice(cursor, reference.replacementStart);
    expandedPrompt += withPromptBlockBoundaries(prompt, reference.replacementStart, reference.matchEnd, expandedReference);
    cursor = reference.matchEnd;
  }

  return expandedPrompt + prompt.slice(cursor);
}

export function parseDirectoryReferenceTarget(target: string): vscode.Uri | undefined {
  const trimmedTarget = target.trim();
  if (!trimmedTarget.toLowerCase().startsWith(DIRECTORY_REFERENCE_TARGET_PREFIX)) {
    return undefined;
  }

  const referencePath = trimmedTarget.slice(DIRECTORY_REFERENCE_TARGET_PREFIX.length).trim();
  if (!referencePath) {
    return undefined;
  }

  return resolveFileReferenceUri(referencePath);
}

function findPromptDirectoryReferences(prompt: string, language: KeepseekLanguage): PromptDirectoryReference[] {
  const references: PromptDirectoryReference[] = [];

  for (const match of prompt.matchAll(DIRECTORY_REFERENCE_PATTERN)) {
    const target = match[1]?.trim();
    const matchStart = match.index;
    if (!target || matchStart === undefined) {
      continue;
    }

    const uri = parseDirectoryReferenceTarget(target);
    if (!uri) {
      continue;
    }

    const matchEnd = matchStart + match[0].length;
    const replacementStart = getDirectoryReferenceReplacementStart(prompt, matchStart, uri, language);
    if (!isStandaloneReferenceLine(prompt, replacementStart, matchEnd)) {
      continue;
    }
    references.push({
      matchStart,
      matchEnd,
      replacementStart,
      target,
      uri
    });
  }

  return references;
}

function getDirectoryReferenceReplacementStart(
  prompt: string,
  matchStart: number,
  uri: vscode.Uri,
  language: KeepseekLanguage
): number {
  const directoryName = getWorkspaceDirectoryName(uri);
  const prefix = prompt.slice(0, matchStart);
  const labels = [
    `${directoryName}/ `,
    `${directoryName} (${getDirectoryReferenceLabel(language)}) `,
    `${directoryName} (目录) `,
    `${directoryName} (directory) `,
    `${directoryName} `
  ];

  for (const label of labels) {
    if (prefix.endsWith(label)) {
      return matchStart - label.length;
    }
  }

  return matchStart;
}

async function expandPromptDirectoryReference(
  reference: PromptDirectoryReference,
  authorizedExternalReferenceUris: ReadonlySet<string>,
  language: KeepseekLanguage
): Promise<string | undefined> {
  if (!canExpandDirectoryReferenceUri(reference.uri, authorizedExternalReferenceUris)) {
    return undefined;
  }

  try {
    const stat = await vscode.workspace.fs.stat(reference.uri);
    if (stat.type !== vscode.FileType.Directory) {
      return undefined;
    }

    const includeWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
    const limit = Math.min(DIRECTORY_REFERENCE_PREVIEW_LIMIT, getConfiguredWorkspaceToolFileLimit());
    const listing = await listWorkspaceDirectoryEntries(reference.uri, {
      recursive: false,
      maxEntries: limit,
      includeWorkspaceFolder
    });
    const pathLabel = getWorkspaceResourcePath(reference.uri, includeWorkspaceFolder);

    return formatExpandedDirectoryReference({
      heading: reference.target,
      pathLabel,
      entries: listing.entries,
      truncated: listing.truncated,
      limit,
      language
    });
  } catch {
    return undefined;
  }
}

function canExpandDirectoryReferenceUri(uri: vscode.Uri, authorizedExternalReferenceUris: ReadonlySet<string>): boolean {
  if (vscode.workspace.getWorkspaceFolder(uri)) {
    return true;
  }
  return authorizedExternalReferenceUris.has(getFileReferenceAuthorizationKey(uri));
}

function formatExpandedDirectoryReference(input: {
  heading: string;
  pathLabel: string;
  entries: WorkspaceDirectoryEntry[];
  truncated: boolean;
  limit: number;
  language: KeepseekLanguage;
}): string {
  const title = input.language === 'en'
    ? `Directory reference: <${input.heading}>`
    : `目录引用：<${input.heading}>`;
  const guidance = input.language === 'en'
    ? 'The user referenced this directory as a target or reference scope. Prefer it when creating related files, and use keepseek_list_workspace_directory or keepseek_read_workspace_file if you need more detail.'
    : '用户引用了这个目录作为目标位置或参考范围。创建相关文件时优先使用该目录；如需更多细节，请使用 keepseek_list_workspace_directory 或 keepseek_read_workspace_file。';
  const pathLine = input.language === 'en'
    ? `Path: ${input.pathLabel}`
    : `路径：${input.pathLabel}`;
  const entriesTitle = input.language === 'en'
    ? 'Directory entries:'
    : '目录条目：';
  const entries = input.entries.length
    ? input.entries.map(formatDirectoryEntryLine)
    : [input.language === 'en' ? '- (empty)' : '- （空）'];
  const truncated = input.truncated
    ? [
        input.language === 'en'
          ? `Directory listing truncated at ${input.limit} entries.`
          : `目录清单已在 ${input.limit} 个条目处截断。`
      ]
    : [];

  return [title, guidance, pathLine, entriesTitle, ...entries, ...truncated].join('\n');
}

function formatDirectoryEntryLine(entry: WorkspaceDirectoryEntry): string {
  if (entry.kind === 'directory') {
    return `- ${entry.path}/`;
  }
  return `- ${entry.path}${entry.size ? ` (${entry.size})` : ''}`;
}

function getDirectoryReferenceLabel(language: KeepseekLanguage): string {
  return language === 'en' ? 'directory' : '目录';
}

function withPromptBlockBoundaries(prompt: string, start: number, end: number, block: string): string {
  const needsLeadingBreak = start > 0 && !isLineBreak(prompt.charAt(start - 1));
  const needsTrailingBreak = end < prompt.length && !isLineBreak(prompt.charAt(end));
  return `${needsLeadingBreak ? '\n' : ''}${block}${needsTrailingBreak ? '\n' : ''}`;
}

function isLineBreak(value: string): boolean {
  return value === '\n' || value === '\r';
}
