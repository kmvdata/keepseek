import type {
  ActivatedSkill,
  CurrentRunContext,
  LegacyProjectMemoryContext,
  ProjectInstructionContext,
  RunContextDiscardedSource,
  RunContextSourceSummary,
  SkillActivationSource
} from '../shared/types';
import type { ProjectInstructionsResolution } from './projectInstructions';
import { hashContent } from './projectInstructions';
import type { SkillActivationSkip } from '../skills/skillActivationResolver';
import { estimateTokenCount } from './tokenEstimate';
import { deduplicateContextSources, type ContextSourceCandidate } from './contextDeduplication';

export const RUN_CONTEXT_PRECEDENCE = [
  'KeepSeek core safety rules and tool permission boundaries',
  'Current explicit user request',
  'Applicable project AGENTS.md instructions',
  'Skills explicitly selected for the current request',
  'Skills enabled for the current session',
  'Workspace-default personal or project Skills',
  'Deterministically matched implicit Skills',
  'Read-only Legacy Project Memory during migration'
];

type CandidateValue =
  | { type: 'project'; instruction: ProjectInstructionContext }
  | { type: 'skill'; skill: ActivatedSkill }
  | { type: 'legacy'; memory: LegacyProjectMemoryContext };

export interface CurrentRunContextBuilderInput {
  projectInstructions: ProjectInstructionsResolution;
  skills: ActivatedSkill[];
  skillActivationSkips?: SkillActivationSkip[];
  legacyMemory?: LegacyProjectMemoryContext;
  skillCharacterBudget: number;
}

export function buildCurrentRunContext(input: CurrentRunContextBuilderInput): CurrentRunContext {
  const candidates: Array<ContextSourceCandidate<CandidateValue>> = [];
  for (const instruction of input.projectInstructions.instructions) {
    candidates.push({
      id: instruction.id,
      kind: 'project-instructions',
      label: `${instruction.workspaceFolder}/AGENTS.md`,
      uri: instruction.uri,
      content: instruction.content,
      contentHash: instruction.contentHash,
      priority: 30,
      value: { type: 'project', instruction }
    });
  }
  for (const skill of input.skills) {
    candidates.push({
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      uri: skill.skillUri,
      content: skill.content,
      priority: getSkillPriority(skill.activation?.source),
      value: { type: 'skill', skill }
    });
  }
  if (input.legacyMemory?.content.trim()) {
    candidates.push({
      id: 'legacy-project-memory',
      kind: 'legacy-memory',
      label: 'Legacy Project Memory',
      uri: input.legacyMemory.sourceUris[0],
      content: input.legacyMemory.content,
      priority: 70,
      value: { type: 'legacy', memory: input.legacyMemory }
    });
  }

  const deduplication = deduplicateContextSources(candidates);
  const activationDuplicateCount = (input.skillActivationSkips ?? [])
    .filter((skip) => skip.reason === 'duplicate_uri' || skip.reason === 'duplicate_skill').length;
  const projectInstructions: ProjectInstructionContext[] = [];
  const skills: ActivatedSkill[] = [];
  let legacyMemory: LegacyProjectMemoryContext | undefined;
  const sources: RunContextSourceSummary[] = [];
  const discarded: RunContextDiscardedSource[] = [
    ...input.projectInstructions.discarded,
    ...mapActivationSkips(input.skillActivationSkips),
    ...deduplication.discarded
  ];
  let remainingSkillCharacters = Math.max(0, Math.floor(input.skillCharacterBudget));
  let anyTruncated = discarded.some((source) => source.reason === 'budget_exhausted');

  for (const candidate of deduplication.kept) {
    if (candidate.value.type === 'project') {
      projectInstructions.push(candidate.value.instruction);
      sources.push(toProjectSourceSummary(candidate.value.instruction));
      anyTruncated ||= candidate.value.instruction.truncated;
      continue;
    }
    if (candidate.value.type === 'legacy') {
      legacyMemory = candidate.value.memory;
      sources.push({
        id: candidate.id,
        kind: 'legacy-memory',
        label: candidate.label,
        uri: candidate.uri,
        source: 'legacy-read-only',
        characterCount: candidate.content.length,
        tokenEstimate: candidate.value.memory.tokenEstimate,
        contentHash: candidate.contentHash || hashContent(candidate.content),
        truncated: false
      });
      continue;
    }

    const skill = candidate.value.skill;
    if (remainingSkillCharacters <= 0) {
      discarded.push({
        id: skill.id,
        kind: 'skill',
        uri: skill.skillUri,
        reason: 'budget_exhausted'
      });
      anyTruncated = true;
      continue;
    }
    const projected = truncateSkillContent(skill.content, remainingSkillCharacters);
    if (!projected.content) {
      discarded.push({
        id: skill.id,
        kind: 'skill',
        uri: skill.skillUri,
        reason: 'budget_exhausted'
      });
      anyTruncated = true;
      continue;
    }
    const activatedSkill = projected.truncated ? { ...skill, content: projected.content } : skill;
    skills.push(activatedSkill);
    remainingSkillCharacters = Math.max(0, remainingSkillCharacters - projected.countedCharacters);
    anyTruncated ||= projected.truncated;
    sources.push({
      id: skill.id,
      kind: 'skill',
      label: skill.name,
      uri: skill.skillUri,
      source: skill.source,
      activation: skill.activation?.source,
      reason: skill.activation?.reason,
      characterCount: projected.content.length,
      tokenEstimate: estimateTokenCount(projected.content),
      contentHash: candidate.contentHash || hashContent(skill.content),
      truncated: projected.truncated,
      scriptsPresent: skill.hasScripts
    });
  }

  const totalCharacterCount = sources.reduce((total, source) => total + source.characterCount, 0);
  const totalTokenEstimate = sources.reduce((total, source) => total + source.tokenEstimate, 0);
  return {
    projectInstructions,
    skills,
    legacyMemory,
    metadata: {
      precedence: [...RUN_CONTEXT_PRECEDENCE],
      beforeDeduplicationCount: deduplication.beforeCount + activationDuplicateCount,
      afterDeduplicationCount: deduplication.afterCount,
      totalCharacterCount,
      totalTokenEstimate,
      truncated: anyTruncated,
      sources,
      discarded,
      possibleConflicts: [
        ...deduplication.possibleConflicts,
        ...(input.skillActivationSkips ?? [])
          .filter((skip) => skip.reason === 'duplicate_skill' && Boolean(skip.keptId))
          .map((skip) => ({
            leftId: skip.keptId as string,
            rightId: skip.id,
            reason: 'Same normalized Skill name was discovered from multiple sources; the higher-priority source was retained.'
          }))
      ]
    }
  };
}

function getSkillPriority(source: SkillActivationSource | undefined): number {
  switch (source) {
    case 'explicit': return 40;
    case 'session': return 45;
    case 'workspace-default': return 50;
    case 'implicit': return 60;
    default: return 60;
  }
}

function toProjectSourceSummary(instruction: ProjectInstructionContext): RunContextSourceSummary {
  return {
    id: instruction.id,
    kind: 'project-instructions',
    label: `${instruction.workspaceFolder}/AGENTS.md`,
    uri: instruction.uri,
    source: 'workspace-root',
    characterCount: instruction.characterCount,
    tokenEstimate: instruction.tokenEstimate,
    contentHash: instruction.contentHash,
    truncated: instruction.truncated
  };
}

function truncateSkillContent(
  content: string,
  remainingCharacters: number
): { content: string; countedCharacters: number; truncated: boolean } {
  const normalized = content.replace(/\r\n?/gu, '\n').trim();
  if (normalized.length <= remainingCharacters) {
    return { content: normalized, countedCharacters: normalized.length, truncated: false };
  }
  const notice = [
    '\n\n[KeepSeek truncated this Skill instruction to fit the activated-Skills budget.]',
    '\n\n[Skill truncated by KeepSeek.]',
    '[truncated]'
  ].find((candidate) => candidate.length <= remainingCharacters) ?? '';
  if (!notice) {
    return { content: '', countedCharacters: 0, truncated: true };
  }
  const kept = Math.max(0, remainingCharacters - notice.length);
  return {
    content: `${normalized.slice(0, kept).trimEnd()}${notice}`,
    countedCharacters: remainingCharacters,
    truncated: true
  };
}

function mapActivationSkips(skips: readonly SkillActivationSkip[] | undefined): RunContextDiscardedSource[] {
  return (skips ?? []).map((skip) => ({
    id: skip.id,
    kind: 'skill' as const,
    uri: skip.skillUri,
    reason: mapActivationSkipReason(skip.reason),
    keptId: skip.keptId
  }));
}

function mapActivationSkipReason(
  reason: SkillActivationSkip['reason']
): RunContextDiscardedSource['reason'] {
  switch (reason) {
    case 'duplicate_uri': return 'duplicate_uri';
    case 'duplicate_skill': return 'duplicate_skill';
    case 'workspace_untrusted': return 'workspace_untrusted';
    case 'disabled': return 'disabled';
    case 'implicit_limit': return 'implicit_limit';
    case 'allow_implicit_false': return 'implicit_not_allowed';
    case 'not_matched': return 'not_matched';
    case 'load_failed': return 'load_failed';
  }
}
