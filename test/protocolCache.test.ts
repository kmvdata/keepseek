import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  buildInitialAgentMessages,
  getAgentTools
} from '../src/agent/protocol';
import type { ContextFile } from '../src/shared/types';

test('dynamic context is kept out of the stable system prompt', () => {
  const first = buildInitialAgentMessages({
    prompt: 'Explain the file.',
    contextFiles: [createContextFile('one.ts', 'export const one = 1;')],
    history: [],
    language: 'en'
  });
  const second = buildInitialAgentMessages({
    prompt: 'Explain the file.',
    contextFiles: [createContextFile('two.ts', 'export const two = 2;')],
    history: [],
    language: 'en'
  });

  assert.equal(first[0]?.role, 'system');
  assert.equal(second[0]?.role, 'system');
  assert.equal(first[0]?.content, second[0]?.content);
  assert.ok(first.at(-1)?.content?.includes('one.ts'));
  assert.ok(second.at(-1)?.content?.includes('two.ts'));
});

test('tool schema order is canonicalized by tool name', () => {
  const left = getAgentTools({
    toolNames: [
      SEARCH_WORKSPACE_TOOL_NAME,
      CREATE_DRAFT_EDIT_TOOL_NAME,
      READ_WORKSPACE_FILE_RANGE_TOOL_NAME
    ]
  });
  const right = getAgentTools({
    toolNames: [
      READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
      SEARCH_WORKSPACE_TOOL_NAME,
      CREATE_DRAFT_EDIT_TOOL_NAME
    ]
  });

  assert.deepEqual(
    left.map((tool) => tool.function.name),
    [
      CREATE_DRAFT_EDIT_TOOL_NAME,
      READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
      SEARCH_WORKSPACE_TOOL_NAME
    ]
  );
  assert.equal(JSON.stringify(left), JSON.stringify(right));
});

function createContextFile(label: string, content: string): ContextFile {
  return {
    id: label,
    uri: `file:///workspace/${label}`,
    label,
    fsPath: `/workspace/${label}`,
    languageId: 'typescript',
    content,
    sizeBytes: content.length,
    source: 'workspace'
  };
}
