import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import type { ValidationToolAdapter } from '../src/agent/tools/validationTools';
import type { ToolAuthorizationAdapter } from '../src/agent/tools/toolAuthorization';
import type {
  AgentRequest,
  RunAuthorizationPolicy,
  SafeNpmScript,
  ToolAuthorizationDecision
} from '../src/shared/types';
import type { ApprovalReviewerAdapter } from '../src/approvals/approvalReviewer';
import type { ApprovalReviewRecord, ApprovalReviewRequest } from '../src/approvals/approvalReviewTypes';

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-run-validation-'));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'validation-run' }];
});

afterEach(async () => {
  vscode.workspace.workspaceFolders = [];
  await rm(workspaceRoot, { recursive: true, force: true });
});

test('Runner allows baseline validation, then blocks validation after an ordinary DraftEdit', async () => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const targetPath = path.join(workspaceRoot, 'ordinary.ts');
  const calls: ToolCallSpec[] = [
    toolCall('validate-before', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
    toolCall('draft', CREATE_DRAFT_EDIT_TOOL_NAME, {
      path: targetPath,
      content: 'export const ready = true;\n',
      reason: 'Implement the requested change.'
    }),
    toolCall('validate-after', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })
  ];

  const response = await withResponses([toolResponse(calls), textResponse('The change is ready and validation passed.')], async () =>
    await createRunner(validation).run(createRequest('Implement the change.'))
  );

  assert.equal(validation.runCount, 1);
  assert.equal(response.draftEdits.length, 1);
  const results = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(results[0].content).ok, true);
  assert.equal(JSON.parse(results[2].content).errorType, 'pending_changes_require_apply');
  assert.doesNotMatch(response.message, /validation passed/u);
  assert.match(response.message, /covered only the pre-change workspace baseline/u);
  assert.match(response.message, /pending DraftEdits are unapplied and unvalidated/u);
});

test('Runner also blocks validation after a repair DraftEdit', async () => {
  const validation = new FakeValidationTools([validationResult(false)]);
  const targetPath = path.join(workspaceRoot, 'repair.ts');
  const calls: ToolCallSpec[] = [
    toolCall('validate-failure', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
    toolCall('read-problems', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {}),
    toolCall('repair-draft', CREATE_DRAFT_EDIT_TOOL_NAME, {
      path: targetPath,
      content: 'export const repaired = true;\n',
      reason: 'Repair the compile failure.'
    }),
    toolCall('validate-repair', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })
  ];

  const response = await withResponses([toolResponse(calls), textResponse('Repair prepared and compile failed.')], async () =>
    await createRunner(validation).run(createRequest('Fix the compile failure.'))
  );

  assert.equal(validation.runCount, 1);
  const results = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(results[3].content).errorType, 'pending_changes_require_apply');
  assert.equal(response.repairLoop.status, 'waiting_for_apply');
  assert.equal(response.repairLoop.pendingDraftEditIds.length, 1);
  assert.match(response.message, /Validation is paused/u);
  assert.match(response.message, /covered only the pre-change workspace baseline/u);
});

test('Runner preserves the Apply-then-continue validation flow', async () => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const request = createRequest('Continue repair validation after Apply.');
  request.repairLoop = {
    status: 'running_validation',
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile',
    pendingDraftEditIds: []
  };

  const response = await withResponses([
    toolResponse([toolCall('post-apply-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]),
    textResponse('The controlled validation completed.')
  ], async () => await createRunner(validation).run(request));

  assert.equal(validation.runCount, 1);
  assert.equal(response.repairLoop.status, 'completed');
  assert.match(response.message, /post-Apply validation passed on the updated on-disk workspace/u);
});

test('Runner turns keepseek_run_draft into a pending proposal without executing it', async () => {
  const validation = new FakeValidationTools([]);
  const request = createRequest('Run a command after I approve it.');
  request.requestProtocolVersion = 4;
  const response = await withResponses([
    toolResponse([toolCall('draft-run', RUN_DRAFT_TOOL_NAME, {
      executable: 'printf',
      args: ['%s', 'literal; argument'],
      reason: 'Print one literal argument.',
      cwd: '.',
      timeoutMs: 20_000
    })]),
    textResponse('The command is pending your approval.')
  ], async () => await createRunner(validation).run(request));

  assert.equal(validation.runCount, 0);
  assert.equal(response.draftRuns?.length, 1);
  assert.equal(response.draftRuns?.[0]?.spec.executable, 'printf');
  assert.deepEqual(response.draftRuns?.[0]?.spec.args, ['%s', 'literal; argument']);
  assert.equal(response.draftRuns?.[0]?.spec.cwdUri, vscode.Uri.file(await realpath(workspaceRoot)).toString());
  const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}') as {
    ok?: boolean;
    draftRun?: { status?: string };
    message?: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.draftRun?.status, 'pending');
  assert.match(result.message ?? '', /no process was started/u);
});

test('model-reviewed validation persists a neutral tool placeholder and requires a new user-message boundary', async () => {
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc -p .' } }));
  const validation = new FakeValidationTools([validationResult(true)]);
  const reviewer = new FakeApprovalReviewer('approve');
  const request = createRequest('Compile the project under model review.');
  request.approvalMode = 'model_review';
  request.sessionId = 'session-review';
  const response = await withResponses([
    toolResponse([toolCall('reviewed-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], async () => await createRunner(validation, reviewer).run(request));

  assert.equal(validation.runCount, 1);
  assert.equal(reviewer.calls, 1);
  assert.equal(response.approvalContinuationRequired, true);
  const providerResult = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
  assert.equal(providerResult.status, 'approval_result_pending');
  assert.doesNotMatch(response.toolRounds?.[0]?.toolResults[0]?.content ?? '', /Scoped model approval|durationMs/u);
  assert.equal(response.runDetails.approvalReviews?.[0]?.decision, 'approve');
  assert.match(response.approvalToolResults?.[0]?.result.content ?? '', /durationMs/u);
});

test('model-reviewed validation denial does not execute and still crosses the new user-message boundary', async () => {
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc -p .' } }));
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('deny');
  const request = createRequest('Compile the project under model review.');
  request.approvalMode = 'model_review';
  request.sessionId = 'session-review';
  const response = await withResponses([
    toolResponse([toolCall('denied-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], async () => await createRunner(validation, reviewer).run(request));

  assert.equal(validation.runCount, 0);
  assert.equal(response.approvalContinuationRequired, true);
  assert.equal(response.runDetails.approvalReviews?.[0]?.decision, 'deny');
  assert.doesNotMatch(response.toolRounds?.[0]?.toolResults[0]?.content ?? '', /Denied by reviewer/u);
  assert.equal(response.approvalToolResults?.[0]?.status, 'denied');
  const deniedResult = JSON.parse(response.approvalToolResults?.[0]?.result.content ?? '{}');
  assert.equal(deniedResult.ok, true);
  assert.equal(deniedResult.status, 'approval_denied');
  assert.equal(deniedResult.executed, false);
  assert.equal(Object.hasOwn(deniedResult, 'errorType'), false);
});

class FakeValidationTools implements ValidationToolAdapter {
  public runCount = 0;

  public constructor(private readonly results: string[]) {}

  public async readWorkspaceDiagnostics(): Promise<string> {
    return JSON.stringify({
      ok: true,
      total: 1,
      errors: 1,
      warnings: 0,
      information: 0,
      hints: 0,
      truncated: false,
      items: []
    });
  }

  public async runSafeNpmScript(): Promise<string> {
    this.runCount += 1;
    return this.results.shift() ?? validationResult(true);
  }
}

class AllowAllToolAuthorization implements ToolAuthorizationAdapter {
  public createRunPolicy(runId: string): RunAuthorizationPolicy {
    return {
      runId,
      mediumRiskPolicy: 'always',
      authorizedScopes: [],
      deniedScopes: []
    };
  }

  public async authorize(input: {
    toolName: string;
    args: Record<string, unknown>;
    policy: RunAuthorizationPolicy;
  }): Promise<ToolAuthorizationDecision> {
    const validation = input.toolName === RUN_VALIDATION_TOOL_NAME;
    const draftRun = input.toolName === RUN_DRAFT_TOOL_NAME;
    return {
      allowed: true,
      toolName: input.toolName,
      riskLevel: validation ? 'medium' : 'low',
      scope: validation
        ? input.args.script === 'test' ? 'validation_test' : 'validation_compile_lint'
        : draftRun ? 'draft_run_prepare' : 'draft_edit_prepare',
      source: validation ? 'configuration' : 'low_risk',
      requiresExplicitConfirmation: false
    };
  }
}

function createRunner(validation: ValidationToolAdapter, reviewer?: ApprovalReviewerAdapter): AgentRunner {
  return new AgentRunner(
    new WorkspaceToolService(),
    undefined,
    validation,
    undefined,
    undefined,
    new AllowAllToolAuthorization(),
    undefined,
    undefined,
    reviewer
  );
}

class FakeApprovalReviewer implements ApprovalReviewerAdapter {
  public calls = 0;

  public constructor(private readonly decision: 'approve' | 'deny') {}

  public async review(request: ApprovalReviewRequest): Promise<{ status: 'reviewed'; record: ApprovalReviewRecord }> {
    this.calls += 1;
    return { status: 'reviewed', record: this.createRecord(request, 'model_review') };
  }

  public async createHostPolicyApproval(request: ApprovalReviewRequest): Promise<{ status: 'reviewed'; record: ApprovalReviewRecord }> {
    return { status: 'reviewed', record: this.createRecord(request, 'host_policy') };
  }

  public async consumeApproval(): Promise<void> {}

  private createRecord(request: ApprovalReviewRequest, source: 'model_review' | 'host_policy'): ApprovalReviewRecord {
    return {
      reviewId: `review-${this.calls}`,
      runtimeId: 'runtime',
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: 1,
      approvalSource: source,
      reviewerSourceId: source === 'model_review' ? 'review-source' : '',
      reviewerModelId: source === 'model_review' ? 'review-model' : '',
      reviewerProvider: source === 'model_review' ? 'openai-responses' : 'host_policy',
      decision: this.decision,
      risk: this.decision === 'approve' ? 'low' : 'high',
      rationale: this.decision === 'approve' ? 'Scoped model approval.' : 'Denied by reviewer.',
      policyRules: ['least_privilege'],
      createdAt: '2026-01-01T00:00:00.000Z'
    };
  }
}

function createRequest(prompt: string): AgentRequest {
  return {
    prompt,
    model: {
      id: 'responses-eval-model',
      label: 'Responses Eval Model',
      provider: 'openai-responses',
      sourceId: 'responses-eval-source',
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_000
    },
    settings: {
      thinkingEnabled: false,
      reasoningEffort: 'high',
      compressionThreshold: 'balanced'
    },
    contextFiles: [],
    history: [{
      id: 'user-1',
      role: 'user',
      content: prompt,
      createdAt: '2026-01-01T00:00:00.000Z'
    }],
    language: 'en',
    requestProtocolVersion: 3,
    sourceConfig: {
      sourceId: 'responses-eval-source',
      provider: 'openai-responses',
      apiKey: 'test-key',
      baseUrl: 'https://eval.invalid/v1',
      supportsBilling: false
    },
    executionLimits: {
      maxToolIterations: 2,
      maxToolCalls: 8,
      maxRepairIterations: 2
    }
  };
}

function validationResult(ok: boolean): string {
  return JSON.stringify({
    ok,
    kind: 'npm_script',
    script: 'compile' satisfies SafeNpmScript,
    authorized: true,
    exitCode: ok ? 0 : 1,
    durationMs: 20,
    timedOut: false,
    diagnostics: {
      ok: true,
      total: ok ? 0 : 1,
      errors: ok ? 0 : 1,
      warnings: 0,
      information: 0,
      hints: 0,
      truncated: false,
      items: []
    },
    error: ok ? undefined : 'compile failed'
  });
}

interface ToolCallSpec {
  id: string;
  name: string;
  arguments: string;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallSpec {
  return { id, name, arguments: JSON.stringify(args) };
}

function toolResponse(calls: ToolCallSpec[]): Response {
  return completedResponse(calls.map((call) => ({
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments
  })));
}

function textResponse(text: string): Response {
  return completedResponse([{
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  }]);
}

function completedResponse(output: unknown[]): Response {
  const body = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', output }
  })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function withResponses<T>(responses: Response[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error('No mocked provider response remains.');
    }
    return response;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
