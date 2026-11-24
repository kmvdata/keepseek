import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { lastUserSelectedPrompt } from '../src/agent/promptGeneration';
import { AgentRunner, getToolExposureError } from '../src/agent/runner';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ProjectQueueService } from '../src/sessions/queue/queueService';
import type { AgentRequest } from '../src/shared/types';
import { SkillStore } from '../src/skills/skillStore';
import { BUILTIN_GEN_PROMPT_ID } from '../src/skills/skillTypes';
import * as vscode from './stubs/vscode';

interface TestHost {
  initializeAfterWebviewReady(): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
  views: Set<unknown>;
  agentRunner: AgentRunner;
  skillStore: SkillStore;
  changeSets: ChangeSetStore;
  drainApproveAllExecution(trigger: string): Promise<void>;
}
const forbidden = ['keepseek_run_validation', 'keepseek_create_draft_edit', 'keepseek_apply_patch',
  'keepseek_run_draft', 'keepseek_delegate_task', 'keepseek_delegate_parallel', 'keepseek_delete_workspace_file'];

for (const mode of ['ask', 'approve-all'] as const) {
  test('gen-prompt submission, forged validation and recovery in ' + mode, async t => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-gen-prompt-turn-')));
    const project = path.join(root, 'project');
    await mkdir(project);
    const folder = vscode.Uri.file(project);
    const state = vscode.Uri.file(path.join(root, 'state'));
    const prevFolders = vscode.workspace.workspaceFolders;
    const prevWindow = { ...vscode.window };
    const notices: string[] = [];
    const alignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
    Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage: async (s: string) => { notices.push(s); },
      showErrorMessage: async (s: string) => { notices.push(s); } });
    vscode.workspace.workspaceFolders = [{ uri: folder, name: 'project' }];
    const storage = new GlobalSessionStorage(state as never);
    const scope = { key: 'folders:' + folder.toString(), name: 'project', folderUris: [folder.toString()] };
    const queue = new ProjectQueueService(key => storage.getProjectQueueUri(key));
    const store = new ChatSessionStore(storage, 'en', scope, queue);
    const init = store.initialize({ fresh: true });
    await init;
    await new ModelSourceStore(state as never).createSource({ id: 'mock', provider: 'openai-compatible', name: 'Mock',
      apiKey: 'fixture', baseUrl: 'https://gen-prompt.invalid/v1', models: [{ id: 'mock', maxOutputTokens: 8192, contextWindowTokens: 128000 }] });
    if (mode === 'ask') {
      store.getActiveSession().messages.push({ id: 'member', role: 'user', content: 'Queued session', createdAt: new Date().toISOString() });
      await store.persist();
      await store.createNewSession();
    }
    const session = store.getActiveSession();
    session.customTitle = 'Prompt tests';
    session.messages.push({ id: 'queued', role: 'user', content: 'Join the queue', createdAt: new Date().toISOString() });
    await store.setApprovalMode(mode);
    await store.persist();
    const provider = new KeepseekChatViewProvider(vscode.Uri.file(process.cwd()) as never, store, state as never,
      { keys: () => [], get: (_k: string, fallback: unknown) => fallback, update: async () => undefined } as never,
      { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' }, init);
    const host = provider as unknown as TestHost;
    const events: Array<Record<string, unknown>> = [];
    host.views.add({ webview: { postMessage: async (event: Record<string, unknown>) => { events.push(event); return true; } } });
    t.after(async () => {
      provider.dispose();
      store.dispose();
      vscode.workspace.workspaceFolders = prevFolders;
      Object.assign(vscode.window, prevWindow);
      Object.assign(vscode, { StatusBarAlignment: alignment });
      await storage.flush();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    });
    let cp: RunCheckpoint | undefined;
    let stopped = false;
    const run = host.agentRunner.run.bind(host.agentRunner);
    t.mock.method(host.agentRunner, 'run', async (req: AgentRequest, cb: Parameters<AgentRunner['run']>[1] = {}) => {
      assert.equal(req.turnIntent, 'generate_prompt');
      return run(req, { ...cb, onCheckpoint: async checkpoint => {
        cp = checkpoint;
        await cb.onCheckpoint?.(checkpoint);
        if (mode === 'ask' && !stopped && checkpoint.state?.pending?.response.message.tool_calls?.length) {
          stopped = true;
          await host.handleMessage({ type: 'abortPrompt', sessionId: session.id });
        }
      } });
    });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(String(url), 'https://gen-prompt.invalid/v1/chat/completions');
      const payload = JSON.parse(String(init.body));
      const names = payload.tools.map((tool: { function: { name: string } }) => tool.function.name);
      assert.ok(names.includes('keepseek_read_evidence'));
      assert.ok(forbidden.every(name => !names.includes(name)));
      const first = ++calls === 1;
      assert.ok(calls <= 2);
      if (!first) assert.match(JSON.stringify(payload.messages), /prompt_generation_read_only/u);
      const delta = first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forged', type: 'function',
        function: { name: 'keepseek_run_validation', arguments: '{"script":"test"}' } }] }
        : { role: 'assistant', content: 'Update counter.ts to export addOne. Verify addOne(3) equals 4.' };
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }] })
        + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    await host.initializeAfterWebviewReady();
    const waiting = path.join(project, 'waiting.ts');
    host.changeSets.addDraftEdits({ sessionId: session.id, runId: 'earlier', messageId: 'queued', edits: [
      createFullTextDraftEdit({ id: 'earlier-draft', uri: vscode.Uri.file(waiting).toString(), label: 'waiting.ts',
        action: 'create', content: 'export {}', reason: 'pre-existing draft' })
    ] });
    const order = store.getProjectQueue()!.entries.map(entry => entry.sessionId);
    assert.equal(order.indexOf(session.id), mode === 'ask' ? 1 : 0);
    await host.handleMessage({ type: 'sendPrompt', sessionId: session.id, requestId: 'gen', sourceId: 'mock', modelId: 'mock',
      skillIds: [BUILTIN_GEN_PROMPT_ID], prompt: mode === 'approve-all' ? '/draft counter.ts\nexport const addOne = (n: number) => n + 1;' : 'Implement addOne in counter.ts now.' });
    if (mode === 'ask') {
      assert.ok(stopped);
      assert.equal(calls, 1);
      const interrupted = session.messages.at(-1)!;
      const reopened = new GlobalSessionStorage(state as never);
      const persistedSession = await reopened.loadSession(scope.key, session.id, { readOnly: true });
      assert.ok(persistedSession && lastUserSelectedPrompt(persistedSession.messages));
      const recovered = normalizeRunCheckpoint(await reopened.loadMessageCheckpoint(scope.key, session.id, interrupted.id));
      assert.ok(recovered && recovered.request.turnIntent === 'generate_prompt');
      assert.equal(recovered.taskId, interrupted.runCheckpoint?.taskId);
      interrupted.runCheckpoint = recovered;
      await host.handleMessage({ type: 'continueAgentTask', messageId: interrupted.id });
    }
    assert.equal(calls, 2, JSON.stringify({ notices, events: events.filter(e => e.type === 'submissionResult'), tail: session.messages.at(-1)?.content }));
    assert.ok(cp && normalizeRunCheckpoint(cp));
    const frozen = cp.request;
    // The answer keeps this turn's own text; the frozen prompt is a separate block.
    const answer = session.messages.at(-1)!;
    assert.equal(answer.content, 'Update counter.ts to export addOne. Verify addOne(3) equals 4.');
    assert.equal(cp.finalResponse?.message, answer.content);
    const block = answer.handoffPrompt;
    assert.ok(block, 'the frozen prompt is delivered as its own block');
    assert.equal(block.version, 1);
    assert.equal(block.body, cp.finalResponse?.handoffPrompt?.body);
    assert.equal(block.bodyHash, createHash('sha256').update(block.body).digest('hex'));
    // Persist, reload and normalize must return the same bytes.
    const persistedAfterRun = await new GlobalSessionStorage(state as never)
      .loadSession(scope.key, session.id, { readOnly: true });
    assert.deepEqual(persistedAfterRun?.messages.find(message => message.id === answer.id)?.handoffPrompt, block);
    assert.equal(cp.state?.validationRunCount, 0);
    assert.deepEqual(cp.finalResponse?.draftEdits, []);
    assert.equal(cp.finalResponse?.changeSet, undefined);
    assert.deepEqual(store.getProjectQueue()!.entries.map(entry => entry.sessionId), order);
    await host.drainApproveAllExecution('run_end');
    await assert.rejects(access(waiting));
    assert.ok(host.changeSets.hasPendingForSession(session.id));
    const weakened = structuredClone(cp);
    delete weakened.request.turnIntent;
    assert.equal(normalizeRunCheckpoint(weakened), undefined);
    for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
      const projection = buildProviderRequestProjection({ ...frozen, agentSettings: frozen.settings, provider,
        slimToolNames: [...forbidden, 'keepseek_read_workspace_file', 'keepseek_read_evidence'] });
      const names = projection.responses?.tools.map(tool => tool.name) ?? projection.anthropic?.tools.map(tool => tool.name)
        ?? projection.tools.map(tool => tool.function.name);
      assert.deepEqual(names.sort(), ['keepseek_read_evidence', 'keepseek_read_workspace_file']);
      // The frozen prompt must never reach provider-visible bytes.
      assert.ok(!JSON.stringify(projection).includes(block.body));
    }
    for (const name of forbidden) {
      assert.match(getToolExposureError(name, new Set([name]), frozen.turnIntent)!, /prompt_generation_read_only/u);
    }
    const beforeFailure = session.messages.map(message => message.id);
    const unavailable = t.mock.method(host.skillStore, 'resolveAndLoadSkills', async () => ({
      skills: [], failures: [{ id: BUILTIN_GEN_PROMPT_ID, name: 'gen-prompt', error: 'Missing package resource' }]
    }));
    await host.handleMessage({ type: 'sendPrompt', sessionId: session.id, requestId: 'unavailable', sourceId: 'mock', modelId: 'mock',
      skillIds: [BUILTIN_GEN_PROMPT_ID], prompt: 'Apply the change now.' });
    unavailable.mock.restore();
    assert.equal(calls, 2);
    assert.deepEqual(session.messages.map(message => message.id), beforeFailure);
    assert.ok(events.some(event => event.type === 'submissionResult' && event.requestId === 'unavailable' && event.status === 'rejected'));
    assert.match(notices.join(' '), /gen-prompt/u);
    await host.drainApproveAllExecution('slot_released');
    await assert.rejects(access(waiting));
    // A block whose hash no longer matches its body is dropped on load while the
    // message itself still loads.
    answer.handoffPrompt = { version: 1, body: block.body, bodyHash: 'f'.repeat(64) };
    await store.persist();
    const reopenedTampered = await new GlobalSessionStorage(state as never)
      .loadSession(scope.key, session.id, { readOnly: true });
    const tamperedMessage = reopenedTampered?.messages.find(message => message.id === answer.id);
    assert.ok(tamperedMessage, 'the message survives a dropped prompt block');
    assert.equal(tamperedMessage.handoffPrompt, undefined);
  });
}
