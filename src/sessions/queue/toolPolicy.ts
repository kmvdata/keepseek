/**
 * Write-tool classification.
 *
 * Every tool listed here produces a workspace side effect, so it needs the
 * project write lease. Draft *preparation* tools are included on purpose: they
 * do not write, but they are the only path that can later produce a change, and
 * keeping the two sets identical means a new effect-bearing tool cannot be
 * added without being classified here.
 *
 * The classification is explicit rather than "everything minus readers": a new
 * tool must be classified deliberately.
 */

/** Tools that never touch the workspace. */
const READ_ONLY_TOOLS: readonly string[] = [
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
  'keepseek_read_plugin_skill'
];

/** Tools that produce a workspace side effect and therefore need the lease. */
const WRITE_TOOLS: readonly string[] = [
  'keepseek_create_draft_edit',
  'keepseek_create_incremental_draft_edit',
  'keepseek_apply_patch',
  'keepseek_delete_workspace_file',
  'keepseek_run_draft',
  // Fixed compile/lint/test writes build output, so it is a side effect too.
  'keepseek_run_validation'
];

const readOnlySet = new Set(READ_ONLY_TOOLS);
const writeSet = new Set(WRITE_TOOLS);

/** True when `toolName` is a known read-only tool. */
export function isReadOnlyTool(toolName: string): boolean {
  return readOnlySet.has(toolName);
}

/**
 * True for tools that produce a workspace side effect.
 *
 * Unknown tools report `false`: classification is for diagnostics and UI copy,
 * never the enforcement point. Enforcement is `writeGate`, which every side
 * effect path already consults.
 */
export function isWriteSideEffectTool(toolName: string): boolean {
  return writeSet.has(toolName);
}