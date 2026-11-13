// Run after `bun run build:test`, then open the printed HTML file in a browser.
// Production HTML, CSS and script; simulated VS Code defaults and a side-effect-free Host.
// Add ?run=1 to run the matrix automatically. Read window.keepseekLayoutResult or #layoutResult.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
require('../out-test/test/registerVscodeStub');
const { getHtmlForWebview } = require('../out-test/src/webview/html');
const { Uri } = require('../out-test/test/stubs/vscode');

// VS Code contributes this padding before the extension's own stylesheet. A plain
// browser preview without it cannot reproduce the original 20px-per-side defect.
const hostDefaults = '@layer vscode-default { body { margin: 0; padding: 0 20px; } }';
const theme = `:root {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  --vscode-font-size: 13px; --vscode-editor-font-family: monospace;
  --vscode-editor-font-size: 12px; --vscode-foreground: #ddd;
  --vscode-editor-foreground: #ddd; --vscode-descriptionForeground: #aaa;
  --vscode-errorForeground: #f88; --vscode-sideBar-background: #202020;
  --vscode-editor-background: #181818; --vscode-input-background: #282828;
  --vscode-panel-border: #555; --vscode-button-background: #176ca4;
  --vscode-button-foreground: white; --vscode-focusBorder: #39f;
}
:root[data-fixture-theme="light"] {
  --vscode-foreground: #222; --vscode-editor-foreground: #222;
  --vscode-descriptionForeground: #666; --vscode-sideBar-background: #f5f5f5;
  --vscode-editor-background: #fff; --vscode-input-background: #fff;
  --vscode-panel-border: #bbb;
}`;
let webview = getHtmlForWebview({
  webview: { cspSource: "'self'", asWebviewUri: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E' },
  extensionUri: Uri.file(process.cwd()), language: 'zh-CN', extensionInfo: { version: 'layout-fixture' }
});
const nonce = webview.match(/script nonce="([^"]+)"/)[1];
webview = webview.replace('<style>', '<style>' + hostDefaults + theme).replace(`<script nonce="${nonce}">`, `<script nonce="${nonce}">
window.fixtureMessages = [];
window.fixtureErrors = [];
window.addEventListener('error', event => window.fixtureErrors.push(String(event.message)));
window.acquireVsCodeApi = () => ({postMessage: message => window.fixtureMessages.push(message), getState: () => null, setState: () => {}});
</script><script nonce="${nonce}">`);

function client(hostDefaults) {
  const frame = document.querySelector('iframe');
  const summary = document.querySelector('#summary');
  const output = document.querySelector('#layoutResult');
  const widths = [320, 360, 361, 480, 600, 920];
  const languages = ['zh-CN', 'en'];
  const scales = [1, 1.25, 1.5];
  const themes = ['dark', 'light'];
  let revision = 0;
  let running = false;
  const paint = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const check = (condition, label) => { if (!condition) throw new Error(label); };
  const close = (a, b, label, tolerance = 1.5) => check(Math.abs(a - b) <= tolerance, label + ': ' + a + ' vs ' + b);
  const doc = () => frame.contentDocument;
  const element = selector => {
    const node = doc().querySelector(selector);
    check(node, 'missing ' + selector);
    return node;
  };
  const rect = selector => element(selector).getBoundingClientRect();
  function receive(message) {
    frame.contentWindow.dispatchEvent(new frame.contentWindow.MessageEvent('message', { data: message }));
  }
  function sample(language) {
    const sentence = language === 'en'
      ? 'Use the available width while preserving readable text and reachable controls. '
      : '充分使用聊天区域的横向空间，同时保留正文可读性和按钮操作空间。';
    const columns = Array.from({ length: 9 }, (_, i) => 'Column ' + (i + 1));
    return {
      language, approvalMode: 'ask', activeSessionId: 'layout', isBusy: false,
      startup: { phase: 'ready', interactiveReady: true, sideEffectsReady: true },
      interaction: { sessionId: 'layout', revision: revision + 1, phase: 'idle', canEdit: true,
        canSubmit: true, canChangeContext: true, canNavigate: true, canCancel: false },
      contextFiles: [{ uri: 'file:///fixture/src/example.ts', label: 'src/example.ts', fsPath: '/fixture/src/example.ts' }],
      backgroundRun: { id: 'layout-background', sessionId: 'layout', status: 'completed', goal: { script: 'test' },
        progress: { round: 1, toolCalls: 2 }, limits: { maxRounds: 5 } },
      messages: [
        { id: 'long-user', role: 'user', content: sentence.repeat(5), createdAt: '2026-11-10T00:00:00Z' },
        { id: 'assistant', role: 'assistant', createdAt: '2026-11-10T00:00:01Z', content:
          sentence.repeat(3) + '\n\n```typescript\nconst longLine = "' + 'unbroken-'.repeat(75) + '";\n```\n\n'
          + '| ' + columns.join(' | ') + ' |\n| ' + columns.map(() => '---').join(' | ') + ' |\n| '
          + columns.map(() => 'Long cell value').join(' | ') + ' |\n\n' + sentence.repeat(8) }
      ],
      draftRuns: [], changeSets: [], approvalProcessing: null
    };
  }
  async function show(width, language, scale, themeName) {
    // A root CSS zoom does not resize vw/vh or media queries like browser zoom.
    // Resize the actual CSS viewport, then scale only the outer preview surface.
    frame.style.width = (width / scale) + 'px';
    frame.style.height = (960 / scale) + 'px';
    frame.style.transform = 'scale(' + scale + ')';
    doc().documentElement.dataset.fixtureTheme = themeName;
    receive({ type: 'state', revision: ++revision, state: sample(language) });
    await paint();
  }
  function inside(selector, width, scale, allowsHorizontalScroll = false) {
    const node = element(selector);
    const bounds = node.getBoundingClientRect();
    check(bounds.width > 0 && bounds.height > 0, selector + ' visible');
    check(bounds.left >= -1.5 && bounds.right <= width + 1.5, selector + ' within viewport: ' + bounds.left + '..' + bounds.right);
    check(allowsHorizontalScroll || node.scrollWidth <= node.clientWidth + 1, selector + ' does not horizontally overflow');
    return { left: bounds.left / scale, right: bounds.right / scale, width: bounds.width / scale };
  }
  function measure(width, scale) {
    const style = node => frame.contentWindow.getComputedStyle(node);
    check(parseFloat(style(doc().body).paddingLeft) === 0 && parseFloat(style(doc().body).paddingRight) === 0,
      'body clears injected VS Code 20px padding');
    const shell = rect('.shell');
    close(shell.left, 0, 'shell starts at viewport');
    close(shell.width, width, 'shell occupies full viewport');
    const gutter = frame.contentWindow.matchMedia('(max-width: 360px)').matches ? 4 : 6;
    const header = element('.header');
    close(parseFloat(style(header).paddingLeft), gutter, 'header left gutter');
    close(parseFloat(style(header).paddingRight), gutter, 'header right gutter');
    const composer = inside('.composer-input-inner', width, scale);
    close(composer.left, gutter, 'composer single left gutter');
    close((width / scale) - composer.right, gutter, 'composer single right gutter');
    const assistant = inside('.message.assistant .message-body', width, scale);
    close(assistant.left, gutter, 'assistant single left gutter');
    const transcript = element('.transcript');
    const scrollbar = (transcript.offsetWidth - transcript.clientWidth) * scale;
    close((width / scale) - assistant.right, gutter + scrollbar / scale, 'assistant right gutter plus scrollbar');
    if (frame.contentWindow.matchMedia('(max-width: 600px)').matches) {
      close(rect('.message.user .message-body').width / scale, rect('.message.user').width / scale,
        'long user message uses available narrow width');
    }
    close(parseFloat(style(element('#contextBarOuter')).paddingLeft), gutter, 'context gutter');
    close(rect('#backgroundRegion').left / scale, gutter, 'background gutter');
    const code = inside('.message-code-block', width, scale);
    close(code.left, assistant.left, 'code aligned with assistant');
    close(code.width, assistant.width, 'code uses assistant width');
    const pre = element('.message-code-block pre');
    check(pre.scrollWidth > pre.clientWidth, 'long code scrolls locally');
    const table = inside('.message-table-wrap', width, scale, true);
    close(table.width, assistant.width, 'table uses assistant width');
    const tableNode = element('.message-table-wrap');
    check(style(tableNode).overflowX === 'auto', 'table owns horizontal scrolling');
    check(doc().documentElement.scrollWidth <= doc().documentElement.clientWidth + 1, 'document has no horizontal overflow');
    check(doc().body.scrollWidth <= doc().body.clientWidth + 1, 'body has no horizontal overflow');
    for (const selector of ['#referenceMenuButton', '#commandMenuButton', '#executionModeButton', '#sendButton']) {
      const button = element(selector);
      const bounds = button.getBoundingClientRect();
      check(bounds.width / scale >= 24 && bounds.height / scale >= 24, selector + ' retains click target');
      check(bounds.left >= 0 && bounds.right <= width + 1.5, selector + ' reachable');
      button.focus();
      check(doc().activeElement === button || button.disabled, selector + ' focusable when enabled');
    }
    return { gutter, composer, assistant, code, table, scrollbar: scrollbar / scale };
  }
  function assertToolbarClear(label) {
    const input = rect('#promptInput');
    const toolbar = rect('.composer-toolbar');
    const composer = rect('.composer-input-inner');
    close(toolbar.height, 30, label + ': toolbar retains 30px');
    check(input.bottom <= toolbar.top + 0.5, label + ': text does not overlap toolbar');
    for (const selector of ['#referenceMenuButton', '#commandMenuButton', '#executionModeButton', '#sendButton']) {
      const button = rect(selector);
      check(button.top >= input.bottom - 0.5 && button.bottom <= composer.bottom - 0.5,
        label + ': ' + selector + ' stays below text and inside input border');
      check(button.height >= 24 && button.width >= 24, label + ': ' + selector + ' retains click target');
    }
  }
  function assertCommandMenuAnchor(label) {
    const menu = rect('#commandMenu');
    const toolbar = rect('.composer-toolbar');
    const gap = toolbar.top - menu.bottom;
    check(menu.top >= 2 && menu.bottom <= doc().documentElement.clientHeight - 2,
      label + ': command menu stays inside vertical viewport');
    check(gap >= 0 && gap <= 8, label + ': command menu clears toolbar with a small gap: ' + gap);
    for (const selector of ['#referenceMenuButton', '#commandMenuButton', '#executionModeButton', '#sendButton']) {
      check(menu.bottom <= rect(selector).top, label + ': command menu does not cover ' + selector);
    }
    return gap;
  }
  function inputEvent() {
    element('#promptInput').dispatchEvent(new frame.contentWindow.InputEvent('input', {
      bubbles: true, inputType: 'insertText'
    }));
  }
  async function enterPrompt(text) {
    // Exercise the production contenteditable input listener, including sanitizing,
    // autogrow, scroll restoration and send-button state; never submit to the Host.
    element('#promptInput').textContent = text;
    inputEvent();
    await paint();
  }
  async function verticalMeasurements() {
    const viewportHeight = doc().documentElement.clientHeight;
    const shell = rect('.shell');
    const header = rect('.header');
    close(shell.top, 0, 'shell touches Webview top');
    close(shell.bottom, viewportHeight, 'shell fills Webview height');
    close(header.top, 0, 'header touches Webview top');
    close(header.height, 30, 'header is 30px including border and padding');
    close(shell.bottom - rect('.composer-input-inner').bottom, 2, 'composer single bottom inset');
    const transcript = element('.transcript');
    transcript.scrollTop = 0;
    const topInset = rect('.message').top - rect('.transcript').top;
    close(topInset, 2, 'first message starts 2px inside transcript');
    const messages = [...doc().querySelectorAll('.message')];
    check(messages.length >= 2, 'fixture has adjacent messages');
    const messageGaps = messages.slice(1).map((message, index) => {
      const gap = message.getBoundingClientRect().top - messages[index].getBoundingClientRect().bottom;
      close(gap, 8, 'adjacent messages have 8px spacing');
      return gap;
    });
    transcript.scrollTop = transcript.scrollHeight;
    const bottomInset = rect('.transcript').bottom - messages.at(-1).getBoundingClientRect().bottom;
    close(bottomInset, 4, 'last message ends 4px inside transcript');

    await enterPrompt('');
    const emptyInput = rect('#promptInput').height;
    const emptyComposer = rect('.composer-input-inner').height;
    close(emptyInput, 44, 'empty editor keeps two-line 44px minimum');
    close(emptyComposer, 76, 'empty composer has no extra parent minimum height');
    check(element('#sendButton').disabled, 'empty prompt cannot submit');
    assertToolbarClear('empty prompt');
    await enterPrompt('A short prompt');
    close(rect('#promptInput').height, emptyInput, 'short prompt retains compact editor');
    close(rect('.composer-input-inner').height, emptyComposer, 'short prompt retains compact composer');
    check(!element('#sendButton').disabled, 'nonempty ready prompt can submit');

    await enterPrompt('Autogrow line\n'.repeat(80));
    const prompt = element('#promptInput');
    const longInput = rect('#promptInput').height;
    const longComposer = rect('.composer-input-inner').height;
    close(longInput, 200, 'long prompt grows to the existing 200px limit');
    close(longComposer, 232, 'long composer grows naturally around editor and toolbar');
    check(prompt.scrollHeight > prompt.clientHeight + 100, 'long prompt has local vertical scrolling');
    check(frame.contentWindow.getComputedStyle(prompt).overflowY === 'auto', 'editor owns vertical scrolling');
    close(shell.bottom - rect('.composer-input-inner').bottom, 2, 'long input preserves bottom inset');
    assertToolbarClear('long prompt');
    prompt.scrollTop = prompt.scrollHeight - prompt.clientHeight;
    const previousScrollTop = prompt.scrollTop;
    prompt.append(doc().createTextNode('Continued typing'));
    inputEvent();
    await paint();
    check(prompt.scrollTop >= previousScrollTop - 1.5, 'typing at the end preserves editor scroll position');
    close(rect('#promptInput').height, 200, 'continued typing preserves maximum editor height');
    element('#commandMenuButton').click();
    await paint();
    const longMenuGap = assertCommandMenuAnchor('long prompt');
    element('#commandMenuButton').click();

    await enterPrompt('');
    close(rect('#promptInput').height, 44, 'clearing text shrinks editor to 44px');
    close(rect('.composer-input-inner').height, 76, 'clearing text shrinks composer to 76px');
    close(prompt.scrollTop, 0, 'cleared editor has no stale scroll offset');
    check(element('#sendButton').disabled, 'cleared prompt disables submit again');
    check(prompt.getAttribute('contenteditable') === 'true', 'editor remains editable after autogrow and shrink');
    assertToolbarClear('cleared prompt');
    check(!(frame.contentWindow.fixtureMessages || []).some(message => message.type === 'sendPrompt'),
      'layout fixture never submits prompts');
    return { headerHeight: header.height, topInset, bottomInset, messageGaps,
      emptyInput, emptyComposer, longInput, longComposer, longMenuGap };
  }
  async function interactionMeasurements(width, scale) {
    const results = {};
    element('#commandMenuButton').click();
    await paint();
    results.commandMenu = inside('#commandMenu', width, scale);
    const input = rect('.composer-input-inner');
    const menu = rect('#commandMenu');
    close(menu.left, input.left, 'command menu has no second gutter');
    close(menu.right, input.right, 'command menu aligns input right');
    results.commandMenuToolbarGap = assertCommandMenuAnchor('compact prompt');
    element('#commandMenuButton').click();
    element('#referenceMenuButton').click();
    await paint();
    results.referenceMenu = inside('#referenceMenu', width, scale);
    const reference = rect('#referenceMenu');
    close(reference.left, input.left, 'reference menu has no second gutter');
    close(reference.right, input.right, 'reference menu aligns input right');
    const referenceGap = input.top - reference.bottom;
    check(referenceGap >= 2 && referenceGap <= 8, 'reference menu clears complete input with a small gap: ' + referenceGap);
    check(reference.top >= 2, 'reference menu stays inside vertical viewport');
    results.referenceMenuInputGap = referenceGap;
    element('#referenceMenuButton').click();
    element('#executionModeButton').click();
    await paint();
    results.executionModeMenu = inside('#executionModeMenu', width, scale);
    element('#executionModeButton').click();
    element('#settingsTab').click();
    await paint();
    results.settingsMenu = inside('#settingsMenu', width, scale);
    close(rect('#settingsMenu').top - rect('.header').bottom, 2, 'settings menu follows header with 2px inset');
    element('#settingsTab').click();
    element('#historyTab').click();
    await paint();
    results.historyMenu = inside('#sessionMenu', width, scale);
    close(rect('#sessionMenu').top - rect('.header').bottom, 2, 'history menu follows header with 2px inset');
    close(rect('#sessionMenu').left, input.left, 'history menu fills available width from the input left edge');
    close(rect('#sessionMenu').right, input.right, 'history menu fills available width to the input right edge');
    element('#historyTab').click();
    receive({ type: 'showSettingsDialog', sources: [{ id: 'fixture', name: 'Layout fixture', provider: 'openai-compatible',
      apiKey: '', baseUrl: 'https://example.invalid/v1', models: [{ id: 'fixture-model', name: 'Fixture model' }] }], selectedSourceId: 'fixture' });
    await paint();
    results.accountDialog = inside('#settingsDialogOverlay .settings-dialog', width, scale);
    element('#settingsCancelBtn').click();
    element('[data-message-id="long-user"][data-message-action="edit"]').click();
    await paint();
    results.edit = inside('.message.is-editing .message-body', width, scale);
    const available = rect('.message.is-editing').width / scale;
    if (frame.contentWindow.matchMedia('(max-width: 600px)').matches) {
      close(results.edit.width, available, 'narrow edit uses available width');
      close(rect('.message-edit-form').width / scale, available, 'narrow edit form has no fixed 520px cap');
    }
    element('[data-message-action="cancel-edit"]').click();
    check((frame.contentWindow.fixtureErrors || []).length === 0, 'production script has no errors');
    return results;
  }
  async function runMatrix() {
    if (running) return;
    running = true;
    const results = [];
    let current;
    summary.textContent = 'Running production Webview layout matrix…';
    try {
      for (const width of widths) for (const language of languages) for (const scale of scales) for (const themeName of themes) {
        current = { width, language, scale, theme: themeName };
        await show(width, language, scale, themeName);
        const viewportWidth = doc().documentElement.clientWidth;
        const layout = measure(viewportWidth, 1);
        const vertical = await verticalMeasurements();
        const interactions = await interactionMeasurements(viewportWidth, 1);
        results.push({ ...current, viewportWidth, layout, vertical, interactions });
        summary.textContent = 'Running… ' + results.length + '/72';
      }
      window.keepseekLayoutResult = { passed: true, layouts: results.length, userAgent: navigator.userAgent,
        scaleMethod: 'Scaled iframe with CSS viewport width/scale and height/scale (not native VS Code zoom)', hostDefaults, results };
      summary.textContent = 'PASS: ' + results.length + ' production layouts with injected VS Code defaults.';
    } catch (error) {
      window.keepseekLayoutResult = { passed: false, passedLayouts: results.length, current,
        error: error.stack, userAgent: navigator.userAgent, results };
      summary.textContent = 'FAIL: ' + error.message;
    }
    output.textContent = JSON.stringify(window.keepseekLayoutResult, null, 2);
    running = false;
  }
  window.runKeepseekLayoutMatrix = runMatrix;
  document.querySelector('#matrix').onclick = runMatrix;
  document.querySelector('#preview').onclick = () => show(Number(document.querySelector('#width').value),
    document.querySelector('#language').value, Number(document.querySelector('#scale').value), document.querySelector('#theme').value);
  frame.onload = async () => {
    await show(600, 'zh-CN', 1, 'dark');
    window.keepseekLayoutReady = true;
    if (new URL(location.href).searchParams.get('run') === '1') runMatrix();
  };
}
const page = `<!doctype html><meta charset="utf-8"><title>KeepSeek Webview layout verification</title>
<style>body{font:14px system-ui;background:#eee;color:#111}iframe{border:0;height:960px;display:block;transform-origin:top left}pre{white-space:pre-wrap;max-height:300px;overflow:auto}button,select{margin:4px}</style>
<p id="summary">Production Webview with injected VS Code body padding and synthetic Host; no external requests or workspace operations can execute.</p>
<button id="matrix">Run layout matrix</button>
<label>Width<select id="width">${[320,360,361,480,600,920].map(w=>`<option ${w===600?'selected':''}>${w}</option>`).join('')}</select></label>
<label>Language<select id="language"><option>zh-CN</option><option>en</option></select></label>
<label>Preview scale<select id="scale"><option>1</option><option>1.25</option><option>1.5</option></select></label>
<label>Theme<select id="theme"><option>dark</option><option>light</option></select></label>
<button id="preview">Preview</button><details><summary>Measurements</summary><pre id="layoutResult"></pre></details>
<iframe title="Actual KeepSeek Webview" srcdoc="${webview.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe><script>(${client.toString()})(${JSON.stringify(hostDefaults)})</script>`;
const destination = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'keepseek-webview-layout.html'));
fs.writeFileSync(destination, page);
console.log(destination);
