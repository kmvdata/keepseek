import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { normalizeHandoffPromptBlock } from '../src/agent/handoffPrompt';
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

test('the frozen prompt renders as one copyable block with the button at its bottom-right', () => {
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
  assert.deepEqual(block.children.map(child => child.className), ['message-code-toolbar', '', 'message-prompt-footer']);

  const codes = block.querySelectorAll('code');
  assert.equal(codes.length, 1, 'the body is never re-parsed into more blocks');
  assert.equal(codes[0].className, 'language-markdown');
  assert.equal(codes[0].textContent, body, 'a copy reads exactly the frozen bytes');

  const buttons = card.querySelectorAll('button[data-code-action="copy"]');
  assert.equal(buttons.length, 1, 'the transcript copy delegation needs one copy button');
  const footer = block.children.at(-1)!;
  assert.equal(footer.className, 'message-prompt-footer', 'the button sits in the footer at the bottom-right');
  assert.deepEqual(footer.children, [buttons[0]]);
  assert.ok(buttons[0].classList.contains('message-prompt-copy'));
  assert.equal(block.children[0].querySelectorAll('button').length, 0, 'the ordinary top toolbar keeps no copy button here');
});