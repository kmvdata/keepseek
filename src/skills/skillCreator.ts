import * as vscode from 'vscode';
import { localize, type KeepseekLanguage } from '../shared/i18n';
import { stringify } from 'yaml';
import { projectSkillsUri } from '../context/sharedConfigPaths';
import { SKILL_FILE_NAME } from './skillTypes';

export interface CreateSkillDraftInput {
  workspaceFolder: vscode.WorkspaceFolder;
  rawName: string;
  description: string;
  allowImplicit: boolean;
  language: KeepseekLanguage;
}

export interface CreatedSkillDraft {
  normalizedName: string;
  targetUri: vscode.Uri;
  content: string;
  label: string;
  reason: string;
  files: Array<{ targetUri: vscode.Uri; content: string; label: string }>;
}

const VALID_SKILL_NAME_PATTERN = /^[a-z0-9_-]+$/u;

export class SkillCreator {
  public createDraft(input: CreateSkillDraftInput): CreatedSkillDraft {
    if (typeof input.allowImplicit !== 'boolean') throw new Error('Implicit invocation policy must be boolean / 隐式调用策略必须是布尔值');
    const normalizedName = normalizeSkillName(input.rawName, input.language);
    const description = normalizeDescription(input.description, input.language);
    const skillsRootUri = projectSkillsUri(input.workspaceFolder.uri);
    const targetUri = vscode.Uri.joinPath(skillsRootUri, normalizedName, SKILL_FILE_NAME);

    if (!isUriInside(skillsRootUri, targetUri)) {
      throw new Error(localize(input.language, 'createSkillInvalidPath'));
    }

    const label = `.agents/skills/${normalizedName}/${SKILL_FILE_NAME}`;
    const content = renderSkillMarkdown({ name: normalizedName, description });
    const files = [{ targetUri, content, label }, {
      targetUri: vscode.Uri.joinPath(skillsRootUri, normalizedName, 'agents', 'openai.yaml'),
      content: stringify({ policy: { allow_implicit_invocation: input.allowImplicit } }),
      label: `.agents/skills/${normalizedName}/agents/openai.yaml`
    }];
    return { normalizedName, targetUri, label, reason: localize(input.language, 'createSkillDraftReason'), content, files };

  }
}

export function normalizeSkillName(rawName: string, language: KeepseekLanguage): string {
  const trimmed = String(rawName ?? '').trim();
  if (!trimmed) {
    throw new Error(localize(language, 'createSkillNameRequired'));
  }
  if (hasControlCharacters(trimmed)) {
    throw new Error(localize(language, 'createSkillNameInvalidCharacters'));
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(localize(language, 'createSkillNameInvalidPath'));
  }

  const normalized = trimmed
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-')
    .toLowerCase();
  if (!normalized || normalized.length > 64 || !VALID_SKILL_NAME_PATTERN.test(normalized) || !/[a-z0-9]/u.test(normalized)) {
    throw new Error(localize(language, 'createSkillNameInvalidCharacters'));
  }
  return normalized;
}

function normalizeDescription(description: string, language: KeepseekLanguage): string {
  const normalized = String(description ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized || normalized.length > 1024) {
    throw new Error(localize(language, 'createSkillDescriptionRequired'));
  }
  if (hasControlCharacters(normalized.replace(/\n/gu, ''))) {
    throw new Error(localize(language, 'createSkillDescriptionInvalid'));
  }
  return normalized;
}

function renderSkillMarkdown(input: { name: string; description: string }): string {
  return [
    '---', stringify({ name: input.name, description: input.description }).trimEnd(), '---', '',
    `# ${input.name}`, '', '## When To Use', input.description, '', '## Instructions',
    '- Describe the repeatable workflow, required inputs and expected output.',
    '- Check relevant evidence and report results, limitations and unresolved questions.', ''
  ].join('\n');
}

function isUriInside(rootUri: vscode.Uri, targetUri: vscode.Uri): boolean {
  const root = rootUri.toString().replace(/\/?$/u, '/');
  return targetUri.toString().startsWith(root);
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}
