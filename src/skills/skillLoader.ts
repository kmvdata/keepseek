import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { formatBytes } from '../shared/format';
import { getMarkdownFence } from '../shared/markdown';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import { toActivatedSkill, type ActivatedSkill, type SkillManifest } from './skillTypes';

const MAX_REFERENCED_SKILL_RESOURCES = 12;
const MAX_REFERENCED_SKILL_RESOURCE_CHARS = 48_000;
const MARKDOWN_LINK_TARGET_PATTERN = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;

interface LoadedSkillResource {
  uri: vscode.Uri;
  content: string;
}

export class SkillLoader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async loadSkill(manifest: SkillManifest): Promise<ActivatedSkill> {
    if (!manifest.enabled) {
      throw new Error(manifest.unavailableReason || 'Skill is disabled.');
    }
    if (!isUriInsideOrEqual(manifest.rootUri, manifest.skillUri)) {
      throw new Error('Skill file is outside the skill root.');
    }
    const content = await this.readSkillTextFile(manifest.skillUri);
    const resources = await this.loadReferencedResources(manifest.rootUri, manifest.skillUri, content);
    const activated = toActivatedSkill(manifest, formatSkillContentWithResources(manifest.rootUri, content, resources));
    activated.loadedResourceUris = [
      manifest.skillUri.toString(),
      ...resources.map((resource) => resource.uri.toString())
    ];
    return activated;
  }

  private async loadReferencedResources(
    rootUri: vscode.Uri,
    skillUri: vscode.Uri,
    skillContent: string
  ): Promise<LoadedSkillResource[]> {
    const resources: LoadedSkillResource[] = [];
    const queue: Array<{ uri: vscode.Uri; content: string }> = [{ uri: skillUri, content: skillContent }];
    const seen = new Set<string>([skillUri.toString()]);
    let referencedContentChars = 0;

    for (let index = 0; index < queue.length && resources.length < MAX_REFERENCED_SKILL_RESOURCES; index += 1) {
      const current = queue[index];
      for (const targetUri of findReferencedResourceUris(rootUri, current.uri, current.content)) {
        const key = targetUri.toString();
        if (seen.has(key) || resources.length >= MAX_REFERENCED_SKILL_RESOURCES) {
          continue;
        }
        seen.add(key);

        try {
          const content = await this.readSkillTextFile(targetUri);
          if (referencedContentChars + content.length > MAX_REFERENCED_SKILL_RESOURCE_CHARS) {
            continue;
          }
          referencedContentChars += content.length;
          const resource = { uri: targetUri, content };
          resources.push(resource);
          queue.push(resource);
        } catch {
          // Referenced resources are best-effort; an unreadable optional file should not disable the skill.
        }
      }
    }

    return resources;
  }

  private async readSkillTextFile(uri: vscode.Uri): Promise<string> {
    if (shouldSkipTextUri(uri)) {
      throw new Error(`${getUriBasename(uri)} is not a readable text file.`);
    }

    const maxBytes = getConfiguredMaxFileBytes();
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(`${getUriBasename(uri)} is not a file.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${getUriBasename(uri)} is larger than ${formatBytes(maxBytes)}.`);
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${getUriBasename(uri)} is larger than ${formatBytes(maxBytes)}.`);
    }

    const content = this.decoder.decode(bytes).replace(/\r\n?/gu, '\n');
    if (!isReadableTextContent(content)) {
      throw new Error(`${getUriBasename(uri)} appears to be binary or unreadable text.`);
    }
    return content;
  }
}

function getUriBasename(uri: vscode.Uri): string {
  const value = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return path.basename(value) || 'skill instruction file';
}

export function isUriInsideOrEqual(rootUri: vscode.Uri, candidateUri: vscode.Uri): boolean {
  if (rootUri.scheme === 'file' && candidateUri.scheme === 'file') {
    const rootPath = path.resolve(rootUri.fsPath);
    const candidatePath = path.resolve(candidateUri.fsPath);
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
  }

  const root = rootUri.toString();
  const candidate = candidateUri.toString();
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

function findReferencedResourceUris(rootUri: vscode.Uri, currentUri: vscode.Uri, content: string): vscode.Uri[] {
  const uris: vscode.Uri[] = [];
  const currentDirectoryUri = vscode.Uri.joinPath(currentUri, '..');

  for (const match of content.matchAll(MARKDOWN_LINK_TARGET_PATTERN)) {
    const target = normalizeMarkdownResourceTarget(match[1] ?? '');
    if (!target || isExternalOrAbsoluteResourceTarget(target) || isSkillScriptTarget(target)) {
      continue;
    }

    const targetUri = vscode.Uri.joinPath(currentDirectoryUri, ...target.split(/[\\/]+/u).filter(Boolean));
    if (!isUriInsideOrEqual(rootUri, targetUri)) {
      continue;
    }
    uris.push(targetUri);
  }

  return uris;
}

function isSkillScriptTarget(target: string): boolean {
  return target.split(/[\\/]+/u).some((segment) => segment.toLocaleLowerCase() === 'scripts');
}

function normalizeMarkdownResourceTarget(value: string): string {
  let target = value.trim();
  if (!target || target.startsWith('#')) {
    return '';
  }
  if (target.startsWith('<') && target.endsWith('>')) {
    target = target.slice(1, -1).trim();
  }
  const hashIndex = target.indexOf('#');
  if (hashIndex >= 0) {
    target = target.slice(0, hashIndex).trim();
  }
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isExternalOrAbsoluteResourceTarget(target: string): boolean {
  return /^[a-z][a-z\d+.-]*:/iu.test(target) || path.isAbsolute(target) || target.startsWith('~');
}

function formatSkillContentWithResources(rootUri: vscode.Uri, content: string, resources: LoadedSkillResource[]): string {
  if (!resources.length) {
    return content;
  }

  return [
    content,
    '',
    '---',
    '',
    'Loaded relative skill resources:',
    ...resources.map((resource) => formatLoadedSkillResource(rootUri, resource))
  ].join('\n');
}

function formatLoadedSkillResource(rootUri: vscode.Uri, resource: LoadedSkillResource): string {
  const normalizedContent = resource.content.replace(/\r\n?/gu, '\n');
  const fence = getMarkdownFence(normalizedContent);
  const content = normalizedContent.endsWith('\n') ? normalizedContent : `${normalizedContent}\n`;
  return [
    '',
    `## ${getRelativeResourceLabel(rootUri, resource.uri)}`,
    `Source: ${resource.uri.toString()}`,
    `${fence}`,
    content,
    fence
  ].join('\n');
}

function getRelativeResourceLabel(rootUri: vscode.Uri, resourceUri: vscode.Uri): string {
  if (rootUri.scheme === 'file' && resourceUri.scheme === 'file') {
    return path.relative(rootUri.fsPath, resourceUri.fsPath) || getUriBasename(resourceUri);
  }
  return resourceUri.toString();
}
