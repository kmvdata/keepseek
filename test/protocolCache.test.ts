import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
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

test('project instructions and Skills do not mutate the stable system prefix', () => {
  const withoutDynamicContext = buildInitialAgentMessages({
    prompt: 'Inspect.',
    contextFiles: [],
    history: [],
    language: 'en'
  });
  const withDynamicContext = buildInitialAgentMessages({
    prompt: 'Inspect.',
    contextFiles: [],
    history: [],
    language: 'en',
    currentRunContext: {
      projectInstructions: [{
        id: 'root',
        uri: 'file:///workspace/AGENTS.md',
        workspaceFolder: 'workspace',
        content: 'Project rule.',
        characterCount: 13,
        tokenEstimate: 4,
        contentHash: 'hash-project',
        truncated: false
      }],
      skills: [{
        id: 'review',
        name: 'review',
        source: 'agentsWorkspace',
        rootUri: 'file:///workspace/.agents/skills/review',
        skillUri: 'file:///workspace/.agents/skills/review/SKILL.md',
        content: 'Review workflow.',
        activation: { source: 'explicit', reason: 'Selected.' }
      }],
      metadata: {
        precedence: [],
        beforeDeduplicationCount: 2,
        afterDeduplicationCount: 2,
        totalCharacterCount: 29,
        totalTokenEstimate: 8,
        truncated: false,
        sources: [],
        discarded: [],
        possibleConflicts: []
      }
    }
  });

  assert.equal(withDynamicContext[0]?.content, withoutDynamicContext[0]?.content);
  assert.match(withDynamicContext.at(-1)?.content ?? '', /Project rule[\s\S]*Review workflow/u);
});

test('Legacy Project Memory stays in lowest-priority current-run context below the explicit user request', () => {
  const messages = buildInitialAgentMessages({
    prompt: 'For this run, use pnpm instead.',
    contextFiles: [],
    history: [],
    language: 'en',
    currentRunContext: {
      projectInstructions: [],
      skills: [],
      legacyMemory: {
        content: '- [command] Always use npm.',
        entryIds: ['memory-1'],
        tokenEstimate: 8,
        sourceUris: ['file:///workspace/.keepseek/memory.json']
      },
      metadata: {
        precedence: [],
        beforeDeduplicationCount: 1,
        afterDeduplicationCount: 1,
        totalCharacterCount: 27,
        totalTokenEstimate: 8,
        truncated: false,
        sources: [],
        discarded: [],
        possibleConflicts: []
      }
    }
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[1]?.role, 'user');
  assert.ok(messages[1]?.content?.includes('lowest-priority migration compatibility'));
  assert.ok(messages[1]?.content?.endsWith('For this run, use pnpm instead.'));
});

test('validation tool exposes only the fixed safe npm scripts', () => {
  const tool = getAgentTools({ toolNames: [RUN_VALIDATION_TOOL_NAME] })[0];
  const properties = tool.function.parameters.properties as Record<string, { enum?: string[] }>;

  assert.equal(tool.function.name, RUN_VALIDATION_TOOL_NAME);
  assert.deepEqual(properties.script?.enum, ['compile', 'lint', 'test']);
  assert.equal(properties.command, undefined);
});

test('semantic tools expose structured provider inputs', () => {
  const tools = getAgentTools({
    toolNames: [
      FIND_SYMBOL_TOOL_NAME,
      FIND_REFERENCES_TOOL_NAME,
      GET_DOCUMENT_SYMBOLS_TOOL_NAME,
      GET_WORKSPACE_SYMBOLS_TOOL_NAME
    ]
  });
  assert.deepEqual(tools.map((tool) => tool.function.name), [
    FIND_REFERENCES_TOOL_NAME,
    FIND_SYMBOL_TOOL_NAME,
    GET_DOCUMENT_SYMBOLS_TOOL_NAME,
    GET_WORKSPACE_SYMBOLS_TOOL_NAME
  ]);
  const references = tools.find((tool) => tool.function.name === FIND_REFERENCES_TOOL_NAME);
  assert.deepEqual(references?.function.parameters.required, ['column', 'line', 'path']);
});

test('patch tool does not expose a target path or write option', () => {
  const tool = getAgentTools({ toolNames: [GIT_CREATE_PATCH_TOOL_NAME] })[0];
  const properties = tool.function.parameters.properties as Record<string, unknown>;
  assert.equal(properties.outputPath, undefined);
  assert.equal(properties.apply, undefined);
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
