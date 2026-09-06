import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { resolveConfiguredSubagentModel } from '../src/accounts/subagentModelResolver';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import { ApprovalCircuitBreaker } from '../src/approvals/approvalCircuitBreaker';
import {
  findDeterministicReviewDenial,
  findSensitiveEvidence,
  parseApprovalReviewerJson,
  serializeApprovalReviewRequest
} from '../src/approvals/approvalPolicy';
import { ApprovalReviewerService } from '../src/approvals/approvalReviewer';
import { createBoundedReviewText, hashApprovalValue } from '../src/approvals/approvalReviewHash';
import { createDraftEditReviewRequest } from '../src/approvals/approvalReviewSurface';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import type { ApprovalReviewRequest } from '../src/approvals/approvalReviewTypes';
import { buildApprovalReviewerProviderBody } from '../src/approvals/oneShotTextRequest';
import type { AgentRequest, ChatMessage } from '../src/shared/types';

test('reviewer JSON parsing accepts only the complete strict schema', () => {
  const valid = JSON.stringify({
    decision: 'approve', risk: 'low', reason: 'Scoped and directly relevant.',
    policyRules: ['least_privilege'], saferAlternative: ''
  });
  assert.equal(parseApprovalReviewerJson(valid).decision, 'approve');
  for (const invalid of [
    '```json\n' + valid + '\n```',
    JSON.stringify({ decision: 'approve', risk: 'low', reason: 'ok', policyRules: [] }),
    JSON.stringify({ decision: 'allow', risk: 'low', reason: 'ok', policyRules: [], saferAlternative: '' }),
    JSON.stringify({ decision: 'approve', risk: 'unknown', reason: 'ok', policyRules: [], saferAlternative: '' }),
    JSON.stringify({ decision: 'approve', risk: 'low', reason: 'ok', policyRules: [], saferAlternative: '', extra: true })
  ]) assert.throws(() => parseApprovalReviewerJson(invalid), /reviewer/u);
});

test('reviewer provider bodies are tool-free and protocol-native', () => {
  const chat = buildApprovalReviewerProviderBody({
    modelId: 'chat-model', provider: 'openai-compatible', systemPrompt: 'system', userPrompt: 'evidence'
  }) as unknown as Record<string, unknown>;
  const responses = buildApprovalReviewerProviderBody({
    modelId: 'responses-model', provider: 'openai-responses', systemPrompt: 'system', userPrompt: 'evidence'
  }) as unknown as Record<string, unknown>;
  const anthropic = buildApprovalReviewerProviderBody({
    modelId: 'anthropic-model', provider: 'anthropic-compatible', systemPrompt: 'system', userPrompt: 'evidence'
  }) as unknown as Record<string, unknown>;
  for (const body of [chat, responses, anthropic]) {
    assert.equal(Object.hasOwn(body, 'tools'), false);
    assert.equal(body.stream, true);
    assert.equal(body.temperature, 0);
  }
  assert.deepEqual((chat.messages as Array<{ role: string }>).map((item) => item.role), ['system', 'user']);
  assert.equal(Object.hasOwn(responses, 'thinking'), false);
  assert.equal(responses.store, false);
  assert.deepEqual((responses.input as Array<{ role: string }>).map((item) => item.role), ['system', 'user']);
  assert.equal(Array.isArray(anthropic.system), true);
  assert.deepEqual((anthropic.messages as Array<{ role: string }>).map((item) => item.role), ['user']);
});

test('review surfaces are deterministic, bounded, and exclude hidden provider state', () => {
  const trusted = vscode.workspace.isTrusted;
  const folders = vscode.workspace.workspaceFolders;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/private/workspace'), name: 'project' }];
  try {
    const history: ChatMessage[] = [{
      id: 'u', role: 'user', content: 'Make the requested narrow change.', createdAt: '2026-01-01'
    }, {
      id: 'a', role: 'assistant', content: 'I prepared one file.', createdAt: '2026-01-01',
      reasoningContent: 'HIDDEN_REASONING_SENTINEL',
      providerReplay: { protocol: 'openai-responses', sourceId: 's', baseUrl: 'x', items: [{ type: 'reasoning', id: 'HIDDEN_PROVIDER_SENTINEL' }] }
    }];
    const content = 'head\n' + 'x'.repeat(60_000) + '\ntail';
    const request = createDraftEditReviewRequest({
      sessionId: 'session', agentRunId: 'run', language: 'en', history,
      edit: { id: 'edit', uri: 'file:///private/workspace/a.ts', label: 'a.ts', action: 'create', newText: content, reason: 'Create a.ts.' },
      originalText: ''
    });
    const serialized = serializeApprovalReviewRequest(request);
    const exact = request.exactAction.kind === 'draft_edit_apply' ? request.exactAction : undefined;
    assert.equal(exact?.proposedChange.truncated, true);
    assert.equal(exact?.proposedChange.totalChars, content.length);
    assert.equal(exact?.proposedChange.contentHash, createBoundedReviewText(content).contentHash);
    assert.match(exact?.proposedChange.content ?? '', /^head/u);
    assert.match(exact?.proposedChange.content ?? '', /tail$/u);
    const lineEndingEvidence = createBoundedReviewText('a\r\nb\n');
    assert.notEqual(lineEndingEvidence.contentHash, createBoundedReviewText('a\nb\n').contentHash);
    assert.equal(lineEndingEvidence.content, 'a\r\nb\n');
    assert.doesNotMatch(serialized, /HIDDEN_REASONING_SENTINEL|HIDDEN_PROVIDER_SENTINEL|\/private\/workspace"/u);
    assert.match(serialized, /UNTRUSTED_EVIDENCE/u);
    assert.deepEqual(request.workspaceRootIds, ['root-1:project']);
  } finally {
    vscode.workspace.isTrusted = trusted;
    vscode.workspace.workspaceFolders = folders;
  }
});

test('approval records require an exact current-runtime match and are one-shot', async () => {
  await withApprovalFixture(async ({ storageUri, store }) => {
    const record = await store.add(approvalRecordInput());
    const match = {
      reviewId: record.reviewId, sessionId: 'session', agentRunId: 'run', targetId: 'target',
      actionKind: 'draft_run_execute' as const, actionHash: 'hash', policyVersion: 1,
      approvalMode: 'model_review' as const, workspaceTrusted: true
    };
    for (const mismatch of [
      { sessionId: 'other-session' },
      { agentRunId: 'other-run' },
      { targetId: 'other-target' },
      { actionKind: 'validation_run' as const },
      { actionHash: 'changed' },
      { policyVersion: 2 },
      { approvalMode: 'delegate' as const },
      { workspaceTrusted: false }
    ]) {
      await assert.rejects(store.consumeMatchingApproval({ ...match, ...mismatch }), /matching approval|untrusted workspace/u);
    }
    assert.ok((await store.consumeMatchingApproval(match)).consumedAt);
    await assert.rejects(store.consumeMatchingApproval(match), /matching approval/u);

    const oldRuntimeRecord = await store.add({ ...approvalRecordInput(), targetId: 'restart-target' });
    await store.flush();
    const restarted = new ApprovalReviewStore(storageUri as never);
    await restarted.initialize();
    await assert.rejects(restarted.consumeMatchingApproval({
      ...match, reviewId: oldRuntimeRecord.reviewId, targetId: 'restart-target'
    }), /matching approval/u);
  });
});

test('subagent selection is shared by reviewer resolution and fixed failures never fall back', async () => {
  await withApprovalFixture(async ({ storageUri, store }) => {
    const sourceStore = new ModelSourceStore(storageUri as never);
    await sourceStore.createSource({
      id: 'review-source', provider: 'openai-responses', name: 'Reviewer', apiKey: 'review-key',
      models: [{ id: 'review-model' }]
    });
    const settings = new SubagentSettingsStore(storageUri as never, 'workspace-key');
    await settings.save({ mode: 'fixed', sourceId: 'review-source', modelId: 'review-model' });
    const parent = parentRequestContext();
    const fixed = await resolveConfiguredSubagentModel({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace-key', sourceStore,
      parentRequest: parent, language: 'en', settingsStore: settings
    });
    assert.equal(fixed.model.id, 'review-model');
    assert.equal(fixed.sourceConfig.sourceId, 'review-source');
    assert.notEqual(fixed.model.id, parent.model.id);

    const followMain = await resolveConfiguredSubagentModel({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace-key', sourceStore,
      parentRequest: parent, language: 'en',
      settingsStore: { load: async () => ({ version: 1, mode: 'follow-main', updatedAt: new Date(0).toISOString() }) } as SubagentSettingsStore
    });
    assert.equal(followMain.model.id, parent.model.id);
    assert.notEqual(followMain.model, parent.model);

    await assert.rejects(resolveConfiguredSubagentModel({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace-key', sourceStore,
      parentRequest: parent, language: 'en',
      settingsStore: { load: async () => ({ version: 1, mode: 'fixed', sourceId: 'missing', modelId: 'gone', updatedAt: new Date(0).toISOString() }) } as SubagentSettingsStore
    }), /not silently fall back/u);

    await settings.save({ mode: 'fixed', sourceId: 'missing', modelId: 'gone' });
    let reviewerCalls = 0;
    const unavailable = await new ApprovalReviewerService({
      globalStorageUri: storageUri as never,
      workspaceKey: 'workspace-key',
      sourceStore,
      store,
      requestText: async () => {
        reviewerCalls++;
        return '{}';
      }
    }).review(reviewRequest(), parent);
    assert.equal(reviewerCalls, 0);
    assert.equal(unavailable.record.decision, 'unavailable');
    assert.equal(unavailable.record.reviewerModelId, '');
    assert.notEqual(unavailable.record.reviewerModelId, parent.model.id);
  });
});

test('reviewer retries once, treats invalid output as unavailable, and never auto-approves secrets', async () => {
  await withApprovalFixture(async ({ storageUri, store }) => {
    const sourceStore = new ModelSourceStore(storageUri as never);
    let attempts = 0;
    const reviewer = new ApprovalReviewerService({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace', sourceStore, store,
      requestText: async () => {
        attempts++;
        if (attempts === 1) throw new Error('temporary network failure');
        return JSON.stringify({ decision: 'approve', risk: 'low', reason: 'Scoped.', policyRules: ['least_privilege'], saferAlternative: '' });
      }
    });
    const approved = await reviewer.review(reviewRequest(), parentRequestContext());
    assert.equal(attempts, 2);
    assert.equal(approved.record.decision, 'approve');

    const malformed = new ApprovalReviewerService({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace', sourceStore, store,
      requestText: async () => '{not valid json}'
    });
    const unavailable = await malformed.review({ ...reviewRequest(), targetId: 'invalid', actionHash: 'invalid' }, parentRequestContext());
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.record.decision, 'unavailable');

    const secret = { ...reviewRequest(), targetId: 'secret', actionHash: 'secret', purpose: 'send api_key=abcdefghijklmnop' };
    assert.equal(findSensitiveEvidence(serializeApprovalReviewRequest(secret)), 'suspected_credential_material');
    const hostDenied = await reviewer.createHostPolicyApproval(secret);
    assert.equal(hostDenied.record.decision, 'deny');
    assert.equal(hostDenied.record.approvalSource, 'local_policy');

    attempts = 0;
    const unreachable = new ApprovalReviewerService({
      globalStorageUri: storageUri as never, workspaceKey: 'workspace', sourceStore, store,
      requestText: async () => {
        attempts++;
        throw new Error(attempts === 1 ? 'network unavailable' : 'Approval reviewer timed out.');
      }
    });
    const unavailableAfterRetry = await unreachable.review(
      { ...reviewRequest(), targetId: 'timeout', actionHash: 'timeout' },
      parentRequestContext()
    );
    assert.equal(attempts, 2);
    assert.equal(unavailableAfterRetry.status, 'unavailable');
    assert.equal(unavailableAfterRetry.record.decision, 'unavailable');

    const hostApproved = await reviewer.createHostPolicyApproval({
      ...reviewRequest(), targetId: 'host-approved', actionHash: 'host-approved'
    });
    assert.equal(hostApproved.record.decision, 'approve');
    assert.equal(hostApproved.record.approvalSource, 'host_policy');
    assert.match(hostApproved.record.rationale, /without model review/u);
  });
});

test('approval refusal circuit breaker trips at three consecutive and ten of fifty', () => {
  const breaker = new ApprovalCircuitBreaker();
  assert.equal(breaker.record('consecutive', 'deny').tripped, false);
  assert.equal(breaker.record('consecutive', 'deny').tripped, false);
  assert.equal(breaker.record('consecutive', 'deny').reason, 'consecutive_denials');
  breaker.record('reset', 'deny');
  breaker.record('reset', 'unavailable');
  assert.equal(breaker.record('reset', 'deny').tripped, false);
  for (let index = 0; index < 9; index++) {
    breaker.record('recent', 'deny');
    breaker.record('recent', 'approve');
  }
  assert.equal(breaker.record('recent', 'deny').reason, 'recent_denials');
});

test('a repeated denied action hash is rejected locally without another reviewer request', async () => {
  await withApprovalFixture(async ({ storageUri, store }) => {
    const breaker = new ApprovalCircuitBreaker();
    let requests = 0;
    const reviewer = new ApprovalReviewerService({
      globalStorageUri: storageUri as never,
      workspaceKey: 'workspace',
      sourceStore: new ModelSourceStore(storageUri as never),
      store,
      circuitBreaker: breaker,
      requestText: async () => {
        requests++;
        return JSON.stringify({
          decision: 'deny', risk: 'high', reason: 'Too broad.',
          policyRules: ['least_privilege'], saferAlternative: 'Narrow the operation.'
        });
      }
    });
    const request = { ...reviewRequest(), actionHash: 'repeat-hash' };
    assert.equal((await reviewer.review(request, parentRequestContext())).record.decision, 'deny');
    const repeated = await reviewer.review({ ...request, targetId: 'new-tool-call' }, parentRequestContext());
    assert.equal(requests, 1);
    assert.equal(repeated.record.approvalSource, 'local_policy');
    assert.match(repeated.record.rationale, /already denied/u);
    const tripped = await reviewer.review({ ...request, targetId: 'third-tool-call' }, parentRequestContext());
    assert.equal(tripped.circuitBreakReason, 'consecutive_denials');
    assert.equal(requests, 1);
  });
});

test('sensitive DraftRun environment values are denied before they enter a reviewer request', () => {
  const request: ApprovalReviewRequest = {
    ...reviewRequest(),
    actionKind: 'draft_run_execute',
    targetId: 'run-secret',
    actionHash: 'secret-spec',
    exactAction: {
      kind: 'draft_run_execute',
      executable: 'node',
      argv: ['script.js'],
      cwdUri: 'file:///workspace',
      env: [{ name: 'SERVICE_API_KEY', value: 'not-shaped-like-a-token' }],
      timeoutMs: 20_000,
      effectAssessment: { version: 1, verdict: 'unknown', effects: ['workspace_read'], evidence: [] },
      specHash: 'secret-spec'
    }
  };
  assert.equal(findDeterministicReviewDenial(request), 'suspected_credential_material');
});

test('unregistered, mismatched, and changed-hash approval requests are denied before a reviewer call', async () => {
  await withApprovalFixture(async ({ storageUri, store }) => {
    let calls = 0;
    const reviewer = new ApprovalReviewerService({
      globalStorageUri: storageUri as never,
      workspaceKey: 'workspace',
      sourceStore: new ModelSourceStore(storageUri as never),
      store,
      requestText: async () => {
        calls++;
        return JSON.stringify({
          decision: 'approve', risk: 'low', reason: 'ok', policyRules: [], saferAlternative: ''
        });
      }
    });
    const unknown = { ...reviewRequest(), actionKind: 'unknown_action' } as unknown as ApprovalReviewRequest;
    const mismatch = {
      ...reviewRequest(),
      targetId: 'mismatch',
      actionHash: 'mismatch',
      actionKind: 'external_file_access' as const
    };
    const changedRun = {
      ...reviewRequest(),
      targetId: 'changed-run',
      actionKind: 'draft_run_execute' as const,
      actionHash: 'changed',
      exactAction: {
        kind: 'draft_run_execute' as const,
        executable: 'node', argv: ['--version'], cwdUri: 'file:///workspace', env: [], timeoutMs: 20_000,
        effectAssessment: { version: 1 as const, verdict: 'likely_readonly' as const, effects: ['workspace_read' as const], evidence: [] },
        specHash: 'original'
      }
    };
    assert.equal((await reviewer.review(unknown, parentRequestContext())).record.decision, 'deny');
    assert.equal((await reviewer.review(mismatch, parentRequestContext())).record.decision, 'deny');
    assert.equal((await reviewer.review(changedRun, parentRequestContext())).record.decision, 'deny');
    assert.equal(calls, 0);
  });
});

function reviewRequest(): ApprovalReviewRequest {
  return {
    version: 1, sessionId: 'session', rootTaskId: 'root', agentRunId: 'run', actionKind: 'validation_run',
    targetId: 'validation', actionHash: hashApprovalValue({ script: 'compile' }),
    originalGoalSummary: 'Compile the project.', visibleSessionEvidence: ['user: Compile the project.'],
    workspaceTrusted: true, workspaceRootIds: ['root-1:project'], purpose: 'Run compile.',
    staticRiskAnalysis: ['fixed_script:compile'], exactAction: { kind: 'validation_run', script: 'compile', workspaceRootId: 'root-1:project' },
    responseLanguage: 'en'
  };
}

function approvalRecordInput() {
  return {
    sessionId: 'session', rootTaskId: 'root', agentRunId: 'run', targetId: 'target', actionKind: 'draft_run_execute' as const,
    actionHash: 'hash', policyVersion: 1, approvalSource: 'model_review' as const,
    reviewerSourceId: 'source', reviewerModelId: 'model', reviewerProvider: 'openai-responses',
    decision: 'approve' as const, risk: 'low' as const, rationale: 'Scoped.', policyRules: ['least_privilege']
  };
}

function parentRequestContext(): Pick<AgentRequest, 'model' | 'sourceConfig'> {
  return {
    model: { id: 'main-model', label: 'Main', provider: 'openai-responses', sourceId: 'main-source', contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
    sourceConfig: { sourceId: 'main-source', provider: 'openai-responses', apiKey: 'main-key', baseUrl: 'https://example.invalid/v1', supportsBilling: false }
  };
}

async function withApprovalFixture(run: (fixture: {
  storageUri: vscode.Uri;
  store: ApprovalReviewStore;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-approval-review-'));
  const storageUri = vscode.Uri.file(root);
  const store = new ApprovalReviewStore(storageUri as never);
  await store.initialize();
  try {
    await run({ storageUri, store });
  } finally {
    await store.flush();
    await rm(root, { recursive: true, force: true });
  }
}
