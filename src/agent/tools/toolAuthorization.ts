import type { KeepseekLanguage } from '../../shared/i18n';
import type { AuthorizedToolScope, ToolAuthorizationDecision, ToolRiskLevel } from '../../shared/types';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELEGATE_PARALLEL_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  DELEGATION_CHECKPOINT_TOOL_NAME,
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
  READ_EVIDENCE_TOOL_NAME,
  READ_PLUGIN_SKILL_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_SUBAGENT_RESULT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  SEARCH_SESSION_ARCHIVE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
} from '../protocol';

export interface ToolAuthorizationMetadata {
  riskLevel: ToolRiskLevel;
  scope: AuthorizedToolScope;
}

const LOW_RISK_TOOLS = new Map<string, AuthorizedToolScope>([
  [DELEGATION_CHECKPOINT_TOOL_NAME, 'subagent_delegate'],
  [DELEGATE_TASK_TOOL_NAME, 'subagent_delegate'],
  [DELEGATE_PARALLEL_TOOL_NAME, 'subagent_delegate'],
  [READ_SUBAGENT_RESULT_TOOL_NAME, 'subagent_delegate'],
  // Evidence snapshots are immutable, task-scoped reads. Keep them in the
  // same low-risk class as other local read-only retrieval tools so a v8
  // schema can execute the infrastructure tool it exposes.
  [READ_EVIDENCE_TOOL_NAME, 'workspace_read'],
  [READ_PLUGIN_SKILL_TOOL_NAME, 'workspace_read'],
  [LIST_WORKSPACE_FILES_TOOL_NAME, 'workspace_read'],
  [LIST_WORKSPACE_DIRECTORY_TOOL_NAME, 'workspace_read'],
  [SEARCH_WORKSPACE_TOOL_NAME, 'workspace_read'],
  // keepseek_search_session_archive 是本地只读的会话归档检索（词法/BM25、无模型调用），与 search_workspace 同级对待，归为低风险，避免被当作未知工具每次都弹高风险授权窗。
  [SEARCH_SESSION_ARCHIVE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_FILE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_FILE_RANGE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, 'diagnostics_read'],
  [FIND_SYMBOL_TOOL_NAME, 'semantic_read'],
  [FIND_REFERENCES_TOOL_NAME, 'semantic_read'],
  [GET_DOCUMENT_SYMBOLS_TOOL_NAME, 'semantic_read'],
  [GET_WORKSPACE_SYMBOLS_TOOL_NAME, 'semantic_read'],
  [CREATE_DRAFT_EDIT_TOOL_NAME, 'draft_edit_prepare'],
  [CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME, 'draft_edit_prepare'],
  [APPLY_PATCH_TOOL_NAME, 'draft_edit_prepare'],
  [RUN_DRAFT_TOOL_NAME, 'draft_run_prepare'],
  [GIT_STATUS_TOOL_NAME, 'git_read'],
  [GIT_DIFF_TOOL_NAME, 'git_read'],
  [GIT_CURRENT_BRANCH_TOOL_NAME, 'git_read'],
  [GIT_CREATE_PATCH_TOOL_NAME, 'git_patch_create'],
  [GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME, 'git_read'],
  // 方案A：delete_workspace_file 只创建待确认的 delete DraftEdit，不会立即删除文件。真正的删除由 Apply 时确认：ask 模式下经 confirmDeleteApply 逐次确认，approve-all 模式与其他副作用一样不再额外询问，因此准备阶段不弹授权窗，降为低风险。
  [DELETE_WORKSPACE_FILE_TOOL_NAME, 'workspace_write']
]);

const HIGH_RISK_TOOLS = new Map<string, AuthorizedToolScope>([
  ['keepseek_apply_workspace_edit', 'workspace_write'],
  ['keepseek_git_commit', 'git_commit'],
  ['keepseek_git_push', 'git_push']
]);

export function getHighRiskToolConfirmationPrompt(
  toolName: string,
  args: Record<string, unknown>,
  language: KeepseekLanguage
): string {
  if (toolName === DELETE_WORKSPACE_FILE_TOOL_NAME) {
    const targetPath = formatHighRiskArgument(args.path, language === 'en' ? '(path unavailable)' : '（路径不可用）');
    const reason = formatHighRiskArgument(args.reason, language === 'en' ? '(reason unavailable)' : '（原因不可用）');
    return language === 'en'
      ? [
          'KeepSeek requests confirmation to prepare one pending file deletion.',
          `Path: ${targetPath}`,
          `Reason: ${reason}`,
          'This only prepares a delete DraftEdit and does not delete the file immediately. The file will be deleted only if you later review and apply the pending ChangeSet. Confirm this single preparation request?'
        ].join('\n')
      : [
          'KeepSeek 请求确认准备一个待确认文件删除。',
          `路径：${targetPath}`,
          `原因：${reason}`,
          '这只会准备 delete DraftEdit，不会立即删除文件。只有你之后审核并应用待确认 ChangeSet，文件才会真正删除。是否仅确认本次准备请求？'
        ].join('\n');
  }

  return language === 'en'
    ? `KeepSeek requests a high-risk operation (${toolName}). Confirm this single operation?`
    : `KeepSeek 请求执行高风险操作（${toolName}）。是否仅确认本次操作？`;
}

export function getToolAuthorizationMetadata(
  toolName: string,
  args: Record<string, unknown> = {}
): ToolAuthorizationMetadata {
  const lowRiskScope = LOW_RISK_TOOLS.get(toolName);
  if (lowRiskScope) {
    return { riskLevel: 'low', scope: lowRiskScope };
  }
  if (toolName === RUN_VALIDATION_TOOL_NAME) {
    return {
      riskLevel: 'medium',
      scope: args.script === 'test' ? 'validation_test' : 'validation_compile_lint'
    };
  }
  const highRiskScope = HIGH_RISK_TOOLS.get(toolName);
  if (highRiskScope) {
    return { riskLevel: 'high', scope: highRiskScope };
  }

  // Unknown tools fail closed at the highest risk level. authorize() denies them silently
  // (no confirmation dialog) because an unregistered tool name cannot be routed to any handler.
  return { riskLevel: 'high', scope: 'workspace_write' };
}

export function createAuthorizationDeniedToolResult(decision: ToolAuthorizationDecision): string {
  return JSON.stringify({
    ok: false,
    errorType: decision.failureCode ?? 'authorization_denied',
    authorization: decision,
    error: decision.reason ?? 'Tool authorization was denied.'
  });
}

function formatHighRiskArgument(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized) {
    return fallback;
  }
  return normalized.length <= 320 ? normalized : `${normalized.slice(0, 319).trimEnd()}…`;
}
