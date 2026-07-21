import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import { getToolAuthorizationMetadata } from '../src/agent/tools/toolAuthorization';

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

test('unknown and high-risk Git mutation tools fail closed', () => {
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
