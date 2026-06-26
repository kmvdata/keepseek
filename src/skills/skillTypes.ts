import * as vscode from 'vscode';
import type { ActivatedSkill, SkillSource } from '../shared/types';

export { type ActivatedSkill, type SkillSource };

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceLabel: string;
  rootUri: vscode.Uri;
  skillUri: vscode.Uri;
  enabled: boolean;
  allowImplicit: boolean;
  userInvocable: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  hasScripts: boolean;
  unavailableReason?: string;
}

export interface SkillManifestView {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceLabel: string;
  rootUri: string;
  skillUri: string;
  enabled: boolean;
  allowImplicit: boolean;
  userInvocable: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  hasScripts: boolean;
  unavailableReason?: string;
  active?: boolean;
  loadError?: string;
}

export interface SkillStateView {
  workspaceTrusted: boolean;
  items: SkillManifestView[];
  activeSkillIds: string[];
}

export const SKILL_FILE_NAME = 'SKILL.md';
export const SKILL_INSTRUCTION_FILE_NAMES = [SKILL_FILE_NAME, 'AGENTS.md'] as const;

export function createSkillId(source: SkillSource, rootUri: vscode.Uri): string {
  return `${source}:${encodeURIComponent(rootUri.toString())}`;
}

export function toActivatedSkill(manifest: SkillManifest, content: string): ActivatedSkill {
  return {
    id: manifest.id,
    name: manifest.name,
    source: manifest.source,
    rootUri: manifest.rootUri.toString(),
    skillUri: manifest.skillUri.toString(),
    content,
    loadedResourceUris: [manifest.skillUri.toString()]
  };
}

export function toSkillManifestView(
  manifest: SkillManifest,
  options: { active?: boolean; loadError?: string } = {}
): SkillManifestView {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    source: manifest.source,
    sourceLabel: manifest.sourceLabel,
    rootUri: manifest.rootUri.toString(),
    skillUri: manifest.skillUri.toString(),
    enabled: manifest.enabled,
    allowImplicit: manifest.allowImplicit,
    userInvocable: manifest.userInvocable,
    hasReferences: manifest.hasReferences,
    hasAssets: manifest.hasAssets,
    hasScripts: manifest.hasScripts,
    unavailableReason: manifest.unavailableReason,
    active: options.active,
    loadError: options.loadError
  };
}
