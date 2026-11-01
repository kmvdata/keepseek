import { createHash } from 'node:crypto';
import type { AgentRequest } from '../../shared/types';
import { resolveSubagentProfile } from './profiles';
import type { SubagentProfile } from './types';

/** Host-only, immutable inheritance proof. Never append this object to model context. */
export interface SubagentHostContextV1 {
  version: 1;
  projectInstructions: Array<{ uri: string; workspaceFolder: string; content: string }>;
  profiles: Array<{ skillId: string; name: string; versionHash: string; profile: SubagentProfile }>;
  workspace: { text: string; hash: string };
  workspaceTrusted: boolean;
  authorizedExternalReferenceUris: string[];
  hash: string;
}

const MAX_CAPSULE_BYTES = 4 * 1024 * 1024;
const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export function createSubagentHostContext(request: AgentRequest, workspace: { text: string; hash: string }, workspaceTrusted = true): SubagentHostContextV1 {
  const profiles = (request.currentRunContext?.skills ?? []).flatMap(skill => {
    if (skill.runAs !== 'subagent' || !skill.subagentProfile) return [];
    const profile = resolveSubagentProfile({ requestedId: skill.subagentProfile.id, skills: [skill] });
    if (!profile) return [];
    const clean = projectProfile(profile);
    return [{ skillId: skill.id, name: skill.name, versionHash: digest(JSON.stringify(clean)), profile: clean }];
  }).sort((a, b) => compare(a.profile.id, b.profile.id) || compare(a.skillId, b.skillId));
  if (new Set(profiles.map(p => p.profile.id)).size !== profiles.length) throw new Error('Duplicate activated subagent profile identity.');
  const body = {
    version: 1 as const,
    projectInstructions: (request.currentRunContext?.projectInstructions ?? []).map(item => ({
      uri: item.uri, workspaceFolder: item.workspaceFolder, content: item.content
    })).sort((a, b) => compare(a.uri, b.uri)),
    profiles,
    workspace: { text: workspace.text, hash: workspace.hash },
    workspaceTrusted,
    authorizedExternalReferenceUris: [...new Set(request.authorizedExternalReferenceUris ?? [])].sort(compare)
  };
  const capsule = { ...body, hash: digest(JSON.stringify(body)) };
  if (!normalizeSubagentHostContext(capsule)) throw new Error('Subagent host context is invalid or exceeds the 4 MiB host resource limit.');
  return capsule;
}

/** Strict projection removes unknown/runtime fields and verifies exact original bytes. */
export function normalizeSubagentHostContext(value: unknown): SubagentHostContextV1 | undefined {
  try {
    if (!value || typeof value !== 'object' || Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CAPSULE_BYTES) return undefined;
    const raw = value as SubagentHostContextV1;
    if (raw.version !== 1 || !Array.isArray(raw.projectInstructions) || !Array.isArray(raw.profiles)
      || !Array.isArray(raw.authorizedExternalReferenceUris) || typeof raw.workspace?.text !== 'string'
      || typeof raw.workspaceTrusted !== 'boolean'
      || raw.workspace.hash !== digest(raw.workspace.text) || typeof raw.hash !== 'string') return undefined;
    if (raw.projectInstructions.some(p => !p || [p.uri, p.workspaceFolder, p.content].some(s => typeof s !== 'string'))
      || raw.authorizedExternalReferenceUris.some(uri => typeof uri !== 'string')
      || raw.profiles.some(p => !p || typeof p.skillId !== 'string' || typeof p.name !== 'string'
        || !validProfile(p.profile) || p.versionHash !== digest(JSON.stringify(projectProfile(p.profile))))) return undefined;
    const body = {
      version: 1 as const,
      projectInstructions: raw.projectInstructions.map(p => ({ uri: p.uri, workspaceFolder: p.workspaceFolder, content: p.content })),
      profiles: raw.profiles.map(p => ({ skillId: p.skillId, name: p.name, versionHash: p.versionHash, profile: projectProfile(p.profile) })),
      workspace: { text: raw.workspace.text, hash: raw.workspace.hash },
      workspaceTrusted: raw.workspaceTrusted,
      authorizedExternalReferenceUris: [...raw.authorizedExternalReferenceUris]
    };
    if (new Set(body.profiles.map(p => p.profile.id)).size !== body.profiles.length
      || digest(JSON.stringify(body)) !== raw.hash) return undefined;
    return { ...body, hash: raw.hash };
  } catch { return undefined; }
}

export function resolveInheritedSubagentHostContext(request: AgentRequest, workspace: { text: string; hash: string }, workspaceTrusted = true): SubagentHostContextV1 | undefined {
  const capsule = normalizeSubagentHostContext(request.subagentHostContext);
  if (!capsule || capsule.workspace.hash !== workspace.hash || capsule.workspaceTrusted !== workspaceTrusted
    || JSON.stringify(capsule.authorizedExternalReferenceUris) !== JSON.stringify([...new Set(request.authorizedExternalReferenceUris ?? [])].sort(compare))) return undefined;
  return capsule;
}

function validProfile(p: SubagentProfile): boolean {
  return Boolean(p && typeof p.id === 'string' && p.id && typeof p.label === 'string'
    && typeof p.description === 'string' && typeof p.instructions === 'string'
    && ['research-read', 'review-read', 'proposal', 'nested-read'].includes(p.lane)
    && Array.isArray(p.toolNames) && p.toolNames.every(name => typeof name === 'string')
    && typeof p.canDelegate === 'boolean' && Number.isSafeInteger(p.resultMaxChars) && p.resultMaxChars > 0
    && (p.maxSteps === undefined || Number.isSafeInteger(p.maxSteps) && p.maxSteps > 0)
    && (p.timeoutMs === undefined || Number.isSafeInteger(p.timeoutMs) && p.timeoutMs > 0)
    && (p.sourceSkillId === undefined || typeof p.sourceSkillId === 'string'));
}

function projectProfile(p: SubagentProfile): SubagentProfile {
  return { id: p.id, label: p.label, description: p.description, lane: p.lane, instructions: p.instructions,
    toolNames: [...p.toolNames], ...(p.maxSteps !== undefined ? { maxSteps: p.maxSteps } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}), canDelegate: p.canDelegate,
    resultMaxChars: p.resultMaxChars, ...(p.sourceSkillId !== undefined ? { sourceSkillId: p.sourceSkillId } : {}) };
}
