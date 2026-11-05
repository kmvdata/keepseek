import './registerVscodeStub';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { DelegatedApprovalQueue, draftRunPreparedMessage, getApprovalModeUserTail, normalizeApprovalMode } from '../src/agent/approvalMode';
import { localize, WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { createDraftRunProposal, hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { ExactOperationGrants } from '../src/approvals/authorization';
import { buildInitialAgentMessages, getAgentSystemPrompt, getAgentTools, RUN_VALIDATION_TOOL_NAME } from '../src/agent/protocol';
import { ToolAuthorizationService } from '../src/agent/tools/toolAuthorization';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import type { ApprovalMode, ChatMessage, ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { normalizeApprovalProcessing } from '../src/approvals/approvalProcessing';

test('draft receipt and host authorization text describe the actual mode without claiming execution', () => {
  for (const lang of ['en', 'zh-CN'] as const) for (const mode of ['ask', 'delegate'] as const) {
    const receipt = draftRunPreparedMessage(mode, lang);
    assert.match(receipt, lang === 'en' ? /no process was started/u : /尚未执行/u);
    if (mode !== 'ask') assert.doesNotMatch(receipt, /Wait for the user|等待用户/u);
    const scope = localize(lang, 'approvalExternalPrompt', { target: 'file:///outside/result.txt' });
    assert.match(scope, /file:\/\/\/outside\/result.txt/u);
    assert.notEqual(localize(lang, 'approvalReviewerUnavailable'), 'approvalReviewerUnavailable');
    const delegate = WEBVIEW_TRANSLATIONS[lang].approvalDelegateDescription;
    assert.match(delegate, lang === 'en' ? /decision remains unresolved/u : /仍无法决定/u);
    assert.match(delegate, lang === 'en' ? /extension-host privileges, without an OS sandbox/u : /扩展宿主权限.*无操作系统沙箱/u);
  }
});

test('approval defaults fail closed and queue cannot replay, cross sessions, or survive cancellation', () => {
  assert.equal(normalizeApprovalMode('delegate'), 'delegate');
  assert.equal(normalizeApprovalMode('model_review'), 'ask');
  for (const value of [undefined, true, 'always', 'Delegate', 'ask']) assert.equal(normalizeApprovalMode(value), 'ask');
  const queue = new DelegatedApprovalQueue();
  const batch = { sessionId: 's', runId: 'r', editIds: ['e'], draftRunIds: ['d'] };
  queue.enqueue(batch);
  batch.editIds.push('mutated');
  assert.equal(queue.take('other'), undefined);
  const first = queue.take('s')!;
  assert.deepEqual(first.batch.editIds, ['e']);
  assert.equal(queue.take('s'), undefined);
  queue.enqueue({ ...batch, runId: 'next' });
  queue.cancel();
  assert.equal(first.controller.signal.aborted, true);
  queue.finish(first.controller);
  assert.equal(queue.take('s'), undefined);
  assert.equal(new DelegatedApprovalQueue().take('s'), undefined);
});

test('an interrupted correction retains diagnostics and the attempt ledger without restoring execution authority', () => {
  const state = normalizeApprovalProcessing({ version: 1, runId: 'segment', rootTaskId: 'task', mode: 'delegate',
    status: 'replanning', replanKeys: ['a'.repeat(64)], targets: [{ id: 'run', kind: 'command', status: 'needs_replan',
      replan: { draftRunId: 'run', specHash: 'hash', rootTaskId: 'task', executionSegmentId: 'segment',
        phase: 'preflight', code: 'git_status_pager_override', reason: 'Use controlled status.', executed: false }
    }, { id: 'dependent', kind: 'command', status: 'dependency_blocked', reason: 'Malformed -m.',
      dependency: { targetId: 'run', label: 'git status', reason: 'Use controlled status.' }
    }] });
  assert.equal(state?.status, 'stopped');
  assert.equal(state?.canResume, undefined);
  assert.deepEqual(state?.replanKeys, ['a'.repeat(64)]);
  assert.equal(state?.targets[0].replan?.executed, false);
  assert.equal(state?.targets[1].reason, 'Malformed -m.');
  assert.equal(state?.targets[1].dependency?.targetId, 'run');
  assert.equal(new DelegatedApprovalQueue().take('session'), undefined);
});

test('stored approval modes preserve explicit legacy choices and fail closed on missing or unknown values', () => {
  const scope = { key: 'workspace:test', name: 'Test', folderUris: ['file:///workspace'] };
  const sessions = normalizeStoredSessions({ sessions: [
    storedSession('ask-missing', undefined),
    storedSession('unknown', 'always'),
    storedSession('delegate', 'delegate'),
    storedSession('model', 'model_review')
  ] }, scope);
  const modes = Object.fromEntries(sessions.map((session) => [session.id, session.approvalMode]));
  assert.deepEqual(modes, {
    'ask-missing': 'ask', unknown: 'ask', delegate: 'delegate', model: 'ask'
  });
});

test('approval changes only append new user bytes; V5/V6 stay frozen and V7 adds model review', () => {
  const history: ChatMessage[] = [{ id: 'u', role: 'user', content: 'task', providerContent: 'task\n\n' + getApprovalModeUserTail('ask'), createdAt: '2026-01-01' }];
  const input = { history, language: 'en' as const, contextFiles: [], prompt: 'task', requestProtocolVersion: 6 };
  const before = buildInitialAgentMessages(input);
  const frozen = JSON.stringify(history[0]);
  history.push({ id: 'a', role: 'assistant', content: 'prepared', createdAt: '2026-01-01' });
  history.push({ id: 'u2', role: 'user', content: 'continue', providerContent: 'continue\n\n' + getApprovalModeUserTail('delegate'), createdAt: '2026-01-01' });
  const after = buildInitialAgentMessages({ ...input, prompt: 'continue' });
  assert.equal(JSON.stringify(history[0]), frozen);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.match(getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 5 }), /Every arbitrary command requires a separate user click/u);
  assert.doesNotMatch(getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 6 }), /Every arbitrary command requires a separate user click/u);
  assert.doesNotMatch(getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 6 }), /model_review/u);
  assert.match(getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 7 }), /model_review/u);
  assert.match(getApprovalModeUserTail('delegate'), /materially safer (?:new )?action/u);
  new Script(getInputScript());
  new Script(getScript());
});

test('V1-V6 system and tool bytes remain frozen while the V7 lane has a stable prefix', () => {
  const systemHashes = {
    en: [
      '4a416b83f1739fe004774807758404a064472862dcf3ccfa6490fc62b717c3b7',
      '4a416b83f1739fe004774807758404a064472862dcf3ccfa6490fc62b717c3b7',
      '4a416b83f1739fe004774807758404a064472862dcf3ccfa6490fc62b717c3b7',
      '82552e10d15a319863afc646e7030f60cf8d79c817834a5840f98ff6a54ae206',
      '4b3eb4c23dcb16e80089a9cc53c4802b4dda69c820876debc2ba427836c32465',
      '66a1905e145e0e42844bda3dda11403f3b727210b2c3d62fdd6b49ce5df24a4d',
      'dbfbc84dfc4410a2bcff42009b9e7ffa27a6fb6176439b68d51e1a0099da07de'
    ],
    'zh-CN': [
      '1d63f220eea788dadfca73fbc3c504010fa98be2b836dd6e94edc0238fc4c152',
      '1d63f220eea788dadfca73fbc3c504010fa98be2b836dd6e94edc0238fc4c152',
      '1d63f220eea788dadfca73fbc3c504010fa98be2b836dd6e94edc0238fc4c152',
      '9e32ce6737fa037aa5769e3c18561bdccfbd12e17c03cd89f78996bb50b8fd79',
      'd550e5df53f3381e735376df4e1086b53cfdaad701cbf6b290888b3171302c39',
      'd55205b98254cb7e85404e5e0818adf2ca382cf81ebc2cd6e40106943caf3502',
      '845e1648615c47e47ea1b88b41ab5e5b5205815f77cbeccbc73d235202208fb0'
    ]
  } as const;
  const toolHashes = [
    '68227c9aade1ba1eca24a6b9aaa9fe3ccadfdb1a744947d391f4e01fd9154ebd',
    '68227c9aade1ba1eca24a6b9aaa9fe3ccadfdb1a744947d391f4e01fd9154ebd',
    '97cd1468e229ba0700f183a73580666a7979745eb4985a818d2ef6fef072cff1',
    '92ae22c074c3c2f910c9e72fb1258238722fa53f489ef9ca86b1126561d76a7a',
    '645b7150edcd8a4803875f28d51ab531e48e7e287d4420eb1d587bde44857719',
    '45795f3e011bbccc7820cb2312a42ecf6fdedfd62f7f6b83d105c9425f5733bb',
    '16871e5ca9d5c0db8d78ba513def6189127d4f07db268ee06d3bb86a07384b31'
  ];
  for (const language of ['en', 'zh-CN'] as const) {
    for (let version = 1; version <= 7; version++) {
      assert.equal(hashBytes(getAgentSystemPrompt({ language, requestProtocolVersion: version })), systemHashes[language][version - 1]);
    }
  }
  for (let version = 1; version <= 7; version++) {
    assert.equal(hashBytes(JSON.stringify(getAgentTools({ requestProtocolVersion: version }))), toolHashes[version - 1]);
  }
});

test('approval mode uses the model selector interaction directly below the subagent model', () => {
  const template = getInputTemplate();
  const modelSection = template.indexOf('<section class="command-section" aria-label="Model">');
  const subagentList = template.indexOf('id="commandSubagentModelList"', modelSection);
  const approvalSwitch = template.indexOf('id="commandApprovalModeSwitch"', subagentList);
  const approvalList = template.indexOf('id="commandApprovalModeList"', approvalSwitch);
  const compressionThreshold = template.indexOf('data-i18n="compressionThreshold"', approvalList);

  assert.ok(modelSection >= 0);
  assert.ok(subagentList < approvalSwitch);
  assert.ok(approvalSwitch < approvalList);
  assert.ok(approvalList < compressionThreshold);
  const inputScript = getInputScript();
  const optionList = inputScript.indexOf("{ mode: 'ask'");
  assert.ok(optionList >= 0);
  assert.doesNotMatch(inputScript, /mode: 'model_review'/u);
  assert.ok(optionList < inputScript.indexOf("{ mode: 'delegate'", optionList));
  assert.equal((template.match(/id="commandApprovalModeSwitch"/gu) ?? []).length, 1);
  assert.match(inputScript, /commandApprovalModeListOpen/u);
  assert.match(inputScript, /openCommandApprovalModeListAndFocus/u);
  assert.match(inputScript, /postMessage\(\{ type: 'setApprovalMode'/u);
  assert.doesNotMatch(inputScript, /setComposerStatus\(t\('approvalMode'\)/u);
  assert.match(getScript(), /approvalMode: 'ask'/u);
  assert.doesNotMatch(JSON.stringify(getAgentTools({ requestProtocolVersion: 7 })), /setApprovalMode/u);
});

test('delegated validation is authorized without a dialog; unknown tools remain denied', async () => {
  vscode.workspace.isTrusted = true;
  const service = new ToolAuthorizationService();
  const policy = { ...service.createRunPolicy('r'), approvalMode: 'delegate' as const, mediumRiskPolicy: 'ask' as const };
  const approved = await service.authorize({ policy, toolName: RUN_VALIDATION_TOOL_NAME, args: { script: 'test' }, language: 'en' });
  assert.equal(approved.allowed, true);
  assert.equal(approved.source, 'delegated_approver');
  const unknown = await service.authorize({ policy, toolName: 'unknown', args: {}, language: 'en' });
  assert.equal(unknown.allowed, false);
});

test('ask mode requests approval for each validation even with prior grants and always configuration', async () => {
  const window = vscode.window as unknown as { showInformationMessage?: (...args: unknown[]) => Promise<string> };
  const original = window.showInformationMessage;
  let prompts = 0;
  window.showInformationMessage = async () => { prompts++; return 'Allow once'; };
  try {
    const service = new ToolAuthorizationService();
    const policy = { ...service.createRunPolicy('r'), approvalMode: 'ask' as const, mediumRiskPolicy: 'always' as const };
    for (let i = 0; i < 2; i++) {
      const decision = await service.authorize({ policy, toolName: RUN_VALIDATION_TOOL_NAME, args: { script: 'compile' }, language: 'en' });
      assert.equal(decision.source, 'explicit_confirmation');
    }
    assert.equal(prompts, 2);
  } finally {
    if (original) window.showInformationMessage = original;
    else delete window.showInformationMessage;
  }
});

test('delegation does not grant external file access, even in trusted runs', () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setDelegatedFileAuthorization(true);
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setAuthorizedExternalReferenceUris([]);
    service.setDelegatedFileAuthorization(false);
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setDelegatedFileAuthorization(true);
    vscode.workspace.isTrusted = false;
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

test('reviewer cannot grant external access; explicit reference grants only the exact URI', async () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    const external = await service.inspectExternalRead('/external/reviewed.txt');
    assert.equal(external?.authorized, false);
    const reviewed = external?.uri;
    assert.equal(reviewed, vscode.Uri.file('/external/reviewed.txt').toString());
    assert.throws(() => service.authorizeReviewedExternalUri(reviewed!), /explicit user/u);
    service.setAuthorizedExternalReferenceUris([reviewed!]);
    assert.equal(service.resolveTargetUri('/external/reviewed.txt').toString(), reviewed);
    assert.throws(() => service.resolveTargetUri('/external/sibling.txt'), /inside/u);
  } finally {
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
  }
});

test('delegated workflow applies edits, executes commands, and continues exactly once with real results', async () => {
  const fixture = workflowFixture();
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'command:d1', 'command:d2', 'continue']);
  assert.match(fixture.prompts[0], /"applied":true/u);
  assert.equal(fixture.queue.take('s'), undefined);
});

test('revocation during an edit prevents all subsequent edits, commands and continuation', async () => {
  const fixture = workflowFixture();
  fixture.onEdit = () => { fixture.session.approvalMode = 'ask'; fixture.queue.cancel(); };
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1']);
});

test('failed apply stops dependent commands and retains failure evidence without a model call', async () => {
  const fixture = workflowFixture();
  fixture.failEdit = true;
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'stopped']);
  assert.match(fixture.prompts[0], /file changed/u);
  assert.match(fixture.prompts[0], /"applied":false/u);
});

test('failed command prevents later commands; Stop prevents continuation', async () => {
  const fixture = workflowFixture();
  fixture.onCommand = () => { fixture.queue.cancel(); };
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'command:d1']);
});

test('ask mode does not consume delegated effects even if a stale batch exists', async () => {
  const fixture = workflowFixture();
  fixture.session.approvalMode = 'ask';
  await fixture.run();
  assert.deepEqual(fixture.effects, []);
});

test('ask mode retires malformed argv and dependent drafts while leaving the valid prerequisite for an individual click', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-ask-correction-'));
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  const store = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never);
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'fixture' }];
    vscode.workspace.isTrusted = true;
    const drafts = await Promise.all([
      createDraftRunProposal({ executable: 'git', args: ['add', '--all', '.'], reason: 'Stage' }),
      createDraftRunProposal({ executable: 'git', args: ['commit', '-a', '-m', 'Title', 'stray'], reason: 'Commit' }),
      createDraftRunProposal({ executable: 'git', args: ['status', '--porcelain=v1'], reason: 'Verify' })
    ]);
    store.addProposals({ proposals: drafts, agentRunId: 'r', sessionId: 's' });
    const f = workflowFixture({ mode: 'ask', runStore: store });
    await f.provider.markAskDraftRunCorrections(f.session, 'r', 'r', drafts.map(draft => draft.id));
    assert.equal(store.get(drafts[0].id)?.status, 'pending');
    assert.equal(store.get(drafts[1].id)?.status, 'needs_replan');
    assert.equal(store.get(drafts[1].id)?.replan?.executed, false);
    assert.equal(store.get(drafts[2].id)?.dependency?.targetId, drafts[1].id);
    assert.equal(store.get(drafts[2].id)?.status, 'cancelled');
    assert.deepEqual(f.effects, []);
  } finally {
    await store.flush(); store.dispose();
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
});

test('model denial leaves a DraftEdit pending and records guidance without another model call', async () => {
  const fixture = workflowFixture({ mode: 'delegate', denyTarget: 'e1' });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.match(fixture.prompts[0] ?? '', /denied by the configured reviewer/iu);
  assert.match(fixture.prompts[0] ?? '', /materially safer (?:new )?action/u);
});

test('model denial never spawns a DraftRun', async () => {
  const fixture = workflowFixture({ mode: 'delegate', denyTarget: 'd1', editIds: [], draftRunIds: ['d1'] });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.match(fixture.prompts[0] ?? '', /"decision":"deny"/u);
});

test('reviewer unavailability freezes every remaining effect in the batch', async () => {
  const fixture = workflowFixture({ mode: 'delegate', unavailableBeforeEffects: true });
  await fixture.run();
  assert.deepEqual(fixture.effects, ['stopped']);
  assert.equal(fixture.prompts.length, 1);
  assert.match(fixture.prompts[0], /reviewer unavailable/u);
});

test('an interrupted Git correction stays stopped without replaying a restored draft', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-correction-recovery-'));
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  const workspace = vscode.Uri.file(path.join(root, 'repo'));
  const storage = vscode.Uri.file(path.join(root, 'storage')) as never;
  let launches = 0;
  const executor = { execute: async () => {
    launches++;
    return { exitCode: 0, timedOut: false, cancelled: false };
  }, cancel: () => false, showTerminal: () => false, dispose: () => {} };
  const store = new DraftRunStore(storage, executor);
  const reloaded = new DraftRunStore(storage, executor);
  try {
    execFileSync('git', ['init', '--template=', workspace.fsPath], { stdio: 'pipe' });
    for (const [key, value] of [['commit.gpgsign', 'false'], ['core.fsmonitor', 'false'], ['core.hooksPath', '.git/hooks']]) {
      execFileSync('git', ['config', '--local', key, value], { cwd: workspace.fsPath, stdio: 'pipe' });
    }
    vscode.workspace.workspaceFolders = [{ uri: workspace, name: 'fixture' }];
    vscode.workspace.isTrusted = true;
    const draft = () => createDraftRunProposal({ executable: 'git', args: ['commit', '-a', '-m', 'Title', 'stray'], reason: 'Commit' });
    const first = await draft();
    store.addProposals({ proposals: [first], agentRunId: 'r', sessionId: 's' });
    const original = workflowFixture({ editIds: [], draftRunIds: [first.id], workspacePath: workspace.fsPath, runStore: store });
    original.session.messages[0].content = 'Create a local git commit.';
    let interruptedState: ChatSession['approvalProcessing'];
    original.provider.sendPrompt = async () => {
      interruptedState = structuredClone(original.session.approvalProcessing);
      original.queue.cancel();
    };
    await original.run();
    assert.equal(interruptedState?.status, 'replanning');
    assert.equal(store.get(first.id)?.status, 'needs_replan');
    await store.flush();

    await reloaded.initialize();
    const restarted = workflowFixture({ editIds: [], workspacePath: workspace.fsPath, runStore: reloaded });
    restarted.session.messages[0].content = 'Create a local git commit.';
    restarted.session.approvalProcessing = normalizeApprovalProcessing(interruptedState);
    assert.equal(restarted.queue.take('s'), undefined);
    await restarted.provider.resumeApprovalProcessing();
    assert.ok(restarted.queue.take('s'), 'explicit recovery only queues fresh preflight; it cannot execute by itself');
    assert.equal(restarted.effects.filter(effect => effect === 'continue').length, 0);
    assert.equal(restarted.session.approvalProcessing?.status, 'blocked');
    assert.equal(restarted.session.approvalProcessing?.replanKeys?.length, 1);
    assert.equal(reloaded.get(first.id)?.replan?.executed, false);
    assert.equal(launches, 0);
  } finally {
    await store.flush(); await reloaded.flush();
    store.dispose(); reloaded.dispose();
    vscode.workspace.workspaceFolders = folders;
    vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
});

test('model denial of a deletion leaves the exact file unchanged', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-model-delete-denial-'));
  const target = path.join(root, 'keep.ts');
  const folders = vscode.workspace.workspaceFolders;
  try {
    await writeFile(target, 'preserve these bytes\n', 'utf8');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'workspace' }];
    const fixture = workflowFixture({
      mode: 'delegate',
      denyTarget: 'e1',
      editIds: ['e1'],
      draftRunIds: [],
      deleteOnApplyPath: target
    });
    await fixture.run();
    assert.deepEqual(fixture.effects, ['stopped']);
    assert.equal(await readFile(target, 'utf8'), 'preserve these bytes\n');
  } finally {
    vscode.workspace.workspaceFolders = folders;
    await rm(root, { recursive: true, force: true });
  }
});

function workflowFixture(options: {
  mode?: ApprovalMode;
  denyTarget?: string;
  editIds?: string[];
  draftRunIds?: string[];
  deleteOnApplyPath?: string;
  unavailableBeforeEffects?: boolean;
  workspacePath?: string;
  runStore?: DraftRunStore;
} = {}) {
  const queue = new DelegatedApprovalQueue();
  const userTask = { version: 1, id: 'r', originMessageId: 'u', reason: 'user' };
  const session = { id: 's', approvalMode: options.mode ?? 'delegate', approvalProcessing: undefined as ChatSession['approvalProcessing'], messages: [{
    id: 'u', role: 'user', content: 'Prepare the requested workspace changes and run their commands.', createdAt: '', userTask
  }, {
    id: 'assistant', role: 'assistant', content: '', createdAt: '',
    userTask,
    runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: { taskId: 'r' } }
  }] };
  const fixture = {
    queue, session, effects: [] as string[], prompts: [] as string[], failEdit: false,
    onEdit: () => {}, onCommand: () => {}, run: async () => {}
  };
  const reviews = new Map<string, Record<string, unknown>>();
  let reviewSequence = 0;
  const makeReview = (request: Record<string, unknown>) => {
    const reviewId = `review-${++reviewSequence}`;
    const record = {
      reviewId,
      runtimeId: 'runtime',
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: 1,
      approvalSource: Boolean(options.denyTarget) ? 'model_review' : 'host_policy',
      reviewerSourceId: Boolean(options.denyTarget) ? 'review-source' : '',
      reviewerModelId: Boolean(options.denyTarget) ? 'review-model' : '',
      reviewerProvider: Boolean(options.denyTarget) ? 'openai-responses' : 'host_policy',
      decision: request.targetId === options.denyTarget ? 'deny' : 'approve',
      risk: request.targetId === options.denyTarget ? 'high' : 'low',
      rationale: request.targetId === options.denyTarget
        ? 'Denied by the configured reviewer.'
        : 'Approved for this exact operation.',
      policyRules: [request.targetId === options.denyTarget ? 'least_privilege' : 'direct_user_goal'],
      createdAt: new Date().toISOString()
    };
    reviews.set(reviewId, record);
    return record;
  };
  const edit = (id: string) => options.deleteOnApplyPath
    ? {
        id, uri: vscode.Uri.file(options.deleteOnApplyPath).toString(), label: path.basename(options.deleteOnApplyPath),
        action: 'delete' as const, newText: '', reason: `delete ${id}`
      }
    : {
        id, uri: vscode.Uri.file(path.join(os.tmpdir(), id)).toString(), label: id, action: 'create' as const,
        newText: `content:${id}\n`, reason: `create ${id}`
      };
  const draftRun = (id: string) => {
    const spec = {
      executable: 'node', args: ['--version'], reason: `run ${id}`, externalCwd: false,
      cwdUri: vscode.Uri.file(os.tmpdir()).toString(), cwdLabel: os.tmpdir(), env: [], timeoutMs: 20_000
    };
    return {
    id, sessionId: 's', agentRunId: 'r', messageId: 'a', status: 'pending', specHash: hashDraftRunSpec(spec), spec,
    effectAssessment: { version: 1, verdict: 'likely_readonly', effects: ['workspace_read'], evidence: [] },
    outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
  };
  const provider = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    language: 'en', delegatedApprovals: queue, repairLoopsBySession: new Map(), externalEffectGrants: new ExactOperationGrants(),
    approvalCircuitBreaker: { record: () => ({ tripped: false }) },
    approvalReviews: {
      flush: async () => {},
      get: (id: string) => reviews.get(id),
      getLatestForTarget: () => undefined,
      findDenialForAction: () => undefined
    },
    approvalReviewer: {
      createHostPolicyApproval: async (request: Record<string, unknown>) => ({ status: 'reviewed', record: makeReview(request) }),
      review: async (request: Record<string, unknown>) => ({ status: 'reviewed', record: makeReview(request) }),
      consumeApproval: async (record: Record<string, unknown>) => {
        const consumed = { ...record, consumedAt: new Date().toISOString() };
        reviews.set(String(record.reviewId), consumed);
      }
    },
    getApprovalReviewerModelContext: async () => ({ model: { id: 'model' } }),
    enterTaskWork: () => undefined,
    loadTaskBudget: async () => undefined,
    authorizedExternalReferenceUris: new Set(), selectedSourceId: 'source', selectedModelId: 'model',
    sessionStore: { activeSessionId: 's', getActiveSession: () => session, persist: async () => {} },
    changeSets: {
      flush: async () => {},
      toWebviewState: () => [{ runId: 'r', files: ['e1', 'e2'].map((id) => ({ id, uri: 'file:///workspace/' + id, label: id, status: 'pending' })) }],
      getPendingEdit: (id: string) => ({ edit: edit(id), runId: 'r', sessionId: 's' }),
      preflightEdit: async () => ({ originalText: '' }),
      attachApprovalReview: () => true,
      discardEdit: () => true,
      applyEdit: async (id: string, approval: { isAuthorized: () => boolean }) => {
        assert.equal(approval.isAuthorized(), true);
        fixture.effects.push('edit:' + id); fixture.onEdit();
        if (options.deleteOnApplyPath) await rm(options.deleteOnApplyPath);
        return { appliedEditIds: fixture.failEdit ? [] : [id], failed: fixture.failEdit ? [{ error: 'file changed' }] : [] };
      }
    },
    draftRuns: options.runStore ?? {
      flush: async () => {},
      get: (id: string) => draftRun(id),
      preflightApproval: async (id: string) => draftRun(id),
      setPendingDependency: () => true,
      markNotExecuted: () => true,
      getRunsForSegments: () => [],
      attachApprovalReview: () => true,
      approveAndRun: async (id: string, uris: Set<string>, options: { delegatedApproval: () => boolean }) => {
        assert.equal(options.delegatedApproval(), true);
        assert.equal(uris.size, 0);
        fixture.effects.push('command:' + id); fixture.onCommand();
        return { status: 'done' };
      }
    },
    postState: () => {}, setAgentActivity: () => {}, refreshSkills: async () => {}, awaitRunContextRefresh: async () => true, scheduleRunContextRefresh: () => {}, handleAppliedRepairEdits: async () => {},
    sendPrompt: async (prompt: string) => { fixture.effects.push('continue'); fixture.prompts.push(prompt); return {}; },
    appendStoppedApprovalOutcome: async (prompt: string) => { fixture.effects.push('stopped'); fixture.prompts.push(prompt); }
  }) as { executeDelegatedApprovals(next: NonNullable<ReturnType<DelegatedApprovalQueue['take']>>): Promise<void>;
    resumeApprovalProcessing(): Promise<void>; sendPrompt(prompt: string): Promise<unknown>;
    markAskDraftRunCorrections(chat: typeof session, segmentId: string, rootTaskId: string, ids: string[]): Promise<void> };
  fixture.run = async () => {
    vscode.workspace.isTrusted = true;
    const priorFolders = vscode.workspace.workspaceFolders;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(options.workspacePath ?? os.tmpdir()), name: 'test' }];
    queue.enqueue({
      sessionId: 's',
      runId: 'r',
      editIds: options.editIds ?? ['e1', 'e2'],
      draftRunIds: options.draftRunIds ?? ['d1', 'd2'],
      continueAfterApprovalReview: options.unavailableBeforeEffects || undefined,
      approvalStopReason: options.unavailableBeforeEffects ? 'reviewer unavailable' : undefined,
      approvalReviews: options.unavailableBeforeEffects ? [{
        reviewId: 'review-unavailable', sessionId: 's', rootTaskId: 'r', agentRunId: 'r', targetId: 'validation',
        actionKind: 'validation_run', policyVersion: 1, approvalSource: 'model_review', reviewerSourceId: '',
        reviewerModelId: '', reviewerProvider: '', decision: 'unavailable', risk: 'high', rationale: 'reviewer unavailable',
        createdAt: new Date().toISOString()
      }] : undefined
    });
    try { await provider.executeDelegatedApprovals(queue.take('s')!); }
    finally { vscode.workspace.workspaceFolders = priorFolders; }
  };
  return Object.assign(fixture, { provider });
}

function storedSession(id: string, approvalMode: unknown) {
  return {
    id,
    title: id,
    messages: [],
    approvalMode,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function hashBytes(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
