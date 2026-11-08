import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { createHistoryTruncationPlan } from '../src/sessions/historyTruncation';
import type { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import type { SharedProjectSources } from '../src/context/sharedProjectSources';
import type { SkillStore } from '../src/skills/skillStore';
import type { ChangeSetStore } from '../src/edits/changeSetStore';
import type { InteractionSnapshot } from '../src/provider/interactionState';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import type { AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';
import { createWebviewDomHarness } from './webviewDomHarness';

// Execution-recovery tests explicitly prepare after the finite history view.
// Selecting history alone is covered separately below and must remain passive.
async function openSessionForContinuation(host: NavigationHost, sessionId: string): Promise<void> {
  await host.handleMessage({ type: 'selectSession', sessionId });
  await host.handleMessage({ type: 'prepareHistorySession', sessionId,
    viewGeneration: host.observerViewGeneration, requestId: `prepare-${sessionId}-${host.observerViewGeneration}` });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface NavigationHost {
  handleMessage(message: WebviewMessage): Promise<void>;
  observerViewGeneration: number;
  initializeAfterWebviewReady(): Promise<void>;
  ensureSessionNavigationReady(): Promise<void>;
  refreshWorkspaceScope(): Promise<void>;
  refreshConfiguration(): void;
  refreshSkills(options?: { post?: boolean }): Promise<void>;
  refreshModelSourceState(): Promise<void>;
  scheduleRunContextRefresh(uris: readonly string[]): void;
  runContextRefreshPromise?: Promise<void>;
  recoverHistoryTruncation(session: ChatSession): Promise<void>;
  postState(options: { immediate?: boolean; forceFull?: boolean }): void;
  postLightweightState(): void;
  isStartingRun: boolean;
  isBusy: boolean;
  sessionReady: boolean;
  approvalDataReady: boolean;
  requestContextReady: boolean;
  sessionRecoveryReady: boolean;
  activeSessionEntryRevision: number;
  draftRunAutoContinueTimer?: ReturnType<typeof setTimeout>;
  scheduleDraftRunAutoContinuation(): void;
  sessionTitles: SessionTitleCoordinator;
  sharedProjectSources: SharedProjectSources;
  skillStore: SkillStore;
  currentRunContextsBySession: Map<string, unknown>;
  activeRunSettled?: Promise<void>;
  awaitRunContextRefresh(): Promise<boolean>;
  sendPromptImpl(prompt: string, sourceId: string, modelId: string, settings: unknown, options?: {
    userMessageId?: string; userTask?: NonNullable<ChatMessage['userTask']>; onSubmissionAccepted?: () => void;
  }): Promise<AgentResponse | undefined>;
  queueUsageLedgerFlush(session: ChatSession): void;
  recoverSubagentUsage(session: ChatSession): Promise<void>;
  usageLedgerFlushes: Map<string, Promise<void>>;
  usageDisplayReadiness: Map<string, 'loading' | 'ready' | 'incomplete'>;
  changeSets: Pick<ChangeSetStore, 'initialize' | 'loadSession' | 'addDraftEdits' | 'flush'>;
  views: Set<unknown>;
}

interface PostedState {
  activeSessionId?: string;
  isBusy?: boolean;
  interaction?: InteractionSnapshot;
  messages?: ChatMessage[];
  changeSets?: Array<{ id: string }>;
  skills?: { items: Array<{ name: string }> };
  usageMetrics?: { displayReadiness?: 'loading' | 'ready' | 'incomplete' };
  historyPreview?: { sessionId: string; generation: number; loading: boolean; error?: string; canContinue: boolean } | null;
}

interface HostPost {
  type: string;
  sessionId?: string;
  requestId?: string;
  revision?: number;
  status?: 'accepted' | 'rejected' | 'failed';
  reason?: string;
  state?: PostedState;
}

test('owner history selection is a finite passive view; only explicit preparation restores its execution authority', async t => {
  const { host, store, storage, first, second, posts, publish } = await fixture(t, { historyMessages: 120 });
  const view = createWebviewDomHarness();
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) { view.receive(message); return Promise.resolve(true); } } });
  let fullReads = 0, pageReads = 0, recoveryReads = 0, sourceReads = 0, skillReads = 0, requests = 0;
  const load = storage.loadSession.bind(storage), page = store.viewSessionPage.bind(store);
  const recovery = host.changeSets.loadSession!.bind(host.changeSets);
  const sources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  const skills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => { requests++; throw new Error('Passive history cannot call a model'); };
  storage.loadSession = async (...args) => { fullReads++; return load(...args); };
  store.viewSessionPage = async (...args) => { pageReads++; return page(...args); };
  host.changeSets.loadSession = async (...args) => { recoveryReads++; return recovery(...args); };
  host.sharedProjectSources.refresh = async (...args) => { sourceReads++; return sources(...args); };
  host.skillStore.resolveAndLoadSkills = async input => { skillReads++; return skills(input); };

  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  const preview = lastState(posts).historyPreview!;
  assert.equal(preview.sessionId, second.id);
  assert.equal(lastState(posts).messages?.length, 30);
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.equal(view.element('historyPrepareContinue').disabled, false);
  assert.equal(store.activeSessionId, first.id, 'view selection cannot retarget execution');
  assert.equal(pageReads, 1); assert.equal(fullReads, 0); assert.equal(recoveryReads, 0);
  assert.equal(sourceReads, 0); assert.equal(skillReads, 0); assert.equal(requests, 0);
  publish(); host.postLightweightState();
  assert.equal(lastState(posts).activeSessionId, second.id, 'old startup publications retain the selected finite view');
  await host.handleMessage(submission(second.id, 'passive-old-send'));
  assert.equal(posts.find(post => post.requestId === 'passive-old-send')?.status, 'rejected');
  assert.equal(store.activeSessionId, first.id);

  view.element('historyPrepareContinue').click();
  const prepare = view.posted.find(message => message.type === 'prepareHistorySession')!;
  assert.equal(prepare.sessionId, second.id); assert.equal(prepare.viewGeneration, preview.generation);
  assert.equal(prepare.taskCardId, undefined);
  await host.handleMessage(prepare as WebviewMessage);
  assert.equal(store.activeSessionId, second.id);
  assert.ok(fullReads > 0); assert.ok(recoveryReads > 0); assert.ok(sourceReads > 0); assert.ok(skillReads > 0);
  assert.equal(requests, 0, 'preparing history restores safety and context without executing a request');
  assert.equal(lastState(posts).historyPreview, null);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(posts.find(post => post.type === 'historyPreviewResult' && post.requestId === prepare.requestId)?.status, 'ready');
});

test('history preparation keeps generation ownership across a delayed owner check and cannot supersede a new blank target', async t => {
  const { host, store, second, posts } = await fixture(t);
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  const generation = host.observerViewGeneration;
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const internal = host as unknown as { ownerReadiness: Promise<void> };
  internal.ownerReadiness = (async () => { entered.resolve(); await release.promise; })();
  const preparation = host.handleMessage({ type: 'prepareHistorySession', sessionId: second.id, viewGeneration: generation, requestId: 'late-history-owner' });
  await entered.promise;
  await host.handleMessage({ type: 'newSession' });
  const freshId = store.activeSessionId;
  release.resolve(); await preparation;
  assert.notEqual(freshId, second.id);
  assert.equal(store.activeSessionId, freshId);
  assert.deepEqual(store.getActiveSession().messages, []);
  assert.equal(posts.find(post => post.requestId === 'late-history-owner')?.status, 'rejected');
});

test('navigation preparation never advertises a running task or a Stop action', async t => {
  const { host, second, publish, posts } = await fixture(t);
  const reading = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const refresh = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  host.sharedProjectSources.refresh = async (...args) => { reading.resolve(); await release.promise; return refresh(...args); };
  const navigation = openSessionForContinuation(host, second.id);
  await reading.promise;
  publish();
  const during = posts.at(-1)?.state as { isBusy?: boolean; interaction?: { phase: string; canCancel: boolean; canSubmit: boolean; canEdit: boolean; canNavigate: boolean } };
  // Capture before releasing the barrier, but always settle the operation even
  // when this regression is run against the old implementation.
  release.resolve();
  await navigation;
  assert.equal(during.isBusy, false, 'context I/O is not a main model task');
  assert.equal(during.interaction?.phase, 'preparing_context');
  assert.equal(during.interaction?.canCancel, false);
  assert.equal(during.interaction?.canSubmit, false);
  assert.equal(during.interaction?.canEdit, true);
  assert.equal(during.interaction?.canNavigate, true, 'context reads no longer own the safely committed navigation');
});

test('safe history selection allows another navigation while old context is pending without releasing the new recovery owner', async t => {
  const { host, store, first, second, posts, publish, errors } = await fixture(t);
  const oldContextEntered = deferred(); const releaseOldContext = deferred();
  const newRecoveryEntered = deferred(); const releaseNewRecovery = deferred();
  t.after(() => { releaseOldContext.resolve(); releaseNewRecovery.resolve(); });
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let pauseOld = true;
  host.skillStore.resolveAndLoadSkills = async input => {
    const result = await resolveSkills(input);
    if (input.session.id === second.id && pauseOld) {
      pauseOld = false; oldContextEntered.resolve(); await releaseOldContext.promise;
      throw new Error('obsolete history context failed');
    }
    return result;
  };
  const oldNavigation = openSessionForContinuation(host, second.id);
  await oldContextEntered.promise;
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  const load = host.changeSets.loadSession!.bind(host.changeSets);
  host.changeSets.loadSession = async sessionId => {
    if (sessionId === first.id) { newRecoveryEntered.resolve(); await releaseNewRecovery.promise; }
    await load(sessionId);
  };
  const newNavigation = openSessionForContinuation(host, first.id);
  await newRecoveryEntered.promise;
  publish();
  const owner = lastState(posts).interaction?.operationId;
  assert.ok(owner);
  const entryFloor = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  releaseOldContext.resolve(); await oldNavigation;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.operationId, owner, 'old finally cannot release a newer navigation owner');
  assert.equal(lastState(posts).interaction?.canNavigate, false, 'new target operation recovery still owns navigation');
  assert.equal(host.activeSessionEntryRevision, entryFloor, 'old completion cannot create a new entry revision');
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.equal(errors.length, 0);
  releaseNewRecovery.resolve(); await newNavigation;
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('A to B to A context preparation ignores the previous A generation failure and completion publication', async t => {
  const { host, store, first, second, posts, publish, errors } = await fixture(t);
  await openSessionForContinuation(host, second.id);
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let pauseFirstA = true;
  host.skillStore.resolveAndLoadSkills = async input => {
    const result = await resolveSkills(input);
    if (input.session.id === first.id && pauseFirstA) {
      pauseFirstA = false; entered.resolve(); await release.promise;
      throw new Error('previous A preparation failed');
    }
    return result;
  };
  const previousA = openSessionForContinuation(host, first.id);
  await entered.promise;
  await openSessionForContinuation(host, second.id);
  await openSessionForContinuation(host, first.id);
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  const entryFloor = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  release.resolve(); await previousA;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(host.activeSessionEntryRevision, entryFloor);
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.equal(errors.length, 0);
});

test('copyOtherWorkspaceSession releases navigation after safe selection while its context continues loading', async t => {
  const { host, store, storage, first, publish, posts, errors } = await fixture(t);
  const foreignScope = { key: 'workspace:copy-context', name: 'Copy Context', folderUris: [] };
  const sourceId = 'copy-source';
  await storage.saveWorkspace(foreignScope, {
    activeSessionId: sourceId,
    sessions: [{ ...first, id: sourceId, workspaceKey: foreignScope.key, workspaceName: foreignScope.name, workspaceFolders: [] }]
  });
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let pauseTarget = true;
  host.skillStore.resolveAndLoadSkills = async input => {
    const result = await resolveSkills(input);
    if (input.session.id !== first.id && pauseTarget) {
      pauseTarget = false; entered.resolve(); await release.promise;
    }
    return result;
  };
  const preparing = host.handleMessage({ type: 'copyOtherWorkspaceSession', workspaceKey: foreignScope.key, sessionId: sourceId });
  await entered.promise;
  publish();
  assert.notEqual(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  await openSessionForContinuation(host, first.id);
  const entryFloor = host.activeSessionEntryRevision;
  release.resolve(); await preparing;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(host.activeSessionEntryRevision, entryFloor);
  assert.equal(errors.length, 0);
});

test('a new ordinary session is ready without loading project context or Skills; its first send prepares them', async t => {
  const { host, store, first, posts, publish } = await fixture(t);
  const refresh = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let sourceReads = 0, skillReads = 0;
  host.sharedProjectSources.refresh = async (...args) => { sourceReads++; return refresh(...args); };
  host.skillStore.resolveAndLoadSkills = async input => { skillReads++; return resolveSkills(input); };
  const calls = acceptedRun(host, store);
  await host.handleMessage({ type: 'newSession' });
  const fresh = store.getActiveSession();
  publish();
  assert.notEqual(fresh.id, first.id);
  assert.deepEqual(fresh.messages, []);
  assert.equal(sourceReads, 0, 'New must not scan project sources before there is user input');
  assert.equal(skillReads, 0, 'New must not load Skills before there is user input');
  assert.equal(host.currentRunContextsBySession.has(fresh.id), false);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  await host.handleMessage(submission(fresh.id, 'fresh-first-input'));
  assert.ok(sourceReads > 0, 'the real first submission still loads its own project context');
  assert.ok(skillReads > 0, 'the real first submission still resolves its own Skills');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, fresh.id);
  assert.equal(posts.find(post => post.requestId === 'fresh-first-input')?.status, 'accepted');
});

test('unreadable project context does not block New; first send preserves its unaccepted draft', async t => {
  const { host, store, posts, errors, publish } = await fixture(t);
  host.sharedProjectSources.refresh = async () => { throw new Error('fresh context cannot be read'); };
  const calls = acceptedRun(host, store);
  await host.handleMessage({ type: 'newSession' });
  const fresh = store.getActiveSession();
  publish();
  assert.equal(errors.length, 0, 'opening an empty session does not read failing project sources');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  await host.handleMessage(submission(fresh.id, 'fresh-context-error'));
  assert.equal(calls.length, 0, 'context failure cannot silently dispatch an underprepared request');
  const feedback = posts.find(post => post.requestId === 'fresh-context-error');
  assert.ok(feedback);
  assert.ok(feedback.status === 'rejected' || feedback.status === 'failed');
  assert.match(feedback.reason ?? '', /fresh context cannot be read/u);
  assert.deepEqual(fresh.messages, [], 'no durable user acceptance means no ACK may clear the draft');
});

for (const action of ['skills', 'configuration', 'source-watcher'] as const) {
  test(`automatic ${action} refresh does not load context or take readiness from a fresh empty session`, async t => {
    const { host, store, posts, publish } = await fixture(t);
    await host.handleMessage({ type: 'newSession' });
    const freshId = store.activeSessionId;
    const refreshSources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
    const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
    const refreshModels = host.refreshModelSourceState.bind(host);
    const releaseModels = deferred();
    t.after(() => releaseModels.resolve());
    let sourceReads = 0, skillReads = 0;
    let modelWork: Promise<void> | undefined;
    host.sharedProjectSources.refresh = async (...args) => { sourceReads++; return refreshSources(...args); };
    host.skillStore.resolveAndLoadSkills = async input => { skillReads++; return resolveSkills(input); };
    host.refreshModelSourceState = () => modelWork = (async () => { await releaseModels.promise; await refreshModels(); })();
    try {
      if (action === 'skills') await host.refreshSkills();
      else if (action === 'configuration') host.refreshConfiguration();
      else host.scheduleRunContextRefresh(['file:///temporary-project/AGENTS.md', 'file:///temporary-project/.agents/skills/example/SKILL.md']);
      // A watcher is queued on the previous refresh promise. Observe its work
      // without making any model/source request complete to unlock the editor.
      await host.runContextRefreshPromise;
      await new Promise<void>(resolve => setImmediate(resolve));
      publish();
      assert.equal(store.activeSessionId, freshId);
      assert.equal(sourceReads, 0, 'automatic maintenance must defer project reads until a real submission');
      assert.equal(skillReads, 0, 'automatic maintenance must defer Skill resolution until a real submission');
      assert.equal(host.currentRunContextsBySession.has(freshId), false);
      assert.equal(lastState(posts).interaction?.phase, 'idle');
      assert.equal(lastState(posts).interaction?.canEdit, true);
      assert.equal(lastState(posts).interaction?.canSubmit, true);
      assert.equal(host.sharedProjectSources.dirty, true, 'the next real submission must still refresh changed sources');
    } finally {
      releaseModels.resolve();
      await modelWork;
    }
  });
}

test('automatic refreshes before initial loading completes cannot own the placeholder or block New', { timeout: 10_000 }, async t => {
  const { host, store, first, posts, releaseLoad, initialization, publish } = await fixture(t, { delayLoad: true });
  const releaseMaintenance = deferred();
  t.after(() => { releaseMaintenance.resolve(); releaseLoad.resolve(); });
  const refreshSources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  const refreshModels = host.refreshModelSourceState.bind(host);
  let sourceReads = 0;
  let modelWork: Promise<void> | undefined;
  host.sharedProjectSources.refresh = async (...args) => { sourceReads++; await releaseMaintenance.promise; return refreshSources(...args); };
  host.refreshModelSourceState = () => modelWork = (async () => { await releaseMaintenance.promise; await refreshModels(); })();
  const skillsRefresh = host.refreshSkills();
  let watcherRefresh: Promise<void> | undefined;
  try {
    host.refreshConfiguration();
    host.scheduleRunContextRefresh(['file:///temporary-project/AGENTS.md', 'file:///temporary-project/.agents/skills/example/SKILL.md']);
    watcherRefresh = host.runContextRefreshPromise;
    publish();
    assert.equal(host.sessionReady, false, 'the historical load is still deliberately paused');
    assert.equal(sourceReads, 0, 'automatic work must not read placeholder context before session authority exists');
    assert.equal(lastState(posts).interaction?.operationId, undefined, 'automatic maintenance cannot reserve a placeholder recovery owner');
    await host.handleMessage({ type: 'newSession' });
    publish();
    assert.notEqual(store.activeSessionId, first.id);
    assert.equal(store.messages.length, 0);
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'New is usable before old loading and model maintenance finish');
    assert.equal(sourceReads, 0);
  } finally {
    releaseMaintenance.resolve(); releaseLoad.resolve();
    await Promise.allSettled([initialization, skillsRefresh, watcherRefresh, modelWork]);
  }
});

test('explicit Skills catalog loading remains available in a fresh editor without preparing prompt bodies or blocking input', { timeout: 10_000 }, async t => {
  const { host, store, root, posts, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const sessionId = store.activeSessionId;
  const skillDirectory = join(root, '.agents', 'skills', 'menu-skill');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), '---\nname: menu-skill\ndescription: A catalog-only fixture\n---\nPrivate prompt body stays unloaded.\n');
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrusted = vscode.workspace.isTrusted;
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root), name: 'Skills Menu Fixture', index: 0 }], isTrusted: true });
  const metadataEntered = deferred(); const releaseMetadata = deferred();
  t.after(() => releaseMetadata.resolve());
  const refreshSources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  const refreshMetadata = host.skillStore.refresh.bind(host.skillStore);
  const loadBodies = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let sourceReads = 0, bodyLoads = 0;
  host.sharedProjectSources.refresh = async (...args) => { sourceReads++; return refreshSources(...args); };
  host.skillStore.refresh = async (...args) => { metadataEntered.resolve(); await releaseMetadata.promise; await refreshMetadata(...args); };
  host.skillStore.resolveAndLoadSkills = async input => { bodyLoads++; return loadBodies(input); };
  const request = host.handleMessage({ type: 'requestSkills' });
  try {
    await metadataEntered.promise;
    publish();
    assert.equal(store.activeSessionId, sessionId);
    assert.equal(sourceReads, 1, 'an explicit menu request still refreshes the actual catalog source');
    assert.equal(bodyLoads, 0);
    assert.equal(host.currentRunContextsBySession.has(sessionId), false);
    assert.equal(lastState(posts).interaction?.operationId, undefined);
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'metadata I/O cannot own the first-send editor');
  } finally {
    releaseMetadata.resolve();
    try { await request; }
    finally { Object.assign(vscode.workspace, { workspaceFolders: previousFolders, isTrusted: previousTrusted }); }
  }
  assert.equal(bodyLoads, 0, 'listing a Skill must not activate or load its prompt body');
  assert.ok(lastState(posts).skills?.items.some(skill => skill.name === 'menu-skill'), 'the menu receives real discovered metadata');
  assert.equal(host.currentRunContextsBySession.has(sessionId), false);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('a Skills catalog completion from the previous fresh session cannot publish into the next New target', { timeout: 10_000 }, async t => {
  const { host, store, root, posts, errors, publish } = await fixture(t);
  const oldScope = join(root, 'catalog-old'); const newScope = join(root, 'catalog-current');
  await Promise.all([oldScope, newScope].map(async scope => {
    const name = scope === oldScope ? 'old-only' : 'current-only';
    const directory = join(scope, '.agents', 'skills', name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Distinct catalog fixture\n---\nKeep the prompt body unloaded.\n`);
  }));
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrusted = vscode.workspace.isTrusted;
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: vscode.Uri.file(root), name: 'Catalog Race Fixture', index: 0 }], isTrusted: true });
  await host.handleMessage({ type: 'newSession' });
  store.getActiveSession().projectScopeUri = vscode.Uri.file(oldScope).toString();
  const previousSessionId = store.activeSessionId;
  const metadataEntered = deferred(); const releaseMetadata = deferred();
  t.after(() => releaseMetadata.resolve());
  const refreshMetadata = host.skillStore.refresh.bind(host.skillStore);
  host.skillStore.refresh = async (...args) => {
    if (args[0]?.scope?.cwd.path.endsWith('/catalog-old')) { metadataEntered.resolve(); await releaseMetadata.promise; }
    await refreshMetadata(...args);
  };
  const request = host.handleMessage({ type: 'requestSkills' });
  let nextSessionId = '';
  let postsAtSwitch = 0;
  let currentCatalog: ReturnType<SkillStore['getStateView']> | undefined;
  try {
    await metadataEntered.promise;
    await host.handleMessage({ type: 'newSession' });
    nextSessionId = store.activeSessionId;
    store.getActiveSession().projectScopeUri = vscode.Uri.file(newScope).toString();
    postsAtSwitch = posts.length;
    assert.notEqual(nextSessionId, previousSessionId);
    await host.handleMessage({ type: 'requestSkills' });
    currentCatalog = host.skillStore.getStateView(store.getActiveSession());
    assert.ok(currentCatalog.items.some(skill => skill.name === 'current-only'));
    assert.ok(!currentCatalog.items.some(skill => skill.name === 'old-only'));
    releaseMetadata.resolve(); await request;
    assert.deepEqual(host.skillStore.getStateView(store.getActiveSession()), currentCatalog,
      'late old-scope metadata must not replace the current scope, config or manifests in the shared Skill store');
  } finally {
    releaseMetadata.resolve();
    try { await request; }
    finally { Object.assign(vscode.workspace, { workspaceFolders: previousFolders, isTrusted: previousTrusted }); }
  }
  assert.ok(posts.slice(postsAtSwitch).every(post => post.state?.activeSessionId !== previousSessionId), 'late catalog work cannot restore or publish the old input target');
  assert.equal(store.activeSessionId, nextSessionId);
  assert.equal(errors.length, 0, 'a superseded catalog lookup is not a current-session preparation failure');
  publish();
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(host.currentRunContextsBySession.has(nextSessionId), false);
});

test('a Skills catalog read failure leaves the fresh editor ready and its input untouched', async t => {
  const { host, store, posts, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const sessionId = store.activeSessionId;
  host.sharedProjectSources.refresh = async () => { throw new Error('catalog metadata unavailable'); };
  await host.handleMessage({ type: 'requestSkills' });
  publish();
  assert.equal(store.activeSessionId, sessionId);
  assert.equal(store.messages.length, 0);
  assert.equal(host.currentRunContextsBySession.has(sessionId), false);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('a pending Skills menu cannot refresh metadata or dirty sources after the first send owns preparation', { timeout: 10_000 }, async t => {
  const { host, store, posts, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const sessionId = store.activeSessionId;
  const sourceEntered = deferred(); const releaseSource = deferred();
  const bodiesEntered = deferred(); const releaseBodies = deferred();
  t.after(() => { releaseSource.resolve(); releaseBodies.resolve(); });
  const refreshSources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  const refreshMetadata = host.skillStore.refresh.bind(host.skillStore);
  const loadBodies = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let catalogSource = true;
  let sourceReads = 0, metadataRefreshes = 0;
  host.sharedProjectSources.refresh = async (...args) => {
    sourceReads++;
    const snapshot = await refreshSources(...args);
    if (catalogSource) { catalogSource = false; sourceEntered.resolve(); await releaseSource.promise; }
    return snapshot;
  };
  host.skillStore.refresh = async (...args) => { metadataRefreshes++; await refreshMetadata(...args); };
  host.skillStore.resolveAndLoadSkills = async input => { bodiesEntered.resolve(); await releaseBodies.promise; return loadBodies(input); };
  const calls = acceptedRun(host, store);
  const catalogRequest = host.handleMessage({ type: 'requestSkills' });
  let taskRequest: Promise<void> | undefined;
  try {
    await sourceEntered.promise;
    taskRequest = host.handleMessage(submission(sessionId, 'first-send-during-skill-menu'));
    await bodiesEntered.promise;
    publish();
    const operationId = lastState(posts).interaction?.operationId;
    assert.ok(operationId);
    assert.equal(lastState(posts).interaction?.phase, 'preparing_task');
    assert.equal(lastState(posts).interaction?.canSubmit, false);
    assert.equal(host.sharedProjectSources.dirty, false);
    const readsAtTask = sourceReads, refreshesAtTask = metadataRefreshes;
    await host.handleMessage({ type: 'requestSkills' });
    assert.equal(sourceReads, readsAtTask, 'a repeated menu request cannot read sources while foreground preparation owns them');
    assert.equal(host.sharedProjectSources.dirty, false, 'a repeated menu request cannot invalidate the owned preparation snapshot');
    releaseSource.resolve(); await catalogRequest;
    publish();
    assert.equal(metadataRefreshes, refreshesAtTask, 'a menu started before Send cannot advance Skill refresh selection after task preparation starts');
    assert.equal(lastState(posts).interaction?.operationId, operationId);
    assert.equal(lastState(posts).interaction?.canSubmit, false);
  } finally {
    releaseSource.resolve(); releaseBodies.resolve();
    await Promise.all([catalogRequest, taskRequest]);
  }
  assert.equal(calls.length, 1);
  assert.equal(posts.find(post => post.requestId === 'first-send-during-skill-menu')?.status, 'accepted');
});

test('fresh-session file watching defers attached-file reads until the first send and ignores unattached files', async t => {
  const { host, store, posts, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const freshId = store.activeSessionId;
  const runtime = host as unknown as { fileContext: {
    getAll(): unknown[];
    refreshUris(uris: readonly string[]): Promise<void>;
  } };
  const selectedUri = 'file:///temporary-project/selected.txt';
  runtime.fileContext.getAll = () => [{ id: 'selected', uri: selectedUri, label: 'selected.txt',
    fsPath: '/temporary-project/selected.txt', languageId: 'plaintext', source: 'workspace', content: '', sizeBytes: 0 }];
  const reads: string[][] = [];
  runtime.fileContext.refreshUris = async uris => { reads.push([...uris]); };
  host.scheduleRunContextRefresh([selectedUri, 'file:///temporary-project/unattached.txt', 'file:///temporary-project/AGENTS.md']);
  await host.runContextRefreshPromise;
  publish();
  assert.deepEqual(reads, [], 'watcher notifications cannot start fresh-session file I/O');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  const calls = acceptedRun(host, store);
  await host.handleMessage(submission(freshId, 'fresh-deferred-file-refresh'));
  assert.deepEqual(reads, [[selectedUri]], 'the real request refreshes only its previously attached changed file');
  assert.equal(calls.length, 1);
  assert.equal(posts.find(post => post.requestId === 'fresh-deferred-file-refresh')?.status, 'accepted');
});

for (const initialEmpty of ['restored', 'created'] as const) {
  test(`${initialEmpty} empty startup session is ready while model and safety initialization are paused`, { timeout: 10_000 }, async t => {
    const { host, store, posts, publish } = await fixture(t, { skipStartup: true, initialEmpty });
    const safetyEntered = deferred(); const modelEntered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const initializeSafety = host.changeSets.initialize.bind(host.changeSets);
    const loadOperations = host.changeSets.loadSession.bind(host.changeSets);
    const refreshModels = host.refreshModelSourceState.bind(host);
    const refreshSources = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
    const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
    let sourceReads = 0, skillReads = 0, initializingSafety = false;
    const recoveredSessionIds: string[] = [];
    host.changeSets.initialize = async () => {
      safetyEntered.resolve(); await release.promise;
      initializingSafety = true;
      try { await initializeSafety(); } finally { initializingSafety = false; }
    };
    host.changeSets.loadSession = async sessionId => {
      if (!initializingSafety) recoveredSessionIds.push(sessionId);
      await loadOperations(sessionId);
    };
    host.refreshModelSourceState = async () => { modelEntered.resolve(); await release.promise; await refreshModels(); };
    host.sharedProjectSources.refresh = async (...args) => { sourceReads++; return refreshSources(...args); };
    host.skillStore.resolveAndLoadSkills = async input => { skillReads++; return resolveSkills(input); };
    const startup = host.initializeAfterWebviewReady();
    const calls = acceptedRun(host, store);
    let request: Promise<void> | undefined;
    const emptyId = store.activeSessionId;
    try {
      await Promise.all([safetyEntered.promise, modelEntered.promise]);
      publish();
      assert.equal(store.messages.length, 0);
      assert.equal(sourceReads, 0, 'restoring an empty editor does not scan project instructions');
      assert.equal(skillReads, 0);
      assert.equal(host.approvalDataReady, false, 'interactive readiness does not fabricate finished safety recovery');
      assert.equal(host.requestContextReady, false);
      assert.equal(lastState(posts).interaction?.phase, 'idle');
      assert.equal(lastState(posts).interaction?.canEdit, true);
      assert.equal(lastState(posts).interaction?.canSubmit, true);
      request = host.handleMessage(submission(emptyId, `empty-${initialEmpty}-first-send`));
      publish();
      assert.equal(lastState(posts).interaction?.phase, 'preparing_task');
      assert.equal(calls.length, 0, 'a real first request still waits for its required safety and model preparation');
    } finally {
      release.resolve();
      await Promise.all([startup, request]);
    }
    assert.equal(store.activeSessionId, emptyId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, emptyId);
    assert.equal(posts.find(post => post.requestId === `empty-${initialEmpty}-first-send`)?.status, 'accepted');
    assert.ok(recoveredSessionIds.includes(emptyId), 'a restored or automatically created empty session still loads its own operation records before its first request');
    assert.ok(recoveredSessionIds.every(sessionId => sessionId === emptyId), 'empty-session preparation must retain its exact recovery identity');
    assert.ok(sourceReads > 0 && skillReads > 0, 'the accepted first input has its own prepared project and Skill context');
  });
}

test('history validation without a truncation journal never reserves a foreground recovery operation', async t => {
  const { host, store, posts, publish } = await fixture(t);
  const release = deferred();
  t.after(() => release.resolve());
  const flush = host.changeSets.flush.bind(host.changeSets);
  host.changeSets.flush = async () => { await release.promise; await flush(); };
  const recovery = host.recoverHistoryTruncation(store.getActiveSession());
  try {
    publish();
    assert.equal(lastState(posts).interaction?.operationId, undefined, 'read-only operation validation must not take the foreground editor owner');
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true);
  } finally { release.resolve(); await recovery; }
});

test('a durable pending history truncation still blocks submission until its recovery commits', async t => {
  const { host, store, posts, publish } = await fixture(t);
  const session = store.getActiveSession();
  const replacement: ChatMessage = { id: 'recovered-input', role: 'user', content: 'Revised durable input', createdAt: new Date(0).toISOString(),
    userTask: { version: 1, id: 'recovered-input', originMessageId: 'recovered-input', reason: 'user' } };
  session.pendingHistoryTruncation = createHistoryTruncationPlan(session, session.messages[0].id, replacement);
  assert.ok(session.pendingHistoryTruncation);
  await store.persist();
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const persist = store.persist.bind(store);
  store.persist = async (...args) => { entered.resolve(); await release.promise; await persist(...args); };
  const recovery = host.recoverHistoryTruncation(session);
  try {
    await entered.promise;
    publish();
    assert.ok(lastState(posts).interaction?.operationId);
    assert.equal(lastState(posts).interaction?.canSubmit, false, 'a real durable mutation remains a required foreground barrier');
    assert.notEqual(lastState(posts).interaction?.phase, 'idle');
  } finally { release.resolve(); await recovery; }
  assert.equal(session.pendingHistoryTruncation, undefined);
  assert.deepEqual(session.messages, [replacement]);
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('cold startup context for the previous session cannot hold or overwrite a ready history target', async t => {
  const { host, store, first, second, publish, posts } = await fixture(t, { skipStartup: true });
  const started = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const refresh = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  let initial = true;
  host.sharedProjectSources.refresh = async (...args) => {
    const result = await refresh(...args);
    if (args[0] === first.id && initial) {
      initial = false; started.resolve(); await release.promise;
    }
    return result;
  };
  const startup = host.initializeAfterWebviewReady();
  await started.promise;
  await host.ensureSessionNavigationReady();
  assert.equal(host.requestContextReady, false, 'old startup context is still required for the old session');
  await openSessionForContinuation(host, second.id);
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true, 'target is ready before the unrelated old promise ends');
  assert.equal(host.sessionRecoveryReady, true);
  release.resolve(); await startup;
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true, 'old failure/finally cannot take readiness away');
  assert.equal(host.sharedProjectSources.sessionId, second.id, 'old continuation does not reselect the source facade');
  assert.ok(host.currentRunContextsBySession.has(second.id));
  t.diagnostic(JSON.stringify({ boundary: 'cold-start-history', oldContextPaused: true, targetCanSubmitBeforeRelease: true,
    oldCompletionIgnored: true, sourceReads: host.sharedProjectSources.diagnostics }));
});

test('new session is ready while startup safety recovery is pending; sending still waits for safety', { timeout: 10_000 }, async t => {
  const { host, store, first, posts, publish } = await fixture(t, { skipStartup: true });
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const initialize = host.changeSets.initialize.bind(host.changeSets);
  host.changeSets.initialize = async () => { entered.resolve(); await release.promise; await initialize(); };
  const startup = host.initializeAfterWebviewReady();
  await entered.promise;
  const calls = acceptedRun(host, store);
  let request: Promise<void> | undefined;
  let freshId = '';
  try {
    await host.handleMessage({ type: 'newSession' });
    freshId = store.activeSessionId;
    publish();
    assert.notEqual(freshId, first.id);
    assert.equal(host.approvalDataReady, false, 'display readiness must not pretend global safety recovery finished');
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    request = host.handleMessage(submission(freshId, 'fresh-pending-safety'));
    publish();
    assert.equal(lastState(posts).interaction?.phase, 'preparing_task', 'an explicit send owns a task preparation rather than a session-loading spinner');
    assert.equal(lastState(posts).interaction?.canSubmit, false, 'duplicate sends remain closed while necessary preparation is pending');
    assert.equal(calls.length, 0, 'no model dispatch may cross unfinished safety recovery');
  } finally {
    release.resolve();
    await Promise.all([startup, request]);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, freshId);
  assert.equal(posts.find(post => post.requestId === 'fresh-pending-safety')?.status, 'accepted');
  assert.equal(store.activeSessionId, freshId);
});

test('new session first send does not wait for the previous startup session context', { timeout: 10_000 }, async t => {
  const { host, store, first, posts, publish } = await fixture(t, { skipStartup: true });
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let freshSkillReads = 0;
  host.skillStore.resolveAndLoadSkills = async input => {
    if (input.session.id === first.id) { entered.resolve(); await release.promise; }
    else freshSkillReads++;
    return resolveSkills(input);
  };
  const startup = host.initializeAfterWebviewReady();
  await entered.promise;
  const calls = acceptedRun(host, store);
  let request: Promise<void> | undefined;
  let freshId = '';
  try {
    await host.handleMessage({ type: 'newSession' });
    freshId = store.activeSessionId;
    publish();
    assert.equal(freshSkillReads, 0, 'opening empty input does not load a new session context');
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    request = host.handleMessage(submission(freshId, 'fresh-with-old-context-paused'));
    await request;
    assert.equal(calls.length, 1, 'the first send uses its own context without waiting for an obsolete old target');
    assert.equal(calls[0].sessionId, freshId);
    assert.ok(freshSkillReads > 0);
    assert.equal(posts.find(post => post.requestId === 'fresh-with-old-context-paused')?.status, 'accepted');
  } finally {
    release.resolve();
    await Promise.all([startup, request]);
  }
  publish();
  assert.equal(store.activeSessionId, freshId);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.ok(host.currentRunContextsBySession.has(freshId));
});

for (const action of ['refresh', 'retry'] as const) {
  test(`same-session ${action} owns readiness when the old startup Skill load fails late`, async t => {
    const { host, store, first, publish, posts } = await fixture(t, { skipStartup: true });
    const started = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
    let initial = true;
    host.skillStore.resolveAndLoadSkills = async input => {
      if (initial) {
        initial = false; started.resolve(); await release.promise;
        throw new Error('old Skill source was superseded');
      }
      return resolveSkills(input);
    };
    const startup = host.initializeAfterWebviewReady();
    await started.promise;
    await host.ensureSessionNavigationReady();
    host.sharedProjectSources.dirty = true;
    if (action === 'refresh') await host.refreshSkills();
    else await host.handleMessage({ type: 'retryInteraction' });
    publish();
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'new preparation completed while old Skill work is paused');
    release.resolve(); await startup;
    publish();
    assert.equal(store.activeSessionId, first.id, 'the race stays within one session');
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'late startup failure cannot replace the new ready state');
    assert.notEqual(lastState(posts).interaction?.phase, 'failed');
  });
}

test('target operation recovery failure is retried before submission becomes available', async t => {
  const { host, second, publish, posts } = await fixture(t);
  const originalLoad = host.changeSets.loadSession!.bind(host.changeSets);
  let attempts = 0;
  host.changeSets.loadSession = async sessionId => {
    if (sessionId === second.id && ++attempts === 1) throw new Error('target recovery read failed');
    await originalLoad(sessionId);
  };
  await openSessionForContinuation(host, second.id);
  publish();
  assert.equal(host.sessionRecoveryReady, false);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  await host.handleMessage({ type: 'retryInteraction' });
  publish();
  assert.equal(attempts, 2, 'retry reloads the necessary target records');
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('deleting the active history row restores the replacement session recovery readiness', async t => {
  const { host, store, first, publish, posts } = await fixture(t);
  const previousWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (_message, ...items) => items.find(item => typeof item === 'string') as never;
  t.after(() => { vscode.window.showWarningMessage = previousWarning; });
  await host.handleMessage({ type: 'deleteSessions', sessionIds: [first.id] });
  publish();
  assert.notEqual(store.activeSessionId, first.id);
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('workspace scope change restores target operations before opening task submission', async t => {
  const { host, store, publish, posts } = await fixture(t);
  const initial = store.activeSessionId;
  await host.refreshWorkspaceScope();
  publish();
  assert.notEqual(store.activeSessionId, initial, 'isolated fixture scope differs from the configured workspace scope');
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

function messages(taskId: string): ChatMessage[] {
  const userTask = { version: 1 as const, id: taskId, originMessageId: `${taskId}-user`, reason: 'user' as const };
  return [
    { id: `${taskId}-user`, role: 'user', content: '分析 KeepSeek 会话切换', createdAt: new Date().toISOString(), userTask },
    { id: `${taskId}-answer`, role: 'assistant', content: '检查会话存储与状态发布。', createdAt: new Date().toISOString(), userTask }
  ];
}

async function fixture(t: TestContext, options: {
  delayLoad?: boolean; loadFailure?: boolean; skipStartup?: boolean; initialEmpty?: 'restored' | 'created'; historyMessages?: number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-session-navigation-'));
  const uri = vscode.Uri.file(root);
  const scope = { key: 'workspace:navigation', name: 'Navigation', folderUris: [] };
  const storage = new GlobalSessionStorage(uri as never);
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
  const first = seed.getActiveSession();
  let second = first;
  if (options.initialEmpty !== 'created') {
    first.messages = messages('task-first');
    await seed.persist();
    second = await seed.createNewSession();
    second.messages = options.historyMessages ? Array.from({ length: options.historyMessages }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' as const : 'user' as const, content: `History ${i}`, createdAt: new Date(i * 1000).toISOString() })) : messages('task-second');
    await seed.persist();
    await seed.selectSession(first.id);
    if (options.initialEmpty === 'restored') {
      seed.getActiveSession().messages = [];
      await seed.persist();
    }
  }

  const loadStarted = deferred();
  const releaseLoad = deferred();
  const originalLoad = storage.loadWorkspace.bind(storage);
  if (options.delayLoad) storage.loadWorkspace = async input => {
    const snapshot = await originalLoad(input);
    loadStarted.resolve();
    await releaseLoad.promise;
    if (options.loadFailure) throw new Error('injected session load failure');
    return snapshot;
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  const initialization = store.initialize();
  void initialization.catch(() => undefined);
  if (!options.delayLoad) await initialization;
  else await loadStarted.promise;

  const previousWindow = { ...vscode.window };
  const previousStatusBarFactory = (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const errors: string[] = [];
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showErrorMessage: async (error: string) => { errors.push(error); }
  });
  const provider = new KeepseekChatViewProvider(uri as never, store, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization);
  const host = provider as unknown as NavigationHost;
  const posts: HostPost[] = [];
  host.views.add({ webview: { postMessage(message: typeof posts[number]) { posts.push(message); return Promise.resolve(true); } } });
  t.after(async () => {
    releaseLoad.resolve();
    await initialization.catch(() => undefined);
    await provider.shutdown();
    await storage.cleanupExpiredSessions({ currentWorkspaceKey: scope.key, currentActiveSessionId: store.activeSessionId });
    await storage.flush();
    Object.assign(vscode.window, previousWindow);
    if (previousStatusBarFactory === undefined) delete (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscode, { StatusBarAlignment: previousAlignment });
    await rm(root, { recursive: true, force: true });
  });
  if (!options.delayLoad && !options.skipStartup) await host.initializeAfterWebviewReady();
  const publish = () => host.postState({ immediate: true, forceFull: true });
  return { host, store, storage, scope, root, first, second, posts, errors, releaseLoad, initialization, publish };
}

/** The real Host admission, ownership and final persistence remain in use. */
function acceptedRun(host: NavigationHost, store: ChatSessionStore) {
  const calls: Array<{ prompt: string; sessionId: string; rootTaskId: string }> = [];
  host.sendPromptImpl = async (prompt, _source, _model, _settings, options) => {
    assert.ok(options?.userMessageId && options.userTask);
    const session = store.getActiveSession();
    calls.push({ prompt, sessionId: session.id, rootTaskId: options.userTask.id });
    session.messages.push({ id: options.userMessageId, role: 'user', content: prompt,
      createdAt: new Date(0).toISOString(), userTask: options.userTask });
    options.onSubmissionAccepted?.();
    return { message: 'controlled response', draftEdits: [] } as unknown as AgentResponse;
  };
  return calls;
}

function submission(sessionId: string, requestId: string, messageId?: string): Extract<WebviewMessage, { type: 'sendPrompt' | 'editUserPrompt' }> {
  const shared = { sessionId, requestId, prompt: `Question ${requestId}`, sourceId: 'test-source', modelId: 'test-model' };
  return messageId ? { type: 'editUserPrompt', messageId, ...shared } : { type: 'sendPrompt', ...shared };
}

function lastState(posts: readonly HostPost[]): PostedState {
  const state = [...posts].reverse().find(post => Boolean(post.state))?.state;
  assert.ok(state);
  return state;
}

for (const kind of ['sendPrompt', 'editUserPrompt'] as const) {
  test(`${kind} reserves before its first context await; duplicates and navigation cannot cross it`, async t => {
    const { host, store, first, second, posts, publish } = await fixture(t);
    const entered = deferred();
    const release = deferred<boolean>();
    t.after(() => release.resolve(true));
    host.awaitRunContextRefresh = async () => { entered.resolve(); return release.promise; };
    const calls = acceptedRun(host, store);
    const request = submission(first.id, 'original', kind === 'editUserPrompt' ? first.messages[0].id : undefined);
    const running = host.handleMessage(request);
    await entered.promise;
    try {
      await host.handleMessage(request); // Same transport request is still pending.
      await host.handleMessage(submission(first.id, 'conflicting-send'));
      await host.handleMessage(submission(first.id, 'conflicting-edit', first.messages[0].id));
      await openSessionForContinuation(host, second.id);
      await host.handleMessage({ type: 'newSession' });
      publish();
      const pending = lastState(posts);
      assert.equal(pending.interaction?.phase, 'preparing_task');
      assert.equal(pending.interaction?.canSubmit, false);
      assert.equal(pending.interaction?.canNavigate, false);
      assert.equal(pending.interaction?.canEdit, true);
      assert.equal(store.activeSessionId, first.id);
      assert.equal(calls.length, 0, 'nothing dispatches before the required context barrier');
      assert.deepEqual(posts.filter(post => post.type === 'submissionResult').map(post => [post.requestId, post.status]),
        [['conflicting-send', 'rejected'], ['conflicting-edit', 'rejected']]);
    } finally { release.resolve(true); await running; }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, first.id);
    assert.equal(posts.filter(post => post.type === 'submissionResult' && post.requestId === 'original' && post.status === 'accepted').length, 1);
    await host.handleMessage(request);
    assert.equal(calls.length, 1, 'replaying accepted transport feedback never reruns the task');
    publish();
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    t.diagnostic(JSON.stringify({ boundary: 'first-context-await', request: kind, acceptedTasks: calls.length,
      pendingPhase: 'preparing_task', navigationCommitted: false, finalPhase: lastState(posts).interaction?.phase }));
  });
}

test('request feedback closes wrong-session, unready and failed admission without consuming another request', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  await host.handleMessage(submission(second.id, 'wrong-session'));
  host.requestContextReady = false;
  await host.handleMessage(submission(first.id, 'not-ready'));
  host.requestContextReady = true;
  await host.handleMessage(submission(first.id, 'not-ready')); // Repeated old rejection is idempotent.
  assert.equal(calls.length, 0);
  const original = host.sendPromptImpl;
  host.sendPromptImpl = async () => { throw new Error('injected preparation failure'); };
  await host.handleMessage(submission(first.id, 'failed-preparation'));
  host.sendPromptImpl = original;
  await host.handleMessage(submission(first.id, 'valid-next-request'));
  assert.deepEqual(posts.filter(post => post.type === 'submissionResult').map(post => [post.sessionId, post.requestId, post.status]), [
    [second.id, 'wrong-session', 'rejected'], [first.id, 'not-ready', 'rejected'], [first.id, 'not-ready', 'rejected'],
    [first.id, 'failed-preparation', 'failed'], [first.id, 'valid-next-request', 'accepted']
  ]);
  assert.match(posts.find(post => post.requestId === 'failed-preparation')?.reason ?? '', /injected preparation failure/u);
  assert.equal(calls.length, 1);
  assert.equal(store.activeSessionId, first.id);
  publish();
  assert.equal(lastState(posts).interaction?.phase, 'idle');
});

test('a preparation cancel must match its owner and cannot release still-pending context I/O', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const entered = deferred();
  const release = deferred<boolean>();
  t.after(() => release.resolve(true));
  host.awaitRunContextRefresh = async () => { entered.resolve(); return release.promise; };
  const calls = acceptedRun(host, store);
  const before = store.getActiveSession().messages.length;
  const pending = host.handleMessage(submission(first.id, 'cancel-preparation'));
  await entered.promise;
  try {
    publish();
    const owner = lastState(posts).interaction?.cancelOperationId;
    assert.ok(owner);
    await host.handleMessage({ type: 'abortPrompt', sessionId: first.id, operationId: 'old-operation' });
    publish();
    assert.equal(lastState(posts).interaction?.canCancel, true, 'a stale Stop cannot cancel the current owner');
    await host.handleMessage({ type: 'abortPrompt', sessionId: first.id, operationId: owner });
    publish();
    const stopping = lastState(posts);
    assert.equal(stopping.interaction?.canCancel, false);
    assert.equal(stopping.interaction?.canSubmit, false, 'an abort signal cannot prove the pending read has settled');
    await openSessionForContinuation(host, second.id);
    assert.equal(store.activeSessionId, first.id);
  } finally { release.resolve(true); await pending; }
  assert.equal(calls.length, 0);
  assert.equal(store.getActiveSession().messages.length, before);
  assert.equal(posts.find(post => post.requestId === 'cancel-preparation')?.status, 'rejected');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
});

test('rapid history navigation drops concurrent targets and persists the same final selection it displays', async t => {
  const { host, store, storage, scope, first, second, posts } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const save = storage.saveSessionChanges.bind(storage);
  storage.saveSessionChanges = async (...args) => { entered.resolve(); await release.promise; return save(...args); };
  const navigating = openSessionForContinuation(host, second.id);
  await entered.promise;
  try {
    await openSessionForContinuation(host, first.id);
    await openSessionForContinuation(host, second.id);
    await host.handleMessage({ type: 'newSession' });
    assert.equal(store.activeSessionId, second.id, 'selection persistence retains navigation ownership');
  } finally { release.resolve(); await navigating; }
  await openSessionForContinuation(host, first.id);
  await openSessionForContinuation(host, second.id);
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).activeSessionId, second.id);
  const durable = await storage.loadWorkspace(scope);
  assert.equal(durable?.activeSessionId, second.id);
  assert.equal(durable.sessionSummaries?.length, 2, 'ignored concurrent New never created a hidden third session');
});

test('final durability keeps admission and settlement pending with Saving, then releases in the same state update', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  const saving = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const persist = store.persist.bind(store);
  store.persist = async (...args) => { saving.resolve(); await release.promise; await persist(...args); };
  const running = host.handleMessage(submission(first.id, 'slow-final-save'));
  await saving.promise;
  const settled = host.activeRunSettled;
  assert.ok(settled);
  let completed = false;
  void settled.then(() => { completed = true; });
  try {
    publish();
    const during = lastState(posts);
    assert.equal(during.isBusy, false);
    assert.equal(during.interaction?.phase, 'saving');
    assert.equal(during.interaction?.canCancel, false);
    assert.equal(during.interaction?.canSubmit, false);
    await host.handleMessage(submission(first.id, 'during-save'));
    await openSessionForContinuation(host, second.id);
    await Promise.resolve();
    assert.equal(completed, false, 'scope changes must still await necessary durability');
    assert.equal(store.activeSessionId, first.id);
    assert.equal(calls.length, 1);
  } finally { release.resolve(); await running; }
  assert.equal(completed, true);
  assert.equal(host.activeRunSettled, undefined);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(posts.find(post => post.requestId === 'during-save')?.status, 'rejected');
  t.diagnostic(JSON.stringify({ boundary: 'final-durability', modelFinished: true, phaseUntilWrite: 'saving',
    cancelAvailable: false, settledBeforeWrite: false, terminalPhase: lastState(posts).interaction?.phase }));
});

test('failed final durability preserves accepted content and retry saves it without rerunning the model', async t => {
  const { host, store, storage, scope, first, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  const persist = store.persist.bind(store);
  let fail = true;
  store.persist = async (...args) => { if (fail) throw new Error('injected final write failure'); await persist(...args); };
  await host.handleMessage(submission(first.id, 'save-failure'));
  publish();
  const failed = lastState(posts);
  assert.equal(failed.interaction?.phase, 'failed');
  assert.equal(failed.interaction?.canSubmit, false);
  assert.equal(failed.interaction?.canCancel, false);
  assert.match(failed.interaction?.blockingReason ?? '', /injected final write failure/u);
  assert.ok(store.getActiveSession().messages.some(message => message.content === 'Question save-failure'));
  assert.equal(posts.find(post => post.requestId === 'save-failure')?.status, 'accepted');
  await host.handleMessage(submission(first.id, 'blocked-by-write'));
  assert.equal(calls.length, 1);
  fail = false;
  await host.handleMessage({ type: 'retryInteraction' });
  assert.equal(calls.length, 1, 'retry has no model or side-effect execution');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  const durable = await storage.loadWorkspace(scope);
  assert.ok(durable.sessions[0].messages.some(message => message.content === 'Question save-failure'),
    'retry really commits the retained accepted content to temporary session storage');
});

test('display ledger and child summaries can stay pending while critical operation recovery controls readiness', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const ledger = deferred();
  const summaries = deferred();
  const recovery = deferred();
  const recoveryStarted = deferred();
  t.after(() => { ledger.resolve(); summaries.resolve(); recovery.resolve(); });
  let ledgerReads = 0, summaryReads = 0;
  host.queueUsageLedgerFlush = session => { ledgerReads++; host.usageLedgerFlushes.set(session.id, ledger.promise); };
  host.recoverSubagentUsage = async () => { summaryReads++; await summaries.promise; };
  const loadOperations = host.changeSets.loadSession!.bind(host.changeSets);
  host.changeSets.loadSession = async sessionId => { recoveryStarted.resolve(); await recovery.promise; await loadOperations(sessionId); };
  const navigation = openSessionForContinuation(host, second.id);
  await recoveryStarted.promise;
  try {
    publish();
    const visible = lastState(posts);
    assert.equal(visible.activeSessionId, second.id);
    assert.ok(visible.messages?.some(message => message.id === 'task-second-user'), 'the correct body is safe to show before operation recovery');
    assert.equal(visible.interaction?.phase, 'preparing_context');
    assert.equal(visible.interaction?.canSubmit, false, 'operation consistency remains a required barrier');
    assert.equal(visible.usageMetrics?.displayReadiness, 'loading');
  } finally { recovery.resolve(); await navigation; }
  assert.equal(ledgerReads, 1);
  assert.equal(summaryReads, 1);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(lastState(posts).usageMetrics?.displayReadiness, 'loading', 'pending statistics are not invented as complete zeroes');
  await openSessionForContinuation(host, first.id);
  assert.equal(store.activeSessionId, first.id, 'the next session does not await old display work');
  ledger.resolve(); summaries.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).activeSessionId, first.id);
  assert.equal(host.usageDisplayReadiness.get(second.id), 'ready');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  t.diagnostic(JSON.stringify({ boundary: 'navigation-dependencies', criticalRecoveryBlocksSubmit: true,
    ledgerReads, summaryReads, displayPendingAtSubmitReady: true, lateDisplayChangedActiveSession: false }));
});

test('an older queued context refresh failure cannot replace a newer successful refresh', async t => {
  const { host, posts, publish } = await fixture(t);
  const runtime = host as unknown as {
    fileContext: { getAll(): unknown[]; refreshUris(uris: readonly string[]): Promise<void> };
    scheduleRunContextRefresh(uris: readonly string[]): void;
    runContextRefreshPromise?: Promise<void>;
    runContextRefreshError?: unknown;
  };
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const uri = 'file:///temporary-context.txt';
  runtime.fileContext.getAll = () => [{ id: 'context', uri, label: 'context', fsPath: '/temporary-context.txt',
    languageId: 'plaintext', source: 'workspace', content: '', sizeBytes: 0 }];
  let reads = 0;
  runtime.fileContext.refreshUris = async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; throw new Error('obsolete refresh failure'); }
  };
  runtime.scheduleRunContextRefresh([uri]);
  await entered.promise;
  runtime.scheduleRunContextRefresh([uri]);
  const latest = runtime.runContextRefreshPromise;
  release.resolve();
  await latest;
  await new Promise<void>(resolve => setImmediate(resolve));
  publish();
  assert.equal(reads, 2);
  assert.equal(runtime.runContextRefreshError, undefined);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('A to B to A rejects submissions from the previous entry revision without losing a newer draft', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  publish();
  const revision = lastState(posts).interaction!.revision;
  await openSessionForContinuation(host, second.id);
  await openSessionForContinuation(host, first.id);
  await host.handleMessage({ ...submission(first.id, 'old-entry'), stateRevision: revision });
  assert.equal(posts.find(post => post.requestId === 'old-entry')?.status, 'rejected');
  assert.equal(calls.length, 0);
  await host.handleMessage({ ...submission(first.id, 'current-entry'), stateRevision: lastState(posts).interaction!.revision });
  assert.equal(calls.length, 1);
  assert.equal(posts.find(post => post.requestId === 'current-entry')?.status, 'accepted');
});

test('failed startup safety recovery cannot be bypassed through navigation into a store flush', async t => {
  const { host, store, first, second, posts } = await fixture(t);
  host.approvalDataReady = false;
  const failedSafety = Promise.reject(new Error('Safety recovery failed. Reload the window to retry.'));
  void failedSafety.catch(() => undefined);
  Object.assign(host, { approvalStoresInitialization: failedSafety });
  let loads = 0;
  host.changeSets.loadSession = async () => { loads++; };
  await openSessionForContinuation(host, second.id);
  assert.equal(store.activeSessionId, first.id);
  assert.equal(loads, 0, 'a failed safety store must not be flushed from partial in-memory data');
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.match(lastState(posts).interaction?.blockingReason ?? '', /Safety recovery failed|操作记录恢复失败/u);
});

test('history selection waits for the initial persisted session load', async t => {
  const { host, store, storage, first, second, releaseLoad, initialization, publish, posts } = await fixture(t, { delayLoad: true });
  let writes = 0;
  const originalSave = storage.saveSessionChanges.bind(storage);
  storage.saveSessionChanges = async (...args) => { writes++; await originalSave(...args); };
  const navigation = openSessionForContinuation(host, second.id);
  const writesBeforeLoad = writes;
  releaseLoad.resolve();
  await Promise.all([initialization, navigation]);
  assert.equal(writesBeforeLoad, 0, 'navigation must not save an empty pre-load session over persisted history');
  assert.equal(store.activeSessionId, second.id, 'history selection must use the initialized summaries');
  publish();
  assert.equal(posts.at(-1)?.state?.activeSessionId, store.activeSessionId);
  assert.notEqual(store.activeSessionId, first.id);
});

for (const loadFailure of [false, true]) {
  test(`new session becomes ready before the old initial session load ${loadFailure ? 'fails' : 'finishes'}`, { timeout: 10_000 }, async t => {
    const { host, store, storage, scope, first, second, releaseLoad, initialization, posts, publish } = await fixture(t, { delayLoad: true, loadFailure });
    t.after(() => releaseLoad.resolve());
    const persistedFirst = await storage.loadSession(scope.key, first.id);
    const persistedSecond = await storage.loadSession(scope.key, second.id);
    assert.ok(persistedFirst && persistedSecond);
    await host.handleMessage({ type: 'newSession' });
    const fresh = store.getActiveSession();
    publish();
    assert.notEqual(fresh.id, first.id);
    assert.notEqual(fresh.id, second.id);
    assert.deepEqual(fresh.messages, []);
    assert.equal(lastState(posts).activeSessionId, fresh.id);
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'an unrelated old session is not a send-readiness dependency');
    assert.equal(host.isStartingRun, false);
    const calls = acceptedRun(host, store);
    await host.handleMessage(submission(fresh.id, 'fresh-during-old-load'));
    assert.equal(calls.length, 1, 'the first submission prepares only its fresh target while old history loading stays paused');
    assert.equal(calls[0].sessionId, fresh.id);
    assert.equal(posts.find(post => post.requestId === 'fresh-during-old-load')?.status, 'accepted');
    const acceptedMessage = store.messages.find(message => message.role === 'user');
    assert.ok(acceptedMessage);
    const pendingChange = host.changeSets.addDraftEdits({
      sessionId: fresh.id, runId: calls[0].rootTaskId, messageId: acceptedMessage.id,
      edits: [{ id: 'fresh-unapplied-edit', uri: vscode.Uri.file(join(scope.folderUris[0] ?? tmpdir(), 'fresh-never-applied.txt')).toString(),
        label: 'fresh-never-applied.txt', action: 'create', newText: 'pending fixture only', reason: 'Test a visible pending operation' }]
    });
    assert.ok(pendingChange);
    publish();
    assert.ok(lastState(posts).changeSets?.some(change => change.id === pendingChange.id));
    host.postLightweightState();
    assert.ok(lastState(posts).changeSets?.some(change => change.id === pendingChange.id), 'late startup publication cannot clear live pending change cards');
    const oldFirst = await storage.loadSession(scope.key, first.id);
    const oldSecond = await storage.loadSession(scope.key, second.id);
    assert.deepEqual(oldFirst?.messages, persistedFirst.messages, 'creating fresh must preserve old durable history');
    assert.deepEqual(oldSecond?.messages, persistedSecond.messages);
    releaseLoad.resolve();
    if (loadFailure) await assert.rejects(initialization, /injected session load failure/);
    else await initialization;
    await host.initializeAfterWebviewReady();
    publish();
    assert.equal(store.activeSessionId, fresh.id, 'late old initialization cannot restore its selection');
    assert.deepEqual(store.getActiveSession().messages, fresh.messages, 'late initialization must retain the accepted fresh history');
    assert.equal(store.getActiveSession().messages.filter(message => message.role === 'user').length, 1, 'late initialization cannot erase the accepted fresh input');
    assert.equal(lastState(posts).activeSessionId, fresh.id);
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    assert.ok(lastState(posts).changeSets?.some(change => change.id === pendingChange.id), 'old load completion retains the fresh target operation cards');
  });
}

test('repeated new-session clicks create one persisted session while navigation is pending', async t => {
  const { host, store, storage, first, second, publish, posts } = await fixture(t);
  const saveStarted = deferred();
  const releaseSave = deferred();
  t.after(() => releaseSave.resolve());
  const states: StoredWorkspaceSessionState[] = [];
  const originalSave = storage.saveSessionChanges.bind(storage);
  storage.saveSessionChanges = async (...args) => {
    states.push(args[1]);
    saveStarted.resolve();
    await releaseSave.promise;
    await originalSave(...args);
  };
  const firstClick = host.handleMessage({ type: 'newSession' });
  const secondClick = host.handleMessage({ type: 'newSession' });
  await saveStarted.promise;
  const lockedDuringSave = host.isStartingRun;
  releaseSave.resolve();
  await Promise.all([firstClick, secondClick]);
  assert.equal(lockedDuringSave, true, 'navigation owns the host lock before its first asynchronous barrier');
  assert.equal(new Set(states.map(state => state.activeSessionId)).size, 1);
  assert.notEqual(store.activeSessionId, first.id);
  assert.notEqual(store.activeSessionId, second.id);
  assert.equal(host.isStartingRun, false);
  assert.equal(host.currentRunContextsBySession.has(store.activeSessionId), false, 'creating an empty session does not prepare unused context');
  publish();
  assert.equal(posts.at(-1)?.state?.isBusy, false);
});

test('persisted selectSession is published and unlocked when its context refresh fails', async t => {
  const { host, store, first, second, posts, errors, publish } = await fixture(t);
  // Fault injection at the context-source dependency, without replacing Host
  // navigation, state construction, persistence, or approval/runtime services.
  host.sharedProjectSources.refresh = async () => { throw new Error('injected context read failure'); };
  await openSessionForContinuation(host, second.id);
  assert.notEqual(store.activeSessionId, first.id);
  assert.equal(host.isStartingRun, false);
  assert.equal(errors.length, 1);
  assert.ok(posts.some(post => post.type === 'sessionChanged'));
  publish();
  assert.equal(posts.at(-1)?.state?.activeSessionId, store.activeSessionId);
  assert.equal(posts.at(-1)?.state?.isBusy, false);
});

test('an in-flight automatic title does not block or get cancelled by session navigation', async t => {
  const { host, store, first, second, publish, posts } = await fixture(t);
  const requested = deferred();
  const response = deferred<string>();
  t.after(() => response.resolve('{"decision":"defer","title":null}'));
  let titleSignal: AbortSignal | undefined;
  const title = host.sessionTitles.complete(first.id, 'task-first', async input => {
    titleSignal = input.signal;
    requested.resolve();
    return response.promise;
  });
  await requested.promise;
  await host.handleMessage({ type: 'newSession' });
  await openSessionForContinuation(host, second.id);
  assert.equal(store.activeSessionId, second.id);
  assert.equal(titleSignal?.aborted, false);
  response.resolve('{"decision":"set","title":"会话切换排查"}');
  assert.equal(await title, true);
  assert.equal(store.getSessionById(first.id)?.title, '会话切换排查');
  assert.equal(store.activeSessionId, second.id);
  publish();
  assert.equal(posts.at(-1)?.state?.isBusy, false);
});

test('session navigation retains the main-run busy guard', async t => {
  const { host, store, first, second } = await fixture(t);
  host.isBusy = true;
  await host.handleMessage({ type: 'newSession' });
  await openSessionForContinuation(host, second.id);
  assert.equal(store.activeSessionId, first.id);
  host.isBusy = false;
});

test('early navigation state cannot schedule a continuation before recovery and request context are ready', async t => {
  const { host } = await fixture(t);
  clearTimeout(host.draftRunAutoContinueTimer);
  host.draftRunAutoContinueTimer = undefined;
  for (const [approvalReady, contextReady] of [[false, false], [false, true], [true, false]]) {
    host.approvalDataReady = approvalReady;
    host.requestContextReady = contextReady;
    host.scheduleDraftRunAutoContinuation();
    assert.equal(host.draftRunAutoContinueTimer, undefined);
  }
  host.approvalDataReady = true;
  host.requestContextReady = true;
  host.scheduleDraftRunAutoContinuation();
  assert.ok(host.draftRunAutoContinueTimer, 'the ready startup full state can schedule continuation normally');
});
