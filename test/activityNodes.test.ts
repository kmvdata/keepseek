import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActivityNodes, type ActivityNode } from '../src/agent/logging/activityNodes';
import { describeToolTarget } from '../src/agent/toolTarget';
import { getVisibleMessages } from '../src/sessions/chatSessionStore';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import type { AgentToolRound, ChatMessage } from '../src/shared/types';

/**
 * The activity nodes are a pure derived view: they never carry tool result
 * bodies, never invent durations, and must collapse to `undefined` whenever the
 * original whole-message rendering has to stay authoritative.
 */

function round(
  assistantContent: string | null,
  calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>,
  results: Array<{ toolCallId: string; content: string }>
): AgentToolRound {
  return {
    assistantContent,
    reasoningContent: null,
    toolCalls: calls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) }
    })),
    toolResults: results
  };
}

function toolNodes(nodes: ActivityNode[] | undefined): Extract<ActivityNode, { kind: 'tool' }>[] {
  return (nodes ?? []).filter((node): node is Extract<ActivityNode, { kind: 'tool' }> => node.kind === 'tool');
}

function sayNodes(nodes: ActivityNode[] | undefined): string[] {
  return (nodes ?? []).filter((node): node is Extract<ActivityNode, { kind: 'say' }> => node.kind === 'say')
    .map((node) => node.text);
}

test('no toolRounds yields no derived view, so the original rendering stays', () => {
  assert.equal(buildActivityNodes({ content: 'final answer' }), undefined);
  assert.equal(buildActivityNodes({ content: 'final answer', toolRounds: [] }), undefined);
});

test('a single round renders narration, the tool, then the final answer', () => {
  const nodes = buildActivityNodes({
    content: '我先只读查看实际执行计划。\n\n最终回答。',
    toolRounds: [round('我先只读查看实际执行计划。\n\n', [
      { id: 'call-1', name: 'keepseek_read_workspace_file', args: { path: 'discord_message.py' } }
    ], [{ toolCallId: 'call-1', content: JSON.stringify({ ok: true, path: 'discord_message.py' }) }])]
  });
  assert.deepEqual(nodes, [
    { kind: 'say', text: '我先只读查看实际执行计划。' },
    { kind: 'tool', id: 'call-1', name: 'keepseek_read_workspace_file', target: 'discord_message.py', status: 'succeeded' },
    { kind: 'say', text: '最终回答。' }
  ]);
});

test('multiple rounds keep their interleaved order', () => {
  const nodes = buildActivityNodes({
    content: 'A\n\nB\n\n答案',
    toolRounds: [
      round('A\n\n', [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
        [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }]),
      round('B\n\n', [
        { id: 'c2', name: 'keepseek_search_workspace', args: { query: 'signal_collect_message_kind' } },
        { id: 'c3', name: 'keepseek_read_workspace_file_range', args: { path: 'b.ts', startLine: 1, endLine: 20 } }
      ], [
        { toolCallId: 'c2', content: JSON.stringify({ ok: true }) },
        { toolCallId: 'c3', content: JSON.stringify({ ok: true }) }
      ])
    ]
  });
  assert.deepEqual(nodes?.map((node) => node.kind === 'say' ? `say:${node.text}` : `tool:${node.id}`), [
    'say:A', 'tool:c1', 'say:B', 'tool:c2', 'tool:c3', 'say:答案'
  ]);
});

test('tool status follows the recorded result, and a missing result is still running', () => {
  const nodes = buildActivityNodes({
    content: '',
    toolRounds: [round(null, [
      { id: 'failed', name: 'keepseek_read_workspace_file', args: { path: 'x.ts' } },
      { id: 'denied', name: 'keepseek_run_validation', args: { script: 'test' } },
      { id: 'pending', name: 'keepseek_git_status', args: {} }
    ], [
      { toolCallId: 'failed', content: JSON.stringify({ ok: false, errorType: 'read_failed', error: 'nope' }) },
      { toolCallId: 'denied', content: JSON.stringify({ ok: false, errorType: 'authorization_denied' }) }
    ])]
  });
  const statuses = toolNodes(nodes).map((node) => [node.id, node.status]);
  assert.deepEqual(statuses, [['failed', 'failed'], ['denied', 'denied'], ['pending', 'running']]);
});

test('durations come only from the recorded run details, never from wall clock', () => {
  const nodes = buildActivityNodes({
    content: '',
    toolRounds: [round(null, [
      { id: 'timed', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } },
      { id: 'untimed', name: 'keepseek_read_workspace_file', args: { path: 'b.ts' } }
    ], [
      { toolCallId: 'timed', content: JSON.stringify({ ok: true }) },
      { toolCallId: 'untimed', content: JSON.stringify({ ok: true }) }
    ])],
    toolDurations: { timed: 312 }
  });
  const tools = toolNodes(nodes);
  assert.equal(tools[0].durationMs, 312);
  assert.equal(Object.hasOwn(tools[1], 'durationMs'), false, 'no duration is invented');
});

test('the recovery prefix is stripped, so narration is never repeated', () => {
  // This is exactly what KeepseekChatViewProvider rebuilds on resume.
  const prefix = 'A' + 'B';
  const nodes = buildActivityNodes({
    content: prefix + '最终回答',
    toolRounds: [
      round('A', [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
        [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }]),
      round('B', [{ id: 'c2', name: 'keepseek_read_workspace_file', args: { path: 'b.ts' } }],
        [{ toolCallId: 'c2', content: JSON.stringify({ ok: true }) }])
    ]
  });
  assert.deepEqual(sayNodes(nodes), ['A', 'B', '最终回答']);
});

test('a final answer that does not start with the prefix is kept whole', () => {
  const nodes = buildActivityNodes({
    content: '这是完整回答，不含旁白。',
    toolRounds: [round('旁白。\n\n', [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
      [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }])]
  });
  assert.deepEqual(sayNodes(nodes), ['旁白。', '这是完整回答，不含旁白。']);
});

test('a fully consumed prefix leaves no empty trailing narration', () => {
  const nodes = buildActivityNodes({
    content: 'A',
    toolRounds: [round('A', [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
      [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }])]
  });
  assert.deepEqual(sayNodes(nodes), ['A']);
});

test('the node list is capped and says how many steps are missing', () => {
  const calls = Array.from({ length: 260 }, (_, index) => ({
    id: `c${index}`,
    name: 'keepseek_read_workspace_file',
    args: { path: `f${index}.ts` }
  }));
  const nodes = buildActivityNodes({
    content: '',
    toolRounds: [round(null, calls, calls.map((call) => ({ toolCallId: call.id, content: JSON.stringify({ ok: true }) })))]
  });
  assert.equal(nodes?.length, 200);
  const last = nodes?.[nodes.length - 1];
  assert.equal(last?.kind, 'say');
  assert.match((last as { text: string }).text, /61/u, 'the marker names the dropped step count');
});

test('a live tool is appended as a running step', () => {
  const nodes = buildActivityNodes({
    content: '',
    toolRounds: [round(null, [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
      [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }])],
    liveTool: { id: 'live', name: 'keepseek_search_workspace' }
  });
  const tools = toolNodes(nodes);
  assert.equal(tools.at(-1)?.id, 'live');
  assert.equal(tools.at(-1)?.status, 'running');
});

test('tool result bodies never reach the derived view', () => {
  const huge = JSON.stringify({ ok: true, content: 'x'.repeat(5_000) });
  const nodes = buildActivityNodes({
    content: '',
    toolRounds: [round(null, [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
      [{ toolCallId: 'c1', content: huge }])]
  });
  const serialized = JSON.stringify(nodes);
  assert.equal(serialized.includes('x'.repeat(64)), false);
  assert.equal(toolNodes(nodes)[0].target, 'a.ts');
});

test('both language catalogs define exactly the same activity keys', () => {
  const keysOf = (language: 'zh-CN' | 'en') => Object.keys(WEBVIEW_TRANSLATIONS[language])
    .filter((key) => key.startsWith('activity'))
    .sort();
  assert.deepEqual(keysOf('en'), keysOf('zh-CN'));
  assert.ok(keysOf('zh-CN').includes('activityShowMore'));
  assert.ok(keysOf('zh-CN').includes('activityToolFallback'));
  assert.ok(keysOf('zh-CN').includes('activityStatus_denied'));
});

test('describeToolTarget only promotes whitelisted arguments', () => {
  assert.equal(describeToolTarget('keepseek_read_workspace_file', { path: 'src/a.ts' }, 'zh-CN'), 'src/a.ts');
  assert.equal(describeToolTarget('keepseek_run_validation', { script: 'test' }, 'zh-CN'), 'test');
  assert.equal(describeToolTarget('keepseek_search_workspace', { query: 'needle' }, 'zh-CN'), 'needle');
  assert.equal(describeToolTarget('keepseek_search_workspace', { query: 'needle', path: 'src' }, 'en'), 'needle in src');
  assert.equal(describeToolTarget('keepseek_git_status', {}, 'zh-CN'), undefined);
  assert.equal(describeToolTarget('keepseek_list_workspace_files', { path: 'ignored' }, 'zh-CN'), undefined);
  assert.equal(describeToolTarget('keepseek_unknown_tool', { path: 'src/a.ts' }, 'zh-CN'), undefined);
  // A subagent prompt is never surfaced; only a short profile id may be shown.
  assert.equal(describeToolTarget('keepseek_delegate_task', { task: 'secret plan', profile: 'research' }, 'zh-CN'), 'research');
  assert.equal(describeToolTarget('keepseek_delegate_task', { task: 'secret plan' }, 'zh-CN'), undefined);
  assert.equal(describeToolTarget('keepseek_delegate_task', { task: 'x', profile: 'not a profile id!' }, 'zh-CN'), undefined);
});

test('describeToolTarget trims a command to executable plus three short arguments', () => {
  const long = 'a'.repeat(80);
  const target = describeToolTarget('keepseek_run_draft', {
    executable: 'psql',
    args: ['-c', 'EXPLAIN SELECT 1', long, 'fourth-argument-is-dropped']
  }, 'zh-CN');
  assert.ok(target?.startsWith('psql -c EXPLAIN SELECT 1 '));
  assert.equal(target?.includes('fourth-argument-is-dropped'), false, 'at most three arguments are shown');
  assert.equal(target?.includes(long), false, 'each argument is truncated');
  assert.ok((target ?? '').includes('…'));
  assert.ok((target ?? '').length <= 60);
});

test('describeToolTarget caps the whole target at 60 characters', () => {
  const target = describeToolTarget('keepseek_read_workspace_file', { path: `${'d'.repeat(120)}.ts` }, 'zh-CN');
  assert.equal(Array.from(target ?? '').length, 60);
  assert.ok((target ?? '').endsWith('…'));
});

test('describeToolTarget collapses whitespace in the target', () => {
  assert.equal(describeToolTarget('keepseek_read_workspace_file', { path: '  src/\n a.ts  ' }, 'zh-CN'), 'src/ a.ts');
});

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

test('visible messages expose nodes but still strip toolRounds', () => {
  const [visible] = getVisibleMessages([assistantMessage({
    content: '最终回答',
    toolRounds: [round(null, [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }],
      [{ toolCallId: 'c1', content: JSON.stringify({ ok: true }) }])],
    runDetails: {
      runId: 'r1', modelId: 'm', status: 'succeeded', startedAt: new Date().toISOString(),
      modelRequests: { requestCount: 1, providerAttemptCount: 1, usageResponseCount: 1, messageCount: 1, exposedToolCount: 1, thinkingEnabled: false },
      toolCallCount: 1,
      toolCalls: [{ id: 'c1', name: 'keepseek_read_workspace_file', startedAt: new Date().toISOString(), status: 'succeeded', durationMs: 120 }],
      authorizations: [], changeSets: [], validations: [], contextSources: [], contextDiscarded: [], truncated: false
    }
  })]);
  assert.equal(Object.hasOwn(visible, 'toolRounds'), false, 'toolRounds must stay stripped from the webview projection');
  const tools = toolNodes(visible.activityNodes);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].durationMs, 120, 'durations align by tool call id from run details');
});

test('a message without toolRounds gains no activity container', () => {
  const [visible] = getVisibleMessages([assistantMessage({ content: '纯文本回答' })]);
  assert.equal(visible.activityNodes, undefined);
});

test('user messages never produce activity nodes', () => {
  const [visible] = getVisibleMessages([{
    id: 'u1', role: 'user', content: '问题', createdAt: new Date().toISOString(),
    toolRounds: [round(null, [{ id: 'c1', name: 'keepseek_read_workspace_file', args: { path: 'a.ts' } }], [])]
  } as ChatMessage]);
  assert.equal(visible.activityNodes, undefined);
});