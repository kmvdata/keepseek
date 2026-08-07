import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInitialAgentMessages,
  formatCurrentRunContextForAgent,
  getAgentSystemPrompt
} from '../src/agent/protocol';
import type { AgentToolCall, AgentToolRound, ChatMessage, ContextFile } from '../src/shared/types';

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

function assistantMessage(id: string, content: string, toolRounds?: AgentToolRound[]): ChatMessage {
  return {
    id,
    role: 'assistant',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...(toolRounds ? { toolRounds } : {})
  };
}

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
