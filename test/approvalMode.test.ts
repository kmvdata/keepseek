import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { DelegatedApprovalQueue, getApprovalModeUserTail, normalizeApprovalMode } from '../src/agent/approvalMode';
import { buildInitialAgentMessages, getAgentSystemPrompt, RUN_VALIDATION_TOOL_NAME } from '../src/agent/protocol';
import { ToolAuthorizationService } from '../src/agent/tools/toolAuthorization';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import { getScript } from '../src/webview/script';
import type { ApprovalMode, ChatMessage } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('approval defaults fail closed and queue cannot replay, cross sessions, or survive cancellation', () => {
  assert.equal(normalizeApprovalMode('delegate'), 'delegate');
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

test('approval changes only append new user bytes; V5 stays manual and V6 system stays static', () => {
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
  new Script(getInputScript());
  new Script(getScript());
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
  assert.equal((template.match(/id="commandApprovalModeSwitch"/gu) ?? []).length, 1);
  assert.match(getInputScript(), /commandApprovalModeListOpen/u);
  assert.match(getInputScript(), /openCommandApprovalModeListAndFocus/u);
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

test('delegated external file authorization is limited to trusted runs and is not inherited by ask mode', () => {
  const folders = vscode.workspace.workspaceFolders;
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace'), name: 'workspace' }];
    vscode.workspace.isTrusted = true;
    const service = new WorkspaceToolService();
    assert.throws(() => service.resolveTargetUri('/external/file.txt'), /inside/u);
    service.setDelegatedFileAuthorization(true);
    assert.equal(service.resolveTargetUri('/external/file.txt').fsPath, '/external/file.txt');
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

test('failed apply never executes dependent commands and sends failure evidence to the model', async () => {
  const fixture = workflowFixture();
  fixture.failEdit = true;
  await fixture.run();
  assert.deepEqual(fixture.effects, ['edit:e1', 'edit:e2', 'continue']);
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

function workflowFixture() {
  const queue = new DelegatedApprovalQueue();
  const session = { id: 's', approvalMode: 'delegate' as ApprovalMode };
  const fixture = {
    queue, session, effects: [] as string[], prompts: [] as string[], failEdit: false,
    onEdit: () => {}, onCommand: () => {}, run: async () => {}
  };
  const provider = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    language: 'en', delegatedApprovals: queue, repairLoopsBySession: new Map(),
    authorizedExternalReferenceUris: new Set(), selectedSourceId: 'source', selectedModelId: 'model',
    sessionStore: { activeSessionId: 's', getActiveSession: () => session, persist: async () => {} },
    changeSets: {
      flush: async () => {},
      toWebviewState: () => [{ runId: 'r', files: ['e1', 'e2'].map((id) => ({ id, uri: 'file:///workspace/' + id, label: id, status: 'pending' })) }],
      applyEdit: async (id: string, approval: { isAuthorized: () => boolean }) => {
        assert.equal(approval.isAuthorized(), true);
        fixture.effects.push('edit:' + id); fixture.onEdit();
        return { appliedEditIds: fixture.failEdit ? [] : [id], failed: fixture.failEdit ? [{ error: 'file changed' }] : [] };
      }
    },
    draftRuns: {
      flush: async () => {},
      get: (id: string) => ({ id, sessionId: 's', agentRunId: 'r', status: 'pending', spec: { executable: 'node', externalCwd: true, cwdUri: 'file:///external' } }),
      approveAndRun: async (id: string, uris: Set<string>, options: { delegatedApproval: () => boolean }) => {
        assert.equal(options.delegatedApproval(), true);
        assert.equal(uris.has('file:///external'), true);
        fixture.effects.push('command:' + id); fixture.onCommand();
        return { status: 'done' };
      }
    },
    postState: () => {}, setAgentActivity: () => {}, refreshSkills: async () => {}, handleAppliedRepairEdits: async () => {},
    sendPrompt: async (prompt: string) => { fixture.effects.push('continue'); fixture.prompts.push(prompt); }
  }) as { executeDelegatedApprovals(next: NonNullable<ReturnType<DelegatedApprovalQueue['take']>>): Promise<void> };
  fixture.run = async () => {
    vscode.workspace.isTrusted = true;
    queue.enqueue({ sessionId: 's', runId: 'r', editIds: ['e1', 'e2'], draftRunIds: ['d1', 'd2'] });
    await provider.executeDelegatedApprovals(queue.take('s')!);
  };
  return fixture;
}
