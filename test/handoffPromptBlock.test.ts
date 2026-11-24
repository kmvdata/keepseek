import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { normalizeHandoffPromptBlock, renderGeneratedHandoffPrompt } from '../src/agent/handoffPrompt';
import { getStyles } from '../src/webview/styles';
import { getScript } from '../src/webview/script';

/** A body that already contains markdown fences: the block must render it verbatim. */
const body = [
  '## Goal',
  '',
  '```ts',
  'export const addOne = (n: number) => n + 1;',
  '```',
  '',
  '````md',
  '```nested',
  'keep this fence',
  '```',
  '````'
].join('\n');

test('a frozen prompt block is valid only while its hash matches its bytes', () => {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  assert.deepEqual(normalizeHandoffPromptBlock({ version: 1, body, bodyHash }), { version: 1, body, bodyHash });
  assert.equal(normalizeHandoffPromptBlock({ version: 2, body, bodyHash }), undefined, 'only version 1 is current');
  assert.equal(normalizeHandoffPromptBlock({ version: 1, body: '   ', bodyHash }), undefined, 'an empty body is not a block');
  assert.equal(normalizeHandoffPromptBlock({ version: 1, body, bodyHash: bodyHash.toUpperCase() }), undefined);
  assert.equal(normalizeHandoffPromptBlock({ version: 1, body, bodyHash: bodyHash.slice(1) }), undefined);
  assert.equal(normalizeHandoffPromptBlock({ version: 1, body: `${body}\n`, bodyHash }), undefined, 'a changed body invalidates the hash');
  assert.equal(normalizeHandoffPromptBlock({ version: 1, body, bodyHash: 'f'.repeat(64) }), undefined);
  assert.equal(normalizeHandoffPromptBlock(undefined), undefined);
});

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  title: string;
  type: string;
  innerHTML: string;
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  classes: string[];
  children: FakeNode[];
  append(...nodes: FakeNode[]): void;
  setAttribute(name: string, value: string): void;
  querySelector(selector: string): FakeNode | null;
  querySelectorAll(selector: string): FakeNode[];
}

function createNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    className: '',
    textContent: '',
    title: '',
    type: '',
    innerHTML: '',
    dataset: {},
    attributes: {},
    classes: [],
    children: [],
    append(...nodes: FakeNode[]) { node.children.push(...nodes); },
    setAttribute(name: string, value: string) { node.attributes[name] = value; },
    querySelector(selector: string) { return descendants(node).find(child => matches(child, selector)) ?? null; },
    querySelectorAll(selector: string) { return descendants(node).filter(child => matches(child, selector)); }
  };
  const classList = {
    add(name: string) {
      if (!node.classes.includes(name)) node.classes.push(name);
      node.className = node.classes.join(' ');
    },
    contains(name: string) { return node.classes.includes(name); }
  };
  return Object.assign(node, { classList });
}

function descendants(node: FakeNode): FakeNode[] {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function matches(node: FakeNode, selector: string): boolean {
  const button = /^button\[data-code-action="(.+)"\]$/u.exec(selector);
  if (button) return node.tagName === 'button' && node.dataset.codeAction === button[1];
  if (selector.startsWith('.')) return node.className.split(/\s+/u).includes(selector.slice(1));
  return node.tagName === selector;
}

test('the frozen prompt renders as one copyable block with the copy button in its top toolbar', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');
  const start = script.indexOf('function createMarkdownCodeBlock(');
  const end = script.indexOf('function appendMarkdownInline(', start);
  assert.ok(start >= 0 && end > start, 'the code-block helpers are still adjacent in the script');
  const createHandoffPromptCard = runInNewContext(
    [script.slice(start, end), 'createHandoffPromptCard'].join('\n'),
    { document: { createElement: (tagName: string) => createNode(tagName) }, t: (key: string) => key }
  ) as (prompt: { version: 1; body: string; bodyHash: string }) => FakeNode;

  const bodyHash = createHash('sha256').update(body).digest('hex');
  const card = createHandoffPromptCard({ version: 1, body, bodyHash });
  assert.equal(card.className, 'message-prompt-block');
  assert.equal(card.title, 'handoffPromptCopyHint');

  const blocks = card.querySelectorAll('.message-code-block');
  assert.equal(blocks.length, 1, 'the block reuses the existing code-block chrome');
  const block = blocks[0];
  assert.deepEqual(block.children.map(child => child.tagName), ['div', 'pre'], 'the block is one toolbar plus its pre');
  assert.equal(block.children[0].className, 'message-code-toolbar');
  assert.equal(card.querySelectorAll('.message-prompt-footer').length, 0, 'there is no bottom footer');

  const codes = block.querySelectorAll('code');
  assert.equal(codes.length, 1, 'the body is never re-parsed into more blocks');
  assert.equal(codes[0].className, 'language-markdown');
  assert.equal(codes[0].textContent, body, 'a copy reads exactly the frozen bytes');

  const buttons = card.querySelectorAll('button[data-code-action="copy"]');
  assert.equal(buttons.length, 1, 'the transcript copy delegation needs one copy button');
  const toolbar = block.children[0];
  assert.equal(toolbar.querySelectorAll('button[data-code-action="copy"]').length, 1, 'the button stays in the top toolbar');
  assert.equal(toolbar.children[0].className, 'message-code-language', 'the language label keeps the left slot');
  assert.deepEqual(toolbar.children.at(-1), buttons[0], 'the copy button keeps the right-hand slot');
  assert.ok(buttons[0].classList.contains('message-prompt-copy'));
});

const projectRoot = 'file:///Users/kermit/Projects/keepseek';

function fileReadRound(uri: string, fileSha256: string): NonNullable<Parameters<typeof renderGeneratedHandoffPrompt>[4]> {
  return [{
    assistantContent: null, reasoningContent: null,
    toolCalls: [{ id: 'read', type: 'function', function: { name: 'keepseek_read_workspace_file', arguments: '{}' } }],
    toolResults: [{ toolCallId: 'read', content: JSON.stringify({ ok: true, uri, fileSha256 }) }]
  }];
}

test('the frozen body is the authored prompt alone, with measured hashes only after it', () => {
  const requirement = '[$gen-prompt](builtin:gen-prompt) 修复 gen-prompt 的展示问题，改 src/webview/script.ts';
  const authored = ['## 目标', '', '修复提示词块的展示形态。', '', '## 步骤', '',
    '1. 修改 src/webview/script.ts 的 createHandoffPromptCard。'].join('\n');
  const preview = renderGeneratedHandoffPrompt(requirement, authored, 'zh-CN', [projectRoot]);
  assert.ok(preview.ok);
  assert.equal(preview.body, authored, 'the delivered bytes are exactly the authored prompt');
  for (const template of ['# 实施任务', '## 目标与工作范围', '## 明确限制', '## 已决定的方案与具体步骤',
    '## 待核实假设', '## 验收与交付物', '[$gen-prompt](builtin:gen-prompt)', '修复 gen-prompt 的展示问题']) {
    assert.ok(!preview.body.includes(template), template + ' must not enter the frozen body');
  }
  assert.equal(preview.bodyHash, createHash('sha256').update(preview.body).digest('hex'));

  // A `/draft` composer shortcut still reaches the executor: its bytes open the body.
  const draft = renderGeneratedHandoffPrompt('/draft src/a.ts\nexport const a = 1;', 'Update src/a.ts.',
    'en', [projectRoot]);
  assert.ok(draft.ok);
  assert.ok(draft.body.startsWith('Create src/a.ts with exactly this content:\n\nexport const a = 1;'), draft.body);
  assert.ok(draft.body.endsWith('Update src/a.ts.'), draft.body);
  assert.ok(!draft.body.includes('/draft '), 'the composer shortcut itself is not part of the prompt');

  // Measured hashes are an appendix after the prompt, never a preamble.
  const anchored = renderGeneratedHandoffPrompt('Goal', 'Update src/a.ts.', 'en', [projectRoot],
    fileReadRound(projectRoot + '/src/a.ts', 'b'.repeat(64)));
  assert.ok(anchored.ok);
  assert.ok(anchored.body.startsWith('Update src/a.ts.'), anchored.body);
  assert.ok(anchored.body.endsWith('## File-content SHA-256 at inspection\n\n- `./src/a.ts` — `'
    + 'b'.repeat(64) + '`'), anchored.body);
});

test('the frozen prompt block wraps like prose instead of scrolling sideways', () => {
  const styles = getStyles();
  const promptRule = /\.message-prompt-block \.message-code-block pre,\s*\n\s*\.message-prompt-block \.message-code-block code \{([^}]*)\}/u.exec(styles);
  assert.ok(promptRule, 'the frozen prompt block owns one wrap rule for pre and code');
  assert.match(promptRule[1], /white-space:\s*pre-wrap;/u);
  assert.match(promptRule[1], /overflow-wrap:\s*anywhere;/u);
  // The wrap must stay local: ordinary code blocks keep preformatted local scrolling.
  const codeRule = /\.message-code-block pre \{([^}]*)\}/u.exec(styles);
  assert.ok(codeRule, 'the ordinary code block keeps its own rule');
  assert.match(codeRule[1], /white-space:\s*pre;/u);
  assert.doesNotMatch(codeRule[1], /pre-wrap/u);
});
