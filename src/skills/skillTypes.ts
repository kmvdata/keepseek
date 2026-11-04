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
  hasReferences: boolean;
  hasAssets: boolean;
  hasScripts: boolean;
  runAs?: 'subagent';
  subagentProfile?: {
    id: string;
    tools?: string[];
    maxSteps?: number;
    timeoutMs?: number;
    canDelegate?: boolean;
    resultMaxChars?: number;
  };
  interface?: Record<string, string>;
  dependencies?: Array<{ type: string; value: string; description?: string }>;
  policySource?: string;
  unavailableReason?: string;
  /** Internal cache identity; omitted from the Webview projection. */
  contentFingerprint?: string;
  physicalUri?: string;
  documentHash?: string;
  metadataHash?: string;
  readBoundaryUri?: string;
}

export interface SkillManifestView {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceLabel: string;
  rootUri: string;
  rootPath: string;
  skillUri: string;
  skillPath: string;
  enabled: boolean;
  allowImplicit: boolean;
  hasReferences: boolean;
  hasAssets: boolean;
  hasScripts: boolean;
  runAs?: 'subagent';
  subagentProfile?: SkillManifest['subagentProfile'];
  interface?: Record<string, string>;
  dependencies?: Array<{ type: string; value: string; description?: string }>;
  policySource?: string;
  unavailableReason?: string;
  active?: boolean;
  loadError?: string;
  workspaceDefault?: boolean;
}

export interface SkillStateView {
  workspaceTrusted: boolean;
  scopeUri?: string;
  diagnostics?: string[];
  configSummary?: { projectDocMaxBytes: number; fallbackFilenames: string[]; origins: Record<string, string>; fingerprint: string };
  items: SkillManifestView[];
  activeSkillIds: string[];
  workspaceDefaultSkillIds: string[];
}

export const SKILL_FILE_NAME = 'SKILL.md';

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
    description: manifest.description,
    hasScripts: manifest.hasScripts,
    runAs: manifest.runAs,
    subagentProfile: manifest.subagentProfile
      ? { ...manifest.subagentProfile, tools: manifest.subagentProfile.tools ? [...manifest.subagentProfile.tools] : undefined }
      : undefined,
    loadedResourceUris: [manifest.skillUri.toString()]
  };
}

export function toSkillManifestView(
  manifest: SkillManifest,
  options: { active?: boolean; loadError?: string; workspaceDefault?: boolean } = {}
): SkillManifestView {
  return {
    id: manifest.id,
    name: manifest.name,
    description: manifest.description,
    source: manifest.source,
    sourceLabel: manifest.sourceLabel,
    rootUri: manifest.rootUri.toString(),
    rootPath: getUriDisplayPath(manifest.rootUri),
    skillUri: manifest.skillUri.toString(),
    skillPath: getUriDisplayPath(manifest.skillUri),
    enabled: manifest.enabled,
    allowImplicit: manifest.allowImplicit,
    hasReferences: manifest.hasReferences,
    hasAssets: manifest.hasAssets,
    hasScripts: manifest.hasScripts,
    runAs: manifest.runAs,
    subagentProfile: manifest.subagentProfile
      ? { ...manifest.subagentProfile, tools: manifest.subagentProfile.tools ? [...manifest.subagentProfile.tools] : undefined }
      : undefined,
    interface: manifest.interface,
    dependencies: manifest.dependencies,
    policySource: manifest.policySource,
    unavailableReason: manifest.unavailableReason,
    active: options.active,
    loadError: options.loadError,
    workspaceDefault: options.workspaceDefault
  };
}

function getUriDisplayPath(uri: vscode.Uri): string {
  return uri.scheme === 'file' ? uri.fsPath : uri.toString();
}
