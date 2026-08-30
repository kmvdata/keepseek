import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore, normalizeSubagentModelSetting } from '../src/accounts/subagentSettingsStore';
import {
  DELEGATE_PARALLEL_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  READ_SUBAGENT_RESULT_TOOL_NAME,
  formatActiveSkills,
  getAgentSystemPrompt,
  getAgentToolNamesForPrompt,
  getAgentTools
} from '../src/agent/protocol';
import { AgentLoop, AgentRunner } from '../src/agent/runner';
import { SubagentScheduler } from '../src/agent/subagents/scheduler';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { SubagentStore } from '../src/agent/subagents/store';
import type {
  DelegateParallelInput,
  DelegateTaskInput,
  ReadSubagentResultInput,
  StoredSubagentMetadata,
  SubagentInvocationContext,
  SubagentToolAdapter,
  SubagentToolExecution
} from '../src/agent/subagents/types';
import type { AgentRequest, DraftEdit, DraftRunProposal } from '../src/shared/types';
import { parseSkillFrontmatter } from '../src/skills/skillDiscovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

test('protocol v5 adds stable delegation tools without changing the frozen v4 lane', () => {
  const v4Names = getAgentToolNamesForPrompt('investigate the workspace', false, 4);
  const v5Names = getAgentToolNamesForPrompt('investigate the workspace', false, 5);
  assert.equal(v4Names.includes(DELEGATE_TASK_TOOL_NAME), false);
  assert.equal(v4Names.includes(DELEGATE_PARALLEL_TOOL_NAME), false);
  assert.equal(v4Names.includes(READ_SUBAGENT_RESULT_TOOL_NAME), false);
  assert.equal(v5Names.includes(DELEGATE_TASK_TOOL_NAME), true);
  assert.equal(v5Names.includes(DELEGATE_PARALLEL_TOOL_NAME), true);
  assert.equal(v5Names.includes(READ_SUBAGENT_RESULT_TOOL_NAME), true);

  const v4Prompt = getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 4 });
  const v5Prompt = getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 5 });
  assert.doesNotMatch(v4Prompt, /keepseek_delegate_task/u);
  assert.match(v5Prompt, /self-contained/u);
  assert.match(v5Prompt, /no parent history/u);

  const tools = getAgentTools({
    requestProtocolVersion: 5,
    toolNames: [DELEGATE_TASK_TOOL_NAME, DELEGATE_PARALLEL_TOOL_NAME, READ_SUBAGENT_RESULT_TOOL_NAME]
  });
  assert.deepEqual(tools.map((tool) => tool.function.name), [
    DELEGATE_PARALLEL_TOOL_NAME,
    DELEGATE_TASK_TOOL_NAME,
    READ_SUBAGENT_RESULT_TOOL_NAME
  ]);
  assert.equal(tools.every((tool) => tool.function.parameters.additionalProperties === false), true);
});

test('subagent Skill profiles keep full instructions out of the v5 parent context', () => {
  const secretInstructions = 'FULL CHILD ONLY INSTRUCTIONS '.repeat(200);
  const skill = {
    id: 'agentsWorkspace:reviewer',
    name: 'Focused reviewer',
    source: 'agentsWorkspace' as const,
    rootUri: 'file:///workspace/.agents/reviewer',
    skillUri: 'file:///workspace/.agents/reviewer/SKILL.md',
    content: secretInstructions,
    description: 'Reviews one bounded surface.',
    runAs: 'subagent' as const,
    subagentProfile: {
      id: 'focused-reviewer',
      tools: ['keepseek_read_workspace_file_range'],
      canDelegate: false
    }
  };
  const parent = formatActiveSkills({ skills: [skill], language: 'en', requestProtocolVersion: 5 });
  const legacy = formatActiveSkills({ skills: [skill], language: 'en', requestProtocolVersion: 4 });
  assert.match(parent, /focused-reviewer/u);
  assert.doesNotMatch(parent, /FULL CHILD ONLY INSTRUCTIONS/u);
  assert.ok(parent.length <= 4_000);
  assert.match(legacy, /FULL CHILD ONLY INSTRUCTIONS/u);
});

test('subagent frontmatter parses typed profile policy including block-list tools', () => {
  const parsed = parseSkillFrontmatter([
    '---',
    'name: Security reviewer',
    'metadata:',
    '  keepseek:',
    '    runAs: subagent',
    '    profile: security-review',
    '    tools:',
    '      - keepseek_search_workspace',
    '      - keepseek_read_workspace_file_range',
    '    maxSteps: 7',
    '    timeoutMs: 45000',
    '    canDelegate: false',
    '    resultMaxChars: 64000',
    '---',
    'Review security boundaries.'
  ].join('\n'));
  assert.equal(parsed.runAs, 'subagent');
  assert.equal(parsed.profile, 'security-review');
  assert.deepEqual(parsed.tools, ['keepseek_search_workspace', 'keepseek_read_workspace_file_range']);
  assert.equal(parsed.maxSteps, 7);
  assert.equal(parsed.timeoutMs, 45_000);
  assert.equal(parsed.canDelegate, false);
  assert.equal(parsed.resultMaxChars, 64_000);
});

test('global subagent model setting persists fixed identity and defaults safely', async () => {
  const storageRoot = await createTemporaryDirectory('keepseek-subagent-settings-');
  const store = new SubagentSettingsStore(vscode.Uri.file(storageRoot));
  assert.equal((await store.load()).mode, 'follow-main');
  const fixed = await store.save({ mode: 'fixed', sourceId: 'source-a', modelId: 'model-a' });
  assert.equal(fixed.mode, 'fixed');
  assert.deepEqual(await store.load(), fixed);
  const follow = await store.save({ mode: 'follow-main' });
  assert.equal(follow.mode, 'follow-main');
  assert.equal(follow.sourceId, undefined);
  const incomplete = normalizeSubagentModelSetting({ mode: 'fixed', sourceId: '', modelId: 'x' });
  assert.equal(incomplete.mode, 'fixed');
  assert.equal(incomplete.sourceId, undefined);
  assert.equal(incomplete.modelId, 'x');
});

test('scheduler enforces depth, tree budgets, path claims, and bounded root concurrency', async () => {
  const scheduler = new SubagentScheduler();
  assert.deepEqual(scheduler.reserve({
    treeId: 'tree-path', parentRunId: 'parent-path', ownerId: 'one', depth: 1, proposal: true, paths: ['src/a.ts']
  }), { ok: true });
  const conflict = scheduler.reserve({
    treeId: 'tree-path', parentRunId: 'parent-path', ownerId: 'two', depth: 1, proposal: true, paths: ['./src/a.ts']
  });
  assert.equal(conflict.ok, false);
  assert.equal(scheduler.reserve({
    treeId: 'tree-depth', parentRunId: 'parent-depth', ownerId: 'deep', depth: 3, proposal: false
  }).ok, false);

  let active = 0;
  let maximum = 0;
  const tasks = Array.from({ length: 5 }, async (_, index) => await scheduler.run({
    depth: 1,
    proposal: false,
    language: 'en'
  }, async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10 + index));
    active -= 1;
  }));
  await Promise.all(tasks);
  assert.equal(maximum, 3);
});

test('subagent store returns bounded final-result pages without transcript or reasoning leakage', async () => {
  const storageRoot = await createTemporaryDirectory('keepseek-subagent-store-');
  const store = new SubagentStore(vscode.Uri.file(storageRoot), 'workspace-key');
  const metadata: StoredSubagentMetadata = {
    version: 1,
    id: 'sa_one',
    treeId: 'tree-one',
    parentSessionId: 'session-one',
    parentRunId: 'run-one',
    rootRunId: 'run-one',
    depth: 1,
    profile: 'research',
    lane: 'research-read',
    task: 'Inspect one thing.',
    status: 'completed',
    sourceId: 'source-a',
    modelId: 'model-a',
    provider: 'deepseek',
    sourceConfigHash: 'source-hash',
    systemPromptHash: 'system-hash',
    toolSchemaHash: 'tools-hash',
    profileHash: 'profile-hash',
    projectInstructionsHash: 'project-hash',
    resultHash: 'result-hash',
    resultChars: 30_000,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z'
  };
  await store.save(metadata, {
    version: 1,
    metadataId: metadata.id,
    contextInstructions: 'PRIVATE CHILD CONTEXT',
    messages: [{ id: 'reasoning', role: 'assistant', content: 'private transcript', createdAt: metadata.createdAt }],
    result: 'R'.repeat(30_000)
  });
  const page = await store.readResultPage({
    parentSessionId: metadata.parentSessionId,
    subagentId: metadata.id,
    offset: 12_000,
    maxChars: 50_000
  });
  assert.equal(page.ok, true);
  assert.equal(String(page.content).length, 18_000);
  assert.equal(page.hasMore, false);
  assert.equal(JSON.stringify(page).includes('PRIVATE CHILD CONTEXT'), false);
  assert.equal(JSON.stringify(page).includes('private transcript'), false);
  assert.equal((await store.readResultPage({
    parentSessionId: 'another-session',
    subagentId: metadata.id
  })).ok, false);
});

test('main AgentRunner routes delegation through the isolated adapter and rejects overlapping child edits', async () => {
  assert.notEqual(AgentRunner, AgentLoop);
  const childEdit: DraftEdit = {
    id: 'child-edit',
    uri: 'file:///workspace/src/a.ts',
    label: 'src/a.ts',
    action: 'modify',
    newText: 'child',
    reason: 'child proposal'
  };
  const adapter = new FakeSubagentAdapter({
    content: JSON.stringify({ ok: true, subagentId: 'sa_child' }),
    draftEdits: [childEdit]
  });
  const runner = new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter);
  const invoke = runner as unknown as {
    handleToolCall(
      call: { id: string; type: 'function'; function: { name: string; arguments: string } },
      edits: DraftEdit[],
      runs: DraftRunProposal[],
      language: 'en',
      options: { parentRequest: AgentRequest; parentRunId: string }
    ): Promise<string>;
  };
  const existing = { ...childEdit, id: 'parent-edit', newText: 'parent' };
  const edits = [existing];
  const result = JSON.parse(await invoke.handleToolCall({
    id: 'delegate',
    type: 'function',
    function: { name: DELEGATE_TASK_TOOL_NAME, arguments: JSON.stringify({ task: 'Inspect src/a.ts.' }) }
  }, edits, [], 'en', {
    parentRequest: createParentRequest(),
    parentRunId: 'parent-run'
  })) as { ok: boolean; errorType?: string };
  assert.equal(adapter.calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'subagent_proposal_conflict');
  assert.deepEqual(edits, [existing]);
});

test('real child provider request excludes parent history, context files, and parent-only instructions', async () => {
  const storageRoot = await createTemporaryDirectory('keepseek-subagent-runtime-');
  const capturedBodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    capturedBodies.push(typeof init?.body === 'string' ? init.body : '');
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'Compact child conclusion.' }, finish_reason: 'stop' }]
    })}\n\ndata: [DONE]\n\n`;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event));
        controller.close();
      }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const runtime = new SubagentRuntime({
      globalStorageUri: vscode.Uri.file(storageRoot),
      workspaceKey: 'workspace-one',
      sourceStore: new ModelSourceStore(vscode.Uri.file(storageRoot))
    });
    const parent = createParentRequest();
    parent.model = {
      ...parent.model,
      provider: 'openai-compatible',
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_000
    };
    parent.sourceConfig = {
      sourceId: 'source-a',
      provider: 'openai-compatible',
      apiKey: 'test-key',
      baseUrl: 'https://provider.invalid/v1',
      supportsBilling: false
    };
    parent.history = [{
      id: 'parent-secret',
      role: 'user',
      content: 'PARENT HISTORY MUST NOT LEAK',
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    parent.contextFiles = [{
      id: 'parent-file',
      uri: 'file:///workspace/private.txt',
      label: 'private.txt',
      fsPath: '/workspace/private.txt',
      languageId: 'plaintext',
      content: 'PARENT CONTEXT FILE MUST NOT LEAK',
      sizeBytes: 33,
      source: 'workspace'
    }];
    parent.contextInstructions = 'PARENT STABLE CONTEXT MUST NOT LEAK';
    parent.currentRunContext = {
      projectInstructions: [{
        id: 'project-rule',
        uri: 'file:///workspace/AGENTS.md',
        workspaceFolder: 'workspace',
        content: 'PROJECT RULE ALLOWED IN CHILD',
        characterCount: 29,
        tokenEstimate: 8,
        contentHash: 'project-hash',
        truncated: false
      }],
      skills: [],
      metadata: {
        precedence: [],
        beforeDeduplicationCount: 0,
        afterDeduplicationCount: 0,
        totalCharacterCount: 0,
        totalTokenEstimate: 0,
        truncated: false,
        sources: [],
        discarded: [],
        possibleConflicts: []
      }
    };

    const execution = await runtime.delegateTask({
      task: 'CHILD SELF CONTAINED TASK',
      profile: 'research'
    }, {
      parentRequest: parent,
      parentRunId: 'parent-run',
      language: 'en'
    });

    assert.equal(JSON.parse(execution.content).ok, true);
    assert.equal(capturedBodies.length, 1);
    const providerBody = capturedBodies[0];
    assert.match(providerBody, /CHILD SELF CONTAINED TASK/u);
    assert.match(providerBody, /PROJECT RULE ALLOWED IN CHILD/u);
    assert.doesNotMatch(providerBody, /PARENT HISTORY MUST NOT LEAK/u);
    assert.doesNotMatch(providerBody, /PARENT CONTEXT FILE MUST NOT LEAK/u);
    assert.doesNotMatch(providerBody, /PARENT STABLE CONTEXT MUST NOT LEAK/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

class FakeSubagentAdapter implements SubagentToolAdapter {
  public calls = 0;

  public constructor(private readonly result: SubagentToolExecution) {}

  public async delegateTask(_input: DelegateTaskInput, _context: SubagentInvocationContext): Promise<SubagentToolExecution> {
    this.calls += 1;
    return this.result;
  }

  public async delegateParallel(_input: DelegateParallelInput, _context: SubagentInvocationContext): Promise<SubagentToolExecution> {
    return this.result;
  }

  public async readResult(_input: ReadSubagentResultInput, _context: SubagentInvocationContext): Promise<SubagentToolExecution> {
    return { content: JSON.stringify({ ok: true }) };
  }
}

function createParentRequest(): AgentRequest {
  return {
    prompt: 'Parent task',
    model: { id: 'model-a', label: 'Model A', provider: 'deepseek', sourceId: 'source-a' },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    history: [],
    language: 'en',
    sessionId: 'session-one'
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
