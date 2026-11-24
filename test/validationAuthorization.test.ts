import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isValidationAuthorizationValid,
  validationAuthorizationRegistry,
  ValidationAuthorizationRegistry
} from '../src/agent/tools/toolAuthorization';
import { isReadOnlyTool, isWriteSideEffectTool } from '../src/sessions/queue/toolPolicy';
import type {
  ToolAuthorizationDecision,
  ValidationAuthorizationRequest,
  ValidationAuthorizationResult
} from '../src/shared/types';

const RUN_VALIDATION = 'keepseek_run_validation';

function decision(overrides: Partial<ToolAuthorizationDecision> = {}): ToolAuthorizationDecision {
  return {
    allowed: true,
    requiresExplicitConfirmation: false,
    riskLevel: 'medium',
    scope: 'validation_compile_lint',
    source: 'host_signed',
    toolName: RUN_VALIDATION,
    decisionId: 'decision-1',
    executionSnapshot: 'fingerprint-a',
    ...overrides
  };
}

const expected = { script: 'compile' as const, scope: 'validation_compile_lint' as const, fingerprint: 'fingerprint-a' };

test('a host-signed decision is valid only for its exact snapshot and scope', () => {
  validationAuthorizationRegistry.reset();
  // The module-level registry is what the runner consumes from.
  validationAuthorizationRegistry.issue('decision-1');
  assert.equal(isValidationAuthorizationValid(decision(), { ...expected, consume: false }), true);
  assert.equal(isValidationAuthorizationValid(decision(), { ...expected, consume: true }), true,
    'the consuming check accepts a live id');
  assert.equal(isValidationAuthorizationValid(decision(), { ...expected, consume: true }), false,
    'a consumed id is never valid twice');
  // The execution-side recheck runs after consumption, so it must not consult
  // availability: requiring it again would deny every legitimate execution.
  assert.equal(isValidationAuthorizationValid(decision(), { ...expected, consume: false }), true,
    'the structural check stays valid after the id was consumed');
  // A fresh id is consumable exactly once.
  validationAuthorizationRegistry.issue('decision-2');
  assert.equal(validationAuthorizationRegistry.consume('decision-2'), true);
  assert.equal(validationAuthorizationRegistry.consume('decision-2'), false);
});

test('a decision id that was never issued cannot be redeemed', () => {
  validationAuthorizationRegistry.reset();
  const registry = new ValidationAuthorizationRegistry();
  assert.equal(registry.consume('made-up'), false);
  assert.equal(registry.isAvailable('made-up'), false);
  registry.issue('made-up');
  assert.equal(registry.isAvailable('made-up'), true);
  registry.reset();
  assert.equal(registry.isAvailable('made-up'), false, 'an epoch reset revokes unconsumed authority');
});

test('risk level must stay medium: a low-risk downgrade is refused', () => {
  validationAuthorizationRegistry.reset();
  validationAuthorizationRegistry.issue('decision-1');
  assert.equal(isValidationAuthorizationValid(decision({ riskLevel: 'low' }), expected), false);
  assert.equal(isValidationAuthorizationValid(decision({ riskLevel: 'medium' }), expected), true);
});

test('a fingerprint mismatch or missing snapshot refuses the decision', () => {
  validationAuthorizationRegistry.reset();
  validationAuthorizationRegistry.issue('decision-1');
  assert.equal(isValidationAuthorizationValid(decision({ executionSnapshot: 'fingerprint-b' }), expected), false);
  assert.equal(isValidationAuthorizationValid(decision({ executionSnapshot: undefined }), expected), false);
});

test('scope and tool name must match the requested script', () => {
  validationAuthorizationRegistry.reset();
  validationAuthorizationRegistry.issue('decision-1');
  assert.equal(isValidationAuthorizationValid(decision(), { ...expected, scope: 'validation_test' }), false,
    'a compile authorization cannot be spent on a test run');
  assert.equal(isValidationAuthorizationValid(decision({ toolName: 'keepseek_read_workspace_file' }), expected), false);
  assert.equal(isValidationAuthorizationValid(decision({ allowed: false }), expected), false);
});

test('only host-issued sources can authorize validation', () => {
  validationAuthorizationRegistry.reset();
  validationAuthorizationRegistry.issue('decision-1');
  assert.equal(isValidationAuthorizationValid(decision({ source: 'low_risk' }), expected), false);
  assert.equal(isValidationAuthorizationValid(decision({ source: 'user_denied' }), expected), false);
  assert.equal(isValidationAuthorizationValid(decision({ source: 'host_signed' }), expected), true);
  assert.equal(isValidationAuthorizationValid(decision({ source: 'user_confirmed' }), expected), true);
});

test('validation is a side effect classified with the other write tools', () => {
  // Every session receives the full frozen tool set; what differs is whether the
  // project write lease admits the side effect, never which tools are offered.
  const available = ['keepseek_read_workspace_file', RUN_VALIDATION, 'keepseek_run_draft'];
  assert.equal(isReadOnlyTool(RUN_VALIDATION), false);
  assert.equal(isWriteSideEffectTool(RUN_VALIDATION), true);
  assert.equal(isReadOnlyTool('keepseek_read_workspace_file'), true);
  assert.deepEqual(available, [...available]);
});

test('the request/result contract carries no model-authored field', () => {
  const request: ValidationAuthorizationRequest = {
    sessionId: 'session-1',
    rootTaskId: 'task-1',
    segmentId: 'segment-1',
    script: 'lint',
    fingerprint: 'fingerprint-a',
    approvalMode: 'ask'
  };
  assert.equal(Object.keys(request).includes('reason'), false);
  const result: ValidationAuthorizationResult = {
    denialReason: 'no_response',
    decision: { ...decision(), allowed: false, source: 'user_denied' }
  };
  assert.equal(result.decision.allowed, false);
  assert.equal(result.denialReason, 'no_response');
});
/**
 * The original defect: the in-loop decision for run_validation was always
 * `allowed:false` because only low-risk tools were self-authorized. The fix
 * moves issuance to the host. These tests call the runner's own issuance entry
 * point to prove both directions without a provider.
 */
interface IssuanceInput {
  request: { sessionId?: string; approvalRootTaskId?: string; language: string; approvalMode?: string;
    checkpoint?: { taskId: string }; persona?: unknown; signal?: AbortSignal };
  callbacks: { onValidationAuthorizationRequest?: (request: ValidationAuthorizationRequest) => Promise<ValidationAuthorizationResult> };
  toolCallId: string;
  script: 'compile' | 'lint' | 'test';
  scope: 'validation_compile_lint' | 'validation_test';
  fingerprint?: string;
  approvalMode: 'ask' | 'approve-all';
  emitStatus: () => void;
}

async function issue(
  input: Partial<IssuanceInput>,
  overrides: { host?: (request: ValidationAuthorizationRequest) => Promise<ValidationAuthorizationResult> } = {}
): Promise<{ decision: ToolAuthorizationDecision; authorizationWaitMs: number }> {
  const { AgentLoop } = await import('../src/agent/runner.js');
  const loop = new AgentLoop();
  const base: IssuanceInput = {
    request: { sessionId: 'session-1', approvalRootTaskId: 'task-1', language: 'en', approvalMode: 'approve-all' },
    callbacks: overrides.host ? { onValidationAuthorizationRequest: overrides.host } : {},
    toolCallId: 'call-1',
    script: 'compile',
    scope: 'validation_compile_lint',
    fingerprint: 'fp-1',
    approvalMode: 'approve-all',
    emitStatus: () => undefined,
    ...input
  };
  return (loop as unknown as {
    requestValidationAuthorization(input: IssuanceInput): Promise<{ decision: ToolAuthorizationDecision; authorizationWaitMs: number }>;
  }).requestValidationAuthorization(base);
}

test('approve-all gets a host-signed medium decision instead of a constant denial', async () => {
  validationAuthorizationRegistry.reset();
  const result = await issue({}, {
    host: async (request) => {
      const decisionId = 'signed-once';
      validationAuthorizationRegistry.issue(decisionId);
      return {
        decision: {
          allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
          scope: request.script === 'test' ? 'validation_test' : 'validation_compile_lint',
          source: 'host_signed', toolName: 'keepseek_run_validation',
          decisionId, executionSnapshot: request.fingerprint
        }
      };
    }
  });
  assert.equal(result.decision.allowed, true, 'the exact defect: this used to be a constant denial');
  assert.equal(result.decision.riskLevel, 'medium', 'validation must stay medium risk');
  assert.equal(result.decision.source, 'host_signed');
  assert.equal(result.decision.executionSnapshot, 'fp-1');
});

test('a missing host callback fails closed instead of self-authorizing', async () => {
  validationAuthorizationRegistry.reset();
  const result = await issue({});
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.failureCode, 'approval_review_required');
  assert.equal(result.decision.denialReason, 'host_authorization_unavailable');
});

test('a host that throws or returns nothing fails closed', async () => {
  validationAuthorizationRegistry.reset();
  const thrown = await issue({}, { host: async () => { throw new Error('dialog failed'); } });
  assert.equal(thrown.decision.allowed, false);
  assert.equal(thrown.decision.denialReason, 'host_authorization_unavailable');

  const empty = await issue({}, { host: async () => undefined as never });
  assert.equal(empty.decision.allowed, false);
});

test('a decision for another snapshot is refused even when the host signs it', async () => {
  validationAuthorizationRegistry.reset();
  const result = await issue({ fingerprint: 'fp-current' }, {
    host: async () => {
      validationAuthorizationRegistry.issue('wrong-snapshot');
      return {
        decision: {
          allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
          scope: 'validation_compile_lint', source: 'host_signed',
          toolName: 'keepseek_run_validation', decisionId: 'wrong-snapshot',
          executionSnapshot: 'fp-stale'
        }
      };
    }
  });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.denialReason, 'scope_mismatch');
});

test('the same decision id cannot authorize two executions', async () => {
  validationAuthorizationRegistry.reset();
  const host = async (request: ValidationAuthorizationRequest): Promise<ValidationAuthorizationResult> => {
    validationAuthorizationRegistry.issue('reused');
    return {
      decision: {
        allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
        scope: 'validation_compile_lint', source: 'host_signed',
        toolName: 'keepseek_run_validation', decisionId: 'reused',
        executionSnapshot: request.fingerprint
      }
    };
  };
  const first = await issue({}, { host });
  assert.equal(first.decision.allowed, true);
  const second = await issue({}, { host });
  assert.equal(second.decision.allowed, false, 'issuing an already consumed id must not revive it');
  assert.equal(second.decision.denialReason, 'scope_mismatch');
});

test('a wallet of pre-issued ids is still single-use per decision', async () => {
  validationAuthorizationRegistry.reset();
  const decision: ToolAuthorizationDecision = {
    allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
    scope: 'validation_compile_lint', source: 'host_signed',
    toolName: 'keepseek_run_validation', decisionId: 'once', executionSnapshot: 'fp-1'
  };
  validationAuthorizationRegistry.issue('once');
  const host = async () => ({ decision });
  const first = await issue({}, { host });
  assert.equal(first.decision.allowed, true);
  const second = await issue({}, { host });
  assert.equal(second.decision.allowed, false);
});

test('a user denial is surfaced with its reason and never executed', async () => {
  validationAuthorizationRegistry.reset();
  const result = await issue({ approvalMode: 'ask' }, {
    host: async () => ({
      denialReason: 'user_denied',
      decision: {
        allowed: false, requiresExplicitConfirmation: false, riskLevel: 'medium',
        scope: 'validation_compile_lint', source: 'user_denied', toolName: 'keepseek_run_validation'
      }
    })
  });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.denialReason, 'user_denied');
  assert.match(result.decision.reason ?? '', /not authorized|approval/iu,
    'a denial must always carry a readable cause');
});

test('a modal wait is reported so it can be excluded from the validation timeout', async () => {
  validationAuthorizationRegistry.reset();
  const result = await issue({ approvalMode: 'ask' }, {
    host: async (request) => {
      await new Promise(resolve => setTimeout(resolve, 60));
      validationAuthorizationRegistry.issue('after-wait');
      return {
        decision: {
          allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
          scope: 'validation_compile_lint', source: 'user_confirmed',
          toolName: 'keepseek_run_validation', decisionId: 'after-wait',
          executionSnapshot: request.fingerprint
        }
      };
    }
  });
  assert.equal(result.decision.allowed, true);
  assert.equal(result.decision.source, 'user_confirmed');
  assert.equal(result.authorizationWaitMs >= 50, true,
    `the measured wait is what offsets the deadline (got ${result.authorizationWaitMs}ms)`);
});

test('an already-aborted run never redeems a decision', async () => {
  validationAuthorizationRegistry.reset();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => issue({ request: {
    sessionId: 's', approvalRootTaskId: 't', language: 'en', approvalMode: 'approve-all', signal: controller.signal
  } }, {
    host: async (request) => {
      validationAuthorizationRegistry.issue('aborted');
      return {
        decision: {
          allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
          scope: 'validation_compile_lint', source: 'host_signed',
          toolName: 'keepseek_run_validation', decisionId: 'aborted',
          executionSnapshot: request.fingerprint
        }
      };
    }
  }));
  assert.equal(validationAuthorizationRegistry.isAvailable('aborted'), true,
    'the id stays unused because nothing was executed');
});

/**
 * Regression guard for the exact shape of the original bug: an authorization
 * that is correct, issued and consumed must still let the process run. The
 * earlier revision of this fix re-checked availability at execution time and
 * denied every run, reproducing "validation is always refused" one layer down.
 */
test('a consumed decision still reaches execution: consumption happens before the intent', async () => {
  validationAuthorizationRegistry.reset();
  const { validateToolDecisionBeforeExecution } = await import('../src/agent/tools/validationTools.js');
  const decision: ToolAuthorizationDecision = {
    allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
    scope: 'validation_compile_lint', source: 'host_signed',
    toolName: 'keepseek_run_validation', decisionId: 'consumed-1', executionSnapshot: 'fp-1'
  };
  validationAuthorizationRegistry.issue('consumed-1');
  assert.equal(validationAuthorizationRegistry.consume('consumed-1'), true, 'the runner consumed it');
  assert.equal(validationAuthorizationRegistry.isAvailable('consumed-1'), false, 'it is spent');
  assert.equal(validateToolDecisionBeforeExecution(decision, 'compile'), undefined,
    'a spent-but-valid decision must execute; only replay protection lives in the runner');
});

test('the execution check still refuses a tampered decision', async () => {
  const { validateToolDecisionBeforeExecution } = await import('../src/agent/tools/validationTools.js');
  const base: ToolAuthorizationDecision = {
    allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium',
    scope: 'validation_compile_lint', source: 'host_signed',
    toolName: 'keepseek_run_validation', decisionId: 'd-1', executionSnapshot: 'fp-1'
  };
  assert.equal(validateToolDecisionBeforeExecution(base, 'compile'), undefined);
  assert.equal(validateToolDecisionBeforeExecution({ ...base, riskLevel: 'low' }, 'compile'), 'authorization_risk_mismatch');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, scope: 'validation_test' }, 'compile'), 'authorization_scope_mismatch');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, source: 'low_risk' }, 'compile'), 'authorization_source_untrusted');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, allowed: false }, 'compile'), 'authorization_not_allowed');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, decisionId: undefined }, 'compile'), 'authorization_decision_missing');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, executionSnapshot: undefined }, 'compile'), 'authorization_snapshot_missing');
  assert.equal(validateToolDecisionBeforeExecution({ ...base, toolName: 'other' }, 'compile'), 'authorization_tool_mismatch');
});
