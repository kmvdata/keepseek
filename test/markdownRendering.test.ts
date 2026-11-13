import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebviewDomHarness } from './webviewDomHarness';

type View = ReturnType<typeof createWebviewDomHarness>;
type DomNode = ReturnType<View['element']>;

function render(content: string, role = 'assistant', isStreaming = false) {
  const view = createWebviewDomHarness();
  const message = { id: 'answer', role, content, createdAt: '', isStreaming };
  const publish = (streaming = isStreaming) => view.receive({ type: 'state', revision: streaming ? 1 : 2, state: {
    activeSessionId: 'markdown', messages: [{ ...message, isStreaming: streaming }],
    language: 'en', isBusy: streaming, startup: { interactiveReady: true, sideEffectsReady: true }
  } });
  publish();
  const contentNode = () => {
    const node = view.element('transcript').querySelector('.message-content');
    assert.ok(node);
    return node;
  };
  return { ...view, message, publish, contentNode };
}

const directChildren = (node: DomNode, tag: string) => node.children.filter(child => child.tagName === tag);
const startNumber = (node: DomNode) => Number(node.getAttribute('start') ?? 1);

const titles = [
  '新增可逆配置契约（默认保持现状开启）',
  '在 Provider 的两个自动入口加门禁（自动不再派发）',
  '配置切换时清理在途自动请求（不打断手动）',
  '补齐回归测试（守行为契约，不测内部实现）',
  '文档与验证收口'
];
const implementationPlan = '## 实施计划\n\n' + titles.map((title, index) =>
  `${index + 1}. **${title}**\n   - 在 \`src/shared/config.ts\` 中检查配置。\n   - 验收：\`bun run compile\` 通过。`
).join('\n\n');

test('Markdown implementation steps remain one ordered list across blank lines and nested bullets for user and assistant', () => {
  for (const role of ['user', 'assistant']) {
    const view = render(implementationPlan, role);
    const lists = directChildren(view.contentNode(), 'OL');
    assert.equal(lists.length, 1, 'blank lines between steps must not restart numbering');
    assert.equal(startNumber(lists[0]), 1);
    const steps = directChildren(lists[0], 'LI');
    assert.equal(steps.length, 5);
    steps.forEach((step, index) => {
      assert.equal(step.querySelector('strong')?.textContent, titles[index]);
      assert.equal(directChildren(step, 'UL').length, 1, 'nested bullets belong inside their step');
      assert.equal(directChildren(directChildren(step, 'UL')[0], 'LI').length, 2);
    });
    assert.equal(view.state.messages[0].content, implementationPlan, 'rendering preserves the original message');
  }
});

test('Markdown repeated 1 markers use normal browser counting and explicit list starts remain independent', () => {
  const repeated = render('1. first\n\n1. second\n\n1. third').contentNode();
  const repeatedLists = directChildren(repeated, 'OL');
  assert.equal(repeatedLists.length, 1);
  assert.equal(directChildren(repeatedLists[0], 'LI').length, 3);
  assert.equal(directChildren(repeatedLists[0], 'LI').some(item => item.hasAttribute('value')), false,
    'do not force every source marker onto the visible counter');

  const separated = render('3. third\n4. fourth\n\nA separate paragraph.\n\n0. zero\n1. one').contentNode();
  const lists = directChildren(separated, 'OL');
  assert.deepEqual(lists.map(startNumber), [3, 0]);
  assert.deepEqual(lists.map(list => directChildren(list, 'LI').length), [2, 2]);
  assert.equal(directChildren(separated, 'P').length, 1, 'a paragraph terminates the previous list');
});

test('Markdown lists distinguish siblings from mixed nested lists and account for multi-digit marker widths', () => {
  const content = render('9. ninth\n   - child A\n     3. nested third\n     4. nested fourth\n   - child B\n10. tenth\n    - child C\n11. eleventh').contentNode();
  const outer = directChildren(content, 'OL');
  assert.equal(outer.length, 1);
  assert.equal(startNumber(outer[0]), 9);
  const steps = directChildren(outer[0], 'LI');
  assert.equal(steps.length, 3);
  const children = directChildren(steps[0], 'UL');
  assert.equal(children.length, 1);
  assert.equal(directChildren(children[0], 'LI').length, 2);
  const nested = children[0].querySelector('ol');
  assert.ok(nested);
  assert.equal(startNumber(nested), 3);
  assert.equal(directChildren(nested, 'LI').length, 2);
  assert.equal(directChildren(steps[1], 'UL')[0].textContent, 'child C');
});

test('Markdown lightly shifted sibling markers and lazy paragraph continuations stay in the existing list', () => {
  const cases = [
    { source: '1. a\n 1. b\n 1. c', start: 1, count: 3, last: 'c' },
    { source: ' 1. a\n1. b', start: 1, count: 2, last: 'b' },
    { source: '1. a\n  continuation\n2. b', start: 1, count: 2, last: 'b', continuation: true },
    { source: '10. a\n  continuation\n 11. b\n12. c', start: 10, count: 3, last: 'c', continuation: true }
  ];
  for (const sample of cases) {
    const content = render(sample.source).contentNode();
    const lists = directChildren(content, 'OL');
    assert.equal(lists.length, 1, sample.source);
    assert.equal(startNumber(lists[0]), sample.start);
    const steps = directChildren(lists[0], 'LI');
    assert.equal(steps.length, sample.count, sample.source);
    assert.equal(steps.at(-1)?.textContent, sample.last);
    assert.equal(content.querySelectorAll('ol').length, 1, 'minor marker indentation does not create a child list');
    assert.equal(directChildren(content, 'P').length, 0, 'lazy continuation text remains in its list item');
    if (sample.continuation) assert.ok(steps[0].textContent.includes('continuation'));
  }
});

test('Markdown list items retain paragraph, fenced-code and table blocks without treating code as list structure', () => {
  const source = [
    '1. **first**', '', '   Additional paragraph.', '', '   ```text',
    '   1. literal code marker', '   - literal bullet', '', '   2. still code', '   ```', '',
    '   | Name | Value |', '   | --- | --- |', '   | a | b |', '', '2. second'
  ].join('\n');
  const content = render(source).contentNode();
  const outer = directChildren(content, 'OL');
  assert.equal(outer.length, 1);
  const steps = directChildren(outer[0], 'LI');
  assert.equal(steps.length, 2);
  assert.ok(steps[0].textContent.includes('Additional paragraph.'));
  assert.equal(steps[0].querySelector('pre code')?.textContent,
    '1. literal code marker\n- literal bullet\n\n2. still code');
  assert.equal(steps[0].querySelectorAll('ol, ul').length, 0);
  assert.equal(steps[0].querySelectorAll('table').length, 1);
});

test('Markdown marker changes, headings and rules delimit independent lists without continuing their counters', () => {
  const content = render([
    '3. third', '4. fourth', '', '5) fifth', '6) sixth', '', '- dash', '', '+ plus', '',
    '## A new section', '', '7. seventh', '', '---', '', '9. ninth'
  ].join('\n')).contentNode();
  assert.deepEqual(directChildren(content, 'OL').map(startNumber), [3, 5, 7, 9]);
  assert.deepEqual(directChildren(content, 'OL').map(list => directChildren(list, 'LI').length), [2, 2, 1, 1]);
  assert.equal(directChildren(content, 'UL').length, 2, 'a different bullet starts a separate list');
  assert.equal(directChildren(content, 'H2').length, 1);
  assert.equal(directChildren(content, 'HR').length, 1);
});

test('Markdown tab-indented children and empty list items keep their siblings and terminate normally', () => {
  const content = render('1. first\n\t- child\n\t  2. nested\n2. \n3. third\n\n-\n- final').contentNode();
  const outer = directChildren(content, 'OL');
  assert.equal(outer.length, 1);
  const steps = directChildren(outer[0], 'LI');
  assert.equal(steps.length, 3);
  const childList = directChildren(steps[0], 'UL')[0];
  assert.ok(childList);
  const nested = childList.querySelector('ol');
  assert.ok(nested);
  assert.equal(startNumber(nested), 2);
  assert.equal(nested.textContent, 'nested');
  assert.equal(steps[1].textContent, '');
  assert.equal(steps[2].textContent, 'third');
  const bullets = directChildren(content, 'UL');
  assert.equal(bullets.length, 1);
  assert.deepEqual(directChildren(bullets[0], 'LI').map(item => item.textContent), ['', 'final']);
});

test('Markdown deeply nested lists fall back to readable text while preserving the deepest body and outer sibling', () => {
  const nested = Array.from({ length: 70 }, (_, depth) =>
    '   '.repeat(depth) + '1. ' + (depth === 69 ? 'deepest body' : 'level ' + depth));
  const source = nested.join('\n') + '\n2. outside tail';
  const content = render(source).contentNode();
  const outer = directChildren(content, 'OL');
  assert.equal(outer.length, 1);
  const steps = directChildren(outer[0], 'LI');
  assert.equal(steps.length, 2);
  assert.ok(steps[0].textContent.includes('deepest body'), 'the nesting guard retains the remaining source as text');
  assert.equal(steps[1].textContent, 'outside tail');
  assert.ok(content.querySelectorAll('ol').length < 70, 'deep input uses a bounded DOM nesting depth');
});

test('Markdown stream completion and reloaded history use the same ordered-list structure', () => {
  const view = render(implementationPlan, 'assistant', true);
  assert.equal(view.contentNode().textContent, implementationPlan);
  assert.equal(view.contentNode().querySelectorAll('ol').length, 0, 'streaming keeps unparsed text');
  view.publish(false);
  const finalLists = directChildren(view.contentNode(), 'OL');
  assert.equal(finalLists.length, 1);
  assert.equal(directChildren(finalLists[0], 'LI').length, 5);
  const restored = render(implementationPlan);
  assert.equal(directChildren(directChildren(restored.contentNode(), 'OL')[0], 'LI').length, 5);
});

test('Markdown message copy button copies original source bytes after nested-list rendering', async () => {
  const source = implementationPlan.replaceAll('\n', '\r\n') + '\r\n';
  const view = render(source);
  const copied: string[] = [];
  view.document.execCommand = (command: string) => {
    assert.equal(command, 'copy');
    copied.push(view.document.querySelector('textarea[readonly]')?.value ?? '');
    return true;
  };
  // The native DOM select() method is not needed by the clipboard contract.
  const createElement = view.document.createElement;
  view.document.createElement = (tag: string) => {
    const element = createElement(tag);
    if (tag === 'textarea') element.select = () => {};
    return element;
  };
  const button = view.element('transcript').querySelector('button[data-message-action="copy"]');
  assert.ok(button);
  view.element('transcript').dispatchEvent({ type: 'click', target: button });
  await Promise.resolve();
  assert.deepEqual(copied, [source]);
  assert.equal(view.state.messages[0].content, source);
});
