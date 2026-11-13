// 一次性迁移守卫脚本：记录 Webview 生成字节的 sha256，并列出 src/webview 之外的 UI 呈现代码归属。
// 先执行 `bun run build:test`，再执行 `node scripts/verify-ui-layer.cjs`。
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
require('../out-test/test/registerVscodeStub');
const { getScript } = require('../out-test/src/webview/script');
const { getStyles } = require('../out-test/src/webview/styles');
const { getTemplate } = require('../out-test/src/webview/template');
const { getInputScript } = require('../out-test/src/webview/input/script');
const { getInputStyles } = require('../out-test/src/webview/input/styles');
const { getInputTemplate } = require('../out-test/src/webview/input/template');
const { getHtmlForWebview } = require('../out-test/src/webview/html');
const { Uri } = require('../out-test/test/stubs/vscode');

const ROOT = path.resolve(__dirname, '..');
const FROZEN_INPUT_HASHES = {
  getInputScript: 'eb823fdf4e8ba02d6f28bdb085c5d01de38c612e39010066380d3ae31f25117f',
  getInputStyles: '6868e318f8c2fb409ded9fb9becf3a4b97a2701b08851d6fa3114197908e8604',
  getInputTemplate: '4ae8bf2c5d83421754c9c506d3e5b7eabb76c434486dd574feef7ae4b53b1311'
};

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

// nonce 与资源 URI 每次生成都不同；替换为固定占位符后再计算输出字节哈希。
function normalizedHtml() {
  const html = getHtmlForWebview({
    webview: { cspSource: 'csp:baseline', asWebviewUri: (uri) => `uri:${uri.path}` },
    extensionUri: Uri.file('/extension'),
    language: 'zh-CN',
    extensionInfo: { version: '0.0.0-baseline' }
  });
  const nonce = /nonce="([^"]+)"/u.exec(html)[1];
  return html.split(nonce).join('<nonce>');
}

const entries = {
  getScript,
  getStyles,
  getTemplate: () => getTemplate({ version: '0.0.0-baseline' }),
  getInputScript,
  getInputStyles,
  getInputTemplate,
  getHtmlForWebviewNormalized: normalizedHtml
};

const hashes = {};
for (const [name, build] of Object.entries(entries)) {
  const value = build();
  hashes[name] = { sha256: hash(value), chars: value.length };
}

const INDICATORS = [
  ['window-api', /\b(?:createStatusBarItem|showQuickPick|withProgress|showInformationMessage|showWarningMessage|showErrorMessage)\b/gu],
  ['codicon', /\$\([A-Za-z~-]+\)/gu],
  ['html-tag', /<[a-z][a-z0-9-]*[\s>]/gu],
  ['webview-message', /webview\.postMessage|postToWebview\(/gu]
];

function collectTypeScriptFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'webview') continue;
      found.push(...collectTypeScriptFiles(absolute));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.ts')) found.push(absolute);
  }
  return found;
}

const inventory = [];
for (const file of collectTypeScriptFiles(path.join(ROOT, 'src')).sort()) {
  const source = fs.readFileSync(file, 'utf8');
  const counts = {};
  for (const [label, pattern] of INDICATORS) {
    const matched = source.match(pattern);
    if (matched) counts[label] = matched.length;
  }
  if (Object.keys(counts).length) {
    inventory.push({ path: path.relative(ROOT, file), counts });
  }
}

const mismatched = Object.entries(FROZEN_INPUT_HASHES)
  .filter(([name, expected]) => hashes[name].sha256 !== expected)
  .map(([name, expected]) => ({ name, expected, actual: hashes[name].sha256 }));

process.stdout.write(`${JSON.stringify({ hashes, frozenInputMismatches: mismatched, inventory }, null, 2)}\n`);
