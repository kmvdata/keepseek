import * as vscode from 'vscode';
import { getConfiguredValidationAuthorizationPolicy } from '../../shared/config';
import type { KeepseekLanguage } from '../../shared/i18n';
import type {
  AuthorizedToolScope,
  RunAuthorizationPolicy,
  ToolAuthorizationDecision,
  ToolRiskLevel
} from '../../shared/types';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
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
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
} from '../protocol';

export interface ToolAuthorizationMetadata {
  riskLevel: ToolRiskLevel;
  scope: AuthorizedToolScope;
}

export interface ToolAuthorizationAdapter {
  createRunPolicy(runId: string): RunAuthorizationPolicy;
  authorize(input: {
    toolName: string;
    args: Record<string, unknown>;
    language: KeepseekLanguage;
    policy: RunAuthorizationPolicy;
  }): Promise<ToolAuthorizationDecision>;
}

const LOW_RISK_TOOLS = new Map<string, AuthorizedToolScope>([
  [LIST_WORKSPACE_FILES_TOOL_NAME, 'workspace_read'],
  [LIST_WORKSPACE_DIRECTORY_TOOL_NAME, 'workspace_read'],
  [SEARCH_WORKSPACE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_FILE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_FILE_RANGE_TOOL_NAME, 'workspace_read'],
  [READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, 'diagnostics_read'],
  [FIND_SYMBOL_TOOL_NAME, 'semantic_read'],
  [FIND_REFERENCES_TOOL_NAME, 'semantic_read'],
  [GET_DOCUMENT_SYMBOLS_TOOL_NAME, 'semantic_read'],
  [GET_WORKSPACE_SYMBOLS_TOOL_NAME, 'semantic_read'],
  [CREATE_DRAFT_EDIT_TOOL_NAME, 'draft_edit_prepare'],
  [GIT_STATUS_TOOL_NAME, 'git_read'],
  [GIT_DIFF_TOOL_NAME, 'git_read'],
  [GIT_CURRENT_BRANCH_TOOL_NAME, 'git_read'],
  [GIT_CREATE_PATCH_TOOL_NAME, 'git_patch_create'],
  [GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME, 'git_read']
]);

const HIGH_RISK_TOOLS = new Map<string, AuthorizedToolScope>([
  ['keepseek_apply_workspace_edit', 'workspace_write'],
  ['keepseek_delete_workspace_file', 'workspace_write'],
  ['keepseek_git_commit', 'git_commit'],
  ['keepseek_git_push', 'git_push']
]);

export class ToolAuthorizationService implements ToolAuthorizationAdapter {
  public createRunPolicy(runId: string): RunAuthorizationPolicy {
    return {
      runId,
      mediumRiskPolicy: getConfiguredValidationAuthorizationPolicy(),
      authorizedScopes: [],
      deniedScopes: []
    };
  }

  public async authorize(input: {
    toolName: string;
    args: Record<string, unknown>;
    language: KeepseekLanguage;
    policy: RunAuthorizationPolicy;
  }): Promise<ToolAuthorizationDecision> {
    const metadata = getToolAuthorizationMetadata(input.toolName, input.args);
    if (metadata.riskLevel === 'low') {
      return createDecision(input.toolName, metadata, true, 'low_risk', false);
    }

    if (metadata.riskLevel === 'high') {
      return await this.confirmHighRiskTool(input.toolName, metadata, input.language);
    }

    if (input.policy.authorizedScopes.includes(metadata.scope)) {
      return createDecision(input.toolName, metadata, true, 'run_policy', false);
    }
    if (input.policy.deniedScopes.includes(metadata.scope) || input.policy.mediumRiskPolicy === 'never') {
      return createDecision(
        input.toolName,
        metadata,
        false,
        'user_denied',
        false,
        input.language === 'en'
          ? 'This medium-risk tool is not authorized for the current Agent run.'
          : '当前 Agent 运行未授权此中风险工具。'
      );
    }
    if (input.policy.mediumRiskPolicy === 'always') {
      input.policy.authorizedScopes.push(metadata.scope);
      return createDecision(input.toolName, metadata, true, 'configuration', false);
    }

    const allowRun = input.language === 'en' ? 'Allow for this run' : '本轮允许';
    const denyRun = input.language === 'en' ? 'Deny for this run' : '本轮拒绝';
    const selected = await vscode.window.showInformationMessage(
      getMediumRiskPrompt(input.toolName, metadata.scope, input.args, input.language),
      { modal: true },
      allowRun,
      denyRun
    );
    if (selected === allowRun) {
      input.policy.authorizedScopes.push(metadata.scope);
      return createDecision(input.toolName, metadata, true, 'explicit_confirmation', false);
    }

    input.policy.deniedScopes.push(metadata.scope);
    return createDecision(
      input.toolName,
      metadata,
      false,
      'user_denied',
      false,
      input.language === 'en'
        ? 'The user denied this tool scope for the current Agent run.'
        : '用户已拒绝在当前 Agent 运行中授权此工具范围。'
    );
  }

  private async confirmHighRiskTool(
    toolName: string,
    metadata: ToolAuthorizationMetadata,
    language: KeepseekLanguage
  ): Promise<ToolAuthorizationDecision> {
    const confirm = language === 'en' ? 'Confirm once' : '仅确认本次';
    const selected = await vscode.window.showWarningMessage(
      language === 'en'
        ? `KeepSeek requests a high-risk operation (${toolName}). Confirm this single operation?`
        : `KeepSeek 请求执行高风险操作（${toolName}）。是否仅确认本次操作？`,
      { modal: true },
      confirm
    );
    const allowed = selected === confirm;
    return createDecision(
      toolName,
      metadata,
      allowed,
      allowed ? 'explicit_confirmation' : 'user_denied',
      true,
      allowed
        ? undefined
        : language === 'en'
          ? 'High-risk operations require a separate explicit confirmation every time.'
          : '高风险操作每次都需要单独显式确认。'
    );
  }
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

  // Unknown tools fail closed at the highest risk level.
  return { riskLevel: 'high', scope: 'workspace_write' };
}

export function createAuthorizationDeniedToolResult(decision: ToolAuthorizationDecision): string {
  return JSON.stringify({
    ok: false,
    errorType: 'authorization_denied',
    authorization: decision,
    error: decision.reason ?? 'Tool authorization was denied.'
  });
}

function createDecision(
  toolName: string,
  metadata: ToolAuthorizationMetadata,
  allowed: boolean,
  source: ToolAuthorizationDecision['source'],
  requiresExplicitConfirmation: boolean,
  reason?: string
): ToolAuthorizationDecision {
  return {
    allowed,
    toolName,
    riskLevel: metadata.riskLevel,
    scope: metadata.scope,
    source,
    requiresExplicitConfirmation,
    reason
  };
}

function getMediumRiskPrompt(
  toolName: string,
  scope: AuthorizedToolScope,
  args: Record<string, unknown>,
  language: KeepseekLanguage
): string {
  const script = typeof args.script === 'string' ? args.script : toolName;
  if (language === 'en') {
    return scope === 'validation_test'
      ? `Allow KeepSeek to run the controlled test task for this Agent run (${script})?`
      : `Allow KeepSeek to run controlled compile/lint tasks for this Agent run (${script})?`;
  }
  return scope === 'validation_test'
    ? `允许 KeepSeek 在本轮 Agent 运行中执行受控测试任务（${script}）吗？`
    : `允许 KeepSeek 在本轮 Agent 运行中执行受控 compile/lint 任务（${script}）吗？`;
}
