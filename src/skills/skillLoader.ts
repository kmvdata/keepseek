import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { canonicalUri, readSharedText } from '../context/sharedConfigPaths';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { getMarkdownFence } from '../shared/markdown';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import { toActivatedSkill, type ActivatedSkill, type SkillManifest } from './skillTypes';
import { pinCodexPluginSkill, type CodexPluginReadContext } from './codexPluginResources';

const MAX_REFERENCED_SKILL_RESOURCES = 12;
const MAX_REFERENCED_SKILL_RESOURCE_CHARS = 48_000;
const MARKDOWN_LINK_TARGET_PATTERN = /!?\[[^\]\n]*\]\(([^)\n]+)\)/gu;

interface LoadedSkillResource {
  uri: vscode.Uri;
  content: string;
  omitted?: boolean;
}

export class SkillLoader {
  public async loadPluginSkill(manifest: SkillManifest, packageSkills: readonly SkillManifest[],
    context: CodexPluginReadContext, cwd?: string): Promise<ActivatedSkill> {
    if (!manifest.pluginInstallation || !manifest.enabled || manifest.unavailableReason) {
      throw new Error(manifest.unavailableReason ?? 'Plugin Skill unavailable / 插件 Skill 不可用');
    }
    const pinned = await pinCodexPluginSkill(manifest.pluginInstallation, manifest, packageSkills, context);
    const skill = toActivatedSkill(manifest, pinned.content);
    skill.name = manifest.pluginQualifiedName ?? manifest.name;
    skill.pluginSnapshot = pinned.snapshot;
    skill.pluginPolicyCwd = cwd;
    skill.loadedResourceUris = [...new Set([manifest.skillUri.toString(), ...pinned.resources.map(resource => resource.uri)])];
    return skill;
  }

  public async loadSkill(manifest: SkillManifest): Promise<ActivatedSkill> {
    if (manifest.pluginInstallation) throw new Error('Plugin Skill requires explicit task activation / 插件 Skill 需要在任务中显式调用');
    if (!manifest.enabled) {
      throw new Error(manifest.unavailableReason || 'Skill is disabled.');
    }
    if (!isUriInsideOrEqual(manifest.rootUri, manifest.skillUri)) {
      throw new Error('Skill file is outside the skill root.');
    }
    if (!vscode.workspace.isTrusted && (manifest.source === 'workspace' || manifest.source === 'agentsWorkspace')) throw new Error('Workspace is not trusted / 工作区未受信任');
    const boundary = manifest.readBoundaryUri ? vscode.Uri.parse(manifest.readBoundaryUri) : manifest.rootUri;
    if (manifest.readBoundaryUri && (await canonicalUri(boundary)).toString() !== manifest.readBoundaryUri) throw new Error('Skill boundary changed; refresh required / Skill 边界已变更，请刷新');
    const content = await this.readSkillTextFile(manifest.skillUri, boundary);
    if (manifest.physicalUri && (await canonicalUri(manifest.skillUri)).toString() !== manifest.physicalUri) throw new Error('Skill target changed; refresh required / Skill 目标已变更，请刷新');
    if (manifest.documentHash && createHash('sha256').update(content).digest('hex') !== manifest.documentHash) throw new Error('Skill changed; refresh required / Skill 已变更，请刷新');
    if (manifest.metadataHash) {
      const metadata = await readSharedText(vscode.Uri.joinPath(manifest.rootUri, 'agents', 'openai.yaml'), [boundary], 65536);
      if (createHash('sha256').update(metadata ?? '').digest('hex') !== manifest.metadataHash) throw new Error('Skill policy changed; refresh required / Skill 策略已变更，请刷新');
    }
    const resources = await this.loadReferencedResources(manifest.rootUri, manifest.skillUri, content, boundary);
    const activated = toActivatedSkill(manifest, formatSkillContentWithResources(manifest.rootUri, content, resources));
    activated.loadedResourceUris = [
      manifest.skillUri.toString(),
      ...resources.filter(resource => !resource.omitted).map((resource) => resource.uri.toString())
    ];
    return activated;
  }

  private async loadReferencedResources(
    rootUri: vscode.Uri,
    skillUri: vscode.Uri,
    skillContent: string,
    boundary: vscode.Uri
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
          if (!isUriInsideOrEqual(rootUri, targetUri)) throw new Error('Resource outside Skill root');
          const content = await this.readSkillTextFile(targetUri, boundary);
          if (referencedContentChars + content.length > MAX_REFERENCED_SKILL_RESOURCE_CHARS) {
            resources.push({ uri: targetUri, omitted: true, content: '[Resource omitted: capacity limit / 资源超过容量上限]' });
            continue;
          }
          referencedContentChars += content.length;
          const resource = { uri: targetUri, content };
          resources.push(resource);
          queue.push(resource);
        } catch {
          resources.push({ uri: targetUri, omitted: true, content: '[Resource missing, unreadable or outside authorized boundary / 资源缺失、不可读或越过授权边界]' });
        }
      }
    }

    return resources;
  }

  private async readSkillTextFile(uri: vscode.Uri, boundary: vscode.Uri): Promise<string> {
    if (shouldSkipTextUri(uri)) throw new Error(`${getUriBasename(uri)} is not a readable text file.`);
    const content = await readSharedText(uri, [boundary], getConfiguredMaxFileBytes());
    if (content === undefined || !isReadableTextContent(content)) throw new Error('Skill resource is missing or unreadable / Skill 资源缺失或不可读');
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
