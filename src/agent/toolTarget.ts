import { localize, type KeepseekLanguage } from '../shared/i18n';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  DELEGATE_PARALLEL_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_SESSION_ARCHIVE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
} from './protocol';

/** The activity detail is a display suffix, never provider input. */
const MAX_TARGET_CHARS = 60;
const MAX_COMMAND_ARG_ITEMS = 3;
const MAX_COMMAND_ARG_CHARS = 40;

/**
 * Tools whose only meaningful target is the `path` argument.
 * This is a closed whitelist: an argument that is not listed here is never
 * promoted to the status bar, whatever the model put in it.
 */
const PATH_TARGET_TOOLS = new Set([
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME
]);

/** Tools whose primary target is what was searched for, optionally scoped. */
const QUERY_TARGET_TOOLS = new Set([
  SEARCH_WORKSPACE_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  SEARCH_SESSION_ARCHIVE_TOOL_NAME
]);

/** Git readers keep only a path/ref when the model actually passed one. */
const GIT_TARGET_TOOLS = new Set([
  GIT_STATUS_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME
]);

/**
 * One short, human-readable "what is this operating on" suffix for the status
 * bar and the activity nodes, for example `discord_message.py` or
 * `test` (validation) or `psql -c "EXPLAIN ..."` (command proposal).
 *
 * Returns `undefined` rather than a meaningless string: a bare tool name in the
 * status bar reads worse than no detail at all.
 */
export function describeToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  language: KeepseekLanguage
): string | undefined {
  if (!toolName) return undefined;
  const safeArgs = args ?? {};

  if (PATH_TARGET_TOOLS.has(toolName)) {
    return compactTarget(readTargetString(safeArgs, 'path'));
  }

  if (QUERY_TARGET_TOOLS.has(toolName)) {
    const query = readTargetString(safeArgs, 'query');
    if (!query) return undefined;
    const scope = readTargetString(safeArgs, 'path');
    return compactTarget(scope ? `${query} ${localize(language, 'toolTargetSearchIn', { path: scope })}` : query);
  }

  if (GIT_TARGET_TOOLS.has(toolName)) {
    return compactTarget(readTargetString(safeArgs, 'path') ?? readTargetString(safeArgs, 'ref'));
  }

  if (toolName === RUN_VALIDATION_TOOL_NAME) {
    return compactTarget(readTargetString(safeArgs, 'script'));
  }

  if (toolName === RUN_DRAFT_TOOL_NAME) {
    const executable = readTargetString(safeArgs, 'executable');
    const argv = describeCommandArguments(safeArgs.args);
    return compactTarget([executable, ...argv].filter(Boolean).join(' '));
  }

  if (toolName === DELEGATE_TASK_TOOL_NAME) {
    // Never surface the child prompt; a role/profile name is all the user needs.
    return compactTarget(readRoleName(safeArgs));
  }

  if (toolName === DELEGATE_PARALLEL_TOOL_NAME) {
    const tasks = Array.isArray(safeArgs.tasks) ? safeArgs.tasks : [];
    for (const task of tasks) {
      const role = readRoleName(task);
      if (role) return compactTarget(role);
    }
    return undefined;
  }

  if (toolName === READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME || toolName === LIST_WORKSPACE_FILES_TOOL_NAME) {
    // No path argument exists; there is nothing honest to show.
    return undefined;
  }

  return undefined;
}

function readTargetString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args?.[key];
  if (typeof value !== 'string') return undefined;
  const compacted = value.replace(/\s+/gu, ' ').trim();
  return compacted ? compacted : undefined;
}

function readRoleName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const role = typeof record.profile === 'string'
    ? record.profile
    : typeof record.lane === 'string' ? record.lane : undefined;
  if (!role) return undefined;
  // Profile ids are short identifiers; anything else is model-authored text.
  return /^[A-Za-z0-9._:-]{1,40}$/u.test(role) ? role : undefined;
}

function describeCommandArguments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value.slice(0, MAX_COMMAND_ARG_ITEMS)) {
    if (typeof entry !== 'string') continue;
    const compacted = entry.replace(/\s+/gu, ' ').trim();
    if (!compacted) continue;
    items.push(compacted.length <= MAX_COMMAND_ARG_CHARS
      ? compacted
      : `${compacted.slice(0, MAX_COMMAND_ARG_CHARS - 1).trimEnd()}…`);
  }
  return items;
}

function compactTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compacted = value.replace(/\s+/gu, ' ').trim();
  if (!compacted) return undefined;
  return compacted.length <= MAX_TARGET_CHARS
    ? compacted
    : `${compacted.slice(0, MAX_TARGET_CHARS - 1).trimEnd()}…`;
}