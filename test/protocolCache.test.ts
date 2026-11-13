import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  SEARCH_SESSION_ARCHIVE_TOOL_NAME,
  buildInitialAgentMessages,
  formatActiveSkills,
  formatCurrentRunContextForAgent,
  getAgentSystemPrompt,
  getAgentToolNamesForPrompt,
  getAgentTools,
  isDraftEditPreparationTool,
  isDraftRunPreparationTool
} from '../src/agent/protocol';
import type { ContextFile, CurrentRunContext } from '../src/shared/types';

test('fresh sessions expose the current command plan, evidence and delegation contract with one static prefix', () => {
  const tools = getAgentTools();
  const names = tools.map(tool => tool.function.name);
  for (const required of [APPLY_PATCH_TOOL_NAME, READ_EVIDENCE_TOOL_NAME, RUN_DRAFT_TOOL_NAME,
    'keepseek_delegation_checkpoint', 'keepseek_read_subagent_result']) {
    assert.ok(names.includes(required), required);
  }
  assert.ok(!names.includes('keepseek_read_plugin_skill'));
  const command = tools.find(tool => tool.function.name === RUN_DRAFT_TOOL_NAME)!;
  const properties = command.function.parameters.properties as Record<string, unknown>;
  assert.ok(properties.prerequisites);
  assert.ok(properties.replacesDraftRun);
  const reader = tools.find(tool => tool.function.name === 'keepseek_read_subagent_result')!;
  assert.deepEqual(reader.function.parameters.required, ['ref']);
  assert.equal((reader.function.parameters.properties as Record<string, unknown>).subagentId, undefined);
  assert.equal((reader.function.parameters.properties as Record<string, unknown>).maxChars, undefined);
  for (const language of ['en', 'zh-CN'] as const) {
    const prompt = getAgentSystemPrompt({ language });
    assert.equal(prompt, getAgentSystemPrompt({ language, requestProtocolVersion: 15 }));
    assert.doesNotMatch(prompt, /model_review|Legacy Project Memory/u);
    assert.match(prompt, /ask/u);
    assert.match(prompt, /delegate/u);
  }
  assert.deepEqual(tools, getAgentTools());
});

test('dynamic context files live in a stable contextInstructions system message, never in the user message', () => {
  const firstContextFiles = [createContextFile('one.ts', 'export const one = 1;')];
  const secondContextFiles = [createContextFile('two.ts', 'export const two = 2;')];
  const first = buildInitialAgentMessages({
    prompt: 'Explain the file.',
    contextFiles: firstContextFiles,
    contextInstructions: formatCurrentRunContextForAgent({
      contextFiles: firstContextFiles,
      language: 'en'
    }),
    history: [],
    language: 'en'
  });
  const second = buildInitialAgentMessages({
    prompt: 'Explain the file.',
    contextFiles: secondContextFiles,
    contextInstructions: formatCurrentRunContextForAgent({
      contextFiles: secondContextFiles,
      language: 'en'
    }),
    history: [],
    language: 'en'
  });

  assert.equal(first[0]?.role, 'system');
  assert.equal(second[0]?.role, 'system');
  assert.equal(first[0]?.content, second[0]?.content);
  // context files 进入稳定上下文块（第二条 system 消息），而不是 user 消息
  assert.ok(first[1]?.content?.includes('one.ts'));
  assert.ok(second[1]?.content?.includes('two.ts'));
  // user 消息是纯 prompt，不含任何包装，跨轮字节一致
  assert.equal(first.at(-1)?.content, 'Explain the file.');
  assert.ok(!first.at(-1)?.content?.includes('one.ts'));
});

test('project instructions and Skills live in contextInstructions, keeping the system prompt byte-stable', () => {
  const dynamicContext: CurrentRunContext = {
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
  };
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
    contextInstructions: formatCurrentRunContextForAgent({
      contextFiles: [],
      currentRunContext: dynamicContext,
      language: 'en'
    })
  });

  assert.equal(withDynamicContext[0]?.content, withoutDynamicContext[0]?.content);
  assert.match(withDynamicContext[1]?.content ?? '', /Project rule[\s\S]*Review workflow/u);
  assert.equal(withDynamicContext.at(-1)?.content, 'Inspect.');
});


test('validation tool exposes only the fixed safe npm scripts', () => {
  const tool = getAgentTools({ toolNames: [RUN_VALIDATION_TOOL_NAME] }).find(tool => tool.function.name === RUN_VALIDATION_TOOL_NAME)!;
  const properties = tool.function.parameters.properties as Record<string, { enum?: string[] }>;

  assert.equal(tool.function.name, RUN_VALIDATION_TOOL_NAME);
  assert.deepEqual(properties.script?.enum, ['compile', 'lint', 'test']);
  assert.equal(properties.command, undefined);
  assert.match(tool.function.description, /current on-disk workspace/u);
  assert.match(tool.function.description, /after any DraftEdit succeeds/u);
  assert.match(tool.function.description, /pending ChangeSet/u);
});

test('delete tool is always exposed and only prepares a non-recursive pending file deletion', () => {
  const tool = getAgentTools({ toolNames: [DELETE_WORKSPACE_FILE_TOOL_NAME] })[0];
  const properties = tool.function.parameters.properties as Record<string, unknown>;

  assert.equal(tool.function.name, DELETE_WORKSPACE_FILE_TOOL_NAME);
  assert.deepEqual(Object.keys(properties).sort(), ['path', 'reason']);
  assert.deepEqual(tool.function.parameters.required, ['path', 'reason']);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.match(tool.function.description, /pending delete DraftEdit/u);
  assert.match(tool.function.description, /never deletes the file immediately/u);
  assert.match(tool.function.description, /never targets directories/u);
  assert.match(tool.function.description, /never deletes recursively/u);
  assert.ok(getAgentToolNamesForPrompt('Explain this code.', true).includes(DELETE_WORKSPACE_FILE_TOOL_NAME));
  assert.ok(getAgentToolNamesForPrompt('Explain this code.', false).includes(DELETE_WORKSPACE_FILE_TOOL_NAME));
});

test('system prompts explain safe pending file deletion in both languages', () => {
  const english = getAgentSystemPrompt({ language: 'en' });
  const chinese = getAgentSystemPrompt({ language: 'zh-CN' });

  assert.match(english, /keepseek_delete_workspace_file/u);
  assert.match(english, /SafeFileEditor/u);
  assert.match(chinese, /keepseek_delete_workspace_file/u);
  assert.match(chinese, /SafeFileEditor/u);
});

test('system prompts define adaptive read-only intent, evidence, edit, archive, and validation contracts', () => {
  const english = getAgentSystemPrompt({ language: 'en' });
  const chinese = getAgentSystemPrompt({ language: 'zh-CN' });

  for (const prompt of [english, chinese]) {
    assert.match(prompt, /DraftEdit/u);
    assert.match(prompt, /keepseek_create_incremental_draft_edit/u);
    assert.match(prompt, /keepseek_create_draft_edit/u);
    assert.match(prompt, /keepseek_search_session_archive/u);
    assert.match(prompt, /Git/u);
    assert.match(prompt, /Skill scripts/u);
  }
  assert.match(english, /Treat answering, understanding, diagnosis, and review as read-only tasks by default/u);
  assert.match(english, /strongest clue already supplied/u);
  assert.match(english, /next important uncertainty/u);
  assert.match(english, /Validation checks only the current on-disk workspace/u);
  assert.match(english, /pre-change baseline/u);
  assert.match(english, /post-Apply validation/u);
  assert.match(english, /facts directly observed in tool results from inference/u);
  assert.match(english, /ambiguity would materially change/u);
  assert.match(chinese, /回答、理解、诊断和审查默认都是只读任务/u);
  assert.match(chinese, /最强线索/u);
  assert.match(chinese, /下一个关键不确定性/u);
  assert.match(chinese, /验证只能检查当前已经落盘的工作区/u);
  assert.match(chinese, /修改前(?:的)?基线/u);
  assert.match(chinese, /Apply 后验证/u);
  assert.match(chinese, /工具直接观察到的事实与推断/u);
  assert.match(chinese, /歧义会实质改变/u);
});

test('classifies both file-changing tools as DraftEdit preparation tools', () => {
  assert.equal(isDraftEditPreparationTool(CREATE_DRAFT_EDIT_TOOL_NAME), true);
  assert.equal(isDraftEditPreparationTool(CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME), true);
  assert.equal(isDraftEditPreparationTool(DELETE_WORKSPACE_FILE_TOOL_NAME), true);
  assert.equal(isDraftEditPreparationTool(SEARCH_WORKSPACE_TOOL_NAME), false);
  assert.equal(isDraftRunPreparationTool(RUN_DRAFT_TOOL_NAME), true);
  assert.equal(isDraftRunPreparationTool(RUN_VALIDATION_TOOL_NAME), false);
});

test('project rules, skills, and attachments share one deterministic context budget', () => {
  const file = createContextFile('large.ts', 'f'.repeat(2_000));
  const context: CurrentRunContext = {
    projectInstructions: [{
      id: 'root', uri: 'file:///workspace/AGENTS.md', workspaceFolder: 'workspace',
      content: 'p'.repeat(1_000), characterCount: 1_000, tokenEstimate: 250,
      contentHash: 'project', truncated: false
    }],
    skills: [{
      id: 'skill', name: 'skill', source: 'agentsWorkspace', rootUri: 'file:///skill',
      skillUri: 'file:///skill/SKILL.md', content: 's'.repeat(2_000), hasScripts: false,
      activation: { source: 'explicit', reason: 'selected' }
    }],
    metadata: {
      precedence: [], beforeDeduplicationCount: 3, afterDeduplicationCount: 3,
      totalCharacterCount: 5_000, totalTokenEstimate: 1_250, truncated: false,
      sources: [], discarded: [], possibleConflicts: []
    }
  };
  const first = formatCurrentRunContextForAgent({
    contextFiles: [file], currentRunContext: context, language: 'en', totalBudgetCharacters: 2_500
  });
  const second = formatCurrentRunContextForAgent({
    contextFiles: [file], currentRunContext: context, language: 'en', totalBudgetCharacters: 2_500
  });
  assert.equal(first, second);
  assert.ok(first.length < 3_000);
  assert.match(first, /shared context budget/u);
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
    GET_WORKSPACE_SYMBOLS_TOOL_NAME,
    READ_EVIDENCE_TOOL_NAME
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
      DELETE_WORKSPACE_FILE_TOOL_NAME,
      READ_WORKSPACE_FILE_RANGE_TOOL_NAME
    ]
  });
  const right = getAgentTools({
    toolNames: [
      READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
      SEARCH_WORKSPACE_TOOL_NAME,
      DELETE_WORKSPACE_FILE_TOOL_NAME,
      CREATE_DRAFT_EDIT_TOOL_NAME
    ]
  });

  assert.deepEqual(
    left.map((tool) => tool.function.name),
    [
      CREATE_DRAFT_EDIT_TOOL_NAME,
      DELETE_WORKSPACE_FILE_TOOL_NAME,
      READ_EVIDENCE_TOOL_NAME,
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

test('slim tool set varies with prompt keywords, so it must freeze per session', () => {
  const plain = getAgentToolNamesForPrompt('Summarize this code.', true);
  const git = getAgentToolNamesForPrompt('Show git status and the current diff.', true);
  assert.ok(!plain.includes(GIT_STATUS_TOOL_NAME));
  assert.ok(git.includes(GIT_STATUS_TOOL_NAME));
  // 冻结后：同一工具集生成的 schema 跨轮稳定（按名排序、内容一致）
  const first = getAgentTools({ toolNames: git });
  const second = getAgentTools({ toolNames: git });
  assert.deepEqual(first.map((tool) => tool.function.name), second.map((tool) => tool.function.name));
  assert.deepEqual(first, second);
});
