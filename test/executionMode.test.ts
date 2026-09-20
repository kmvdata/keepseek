import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import {
  createPlanPhaseBlockedToolResult,
  getPlanPhaseToolBlockReason,
  getPlanWorkflowTail,
  getPlanWorkflowViews,
  hasPlanImplementationArtifacts,
  hashPlanContent,
  invalidatePlansForRemovedMessages,
  normalizeExecutionMode,
  normalizePlanWorkflowRecords,
  PLAN_EXECUTION_CONTINUATION_PROMPT,
  PLAN_PHASE_BLOCKED_ERROR_TYPE,
  PLAN_WORKFLOW_TAIL,
  registerPendingPlan,
  requestPlanRevisionForNewPrompt,
  resolvePlanDecision
} from '../src/agent/executionMode';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  getAgentSystemPrompt,
  getAgentTools
} from '../src/agent/protocol';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { createDisplayedSessionContextUsageEstimate } from '../src/agent/contextUsage';
import { createEmptySession, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { getInputScript } from '../src/webview/input/script';
import { getInputStyles } from '../src/webview/input/styles';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { ApprovalMode, ChatMessage, ChatSession, KeepseekModel } from '../src/shared/types';

const MODEL: KeepseekModel = {
  id: 'execution-test-model',
  label: 'Execution Test Model',
  provider: 'deepseek',
  contextWindowTokens: 128_000,
  maxOutputTokens: 8_000
};
const SETTINGS = {
  thinkingEnabled: true,
  reasoningEffort: 'high' as const,
  compressionThreshold: 'balanced' as const
};

test('execution mode normalization defaults missing and unknown values to normal', () => {
  assert.equal(normalizeExecutionMode(undefined), 'normal');
  assert.equal(normalizeExecutionMode('goal'), 'normal');
  assert.equal(normalizeExecutionMode('PLAN'), 'normal');
  assert.equal(normalizeExecutionMode('normal'), 'normal');
  assert.equal(normalizeExecutionMode('plan'), 'plan');

  const scope = { key: 'workspace:test', name: 'Test', folderUris: [] };
  const sessions = normalizeStoredSessions({ sessions: [
    storedSession('missing', undefined),
    storedSession('unknown', 'goal'),
    storedSession('planned', 'plan')
  ] }, scope);
  assert.deepEqual(sessions.map((session) => session.executionMode), ['normal', 'normal', 'plan']);
  assert.equal(createEmptySession('en', scope).executionMode, 'normal');
});

test('normal execution adds no bytes and Plan persists one stable user-message tail', () => {
  assert.equal(getPlanWorkflowTail('normal'), '');
  assert.equal(getPlanWorkflowTail('plan'), PLAN_WORKFLOW_TAIL);
  assert.equal(hashPlanContent(PLAN_WORKFLOW_TAIL), 'fccd48ed6c82b7b153888c4740caf9e2367fafb9c46df3995638e315b22ca6ce');
  assert.match(PLAN_WORKFLOW_TAIL, /planning phase only/u);
  assert.match(PLAN_WORKFLOW_TAIL, /2–6 top-level numbered phases/u);
  assert.match(PLAN_EXECUTION_CONTINUATION_PROMPT, /explicitly approved/u);

  const normalHistory: ChatMessage[] = [user('u-normal', 'Inspect the project.', 'Inspect the project.')];
  const planProviderContent = 'Inspect the project.\n\n' + PLAN_WORKFLOW_TAIL;
  const planHistory: ChatMessage[] = [user('u-plan', 'Inspect the project.', planProviderContent)];
  const common = {
    model: MODEL,
    agentSettings: SETTINGS,
    contextFiles: [],
    language: 'en' as const,
    prompt: 'Inspect the project.',
    requestProtocolVersion: 9
  };
  const normal = buildProviderRequestProjection({ ...common, history: normalHistory });
  const plan = buildProviderRequestProjection({ ...common, history: planHistory });
  assert.equal(normal.messages.at(-1)?.content, 'Inspect the project.');
  assert.equal(plan.messages.at(-1)?.content, planProviderContent);
  assert.equal(planHistory[0].providerContent, planProviderContent);
  assert.equal(normal.messages[0]?.content, plan.messages[0]?.content);
  assert.deepEqual(normal.tools, plan.tools);
  assert.equal(getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 9 }), normal.messages[0]?.content);
  assert.deepEqual(getAgentTools({ requestProtocolVersion: 9 }), normal.tools);

  const normalUsage = createDisplayedSessionContextUsageEstimate({ ...common, messages: normalHistory });
  const planUsage = createDisplayedSessionContextUsageEstimate({ ...common, messages: planHistory });
  assert.ok(planUsage.breakdown.inputTokensEstimate > normalUsage.breakdown.inputTokensEstimate);

  const replayHistory = [
    ...planHistory,
    assistant('a-plan', '1. Inspect\n   - Verify the code path.'),
    user('u-next', 'Continue planning.', 'Continue planning.\n\n' + PLAN_WORKFLOW_TAIL)
  ];
  const replay = buildProviderRequestProjection({ ...common, prompt: 'Continue planning.', history: replayHistory });
  assert.equal(replay.messages.find((message) => message.role === 'user')?.content, planProviderContent);
  assert.equal(replay.messages.at(-1)?.content, 'Continue planning.\n\n' + PLAN_WORKFLOW_TAIL);
});

test('Plan tool guard permits investigation but rejects implementation before authorization', async () => {
  assert.equal(getPlanPhaseToolBlockReason({ executionMode: 'plan', toolName: READ_WORKSPACE_FILE_RANGE_TOOL_NAME }), undefined);
  assert.equal(getPlanPhaseToolBlockReason({ executionMode: 'plan', toolName: RUN_VALIDATION_TOOL_NAME }), undefined);
  for (const toolName of [
    CREATE_DRAFT_EDIT_TOOL_NAME,
    CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
    APPLY_PATCH_TOOL_NAME,
    DELETE_WORKSPACE_FILE_TOOL_NAME,
    RUN_DRAFT_TOOL_NAME
  ]) {
    const reason = getPlanPhaseToolBlockReason({ executionMode: 'plan', toolName });
    assert.match(reason ?? '', /planning phase/u);
    const result = JSON.parse(createPlanPhaseBlockedToolResult(toolName, reason ?? 'blocked'));
    assert.equal(result.errorType, PLAN_PHASE_BLOCKED_ERROR_TYPE);
    assert.equal(result.executionMode, 'plan');
  }
  assert.equal(getPlanPhaseToolBlockReason({
    executionMode: 'plan',
    toolName: DELEGATE_TASK_TOOL_NAME,
    args: { profile: 'research', task: 'inspect' }
  }), undefined);
  assert.match(getPlanPhaseToolBlockReason({
    executionMode: 'plan',
    toolName: DELEGATE_TASK_TOOL_NAME,
    args: { profile: 'proposal', task: 'write it' }
  }) ?? '', /Writer\/proposal/u);
  assert.match(getPlanPhaseToolBlockReason({
    executionMode: 'plan',
    toolName: DELEGATE_TASK_TOOL_NAME,
    args: { lane: 'proposal', task: 'write it' }
  }) ?? '', /Writer\/proposal/u);
  assert.match(getPlanPhaseToolBlockReason({
    executionMode: 'plan',
    toolName: DELEGATE_TASK_TOOL_NAME,
    args: { continueSubagentId: 'unknown-child', task: 'continue' }
  }) ?? '', /continuations are unavailable/u);
  assert.equal(getPlanPhaseToolBlockReason({ executionMode: 'normal', toolName: RUN_DRAFT_TOOL_NAME }), undefined);

  const runnerSource = await readFile(path.join(process.cwd(), 'src/agent/runner.ts'), 'utf8');
  assert.ok(runnerSource.indexOf('getPlanPhaseToolBlockReason') < runnerSource.indexOf('this.toolAuthorization.authorize'));
});

test('pending plans are content-bound, latest-only, restartable, and resolved only once', () => {
  const session = planSession('session-a', 'ask');
  const first = registerPendingPlan({
    session,
    userMessageId: 'u1',
    assistantMessageId: 'a1',
    content: session.messages[1].content,
    now: '2026-01-01T00:00:02.000Z',
    id: 'plan-1'
  });
  assert.equal(first.contentHash, hashPlanContent(session.messages[1].content));
  assert.deepEqual(getPlanWorkflowViews(session).map((plan) => plan.status), ['pending']);

  const persisted = structuredClone(session);
  const restoredRecords = normalizePlanWorkflowRecords(persisted.planWorkflows, persisted.id);
  persisted.planWorkflows = restoredRecords;
  assert.equal(getPlanWorkflowViews(persisted)[0]?.status, 'pending');
  assert.equal(persisted.executionMode, 'plan');

  assert.deepEqual(resolvePlanDecision({
    session,
    activeSessionId: 'another-session',
    planId: first.id,
    action: 'start_execution'
  }), { ok: false, reason: 'plan_session_mismatch' });
  session.messages[1].content = 'tampered';
  assert.deepEqual(resolvePlanDecision({
    session,
    activeSessionId: session.id,
    planId: first.id,
    action: 'start_execution'
  }), { ok: false, reason: 'plan_hash_mismatch' });
  assert.equal(getPlanWorkflowViews(session)[0]?.status, 'invalid');
  session.messages[1].content = '1. Inspect\n   - Verify evidence.';

  const approved = resolvePlanDecision({
    session,
    activeSessionId: session.id,
    planId: first.id,
    action: 'start_execution',
    now: '2026-01-01T00:00:03.000Z'
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.ok && approved.startExecution, true);
  assert.equal(session.executionMode, 'normal');
  assert.equal(session.approvalMode, 'ask');
  assert.deepEqual(resolvePlanDecision({
    session,
    activeSessionId: session.id,
    planId: first.id,
    action: 'start_execution'
  }), { ok: false, reason: 'plan_mode_inactive' });
});

test('revise, exit, replacement, edit resend, and approval modes preserve independent state', () => {
  for (const approvalMode of ['ask', 'model_review', 'delegate'] as const) {
    const session = planSession('session-' + approvalMode, approvalMode);
    const plan = registerPendingPlan({
      session,
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      content: session.messages[1].content,
      id: 'plan-' + approvalMode
    });
    const result = resolvePlanDecision({
      session,
      activeSessionId: session.id,
      planId: plan.id,
      action: 'start_execution'
    });
    assert.equal(result.ok, true);
    assert.equal(session.executionMode, 'normal');
    assert.equal(session.approvalMode, approvalMode);
  }

  const reviseSession = planSession('revise', 'delegate');
  const old = registerPendingPlan({
    session: reviseSession, userMessageId: 'u1', assistantMessageId: 'a1',
    content: reviseSession.messages[1].content, id: 'old'
  });
  const revised = resolvePlanDecision({
    session: reviseSession,
    activeSessionId: reviseSession.id,
    planId: old.id,
    action: 'revise_plan'
  });
  assert.equal(revised.ok, true);
  assert.equal(revised.ok && revised.startExecution, false);
  assert.equal(reviseSession.executionMode, 'plan');
  assert.equal(old.status, 'revision_requested');
  reviseSession.messages.push(user('u2', 'Change the approach.'), assistant('a2', '1. Revise\n   - Verify again.'));
  const replacement = registerPendingPlan({
    session: reviseSession, userMessageId: 'u2', assistantMessageId: 'a2',
    content: reviseSession.messages[3].content, id: 'replacement'
  });
  assert.equal(old.status, 'superseded');
  assert.equal(replacement.status, 'pending');
  assert.equal(invalidatePlansForRemovedMessages(reviseSession, new Set(['a2'])), true);
  assert.equal(replacement.status, 'superseded');

  const exitSession = planSession('exit', 'model_review');
  const exitPlan = registerPendingPlan({
    session: exitSession, userMessageId: 'u1', assistantMessageId: 'a1',
    content: exitSession.messages[1].content, id: 'exit-plan'
  });
  const exited = resolvePlanDecision({
    session: exitSession,
    activeSessionId: exitSession.id,
    planId: exitPlan.id,
    action: 'exit_plan'
  });
  assert.equal(exited.ok, true);
  assert.equal(exited.ok && exited.startExecution, false);
  assert.equal(exitSession.executionMode, 'normal');
  assert.equal(exitSession.approvalMode, 'model_review');

  const directRevision = planSession('direct-revision', 'ask');
  registerPendingPlan({
    session: directRevision, userMessageId: 'u1', assistantMessageId: 'a1',
    content: directRevision.messages[1].content, id: 'direct'
  });
  assert.equal(requestPlanRevisionForNewPrompt(directRevision), true);
  assert.equal(directRevision.planWorkflows?.[0]?.status, 'revision_requested');
});

test('implementation artifacts invalidate a Plan response regardless of approval mode', () => {
  for (const approvalMode of ['ask', 'model_review', 'delegate'] as const) {
    void approvalMode;
    assert.equal(hasPlanImplementationArtifacts({
      draftEdits: [{ id: 'edit' }] as never,
      draftRuns: [],
      changeSet: undefined
    }), true);
    assert.equal(hasPlanImplementationArtifacts({
      draftEdits: [],
      draftRuns: [{ id: 'run' }] as never,
      changeSet: undefined
    }), true);
  }
  assert.equal(hasPlanImplementationArtifacts({ draftEdits: [], draftRuns: [], changeSet: undefined }), false);
});

test('only the host plan-decision message starts a fresh protected implementation turn', async () => {
  const session = planSession('host-session', 'delegate');
  const plan = registerPendingPlan({
    session,
    userMessageId: 'u1',
    assistantMessageId: 'a1',
    content: session.messages[1].content,
    id: 'host-plan'
  });
  const sends: Array<{ prompt: string; options: unknown }> = [];
  const posts: unknown[] = [];
  const provider = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    isBusy: false,
    isStartingRun: false,
    activeDraftRunId: undefined,
    approvalDataReady: true,
    requestContextReady: true,
    selectedSourceId: 'source',
    selectedModelId: 'model',
    agentSettings: SETTINGS,
    sessionStore: {
      activeSessionId: session.id,
      getActiveSession: () => session,
      persist: async () => {}
    },
    hasActiveBackgroundRun: () => false,
    postState: () => {},
    postToWebview: (message: unknown) => { posts.push(message); },
    t: (key: string) => key,
    sendPrompt: async (prompt: string, _sourceId: string, _modelId: string, _settings: unknown, options: unknown) => {
      sends.push({ prompt, options });
    }
  }) as unknown as {
    handleMessage(message: unknown): Promise<void>;
  };

  await provider.handleMessage({ type: 'resolvePlanDecision', planId: plan.id, action: 'start_execution' });
  assert.equal(session.executionMode, 'normal');
  assert.equal(session.approvalMode, 'delegate');
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.prompt, PLAN_EXECUTION_CONTINUATION_PROMPT);
  assert.deepEqual(sends[0]?.options, { planExecutionContinuation: { planId: plan.id } });

  const revisionSession = planSession('revision-host', 'ask');
  const revision = registerPendingPlan({
    session: revisionSession,
    userMessageId: 'u1',
    assistantMessageId: 'a1',
    content: revisionSession.messages[1].content,
    id: 'revision-plan'
  });
  Object.assign((provider as unknown as { sessionStore: unknown }), {
    sessionStore: {
      activeSessionId: revisionSession.id,
      getActiveSession: () => revisionSession,
      persist: async () => {}
    }
  });
  await provider.handleMessage({ type: 'resolvePlanDecision', planId: revision.id, action: 'revise_plan' });
  assert.equal(sends.length, 1);
  assert.equal(revisionSession.executionMode, 'plan');
  assert.equal(revisionSession.planWorkflows?.[0]?.status, 'revision_requested');
  assert.deepEqual(posts.at(-1), { type: 'focusComposer' });
});

test('input toolbar exposes a standalone N/P execution selector and the host renders a three-action plan card', () => {
  const template = getInputTemplate();
  const inputScript = getInputScript();
  const inputStyles = getInputStyles();
  const script = getScript();
  assert.match(template, /id="commandMenuButton"[\s\S]*id="executionModeButton"[\s\S]*id="status"/u);
  assert.match(template, /id="executionModeButtonLabel"[^>]*>N</u);
  assert.match(template, /id="executionModeMenu"[^>]*role="menu"/u);
  assert.deepEqual(
    [...template.matchAll(/data-execution-mode="(normal|plan)"/gu)].map((match) => match[1]),
    ['normal', 'plan']
  );
  const commandMenuStart = template.indexOf('id="commandMenu"');
  const commandMenuEnd = template.indexOf('id="referenceMenu"', commandMenuStart);
  assert.ok(commandMenuStart >= 0 && commandMenuEnd > commandMenuStart);
  assert.doesNotMatch(template.slice(commandMenuStart, commandMenuEnd), /executionMode|执行方式/u);
  assert.match(template, /data-execution-mode="normal"[^>]*aria-checked="true"/u);
  assert.match(template, /data-execution-mode="plan"[^>]*aria-checked="false"/u);
  assert.deepEqual(
    [...inputScript.matchAll(/button\.dataset\.executionMode === '(plan)' \? 'plan' : 'normal'/gu)].map((match) => match[1]),
    ['plan']
  );
  assert.doesNotMatch(inputScript, /data-execution-mode[^\n]*goal|mode: 'goal'/iu);
  assert.match(inputScript, /function isExecutionModeSelectionLocked\(\)[\s\S]{0,180}state\.isBusy/u);
  assert.match(inputScript, /executionModeButtonLabel\.textContent = currentMode === 'plan' \? 'P' : 'N'/u);
  assert.match(inputScript, /postMessage\(\{ type: 'setExecutionMode', mode: mode \}\)/u);
  assert.match(inputScript, /event\.key === 'ArrowDown'/u);
  assert.match(inputScript, /event\.key === 'Escape'/u);
  assert.match(inputStyles, /\.composer-execution-mode-control:hover \.execution-mode-tooltip/u);
  assert.match(inputStyles, /\.composer-execution-mode-btn:focus-visible \+ \.execution-mode-tooltip/u);
  assert.match(script, /type: 'resolvePlanDecision'/u);
  assert.match(script, /start_execution/u);
  assert.match(script, /revise_plan/u);
  assert.match(script, /exit_plan/u);
  assert.doesNotMatch(script, /resolvePlanDecision[\s\S]{0,180}(content|text):/u);
  new Script(inputScript);
  new Script(script);
});

function planSession(id: string, approvalMode: ApprovalMode): ChatSession {
  return {
    ...createEmptySession('en', { key: 'workspace:test', name: 'Test', folderUris: [] }, approvalMode, 'plan'),
    id,
    executionMode: 'plan',
    approvalMode,
    messages: [
      user('u1', 'Plan this task.'),
      assistant('a1', '1. Inspect\n   - Verify evidence.')
    ]
  };
}

function user(id: string, content: string, providerContent?: string): ChatMessage {
  return {
    id,
    role: 'user',
    content,
    ...(providerContent === undefined ? {} : { providerContent }),
    createdAt: '2026-01-01T00:00:00.000Z'
  };
}

function assistant(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, createdAt: '2026-01-01T00:00:01.000Z' };
}

function storedSession(id: string, executionMode: unknown): Record<string, unknown> {
  return {
    id,
    title: id,
    messages: [],
    executionMode,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: 'workspace:test'
  };
}
