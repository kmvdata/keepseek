import type { SkillActivationInfo, SkillActivationSource } from '../shared/types';
import { normalizeUri } from '../agent/projectInstructions';
import type { SkillManifest } from './skillTypes';

export interface SkillActivationDecision {
  manifest: SkillManifest;
  activation: SkillActivationInfo;
}

export interface SkillActivationSkip {
  id: string;
  name: string;
  skillUri: string;
  reason: 'disabled' | 'workspace_untrusted' | 'allow_implicit_false' | 'not_matched' | 'implicit_limit' | 'duplicate_uri' | 'duplicate_skill' | 'load_failed';
  keptId?: string;
}

export interface SkillActivationResolution {
  activated: SkillActivationDecision[];
  skipped: SkillActivationSkip[];
}

export interface SkillActivationResolverInput {
  manifests: readonly SkillManifest[];
  prompt: string;
  explicitSkillIds?: readonly string[];
  sessionSkillIds?: readonly string[];
  workspaceDefaultSkillIds?: readonly string[];
  workspaceTrusted: boolean;
  maxImplicitSkills: number;
}

interface RankedCandidate extends SkillActivationDecision {
  activationRank: number;
  sourceRank: number;
  discoveryIndex: number;
}

const WORKSPACE_SKILL_SOURCES = new Set(['workspace', 'agentsWorkspace']);

export class SkillActivationResolver {
  public resolve(input: SkillActivationResolverInput): SkillActivationResolution {
    const byId = new Map(input.manifests.map((manifest, index) => [manifest.id, { manifest, index }]));
    const candidates: RankedCandidate[] = [];
    const skipped: SkillActivationSkip[] = [];
    const claimedIds = new Set<string>();

    this.addRequestedCandidates(candidates, claimedIds, skipped, byId, input.explicitSkillIds, 'explicit', input);
    this.addRequestedCandidates(candidates, claimedIds, skipped, byId, input.sessionSkillIds, 'session', input);
    this.addRequestedCandidates(candidates, claimedIds, skipped, byId, input.workspaceDefaultSkillIds, 'workspace-default', input);

    const implicitCandidates: RankedCandidate[] = [];
    input.manifests.forEach((manifest, index) => {
      if (claimedIds.has(manifest.id)) {
        return;
      }
      if (!canActivate(manifest, input.workspaceTrusted)) {
        skipped.push(createSkip(manifest, getUnavailableReason(manifest, input.workspaceTrusted)));
        return;
      }
      if (!manifest.allowImplicit) {
        skipped.push(createSkip(manifest, 'allow_implicit_false'));
        return;
      }
      const match = scoreImplicitMatch(manifest, input.prompt);
      if (match.score <= 0) {
        skipped.push(createSkip(manifest, 'not_matched'));
        return;
      }
      implicitCandidates.push(createCandidate(manifest, index, 'implicit', match.reason, match.score));
    });

    implicitCandidates.sort(compareCandidates);
    const implicitLimit = Math.max(0, Math.floor(input.maxImplicitSkills));
    implicitCandidates.forEach((candidate, index) => {
      if (index < implicitLimit) {
        candidates.push(candidate);
      } else {
        skipped.push(createSkip(candidate.manifest, 'implicit_limit'));
      }
    });

    candidates.sort(compareCandidates);
    const activated: SkillActivationDecision[] = [];
    const seenUris = new Map<string, string>();
    const seenNames = new Map<string, string>();
    for (const candidate of candidates) {
      const uriKey = normalizeUri(candidate.manifest.skillUri);
      const nameKey = normalizeSkillName(candidate.manifest.name);
      const duplicateUri = seenUris.get(uriKey);
      if (duplicateUri) {
        skipped.push(createSkip(candidate.manifest, 'duplicate_uri', duplicateUri));
        continue;
      }
      const duplicateName = nameKey ? seenNames.get(nameKey) : undefined;
      if (duplicateName) {
        skipped.push(createSkip(candidate.manifest, 'duplicate_skill', duplicateName));
        continue;
      }
      seenUris.set(uriKey, candidate.manifest.id);
      if (nameKey) {
        seenNames.set(nameKey, candidate.manifest.id);
      }
      activated.push({ manifest: candidate.manifest, activation: candidate.activation });
    }

    return { activated, skipped };
  }

  private addRequestedCandidates(
    candidates: RankedCandidate[],
    claimedIds: Set<string>,
    skipped: SkillActivationSkip[],
    byId: Map<string, { manifest: SkillManifest; index: number }>,
    ids: readonly string[] | undefined,
    source: Exclude<SkillActivationSource, 'implicit'>,
    input: SkillActivationResolverInput
  ): void {
    for (const id of uniqueIds(ids)) {
      if (claimedIds.has(id)) {
        continue;
      }
      claimedIds.add(id);
      const found = byId.get(id);
      if (!found) {
        continue;
      }
      if (!canActivate(found.manifest, input.workspaceTrusted)) {
        skipped.push(createSkip(found.manifest, getUnavailableReason(found.manifest, input.workspaceTrusted)));
        continue;
      }
      candidates.push(createCandidate(
        found.manifest,
        found.index,
        source,
        getActivationReason(source)
      ));
    }
  }
}

export function scoreImplicitMatch(
  manifest: Pick<SkillManifest, 'name' | 'description' | 'skillUri'>,
  prompt: string
): { score: number; reason: string } {
  const normalizedPrompt = normalizeMatchText(prompt);
  if (!normalizedPrompt) {
    return { score: 0, reason: 'empty request' };
  }
  const normalizedName = normalizeMatchText(manifest.name);
  const promptTerms = new Set(tokenize(normalizedPrompt));
  const nameTerms = tokenize(normalizedName);
  const descriptionTerms = tokenize(normalizeMatchText(manifest.description));
  let score = 0;
  const reasons: string[] = [];

  if (normalizedName && normalizedPrompt.includes(normalizedName)) {
    score += 80;
    reasons.push('skill name');
  }
  const nameMatches = nameTerms.filter((term) => promptTerms.has(term)).length;
  if (nameMatches) {
    score += nameMatches * 12;
    reasons.push(`${nameMatches} name keyword${nameMatches === 1 ? '' : 's'}`);
  }
  const descriptionMatches = Array.from(new Set(descriptionTerms))
    .filter((term) => term.length >= 3 && promptTerms.has(term)).length;
  if (descriptionMatches) {
    score += Math.min(24, descriptionMatches * 3);
    reasons.push(`${descriptionMatches} description keyword${descriptionMatches === 1 ? '' : 's'}`);
  }

  return score >= 8
    ? { score, reason: `Deterministic request match: ${reasons.join(', ')}.` }
    : { score: 0, reason: 'no deterministic keyword match' };
}

function createCandidate(
  manifest: SkillManifest,
  discoveryIndex: number,
  source: SkillActivationSource,
  reason: string,
  score?: number
): RankedCandidate {
  return {
    manifest,
    activation: { source, reason, score },
    activationRank: getActivationRank(source),
    sourceRank: WORKSPACE_SKILL_SOURCES.has(manifest.source) ? 0 : 1,
    discoveryIndex
  };
}

function compareCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return left.activationRank - right.activationRank
    || (right.activation.score ?? 0) - (left.activation.score ?? 0)
    || left.sourceRank - right.sourceRank
    || left.discoveryIndex - right.discoveryIndex
    || left.manifest.name.localeCompare(right.manifest.name, undefined, { sensitivity: 'base' });
}

function getActivationRank(source: SkillActivationSource): number {
  switch (source) {
    case 'explicit': return 0;
    case 'session': return 1;
    case 'workspace-default': return 2;
    case 'implicit': return 3;
  }
}

function getActivationReason(source: Exclude<SkillActivationSource, 'implicit'>): string {
  switch (source) {
    case 'explicit': return 'Selected for the current user request.';
    case 'session': return 'Already enabled in the current chat session.';
    case 'workspace-default': return 'Configured as a default Skill for this workspace.';
  }
}

function canActivate(manifest: SkillManifest, workspaceTrusted: boolean): boolean {
  return manifest.enabled
    && !manifest.unavailableReason
    && (workspaceTrusted || !WORKSPACE_SKILL_SOURCES.has(manifest.source));
}

function getUnavailableReason(
  manifest: SkillManifest,
  workspaceTrusted: boolean
): SkillActivationSkip['reason'] {
  return !workspaceTrusted && WORKSPACE_SKILL_SOURCES.has(manifest.source)
    ? 'workspace_untrusted'
    : 'disabled';
}

function createSkip(
  manifest: SkillManifest,
  reason: SkillActivationSkip['reason'],
  keptId?: string
): SkillActivationSkip {
  return {
    id: manifest.id,
    name: manifest.name,
    skillUri: manifest.skillUri.toString(),
    reason,
    keptId
  };
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  return Array.from(new Set((ids ?? []).map((id) => id.trim()).filter(Boolean)));
}

function normalizeSkillName(name: string): string {
  return normalizeMatchText(name).replace(/\s+/gu, '-');
}

function normalizeMatchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[_./\\-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter((term) => term.length >= 2);
}
