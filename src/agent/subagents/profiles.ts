import type { ActivatedSkill } from '../../shared/types';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
} from '../protocol';
import type { SubagentLane, SubagentProfile } from './types';

const READ_TOOLS = [
  LIST_WORKSPACE_FILES_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME
];

const PROPOSAL_TOOLS = [
  ...READ_TOOLS,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME
];

const BUILTIN_PROFILES: SubagentProfile[] = [
  {
    id: 'research',
    label: 'Research',
    description: 'Locate evidence, trace code paths, and return a compact factual report.',
    lane: 'research-read',
    instructions: 'Investigate the assigned question using the narrowest useful read-only tools. Cite concrete files, symbols, and observed behavior. Return conclusions and unresolved uncertainty; do not propose edits unless explicitly asked by the task.',
    toolNames: READ_TOOLS,
    canDelegate: true,
    resultMaxChars: 120_000
  },
  {
    id: 'review',
    label: 'Review',
    description: 'Review a bounded code surface and prioritize verifiable findings.',
    lane: 'review-read',
    instructions: 'Review only the assigned scope. Prioritize correctness, regressions, security, and missing tests. Each finding must include evidence and impact. Do not modify files or prepare drafts.',
    toolNames: READ_TOOLS,
    canDelegate: true,
    resultMaxChars: 120_000
  },
  {
    id: 'proposal',
    label: 'Proposal',
    description: 'Prepare isolated DraftEdit or DraftRun proposals without applying or executing them.',
    lane: 'proposal',
    instructions: 'Prepare the smallest coherent pending DraftEdits or DraftRuns needed by the task. Never apply a change, approve a command, execute an arbitrary command, or claim that a proposal changed the workspace. Avoid touching paths outside the declared scope.',
    toolNames: PROPOSAL_TOOLS,
    canDelegate: false,
    resultMaxChars: 120_000
  }
];

export function resolveSubagentProfile(input: {
  requestedId?: string;
  requestedLane?: SubagentLane;
  skills?: readonly ActivatedSkill[];
}): SubagentProfile | undefined {
  const requestedId = input.requestedId?.trim() || defaultProfileIdForLane(input.requestedLane);
  const custom = (input.skills ?? []).find((skill) => (
    skill.runAs === 'subagent'
    && (skill.subagentProfile?.id === requestedId || skill.name === requestedId)
  ));
  if (custom?.subagentProfile) {
    const requestedTools = custom.subagentProfile.tools?.length
      ? custom.subagentProfile.tools
      : READ_TOOLS;
    const allowed = new Set(custom.subagentProfile.canDelegate ? PROPOSAL_TOOLS : PROPOSAL_TOOLS);
    return {
      id: custom.subagentProfile.id,
      label: custom.name,
      description: custom.description ?? '',
      lane: inferCustomLane(requestedTools),
      instructions: custom.content,
      toolNames: requestedTools.filter((name) => allowed.has(name)),
      maxSteps: custom.subagentProfile.maxSteps,
      timeoutMs: custom.subagentProfile.timeoutMs,
      canDelegate: custom.subagentProfile.canDelegate === true,
      resultMaxChars: custom.subagentProfile.resultMaxChars ?? 120_000,
      sourceSkillId: custom.id
    };
  }
  const builtin = BUILTIN_PROFILES.find((profile) => profile.id === requestedId);
  if (!builtin) {
    return undefined;
  }
  return {
    ...builtin,
    toolNames: [...builtin.toolNames],
    lane: builtin.lane
  };
}

export function getSubagentProfileCatalog(skills?: readonly ActivatedSkill[]): Array<Pick<SubagentProfile, 'id' | 'label' | 'description' | 'lane'>> {
  const profiles = BUILTIN_PROFILES.map(({ id, label, description, lane }) => ({ id, label, description, lane }));
  for (const skill of skills ?? []) {
    if (skill.runAs !== 'subagent' || !skill.subagentProfile) {
      continue;
    }
    profiles.push({
      id: skill.subagentProfile.id,
      label: skill.name,
      description: skill.description ?? '',
      lane: inferCustomLane(skill.subagentProfile.tools ?? READ_TOOLS)
    });
  }
  return profiles;
}

export function getBuiltInReadToolNames(): string[] {
  return [...READ_TOOLS];
}

function defaultProfileIdForLane(lane: SubagentLane | undefined): string {
  return lane === 'proposal' ? 'proposal' : lane === 'review-read' ? 'review' : 'research';
}

function inferCustomLane(toolNames: readonly string[]): SubagentLane {
  return toolNames.some((name) => (
    name === CREATE_DRAFT_EDIT_TOOL_NAME
    || name === CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME
    || name === DELETE_WORKSPACE_FILE_TOOL_NAME
    || name === RUN_DRAFT_TOOL_NAME
  )) ? 'proposal' : 'research-read';
}
