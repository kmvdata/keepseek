import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { isReadableTextContent } from '../shared/textFileGuards';
import type { ProjectInstructionContext, RunContextDiscardedSource } from '../shared/types';
import { loadSharedCodexConfig, type SharedCodexConfigSnapshot, type SharedCodexConfigOptions } from '../context/sharedCodexConfig';
import { readSharedText } from '../context/sharedConfigPaths';
import { estimateTokenCount } from './tokenEstimate';

export interface ProjectInstructionsResolution {
  instructions: ProjectInstructionContext[];
  discarded: RunContextDiscardedSource[];
}
export interface ProjectInstructionsResolverOptions extends SharedCodexConfigOptions {
  snapshot?: SharedCodexConfigSnapshot;
  maxFileBytes?: number;
}
export class ProjectInstructionsResolver {
  public async resolve(options: ProjectInstructionsResolverOptions = {}): Promise<ProjectInstructionsResolution> {
    const snapshot = options.snapshot ?? await loadSharedCodexConfig(options);
    const instructions: ProjectInstructionContext[] = [];
    const discarded: RunContextDiscardedSource[] = [];
    const maxFileBytes = options.maxFileBytes ?? getConfiguredMaxFileBytes();
    let remaining = snapshot.projectDocMaxBytes;
    const directories = [{ uri: snapshot.codexHome, boundary: snapshot.codexHome, global: true },
      ...(snapshot.scope?.trusted ? snapshot.scope.chain.map(uri => ({ uri, boundary: snapshot.scope!.root, global: false })) : [])];
    if (snapshot.scope && !snapshot.scope.trusted) {
      discarded.push({ id: 'project-instructions:untrusted', kind: 'project-instructions', uri: snapshot.scope.cwd.toString(), reason: 'workspace_untrusted' });
    }
    if (snapshot.diagnostics.length) {
      for (const item of snapshot.diagnostics) discarded.push({ id: `config:${item.uri}`, kind: 'project-instructions', uri: item.uri, reason: 'load_failed' });
      // Malformed document policy cannot silently fall back to permissive defaults.
      if (snapshot.diagnostics.some(item => !item.message.startsWith('Codex 0.133.0'))) return { instructions, discarded };
    }
    for (const directory of directories) {
      const names = ['AGENTS.override.md', 'AGENTS.md', ...(directory.global ? [] : snapshot.fallbackFilenames)];
      for (const name of [...new Set(names)]) {
        const uri = vscode.Uri.joinPath(directory.uri, name);
        const id = `project-instructions:${normalizeUri(uri)}`;
        snapshot.watchedUris.push(uri.toString());
        try {
          const loaded = await readSharedText(uri, [directory.boundary], maxFileBytes);
          if (loaded === undefined || !loaded.trim()) continue;
          if (!isReadableTextContent(loaded)) throw new Error('Unreadable instruction');
          if (remaining <= 0) { discarded.push({ id, uri: uri.toString(), kind: 'project-instructions', reason: 'budget_exhausted' }); break; }
          const projected = truncateUtf8(loaded, remaining);
          remaining = projected !== loaded ? 0 : remaining - Buffer.byteLength(projected);
          instructions.push({ id, uri: uri.toString(), workspaceFolder: directory.global ? 'global' : path.basename(directory.uri.fsPath),
            scopeUri: directory.uri.toString(), order: instructions.length, content: projected,
            characterCount: projected.length, tokenEstimate: estimateTokenCount(projected), contentHash: hashContent(loaded), truncated: projected !== loaded });
          break;
        } catch {
          discarded.push({ id, uri: uri.toString(), kind: 'project-instructions', reason: 'load_failed' });
          // A rejected override cannot be bypassed by a lower-priority file.
          break;
        }
      }
    }
    return { instructions, discarded };
  }
}
export function truncateUtf8(content: string, maxBytes: number): string {
  const bytes = Buffer.from(content);
  let end = Math.max(0, Math.min(bytes.length, Math.floor(maxBytes)));
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
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
