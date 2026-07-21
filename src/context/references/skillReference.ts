import * as path from 'node:path';
import * as vscode from 'vscode';
import { normalizeKeepseekLanguage, type KeepseekLanguage } from '../../shared/i18n';
import { getMarkdownFence } from '../../shared/markdown';
import { SkillLoader } from '../../skills/skillLoader';
import { SKILL_FILE_NAME, type SkillManifest } from '../../skills/skillTypes';
import { resolveFileReferenceUri } from './fileReference';
import { hasUnsafeReferenceTargetCharacters, isInsideMarkdownFence } from './referenceSyntax';

const SKILL_MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\n]+)\)/gu;

export interface ExpandSkillReferencesOptions {
  skillManifests?: readonly SkillManifest[];
  skillLoader?: SkillLoader;
  language?: KeepseekLanguage;
  expandSkillContents?: boolean;
}

interface PromptSkillReference {
  matchStart: number;
  matchEnd: number;
  originalText: string;
  label: string;
  uri: vscode.Uri;
  manifest: SkillManifest;
}

export async function expandSkillReferencesInPrompt(
  prompt: string,
  options: ExpandSkillReferencesOptions = {}
): Promise<string> {
  if (options.expandSkillContents === false) {
    return prompt;
  }
  const references = findPromptSkillReferences(prompt, options.skillManifests ?? []);
  if (!references.length) {
    return prompt;
  }

  const language = normalizeKeepseekLanguage(options.language);
  const loader = options.skillLoader ?? new SkillLoader();
  let expandedPrompt = '';
  let cursor = 0;

  for (const reference of references) {
    if (reference.matchStart < cursor) {
      continue;
    }

    const expandedReference = await expandPromptSkillReference(reference, loader, language);
    if (!expandedReference) {
      continue;
    }

    expandedPrompt += prompt.slice(cursor, reference.matchStart);
    expandedPrompt += withPromptBlockBoundaries(prompt, reference.matchStart, reference.matchEnd, expandedReference);
    cursor = reference.matchEnd;
  }

  return expandedPrompt + prompt.slice(cursor);
}

function findPromptSkillReferences(prompt: string, manifests: readonly SkillManifest[]): PromptSkillReference[] {
  const allowed = createAllowedSkillMap(manifests);
  if (!allowed.size) {
    return [];
  }

  const references: PromptSkillReference[] = [];
  for (const match of prompt.matchAll(SKILL_MARKDOWN_LINK_PATTERN)) {
    const label = match[1]?.trim();
    const target = match[2]?.trim();
    const matchStart = match.index;
    if (!label || !target || matchStart === undefined) {
      continue;
    }
    if (!label.startsWith('$') || isInsideMarkdownFence(prompt, matchStart)) {
      continue;
    }
    if (hasUnsafeReferenceTargetCharacters(target)) {
      continue;
    }

    const uri = resolveFileReferenceUri(target);
    if (!uri || getUriBasename(uri) !== SKILL_FILE_NAME) {
      continue;
    }

    const manifest = allowed.get(getSkillUriKey(uri));
    if (!manifest || !manifest.enabled || !manifest.userInvocable || manifest.unavailableReason) {
      continue;
    }

    references.push({
      matchStart,
      matchEnd: matchStart + match[0].length,
      originalText: match[0],
      label,
      uri,
      manifest
    });
  }

  return references;
}

function createAllowedSkillMap(manifests: readonly SkillManifest[]): Map<string, SkillManifest> {
  const allowed = new Map<string, SkillManifest>();
  for (const manifest of manifests) {
    if (getUriBasename(manifest.skillUri) !== SKILL_FILE_NAME) {
      continue;
    }
    allowed.set(getSkillUriKey(manifest.skillUri), manifest);
  }
  return allowed;
}

async function expandPromptSkillReference(
  reference: PromptSkillReference,
  loader: SkillLoader,
  language: KeepseekLanguage
): Promise<string | undefined> {
  try {
    const skill = await loader.loadSkill(reference.manifest);
    const content = skill.content.replace(/\r\n?/gu, '\n').trim();
    const instruction = language === 'en'
      ? 'The user invoked this Codex-compatible skill. Read the full SKILL.md below, follow its workflow and constraints for this run, and keep KeepSeek core safety rules in force. If the skill refers to relative resources, use the loaded resource sections below or inspect files under the same skill root when needed.'
      : '用户调用了这个与 Codex 兼容的 skill。请完整阅读下面的 SKILL.md，并在本轮请求中遵循其中的工作流和约束，同时继续遵守 KeepSeek 的核心安全规则。如果该 skill 引用了相对资源，请优先使用下方已加载的资源片段，必要时再查看同一 skill 根目录下的文件。';
    const title = language === 'en'
      ? `Codex skill reference: ${reference.originalText}`
      : `Codex skill 引用：${reference.originalText}`;
    const nameLine = language === 'en'
      ? `Name: ${skill.name}`
      : `名称：${skill.name}`;
    const pathLine = language === 'en'
      ? `Instruction file: ${getUriDisplayPath(reference.manifest.skillUri)}`
      : `说明文件：${getUriDisplayPath(reference.manifest.skillUri)}`;
    const fence = getMarkdownFence(content);
    const fencedContent = content.endsWith('\n') ? content : `${content}\n`;
    return [
      reference.originalText,
      title,
      instruction,
      nameLine,
      pathLine,
      `${fence}markdown`,
      fencedContent,
      fence
    ].join('\n');
  } catch {
    return undefined;
  }
}

function getSkillUriKey(uri: vscode.Uri): string {
  if (uri.scheme === 'file') {
    return path.resolve(uri.fsPath);
  }
  return uri.toString();
}

function getUriDisplayPath(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}

function getUriBasename(uri: vscode.Uri): string {
  const value = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return path.basename(value) || '';
}

function withPromptBlockBoundaries(prompt: string, start: number, end: number, block: string): string {
  const needsLeadingBreak = start > 0 && !isLineBreak(prompt.charAt(start - 1));
  const needsTrailingBreak = end < prompt.length && !isLineBreak(prompt.charAt(end));
  return `${needsLeadingBreak ? '\n' : ''}${block}${needsTrailingBreak ? '\n' : ''}`;
}

function isLineBreak(value: string): boolean {
  return value === '\n' || value === '\r';
}
