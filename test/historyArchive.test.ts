import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  archiveContextSourcesBeyondBudget,
  capOversizedFirstUserProviderContent,
  maintainArchivedToolResults,
  searchHistoryArchive
} from '../src/agent/historyArchive';
import type { AgentToolRound, ChatMessage, ChatSession } from '../src/shared/types';

test('snip and prune archive stale tool results without breaking the tool-call group', () => {
  const original = `src/large.ts:1\n${'useful implementation detail\n'.repeat(900)}src/large.ts:900`;
  const round: AgentToolRound = {
    assistantContent: null,
    reasoningContent: 'inspect the file',
    toolCalls: [{
      id: 'call-read',
      type: 'function',
      function: { name: 'keepseek_read_workspace_file_range', arguments: '{}' }
    }],
    toolResults: [{ toolCallId: 'call-read', content: original }]
  };
  const session = createSession([
    message('u1', 'user', 'inspect'),
    { ...message('a1', 'assistant', 'done'), toolRounds: [round] },
    message('u2', 'user', 'next'),
    message('a2', 'assistant', 'ok')
  ]);

  const snipped = maintainArchivedToolResults(session, 'snip', 1);
  assert.equal(snipped.resultCount, 1);
  assert.equal(session.historyArchive?.length, 1);
  assert.equal(session.historyArchive?.[0]?.content, original);
  assert.equal(round.toolCalls.length, 1);
  assert.equal(round.toolResults.length, 1);
  assert.match(round.toolResults[0].content, /^\[snipped tool result/u);
  const archiveId = session.historyArchive?.[0]?.id;
  assert.ok(archiveId);
  assert.match(round.toolResults[0].content, new RegExp(archiveId!));

  const pruned = maintainArchivedToolResults(session, 'prune', 1);
  assert.equal(pruned.resultCount, 1);
  assert.equal(session.historyArchive?.length, 1);
  assert.equal(session.historyArchive?.[0]?.content, original);
  assert.match(round.toolResults[0].content, /^\[elided tool result/u);
  assert.match(round.toolResults[0].content, new RegExp(archiveId!));
});

test('archive maintenance preserves failures and high-risk tool results', () => {
  const failure = '{"ok":false,"error":"test failure: expected 1, got 2"}'.repeat(100);
  const deletion = 'delete authorization details'.repeat(100);
  const session = createSession([
    message('u1', 'user', 'validate'),
    {
      ...message('a1', 'assistant', 'failed'),
      toolRounds: [{
        assistantContent: null,
        reasoningContent: 'validate',
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'keepseek_read_workspace_file_range', arguments: '{}' } },
          { id: 'c2', type: 'function', function: { name: 'keepseek_delete_workspace_file', arguments: '{}' } }
        ],
        toolResults: [
          { toolCallId: 'c1', content: failure },
          { toolCallId: 'c2', content: deletion }
        ]
      }]
    },
    message('u2', 'user', 'next'),
    message('a2', 'assistant', 'ok')
  ]);

  const result = maintainArchivedToolResults(session, 'prune', 1);
  assert.equal(result.changed, false);
  assert.equal(session.historyArchive, undefined);
});

test('local archive search returns bounded relevant excerpts without a model call', () => {
  const session = createSession([]);
  session.historyArchive = [
    {
      id: 'archive-auth',
      messageId: 'a1',
      toolName: 'keepseek_read_workspace_file_range',
      role: 'tool',
      content: 'src/auth.ts validateSession refresh token cookie authorization bug',
      contentHash: 'hash-auth',
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'archive-css',
      messageId: 'a2',
      toolName: 'keepseek_read_workspace_file_range',
      role: 'tool',
      content: 'src/theme.css sidebar spacing and blue color',
      contentHash: 'hash-css',
      createdAt: '2026-01-01T00:00:01.000Z'
    }
  ];

  const hits = searchHistoryArchive(session.historyArchive, 'validateSession auth token', {
    maxResults: 1,
    maxChars: 200
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.id, 'archive-auth');
  assert.ok((hits[0]?.snippet.length ?? 0) <= 200);
});

test('oversized first request stays complete locally while provider projection is bounded and retrievable', () => {
  const original = `important constraint: preserve errors\n${'reference payload '.repeat(4_000)}\ntail fact: use pnpm`;
  const first = message('u1', 'user', original);
  first.expandedContent = original;
  const session = createSession([first]);
  const result = capOversizedFirstUserProviderContent(session, 4_000);

  assert.equal(result.changed, true);
  assert.equal(first.content, original);
  assert.equal(first.expandedContent, original);
  assert.ok((first.providerContent?.length ?? 0) <= 4_000);
  assert.match(first.providerContent ?? '', /important constraint/u);
  assert.match(first.providerContent ?? '', /tail fact/u);
  assert.equal(session.historyArchive?.[0]?.content, original);
  assert.equal(searchHistoryArchive(session.historyArchive, 'pnpm tail fact')[0]?.id, session.historyArchive?.[0]?.id);
});

test('context sources beyond the shared prompt budget are archived for local recall', () => {
  const session = createSession([]);
  const result = archiveContextSourcesBeyondBudget(session, [
    { id: 'project', kind: 'project-instructions', content: 'project rule' },
    { id: 'attachment', kind: 'context-file', content: `unique-middle-fact ${'payload '.repeat(500)}` }
  ], 100);
  assert.equal(result.changed, true);
  assert.equal(session.historyArchive?.length, 1);
  assert.equal(session.historyArchive?.[0]?.messageId, 'context:attachment');
  assert.equal(searchHistoryArchive(session.historyArchive, 'unique-middle-fact')[0]?.id, session.historyArchive?.[0]?.id);
});

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessage {
  return { id, role, content, createdAt: `2026-01-01T00:00:0${id.endsWith('1') ? '1' : '2'}.000Z` };
}

function createSession(messages: ChatMessage[]): ChatSession {
  return {
    id: 'session-archive',
    title: 'Archive',
    messages,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: 'workspace:test',
    workspaceName: 'Test',
    workspaceFolders: [],
    isFavorite: false
  };
}
