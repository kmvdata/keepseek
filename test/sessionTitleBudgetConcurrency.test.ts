import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession, ProviderUsageLedgerRecord } from '../src/shared/types';

interface BudgetHost {
  rememberSessionTitleCompletion(session: ChatSession, message: ChatMessage, response: AgentResponse,
    parent: Pick<AgentRequest, 'model' | 'sourceConfig'>): void;
  markSessionTitleDurable(sessionId: string, taskId: string): void;
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
    runBudget: createLogicalRunBudgetState({ modelRequests: 1, upstreamTokens: 300, treeUpstreamTokens: 300, usedMs: 500 }),
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
  const answer: ChatMessage = { id: 'final-answer', role: 'assistant', content: '请补充审批失败日志。', createdAt: '',
    userTask: link, runDetails: { status: 'succeeded' } as ChatMessage['runDetails'] };
  session.messages.push({ id: link.originMessageId, role: 'user', content: '排查 KeepSeek 审批失败', createdAt: '', userTask: link }, answer);
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
  return { host, session, link, answer, store, request, records, directory };
}

for (const cancelled of [false, true]) {
  test(`root title lease serializes continuation admission with one request left (${cancelled ? 'cancelled without usage' : 'settled usage'})`, async () => {
    const f = await fixture();
    const started = deferred<void>(), response = deferred<Response>();
    const originalFetch = globalThis.fetch;
    let posts = 0;
    let transportSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => {
      posts++;
      assert.equal(posts, 1, 'the continuation cannot use the same last physical request');
      transportSignal = init?.signal ?? undefined;
      started.resolve();
      if (cancelled) return new Promise<Response>((_resolve, reject) => {
        transportSignal?.addEventListener('abort', () => reject(transportSignal?.reason), { once: true });
      });
      return response.promise;
    }) as typeof fetch;
    try {
      f.host.rememberSessionTitleCompletion(f.session, f.answer, {} as AgentResponse, f.request);
      f.host.markSessionTitleDurable(f.session.id, f.link.id);
      f.host.flushSessionTitleCompletions();
      const lease = f.host.sessionTitleBudgetLeases.get(JSON.stringify([f.session.id, f.link.id]));
      assert.ok(lease, 'the production drain occupies the ledger before asynchronous claiming/resolution');
      await started.promise;
      const reserved = structuredClone(f.session.userTaskBudgets![f.link.id]);
      assert.equal(reserved.runBudget!.modelRequests, 2);
      assert.ok(reserved.runBudget!.upstreamTokens > 300);
      let loaded = false;
      const continuationBudget = f.host.loadTaskBudget(f.session, { ...f.link, reason: 'recovery' }).then(latest => {
        loaded = true; return latest;
      });
      await Promise.resolve(); await Promise.resolve();
      assert.equal(loaded, false, 'the continuation cannot read an uncommitted reservation or stale checkpoint');
      // An independent accounting update arriving while the title is in flight
      // must survive its delta settlement; only the title's reservation is freed.
      const latest = f.session.userTaskBudgets![f.link.id];
      latest.usedMs += 1000;
      latest.runBudget!.usedMs += 1000;
      latest.runBudget!.toolCalls = 7;
      latest.usedCostByCurrency = { USD: 2 };
      if (cancelled) f.host.sessionTitles.cancel(f.session.id);
      else response.resolve(new Response(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '{"decision":"defer","title":null}' }, finish_reason: 'stop' }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
        + '\n\ndata: [DONE]\n\n'));
      await lease;
      const budget = await continuationBudget;
      assert.ok(budget);
      assert.equal(budget.runBudget!.modelRequests, 2, 'settlement never refunds a physical attempt');
      assert.equal(budget.runBudget!.toolCalls, 7);
      assert.ok(budget.usedMs >= 1500);
      assert.equal(budget.usedCostByCurrency!.USD, 2);
      assert.equal(budget.runBudget!.upstreamTokens, cancelled ? reserved.runBudget!.upstreamTokens : 420);
      assert.equal(transportSignal?.aborted, cancelled);
      // This is the same checkpoint inheritance used by continueAgentTask,
      // followed by the actual AgentRunner admission and Provider transport.
      const cp = createRunCheckpoint(f.request, 0, 'budget concurrency regression', []);
      inheritTaskBudget(cp, budget);
      const resumed = await new AgentRunner().run({ ...f.request, checkpoint: cp });
      assert.equal(resumed.runDetails.budgetStopReason, 'model_request_budget_exhausted');
      assert.equal(posts, 1);
      assert.ok(f.records.some(record => record.kind === (cancelled ? 'attempt_without_usage' : 'usage_response')));
    } finally {
      globalThis.fetch = originalFetch;
      f.host.sessionTitles.dispose();
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

test('continuation admitted first holds the title until its latest root allowance is persisted', async () => {
  const f = await fixture();
  const started = deferred<void>(), response = deferred<Response>();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => { posts++; started.resolve(); return response.promise; }) as typeof fetch;
  try {
    f.host.rememberSessionTitleCompletion(f.session, f.answer, {} as AgentResponse, f.request);
    f.host.markSessionTitleDurable(f.session.id, f.link.id);
    const budget = await f.host.loadTaskBudget(f.session, { ...f.link, reason: 'recovery' });
    assert.ok(budget);
    const cp = createRunCheckpoint(f.request, 0, 'continuation admitted first', []);
    inheritTaskBudget(cp, budget);
    f.host.isBusy = true;
    const continuation = new AgentRunner().run({ ...f.request, checkpoint: cp }, {
      onCheckpoint: async next => { f.session.userTaskBudgets![f.link.id] = taskBudgetFromCheckpoint(next); await f.store.persist(); }
    });
    await started.promise;
    f.host.flushSessionTitleCompletions();
    assert.equal(f.host.sessionTitleBudgetLeases.size, 0, 'same-root runtime ownership prevents a title reading its old allowance');
    assert.equal(posts, 1);
    response.resolve(new Response(
      'data: ' + JSON.stringify({ choices: [{ delta: { content: 'The task has a final answer.' }, finish_reason: 'stop' }] })
      + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
      + '\n\ndata: [DONE]\n\n'));
    await continuation;
    assert.equal(f.session.userTaskBudgets![f.link.id].runBudget!.modelRequests, 2);
    f.host.isBusy = false;
    f.host.flushSessionTitleCompletions();
    const lease = f.host.sessionTitleBudgetLeases.get(JSON.stringify([f.session.id, f.link.id]));
    assert.ok(lease);
    await lease;
    assert.equal(posts, 1, 'title admission observes the continuation reservation rather than reusing an old snapshot');
    assert.equal(f.session.autoTitle?.lastOutcome, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
    f.host.sessionTitles.dispose();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
