import * as vscode from 'vscode';
import { localize, type KeepseekLanguage } from '../shared/i18n';
import { SKILL_FILE_NAME } from './skillTypes';

export interface CreateSkillDraftInput {
  workspaceFolder: vscode.WorkspaceFolder;
  rawName: string;
  description: string;
  allowImplicit: boolean;
  userInvocable: boolean;
  language: KeepseekLanguage;
}

export interface CreatedSkillDraft {
  normalizedName: string;
  targetUri: vscode.Uri;
  content: string;
  label: string;
  reason: string;
}

const VALID_SKILL_NAME_PATTERN = /^[a-z0-9_-]+$/u;

export class SkillCreator {
  public createDraft(input: CreateSkillDraftInput): CreatedSkillDraft {
    const normalizedName = normalizeSkillName(input.rawName, input.language);
    const description = normalizeDescription(input.description, input.language);
    const skillsRootUri = vscode.Uri.joinPath(input.workspaceFolder.uri, '.agents', 'skills');
    const targetUri = vscode.Uri.joinPath(skillsRootUri, normalizedName, SKILL_FILE_NAME);

    if (!isUriInside(skillsRootUri, targetUri)) {
      throw new Error(localize(input.language, 'createSkillInvalidPath'));
    }

    const label = `.agents/skills/${normalizedName}/${SKILL_FILE_NAME}`;
    return {
      normalizedName,
      targetUri,
      label,
      reason: localize(input.language, 'createSkillDraftReason'),
      content: renderSkillMarkdown({
        name: normalizedName,
        description,
        allowImplicit: input.allowImplicit,
        userInvocable: input.userInvocable
      })
    };
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
  if (!normalized || !VALID_SKILL_NAME_PATTERN.test(normalized) || !/[a-z0-9]/u.test(normalized)) {
    throw new Error(localize(language, 'createSkillNameInvalidCharacters'));
  }
  return normalized;
}

function normalizeDescription(description: string, language: KeepseekLanguage): string {
  const normalized = String(description ?? '').replace(/\r\n?/gu, '\n').trim();
  if (!normalized) {
    throw new Error(localize(language, 'createSkillDescriptionRequired'));
  }
  if (hasControlCharacters(normalized.replace(/\n/gu, ''))) {
    throw new Error(localize(language, 'createSkillDescriptionInvalid'));
  }
  return normalized;
}

function renderSkillMarkdown(input: {
  name: string;
  description: string;
  allowImplicit: boolean;
  userInvocable: boolean;
}): string {
  const frontmatterDescription = input.description.replace(/\s+/gu, ' ');
  return [
    '---',
    `name: ${input.name}`,
    `description: ${frontmatterDescription}`,
    'metadata:',
    '  keepseek:',
    `    allowImplicit: ${input.allowImplicit ? 'true' : 'false'}`,
    `    userInvocable: ${input.userInvocable ? 'true' : 'false'}`,
    '---',
    '',
    `# ${input.name}`,
    '',
    '## When To Use',
    input.description,
    '',
    '## Instructions',
    '- Describe the repeatable workflow this skill should provide.',
    '- Keep KeepSeek core safety rules in force: file writes must be DraftEdit changes that the user applies.',
    '- Do not execute scripts from this skill.',
    ''
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
