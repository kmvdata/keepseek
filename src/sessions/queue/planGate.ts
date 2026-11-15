import type { SessionExecutionMode } from './types';

/**
 * Plan-phase policy.
 *
 * A `plan` session must be genuinely read-only. The previous design relied on a
 * prompt suffix plus a tool blacklist checked at call time: the model still saw
 * every tool and could keep trying, and the guarantee lived in prose.
 *
 * This module owns the policy instead:
 *
 *   - `planToolNames()` is the exact schema a planning session receives, so
 *     write tools are never advertised;
 *   - `isPlanWritableTool()` is the defensive check for a call that arrives
 *     anyway (a replayed round, a stale schema).
 *
 * Keep this list explicit rather than "everything minus writers": a new tool
 * must be classified deliberately.
 */

/** Tools a planning session may use. Anything absent here is not advertised. */
const PLAN_READ_ONLY_TOOLS: readonly string[] = [
  // Workspace inspection.
  'keepseek_list_workspace_files',
  'keepseek_list_workspace_directory',
  'keepseek_search_workspace',
  'keepseek_search_session_archive',
  'keepseek_read_workspace_file',
  'keepseek_read_workspace_file_range',
  'keepseek_read_workspace_diagnostics',
  // Semantic navigation.
  'keepseek_find_symbol',
  'keepseek_find_references',
  'keepseek_get_document_symbols',
  'keepseek_get_workspace_symbols',
  // Read-only Git.
  'keepseek_git_status',
  'keepseek_git_diff',
  'keepseek_git_current_branch',
  'keepseek_git_create_patch',
  'keepseek_git_suggest_commit_message',
  // Evidence and read-only delegation results.
  'keepseek_read_evidence',
  'keepseek_read_subagent_result',
  'keepseek_read_plugin_skill',
  // Fixed compile/lint/test validation reads the workspace; it does not write it.
  'keepseek_run_validation'
];

const PLAN_WRITE_TOOLS: readonly string[] = [
  'keepseek_create_draft_edit',
  'keepseek_create_incremental_draft_edit',
  'keepseek_apply_patch',
  'keepseek_delete_workspace_file',
  'keepseek_run_draft'
];

const planToolSet = new Set(PLAN_READ_ONLY_TOOLS);
const planWriteSet = new Set(PLAN_WRITE_TOOLS);

/** True when `toolName` may be invoked while planning. */
export function isPlanWritableTool(toolName: string): boolean {
  return planToolSet.has(toolName);
}

/** True for tools that would produce a workspace side effect. */
export function isWriteSideEffectTool(toolName: string): boolean {
  return planWriteSet.has(toolName);
}

/**
 * Schema for a planning session.
 *
 * `available` is the full tool list the session would otherwise receive; the
 * result preserves that order so the frozen schema stays deterministic.
 * Delegation tools are retained: a planning session may still research through
 * read-only children.
 */
export function planToolNames(available: readonly string[]): string[] {
  const delegation = new Set(['keepseek_delegate_task', 'keepseek_delegate_parallel', 'keepseek_delegation_checkpoint']);
  return available.filter((name) => planToolSet.has(name) || delegation.has(name));
}

/**
 * The single decision point for "which tools does this mode expose".
 *
 * Callers pass the session's frozen list; `plan` narrows it, `normal` returns it
 * unchanged so existing byte-for-byte schemas are untouched.
 */
export function toolNamesForMode(
  mode: SessionExecutionMode,
  available: readonly string[]
): string[] {
  return mode === 'plan' ? planToolNames(available) : [...available];
}

/** Rejection text for a write tool that arrives during planning. */
export function planWriteRefusal(toolName: string, _language: 'zh-CN' | 'en' = 'zh-CN'): string {
  // One bilingual string keeps the message useful in both UI languages while
  // remaining a stable token for logs and tests.
  return `Tool ${toolName} is unavailable in the planning phase / 规划阶段不可用工具 ${toolName}。`
    + `Produce the implementation plan and wait for the user to execute it. / 请先给出实施计划，等待用户执行。`;
}