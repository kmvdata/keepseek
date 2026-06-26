import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { formatBytes } from '../shared/format';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import { createSkillId, SKILL_INSTRUCTION_FILE_NAMES, type SkillManifest, type SkillSource } from './skillTypes';

interface SkillBaseDirectory {
  source: SkillSource;
  uri: vscode.Uri;
  label: string;
  workspaceScoped: boolean;
}

interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  allowImplicit?: boolean;
  userInvocable?: boolean;
}

const DEFAULT_WORKSPACE_SKILL_DESCRIPTION = 'Project skill disabled because the workspace is not trusted.';

export class SkillDiscovery {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async discover(): Promise<SkillManifest[]> {
    const manifests: SkillManifest[] = [];
    const seen = new Set<string>();

    for (const base of this.getBaseDirectories()) {
      const discovered = await this.discoverBaseDirectory(base);
      for (const manifest of discovered) {
        if (seen.has(manifest.id)) {
          continue;
        }
        seen.add(manifest.id);
        manifests.push(manifest);
      }
    }

    return manifests.sort((left, right) => {
      const nameOrder = left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      return nameOrder || left.sourceLabel.localeCompare(right.sourceLabel, undefined, { sensitivity: 'base' });
    });
  }

  private getBaseDirectories(): SkillBaseDirectory[] {
    const bases: SkillBaseDirectory[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      bases.push(
        {
          source: 'agentsWorkspace',
          uri: vscode.Uri.joinPath(folder.uri, '.agents', 'skills'),
          label: `${folder.name}/.agents`,
          workspaceScoped: true
        },
        {
          source: 'agentsWorkspace',
          uri: vscode.Uri.joinPath(folder.uri, '.agents'),
          label: `${folder.name}/.agents`,
          workspaceScoped: true
        }
      );
    }
    return bases;
  }

  private async discoverBaseDirectory(base: SkillBaseDirectory): Promise<SkillManifest[]> {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(base.uri);
    } catch {
      return [];
    }

    const manifests: SkillManifest[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory || !name.trim()) {
        continue;
      }

      const rootUri = vscode.Uri.joinPath(base.uri, name);
      const skillUri = await this.findSkillInstructionFile(rootUri);
      if (!skillUri) {
        continue;
      }

      manifests.push(await this.createManifest(base, rootUri, skillUri, name));
    }

    return manifests;
  }

  private async createManifest(
    base: SkillBaseDirectory,
    rootUri: vscode.Uri,
    skillUri: vscode.Uri,
    fallbackName: string
  ): Promise<SkillManifest> {
    const id = createSkillId(base.source, rootUri);
    const childNames = await this.readChildNames(rootUri);
    const hasReferences = childNames.has('references');
    const hasAssets = childNames.has('assets');
    const hasScripts = childNames.has('scripts');

    if (base.workspaceScoped && !vscode.workspace.isTrusted) {
      return {
        id,
        name: fallbackName,
        description: DEFAULT_WORKSPACE_SKILL_DESCRIPTION,
        source: base.source,
        sourceLabel: base.label,
        rootUri,
        skillUri,
        enabled: false,
        allowImplicit: false,
        userInvocable: false,
        hasReferences,
        hasAssets,
        hasScripts,
        unavailableReason: DEFAULT_WORKSPACE_SKILL_DESCRIPTION
      };
    }

    const readResult = await this.readSkillMarkdown(skillUri);
    if (!readResult.ok) {
      return {
        id,
        name: fallbackName,
        description: readResult.error,
        source: base.source,
        sourceLabel: base.label,
        rootUri,
        skillUri,
        enabled: false,
        allowImplicit: false,
        userInvocable: false,
        hasReferences,
        hasAssets,
        hasScripts,
        unavailableReason: readResult.error
      };
    }

    const parsed = parseSkillFrontmatter(readResult.content);
    return {
      id,
      name: parsed.name || fallbackName,
      description: parsed.description || deriveDescription(readResult.content),
      source: base.source,
      sourceLabel: base.label,
      rootUri,
      skillUri,
      enabled: true,
      allowImplicit: parsed.allowImplicit ?? false,
      userInvocable: parsed.userInvocable ?? true,
      hasReferences,
      hasAssets,
      hasScripts
    };
  }

  private async findSkillInstructionFile(rootUri: vscode.Uri): Promise<vscode.Uri | undefined> {
    for (const fileName of SKILL_INSTRUCTION_FILE_NAMES) {
      const skillUri = vscode.Uri.joinPath(rootUri, fileName);
      try {
        const stat = await vscode.workspace.fs.stat(skillUri);
        if (stat.type === vscode.FileType.File) {
          return skillUri;
        }
      } catch {
        // Try the next supported instruction filename.
      }
    }
    return undefined;
  }

  private async readChildNames(rootUri: vscode.Uri): Promise<Set<string>> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(rootUri);
      return new Set(entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(([name]) => name));
    } catch {
      return new Set();
    }
  }

  private async readSkillMarkdown(skillUri: vscode.Uri): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
    if (shouldSkipTextUri(skillUri)) {
      return { ok: false, error: `${getUriBasename(skillUri)} is not a readable text file.` };
    }

    const maxBytes = getConfiguredMaxFileBytes();
    try {
      const stat = await vscode.workspace.fs.stat(skillUri);
      if (stat.size > maxBytes) {
        return { ok: false, error: `${getUriBasename(skillUri)} is larger than ${formatBytes(maxBytes)}.` };
      }
      const bytes = await vscode.workspace.fs.readFile(skillUri);
      if (bytes.byteLength > maxBytes) {
        return { ok: false, error: `${getUriBasename(skillUri)} is larger than ${formatBytes(maxBytes)}.` };
      }
      const content = this.decoder.decode(bytes);
      if (!isReadableTextContent(content)) {
        return { ok: false, error: `${getUriBasename(skillUri)} appears to be binary or unreadable text.` };
      }
      return { ok: true, content };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
}

function getUriBasename(uri: vscode.Uri): string {
  const value = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return path.basename(value) || 'skill instruction file';
}

function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) {
    return {};
  }

  const lines = normalized.split('\n');
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex < 0) {
    return {};
  }

  const parsed: ParsedSkillFrontmatter = {};
  const keyPathByIndent: string[] = [];
  for (let index = 1; index < closingIndex; index += 1) {
    const line = lines[index];
    const match = /^(\s*)([A-Za-z0-9_.-]+)\s*:\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    const indent = Math.floor(match[1].length / 2);
    keyPathByIndent.length = indent;
    keyPathByIndent[indent] = match[2];
    const pathKey = keyPathByIndent.slice(0, indent + 1).join('.');
    const value = normalizeScalar(match[3]);
    if (!value) {
      continue;
    }

    switch (pathKey) {
      case 'name':
        parsed.name = value;
        break;
      case 'description':
        parsed.description = value;
        break;
      case 'metadata.keepseek.allowImplicit':
        parsed.allowImplicit = parseBoolean(value);
        break;
      case 'metadata.keepseek.userInvocable':
        parsed.userInvocable = parseBoolean(value);
        break;
    }
  }
  return parsed;
}

function normalizeScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  const quote = trimmed.charAt(0);
  if ((quote === '"' || quote === "'") && trimmed.charAt(trimmed.length - 1) === quote) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseBoolean(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function deriveDescription(content: string): string {
  const body = stripFrontmatter(content).replace(/\r\n?/gu, '\n');
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/^#+\s*/u, '').trim();
    if (!line || line === '---') {
      continue;
    }
    return line.length > 160 ? `${line.slice(0, 157)}...` : line;
  }
  return '';
}

function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n?/gu, '\n');
  if (!normalized.startsWith('---\n')) {
    return normalized;
  }
  const lines = normalized.split('\n');
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      return lines.slice(index + 1).join('\n');
    }
  }
  return normalized;
}
