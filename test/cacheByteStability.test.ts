import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInitialAgentMessages,
  formatCurrentRunContextForAgent,
  getAgentSystemPrompt
} from '../src/agent/protocol';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import type {
  ActivatedSkill,
  AgentToolCall,
  AgentToolRound,
  ChatMessage,
  ContextFile,
  CurrentRunContext
} from '../src/shared/types';

// 缓存契约测试：请求前缀（system + contextInstructions + 历史消息）必须跨轮逐字节稳定。
// 这些断言是 DeepSeek 前缀缓存命中的直接守护：任何“包装版 vs 历史版”不一致都会让
// 该消息之后的全部 token miss。

const CONTEXT_INSTRUCTIONS = 'Project and run context (stable across turns):\n\n## workspace/AGENTS.md\nRule: keep tests green.';

function userMessage(id: string, content: string, expandedContent?: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(expandedContent ? { expandedContent } : {})
  };
}

function assistantMessage(
  id: string,
  content: string,
  toolRounds?: AgentToolRound[],
  reasoningContent?: string
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(toolRounds ? { toolRounds } : {}),
    ...(reasoningContent ? { reasoningContent } : {})
  };
}

test('v2 keeps ordinary final-answer reasoning local while v1 preserves legacy bytes', () => {
  const history = [
    userMessage('u1', 'question'),
    assistantMessage('a1', 'answer', undefined, 'private final reasoning')
  ];
  const legacy = buildInitialAgentMessages({
    prompt: 'next',
    contextFiles: [],
    history,
    language: 'en',
    requestProtocolVersion: 1
  });
  const optimized = buildInitialAgentMessages({
    prompt: 'next',
    contextFiles: [],
    history,
    language: 'en',
    requestProtocolVersion: 2
  });

  const legacyFinal = legacy.find((message) => message.role === 'assistant');
  const optimizedFinal = optimized.find((message) => message.role === 'assistant');
  assert.equal(legacyFinal?.reasoning_content, 'private final reasoning');
  assert.equal(optimizedFinal?.reasoning_content, undefined);
  assert.equal(history[1]?.reasoningContent, 'private final reasoning');
});

test('v2 omits only final reasoning and keeps tool-call reasoning atomically paired', () => {
  const toolCall: AgentToolCall = {
    id: 'call_v2',
    type: 'function',
    function: { name: 'keepseek_read_workspace_file_range', arguments: '{"path":"a.ts","startLine":1,"endLine":2}' }
  };
  const round: AgentToolRound = {
    assistantContent: null,
    reasoningContent: 'required tool reasoning',
    toolCalls: [toolCall],
    toolResults: [{ toolCallId: toolCall.id, content: '{"ok":true}' }]
  };
  const messages = buildInitialAgentMessages({
    prompt: 'next',
    contextFiles: [],
    history: [
      userMessage('u1', 'inspect'),
      assistantMessage('a1', 'done', [round], 'local final reasoning')
    ],
    language: 'en',
    requestProtocolVersion: 2
  });

  const toolAssistant = messages.find((message) => message.tool_calls?.length);
  const finalAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  assert.equal(toolAssistant?.reasoning_content, 'required tool reasoning');
  assert.equal(messages[messages.indexOf(toolAssistant!) + 1]?.tool_call_id, toolCall.id);
  assert.equal(finalAssistant?.reasoning_content, undefined);
});

test('同一 user 消息作为当前 prompt 与作为历史重发时字节一致（B1 契约）', () => {
  const user1 = userMessage('u1', 'first question');
  const round1 = buildInitialAgentMessages({
    prompt: 'first question',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [],
    language: 'en'
  });
  const round2 = buildInitialAgentMessages({
    prompt: 'second question',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [user1, assistantMessage('a1', 'first answer')],
    language: 'en'
  });

  assert.equal(round1.at(-1)?.content, 'first question');
  const round2User1 = round2.find((message) => message.role === 'user');
  assert.equal(round2User1?.content, 'first question');
  // 第一轮完整请求是第二轮请求的字节前缀：除新追加的 assistant + user 外完全一致
  assert.equal(JSON.stringify(round1), JSON.stringify(round2.slice(0, round1.length)));
});

test('引用展开（expandedContent）跨轮保持原样，不因发送时机不同而改变', () => {
  const user1 = userMessage('u1', 'see <path>', 'see /workspace/src/main.ts <path#L1-L5>');
  const round1 = buildInitialAgentMessages({
    // runner 收到的 prompt 是引用展开后的内容（provider 传 prompt=expandedPrompt）
    prompt: user1.expandedContent ?? user1.content,
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [],
    language: 'en'
  });
  const round2 = buildInitialAgentMessages({
    prompt: 'next',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [user1, assistantMessage('a1', 'ok')],
    language: 'en'
  });

  // 第一轮发送的就是展开后的内容
  assert.equal(round1.at(-1)?.content, user1.expandedContent);
  // 第二轮以历史身份重发时字节不变
  const round2User1 = round2.find((message) => message.role === 'user');
  assert.equal(round2User1?.content, user1.expandedContent);
});

test('tail-appended providerContent is reused as history without duplicating the raw current prompt', () => {
  const current = userMessage('u1', 'raw prompt', 'expanded prompt');
  current.providerContent = 'expanded prompt\n\n<keepseek-dynamic-context>new skill</keepseek-dynamic-context>';
  const messages = buildInitialAgentMessages({
    prompt: 'expanded prompt',
    contextFiles: [],
    history: [current],
    language: 'en',
    requestProtocolVersion: 2
  });
  assert.equal(messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(messages.at(-1)?.content, current.providerContent);
});

test('toolRounds 跨轮重建与上一轮发送序列逐字节一致（B4 契约）', () => {
  const toolCall: AgentToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'keepseek_list_workspace_files', arguments: '{}' }
  };
  const toolRound: AgentToolRound = {
    assistantContent: '',
    reasoningContent: 'I will list the files.',
    toolCalls: [toolCall],
    toolResults: [{ toolCallId: 'call_1', content: '["src/main.ts"]' }]
  };
  const user1 = userMessage('u1', 'list files');
  const assistant1 = assistantMessage('a1', 'Here are the files:', [toolRound]);

  const messages = buildInitialAgentMessages({
    prompt: 'list files',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [user1, assistant1],
    language: 'en'
  });

  // 序列：system, contextInstructions, user, assistant(tool_calls), tool, assistant(最终文本)
  assert.deepEqual(messages.map((message) => message.role), [
    'system',
    'system',
    'user',
    'assistant',
    'tool',
    'assistant'
  ]);
  assert.deepEqual(messages[3]?.tool_calls, [toolCall]);
  assert.equal(messages[3]?.content, '');
  assert.equal(messages[3]?.reasoning_content, 'I will list the files.');
  assert.equal(messages[4]?.tool_call_id, 'call_1');
  assert.equal(messages[4]?.content, '["src/main.ts"]');
  assert.equal(messages[5]?.content, 'Here are the files:');
});

test('带工具调用的上一轮请求序列是下一轮请求序列的字节前缀', () => {
  const toolCall: AgentToolCall = {
    id: 'call_1',
    type: 'function',
    function: { name: 'keepseek_list_workspace_files', arguments: '{}' }
  };
  const toolRound: AgentToolRound = {
    assistantContent: '',
    reasoningContent: 'I will list the files.',
    toolCalls: [toolCall],
    toolResults: [{ toolCallId: 'call_1', content: '["src/main.ts"]' }]
  };
  const user1 = userMessage('u1', 'list files');
  const assistant1 = assistantMessage('a1', 'Here are the files:', [toolRound]);

  // 第一轮请求 = 初始消息 + runner 追加的工具轮（这是上轮实际发送的完整字节）
  const round1Initial = buildInitialAgentMessages({
    prompt: 'list files',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [user1],
    language: 'en'
  });
  const round1Request = [
    ...round1Initial,
    {
      role: 'assistant',
      content: '',
      reasoning_content: 'I will list the files.',
      tool_calls: [toolCall]
    },
    {
      role: 'tool',
      tool_call_id: 'call_1',
      content: '["src/main.ts"]'
    }
  ];

  // 第二轮重建：history 含 user1 + assistant1(toolRounds)
  const round2Messages = buildInitialAgentMessages({
    prompt: 'now summarize',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [user1, assistant1],
    language: 'en'
  });

  assert.ok(round2Messages.length >= round1Request.length);
  for (let index = 0; index < round1Request.length; index += 1) {
    assert.deepEqual(round2Messages[index], round1Request[index], `prefix message ${index} differs`);
  }
});

test('contextInstructions 字节确定性：相同输入必得相同输出，不同输入必得不同输出', () => {
  const contextFile: ContextFile = {
    id: 'f1',
    uri: 'file:///workspace/src/main.ts',
    label: 'main.ts',
    fsPath: '/workspace/src/main.ts',
    languageId: 'typescript',
    content: 'export const answer = 42;',
    sizeBytes: 24,
    source: 'workspace'
  };

  const first = formatCurrentRunContextForAgent({
    contextFiles: [contextFile],
    language: 'en'
  });
  const second = formatCurrentRunContextForAgent({
    contextFiles: [contextFile],
    language: 'en'
  });
  const changed = formatCurrentRunContextForAgent({
    contextFiles: [{ ...contextFile, content: 'export const answer = 43;' }],
    language: 'en'
  });

  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.ok(first.includes('main.ts'));
  assert.ok(!first.includes('当前用户请求'));
});

test('system prompt 不随 contextInstructions 或历史变化（base-first 分层）', () => {
  const baseline = getAgentSystemPrompt({ language: 'en' });
  const withHistory = buildInitialAgentMessages({
    prompt: 'next',
    contextFiles: [],
    contextInstructions: CONTEXT_INSTRUCTIONS,
    history: [userMessage('u1', 'hello'), assistantMessage('a1', 'hi')],
    language: 'en'
  });

  assert.equal(withHistory[0]?.role, 'system');
  assert.equal(withHistory[0]?.content, baseline);
});

test('model/provider capability changes do not alter system prompt or frozen tool schema bytes', () => {
  const base = {
    agentSettings: {
      thinkingEnabled: true,
      reasoningEffort: 'max' as const,
      compressionThreshold: 'balanced' as const
    },
    contextFiles: [],
    history: [userMessage('u1', 'hello')],
    language: 'en' as const,
    prompt: 'hello',
    requestProtocolVersion: 3,
    slimToolNames: ['keepseek_list_workspace_files'],
    includeTools: true
  };
  const deepseek = buildProviderRequestProjection({
    ...base,
    model: {
      id: 'deepseek-v4-flash', label: 'Flash', provider: 'deepseek',
      contextWindowTokens: 1_000_000
    },
    provider: 'deepseek'
  });
  const compatible = buildProviderRequestProjection({
    ...base,
    model: {
      id: 'vendor-model', label: 'Vendor', provider: 'openai-compatible',
      contextWindowTokens: 64_000, maxOutputTokens: 4_000
    },
    provider: 'openai-compatible'
  });

  assert.equal(deepseek.messages[0]?.content, compatible.messages[0]?.content);
  assert.equal(deepseek.messages[0]?.content, getAgentSystemPrompt({ language: 'en' }));
  assert.equal(JSON.stringify(deepseek.tools), JSON.stringify(compatible.tools));
  assert.equal(compatible.runtimeProfile.contextWindowTokens, 64_000);
  assert.equal(compatible.runtimeProfile.maxTokens, 4_000);
});

test('会话冻结后（skills 块不变）轮次请求序列保持字节前缀', () => {
  // 模拟 frozenImplicitSkillIds 生效后的稳定 skills 列表：后续 prompt 不再含关键词也不变
  const skill: ActivatedSkill = {
    id: 'auto-review',
    name: 'review-flow',
    source: 'agentsWorkspace',
    rootUri: 'file:///workspace/.agents/skills/review',
    skillUri: 'file:///workspace/.agents/skills/review/SKILL.md',
    content: '# Review flow\n\nRun the review workflow.',
    activation: { source: 'implicit', reason: 'Frozen from the first user request of this chat session.' }
  };
  const runContext: CurrentRunContext = {
    projectInstructions: [],
    skills: [skill],
    metadata: {
      precedence: [],
      beforeDeduplicationCount: 1,
      afterDeduplicationCount: 1,
      totalCharacterCount: skill.content.length,
      totalTokenEstimate: 12,
      truncated: false,
      sources: [{
        id: skill.id,
        kind: 'skill',
        label: skill.name,
        uri: skill.skillUri,
        source: 'agentsWorkspace',
        activation: 'implicit',
        characterCount: skill.content.length,
        tokenEstimate: 12,
        contentHash: 'skill-content-hash',
        truncated: false,
        scriptsPresent: false
      }],
      discarded: [],
      possibleConflicts: []
    }
  };
  const contextInstructions = formatCurrentRunContextForAgent({
    contextFiles: [],
    currentRunContext: runContext,
    language: 'en'
  });

  const user1 = userMessage('u1', 'Please run review-flow.');
  const assistant1 = assistantMessage('a1', 'Reviewing now.');
  const round1 = buildInitialAgentMessages({
    prompt: 'Please run review-flow.',
    contextFiles: [],
    contextInstructions,
    history: [],
    language: 'en'
  });
  const round2 = buildInitialAgentMessages({
    prompt: 'Now fix the findings.',
    contextFiles: [],
    contextInstructions,
    history: [user1, assistant1],
    language: 'en'
  });

  // 冻结语义：skills 块在会话内字节稳定（即使后续 prompt 不再含关键词）
  assert.equal(round1[1]?.content, round2[1]?.content);
  // append-only：第一轮请求序列是第二轮请求序列的字节前缀
  assert.equal(JSON.stringify(round1), JSON.stringify(round2.slice(0, round1.length)));
});
