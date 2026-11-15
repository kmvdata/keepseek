import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isPlanWritableTool,
  isWriteSideEffectTool,
  planToolNames,
  planWriteRefusal,
  toolNamesForMode
} from '../src/sessions/queue/planGate';

/**
 * A planning session must be read-only by construction, not by prompt.
 *
 * These tests pin the policy so a future tool addition cannot silently widen the
 * planning surface.
 */

const ALL_TOOLS = [
  'keepseek_list_workspace_files',
  'keepseek_list_workspace_directory',
  'keepseek_search_workspace',
  'keepseek_search_session_archive',
  'keepseek_read_workspace_file',
  'keepseek_read_workspace_file_range',
  'keepseek_read_workspace_diagnostics',
  'keepseek_find_symbol',
  'keepseek_find_references',
  'keepseek_get_document_symbols',
  'keepseek_get_workspace_symbols',
  'keepseek_git_status',
  'keepseek_git_diff',
  'keepseek_git_current_branch',
  'keepseek_git_create_patch',
  'keepseek_git_suggest_commit_message',
  'keepseek_read_evidence',
  'keepseek_read_subagent_result',
  'keepseek_read_plugin_skill',
  'keepseek_delegate_task',
  'keepseek_delegate_parallel',
  'keepseek_delegation_checkpoint',
  // write-side
  'keepseek_create_draft_edit',
  'keepseek_create_incremental_draft_edit',
  'keepseek_apply_patch',
  'keepseek_delete_workspace_file',
  'keepseek_run_draft',
  'keepseek_run_validation'
];

test('a planning session is never offered a write tool', () => {
  const names = toolNamesForMode('plan', ALL_TOOLS);
  for (const writeTool of [
    'keepseek_create_draft_edit',
    'keepseek_create_incremental_draft_edit',
    'keepseek_apply_patch',
    'keepseek_delete_workspace_file',
    'keepseek_run_draft'
  ]) {
    assert.equal(names.includes(writeTool), false, `${writeTool} must not be advertised while planning`);
  }
});

test('a planning session keeps every read and delegation tool', () => {
  const names = new Set(toolNamesForMode('plan', ALL_TOOLS));
  for (const name of ALL_TOOLS.filter((tool) => !isWriteSideEffectTool(tool))) {
    assert.equal(names.has(name), true, `${name} must stay available while planning`);
  }
});

test('normal mode returns the frozen list unchanged, preserving order and bytes', () => {
  assert.deepEqual(toolNamesForMode('normal', ALL_TOOLS), ALL_TOOLS);
});

test('write side-effect classification matches the planning policy', () => {
  for (const name of ALL_TOOLS) {
    assert.equal(isWriteSideEffectTool(name), !isPlanWritableTool(name) && !name.startsWith('keepseek_delegate') && !name.startsWith('keepseek_delegation'),
      `classification disagrees for ${name}`);
  }
});

test('planToolNames filters an unknown future tool out rather than admitting it', () => {
  const withUnknown = [...ALL_TOOLS, 'keepseek_future_mutating_tool'];
  const names = planToolNames(withUnknown);
  assert.equal(names.includes('keepseek_future_mutating_tool'), false);
});

test('the refusal text names the tool and keeps both languages', () => {
  const en = planWriteRefusal('keepseek_apply_patch', 'en');
  const zh = planWriteRefusal('keepseek_apply_patch', 'zh-CN');
  assert.match(en, /keepseek_apply_patch/u);
  assert.match(en, /planning/u);
  assert.match(zh, /keepseek_apply_patch/u);
  assert.match(zh, /规划/u);
});