import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebviewDomHarness } from './webviewDomHarness';

function projectView(initialWebviewState: unknown = null) {
  const view = createWebviewDomHarness(initialWebviewState);
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'legacy', language: 'en',
    startup: { interactiveReady: true, sideEffectsReady: true }, interaction: { sessionId: 'legacy',
      revision: 1, canEdit: true, canSubmit: false, canNavigate: false, canCancel: true, cancelOperationId: 'old', phase: 'running' } } });
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 1, viewGeneration: 0, viewTaskId: null,
    messages: [], cards: [
      { id: 'A', title: 'Task A', sessionId: 'session-A', rootTaskId: 'root-A', status: 'running', progress: 'Reading code', usedMs: 9000 },
      { id: 'B', title: 'Task B', sessionId: 'session-B', rootTaskId: 'root-B', status: 'waiting', waitingReason: 'approval' }
    ] });
  return view;
}

function cardButton(view: ReturnType<typeof projectView>, id: string) {
  return view.document.querySelector('[data-task-card-id="' + id + '"]')!.querySelector('button')!;
}
function type(view: ReturnType<typeof projectView>, text: string) {
  view.element('promptInput').textContent = text;
  view.element('promptInput').dispatchEvent({ type: 'input' });
}
function submit(view: ReturnType<typeof projectView>) {
  view.element('composer').dispatchEvent({ type: 'submit' });
}

test('project tasks render live cards, deterministic new/task inputs bypass Router and running views remain editable', () => {
  const view = projectView();
  assert.match(view.element('projectTaskList').textContent, /Task A/);
  assert.match(view.element('projectTaskList').textContent, /Reading code/);
  assert.equal(view.element('projectTaskList').children[0].dataset.taskCardId, 'B', 'user work precedes running tasks');
  view.element('projectNewTask').click();
  type(view, 'Create a new task'); submit(view);
  const create = view.posted.find(item => item.type === 'projectTaskCreate')!;
  assert.ok(create); assert.equal(create.targetId, '$new');
  assert.equal(view.posted.filter(item => item.type === 'projectAssistantSubmit').length, 0);
  cardButton(view, 'A').click();
  type(view, 'Keep the previous behavior'); submit(view);
  const supplement = view.posted.find(item => item.type === 'projectTaskSubmit')!;
  assert.ok(supplement); assert.equal(supplement.taskCardId, 'A'); assert.equal(supplement.rootTaskId, 'root-A');
  assert.equal(supplement.inputKind, 'supplement');
  assert.equal(view.element('sendButton').dataset.mode, 'send');
  assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
  assert.equal(view.posted.filter(item => item.type === 'abortPrompt').length, 0);
});

test('task drafts survive A to B to A and stale view publications cannot replace the target', () => {
  const view = projectView();
  cardButton(view, 'A').click(); type(view, 'draft A');
  cardButton(view, 'B').click(); type(view, 'draft B');
  cardButton(view, 'A').click();
  assert.equal(view.element('promptInput').textContent, 'draft A');
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 2, viewGeneration: 1, viewTaskId: 'B',
    messages: [{ id: 'late', role: 'assistant', content: 'wrong view' }] });
  assert.match(view.element('projectInputTarget').textContent, /Task A/);
  assert.equal(view.element('promptInput').textContent, 'draft A');
  assert.equal(view.state.messages.some((item: { id: string }) => item.id === 'late'), false);
  assert.ok(view.posted.some(item => item.type === 'projectTaskDraft' && item.targetId === 'A' && item.markup.includes('draft A')));
  const views = view.posted.filter(item => item.type === 'projectTaskView');
  assert.equal(views.length, 3);
  assert.deepEqual(views.map(item => item.taskCardId), ['A', 'B', 'A']);
  assert.equal(view.posted.filter(item => ['sendPrompt', 'projectTaskSubmit', 'projectAssistantSubmit', 'projectTaskCreate'].includes(item.type)).length, 0);
});

test('durable input ACK clears only its matching draft revision and never a newer edit', () => {
  const view = projectView();
  cardButton(view, 'A').click(); type(view, 'first draft'); submit(view);
  const input = view.posted.find(item => item.type === 'projectTaskSubmit')!;
  assert.equal(view.element('promptInput').textContent, 'first draft', 'saving does not clear input');
  type(view, 'a newer draft');
  view.receive({ type: 'projectTaskSubmissionResult', projectId: 'P', targetId: 'A', requestId: input.requestId, status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'a newer draft');
  submit(view);
  const second = view.posted.filter(item => item.type === 'projectTaskSubmit').at(-1)!;
  cardButton(view, 'B').click(); type(view, 'B draft');
  view.receive({ type: 'projectTaskSubmissionResult', projectId: 'P', targetId: 'A', requestId: second.requestId, status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'B draft');
  cardButton(view, 'A').click(); assert.equal(view.element('promptInput').textContent, '');
});

test('task view actions keep exact emission-time card identity, read-only still permits browsing', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  view.element('projectTaskDetail').querySelector('button')!.click();
  const stop = view.posted.find(item => item.type === 'projectTaskStop')!;
  assert.equal(stop.taskCardId, 'A'); assert.equal(stop.rootTaskId, 'root-A');
  cardButton(view, 'B').click();
  assert.equal(stop.taskCardId, 'A');
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 3, viewGeneration: 2, viewTaskId: 'B', readOnly: true });
  assert.equal(view.element('projectNewTask').disabled, true);
  assert.equal(view.element('projectStopAll').disabled, true);
  assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
  assert.ok(view.posted.some(item => item.type === 'projectTaskPainted' && item.taskCardId === 'B'));
  view.receive({ type: 'projectReadOnly', reason: 'another_owner' });
  assert.match(view.element('statusText').textContent, /read-only/);
});

test('a rejected input remains visible with its original target after switching tasks', () => {
  const view = projectView();
  cardButton(view, 'A').click(); type(view, 'unsaved A'); submit(view);
  const input = view.posted.find(item => item.type === 'projectTaskSubmit')!;
  cardButton(view, 'B').click(); type(view, 'draft B');
  view.receive({ type: 'projectTaskSubmissionResult', projectId: 'P', targetId: 'A', requestId: input.requestId, status: 'failed', reason: 'Disk full' });
  assert.match(view.element('statusText').textContent, /Task A: Disk full/);
  assert.equal(view.element('promptInput').textContent, 'draft B');
  cardButton(view, 'A').click();
  assert.equal(view.element('promptInput').textContent, 'unsaved A');
});

test('Router stop authorization requests explain the exact task and require a real Stop gesture', () => {
  const view = projectView();
  const request = { type: 'projectTaskStopAuthorization', projectId: 'P', taskCardId: 'A', title: 'Task A', requestId: 'stop-request' };
  view.receive(request);
  assert.equal(view.element('statusText').textContent, 'Confirm stopping Task A with its task-card Stop button.');
  assert.equal(view.posted.filter(item => ['projectTaskStop', 'projectTaskStopAll', 'projectAssistantSubmit'].includes(item.type)).length, 0);
  view.receive({ type: 'state', revision: 2, state: { language: 'zh-CN' } });
  view.receive(request);
  assert.equal(view.element('statusText').textContent, '请通过任务卡的停止按钮确认停止Task A');
  cardButton(view, 'A').click();
  view.element('projectTaskDetail').querySelector('button')!.click();
  const stop = view.posted.filter(item => item.type === 'projectTaskStop');
  assert.equal(stop.length, 1); assert.equal(stop[0].taskCardId, 'A');
  assert.equal(stop[0].rootTaskId, 'root-A');
});

test('Router overhead stays visible independently of the viewed task and preserves unknown cost', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 2, viewGeneration: 1, viewTaskId: 'A',
    routerUsage: [{ requestCount: 3, costByCurrency: { USD: 0.0024 }, incomplete: true }] });
  assert.match(view.element('projectRouterUsage').textContent, /Project Router: Reference cost USD 0.0024/);
  assert.match(view.element('projectRouterUsage').textContent, /3 requests/);
  assert.match(view.element('projectRouterUsage').textContent, /Incomplete usage/);
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 3, viewGeneration: 1, viewTaskId: 'A',
    routerUsage: [{ requestCount: 1 }] });
  assert.match(view.element('projectRouterUsage').textContent, /Cost unknown/);
});

test('deep history restores a bounded anchored hot page and Latest is a local deterministic action', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  const messages = Array.from({ length: 80 }, (_, index) => ({ id: 'deep-' + index,
    role: index % 2 ? 'assistant' : 'user', content: 'History ' + index }));
  view.receive({ type: 'state', taskCardId: 'A', viewGeneration: 1, revision: 2,
    state: { activeSessionId: 'session-A', messages, hasOlderMessages: false } });
  const rows = Array.from(view.element('transcript').querySelectorAll('.message[data-message-id]'));
  rows.forEach((row, index) => {
    row.getBoundingClientRect = () => ({ top: index < 20 ? -41 : (index - 20) * 40,
      bottom: index < 20 ? -1 : (index - 20) * 40 + 40 });
  });
  view.element('transcript').scrollTop = 800;
  view.element('transcript').dispatchEvent({ type: 'scroll' });
  cardButton(view, 'B').click(); cardButton(view, 'A').click();
  assert.equal(view.state.messages.length, 30);
  assert.equal(view.state.messages[0].id, 'deep-5');
  assert.ok(view.state.messages.some((message: { id: string }) => message.id === 'deep-20'));
  assert.equal(view.state.hasNewerMessages, true);
  assert.equal(view.element('projectLatestMessages').classList.contains('hidden'), false);
  view.receive({ type: 'state', taskCardId: 'A', viewGeneration: 3, revision: 3,
    state: { activeSessionId: 'session-A', messages: messages.slice(-30) } });
  assert.equal(view.state.messages[0].id, 'deep-5', 'Worker publications preserve the historical anchor');
  view.element('projectLatestMessages').click();
  const latest = view.posted.find(item => item.type === 'projectTaskLatest')!;
  assert.equal(latest.taskCardId, 'A'); assert.equal(latest.projectId, 'P');
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 4, viewGeneration: 3, viewTaskId: 'A',
    messages: messages.slice(-30), hasOlderMessages: true, hasNewerMessages: false });
  assert.equal(view.state.messages.at(-1).id, 'deep-79');
  assert.equal(view.state.hasNewerMessages, false);
  assert.equal(view.element('projectLatestMessages').classList.contains('hidden'), true);
  assert.equal(view.element('transcript').scrollTop, view.element('transcript').scrollHeight);
  assert.equal(view.posted.filter(item => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate', 'projectAssistantSubmit'].includes(item.type)).length, 0);
});


test('project drafts persist across Webview recreation and card-only progress never rebuilds the transcript', () => {
  const first = projectView();
  cardButton(first, 'A').click(); type(first, 'persist this task draft');
  first.element('transcript').scrollTop = 84;
  first.element('transcript').dispatchEvent({ type: 'scroll' });
  const restored = projectView(first.savedWebviewState());
  cardButton(restored, 'A').click();
  assert.equal(restored.element('promptInput').textContent, 'persist this task draft');
  assert.equal(restored.element('transcript').scrollTop, 84);
  const before = restored.element('transcript').firstChild;
  restored.receive({ type: 'projectTasksState', projectId: 'P', revision: 4, viewGeneration: 1, viewTaskId: 'A',
    cards: [{ taskCardId: 'A', state: 'running', sessionId: 'session-A', title: 'Task A', progress: 'Further progress' }] });
  assert.equal(restored.element('transcript').firstChild, before);
  assert.equal(restored.element('promptInput').textContent, 'persist this task draft');
  assert.match(restored.element('projectTaskList').textContent, /Further progress/);
});

test('legacy sessions retain normal input routing while project task controls remain available', () => {
  const view = projectView();
  view.receive({ type: 'projectTasksState', projectId: 'P', enabled: false, viewMode: 'legacy', viewGeneration: 1 });
  view.receive({ type: 'state', revision: 4, state: { activeSessionId: 'legacy', interaction: { sessionId: 'legacy', revision: 4,
    canEdit: true, canSubmit: true, canNavigate: true, canCancel: false, phase: 'idle' } } });
  type(view, 'ordinary session prompt'); submit(view);
  assert.equal(view.posted.filter(item => item.type === 'sendPrompt').length, 1);
  assert.equal(view.posted.filter(item => item.type === 'projectAssistantSubmit').length, 0);
  view.element('projectNewTask').click();
  assert.match(view.element('projectInputTarget').textContent, /New task/);
});


test('lost input ACK is reconciled by identity after Webview recreation without resending content', () => {
  const first = projectView();
  cardButton(first, 'A').click(); type(first, 'durable input with lost ACK'); submit(first);
  const sent = first.posted.find(item => item.type === 'projectTaskSubmit')!;
  const reopened = projectView(first.savedWebviewState());
  const reconcile = reopened.posted.find(item => item.type === 'projectTaskReconcile')!;
  assert.ok(reconcile); assert.equal(reconcile.requestId, sent.requestId); assert.equal(reconcile.targetId, 'A');
  assert.equal(reopened.posted.filter(item => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate', 'projectAssistantSubmit'].includes(item.type)).length, 0);
  reopened.receive({ type: 'projectTaskSubmissionResult', projectId: 'P', targetId: 'A', requestId: sent.requestId, status: 'accepted' });
  cardButton(reopened, 'A').click(); assert.equal(reopened.element('promptInput').textContent, '');
});

test('Router transcript is accepted only in the current project view generation', () => {
  const view = projectView();
  view.receive({ type: 'state', taskCardId: 'router-card', viewGeneration: 0, revision: 5,
    state: { activeSessionId: 'router-session', messages: [{ id: 'router-answer', role: 'assistant', content: 'Task dispatched' }] } });
  assert.equal(view.state.messages[0]?.id, 'router-answer');
  cardButton(view, 'A').click();
  view.receive({ type: 'state', taskCardId: 'router-card', viewGeneration: 0, revision: 6,
    state: { activeSessionId: 'router-session', messages: [{ id: 'stale-router', role: 'assistant', content: 'Stale answer' }] } });
  assert.equal(view.state.messages.some((item: { id: string }) => item.id === 'stale-router'), false);
});


test('independent Worker state revision sequences never suppress another task or Router', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  view.receive({ type: 'state', taskCardId: 'A', viewGeneration: 1, revision: 100,
    state: { activeSessionId: 'session-A', messages: [{ id: 'answer-A', role: 'assistant', content: 'A' }] } });
  cardButton(view, 'B').click();
  view.receive({ type: 'state', taskCardId: 'B', viewGeneration: 2, revision: 2,
    state: { activeSessionId: 'session-B', messages: [{ id: 'answer-B', role: 'assistant', content: 'B' }] } });
  assert.equal(view.state.messages[0]?.id, 'answer-B');
  view.element('projectAssistantView').click();
  view.receive({ type: 'state', taskCardId: 'router-card', viewGeneration: 3, revision: 1,
    state: { activeSessionId: 'router-session', messages: [{ id: 'router-first', role: 'assistant', content: 'Router' }] } });
  assert.equal(view.state.messages[0]?.id, 'router-first');
  cardButton(view, 'A').click();
  view.receive({ type: 'state', taskCardId: 'A', viewGeneration: 4, revision: 99,
    state: { activeSessionId: 'session-A', messages: [{ id: 'stale-A', role: 'assistant', content: 'stale' }] } });
  assert.equal(view.state.messages[0]?.id, 'answer-A');
});


test('legacy new-session navigation does not inherit the viewed task session identity', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  view.element('newChatTab').click();
  const navigation = view.posted.filter(item => item.type === 'newSession').at(-1)!;
  assert.ok(navigation);
  assert.equal(navigation.sessionId, undefined);
  assert.equal(navigation.taskCardId, undefined);
});


test('task edit-resend carries the originating task/session without borrowing its old root', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  view.receive({ type: 'state', taskCardId: 'A', viewGeneration: 1, revision: 6, state: { activeSessionId: 'session-A', messages: [
    { id: 'user-A', role: 'user', content: 'old request', userTask: { version: 1, id: 'root-A', originMessageId: 'user-A', reason: 'user' } }
  ] } });
  const transcript = view.element('transcript'), edit = transcript.querySelector('button[data-message-action="edit"]');
  assert.ok(edit); transcript.dispatchEvent({ type: 'click', target: edit });
  transcript.querySelector('.message-edit-input')!.textContent = 'replacement request';
  transcript.dispatchEvent({ type: 'submit', target: transcript.querySelector('.message-edit-form') });
  const sent = view.posted.find(item => item.type === 'editUserPrompt')!;
  assert.ok(sent); assert.equal(sent.taskCardId, 'A'); assert.equal(sent.sessionId, 'session-A');
  assert.equal(sent.messageId, 'user-A'); assert.equal(sent.rootTaskId, undefined);
  cardButton(view, 'B').click();
  assert.equal(sent.taskCardId, 'A', 'later viewing cannot retarget an already emitted edit');
});

test('legacy background-start and resume controls cannot open an independent task-mode root', () => {
  const view = projectView();
  view.receive({ type: 'state', revision: 9, state: { backgroundAvailableScripts: ['compile', 'test'], isBusy: false } });
  view.window.keepseekOpenBackgroundRunDialog();
  assert.equal(view.element('backgroundRunDialogOverlay').classList.contains('hidden'), true);
  view.element('backgroundStart').dispatchEvent({ type: 'click' });
  view.element('backgroundResume').dispatchEvent({ type: 'click' });
  assert.equal(view.posted.some(item => item.type === 'startBackgroundRun' || item.type === 'resumeBackgroundRun'), false);
});
