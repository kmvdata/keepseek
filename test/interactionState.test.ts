import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InteractionCoordinator, deriveInteractionState, deriveSessionTitleCapability,
  type InteractionFacts, type InteractionDiagnostic, type SessionTitleCapabilityFacts } from '../src/provider/interactionState';
import { localize, WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';

function ready(overrides: Partial<InteractionFacts> = {}): InteractionFacts {
  return { sessionId: 'A', revision: 1, sessionReady: true, requestContextReady: true,
    approvalDataReady: true, ...overrides };
}

test('Host title feedback and Webview disabled reasons use the same real bilingual catalog', () => {
  const outcomes = ['updated', 'unchanged', 'no_material', 'unavailable', 'busy', 'cancelled', 'stale', 'invalid', 'timeout', 'failed', 'save_failed'];
  const reasons = ['loading_sessions', 'recovering', 'model_unavailable', 'untrusted', 'busy', 'saving', 'unavailable'];
  for (const language of ['zh-CN', 'en'] as const) {
    for (const key of [...outcomes.map(value => `titleRefreshOutcome_${value}`), ...reasons.map(value => `titleRefreshReason_${value}`)]) {
      const host = localize(language, key);
      assert.notEqual(host, key, `${language} Host must not expose a translation key`);
      assert.equal(host, WEBVIEW_TRANSLATIONS[language][key]);
    }
  }
  assert.equal(localize('zh-CN', 'titleRefreshOutcome_updated'), '标题已更新。');
  assert.equal(localize('en', 'titleRefreshOutcome_updated'), 'Title updated.');
  assert.match(localize('zh-CN', 'titleRefreshOutcome_save_failed'), /保留旧标题/u);
  assert.match(localize('en', 'titleRefreshOutcome_save_failed'), /previous title was kept/u);
});

test('navigation owns its reservation before I/O but does not offer task cancellation', () => {
  const coordinator = new InteractionCoordinator();
  const owner = coordinator.begin('navigation', 'A', 'loading_session')!;
  assert.equal(coordinator.begin('task', 'A', 'preparing_task'), undefined);
  const loading = coordinator.snapshot(ready({ cancellable: true }));
  assert.equal(loading.phase, 'loading_session');
  assert.equal(loading.canSubmit, false);
  assert.equal(loading.canNavigate, false);
  assert.equal(loading.canEdit, true);
  assert.equal(loading.canCancel, false);
  assert.equal(loading.cancelOperationId, undefined);
  assert.equal(coordinator.update(owner, 'preparing_context', 'B'), true);
  assert.equal(coordinator.snapshot(ready({ sessionId: 'B' })).operationId, owner.operationId);
  assert.equal(coordinator.finish(owner), true);
  const idle = coordinator.snapshot(ready({ sessionId: 'B', revision: 2 }));
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.revision, 2);
  assert.equal(idle.canSubmit, true);
  assert.equal(idle.canNavigate, true);
});

test('late completion and copied tokens cannot release or overwrite a new owner', () => {
  const coordinator = new InteractionCoordinator();
  const old = coordinator.begin('navigation', 'A', 'loading_session')!;
  coordinator.finish(old);
  const current = coordinator.begin('task', 'B', 'preparing_task')!;
  assert.equal(coordinator.finish(old), false);
  assert.equal(coordinator.update(old, 'failed', 'A'), false);
  assert.equal(coordinator.finish({ ...current }), false);
  assert.equal(coordinator.current, current);
  assert.ok(current.generation > old.generation);
  const state = coordinator.snapshot(ready({ sessionId: 'B', cancellable: true }));
  assert.equal(state.phase, 'preparing_task');
  assert.equal(state.cancelOperationId, current.operationId);
  assert.equal(state.canSubmit, false);
});

test('settlement waits for its exact owner and stale finalizers cannot settle another generation', async () => {
  const coordinator = new InteractionCoordinator();
  await coordinator.whenSettled();
  const old = coordinator.begin('navigation', 'A', 'loading_session')!;
  let oldSettled = false;
  const oldWaiter = coordinator.whenSettled().then(() => { oldSettled = true; });
  coordinator.finish({ ...old });
  await Promise.resolve();
  assert.equal(oldSettled, false);
  coordinator.finish(old);
  const current = coordinator.begin('continuation', 'A', 'saving')!;
  let currentSettled = false;
  const currentWaiter = coordinator.whenSettled().then(() => { currentSettled = true; });
  await oldWaiter;
  assert.equal(oldSettled, true);
  assert.equal(currentSettled, false);
  assert.equal(coordinator.finish(old), false);
  await Promise.resolve();
  assert.equal(currentSettled, false);
  coordinator.finish(current);
  await currentWaiter;
  assert.equal(currentSettled, true);
});

test('necessary saving keeps admission closed without retaining a model-running or Stop state', () => {
  const coordinator = new InteractionCoordinator();
  const owner = coordinator.begin('task', 'A', 'preparing_task')!;
  assert.equal(coordinator.snapshot(ready({ mainRunning: true, cancellable: true })).phase, 'running');
  coordinator.update(owner, 'saving');
  const saving = coordinator.snapshot(ready({ starting: true, cancellable: true }));
  assert.equal(saving.phase, 'saving');
  assert.equal(saving.canSubmit, false);
  assert.equal(saving.canCancel, false);
  coordinator.finish(owner);
  assert.equal(coordinator.snapshot(ready()).phase, 'idle');
});

test('cancel requires a current actual owner; readiness and context failures are separate facts', () => {
  assert.equal(deriveInteractionState(ready({ mainRunning: true, cancellable: true })).canCancel, false);
  const run = deriveInteractionState(ready({ mainRunning: true, cancellable: true, cancelOperationId: 'run-current' }));
  assert.equal(run.canCancel, true);
  assert.equal(run.cancelOperationId, 'run-current');
  assert.equal(run.canNavigate, false);
  const context = deriveInteractionState(ready({ contextRefreshing: true }));
  assert.equal(context.phase, 'preparing_context');
  assert.equal(context.canEdit, true);
  assert.equal(context.canSubmit, false);
  assert.equal(context.canNavigate, false);
  const failed = deriveInteractionState(ready({ failure: 'Unable to save; retry required' }));
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.canSubmit, false);
  assert.equal(failed.canNavigate, true);
  assert.equal(failed.blockingReason, 'Unable to save; retry required');
  const startupFailure = deriveInteractionState(ready({ requestContextReady: false, failure: 'Context read failed' }));
  assert.equal(startupFailure.phase, 'failed', 'an unsuccessful preparation cannot keep a loading spinner alive');
  assert.equal(startupFailure.canSubmit, false);
  assert.equal(startupFailure.canNavigate, true);
});

test('old operation scope cannot advertise a new session as ready or cancellable', () => {
  const coordinator = new InteractionCoordinator();
  coordinator.begin('task', 'A', 'running');
  const other = coordinator.snapshot(ready({ sessionId: 'B', cancellable: true }));
  assert.equal(other.sessionId, 'B');
  assert.equal(other.operationId, undefined);
  assert.equal(other.phase, 'loading_session');
  assert.equal(other.canSubmit, false);
  assert.equal(other.canCancel, false);
});

test('display-only background work has no ownership; runtime background exclusivity is retained', () => {
  const coordinator = new InteractionCoordinator();
  assert.equal(coordinator.snapshot(ready()).canSubmit, true);
  const exclusiveBackground = coordinator.snapshot(ready({ backgroundRunning: true }));
  assert.equal(exclusiveBackground.phase, 'action');
  assert.equal(exclusiveBackground.canSubmit, false);
  assert.equal(exclusiveBackground.canNavigate, false);
  const startup = coordinator.snapshot(ready({ sessionReady: false }));
  assert.equal(startup.phase, 'loading_session');
  assert.equal(startup.canEdit, true);
  assert.equal(startup.canSubmit, false);
  assert.equal(startup.canCancel, false);
});

test('diagnostics record phases, safe session identity and elapsed time without affecting owners', () => {
  let now = 10;
  const events: InteractionDiagnostic[] = [];
  const coordinator = new InteractionCoordinator({ now: () => now, id: () => 'controlled', onDiagnostic: event => events.push(event) });
  const owner = coordinator.begin('task', 'session-with-private-data', 'preparing_task')!;
  now = 30;
  coordinator.update(owner, 'running');
  now = 70;
  coordinator.finish(owner);
  assert.deepEqual(events.map(event => [event.event, event.elapsedMs]), [['begin', 0], ['phase', 20], ['finish', 60]]);
  assert.ok(events.every(event => /^[a-f0-9]{12}$/u.test(event.session)));
  assert.ok(events.every(event => event.operationId === owner.operationId && event.generation === owner.generation));
  const broken = new InteractionCoordinator({ onDiagnostic: () => { throw new Error('diagnostic failure'); } });
  const token = broken.begin('task', 'A', 'preparing_task')!;
  assert.equal(broken.finish(token), true);
  assert.equal(broken.current, undefined);
});

test('model, operation recovery, context and persistence waits remain distinct without fake readiness', () => {
  const model = deriveInteractionState(ready({ requestContextReady: false, modelReady: false, contextReady: true }));
  assert.equal(model.waitingReason, 'model');
  assert.equal(model.canSubmit, false);
  assert.equal(model.canEdit, true);
  const recovery = deriveInteractionState(ready({ sessionRecoveryReady: false, modelReady: true, contextReady: true }));
  assert.equal(recovery.waitingReason, 'recovery');
  assert.equal(recovery.canSubmit, false);
  const context = deriveInteractionState(ready({ contextReady: false, modelReady: true }));
  assert.equal(context.waitingReason, 'context');
  assert.equal(context.canSubmit, false, 'detailed context facts cannot be bypassed by the old aggregate');
  const complete = deriveInteractionState(ready({ contextReady: true, modelReady: true, sessionRecoveryReady: true }));
  assert.equal(complete.phase, 'idle');
  assert.equal(complete.waitingReason, undefined);
  assert.equal(complete.canSubmit, true);

  const coordinator = new InteractionCoordinator();
  const owner = coordinator.begin('navigation', 'A', 'saving')!;
  assert.equal(coordinator.snapshot(ready()).waitingReason, 'saving');
  coordinator.update(owner, 'preparing_context');
  assert.equal(coordinator.snapshot(ready({ modelReady: false, contextReady: true })).waitingReason, 'model');
  coordinator.finish(owner);
  assert.equal(coordinator.snapshot(ready()).canSubmit, true);
});

function titleReady(overrides: Partial<SessionTitleCapabilityFacts> = {}): SessionTitleCapabilityFacts {
  return { sessionReady: true, approvalDataReady: true, modelReady: true, trusted: true, ...overrides };
}

test('title refresh is independent of project context preparation but preserves exact safety conflicts', () => {
  const preparing = titleReady({ foregroundKind: 'navigation', foregroundPhase: 'preparing_context' });
  assert.deepEqual(deriveSessionTitleCapability(preparing), { available: true });
  assert.deepEqual(deriveSessionTitleCapability(titleReady({ foregroundKind: 'recovery', foregroundPhase: 'preparing_context' })),
    { available: true }, 'a context-only retry/refresh does not own the naming model or material');
  assert.equal(deriveInteractionState(ready({ contextReady: false })).canSubmit, false,
    'submission and auxiliary naming have separate dependencies');
  assert.deepEqual(deriveSessionTitleCapability(titleReady({ foregroundKind: 'navigation', foregroundPhase: 'loading_session' })),
    { available: false, reason: 'recovering' });
  assert.deepEqual(deriveSessionTitleCapability(titleReady({ foregroundKind: 'navigation', foregroundPhase: 'saving' })),
    { available: false, reason: 'saving' });
  for (const overrides of [{ mainRunning: true }, { actionRunning: true }, { backgroundRunning: true },
    { foregroundKind: 'task' as const }, { foregroundKind: 'recovery' as const }]) {
    assert.deepEqual(deriveSessionTitleCapability(titleReady(overrides)), { available: false, reason: 'busy' });
  }
});

test('title capability explains missing initialization, trust and model without granting authority', () => {
  const cases: Array<[Partial<SessionTitleCapabilityFacts>, string]> = [
    [{ sessionReady: false }, 'loading_sessions'],
    [{ approvalDataReady: false }, 'recovering'],
    [{ trusted: false }, 'untrusted'],
    [{ modelReady: false }, 'model_unavailable'],
    [{ subagentModelReady: false }, 'model_unavailable'],
    [{ saving: true }, 'saving'],
    [{ disposed: true }, 'unavailable']
  ];
  for (const [facts, reason] of cases) {
    assert.deepEqual(deriveSessionTitleCapability(titleReady(facts)), { available: false, reason });
  }
  assert.deepEqual(deriveSessionTitleCapability(titleReady()), { available: true });
});
