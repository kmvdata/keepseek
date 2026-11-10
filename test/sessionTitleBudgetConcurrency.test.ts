import './registerVscodeStub';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import { ChatSessionStore, createEmptySession, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { AgentRunner } from '../src/agent/runner';
import { createRunCheckpoint, inheritTaskBudget } from '../src/agent/runCheckpoint';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import { taskBudgetFromCheckpoint } from '../src/sessions/userTaskBudget';
import type { UserTaskLink } from '../src/sessions/userTask';
import { SESSION_TITLE_SYSTEM_PROMPT } from '../src/sessions/sessionTitle';
import type { AgentRequest, AgentTaskBudgetAuthority, ChatMessage, ChatSession, ProviderUsageLedgerRecord } from '../src/shared/types';

interface BudgetHost {
  rememberSessionTitleSubmission(session: ChatSession, message: ChatMessage,
    parent: Pick<AgentRequest, 'model' | 'sourceConfig'>, liveBudget?: Promise<AgentTaskBudgetAuthority>): void;
  flushSessionTitleCompletions(): void;
  loadTaskBudget(session: ChatSession, link: UserTaskLink, ownsLease?: boolean): Promise<UserTaskBudget | undefined>;
  sessionTitleBudgetLeases: Map<string, Promise<void>>;
  sessionTitles: SessionTitleCoordinator;
  isBusy: boolean;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function taskBudget(): UserTaskBudget {
  return {
    version: 1, usedMs: 500, maxExecutionMs: 0, maxCost: 0, usedCostByCurrency: {},
    runBudget: createLogicalRunBudgetState({ modelRequests: 0, upstreamTokens: 0, treeUpstreamTokens: 0, usedMs: 500 }),
    budgetLimits: { maxModelRequests: 2, maxToolRounds: 0, maxToolCalls: 0, maxContinuations: 0,
      maxContextEpochRollovers: 0, maxUpstreamTokens: 100_000, maxTreeUpstreamTokens: 100_000,
      maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 }
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'keepseek-title-budget-lease-'));
  const globalStorageUri = vscode.Uri.file(directory);
  const scope = { key: 'workspace:title-budget', name: 'Title budget', folderUris: [] };
  const initial = createEmptySession('en', scope);
  let saved: StoredWorkspaceSessionState = { activeSessionId: initial.id, sessions: [initial] };
  const storage = {
    loadWorkspace: async () => structuredClone(saved),
    saveWorkspace: async (_scope: unknown, next: StoredWorkspaceSessionState) => { saved = structuredClone(next); },
    listAllWorkspaceSummaries: async () => [], loadWorkspaceSessions: async () => structuredClone(saved.sessions),
    deleteWorkspaceSessions: async () => {}, deleteEntireWorkspace: async () => {}, cleanupExpiredSessions: async () => false
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  const link: UserTaskLink = { version: 1, id: 'root-budget', originMessageId: 'real-user', reason: 'user' };
  const user: ChatMessage = { id: link.originMessageId, role: 'user', content: '排查 KeepSeek 审批失败', createdAt: '', userTask: link };
  session.messages.push(user);
  session.userTaskBudgets = { [link.id]: taskBudget() };
  await store.persist();
  const sourceStore = new ModelSourceStore(globalStorageUri);
  await sourceStore.createSource({ id: 'completed-source', provider: 'openai-compatible', apiKey: 'resolved-key',
    baseUrl: 'https://lease.invalid/v1', models: [{ id: 'completed-model', contextWindowTokens: 32_768, maxOutputTokens: 8192 }] });
  const request: AgentRequest = { prompt: 'Continue the task',
    model: { id: 'completed-model', label: 'Completed', provider: 'openai-compatible', sourceId: 'completed-source',
      contextWindowTokens: 32_768, maxOutputTokens: 8192 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], history: [], language: 'en', requestProtocolVersion: 8, sessionId: session.id,
    sourceConfig: { sourceId: 'completed-source', provider: 'openai-compatible', apiKey: 'resolved-key',
      baseUrl: 'https://lease.invalid/v1', supportsBilling: false } };
  const records: ProviderUsageLedgerRecord[] = [];
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    sessionStore: store, sessionTitleCandidates: new Map(), sessionTitleDrains: new Set(), sessionTitleBudgetLeases: new Map(),
    sessionTitleDiagnostics: new Map(), manualSessionTitleRequests: new Map(), titleLifecycleDisposed: false,
    sessionReady: true, approvalDataReady: true, requestContextReady: false, language: 'en',
    isBusy: false, delegatedApprovalInFlight: false, draftRunAutoContinueInFlight: false, activeChangeActions: new Set(),
    delegatedApprovals: { hasPending: () => false }, draftRunBatches: { pending: false },
    backgroundRunCoordinator: { getActiveRun: () => undefined }, getRootTaskDraftRuns: () => [],
    globalStorageUri, sourceStore, subagentSettingsStore: new SubagentSettingsStore(globalStorageUri, scope.key),
    subagentModelSetting: { version: 1, mode: 'follow-main', updatedAt: new Date().toISOString() },
    applyUsageLedgerRecord: async (_session: ChatSession, record: ProviderUsageLedgerRecord) => { records.push(record); },
    t: (key: string) => key
  }) as BudgetHost;
  host.sessionTitles = new SessionTitleCoordinator(store);
  return { host, session, link, user, store, request, records, directory };
}

function reply(text: string): Response {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
    + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    + '\n\ndata: [DONE]\n\n');
}

for (const cancelled of [false, true]) {
  test(`input title and main request share live reservations without waiting for either answer (${cancelled ? 'cancelled title without usage' : 'settled title usage'})`, async () => {
    const f = await fixture();
    const mainPosted = deferred<void>(), titlePosted = deferred<void>();
    const mainResponse = deferred<Response>(), titleResponse = deferred<Response>();
    const liveReady = deferred<AgentTaskBudgetAuthority>();
    let authority: AgentTaskBudgetAuthority | undefined;
    const originalFetch = globalThis.fetch;
    const posts: string[] = [];
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const title = body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT;
      posts.push(title ? 'title' : 'main');
      assert.ok(posts.length <= 2, 'both requests share the same two-slot root allowance');
      if (title) {
        titlePosted.resolve();
        if (cancelled) return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
        return titleResponse.promise;
      }
      mainPosted.resolve();
      return mainResponse.promise;
    }) as typeof fetch;
    let main: ReturnType<AgentRunner['run']> | undefined;
    try {
      f.host.rememberSessionTitleSubmission(f.session, f.user, f.request, liveReady.promise);
      f.host.flushSessionTitleCompletions();
      const titleLease = f.host.sessionTitleBudgetLeases.get(JSON.stringify([f.session.id, f.link.id]));
      assert.ok(titleLease, 'accepted input has an isolated auxiliary lifecycle');
      const budget = f.session.userTaskBudgets![f.link.id];
      const cp = createRunCheckpoint(f.request, 0, 'parallel input purpose title', []);
      inheritTaskBudget(cp, budget);
      main = new AgentRunner().run({ ...f.request, checkpoint: cp }, {
        onTaskBudgetReady: live => { authority = live; },
        onFirstModelRequestAdmitted: () => { liveReady.resolve(authority!); },
        onCheckpoint: async next => {
          f.session.userTaskBudgets![f.link.id] = taskBudgetFromCheckpoint(next);
          await f.store.persist();
        }
      });
      await Promise.all([mainPosted.promise, titlePosted.promise]);
      assert.deepEqual([...posts].sort(), ['main', 'title']);
      assert.equal(authority!.run.state.modelRequests, 2);
      assert.equal(f.host.sessionTitles.isRunning(f.session.id), true, 'the main request launched while the title response was pending');
      // Shared authority absorbs newer counters; title settlement cannot merge
      // an old clone over main/child work or add a second wall clock.
      authority!.run.state.toolCalls = 7;
      authority!.cost.record(2, 'USD');
      if (cancelled) f.host.sessionTitles.cancel(f.session.id);
      else titleResponse.resolve(reply('{"decision":"defer","title":null}'));
      await titleLease;
      assert.equal(authority!.run.state.modelRequests, 2, 'a physical title attempt never refunds its request slot');
      assert.equal(authority!.run.state.toolCalls, 7);
      assert.equal(authority!.cost.snapshot().USD, 2);
      mainResponse.resolve(reply('Complete main task answer'));
      await main;
      const saved = f.session.userTaskBudgets![f.link.id];
      assert.equal(saved.runBudget!.modelRequests, 2);
      assert.equal(saved.runBudget!.toolCalls, 7);
      assert.equal(saved.usedCostByCurrency!.USD, 2);
      assert.equal(saved.runBudget!.upstreamTokens, cancelled ? authority!.run.state.upstreamTokens : 240);
      if (cancelled) assert.ok(saved.runBudget!.upstreamTokens > 120, 'unknown dispatched title usage retains its own conservative reservation');
      assert.equal(posts.length, 2);
      assert.ok(f.records.some(record => record.kind === (cancelled ? 'attempt_without_usage' : 'usage_response')));
    } finally {
      mainResponse.resolve(reply('Main cleanup answer'));
      titleResponse.resolve(reply('{"decision":"defer","title":null}'));
      await main?.catch(() => {});
      globalThis.fetch = originalFetch;
      f.host.sessionTitles.dispose();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

test('one remaining shared request slot belongs to the main request while the eager title fails closed without another POST', async () => {
  const f = await fixture();
  f.session.userTaskBudgets![f.link.id].budgetLimits!.maxModelRequests = 1;
  const liveReady = deferred<AgentTaskBudgetAuthority>();
  const mainPosted = deferred<void>(), mainResponse = deferred<Response>();
  let authority: AgentTaskBudgetAuthority | undefined;
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => { posts++; mainPosted.resolve(); return mainResponse.promise; }) as typeof fetch;
  let main: ReturnType<AgentRunner['run']> | undefined;
  try {
    f.host.rememberSessionTitleSubmission(f.session, f.user, f.request, liveReady.promise);
    f.host.flushSessionTitleCompletions();
    const titleLease = f.host.sessionTitleBudgetLeases.get(JSON.stringify([f.session.id, f.link.id]));
    assert.ok(titleLease);
    const cp = createRunCheckpoint(f.request, 0, 'main-first scarce shared allowance', []);
    inheritTaskBudget(cp, f.session.userTaskBudgets![f.link.id]);
    main = new AgentRunner().run({ ...f.request, checkpoint: cp }, {
      onTaskBudgetReady: live => { authority = live; },
      onFirstModelRequestAdmitted: () => { liveReady.resolve(authority!); },
      onCheckpoint: async next => { f.session.userTaskBudgets![f.link.id] = taskBudgetFromCheckpoint(next); await f.store.persist(); }
    });
    await mainPosted.promise;
    await titleLease;
    assert.equal(posts, 1);
    assert.equal(f.session.autoTitle?.stopped, undefined);
    assert.equal(f.session.autoTitle?.lastOutcome, 'failed');
    assert.equal(authority!.run.state.modelRequests, 1);
    mainResponse.resolve(reply('Main purpose response'));
    await main;
    assert.equal(posts, 1, 'no automatic title retry is manufactured by the final assistant answer');
    assert.equal(f.session.userTaskBudgets![f.link.id].runBudget!.modelRequests, 1);
  } finally {
    mainResponse.resolve(reply('Main cleanup'));
    await main?.catch(() => {});
    globalThis.fetch = originalFetch;
    f.host.sessionTitles.dispose();
    rmSync(f.directory, { recursive: true, force: true });
  }
});


test('the local draft shortcut publishes a durable root allowance and permits one input title without a main POST', async () => {
  const f = await fixture();
  const folders = vscode.workspace.workspaceFolders;
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(f.directory), name: 'Input title shortcut' }] });
  const channel = (f.host as unknown as {
    createSessionTitleBudgetChannel(): { ready: Promise<AgentTaskBudgetAuthority>; setAuthority(value: AgentTaskBudgetAuthority): void; open(): void; finish(): void }
  }).createSessionTitleBudgetChannel();
  const originalFetch = globalThis.fetch;
  let titlePosts = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    assert.equal(body.messages[0]?.content, SESSION_TITLE_SYSTEM_PROMPT, 'the local draft must not issue a main-model request');
    titlePosts++;
    return reply('{"decision":"set","title":"准备文档修改"}');
  }) as typeof fetch;
  try {
    f.user.content = '/draft purpose-draft.txt\nAdd the requested documentation text';
    await f.store.persist();
    f.host.rememberSessionTitleSubmission(f.session, f.user, f.request, channel.ready);
    f.host.flushSessionTitleCompletions();
    const titleLease = f.host.sessionTitleBudgetLeases.get(JSON.stringify([f.session.id, f.link.id]));
    assert.ok(titleLease);
    const main = await new AgentRunner().run({ ...f.request, prompt: f.user.content }, {
      onTaskBudgetReady: channel.setAuthority,
      onFirstModelRequestAdmitted: channel.open,
      onTaskBudgetSettled: channel.finish,
      onCheckpoint: async next => { f.session.userTaskBudgets![f.link.id] = taskBudgetFromCheckpoint(next); await f.store.persist(); }
    });
    await titleLease;
    assert.equal(main.draftEdits.length, 1);
    assert.equal(existsSync(join(f.directory, 'purpose-draft.txt')), false, 'the shortcut only prepares a draft');
    assert.equal(titlePosts, 1);
    assert.equal(f.session.title, '准备文档修改');
    assert.equal(f.session.autoTitle?.stopped, 'named');
    assert.equal(f.session.userTaskBudgets![f.link.id].runBudget!.modelRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(vscode.workspace, { workspaceFolders: folders });
    f.host.sessionTitles.dispose();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
