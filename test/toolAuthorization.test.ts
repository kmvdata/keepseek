import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import {
  getHighRiskToolConfirmationPrompt,
  getToolAuthorizationMetadata
} from '../src/agent/tools/toolAuthorization';

test('classifies read-only semantic and Git tools as low risk', () => {
  assert.deepEqual(getToolAuthorizationMetadata(FIND_REFERENCES_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'semantic_read'
  });
  assert.deepEqual(getToolAuthorizationMetadata(GIT_DIFF_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'git_read'
  });
  assert.deepEqual(getToolAuthorizationMetadata(CREATE_DRAFT_EDIT_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'draft_edit_prepare'
  });
  assert.deepEqual(getToolAuthorizationMetadata(CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'draft_edit_prepare'
  });
  assert.deepEqual(getToolAuthorizationMetadata(RUN_DRAFT_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'draft_run_prepare'
  });
});

test('separates compile/lint and test authorization scopes per run', () => {
  assert.deepEqual(getToolAuthorizationMetadata(RUN_VALIDATION_TOOL_NAME, { script: 'compile' }), {
    riskLevel: 'medium',
    scope: 'validation_compile_lint'
  });
  assert.deepEqual(getToolAuthorizationMetadata(RUN_VALIDATION_TOOL_NAME, { script: 'lint' }), {
    riskLevel: 'medium',
    scope: 'validation_compile_lint'
  });
  assert.deepEqual(getToolAuthorizationMetadata(RUN_VALIDATION_TOOL_NAME, { script: 'test' }), {
    riskLevel: 'medium',
    scope: 'validation_test'
  });
});

test('delete preparation stays low risk while unknown and Git mutations fail closed', () => {
  assert.deepEqual(getToolAuthorizationMetadata(DELETE_WORKSPACE_FILE_TOOL_NAME), {
    riskLevel: 'low',
    scope: 'workspace_write'
  });
  assert.deepEqual(getToolAuthorizationMetadata('keepseek_git_commit'), {
    riskLevel: 'high',
    scope: 'git_commit'
  });
  assert.deepEqual(getToolAuthorizationMetadata('keepseek_git_push'), {
    riskLevel: 'high',
    scope: 'git_push'
  });
  assert.deepEqual(getToolAuthorizationMetadata('unknown_tool'), {
    riskLevel: 'high',
    scope: 'workspace_write'
  });
});

test('delete confirmation shows its path and reason without claiming an immediate deletion', () => {
  const english = getHighRiskToolConfirmationPrompt(DELETE_WORKSPACE_FILE_TOOL_NAME, {
    path: 'src/obsolete.ts',
    reason: 'No longer used'
  }, 'en');
  const chinese = getHighRiskToolConfirmationPrompt(DELETE_WORKSPACE_FILE_TOOL_NAME, {
    path: 'src/obsolete.ts',
    reason: '已不再使用'
  }, 'zh-CN');

  assert.match(english, /Path: src\/obsolete\.ts/u);
  assert.match(english, /Reason: No longer used/u);
  assert.match(english, /does not delete the file immediately/u);
  assert.match(english, /pending ChangeSet/u);
  assert.match(chinese, /路径：src\/obsolete\.ts/u);
  assert.match(chinese, /原因：已不再使用/u);
  assert.match(chinese, /不会立即删除文件/u);
  assert.match(chinese, /待确认 ChangeSet/u);
});
