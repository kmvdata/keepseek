import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  getConfiguredMaxFileBytes,
  getConfiguredProjectInstructionsContextBudgetTokens
} from '../shared/config';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import type { ProjectInstructionContext, RunContextDiscardedSource } from '../shared/types';
import { estimateTokenCount } from './tokenEstimate';

const PROJECT_INSTRUCTIONS_FILE_NAME = 'AGENTS.md';

export interface ProjectInstructionsResolution {
  instructions: ProjectInstructionContext[];
  discarded: RunContextDiscardedSource[];
}

export interface ProjectInstructionsResolverOptions {
  workspaceFolders?: readonly vscode.WorkspaceFolder[];
  workspaceTrusted?: boolean;
  budgetTokens?: number;
  maxFileBytes?: number;
}

export class ProjectInstructionsResolver {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async resolve(options: ProjectInstructionsResolverOptions = {}): Promise<ProjectInstructionsResolution> {
    const folders = options.workspaceFolders ?? vscode.workspace.workspaceFolders ?? [];
    const trusted = options.workspaceTrusted ?? vscode.workspace.isTrusted;
    const budgetTokens = Math.max(0, Math.floor(
      options.budgetTokens ?? getConfiguredProjectInstructionsContextBudgetTokens()
    ));
    const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes ?? getConfiguredMaxFileBytes()));
    const instructions: ProjectInstructionContext[] = [];
    const discarded: RunContextDiscardedSource[] = [];

    if (!trusted) {
      for (const folder of folders) {
        const uri = vscode.Uri.joinPath(folder.uri, PROJECT_INSTRUCTIONS_FILE_NAME);
        if (await uriExists(uri)) {
          discarded.push(createDiscarded(uri, 'workspace_untrusted'));
        }
      }
      return { instructions, discarded };
    }

    let remainingTokens = budgetTokens;
    for (const folder of folders) {
      const uri = vscode.Uri.joinPath(folder.uri, PROJECT_INSTRUCTIONS_FILE_NAME);
      const loaded = await this.readInstructionFile(uri, maxFileBytes);
      if (!loaded.content) {
        if (loaded.rejected) {
          discarded.push(createDiscarded(uri, 'load_failed'));
        }
        continue;
      }
      if (remainingTokens <= 0) {
        discarded.push(createDiscarded(uri, 'budget_exhausted'));
        continue;
      }

      const projected = truncateProjectInstructions(loaded.content, remainingTokens);
      if (!projected.content) {
        discarded.push(createDiscarded(uri, 'budget_exhausted'));
        continue;
      }
      const tokenEstimate = estimateTokenCount(projected.content);
      instructions.push({
        id: `project-instructions:${normalizeUri(uri)}`,
        uri: uri.toString(),
        workspaceFolder: folder.name,
        content: projected.content,
        characterCount: projected.content.length,
        tokenEstimate,
        contentHash: hashContent(loaded.content),
        truncated: projected.truncated
      });
      remainingTokens = Math.max(0, remainingTokens - tokenEstimate);
    }

    return { instructions, discarded };
  }

  private async readInstructionFile(
    uri: vscode.Uri,
    maxFileBytes: number
  ): Promise<{ content?: string; rejected: boolean }> {
    if (shouldSkipTextUri(uri)) {
      return { rejected: true };
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return { rejected: false };
    }
    if (stat.type !== vscode.FileType.File || stat.size > maxFileBytes) {
      return { rejected: true };
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > maxFileBytes) {
        return { rejected: true };
      }
      const content = this.decoder.decode(bytes).replace(/\r\n?/gu, '\n').trim();
      return content && isReadableTextContent(content)
        ? { content, rejected: false }
        : { rejected: true };
    } catch {
      return { rejected: true };
    }
  }
}

export function truncateProjectInstructions(
  content: string,
  budgetTokens: number
): { content: string; truncated: boolean } {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (estimateTokenCount(normalized) <= budgetTokens) {
    return { content: normalized, truncated: false };
  }
  if (budgetTokens <= 0) {
    return { content: '', truncated: true };
  }

  const notice = selectTruncationNotice(budgetTokens);
  if (!notice) {
    return { content: '', truncated: true };
  }
  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = createHeadTailExcerpt(normalized, mid, notice);
    if (estimateTokenCount(candidate) <= budgetTokens) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return {
    content: createHeadTailExcerpt(normalized, low, notice),
    truncated: true
  };
}

function selectTruncationNotice(budgetTokens: number): string {
  const notices = [
    '\n\n[KeepSeek truncated the middle of this AGENTS.md to fit the project-instruction budget.]\n\n',
    '\n\n[AGENTS.md truncated by KeepSeek.]\n\n',
    '[truncated]'
  ];
  return notices.find((notice) => estimateTokenCount(notice.trim()) <= budgetTokens) ?? '';
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n?/gu, '\n').trim()).digest('hex');
}

export function normalizeUri(uri: vscode.Uri | string): string {
  const value = typeof uri === 'string' ? uri : uri.toString();
  try {
    const parsed = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
    if (parsed.scheme === 'file') {
      const normalizedPath = parsed.fsPath.replace(/[\\/]+/gu, '/').replace(/\/$/u, '');
      return process.platform === 'win32' ? normalizedPath.toLocaleLowerCase() : normalizedPath;
    }
  } catch {
    // Non-standard URI strings are normalized textually below.
  }
  return value.trim().replace(/\/$/u, '');
}

function createHeadTailExcerpt(content: string, keptCharacters: number, notice: string): string {
  if (keptCharacters <= 0) {
    return notice.trim();
  }
  const headCharacters = Math.ceil(keptCharacters * 0.8);
  const tailCharacters = Math.max(0, keptCharacters - headCharacters);
  const head = content.slice(0, headCharacters).trimEnd();
  const tail = tailCharacters ? content.slice(-tailCharacters).trimStart() : '';
  return [head, notice.trim(), tail].filter(Boolean).join('\n\n');
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.File;
  } catch {
    return false;
  }
}

function createDiscarded(
  uri: vscode.Uri,
  reason: RunContextDiscardedSource['reason']
): RunContextDiscardedSource {
  return {
    id: `project-instructions:${normalizeUri(uri)}`,
    kind: 'project-instructions',
    uri: uri.toString(),
    reason
  };
}
