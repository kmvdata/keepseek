import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPlanWorkflowViews, normalizePlanWorkflowRecords, registerPendingPlan, resolvePlanDecision } from '../src/agent/executionMode';
import { buildPlanHandoffPrompt, hashPlanContent, renderGeneratedHandoffPrompt, verifyHandoffPayload } from '../src/agent/handoffPrompt';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import { type KeepseekLanguage, WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import type { PlanWorkflowView } from '../src/shared/types';
import { getScript } from '../src/webview/script';
import * as ts from 'typescript';
import { INPUT_SCRIPT_FRAGMENTS, INPUT_STYLE_FRAGMENTS, INPUT_TEMPLATE_FRAGMENTS, composeWebviewFragments } from '../src/webview/input/composition';
import { getStyles } from '../src/webview/styles';
import { getTemplate } from '../src/webview/template';
import { getRichTextShortcutsScript } from '../src/webview/richTextShortcuts';
import { createSession } from './sessionFixtures';
import * as vscode from './stubs/vscode';

const root = 'file:///Users/alice/my%20project';
function planningSession() {
  const s = createSession({ id: 'session' });
  s.workspaceFolders = [root];
  s.executionMode = 'plan';
  s.messages = [
    { id: 'u', role: 'user', content: 'Fix retry in /Users/alice/my project/src/jobs.ts. Retain order.', createdAt: s.createdAt,
      expandedContent: 'DO_NOT_EXPORT_expansion', providerContent: 'DO_NOT_EXPORT_tail',
      userTask: { version: 1, id: 'u', originMessageId: 'u', reason: 'user' } },
    { id: 'a', role: 'assistant', content: 'Update retryJob in src/jobs.ts. Check that retry preserves FIFO.', createdAt: s.createdAt,
      reasoningContent: 'DO_NOT_EXPORT_reasoning' }
  ];
  registerPendingPlan({ id: 'p', session: s, userMessageId: 'u', assistantMessageId: 'a', content: s.messages[1].content });
  return s;
}

test('validated export is portable, deterministic and read-only, with host full-file digest provenance', () => {
  const session = planningSession();
  const rawFileDigest = hashPlanContent('\uFEFFconst jobs = [];\r\n');
  const evidenceDigest = hashPlanContent('{}');
  session.messages[1].toolRounds = [{
    assistantContent: null, reasoningContent: null, toolCalls: [{ id: 'read', type: 'function',
      function: { name: 'keepseek_read_workspace_file', arguments: '{"path":"src/jobs.ts"}' } }],
    toolResults: [{ toolCallId: 'read', content: JSON.stringify({
      ok: true, uri: root + '/src/jobs.ts', fileSha256: rawFileDigest, contentHash: evidenceDigest,
      fingerprint: 'DO_NOT_EXPORT_stat', content: 'DO_NOT_EXPORT_file'
    }) }]
  }];
  const original = structuredClone(session);
  const preview = buildPlanHandoffPrompt(session, 'p', 'en');
  assert.ok(preview.ok);
  assert.equal(preview.bodyHash, hashPlanContent(preview.body));
  assert.match(preview.body, /Fix retry in \.\/src\/jobs.ts. Retain order/u);
  assert.ok(preview.body.includes(rawFileDigest));
  assert.ok(!preview.body.includes(evidenceDigest));
  assert.doesNotMatch(preview.body, /Users\/alice|DO_NOT_EXPORT/u);
  assert.deepEqual(getPlanWorkflowViews(session, { language: 'en', newSessionBlockedReason: 'Busy' })[0].promptPreview, preview);
  assert.deepEqual(buildPlanHandoffPrompt(session, 'p', 'en'), preview);
  assert.deepEqual(session, original);
  session.messages[1].content += '!';
  assert.deepEqual(buildPlanHandoffPrompt(session, 'p', 'en'), { ok: false, reason: 'invalid' });
});

test('a revision retains original requirements, and restore retains its external disclosure boundary', () => {
  const session = planningSession();
  assert.ok(resolvePlanDecision({ session, activeSessionId: session.id, planId: 'p', action: 'revise_plan' }).ok);
  session.messages.push({ id: 'u2', role: 'user', createdAt: session.createdAt, content: 'Also test cancellation.' },
    { id: 'a2', role: 'assistant', createdAt: session.createdAt, content: 'Test cancellation before retry.' });
  registerPendingPlan({ session, id: 'p2', userMessageId: 'u2', assistantMessageId: 'a2', content: session.messages[3].content });
  session.planWorkflows = normalizePlanWorkflowRecords(JSON.parse(JSON.stringify(session.planWorkflows)), session.id);
  const revised = buildPlanHandoffPrompt(session, 'p2', 'en');
  assert.ok(revised.ok);
  assert.match(revised.body, /Retain order/u);
  assert.match(revised.body, /Also test cancellation/u);
  assert.deepEqual(buildPlanHandoffPrompt(session, 'p', 'en'), { ok: false, reason: 'invalid' });
  session.planWorkflows[1].externalHandoffContext = true;
  assert.deepEqual(buildPlanHandoffPrompt(session, 'p2', 'en'), { ok: false, reason: 'disclosure' });
});

test('gen-prompt removes its selector and keeps the same execution prompt contract', () => {
  const s = planningSession();
  const artifact = renderGeneratedHandoffPrompt('[$gen-prompt](builtin:gen-prompt) ' + s.messages[0].content,
    s.messages[1].content, 'zh-CN', s.workspaceFolders);
  const fromPlan = buildPlanHandoffPrompt(s, 'p', 'zh-CN');
  assert.ok(artifact.ok && fromPlan.ok);
  assert.equal(artifact.bodyHash, fromPlan.bodyHash);
  assert.doesNotMatch(artifact.body, /builtin:gen-prompt/u);
  // A user-pasted absolute path is no longer a static refusal: only evidence of a read outside
  // the project, or a private key block, still blocks. Sensitive values are redacted instead.
  const pasted = renderGeneratedHandoffPrompt('Goal', 'Use /Users/alice/private.txt', 'en');
  assert.equal(pasted.ok, true);
  const secret = 'sk-' + 'aB3dE9fG2hJ5kL8mN1pQ4rS7';
  const token = renderGeneratedHandoffPrompt('Goal', 'Use token ' + secret, 'en');
  assert.equal(token.ok, true);
  if (token.ok) {
    assert.ok(token.body.includes('[REDACTED]'));
    assert.ok(!token.body.includes(secret));
  }
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'Copy this ev_' + '0'.repeat(40) + '.' + 'd'.repeat(24), 'en'),
    { ok: false, reason: 'missing_context' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'File SHA-256 ' + 'a'.repeat(64), 'en'), { ok: false, reason: 'missing_context' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', '-----BEGIN RSA PRIVATE KEY-----', 'en'), { ok: false, reason: 'disclosure' });
  const body = 'a'.repeat(23_000) + '\nmandatory acceptance\n' + 'b'.repeat(10_000);
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', body, 'en'), { ok: false, reason: 'oversize' });
  const small = renderGeneratedHandoffPrompt('Goal', 'mandatory acceptance', 'en');
  assert.ok(small.ok);
  assert.throws(() => verifyHandoffPayload({ model: 'm', stream: true, messages: [
    { role: 'user', content: small.body.replace('mandatory acceptance', '[archived]') }
  ] }, small.body, small.bodyHash));
  for (const tail of ['', '\n\n[current context]']) {
    const projection: string = small.body + tail;
    assert.equal(verifyHandoffPayload({ model: 'm', stream: true, messages: [{ role: 'user', content: projection }] },
      small.body, small.bodyHash), hashPlanContent(projection));
  }
});

test('approval tail can disable new-session execution while copy remains lossless', () => {
  const s = planningSession();
  s.approvalMode = 'approve-all';
  s.messages[1].content = 'step ' + 'x'.repeat(14_500) + ' MIDPOINT_ACCEPTANCE ' + 'y'.repeat(14_800);
  registerPendingPlan({ session: s, id: 'large', userMessageId: 'u', assistantMessageId: 'a', content: s.messages[1].content });
  const card = getPlanWorkflowViews(s, { language: 'en' }).at(-1)!;
  assert.ok(card.promptPreview?.ok);
  assert.ok(card.promptPreview.body.includes('MIDPOINT_ACCEPTANCE'));
  assert.match(card.newSessionBlockedReason ?? '', /first-message limit/u);
});

class Element {
  readonly children: Element[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  disabled = false;
  className = '';
  tabIndex?: number;
  textContent = '';
  append(...children: Element[]) { this.children.push(...children); }
  setAttribute() { /* browser attribute storage is unnecessary for these assertions */ }
  addEventListener(name: string, fn: () => void) { this.listeners.set(name, fn); }
  byAction(name: string): Element | undefined {
    return this.dataset.planAction === name ? this : this.children.map(c => c.byAction(name)).find(Boolean);
  }
  hasText(text: string): boolean { return this.textContent === text || this.children.some(c => c.hasText(text)); }
}

function planCardHarness(language: KeepseekLanguage) {
  const script = getScript();
  const start = script.indexOf('function createPlanDecisionCard(');
  const end = script.indexOf('function createRunStatePanel(', start);
  assert.ok(start > 0 && end > start);
  const render = new Function('document', 't', 'canSubmitPrompt', 'canNavigateSessions', 'window', 'setTransientStatus', 'vscode',
    script.slice(start, end) + ';return createPlanDecisionCard;');
  const copies: string[] = [];
  const events: WebviewMessage[] = [];
  const statuses: string[] = [];
  let receive!: (event: { data: unknown }) => void;
  const window = { addEventListener: (type: string, listener: typeof receive) => {
    if (type === 'message') receive = listener;
  } };
  const port = { postMessage: (event: WebviewMessage) => events.push(event) };
  const clipboard = { writeText: async (text: string) => { copies.push(text); } };
  new Function('window', 'navigator', 'vscode', getRichTextShortcutsScript())(window, { clipboard }, port);
  const capabilities = { canSubmit: true, canNavigate: true };
  const cardFor: (view: PlanWorkflowView) => Element = render({ createElement: () => new Element() },
    (key: string) => WEBVIEW_TRANSLATIONS[language][key], () => capabilities.canSubmit, () => capabilities.canNavigate,
    window, (status: string) => statuses.push(status), port);
  return { cardFor, copies, events, capabilities, clipboard, statuses, receive };
}

test('plan card previews, repeatedly copies with no host mutation, and confirms exact version once', async () => {
  assert.doesNotThrow(() => new Function(getScript()));
  const session = planningSession();
  for (const language of ['en', 'zh-CN'] as const) {
    const { cardFor, copies, events } = planCardHarness(language);
    const view = getPlanWorkflowViews(session, { language })[0];
    assert.ok(view.promptPreview?.ok);
    const card: Element = cardFor(view);
    const displayed = card.byAction('preview')!;
    assert.equal(displayed.tabIndex, 0);
    const copy = card.byAction('copy_prompt')!;
    assert.equal(copy.textContent, language === 'en' ? 'Copy execution prompt' : '复制执行提示词');
    copy.listeners.get('click')!(); copy.listeners.get('click')!();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(copies, [displayed.textContent, displayed.textContent]);
    assert.deepEqual(events, []);
    const execute = card.byAction('execute_new')!;
    assert.equal(execute.textContent, language === 'en' ? 'Run in new session' : '在新会话执行');
    assert.equal(execute.className, 'primary');
    execute.listeners.get('click')!(); execute.listeners.get('click')!();
    assert.deepEqual(events, [{ type: 'executePlanInNewSession', sessionId: session.id, planId: 'p',
      planHash: view.promptPreview.planHash, bodyHash: hashPlanContent(displayed.textContent) }]);
  }
  const ids = [...getTemplate().matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const styles = getStyles();
  assert.ok(styles.indexOf('.plan-decision-title') < styles.indexOf('.plan-prompt-preview'));
  assert.ok(styles.indexOf('.plan-prompt-preview') < styles.indexOf('.plan-decision-actions'));
});

test('denied browser clipboard falls back to the host and reports success after the matching acknowledgement', async t => {
  const { cardFor, clipboard, events, receive, statuses } = planCardHarness('en');
  clipboard.writeText = async () => { throw new Error('Browser clipboard access denied'); };
  const writes: string[] = [];
  const original = Object.getOwnPropertyDescriptor(vscode, 'env');
  Object.defineProperty(vscode, 'env', { configurable: true, value: {
    clipboard: { writeText: async (text: string) => { writes.push(text); } }
  } });
  t.after(() => { if (original) Object.defineProperty(vscode, 'env', original); else Reflect.deleteProperty(vscode, 'env'); });
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    sessionStore: { activeSessionId: 'session' }, postToWebview: (data: unknown) => receive({ data })
  }) as { handleMessage(message: WebviewMessage): Promise<void> };
  const view = getPlanWorkflowViews(planningSession(), { language: 'en' })[0];
  assert.ok(view.promptPreview?.ok);
  cardFor(view).byAction('copy_prompt')!.listeners.get('click')!();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(events.length, 1);
  const [request] = events;
  assert.ok(request.type === 'writeClipboardText' && request.requestId);
  assert.equal(request.text, view.promptPreview.body);
  receive({ data: { type: 'clipboardWriteResult', ok: true, requestId: 'different-request' } });
  await Promise.resolve();
  assert.deepEqual(statuses, []);
  await host.handleMessage(request);
  assert.deepEqual(writes, [view.promptPreview.body]);
  assert.deepEqual(statuses, [WEBVIEW_TRANSLATIONS.en.copied]);
  assert.equal(events.length, 1);
});

test('pending plan exposes only applicable handoff actions and keeps the current-session decisions usable', async () => {
  for (const language of ['en', 'zh-CN'] as const) {
    const { cardFor, copies, events, capabilities } = planCardHarness(language);
    const session = planningSession();
    const newSessionBlockedReason = WEBVIEW_TRANSLATIONS[language].planActionUnavailable;
    const blocked = getPlanWorkflowViews(session, { language, newSessionBlockedReason })[0];
    assert.ok(blocked.promptPreview?.ok);
    const card = cardFor(blocked);
    assert.equal(card.byAction('execute_new'), undefined);
    assert.equal(card.hasText(newSessionBlockedReason), false);
    assert.equal(card.byAction('start_execution')!.className, 'primary');
    assert.equal(card.byAction('copy_prompt')!.disabled, false);
    capabilities.canSubmit = false;
    const busyCard = cardFor(getPlanWorkflowViews(session, { language })[0]);
    assert.equal(busyCard.byAction('execute_new'), undefined);
    busyCard.byAction('copy_prompt')!.listeners.get('click')!();
    await Promise.resolve();
    assert.deepEqual(copies, [blocked.promptPreview.body]);
    assert.deepEqual(events, []);

    capabilities.canSubmit = true;
    session.planWorkflows![0].externalHandoffContext = true;
    const restricted = getPlanWorkflowViews(session, { language })[0];
    assert.deepEqual(restricted.promptPreview, { ok: false, reason: 'disclosure' });
    const local = cardFor(restricted);
    assert.equal(local.byAction('preview'), undefined);
    assert.equal(local.byAction('copy_prompt'), undefined);
    assert.equal(local.byAction('execute_new'), undefined);
    assert.equal(local.hasText(restricted.newSessionBlockedReason!), false);
    assert.equal(local.byAction('start_execution')!.className, 'primary');
    const decisions = ['start_execution', 'revise_plan', 'exit_plan'];
    for (const action of decisions) {
      const button = local.byAction(action)!;
      assert.equal(button.disabled, false);
      button.listeners.get('click')!();
    }
    assert.deepEqual(events, decisions.map(action => ({ type: 'resolvePlanDecision', planId: 'p', action })));
  }
});

test('handoff receipts preserve recovery and navigation controls independently of copy', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    const { cardFor, capabilities } = planCardHarness(language);
    const labels = WEBVIEW_TRANSLATIONS[language];
    const view = getPlanWorkflowViews(planningSession(), { language })[0];
    assert.ok(view.promptPreview?.ok);
    const receipt = { ...view, status: 'superseded' as const,
      handoff: { phase: 'queued' as const, bodyHash: view.promptPreview.bodyHash, planHash: view.promptPreview.planHash } };
    const resume = cardFor(receipt);
    assert.equal(resume.byAction('execute_new')!.textContent, labels.planHandoffResume);
    assert.equal(resume.byAction('execute_new')!.disabled, false);
    assert.equal(resume.byAction('start_execution'), undefined);
    capabilities.canSubmit = false;
    assert.equal(cardFor(receipt).byAction('execute_new')!.disabled, true);
    assert.equal(cardFor(receipt).byAction('copy_prompt')!.disabled, false);

    const unknown = { ...receipt, handoff: { ...receipt.handoff, phase: 'dispatch_unknown' as const } };
    const open = cardFor({ ...unknown, promptPreview: undefined });
    assert.equal(open.byAction('execute_new')!.textContent, labels.planHandoffOpen);
    assert.equal(open.byAction('execute_new')!.disabled, false);
    assert.equal(open.byAction('copy_prompt'), undefined);
    capabilities.canNavigate = false;
    const waiting = cardFor(unknown);
    assert.equal(waiting.byAction('execute_new')!.disabled, true);
    assert.equal(waiting.hasText(labels.planActionUnavailable), true);
    assert.equal(waiting.byAction('copy_prompt')!.disabled, false);
  }
});

test('emitted webview retains the shared script declarations and ordered input fragments', () => {
  const script = getScript();
  const tree = ts.createSourceFile('webview.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const names: string[] = [];
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) names.push(statement.name.text);
    if (ts.isVariableStatement(statement)) names.push(...statement.declarationList.declarations.map(d => d.name.getText(tree)));
  }
  assert.ok(names.includes('createPlanDecisionCard'));
  assert.equal(names.length, new Set(names).size);
  assert.ok(script.includes(composeWebviewFragments(INPUT_SCRIPT_FRAGMENTS)));
  assert.ok(getStyles().includes(composeWebviewFragments(INPUT_STYLE_FRAGMENTS)));
  assert.ok(getTemplate().includes(composeWebviewFragments(INPUT_TEMPLATE_FRAGMENTS)));
});

test('frozen prompt export observes the source history at plan completion', () => {
  const session = planningSession();
  const oldTurn: typeof session.messages[number] = { id: 'external', role: 'user', content: 'Read the attachment.',
    createdAt: session.createdAt, externalHandoffContext: true };
  session.messages.push(oldTurn);
  assert.ok(buildPlanHandoffPrompt(session, 'p', 'en').ok);
  session.messages.pop();
  session.messages.unshift(oldTurn);
  assert.deepEqual(buildPlanHandoffPrompt(session, 'p', 'en'), { ok: false, reason: 'disclosure' });
});
