import type { ActivatedSkill, AgentRequest, ChatMessage } from '../shared/types';
import { BUILTIN_GEN_PROMPT_ID, isBuiltinGenPrompt } from '../skills/skillTypes';
import type { RunCheckpoint } from './runCheckpoint';

/** Explicit allowlist: new tools require review before a generated prompt may use them. */
const inspectionTools = new Set([
  'keepseek_list_workspace_files', 'keepseek_list_workspace_directory', 'keepseek_search_workspace',
  'keepseek_read_workspace_file', 'keepseek_read_workspace_file_range', 'keepseek_read_workspace_diagnostics',
  'keepseek_find_symbol', 'keepseek_find_references', 'keepseek_get_document_symbols', 'keepseek_get_workspace_symbols',
  'keepseek_git_status', 'keepseek_git_diff', 'keepseek_git_current_branch', 'keepseek_read_evidence'
]);

export function isPromptInspectionTool(name: string): boolean {
  return inspectionTools.has(name);
}

/**
 * The dominant built-in prompt Skill of this turn. Every activation source counts:
 * a selected, session-enabled or workspace-default gen-prompt all make the turn a
 * read-only prompt-generation turn whose output contract nothing else may change.
 */
export function dominantPromptSkill(skills?: readonly ActivatedSkill[]): ActivatedSkill | undefined {
  return skills?.find(skill => isBuiltinGenPrompt(skill));
}

/**
 * True when this submission asks for prompt generation through any source the user
 * configured: the request itself, the session's enabled Skills, or workspace defaults.
 * It is evaluated before Skill resolution so tool exposure can fail closed first.
 */
export function dominantPromptRequested(input: {
  explicitSkillIds?: readonly string[];
  sessionSkillIds?: readonly string[];
  workspaceDefaultSkillIds?: readonly string[];
}): boolean {
  return [input.explicitSkillIds, input.sessionSkillIds, input.workspaceDefaultSkillIds]
    .some(ids => ids?.includes(BUILTIN_GEN_PROMPT_ID) === true);
}

/** The persisted receipt is written only after the selected bundled body loaded successfully. */
export function lastUserSelectedPrompt(messages: readonly ChatMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].usedSkills?.some(isBuiltinGenPrompt) === true;
  }
  return false;
}

export function promptIntentMatches(request: Pick<AgentRequest, 'turnIntent' | 'currentRunContext' | 'history'>): boolean {
  const promptOnly = request.turnIntent === 'generate_prompt';
  return (request.turnIntent === undefined || promptOnly)
    && promptOnly === Boolean(dominantPromptSkill(request.currentRunContext?.skills))
    && promptOnly === lastUserSelectedPrompt(request.history);
}

export function validPromptCheckpoint(cp: RunCheckpoint): boolean {
  if (!promptIntentMatches(cp.request)) return false;
  if (!cp.request.turnIntent) return true;
  const executing = cp.state?.pending?.executing;
  return !cp.request.authorizedExternalReferenceUris?.length
    && (!executing || isPromptInspectionTool(executing.name))
    && !cp.state?.draftEdits.length && !cp.state?.draftRuns.length && !cp.state?.validationRunCount
    && !cp.finalResponse?.changeSet && !cp.finalResponse?.draftEdits.length && !cp.finalResponse?.draftRuns?.length
    && !cp.state?.provider?.tools.some(tool => !isPromptInspectionTool(tool.name));
}
