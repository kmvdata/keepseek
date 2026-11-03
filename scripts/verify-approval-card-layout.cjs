// Run after `bun run build:test`, then open the printed HTML file in a browser.
// Uses the complete production Webview HTML/CSS/script, with a synthetic Host only.
// No model requests, command execution, file edits or third-party dependencies.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../out-test/test/registerVscodeStub');
const { getHtmlForWebview } = require('../out-test/src/webview/html');
const { Uri } = require('../out-test/test/stubs/vscode');

const theme = `:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-editor-font-family: monospace;
  --vscode-foreground: #ddd; --vscode-editor-foreground: #ddd;
  --vscode-descriptionForeground: #aaa; --vscode-errorForeground: #f88;
  --vscode-sideBar-background: #202020; --vscode-editor-background: #181818;
  --vscode-panel-border: #555; --vscode-button-background: #176ca4;
  --vscode-button-foreground: white; --vscode-focusBorder: #39f;
}`;
let webview = getHtmlForWebview({
  webview: { cspSource: "'self'", asWebviewUri: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
  extensionUri: Uri.file(process.cwd()), language: 'zh-CN', extensionInfo: { version: 'layout-fixture' }
});
const nonce = webview.match(/script nonce="([^"]+)"/)[1];
webview = webview.replace('<style>', '<style>' + theme).replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">
  window.fixtureMessages = [];
  window.acquireVsCodeApi = () => ({postMessage: m => window.fixtureMessages.push(m), getState: () => null, setState: () => {}});
</script><script nonce="${nonce}">`);

function client() {
  const frame = document.querySelector('iframe');
  const output = document.querySelector('pre');
  const widths = [320, 379, 380, 480, 600, 920];
  const longReason = '等待你授权精确操作范围：Command scope cannot be established statically; authorize this exact operation. / 无法静态确定命令范围，请确认这条精确操作。';
  const reasons = ['Scope required', longReason, 'file:///external/' + 'very-long-directory/'.repeat(30), 'X'.repeat(500)];
  let revision = 0;
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  function sample(language, mode, reason, status = 'needs_authorization') {
    const runs = ['single', 'batch-A', 'batch-B'].map(id => ({ id, sessionId: 'layout', agentRunId: 'run',
      messageId: 'assistant', specHash: 'hash-' + id, status: 'pending', spec: {
        executable: 'npm', args: ['run', 'lint'], cwdLabel: 'signal_tracker_spa', cwdUri: 'file:///test/signal_tracker_spa', timeoutMs: 120000,
        reason: language === 'en' ? 'Run ESLint on the updated SPA source to check syntax, unused variables and unused imports.'
          : '对修改后的 SPA 源码运行 ESLint，确认删除代码后无语法 / 未使用变量 / 未使用导入类错误。'
      }, effectAssessment: { verdict: 'unknown', effects: ['unknown'] } }));
    return { language, approvalMode: mode, activeSessionId: 'layout', isBusy: false,
      startup: { phase: 'ready', interactiveReady: true, sideEffectsReady: true },
      messages: [{ id: 'assistant', role: 'assistant', content: '', createdAt: '2026-11-03T00:00:00Z' }],
      draftRuns: runs, draftRunBatchHistory: [{ operationId: 'layout-batch', sessionId: 'layout', agentRunId: 'run', phase: 'interrupted',
        entries: runs.slice(1).map(r => ({ draftRunId: r.id, specHash: r.specHash })), currentIndex: 0, remaining: 2 }],
      changeSets: [{ id: 'set', messageId: 'assistant', status: 'pending', operationSummary: 'Layout fixture',
        files: [{ id: 'edit', status: 'pending', action: 'modify', label: 'src/example.ts', uri: 'file:///test/example.ts', reason: runs[0].spec.reason }] }],
      approvalProcessing: { version: 1, runId: 'run', rootTaskId: 'task', mode,
        status: status === 'pending' ? 'processing' : 'blocked', updatedAt: '',
        targets: [...runs.map(r => ({ id: r.id, kind: 'command', status, reason })), { id: 'edit', kind: 'edit', status, reason }] }
    };
  }
  function update(state) {
    frame.contentWindow.dispatchEvent(new frame.contentWindow.MessageEvent('message', { data: { type: 'state', revision: ++revision, state } }));
  }
  function measure(reason, scale) {
    const doc = frame.contentDocument;
    const cards = [...doc.querySelectorAll('.draft-run-card, .draft-chip')];
    check(cards.length === 4, 'all command and file cards rendered');
    check(doc.querySelectorAll('.draft-run-batch-members .draft-run-card').length === 2, 'real nested batch rendered');
    const measurements = [];
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const actions = card.querySelector('.draft-run-actions, .draft-chip-actions');
      const note = card.querySelector('.approval-state-note');
      const heading = card.querySelector('.draft-run-heading, .draft-chip-content');
      check(note && note.textContent === reason, 'complete note');
      check(!actions.contains(note) && [...actions.children].every(n => n.tagName === 'BUTTON'), 'buttons only');
      const h = heading.getBoundingClientRect(), n = note.getBoundingClientRect(), a = actions.getBoundingClientRect();
      check(h.width >= rect.width * 0.8 && n.width >= rect.width * 0.8, 'heading and note use card width');
      check(n.top >= h.bottom - 1 && a.top >= n.bottom - 1, 'ordered nonoverlapping rows');
      check(card.scrollWidth <= card.clientWidth + 1, 'card has no horizontal overflow');
      check(Math.abs(parseFloat(frame.contentWindow.getComputedStyle(note).marginLeft)) < 1, 'no file icon indent');
      const buttons = [...actions.querySelectorAll('button')];
      for (const button of buttons) {
        const b = button.getBoundingClientRect();
        check(b.width > 0 && b.height > 0 && b.left >= rect.left && b.right <= rect.right + 1, 'button inside card');
        check(b.bottom <= rect.bottom + 1 && b.top >= a.top - 1, 'button not vertically clipped');
        check(button.scrollWidth <= button.clientWidth + 1, 'button label not clipped');
        button.focus(); check(doc.activeElement === button, 'button focusable');
      }
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i].getBoundingClientRect(), b = buttons[j].getBoundingClientRect();
        check(Math.min(a.right, b.right) <= Math.max(a.left, b.left) + 1 || Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top) + 1, 'buttons do not overlap');
      }
      const title = card.querySelector('.draft-run-title');
      if (title) {
        const range = doc.createRange(); range.selectNodeContents(title);
        check(range.getClientRects().length === 1, 'sample title stays on one line');
        const values = [...card.querySelectorAll('.draft-run-field-value')];
        check(values[0].textContent === 'npm run lint' && values[1].textContent.includes('signal_tracker_spa'), 'command and cwd preserved');
        check(values.every(v => v.scrollWidth <= v.clientWidth + 1), 'command and cwd wrap without clipping');
      }
      measurements.push({ kind: title ? (card.closest('.draft-run-batch-group') ? 'nested' : 'single') : 'file',
        cardWidth: rect.width / scale, headingWidth: h.width / scale, noteWidth: n.width / scale, height: rect.height / scale });
    }
    return measurements;
  }
  async function show(width, language, mode, reason, scale) {
    frame.style.width = width + 'px';
    frame.contentDocument.documentElement.style.zoom = scale;
    update(sample(language, mode, reason));
    await paint();
  }
  document.querySelector('#matrix').onclick = async () => {
    const results = []; output.textContent = 'Running…';
    try {
      for (const width of widths) for (const language of ['zh-CN', 'en']) for (const mode of ['delegate', 'model_review'])
        for (const scale of [1, 1.25, 1.5]) for (let reasonIndex = 0; reasonIndex < reasons.length; reasonIndex++) {
          await show(width, language, mode, reasons[reasonIndex], scale);
          results.push({ width, language, mode, scale, reasonIndex, cards: measure(reasons[reasonIndex], scale) });
        }
      // State updates travel through the actual Host-message handler; clicks reach only the synthetic Host.
      for (const status of ['pending', 'failed', 'denied', 'needs_authorization']) {
        update(sample('en', 'model_review', status === 'needs_authorization' ? longReason : status, status));
        await paint();
        const doc = frame.contentDocument;
        check(doc.querySelectorAll('.approval-state-note').length === 4, 'no stale/duplicate notes');
        const resumes = [...doc.querySelectorAll('.draft-run-actions button, .draft-chip-actions button')].filter(b => !b.dataset.draftRunAction && !b.dataset.editAction);
        check(resumes.length === (status === 'denied' || status === 'pending' ? 0 : 4), 'state-specific buttons');
        if (status === 'needs_authorization') {
          const host = frame.contentWindow.fixtureMessages; host.length = 0;
          resumes.forEach(b => b.click());
          check(host.length === 4 && host.every(m => m.type === 'resumeApprovalProcessing'), 'authorization messages');
          check(['single', 'batch-A', 'batch-B', 'edit'].every(id => host.some(m => m.authorizeTargetId === id)), 'exact target IDs');
        }
      }
      output.textContent = JSON.stringify({ passed: results.length, cardMeasurements: results.length * 4, userAgent: navigator.userAgent,
        scaleMethod: 'CSS zoom (not native VS Code zoom)', results }, null, 2);
      document.querySelector('#summary').textContent = 'PASS: ' + results.length + ' layouts; ' + results.length * 4 + ' card measurements; dynamic updates and synthetic clicks.';
      await show(380, 'zh-CN', 'model_review', longReason, 1);
    } catch (error) {
      document.querySelector('#summary').textContent = 'FAIL: ' + error.message;
      output.textContent = JSON.stringify({ passedBeforeFailure: results.length, error: error.stack, lastPassed: results.at(-1) }, null, 2);
    }
  };
  document.querySelector('#preview').onclick = () => show(Number(document.querySelector('#width').value), document.querySelector('#language').value,
    'model_review', reasons[Number(document.querySelector('#reason').value)], Number(document.querySelector('#scale').value));
  frame.onload = () => show(380, 'zh-CN', 'model_review', longReason, 1);
}
const page = `<!doctype html><meta charset="utf-8"><title>KeepSeek approval layout verification</title>
<style>body{font:14px system-ui;background:#eee;color:#111}iframe{border:0;height:1600px;display:block}pre{white-space:pre-wrap;max-height:300px;overflow:auto}button,select{margin:4px}</style>
<p id="summary">Synthetic Host; no commands or edits can execute. Actual generated Webview below.</p>
<button id="matrix">Run layout matrix</button>
<label>Width<select id="width">${[320,379,380,480,600,920].map(w=>`<option ${w===380?'selected':''}>${w}</option>`).join('')}</select></label>
<label>Language<select id="language"><option>zh-CN</option><option>en</option></select></label>
<label>Reason<select id="reason"><option value="0">short</option><option value="1" selected>bilingual</option><option value="2">URI</option><option value="3">unbroken</option></select></label>
<label>CSS zoom<select id="scale"><option>1</option><option>1.25</option><option>1.5</option></select></label>
<button id="preview">Preview</button><details><summary>Measurements</summary><pre></pre></details>
<iframe title="Actual KeepSeek Webview" srcdoc="${webview.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe><script>(${client.toString()})()</script>`;
const destination = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'keepseek-approval-card-layout.html'));
fs.writeFileSync(destination, page);
console.log(destination);
