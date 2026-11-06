import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import type { SubagentModelSetting } from '../src/agent/subagents/types';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { createManualSessionTitleBudget, requestSessionTitle, restoreSessionTitleBudget, mergeSessionTitleTaskBudget } from '../src/provider/sessionTitleRequest';
import { OneShotTextRequestError } from '../src/agent/oneShotTextRequest';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import { normalizeUserTaskBudgets } from '../src/sessions/userTaskBudget';
import type { ProviderUsageLedgerRecord } from '../src/shared/types';

function budget(): UserTaskBudget {
  return { version: 1, usedMs: 500, maxExecutionMs: 60_000, maxCost: 0, usedCostByCurrency: {},
    runBudget: createLogicalRunBudgetState({ modelRequests: 3, upstreamTokens: 300, treeUpstreamTokens: 300, usedMs: 500 }),
    budgetLimits: { maxModelRequests: 10, maxToolRounds: 0, maxToolCalls: 0, maxContinuations: 0,
      maxContextEpochRollovers: 0, maxUpstreamTokens: 100_000, maxTreeUpstreamTokens: 100_000,
      maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 } };
}

test('explicit title regeneration has one small serializable allowance independent of an old task deadline', () => {
  const now = Date.now();
  const oldTask = budget();
  oldTask.runBudget!.deadlineAt = new Date(now - 1).toISOString();
  assert.throws(() => restoreSessionTitleBudget(oldTask, now), /time budget is exhausted/u);
  const manual = createManualSessionTitleBudget(now);
  assert.equal(manual.maxExecutionMs, 20_000);
  assert.equal(manual.usedMs, 0);
  assert.equal(manual.runBudget!.deadlineAt, new Date(now + 20_000).toISOString());
  assert.equal(manual.budgetLimits!.maxModelRequests, 1);
  assert.equal(manual.budgetLimits!.maxUpstreamTokens, 32_768);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeUserTaskBudgets(JSON.parse(JSON.stringify({ manual }))).manual)), manual);
  const restored = restoreSessionTitleBudget(manual, now);
  restored.run.reservePhysicalRequest(100, 256);
  assert.throws(() => restored.run.reservePhysicalRequest(100, 256), /model_request_budget_exhausted/u);
  assert.equal(oldTask.runBudget!.modelRequests, 3, 'explicit regeneration never resets the original task counters');
});

test('explicit title regeneration keeps stricter configured time, token and cost limits', () => {
  const original = vscode.workspace.getConfiguration;
  const overrides: Record<string, number> = {
    'agent.maxExecutionMs': 5_000, 'agent.subagentMaxExecutionMs': 10_000,
    'agent.subagentMaxUpstreamTokens': 15_000, 'agent.maxTreeUpstreamTokens': 12_000, 'agent.maxCost': 0.25
  };
  vscode.workspace.getConfiguration = ((...args: Parameters<typeof original>) => {
    const config = original(...args);
    return { ...config, get: <T>(key: string, fallback: T): T => (overrides[key] ?? config.get(key, fallback)) as T };
  }) as typeof original;
  try {
    const manual = createManualSessionTitleBudget();
    assert.equal(manual.maxExecutionMs, 5_000);
    assert.equal(manual.budgetLimits!.maxUpstreamTokens, 12_000);
    assert.equal(manual.budgetLimits!.maxTreeUpstreamTokens, 12_000);
    assert.equal(manual.maxCost, 0.25);
    assert.equal(restoreSessionTitleBudget(manual).cost.limit, 0.25);
  } finally { vscode.workspace.getConfiguration = original; }
});

test('title restores remaining task allowance and the stricter execution/deadline limit', () => {
  const now = Date.now();
  const before = budget(); before.usedMs = 59_200;
  const restored = restoreSessionTitleBudget(before, now);
  assert.equal(restored.timeoutMs, 800);
  assert.equal(restored.run.state.modelRequests, 3);
  assert.equal(restored.run.state.upstreamTokens, 300);
  const expired = budget(); expired.runBudget!.deadlineAt = new Date(now - 1).toISOString();
  assert.throws(() => restoreSessionTitleBudget(expired, now), /time budget is exhausted/u);
  const consumed = budget(); consumed.budgetLimits!.maxModelRequests = 3;
  assert.throws(() => restoreSessionTitleBudget(consumed), /model_request_budget_exhausted/u);
  const legacy = budget(); delete legacy.budgetLimits;
  assert.throws(() => restoreSessionTitleBudget(legacy), /budget is unavailable/u);
});

test('title budget delta keeps newer task fields and permits its own reservation settlement', () => {
  const before = budget(); before.usedCostByCurrency = { USD: 1 };
  const reserved = structuredClone(before);
  reserved.usedMs += 10; reserved.runBudget!.usedMs += 10;
  reserved.runBudget!.modelRequests++; reserved.runBudget!.upstreamTokens += 2_000;
  reserved.runBudget!.treeUpstreamTokens += 2_000; reserved.usedCostByCurrency = { USD: 1.2 };
  const current = structuredClone(before);
  current.commandRecoveryKeys = ['a'.repeat(64)];
  current.runBudget!.toolCalls = 7;
  const merged = mergeSessionTitleTaskBudget(current, before, reserved);
  const later = structuredClone(merged); later.runBudget!.modelRequests++;
  later.runBudget!.upstreamTokens += 100; later.runBudget!.treeUpstreamTokens += 100;
  const settled = structuredClone(reserved);
  settled.usedCostByCurrency = { USD: 1.05 };
  settled.runBudget!.upstreamTokens -= 1_880; settled.runBudget!.treeUpstreamTokens -= 1_880;
  const result = mergeSessionTitleTaskBudget(later, reserved, settled);
  assert.equal(result.runBudget!.modelRequests, 5);
  assert.equal(result.runBudget!.upstreamTokens, 520);
  assert.equal(result.runBudget!.toolCalls, 7);
  assert.equal(result.usedMs, 510);
  assert.ok(Math.abs(result.usedCostByCurrency!.USD - 1.05) < 0.00001);
  assert.deepEqual(result.commandRecoveryKeys, current.commandRecoveryKeys);
});

test('title follow-main freezes the completed source and records usage against the owning root allowance', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keepseek-title-source-'));
  const storageUri = vscode.Uri.file(directory);
  let release!: (value: SubagentModelSetting) => void;
  const settingReady = new Promise<SubagentModelSetting>(resolve => { release = resolve; });
  class DelayedSettings extends SubagentSettingsStore {
    override async load(): Promise<SubagentModelSetting> { return settingReady; }
  }
  const settings = new DelayedSettings(storageUri, 'workspace:title');
  const sourceStore = new ModelSourceStore(storageUri);
  const parentRequest = {
    model: { id: 'completed-model', label: 'Completed', provider: 'openai-compatible', sourceId: 'completed-source', contextWindowTokens: 32768, maxOutputTokens: 8192 },
    sourceConfig: { sourceId: 'completed-source', provider: 'openai-compatible' as const, apiKey: 'test', baseUrl: 'https://completed.invalid/v1', supportsBilling: false }
  };
  const originalFetch = globalThis.fetch;
  const ledger: ProviderUsageLedgerRecord[] = [];
  const initial = budget(); let previous = structuredClone(initial); let latest = structuredClone(initial);
  let dispatched = 0;
  try {
    globalThis.fetch = (async (url, init) => {
      dispatched++;
      assert.match(String(url), /^https:\/\/completed\.invalid/u);
      assert.equal(JSON.parse(String(init?.body)).model, 'completed-model');
      assert.equal(latest.runBudget!.modelRequests, 4, 'reservation is saved before transport');
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"decision":"set","title":"审批排查"}' }, finish_reason: 'stop' }] })
        + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\ndata: [DONE]\n\n');
    }) as typeof fetch;
    const pending = requestSessionTitle({ globalStorageUri: storageUri, workspaceKey: 'workspace:title', sourceStore, settingsStore: settings,
      parentRequest, language: 'zh-CN', sessionId: 'session-a', taskId: 'root-task', userPrompt: '{"messages":[]}', token: 'attempt-token',
      signal: new AbortController().signal, taskBudget: initial,
      onUsageLedgerRecord: record => { ledger.push(record); },
      onBudgetChanged: next => { latest = mergeSessionTitleTaskBudget(latest, previous, next); previous = structuredClone(next); } });
    parentRequest.model.id = 'new-picker-model'; parentRequest.sourceConfig.baseUrl = 'https://new.invalid/v1';
    release({ version: 1, mode: 'follow-main', updatedAt: new Date().toISOString() });
    assert.equal(await pending, '{"decision":"set","title":"审批排查"}');
    assert.equal(dispatched, 1);
    assert.equal(ledger[0].sourceId, 'completed-source');
    assert.equal(ledger[0].originalModelId, 'completed-model');
    assert.equal(ledger[0].requestId, 'session_title_attempt-token');
    assert.equal(latest.runBudget!.modelRequests, 4);
    assert.equal(latest.runBudget!.upstreamTokens, 420);
    assert.deepEqual(initial, budget(), 'the captured budget object is not overwritten');
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('missing fixed title model never falls back to the completed main source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keepseek-title-fixed-'));
  const storageUri = vscode.Uri.file(directory);
  const settingsStore = new SubagentSettingsStore(storageUri, 'workspace:title');
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    await settingsStore.save({ mode: 'fixed', sourceId: 'missing', modelId: 'missing' });
    globalThis.fetch = (async () => { calls++; throw new Error('must not dispatch'); }) as typeof fetch;
    await assert.rejects(requestSessionTitle({ globalStorageUri: storageUri, workspaceKey: 'workspace:title', sourceStore: new ModelSourceStore(storageUri), settingsStore,
      parentRequest: { model: { id: 'main', label: 'Main', provider: 'openai-compatible' },
        sourceConfig: { sourceId: 'main', provider: 'openai-compatible', apiKey: 'test', baseUrl: 'https://main.invalid', supportsBilling: false } },
      language: 'en', sessionId: 'session', taskId: 'root', userPrompt: '{}', token: 'token', signal: new AbortController().signal,
      taskBudget: budget(), onUsageLedgerRecord: () => undefined }), (error: unknown) =>
        error instanceof OneShotTextRequestError && error.reason === 'unavailable' && /missing, disabled, or unavailable/u.test(error.message));
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});

test('a captured explicit subagent setting cannot be replaced by later settings or picker changes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'keepseek-title-setting-snapshot-'));
  const storageUri = vscode.Uri.file(directory);
  const settingsStore = new SubagentSettingsStore(storageUri, 'workspace:title');
  const sourceStore = new ModelSourceStore(storageUri);
  let settingsReads = 0, calls = 0;
  settingsStore.load = async () => { settingsReads++; throw new Error('the click setting must already be frozen'); };
  const setting: Pick<SubagentModelSetting, 'mode' | 'sourceId' | 'modelId'> = { mode: 'follow-main' };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).model, 'captured-main');
      return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"decision":"set","title":"模型选择快照"}' }, finish_reason: 'stop' }] })
        + '\n\ndata: [DONE]\n\n');
    }) as typeof fetch;
    const pending = requestSessionTitle({ globalStorageUri: storageUri, workspaceKey: 'workspace:title', sourceStore, settingsStore,
      setting, parentRequest: { model: { id: 'captured-main', label: 'Main', provider: 'openai-compatible' },
        sourceConfig: { sourceId: 'captured-source', provider: 'openai-compatible', apiKey: 'test', baseUrl: 'https://captured.invalid/v1', supportsBilling: false } },
      language: 'en', sessionId: 'session', taskId: 'root', userPrompt: '{}', token: 'snapshot-token', signal: new AbortController().signal,
      taskBudget: budget(), onUsageLedgerRecord: () => undefined });
    setting.mode = 'fixed'; setting.sourceId = 'missing'; setting.modelId = 'missing';
    assert.equal(await pending, '{"decision":"set","title":"模型选择快照"}');
    assert.equal(settingsReads, 0);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; rmSync(directory, { recursive: true, force: true }); }
});
