import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { PromptReferenceInput, WebviewMessage } from '../src/provider/webviewMessages';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { createRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { RunDetailsBuilder } from '../src/agent/logging/runDetails';
import { getAgentToolNamesForPrompt } from '../src/agent/protocol';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { ExactOperationGrants } from '../src/approvals/authorization';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { DraftRunBatchCoordinator } from '../src/runs/draftRunBatchCoordinator';
import { createDraftRunProposal } from '../src/runs/draftRunProposal';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { UserTaskClock } from '../src/sessions/executionTimeStats';
import { createHistoryTruncationPlan } from '../src/sessions/historyTruncation';
import type { DraftRunStoreEvent } from '../src/runs/draftRunStore';
import type { AgentRequest, AgentResponse, ChatMessage, CurrentRunContext } from '../src/shared/types';

type Host = {
  sendPrompt(prompt: string, sourceId: string, modelId: string, settings: unknown,
    options: { replaceMessageId: string; references?: PromptReferenceInput[] }): Promise<AgentResponse | undefined>;
  saveAgentCheckpoint(session: ReturnType<ChatSessionStore['getActiveSession']>, message: ChatMessage, checkpoint: RunCheckpoint): Promise<void>;
  queueResponseApprovals(session: ReturnType<ChatSessionStore['getActiveSession']>, message: ChatMessage, response: AgentResponse): void;
  handleMessage(message: WebviewMessage): Promise<void>;
  isBusy?: boolean;
  isStartingRun?: boolean;
  delegatedApprovalInFlight?: boolean;
  draftRunAutoContinueInFlight?: boolean;
  activeDraftRunId?: string;
  activeChangeActions: Set<string>;
  manualToolApproval?: { view: { id: string }; decide(approved: boolean): void };
  recoverHistoryTruncation(session: ReturnType<ChatSessionStore['getActiveSession']>): Promise<void>;
  handleDraftRunStoreEvent(event: DraftRunStoreEvent): void;
  flushDraftRunOutputEvent(): void;
  pendingDraftRunOutputEvent?: DraftRunStoreEvent;
  authorizeDraftRunWorkingDirectory(id: string): Promise<void>;
  authorizedExternalExecutionUris: Set<string>;
  authorizedExternalReferenceUris: Set<string>;
  collectAuthorizedExternalReferenceUris(references: undefined, inheritExisting?: boolean): Set<string>;
};

for (const mode of ['ask', 'delegate'] as const) {
  for (const index of [0, 1, 2]) {
    for (const changed of [false, true]) {
      test(`${mode} editing user ${index + 1} ${changed ? 'with changes' : 'unchanged'} truncates sources, preserves earlier records and starts a new task`, async () => {
        await fixture(mode, async f => {
          const target = f.users[index];
          const preserved = f.session.messages.slice(0, index * 2).map(stableHistoryMessage);
          const removedIds = new Set(f.session.messages.slice(index * 2).map(message => message.id));
          const prompt = changed ? `${target.content} revised` : target.content;
          await f.host.sendPrompt(prompt, 'source', 'model', {}, { replaceMessageId: target.id });
          assert.equal(f.requests.length, 1, JSON.stringify(f.session.messages));
          assert.equal(f.session.pendingHistoryTruncation, undefined);
          const replacement = f.session.messages[index * 2];
          assert.equal(replacement.role, 'user');
          assert.equal(replacement.content, prompt);
          assert.notEqual(replacement.id, target.id);
          assert.equal(replacement.userTask?.id, replacement.id);
          assert.equal(replacement.userTask?.reason, 'user');
          assert.equal(f.session.messages.length, index * 2 + 2);
          assert.deepEqual(f.session.messages.slice(0, index * 2).map(stableHistoryMessage), preserved);
          assert.ok(f.session.messages.every(message => !removedIds.has(message.id)));
          assert.equal(f.session.requestProtocol?.toolNames?.join(','), f.frozenToolNames.join(','));
          assert.equal(f.queue.take(f.session.id), undefined);
          assert.equal(f.session.pendingApproval, undefined);
          assert.equal(f.session.approvalProcessing, undefined);
          assert.ok(f.manualCancelled());
          const content = replacement.providerContent ?? replacement.content;
          for (let source = 0; source < 3; source++) {
            const pending = f.runs.get(f.pendingIds[source])!;
            const done = f.runs.get(f.doneIds[source])!;
            assert.equal(pending.status, 'pending', 'history membership does not forge a rejected command result');
            assert.equal(done.status, 'done', 'actual completed effects remain recorded');
            if (source < index) {
              assert.equal(pending.historyInvalidationId, undefined);
              assert.ok(f.runs.toWebviewState(f.session.id).some(run => run.id === pending.id));
              assert.ok(f.edits.toWebviewState(f.session.id).some(set => set.messageId === f.assistants[source].id));
              assert.ok(content.includes(done.id), 'a preserved origin with deleted delivery may bind once to the new user');
              assert.equal(done.resultBoundMessageId, replacement.id);
            } else {
              assert.ok(pending.historyInvalidationId);
              assert.ok(done.historyInvalidationId);
              assert.ok(!f.runs.toWebviewState(f.session.id).some(run => run.id === pending.id || run.id === done.id));
              assert.ok(!f.edits.toWebviewState(f.session.id).some(set => set.messageId === f.assistants[source].id));
              assert.ok(!content.includes(done.id), 'a deleted origin never returns through result tail');
            }
          }
          assert.equal(f.runs.getPendingProviderTail(f.session.id, 'en'), undefined, 'preserved results are delivered once');
          assert.equal(await readFile(f.effectFile, 'utf8'), 'already happened\n');
          assert.equal(f.session.usageStats?.requestCount, 7, 'spent usage survives editing');
          assert.equal(f.session.messages.filter(message => removedIds.has(message.id)).length, 0);
        });
      });
    }
  }
}

test('late checkpoint, old manual button and stale approval response cannot restore a truncated source', async () => {
  await fixture('delegate', async f => {
    const removed = f.assistants[2];
    const checkpoint = structuredClone(removed.runCheckpoint!);
    const lateProposal = await createDraftRunProposal({ executable: 'node', args: ['--version'], reason: 'Late proposal' });
    checkpoint.finalResponse = { ...f.response, draftEdits: [], draftRuns: [lateProposal] };
    checkpoint.status = 'completed';
    await f.host.sendPrompt('Instruction 3 revised', 'source', 'model', {}, { replaceMessageId: f.users[2].id });
    const before = JSON.stringify(f.session.messages);
    await f.host.saveAgentCheckpoint(f.session, removed, checkpoint);
    assert.equal(f.runs.get(lateProposal.id), undefined);
    f.host.queueResponseApprovals(f.session, removed, checkpoint.finalResponse);
    assert.equal(f.queue.take(f.session.id), undefined);
    await f.host.handleMessage({ type: 'resolveValidationApproval', id: 'old-manual', approve: true });
    assert.equal(JSON.stringify(f.session.messages), before);
    assert.equal(f.session.pendingApproval, undefined);
  });
});

test('empty prompt, invalid target and busy command, reviewer, Apply or continuation leave history and operations intact', async () => {
  await fixture('ask', async f => {
    const before = JSON.stringify(f.session.messages);
    const runsBefore = JSON.stringify(f.runs.toWebviewState(f.session.id));
    await f.host.sendPrompt('   ', 'source', 'model', {}, { replaceMessageId: f.users[1].id });
    await f.host.sendPrompt('new', 'source', 'model', {}, { replaceMessageId: 'missing' });
    for (const flag of ['isBusy', 'delegatedApprovalInFlight', 'draftRunAutoContinueInFlight'] as const) {
      f.host[flag] = true;
      await f.host.sendPrompt('new', 'source', 'model', {}, { replaceMessageId: f.users[1].id });
      f.host[flag] = false;
    }
    f.host.activeDraftRunId = 'running';
    await f.host.sendPrompt('new', 'source', 'model', {}, { replaceMessageId: f.users[1].id });
    f.host.activeDraftRunId = undefined;
    f.host.activeChangeActions.add('applying');
    await f.host.sendPrompt('new', 'source', 'model', {}, { replaceMessageId: f.users[1].id });
    f.host.activeChangeActions.clear();
    assert.equal(f.requests.length, 0);
    assert.equal(JSON.stringify(f.session.messages), before);
    assert.equal(JSON.stringify(f.runs.toWebviewState(f.session.id)), runsBefore);
    assert.equal(f.session.pendingHistoryTruncation, undefined);
  });
});

test('history recovery reserves the session through asynchronous persistence and prevents concurrent sends or switches', async () => {
  await fixture('ask', async f => {
    const replacement: ChatMessage = { id: 'recovered-user', role: 'user', content: 'Recovered edit', createdAt: '2026-01-01',
      userTask: { version: 1, id: 'recovered-user', originMessageId: 'recovered-user', reason: 'user' } };
    f.session.pendingHistoryTruncation = createHistoryTruncationPlan(f.session, f.users[1].id, replacement);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acknowledged = new Promise<void>(resolve => { entered = resolve; });
    const persist = f.sessions.persist.bind(f.sessions);
    const select = f.sessions.selectSession.bind(f.sessions);
    let first = true, switches = 0;
    f.sessions.persist = async (...args) => { if (first) { first = false; entered(); await gate; } await persist(...args); };
    f.sessions.selectSession = async (...args) => { switches++; return select(...args); };
    const recovering = f.host.recoverHistoryTruncation(f.session);
    try {
      await acknowledged;
      assert.equal(f.host.isStartingRun, true);
      await f.host.handleMessage({ type: 'selectSession', sessionId: 'other' });
      await f.host.sendPrompt('Another edit', 'source', 'model', {}, { replaceMessageId: f.users[0].id });
      assert.equal(switches, 0);
      assert.equal(f.requests.length, 0);
      assert.equal(f.session.messages.length, 6);
      assert.equal(f.runs.toWebviewState(f.session.id).length, 6, 'independent records wait for the write-ahead boundary');
    } finally { release(); await recovering; f.sessions.persist = persist; f.sessions.selectSession = select; }
    assert.equal(f.host.isStartingRun, undefined);
    assert.equal(f.session.pendingHistoryTruncation, undefined);
    assert.equal(f.session.messages.at(-1)?.id, replacement.id);
    assert.equal(f.requests.length, 0, 'recovery never runs a new request automatically');
  });
});

test('buffered and repeated DraftRun events cannot republish cards after the source is truncated', async () => {
  await fixture('ask', async f => {
    const run = f.runs.toWebviewState(f.session.id).find(item => item.id === f.doneIds[2])!;
    const event: DraftRunStoreEvent = { type: 'output', draftRun: run, delta: 'late output', stream: 'stdout' };
    f.host.pendingDraftRunOutputEvent = event;
    await f.host.sendPrompt('Instruction 3 revised', 'source', 'model', {}, { replaceMessageId: f.users[2].id });
    const before = f.webviewEvents.length;
    f.host.flushDraftRunOutputEvent();
    f.host.handleDraftRunStoreEvent({ ...event, type: 'state' });
    f.host.handleDraftRunStoreEvent(event);
    f.host.flushDraftRunOutputEvent();
    assert.equal(f.webviewEvents.length, before);
    assert.equal(f.host.pendingDraftRunOutputEvent, undefined);
  });
});

test('an external directory dialog opened before editing cannot grant authority to its superseded command', async () => {
  await fixture('ask', async f => {
    const external = path.join(f.root, 'external'); await mkdir(external);
    const proposal = await createDraftRunProposal({ executable: 'node', args: ['--version'], cwd: external, reason: 'External runtime' });
    f.runs.addProposals({ proposals: [proposal], agentRunId: f.assistants[2].runCheckpoint!.taskId,
      sessionId: f.session.id, messageId: f.assistants[2].id });
    const dialogWindow = vscode.window as typeof vscode.window & { showOpenDialog?: () => Promise<vscode.Uri[]> };
    const original = dialogWindow.showOpenDialog;
    let finish!: (uris: vscode.Uri[]) => void;
    dialogWindow.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
    const authorizing = f.host.authorizeDraftRunWorkingDirectory(proposal.id);
    try {
      await f.host.sendPrompt('Instruction 3 revised', 'source', 'model', {}, { replaceMessageId: f.users[2].id });
      finish([vscode.Uri.file(external)]);
      await authorizing;
      assert.equal(f.host.authorizedExternalExecutionUris.size, 0);
      assert.ok(f.runs.get(proposal.id)?.historyInvalidationId);
    } finally {
      finish([]); await authorizing;
      if (original) dialogWindow.showOpenDialog = original; else delete dialogWindow.showOpenDialog;
    }
  });
});

test('editing a stopped no-progress task still refreshes dirty project sources and starts a fresh task', async () => {
  await fixture('ask', async f => {
    f.assistants[2].runCheckpoint!.stopReason = 'no_progress_loop';
    let refreshed = 0;
    Object.assign(f.host, {
      sharedProjectSources: { dirty: true },
      refreshSkills: async () => { refreshed++; }
    });
    await f.host.sendPrompt('Instruction 3 revised', 'source', 'model', {}, { replaceMessageId: f.users[2].id });
    assert.equal(refreshed, 1);
    assert.equal(f.requests.length, 1);
    assert.equal(f.session.messages.at(-2)?.userTask?.reason, 'user');
    assert.notEqual(f.session.messages.at(-2)?.userTask?.id, f.users[2].userTask?.id);
  });
});

test('editing recomputes reference grants and records a real tool capability boundary only when required', async () => {
  await fixture('ask', async f => {
    // Exercise the real reference-grant collector rather than the fixture stub.
    f.host.collectAuthorizedExternalReferenceUris = (KeepseekChatViewProvider.prototype as unknown as Host).collectAuthorizedExternalReferenceUris;
    f.host.authorizedExternalReferenceUris.add(vscode.Uri.file(path.join(f.root, 'old-external.txt')).toString());
    const core = getAgentToolNamesForPrompt('Explain this task', true, 14);
    f.session.requestProtocol!.toolNames = core;
    await f.host.sendPrompt('Inspect git status and the whole file', 'source', 'model', {}, { replaceMessageId: f.users[2].id });
    assert.deepEqual(f.requests[0].authorizedExternalReferenceUris, []);
    assert.deepEqual([...f.host.collectAuthorizedExternalReferenceUris(undefined)], [], 'removed task grants must not return on a later ordinary send');
    assert.match(f.requests[0].historyRewriteReason ?? '', /edit_user_prompt:tool_capability_changed/u);
    assert.ok(f.session.requestProtocol!.toolNames.length > core.length);
    const replacement = f.session.messages.at(-2)!;
    const names = [...f.session.requestProtocol!.toolNames];
    await f.host.sendPrompt(replacement.content, 'source', 'model', {}, { replaceMessageId: replacement.id });
    assert.deepEqual(f.session.requestProtocol!.toolNames, names);
    assert.equal(f.requests[1].historyRewriteReason, 'edit_user_prompt');
    const newExternal = path.join(f.root, 'new-external.txt'); await writeFile(newExternal, 'explicit reference');
    await f.host.sendPrompt('Inspect the explicit reference', 'source', 'model', {}, {
      replaceMessageId: f.session.messages.at(-2)!.id, references: [{ path: newExternal }]
    });
    const expectedUri = vscode.Uri.file(newExternal).toString();
    assert.deepEqual(f.requests[2].authorizedExternalReferenceUris, [expectedUri]);
    assert.deepEqual([...f.host.collectAuthorizedExternalReferenceUris(undefined)], [expectedUri], 'new exact reference survives its successful edit commit');
  });
});

test('editing a middle user drops deleted suffix context archives and preserves retained provider archive references', async () => {
  await fixture('ask', async f => {
    const retainedContent = `${f.users[0].content}\n\n[keepseek-archive:keep]`;
    f.users[0].providerContent = retainedContent;
    f.session.historyArchive = [
      { id: 'keep', messageId: 'context:retained-source', toolName: 'skill', role: 'system',
        content: 'retained referenced context', contentHash: 'a'.repeat(64), createdAt: '2026-01-01' },
      { id: 'suffix-stale', messageId: 'context:deleted-suffix-skill', toolName: 'skill', role: 'system',
        content: 'DELETED_SUFFIX_SKILL_ARCHIVE', contentHash: 'b'.repeat(64), createdAt: '2026-01-01' }
    ];
    await f.host.sendPrompt('Instruction 2 revised', 'source', 'model', {}, { replaceMessageId: f.users[1].id });
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.requests[0].historyArchive?.map(entry => entry.id), ['keep']);
    assert.deepEqual(f.session.historyArchive?.map(entry => entry.id), ['keep']);
    assert.equal(f.requests[0].history.find(message => message.id === f.users[0].id)?.providerContent, retainedContent);
    assert.equal(f.session.messages[0].providerContent, retainedContent);
    assert.equal(JSON.stringify(f.requests[0].historyArchive).includes('DELETED_SUFFIX_SKILL_ARCHIVE'), false);
  });
});

for (const mode of ['ask', 'delegate'] as const) {
  test(`${mode}: editing the first user rebases deleted implicit Skill context and excludes its stale archive`, async () => {
    await fixture(mode, async f => {
      const deletedSkill = 'DELETED_FIRST_TASK_IMPLICIT_SKILL_INSTRUCTION';
      f.session.contextInstructions = `Project and run context:\n\n## Deleted implicit Skill\n${deletedSkill}`;
      f.session.historyArchive = [{ id: 'old-skill-archive', messageId: 'context:deleted-implicit-skill',
        toolName: 'skill', role: 'system', content: deletedSkill, contentHash: 'a'.repeat(64), createdAt: '2026-01-01' }];
      // The fixture's real send pipeline refreshes to an empty run context.
      // No retained message justifies keeping the old first task's Skill text.
      await f.host.sendPrompt('Start the replacement task', 'source', 'model', {}, { replaceMessageId: f.users[0].id });
      assert.equal(f.requests.length, 1);
      const request = f.requests[0];
      assert.equal(request.contextInstructions, '');
      assert.equal(f.session.contextInstructions, '');
      assert.match(request.historyRewriteReason ?? '', /context_semantics_changed/u);
      assert.equal(request.historyArchive?.some(entry => entry.id === 'old-skill-archive'), false);
      assert.equal(f.session.historyArchive?.some(entry => entry.id === 'old-skill-archive'), false);
      const projection = buildProviderRequestProjection({ model: request.model, agentSettings: request.settings,
        contextFiles: request.contextFiles, currentRunContext: request.currentRunContext,
        contextInstructions: request.contextInstructions, history: request.history, contextCompression: request.contextCompression,
        language: request.language, prompt: request.prompt, slimToolNames: request.slimToolNames,
        requestProtocolVersion: request.requestProtocolVersion, provider: request.sourceConfig?.provider,
        sourceId: request.sourceConfig?.sourceId, baseUrl: request.sourceConfig?.baseUrl });
      assert.equal(JSON.stringify(projection.messages).includes(deletedSkill), false,
        'the deleted Skill must leave the actual provider projection, not just be contradicted by a later tail');
      assert.equal(JSON.stringify(request.historyArchive ?? []).includes(deletedSkill), false);
      assert.equal(f.session.messages[0].dynamicContextHash, undefined, 'a rebased stable context needs no compensating dynamic tail');
      assert.deepEqual(f.session.requestProtocol?.toolNames, f.frozenToolNames, 'context semantics do not require a tool schema reset');
    });
  });
}

async function fixture(mode: 'ask' | 'delegate', body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-edit-user-'));
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  let f: Awaited<ReturnType<typeof createFixture>> | undefined;
  try { f = await createFixture(root, mode); await body(f); }
  finally {
    if (f) {
      await f.runs.flush(); await f.edits.flush(); await f.storage.flush(); await f.reviews.flush();
      f.runs.dispose(); f.diff.dispose(); f.clock.dispose();
    }
    vscode.workspace.workspaceFolders = folders; vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
}

function stableHistoryMessage(message: ChatMessage): string {
  // Normal persistence may archive a checkpoint. Provider-visible message
  // fields, replay and tool rounds must remain byte-for-byte unchanged.
  const { runCheckpoint: _checkpoint, runCheckpointArchive: _archive, ...history } = message;
  return JSON.stringify(history);
}

async function createFixture(root: string, mode: 'ask' | 'delegate') {
  const workspace = path.join(root, 'project'); await mkdir(workspace);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'project' }];
  vscode.workspace.isTrusted = true;
  const uri = vscode.Uri.file(path.join(root, 'storage')) as never;
  const scope = { key: 'edit-resend', name: 'project', folderUris: [vscode.Uri.file(workspace).toString()] };
  const storage = new GlobalSessionStorage(uri);
  const sessions = new ChatSessionStore(storage, 'en', scope); await sessions.initialize(); await sessions.setApprovalMode(mode);
  const session = sessions.getActiveSession();
  const frozenToolNames = getAgentToolNamesForPrompt('Instruction', false, 14);
  session.requestProtocol = { version: 14, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: 14,
    toolNames: [...frozenToolNames], createdAt: '2026-01-01' };
  session.contextInstructions = '';
  session.usageStats = { requestCount: 7 } as typeof session.usageStats;
  const model = { id: 'model', sourceId: 'source', provider: 'openai-compatible' as const, label: 'Model', contextWindowTokens: 32768, maxOutputTokens: 4096 };
  const settings = { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const };
  const request: AgentRequest = { model, settings, prompt: 'Instruction', contextFiles: [], history: [], language: 'en', sessionId: session.id };
  const users: ChatMessage[] = [], assistants: ChatMessage[] = [];
  for (let i = 0; i < 3; i++) {
    const userTask = { version: 1 as const, id: `user-${i}`, originMessageId: `user-${i}`, reason: 'user' as const };
    const user: ChatMessage = { id: userTask.id, role: 'user', content: `Instruction ${i + 1}`, createdAt: '2026-01-01', userTask };
    const checkpoint = createRunCheckpoint(request, 0, 'test', scope.folderUris);
    checkpoint.status = 'interrupted'; checkpoint.usedMs = 1000;
    const assistant: ChatMessage = { id: `assistant-${i}`, role: 'assistant', content: `Prepared ${i + 1}`, createdAt: '2026-01-01',
      userTask, runCheckpoint: checkpoint };
    session.messages.push(user, assistant); users.push(user); assistants.push(assistant);
  }
  const sourceStore = new ModelSourceStore(uri);
  await sourceStore.createSource({ id: 'source', provider: 'openai-compatible', name: 'Test', apiKey: 'fake-key', models: [{ id: 'model' }] });
  const reviews = new ApprovalReviewStore(uri); await reviews.initialize();
  const runs = new DraftRunStore(uri, { execute: async () => ({ exitCode: 0, timedOut: false, cancelled: false }),
    cancel: () => false, showTerminal: () => false, dispose: () => {} }, new DraftRunAuthorizationService(reviews));
  const diff = new DraftDiffService();
  const edits = new ChangeSetStore(new SafeFileEditor(), diff, sessions, uri, key => key);
  const pendingIds: string[] = [], doneIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const pending = await createDraftRunProposal({ executable: 'node', args: ['--version'], reason: `Pending ${i}` });
    const done = await createDraftRunProposal({ executable: 'node', args: ['--version'], reason: `Done ${i}` });
    runs.addProposals({ proposals: [pending, done], agentRunId: assistants[i].runCheckpoint!.taskId, sessionId: session.id, messageId: assistants[i].id });
    await runs.approveAndRun(done.id, new Set());
    if (i < 2) runs.bindResultsToMessage([done.id], users[2].id);
    pendingIds.push(pending.id); doneIds.push(done.id);
    edits.addDraftEdits({ edits: [{ id: `edit-${i}`, uri: vscode.Uri.file(path.join(workspace, `new-${i}.txt`)).toString(), label: `new-${i}.txt`,
      action: 'create', newText: 'new\n', reason: 'Requested change' }],
    runId: assistants[i].runCheckpoint!.taskId, sessionId: session.id, messageId: assistants[i].id });
  }
  const effectFile = path.join(workspace, 'already-applied.txt'); await writeFile(effectFile, 'already happened\n');
  const queue = new DelegatedApprovalQueue();
  queue.enqueue({ sessionId: session.id, runId: assistants[2].runCheckpoint!.taskId, editIds: ['edit-2'], draftRunIds: [pendingIds[2]] });
  session.approvalProcessing = { version: 2, runId: assistants[2].runCheckpoint!.taskId, rootTaskId: users[2].id,
    mode: 'delegate', status: 'blocked', targets: [{ id: pendingIds[2], kind: 'command', status: 'manual_required' }], updatedAt: '' };
  session.pendingApproval = { version: 1, id: 'old-manual', sessionId: session.id, rootTaskId: users[2].id, agentRunId: assistants[2].runCheckpoint!.taskId,
    targetId: pendingIds[2], actionHash: runs.get(pendingIds[2])!.specHash, label: 'Old command', reason: 'Permission needed', status: 'waiting' };
  const response = { runId: 'new-trace', message: 'New answer', draftEdits: [], draftRuns: [],
    runDetails: new RunDetailsBuilder({ runId: 'new-trace', modelId: 'model', thinkingEnabled: false }).build('succeeded') } as unknown as AgentResponse;
  const clock = new UserTaskClock();
  const requests: AgentRequest[] = [];
  const webviewEvents: unknown[] = [];
  let cancelled = false;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    globalStorageUri: uri, language: 'en', sessionStore: sessions, sourceStore, taskClock: clock,
    changeSets: edits, draftRuns: runs, draftRunBatches: new DraftRunBatchCoordinator(runs), approvalReviews: reviews,
    delegatedApprovals: queue, externalEffectGrants: new ExactOperationGrants(), authorizedExternalExecutionUris: new Set(),
    authorizedExternalReferenceUris: new Set(), activeChangeActions: new Set(), sessionReady: true, approvalDataReady: true, requestContextReady: true,
    fileContext: { getAll: () => [] }, agentSettings: settings, availableModels: [model], selectedSourceId: 'source', selectedModelId: 'model',
    modelSelectionTransactions: { beginRun: () => {} }, repairLoopsBySession: new Map(), taskPlansBySession: new Map(),
    currentRunContextsBySession: new Map(), slimToolNamesBySession: new Map(), sessionTraceLogUris: new Map(), approvalMainContexts: new Map(),
    backgroundRunCoordinator: { getActiveRun: () => undefined }, hasActiveBackgroundRun: () => false,
    skillStore: { getManifests: () => [], getManifest: () => undefined, invalidateImplicitSkillSnapshot: () => {} },
    refreshModelSourceState: async () => {}, awaitRunContextRefresh: async () => true,
    collectAuthorizedExternalReferenceUris: () => new Set(), resolveSessionToolNames: () => [...session.requestProtocol!.toolNames!],
    refreshCurrentRunContext: async () => ({ context: { projectInstructions: [], skills: [], metadata: {
      precedence: [], beforeDeduplicationCount: 0, afterDeduplicationCount: 0, totalCharacterCount: 0,
      totalTokenEstimate: 0, truncated: false, sources: [], discarded: [], possibleConflicts: []
    } } satisfies CurrentRunContext, failures: [] }),
    refreshContextCompressionBeforeRun: async () => {}, scheduleContextCompressionRefresh: () => {},
    agentRequestCoordinator: { createAgentRequest: (value: AgentRequest) => { requests.push(value); return value; } },
    agentRunner: { run: async () => response },
    createRunStreamPublisher: () => ({ dispose: () => {} }), traceLogService: { getLastRunTraceLogUri: () => undefined },
    updateActiveSessionContextUsage: () => {}, createCurrentSessionContextUsage: () => undefined,
    applyPromptCacheDiagnostics: () => [], createRunCacheSummary: () => undefined, applyPendingModelSelectionAfterRun: async () => {},
    postState: () => {}, postToWebview: (value: unknown) => webviewEvents.push(value), setAgentActivity: () => {}, refreshBalance: async () => {},
    scheduleDraftRunAutoContinuation: () => {}, queueResponseApprovals: () => {}, checkpointActivityDepth: 0,
    getApprovalReviewerModelContext: async () => undefined
  }) as Host;
  host.manualToolApproval = { view: { id: 'old-manual' }, decide: approved => { assert.equal(approved, false); cancelled = true; host.manualToolApproval = undefined; } };
  // Run the production stale-source enqueue guard explicitly in the late-result test.
  const send = host.sendPrompt.bind(host);
  host.sendPrompt = async (...args) => {
    const result = await send(...args);
    host.queueResponseApprovals = (KeepseekChatViewProvider.prototype as unknown as Host).queueResponseApprovals;
    return result;
  };
  return { root, session, sessions, users, assistants, host, requests, runs, edits, reviews, queue, clock, storage, diff,
    pendingIds, doneIds, effectFile, response, frozenToolNames, webviewEvents, manualCancelled: () => cancelled };
}
