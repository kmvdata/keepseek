import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebviewDomHarness } from './webviewDomHarness';

function projectView(initialWebviewState: unknown = null) {
  const view = createWebviewDomHarness(initialWebviewState);
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'legacy', language: 'en',
    startup: { interactiveReady: true, sideEffectsReady: true }, interaction: { sessionId: 'legacy',
      revision: 1, canEdit: true, canSubmit: false, canNavigate: false, canCancel: true, cancelOperationId: 'old', phase: 'running' } } });
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 1, viewGeneration: 0, viewTaskId: null,
    messages: [], cards: [
      { id: 'A', title: 'Task A', sessionId: 'session-A', rootTaskId: 'root-A', status: 'running', progress: 'Reading code', usedMs: 9000,
        firstSubmittedAt: '2026-11-01T00:00:00.000Z', firstSubmittedAtSource: 'user_input' },
      { id: 'B', title: 'Task B', sessionId: 'session-B', rootTaskId: 'root-B', status: 'waiting', waitingReason: 'approval',
        firstSubmittedAt: '2026-11-01T00:00:01.000Z', firstSubmittedAtSource: 'user_input' }
    ] });
  return view;
}

// Task rows live only in the drawer list now; the rail keeps no lamp list.
function cardButton(view: ReturnType<typeof projectView>, id: string) {
  openSidebar(view);
  const node = view.element('projectTaskList').querySelector('[data-task-card-id="' + id + '"]')!;
  return node.tagName === 'BUTTON' ? node : node.querySelector('button')!;
}
function openSidebar(view: ReturnType<typeof projectView>) {
  if (view.element('projectTaskSidebar').classList.contains('hidden')) view.element('projectSidebarToggle').click();
}
// Redesigned rail buttons drive the view through the exposed host API.
function rail(view: ReturnType<typeof projectView>) {
  return (view.window as unknown as { keepseekProjectTasks: {
    openSidebar(): void; closeSidebar(): void; toggleSidebar(): void; isSidebarOpen(): boolean;
    selectView(taskCardId: string | null, mode?: string): void; } }).keepseekProjectTasks;
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
  openSidebar(view);
  assert.match(view.element('projectTaskList').textContent, /Task A/);
  assert.match(view.element('projectTaskList').textContent, /Reading code/);
  assert.equal(view.element('projectTaskList').children[0].dataset.taskCardId, 'A', 'first submission order is independent of task state');
  rail(view).selectView(null, 'new');
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
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 2, viewGeneration: 1, viewTaskId: 'B',
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
  openSidebar(view);
  view.element('projectTaskDetail').querySelector('button')!.click();
  const stop = view.posted.find(item => item.type === 'projectTaskStop')!;
  assert.equal(stop.taskCardId, 'A'); assert.equal(stop.rootTaskId, 'root-A');
  cardButton(view, 'B').click();
  assert.equal(stop.taskCardId, 'A');
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 3, viewGeneration: 2, viewTaskId: 'B', readOnly: true, capabilities: { canSubmit: false, canCreateTarget: true } });
  assert.equal(view.element('projectStopAll').disabled, true);
  assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
  openSidebar(view);
  const mutations = view.element('projectTaskDetail').querySelectorAll('button').filter(button => /Stop this|Continue original|Archive|Delete permanently/u.test(button.textContent));
  assert.ok(mutations.length >= 3);
  assert.equal(mutations.every(button => button.disabled), true);
  const mutationCount = view.posted.filter(item => /projectTask(?:Stop|Resume|Archive|Delete)$/u.test(item.type)).length;
  mutations.forEach(button => button.click());
  assert.equal(view.posted.filter(item => /projectTask(?:Stop|Resume|Archive|Delete)$/u.test(item.type)).length, mutationCount);
  assert.ok(view.posted.some(item => item.type === 'projectTaskPainted' && item.taskCardId === 'B'));
  view.receive({ type: 'projectReadOnly', reason: 'another_owner' });
  assert.match(view.element('statusText').textContent, /another_owner/);
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
  openSidebar(view);
  view.element('projectTaskDetail').querySelector('button')!.click();
  const stop = view.posted.filter(item => item.type === 'projectTaskStop');
  assert.equal(stop.length, 1); assert.equal(stop[0].taskCardId, 'A');
  assert.equal(stop[0].rootTaskId, 'root-A');
});

test('Router overhead stays visible independently of the viewed task and preserves unknown cost', () => {
  const view = projectView();
  cardButton(view, 'A').click();
  openSidebar(view);
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 2, viewGeneration: 1, viewTaskId: 'A',
    routerUsage: [{ requestCount: 3, costByCurrency: { USD: 0.0024 }, incomplete: true }] });
  assert.match(view.element('projectRouterUsage').textContent, /Project Router: Reference cost USD 0.0024/);
  assert.match(view.element('projectRouterUsage').textContent, /3 requests/);
  assert.match(view.element('projectRouterUsage').textContent, /Incomplete usage/);
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 3, viewGeneration: 1, viewTaskId: 'A',
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
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 4, viewGeneration: 3, viewTaskId: 'A',
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
  restored.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 4, viewGeneration: 1, viewTaskId: 'A',
    cards: [{ taskCardId: 'A', state: 'running', sessionId: 'session-A', title: 'Task A', progress: 'Further progress' }] });
  assert.equal(restored.element('transcript').firstChild, before);
  assert.equal(restored.element('promptInput').textContent, 'persist this task draft');
  openSidebar(restored);
  assert.match(restored.element('projectTaskList').textContent, /Further progress/);
});

test('legacy sessions retain normal input routing while project task controls remain available', () => {
  const view = projectView();
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, viewMode: 'legacy', viewGeneration: 1 });
  view.receive({ type: 'state', revision: 4, state: { activeSessionId: 'legacy', interaction: { sessionId: 'legacy', revision: 4,
    canEdit: true, canSubmit: true, canNavigate: true, canCancel: false, phase: 'idle' } } });
  type(view, 'ordinary session prompt'); submit(view);
  assert.equal(view.posted.filter(item => item.type === 'sendPrompt').length, 1);
  assert.equal(view.posted.filter(item => item.type === 'projectAssistantSubmit').length, 0);
  rail(view).selectView(null, 'new');
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
  rail(view).selectView(null, 'project');
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

function sidebarCard(id: string, state = 'completed', extra: Record<string, unknown> = {}) {
  return { taskCardId: id, title: 'Task ' + id, sessionId: 'session-' + id, rootTaskId: 'root-' + id,
    state, firstSubmittedAt: '2026-11-01T00:00:00.000Z', firstSubmittedAtSource: 'user_input',
    lastActivityAt: '2026-11-08T00:00:00.000Z', usedMs: 1000, ...extra };
}
function sidebarIds(view: ReturnType<typeof projectView>, id = 'projectTaskList') {
  openSidebar(view);
  return view.element(id).children.map(node => node.dataset.taskCardId).filter(Boolean);
}
function sidebarPublish(view: ReturnType<typeof projectView>, cards: ReturnType<typeof sidebarCard>[], revision: number) {
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision, cards });
}

test('sidebar starts collapsed and UI-only controls preserve transcript, target and unrelated persisted state', () => {
  const view = projectView({ unrelated: { preserved: true }, projectTaskDrafts: [['P:A', {
    targetId: 'A', revision: 1, markup: 'old draft', skillIds: ['skill-one'], expanded: true
  }]] });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true, 'old details expanded is not sidebar preference');
  const transcript = view.element('transcript').firstChild;
  const start = view.posted.length;
  view.element('projectSidebarToggle').click();
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  view.element('projectTaskScope').value = 'all'; view.element('projectTaskScope').dispatchEvent({ type: 'change' });
  view.element('projectShowArchived').checked = true; view.element('projectShowArchived').dispatchEvent({ type: 'change' });
  const firstCard = cardButton(view, 'A');
  firstCard.dispatchEvent({ type: 'mouseenter' });
  firstCard.dispatchEvent({ type: 'focus' });
  view.element('projectSidebarClose').click();
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
  assert.equal(view.element('transcript').firstChild, transcript);
  assert.equal(view.posted.slice(start).some(item => /Submit|Create|TaskView|sendPrompt|resume|Stop/iu.test(item.type)), false);
  assert.deepEqual((view.savedWebviewState() as any).unrelated, { preserved: true });
  const reopened = projectView(view.savedWebviewState());
  assert.equal(reopened.element('projectTaskSidebar').classList.contains('hidden'), true);
  view.element('projectSidebarToggle').click();
  const reopenedOpen = projectView(view.savedWebviewState());
  assert.equal(reopenedOpen.element('projectTaskSidebar').classList.contains('hidden'), false, 'explicit window preference survives a Webview rebuild');
});

test('sidebar uses immutable first-time order, Registry tie order and keyed nodes across phase and usage changes', () => {
  const view = projectView(); view.setNow(Date.parse('2026-11-08T01:00:00.000Z'));
  const cards = [sidebarCard('C', 'running', { firstSubmittedAt: '2026-11-03T00:00:00.000Z' }),
    sidebarCard('A', 'running'), sidebarCard('B', 'waiting')];
  sidebarPublish(view, cards, 2); openSidebar(view);
  assert.deepEqual(sidebarIds(view, 'projectTaskList'), ['A', 'B', 'C']);
  const buttons = ['A', 'B', 'C'].map(id => cardButton(view, id));
  buttons[0].focus();
  const ring = buttons[0].querySelector('.project-task-ring');
  const transcript = view.element('transcript').firstChild;
  const metrics = view.domMetrics();
  for (let index = 0; index < 30; index++) {
    sidebarPublish(view, cards.map((card, cardIndex) => ({ ...card,
      state: ['running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'][(index + cardIndex) % 6],
      title: 'Changed ' + card.taskCardId + ' ' + index, progress: 'Step ' + index,
      costByCurrency: { USD: index / 1000 } })), index + 3);
    assert.deepEqual(sidebarIds(view, 'projectTaskList'), ['A', 'B', 'C']);
  }
  assert.equal(cardButton(view, 'A'), buttons[0]);
  assert.equal(cardButton(view, 'A').querySelector('.project-task-ring'), ring);
  assert.equal(view.document.activeElement, buttons[0]);
  assert.equal(view.element('transcript').firstChild, transcript);
  assert.deepEqual(view.domMetrics(), metrics, 'phase, title and statistics update existing elements without rebuilding rows or rings');
});

test('rolling 24-hour scope keeps every unfinished task and expires exactly at the boundary without mutating tasks', () => {
  const view = projectView(); const now = Date.parse('2026-11-08T00:00:00.000Z'); view.setNow(now);
  const old = new Date(now - 3 * 86400000).toISOString();
  const cards = [sidebarCard('recent', 'completed', { lastActivityAt: new Date(now - 86400000 + 1).toISOString() }),
    sidebarCard('boundary', 'failed', { lastActivityAt: new Date(now - 86400000).toISOString() }),
    sidebarCard('old', 'cancelled', { lastActivityAt: old }),
    ...['queued', 'preparing', 'running', 'waiting', 'settling', 'stopping'].map(state => sidebarCard(state, state, { lastActivityAt: old, archived: true })),
    sidebarCard('interrupted', 'interrupted', { lastActivityAt: old }),
    sidebarCard('archivedInterrupted', 'interrupted', { lastActivityAt: old, archived: true }),
    sidebarCard('unknown', 'completed', { lastActivityAt: undefined, firstSubmittedAtSource: 'associated' })];
  sidebarPublish(view, cards, 2);
  const start = view.posted.length;
  view.advance(60000);
  assert.equal(view.posted.slice(start).some(item => /Stop|Delete|Archive|Submit|TaskView/iu.test(item.type)), false);
  openSidebar(view);
  assert.deepEqual(sidebarIds(view, 'projectTaskList'), ['queued', 'preparing', 'running', 'waiting', 'settling', 'stopping', 'interrupted']);
  view.element('projectTaskScope').value = 'all'; view.element('projectTaskScope').dispatchEvent({ type: 'change' });
  assert.equal(sidebarIds(view, 'projectTaskList').includes('boundary'), true);
  assert.equal(sidebarIds(view, 'projectTaskList').includes('unknown'), true);
  assert.equal(sidebarIds(view, 'projectTaskList').includes('archivedInterrupted'), false);
  view.element('projectShowArchived').checked = true; view.element('projectShowArchived').dispatchEvent({ type: 'change' });
  assert.equal(sidebarIds(view, 'projectTaskList').includes('archivedInterrupted'), true);
});

test('current expired terminal remains in original rail position only while explicitly viewed', () => {
  const view = projectView(); view.setNow(Date.parse('2026-11-08T00:00:00.000Z'));
  const cards = [sidebarCard('old', 'completed', { lastActivityAt: '2026-11-01T00:00:00.000Z' }), sidebarCard('live', 'running')];
  sidebarPublish(view, cards, 2); openSidebar(view);
  view.element('projectTaskScope').value = 'all'; view.element('projectTaskScope').dispatchEvent({ type: 'change' });
  view.element('projectTaskList').querySelector('[data-task-card-id="old"]')!.querySelector('button')!.click();
  assert.match(cardButton(view, 'old').getAttribute('aria-label') || '', /Current|view/iu);
  cardButton(view, 'live').click();
  // The explicit "all" scope keeps the expired terminal row; only the label moves.
  assert.deepEqual(sidebarIds(view, 'projectTaskList'), ['old', 'live']);
  assert.doesNotMatch(cardButton(view, 'old').getAttribute('aria-label') || '', /Currently viewing/u);
  sidebarPublish(view, cards.map(card => card.taskCardId === 'live' ? { ...card, state: 'completed', archived: true,
    lastActivityAt: '2026-11-01T00:00:00.000Z' } : card), 3);
  assert.equal(sidebarIds(view, 'projectTaskList').includes('live'), false, 'explicit archive is not overridden by current view');
});

test('independent context rings distinguish unknown, real zero, over-limit and restored snapshots without faking completion', () => {
  const view = projectView(); view.setNow(Date.parse('2026-11-08T00:00:00.000Z'));
  const snapshot = (usedTokensEstimate: number, maxTokensEstimate: number, usedPercent: number, status = 'current') => ({
    version: 1, identity: {}, laneFingerprint: 'lane', sequence: 1, projectionRevision: 1,
    recordedAt: '2026-11-07T23:59:00.000Z', status, usage: { usedTokensEstimate, maxTokensEstimate, usedPercent }
  });
  const cards = [sidebarCard('zero', 'running', { contextUsageSnapshot: snapshot(0, 1000, 0) }),
    sidebarCard('done', 'completed', { contextUsageSnapshot: snapshot(400, 1000, 40) }),
    sidebarCard('over', 'running', { contextUsageSnapshot: snapshot(1500, 1000, 150) }),
    sidebarCard('unknown', 'running'),
    sidebarCard('bad', 'running', { contextUsageSnapshot: snapshot(Number.NaN, 1000, 40) }),
    sidebarCard('restored', 'completed', { contextUsageSnapshot: snapshot(200, 1000, 20, 'last_known') })];
  sidebarPublish(view, cards, 2);
  const ring = (id: string) => cardButton(view, id).querySelector('.project-task-ring')!;
  assert.equal(ring('zero').getAttribute('aria-valuenow'), '0');
  assert.equal(ring('done').getAttribute('aria-valuenow'), '40');
  assert.equal(ring('over').getAttribute('aria-valuenow'), '100');
  assert.match(ring('over').getAttribute('aria-valuetext') || '', /150/);
  assert.equal(ring('unknown').dataset.usageStatus, 'unknown');
  assert.equal(ring('unknown').getAttribute('aria-valuenow'), null);
  assert.equal(ring('bad').getAttribute('aria-valuenow'), null);
  assert.equal(ring('restored').dataset.usageStatus, 'last_known');
  sidebarPublish(view, cards.map(card => card.taskCardId === 'done' ? { ...card,
    contextUsageSnapshot: snapshot(100, 2000, 5) } : card), 3);
  assert.equal(ring('done').getAttribute('aria-valuenow'), '5', 'compression or epoch can reduce display percentage');
  assert.equal(ring('zero').getAttribute('aria-valuenow'), '0', 'another task update never supplies its percentage');
});

test('IME view changes wait for composition, preserve confirmed source draft and discard superseded switch', () => {
  const view = projectView(); cardButton(view, 'A').click();
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(view, '输入候选');
  const start = view.posted.filter(item => item.type === 'projectTaskView').length;
  cardButton(view, 'B').click(); rail(view).selectView(null, 'project');
  assert.match(view.element('projectInputTarget').textContent, /Task A/);
  assert.equal(view.posted.filter(item => item.type === 'projectTaskView').length, start);
  type(view, '输入完成'); view.element('promptInput').dispatchEvent({ type: 'compositionend' }); view.advance(0);
  assert.match(view.element('projectInputTarget').textContent, /Project assistant/);
  const views = view.posted.filter(item => item.type === 'projectTaskView');
  assert.equal(views.length, start + 1); assert.equal(views.at(-1)!.taskCardId, null);
  cardButton(view, 'A').click(); assert.equal(view.element('promptInput').textContent, '输入完成');
  assert.equal(view.posted.some(item => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate'].includes(item.type)), false);
});

test('outside mousedown closes sidebar without consuming original click and composing Escape is left to IME', () => {
  const view = projectView(); openSidebar(view);
  const outside = { type: 'mousedown', target: view.element('promptInput'), defaultPrevented: false };
  view.document.dispatchEvent(outside);
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
  assert.equal(outside.defaultPrevented, false);
  openSidebar(view); view.element('promptInput').dispatchEvent({ type: 'compositionstart' });
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape', isComposing: true });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  view.element('promptInput').dispatchEvent({ type: 'compositionend' }); view.advance(0);
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
  assert.equal(view.document.activeElement, view.element('projectSidebarToggle'));
});

test('tooltip uses light safe metadata, preserves its node through progress and never fetches a session', () => {
  const view = projectView();
  sidebarPublish(view, [sidebarCard('A', 'waiting', { title: '<img src=x onerror=alert(1)> Long task title',
    waitingReason: 'approval', progress: 'Waiting for review', firstSubmittedAtSource: 'session_created' })], 2);
  const start = view.posted.length;
  const button = cardButton(view, 'A'); button.dispatchEvent({ type: 'mouseenter' });
  const tooltip = view.element('projectTaskTooltip');
  assert.equal(tooltip.classList.contains('hidden'), false);
  assert.match(tooltip.textContent, /<img src=x onerror=alert\(1\)> Long task title/);
  assert.match(tooltip.textContent, /session|created/iu);
  assert.equal(tooltip.querySelector('img'), null);
  sidebarPublish(view, [sidebarCard('A', 'waiting', { title: '<img src=x onerror=alert(1)> Long task title',
    waitingReason: 'approval', progress: 'Still waiting', firstSubmittedAtSource: 'session_created' })], 3);
  assert.equal(view.element('projectTaskTooltip'), tooltip);
  assert.equal(tooltip.classList.contains('hidden'), false);
  assert.equal(view.posted.slice(start).some(item => ['projectTaskPrefetch', 'projectTaskView', 'loadOlderMessages',
    'regenerateSessionTitle', 'projectAssistantSubmit', 'projectTaskSubmit'].includes(item.type)), false);
  view.document.querySelector('.project-sidebar-content')!.dispatchEvent({ type: 'scroll' });
  assert.equal(tooltip.classList.contains('hidden'), true);
});

test('Escape dismisses the upper temporary interface before sidebar and sidebar preferences stay project scoped', () => {
  const view = projectView(); openSidebar(view);
  view.element('settingsTab').click();
  assert.equal(view.element('settingsMenu').classList.contains('hidden'), false);
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('settingsMenu').classList.contains('hidden'), true);
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'Q', revision: 1, viewGeneration: 0, cards: [], messages: [] });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 3, viewGeneration: 0, cards: [], messages: [] });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
});

test('IME new-session navigation waits for final input and saves the confirmed task draft before emitting navigation', () => {
  const view = projectView(); cardButton(view, 'A').click();
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(view, '输入候选');
  view.element('newChatTab').click();
  assert.equal(view.posted.some(item => item.type === 'newSession'), false);
  view.element('promptInput').dispatchEvent({ type: 'compositionend' });
  type(view, '输入确认后的最终文本');
  assert.equal(view.posted.some(item => item.type === 'newSession'), false, 'the final input event shares the composition settlement boundary');
  view.advance(0);
  const navigationIndex = view.posted.findIndex(item => item.type === 'newSession');
  assert.ok(navigationIndex >= 0);
  const navigation = view.posted[navigationIndex];
  assert.equal(navigation.taskCardId, undefined); assert.equal(navigation.sessionId, undefined);
  assert.ok(view.posted.slice(0, navigationIndex).some(item => item.type === 'projectTaskDraft'
    && item.targetId === 'A' && item.markup.includes('输入确认后的最终文本')));
  assert.equal(view.posted.filter(item => item.type === 'newSession').length, 1);
  assert.equal(view.posted.some(item => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate'].includes(item.type)), false);
});

test('the latest IME navigation gesture wins across task clicks and ordinary history selection', () => {
  const taskWins = projectView(); cardButton(taskWins, 'A').click();
  taskWins.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(taskWins, '原任务文本');
  taskWins.element('newChatTab').click(); cardButton(taskWins, 'B').click();
  taskWins.element('promptInput').dispatchEvent({ type: 'compositionend' }); taskWins.advance(0);
  assert.equal(taskWins.posted.some(item => item.type === 'newSession'), false);
  assert.equal(taskWins.posted.filter(item => item.type === 'projectTaskView').at(-1)!.taskCardId, 'B');
  cardButton(taskWins, 'A').click(); assert.equal(taskWins.element('promptInput').textContent, '原任务文本');

  const historyWins = projectView(); cardButton(historyWins, 'A').click();
  historyWins.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(historyWins, '历史切换前确认');
  cardButton(historyWins, 'B').click(); historyWins.element('newChatTab').click();
  const row = historyWins.document.createElement('div'); row.dataset.sessionId = 'ordinary-history';
  row.setAttribute('data-session-id', 'ordinary-history'); historyWins.element('sessionMenu').append(row);
  historyWins.element('sessionMenu').dispatchEvent({ type: 'click', target: row });
  assert.equal(historyWins.posted.some(item => ['newSession', 'selectSession'].includes(item.type)), false);
  historyWins.element('promptInput').dispatchEvent({ type: 'compositionend' }); historyWins.advance(0);
  const navigations = historyWins.posted.filter(item => ['newSession', 'selectSession'].includes(item.type));
  assert.equal(navigations.length, 1); assert.equal(navigations[0].type, 'selectSession');
  assert.equal(navigations[0].sessionId, 'ordinary-history'); assert.equal(navigations[0].taskCardId, undefined);
  assert.equal(historyWins.posted.filter(item => item.type === 'projectTaskView').length, 1, 'superseded task selection never executes');
  assert.ok(historyWins.posted.some(item => item.type === 'projectTaskDraft' && item.targetId === 'A' && item.markup.includes('历史切换前确认')));
});

test('ordinary sessions without a project defer new-session navigation while the composer is composing', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'ordinary', language: 'en', messages: [],
    startup: { interactiveReady: true, sideEffectsReady: true }, interaction: { sessionId: 'ordinary', revision: 1,
      canEdit: true, canSubmit: true, canNavigate: true, canCancel: false, phase: 'idle' } } });
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(view, '普通会话输入');
  view.element('newChatTab').click();
  assert.equal(view.posted.some(item => item.type === 'newSession'), false);
  view.element('promptInput').dispatchEvent({ type: 'compositionend' }); type(view, '普通会话确认'); view.advance(0);
  assert.equal(view.posted.filter(item => item.type === 'newSession').length, 1);
  assert.equal(view.element('promptInput').textContent, '普通会话确认');
  assert.equal(view.posted.some(item => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate'].includes(item.type)), false);
});

test('first project publication respects new-task mode and never routes its first input to Router', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'ordinary', language: 'en', messages: [] } });
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', hostId: 'host-new', revision: 1, viewGeneration: 0,
    viewTaskId: null, viewMode: 'new', cards: [], messages: [] });
  assert.match(view.element('projectInputTarget').textContent, /New task/);
  type(view, 'First independent task'); submit(view);
  assert.equal(view.posted.filter(item => item.type === 'projectTaskCreate').length, 1);
  assert.equal(view.posted.some(item => item.type === 'projectAssistantSubmit'), false);
});

test('a replacement Host waits for IME settlement and invalidates an old-Host deferred task destination', () => {
  const view = projectView();
  const cards = [sidebarCard('A', 'running'), sidebarCard('B', 'waiting')];
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', hostId: 'old-host', revision: 2,
    viewGeneration: 1, viewTaskId: 'A', viewMode: 'task', cards, messages: [] });
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(view, '旧目标最终中文');
  cardButton(view, 'B').click();
  const before = view.posted.filter(item => item.type === 'projectTaskView').length;
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', hostId: 'replacement-host', revision: 1,
    viewGeneration: 0, viewTaskId: null, viewMode: 'project', cards, messages: [] });
  assert.match(view.element('projectInputTarget').textContent, /Task A/);
  assert.equal(view.element('promptInput').textContent, '旧目标最终中文');
  view.element('promptInput').dispatchEvent({ type: 'compositionend' }); view.advance(0);
  assert.match(view.element('projectInputTarget').textContent, /Project assistant/);
  assert.equal(view.posted.filter(item => item.type === 'projectTaskView').length, before);
  assert.ok(view.posted.some(item => item.type === 'projectTaskDraft' && item.targetId === 'A' && item.markup.includes('旧目标最终中文')));
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', hostId: 'old-host', revision: 100,
    viewGeneration: 99, viewTaskId: 'B', cards, messages: [{ id: 'retired-host-message', role: 'assistant', content: 'Stale' }] });
  assert.match(view.element('projectInputTarget').textContent, /Project assistant/);
  assert.equal(view.state.messages.some((item: { id: string }) => item.id === 'retired-host-message'), false);
});

test('legacy background metadata preserves transcript, composer and IME while updating task capabilities', () => {
  const view = projectView();
  const cards = [sidebarCard('A', 'running'), sidebarCard('B', 'waiting')];
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, viewMode: 'legacy', revision: 2,
    viewGeneration: 0, readOnly: false, cards });
  view.receive({ type: 'state', revision: 20, state: { activeSessionId: 'ordinary-history', messages: [
    { id: 'ordinary-answer', role: 'assistant', content: 'Ordinary history stays mounted' }
  ], interaction: { sessionId: 'ordinary-history', revision: 20, canEdit: true, canSubmit: true,
    canNavigate: true, canCancel: false, phase: 'idle' } } });
  type(view, '普通会话未发送中文'); view.element('promptInput').focus();
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' });
  const transcript = view.element('transcript').firstChild;
  const draftNode = view.element('promptInput').firstChild;
  const metrics = view.domMetrics();
  for (let update = 0; update < 10; update++) {
    view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, viewMode: 'legacy', revision: 3 + update,
      viewGeneration: 0, readOnly: false, cards: cards.map(card => ({ ...card, progress: 'Background step ' + update })) });
  }
  assert.equal(view.element('transcript').firstChild, transcript);
  assert.equal(view.element('promptInput').firstChild, draftNode);
  assert.equal(view.element('promptInput').textContent, '普通会话未发送中文');
  assert.equal(view.document.activeElement, view.element('promptInput'));
  assert.deepEqual(view.domMetrics(), metrics, 'legacy card-only updates do not recreate input menus or transcript elements');
  view.receive({ type: 'projectTasksState', projectId: 'P', enabled: false, revision: 13, viewGeneration: 0,
    readOnly: true, capabilities: { canSubmit: false, canCreateTarget: true }, cards });
  assert.equal(view.element('projectStopAll').disabled, true);
  assert.equal(view.element('promptInput').firstChild, draftNode, 'read-only capability refresh does not rewrite the composing draft');
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, revision: 14, viewGeneration: 0, cards });
  assert.equal(view.element('projectStopAll').disabled, true, 'partial metadata cannot clear read-only authority');
  view.element('promptInput').dispatchEvent({ type: 'compositionend' }); view.advance(0);
  assert.equal(view.element('transcript').firstChild, transcript, 'metadata was not deferred as a view replacement');
  assert.equal(view.element('promptInput').firstChild, draftNode);
  assert.equal(view.posted.some(item => ['projectTaskView', 'projectTaskSubmit', 'projectAssistantSubmit'].includes(item.type)), false);
});

test('legacy publications reject old revisions without rolling back task metadata or read-only state', () => {
  const view = projectView();
  view.receive({ type: 'projectTasksState', projectId: 'P', enabled: false, revision: 10, viewGeneration: 0,
    readOnly: true, capabilities: { canSubmit: false, canCreateTarget: true }, cards: [sidebarCard('A', 'running', { title: 'Newest task title' })] });
  const transcript = view.element('transcript').firstChild;
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, revision: 9, viewGeneration: 0,
    readOnly: false, cards: [sidebarCard('A', 'failed', { title: 'Stale title' })] });
  assert.match(cardButton(view, 'A').getAttribute('aria-label') || '', /Newest task title/);
  assert.equal(view.element('transcript').firstChild, transcript);
});

test('older ownership generations cannot restore execution capability through newer card metadata', () => {
  const view = projectView();
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 10, viewGeneration: 0,
    readOnly: true, reason: 'A live owner is active in another window',
    ownerState: { revision: 8, status: 'owned_elsewhere', generation: 'current', reasonCode: 'live_owner' },
    capabilities: { canSubmit: false, canCreateTarget: true } });
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 11, viewGeneration: 0,
    readOnly: false, reason: 'Outdated owner success',
    ownerState: { revision: 7, status: 'owned', generation: 'retired', reasonCode: 'owned' },
    capabilities: { canSubmit: true, canCreateTarget: true } });
  assert.equal(view.element('projectStopAll').disabled, true);
  assert.match(view.element('projectOwnerReason').textContent, /live owner/);
  assert.equal(view.element('projectOwnerNotice').classList.contains('hidden'), false);
  type(view, 'Kept local draft'); submit(view);
  assert.equal(view.posted.some(item => item.type === 'projectAssistantSubmit'), false);
  assert.equal(view.element('promptInput').textContent, 'Kept local draft');
});

test('a newer metadata revision cannot apply a stale legacy view generation over a local task selection', () => {
  const view = projectView();
  cardButton(view, 'A').click(); cardButton(view, 'B').click(); type(view, 'Task B current draft');
  const selection = view.posted.filter(item => item.type === 'projectTaskView').at(-1)!;
  const transcript = view.element('transcript').firstChild;
  const draftNode = view.element('promptInput').firstChild;
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, viewMode: 'legacy', revision: 100,
    viewGeneration: selection.viewGeneration - 1, readOnly: false,
    cards: [sidebarCard('A', 'running'), sidebarCard('B', 'waiting', { progress: 'Fresh task metadata' })] });
  assert.match(view.element('projectInputTarget').textContent, /Task B/);
  assert.equal(view.element('projectInputTarget').classList.contains('hidden'), false);
  assert.equal(view.element('currentSessionTitle').textContent, 'Task B');
  assert.equal(view.element('transcript').firstChild, transcript);
  assert.equal(view.element('promptInput').firstChild, draftNode);
  assert.equal(view.element('promptInput').textContent, 'Task B current draft');
  assert.match(cardButton(view, 'B').getAttribute('aria-label') || '', /Task B/);
  assert.equal(view.posted.filter(item => item.type === 'projectTaskView').length, 2);
});

test('Host view replacement after compositionend waits for the final input event and saves its original target', () => {
  const view = projectView(); cardButton(view, 'A').click();
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' }); type(view, '候选文字');
  view.element('promptInput').dispatchEvent({ type: 'compositionend' });
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', revision: 3, viewGeneration: 2,
    viewTaskId: 'B', viewMode: 'task', cards: [sidebarCard('A', 'running'), sidebarCard('B', 'waiting')],
    messages: [], draft: { targetId: 'B', revision: 1, markup: 'B existing draft' } });
  assert.match(view.element('projectInputTarget').textContent, /Task A/);
  type(view, '最后确认的中文'); view.advance(0);
  assert.match(view.element('projectInputTarget').textContent, /Task B/);
  assert.equal(view.element('promptInput').textContent, 'B existing draft');
  cardButton(view, 'A').click();
  assert.equal(view.element('promptInput').textContent, '最后确认的中文');
  assert.ok(view.posted.some(message => message.type === 'projectTaskDraft' && message.targetId === 'A'
    && message.markup.includes('最后确认的中文')));
  assert.equal(view.posted.some(message => ['sendPrompt', 'projectTaskSubmit', 'projectTaskCreate'].includes(message.type)), false);
});

test('native usage and existing role dialogs retain Escape ownership above the task sidebar', () => {
  const view = projectView(); openSidebar(view);
  view.element('contextProgress').click();
  const dialog = view.element('usageDetailsDialog'); assert.equal(dialog.open, true);
  const usageEscape = { type: 'keydown', key: 'Escape', target: dialog, immediatePropagationStopped: false };
  view.document.dispatchEvent(usageEscape);
  assert.equal(usageEscape.immediatePropagationStopped, false, 'sidebar capture leaves the native dialog key untouched');
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  dialog.dispatchEvent(usageEscape);
  assert.equal(dialog.open, false);

  const about = view.element('aboutDialogOverlay'); about.classList.remove('hidden');
  const aboutEscape = { type: 'keydown', key: 'Escape', target: about, immediatePropagationStopped: false };
  view.document.dispatchEvent(aboutEscape);
  assert.equal(aboutEscape.immediatePropagationStopped, false, 'legacy role=dialog does not need aria-modal to own Escape');
  about.dispatchEvent(aboutEscape);
  assert.equal(about.classList.contains('hidden'), true);
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), false);
  view.document.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.equal(view.element('projectTaskSidebar').classList.contains('hidden'), true);
});

test('tooltip ownership follows the latest hovered or focused task without leaving another task described by it', () => {
  const view = projectView();
  const a = cardButton(view, 'A'), b = cardButton(view, 'B');
  a.dispatchEvent({ type: 'focus' });
  assert.equal(a.getAttribute('aria-describedby'), 'projectTaskTooltip');
  b.dispatchEvent({ type: 'mouseenter' });
  assert.equal(a.getAttribute('aria-describedby'), null);
  assert.equal(b.getAttribute('aria-describedby'), 'projectTaskTooltip');
  assert.match(view.element('projectTaskTooltip').textContent, /Task B/);
  b.dispatchEvent({ type: 'mouseleave' }); view.advance(100);
  assert.equal(b.getAttribute('aria-describedby'), null);
  assert.equal(view.element('projectTaskTooltip').classList.contains('hidden'), true);
});

test('background state announcements batch attention transitions and remain silent for load and token progress', () => {
  const view = projectView();
  const announcement = view.element('projectTaskAnnouncements');
  view.advance(500); assert.equal(announcement.textContent, '', 'restoring existing tasks is silent');
  const cards = ['A', 'B', 'C', 'D'].map(id => sidebarCard(id, 'running'));
  sidebarPublish(view, cards, 2);
  for (let index = 0; index < 5; index++) sidebarPublish(view, cards.map(card => ({ ...card, progress: 'Token ' + index })), 3 + index);
  view.advance(500); assert.equal(announcement.textContent, '', 'ordinary progress never enters the live region');
  const finished = cards.map(card => ({ ...card, state: 'completed' }));
  sidebarPublish(view, finished, 9);
  assert.equal(announcement.textContent, '', 'a burst is coalesced before announcing');
  view.advance(500);
  assert.match(announcement.textContent, /Task A: Completed/);
  assert.match(announcement.textContent, /Task C: Completed/);
  assert.doesNotMatch(announcement.textContent, /Task D/);
  assert.match(announcement.textContent, /1 more task updates/);
  const text = announcement.textContent;
  sidebarPublish(view, finished.map(card => ({ ...card, progress: 'More metadata' })), 10);
  view.advance(500); assert.equal(announcement.textContent, text);
  assert.equal(view.posted.some(message => ['sendPrompt', 'projectTaskSubmit', 'projectAssistantSubmit', 'projectTaskCreate'].includes(message.type)), false);
});

test('ordinary draft survives rail browsing and ordinary history never becomes the project assistant hot view', () => {
  const view = projectView();
  const ordinary = () => {
    view.receive({ type: 'state', revision: 40, state: { activeSessionId: 'session-A', messages: [
      { id: 'ordinary-only-message', role: 'assistant', content: 'Only ordinary history' }
    ], interaction: { sessionId: 'session-A', revision: 40, canEdit: true, canSubmit: true, canNavigate: true, phase: 'idle' } } });
  };
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, revision: 2, viewGeneration: 1 });
  ordinary(); type(view, 'ordinary session draft');
  cardButton(view, 'A').click(); type(view, 'worker task draft');
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', enabled: false, revision: 3, viewGeneration: 3 });
  view.receive({ type: 'state', revision: 41, state: { activeSessionId: 'session-A', messages: [
    { id: 'ordinary-only-message', role: 'assistant', content: 'Only ordinary history' }
  ] } });
  assert.equal(view.element('promptInput').textContent, 'ordinary session draft', 'same session ID still has separate ordinary and task draft surfaces');
  rail(view).selectView(null, 'project');
  assert.equal(view.state.messages.some((message: { id: string }) => message.id === 'ordinary-only-message'), false);
  cardButton(view, 'A').click();
  assert.equal(view.element('promptInput').textContent, 'worker task draft');
});

test('accepted ACK during composition before its first input cannot clear the active IME text', () => {
  const view = projectView(); cardButton(view, 'A').click(); type(view, 'submitted text'); submit(view);
  const submission = view.posted.find(message => message.type === 'projectTaskSubmit')!;
  view.element('promptInput').dispatchEvent({ type: 'compositionstart' });
  view.receive({ type: 'projectTaskSubmissionResult', projectId: 'P', targetId: 'A',
    requestId: submission.requestId, status: 'accepted' });
  assert.equal(view.element('promptInput').textContent, 'submitted text', 'ACK is deferred while the composing revision is not yet observable');
  type(view, 'submitted text 新输入');
  view.element('promptInput').dispatchEvent({ type: 'compositionend' });
  type(view, 'submitted text 新输入确认'); view.advance(0);
  assert.equal(view.element('promptInput').textContent, 'submitted text 新输入确认');
  submit(view);
  assert.equal(view.posted.filter(message => message.type === 'projectTaskSubmit').length, 2, 'deferred ACK settled and released only its pending submission');
});

test('task mutation gesture includes its complete observed Host and execution identity', () => {
  const view = projectView();
  view.receive({ type: 'projectTasksState', capabilities: { canSubmit: true, canCreateTarget: true }, projectId: 'P', hostId: 'host-P', revision: 2, viewGeneration: 0,
    cards: [sidebarCard('A', 'running', { segmentId: 'segment-A', generation: 7 })], messages: [] });
  cardButton(view, 'A').click(); openSidebar(view);
  view.element('projectTaskDetail').querySelector('button')!.click();
  const stop = view.posted.find(message => message.type === 'projectTaskStop')!;
  assert.equal(stop.projectId, 'P'); assert.equal(stop.hostId, 'host-P');
  assert.equal(stop.taskCardId, 'A'); assert.equal(stop.sessionId, 'session-A');
  assert.equal(stop.rootTaskId, 'root-A'); assert.equal(stop.segmentId, 'segment-A'); assert.equal(stop.generation, 7);
});
