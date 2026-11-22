import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPlanWorkflowViews, normalizePlanWorkflowRecords, registerPendingPlan, resolvePlanDecision } from '../src/agent/executionMode';
import { buildPlanHandoffPrompt, hashPlanContent, renderGeneratedHandoffPrompt, verifyHandoffPayload } from '../src/agent/handoffPrompt';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getScript } from '../src/webview/script';
import * as ts from 'typescript';
import { INPUT_SCRIPT_FRAGMENTS, INPUT_STYLE_FRAGMENTS, INPUT_TEMPLATE_FRAGMENTS, composeWebviewFragments } from '../src/webview/input/composition';
import { getStyles } from '../src/webview/styles';
import { getTemplate } from '../src/webview/template';
import { createSession } from './sessionFixtures';

const root = 'file:///Users/alice/my%20project';
function planningSession() {
  const s = createSession({ id: 'session' });
  s.workspaceFolders = [root];
  s.executionMode = 'plan';
  s.messages = [
    { id: 'u', role: 'user', content: 'Fix retry in /Users/alice/my project/src/jobs.ts. Retain order.', createdAt: s.createdAt,
      expandedContent: 'DO_NOT_EXPORT_expansion', providerContent: 'DO_NOT_EXPORT_tail' },
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
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'Use /Users/alice/private.txt', 'en'), { ok: false, reason: 'disclosure' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'Use token sk-' + 'x'.repeat(24), 'en'), { ok: false, reason: 'disclosure' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'Copy this ev_' + '0'.repeat(40) + '.' + 'd'.repeat(24), 'en'),
    { ok: false, reason: 'missing_context' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'File SHA-256 ' + 'a'.repeat(64), 'en'), { ok: false, reason: 'missing_context' });
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
}

test('plan card previews, repeatedly copies with no host mutation, and confirms exact version once', async () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script));
  const start = script.indexOf('function createPlanDecisionCard(');
  const end = script.indexOf('function createRunStatePanel(', start);
  assert.ok(start > 0 && end > start);
  const render = new Function('document', 't', 'canSubmitPrompt', 'canNavigateSessions', 'copyTextToClipboard', 'setTransientStatus', 'vscode',
    script.slice(start, end) + ';return createPlanDecisionCard;');
  const session = planningSession();
  for (const language of ['en', 'zh-CN'] as const) {
    const copies: string[] = [];
    const events: unknown[] = [];
    const cardFor = render({ createElement: () => new Element() },
      (key: string) => WEBVIEW_TRANSLATIONS[language][key], () => true, () => true,
      async (text: string) => copies.push(text), () => undefined, { postMessage: (event: unknown) => events.push(event) });
    const view = getPlanWorkflowViews(session, { language })[0];
    assert.ok(view.promptPreview?.ok);
    const card: Element = cardFor(view);
    const displayed = card.byAction('preview')!;
    assert.equal(displayed.tabIndex, 0);
    const copy = card.byAction('copy_prompt')!;
    copy.listeners.get('click')!(); copy.listeners.get('click')!();
    await Promise.resolve();
    assert.deepEqual(copies, [displayed.textContent, displayed.textContent]);
    assert.deepEqual(events, []);
    const execute = card.byAction('execute_new')!;
    assert.equal(execute.textContent, language === 'en' ? 'Run in new session' : '在新会话执行');
    assert.equal(execute.className, 'primary');
    execute.listeners.get('click')!(); execute.listeners.get('click')!();
    assert.deepEqual(events, [{ type: 'executePlanInNewSession', sessionId: session.id, planId: 'p',
      planHash: view.promptPreview.planHash, bodyHash: hashPlanContent(displayed.textContent) }]);
    const blocked: Element = cardFor({ ...view, newSessionBlockedReason: 'busy' });
    assert.ok(blocked.byAction('execute_new')!.disabled);
    assert.equal(blocked.byAction('copy_prompt')!.disabled, false);
    const reopen: Element = cardFor({ ...view, status: 'superseded', promptPreview: undefined,
      handoff: { phase: 'dispatch_unknown', bodyHash: view.promptPreview.bodyHash, planHash: view.promptPreview.planHash } });
    assert.equal(reopen.byAction('execute_new')!.textContent, language === 'en' ? 'Open target session' : '打开目标会话');
    assert.equal(reopen.byAction('start_execution'), undefined);
  }
  const ids = [...getTemplate().matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  const styles = getStyles();
  assert.ok(styles.indexOf('.plan-decision-title') < styles.indexOf('.plan-prompt-preview'));
  assert.ok(styles.indexOf('.plan-prompt-preview') < styles.indexOf('.plan-decision-actions'));
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
