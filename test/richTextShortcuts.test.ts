import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { test } from 'node:test';
import { getRichTextShortcutsScript } from '../src/webview/richTextShortcuts';

type FakeNode = FakeElement | FakeText;

class FakeText {
  readonly nodeType = 3;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  layoutHeight = 16;
  layoutTop = 0;

  constructor(public nodeValue: string) {}

  get textContent(): string { return this.nodeValue; }
}

class FakeElement {
  readonly nodeType: number;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  clientHeight = 100;
  clientTop = 0;
  layoutTop = 0;
  scrollHeight = 100;
  scrollTop = 0;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) { this.nodeType = tagName === '#FRAGMENT' ? 11 : 1; }

  get textContent(): string { return this.childNodes.map(node => node.textContent).join(''); }
  get innerText(): string { return plainText(this); }
  get innerHTML(): string { return this.childNodes.map(node => node instanceof FakeText ? node.nodeValue : `<${node.tagName}>${node.innerHTML}</${node.tagName}>`).join(''); }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes.at(-1) ?? null; }
  get isConnected(): boolean { return true; }

  append(...children: FakeNode[]): this {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }

  contains(node: FakeNode | FakeElement | null): boolean {
    let current = node;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parentNode;
    }
    return false;
  }

  focus(): void {}

  getBoundingClientRect(): { bottom: number; top: number } {
    return {
      top: this.layoutTop,
      bottom: this.layoutTop + this.clientHeight
    };
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function plainText(node: FakeNode): string {
  return node instanceof FakeText ? node.nodeValue : node.tagName === 'BR' ? '\n' : node.childNodes.map(plainText).join('');
}

function rootOf(node: FakeNode): FakeNode {
  while (node.parentNode) node = node.parentNode;
  return node;
}

function pointOffset(root: FakeNode, target: FakeNode, offset: number): number {
  if (root === target) {
    return root instanceof FakeText ? offset : root.childNodes.slice(0, offset).reduce((sum, child) => sum + plainText(child).length, 0);
  }
  let length = 0;
  for (const child of root.childNodes) {
    if (child === target || child instanceof FakeElement && child.contains(target)) return length + pointOffset(child, target, offset);
    length += plainText(child).length;
  }
  throw new Error('Point is outside fake DOM');
}

class FakeRange {
  startContainer: FakeNode | FakeElement;
  startOffset = 0;
  endContainer: FakeNode | FakeElement;
  endOffset = 0;

  constructor(initialNode: FakeNode | FakeElement) {
    this.startContainer = initialNode;
    this.endContainer = initialNode;
  }

  get commonAncestorContainer(): FakeNode | FakeElement {
    const ancestors = new Set<FakeNode | FakeElement>();
    let current: FakeNode | FakeElement | null = this.startContainer;
    while (current) {
      ancestors.add(current);
      current = current.parentNode;
    }
    current = this.endContainer;
    while (current && !ancestors.has(current)) {
      current = current.parentNode;
    }
    return current ?? this.startContainer;
  }

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  setStart(node: FakeNode | FakeElement, offset: number): void {
    this.startContainer = node;
    this.startOffset = offset;
    if (this.endContainer === this.startContainer && this.endOffset < offset) {
      this.endOffset = offset;
    }
  }

  setEnd(node: FakeNode | FakeElement, offset: number): void {
    this.endContainer = node;
    this.endOffset = offset;
  }

  collapse(toStart: boolean): void {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }

  selectNodeContents(node: FakeElement): void {
    this.startContainer = node;
    this.startOffset = 0;
    this.endContainer = node;
    this.endOffset = node.childNodes.length;
  }

  cloneRange(): FakeRange {
    const clone = new FakeRange(this.startContainer);
    clone.startOffset = this.startOffset;
    clone.endContainer = this.endContainer;
    clone.endOffset = this.endOffset;
    return clone;
  }

  getBoundingClientRect(): { bottom: number; top: number } {
    const top = this.startContainer.layoutTop;
    const height = this.startContainer instanceof FakeText
      ? this.startContainer.layoutHeight
      : 16;
    return { top, bottom: top + height };
  }

  getClientRects(): Array<{ bottom: number; top: number }> {
    return [this.getBoundingClientRect()];
  }

  toString(): string {
    const root = rootOf(this.startContainer);
    return plainText(root).slice(pointOffset(root, this.startContainer, this.startOffset), pointOffset(root, this.endContainer, this.endOffset));
  }

  deleteContents(): void {
    const root = rootOf(this.startContainer);
    const start = pointOffset(root, this.startContainer, this.startOffset);
    const end = pointOffset(root, this.endContainer, this.endOffset);
    let offset = 0;
    const visit = (node: FakeNode) => {
      if (node instanceof FakeText) {
        const value = node.nodeValue;
        const from = Math.max(0, start - offset);
        const to = Math.min(value.length, end - offset);
        if (from < to) node.nodeValue = value.slice(0, from) + value.slice(to);
        offset += value.length;
      } else if (node.tagName === 'BR') {
        if (start <= offset && end > offset && node.parentNode) {
          node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
          node.parentNode = null;
        }
        offset += 1;
      } else {
        for (const child of node.childNodes.slice()) visit(child);
      }
    };
    visit(root);
    this.collapse(true);
  }

  insertNode(node: FakeNode): void {
    let parent: FakeElement;
    let index: number;
    if (this.startContainer instanceof FakeText) {
      const textNode = this.startContainer;
      parent = textNode.parentNode!;
      index = parent.childNodes.indexOf(textNode) + 1;
      const suffix = new FakeText(textNode.nodeValue.slice(this.startOffset));
      suffix.parentNode = parent;
      textNode.nodeValue = textNode.nodeValue.slice(0, this.startOffset);
      parent.childNodes.splice(index, 0, suffix);
    } else {
      parent = this.startContainer;
      index = this.startOffset;
    }
    const nodes = node instanceof FakeElement && node.nodeType === 11 ? node.childNodes.splice(0) : [node];
    for (const child of nodes) child.parentNode = parent;
    parent.childNodes.splice(index, 0, ...nodes);
  }

  setStartAfter(node: FakeNode): void { this.setStart(node.parentNode!, node.parentNode!.childNodes.indexOf(node) + 1); }
  setEndAfter(node: FakeNode): void { this.setEnd(node.parentNode!, node.parentNode!.childNodes.indexOf(node) + 1); }
}

class FakeSelection {
  anchorNode: FakeNode | FakeElement | null = null;
  anchorOffset = 0;
  focusNode: FakeNode | FakeElement | null = null;
  focusOffset = 0;
  rangeCount = 0;
  modifyHandler: ((alter: string, direction: string, granularity: string) => void) | null = null;

  get isCollapsed(): boolean {
    return this.anchorNode === this.focusNode && this.anchorOffset === this.focusOffset;
  }

  getRangeAt(): FakeRange {
    if (!this.anchorNode || !this.focusNode || !this.rangeCount) {
      throw new Error('Selection has no range');
    }
    const range = new FakeRange(this.anchorNode);
    range.startOffset = this.anchorOffset;
    range.endContainer = this.focusNode;
    range.endOffset = this.focusOffset;
    const root = rootOf(this.anchorNode);
    if (root === rootOf(this.focusNode) && pointOffset(root, this.anchorNode, this.anchorOffset) > pointOffset(root, this.focusNode, this.focusOffset)) {
      range.startContainer = this.focusNode;
      range.startOffset = this.focusOffset;
      range.endContainer = this.anchorNode;
      range.endOffset = this.anchorOffset;
    }
    return range;
  }

  removeAllRanges(): void {
    this.anchorNode = null;
    this.focusNode = null;
    this.rangeCount = 0;
  }

  addRange(range: FakeRange): void {
    this.anchorNode = range.startContainer;
    this.anchorOffset = range.startOffset;
    this.focusNode = range.endContainer;
    this.focusOffset = range.endOffset;
    this.rangeCount = 1;
  }

  setBaseAndExtent(
    anchorNode: FakeNode | FakeElement,
    anchorOffset: number,
    focusNode: FakeNode | FakeElement,
    focusOffset: number
  ): void {
    this.anchorNode = anchorNode;
    this.anchorOffset = anchorOffset;
    this.focusNode = focusNode;
    this.focusOffset = focusOffset;
    this.rangeCount = 1;
  }

  modify(alter: string, direction: string, granularity: string): void {
    this.modifyHandler?.(alter, direction, granularity);
  }

  toString(): string { return this.rangeCount ? this.getRangeAt().toString() : ''; }
}

interface ShortcutHarness {
  controller: {
    handleKeydown(event: Record<string, unknown>): boolean;
    deactivateMark(): void;
    isMarkActive(): boolean;
    runCommand(command: string): boolean;
    canRunCommand(command: string): boolean;
    invalidateYank(): void;
  };
  cutSelection: (() => { anchorNode: FakeNode | FakeElement; anchorOffset: number; focusNode: FakeNode | FakeElement; focusOffset: number }) | null;
  editedCount: number;
  editor: FakeElement;
  executedCommands: string[];
  clipboard: { text: string; readError: boolean; writeError: boolean };
  contextId: string;
  posted: Array<Record<string, unknown>>;
  receive(message: Record<string, unknown>): void;
  addController(editor: FakeElement): ShortcutHarness['controller'];
  press(key: string, code: string, overrides?: Record<string, unknown>): boolean;
  selection: FakeSelection;
  setCaret(node: FakeNode | FakeElement, offset: number): void;
}

function element(tagName: string, ...children: FakeNode[]): FakeElement {
  return new FakeElement(tagName).append(...children);
}

function text(value: string): FakeText {
  return new FakeText(value);
}

function createShortcutHarness(editor: FakeElement, platform = 'Win32'): ShortcutHarness {
  const selection = new FakeSelection();
  const harness: ShortcutHarness = {
    controller: undefined as unknown as ShortcutHarness['controller'],
    cutSelection: null,
    editedCount: 0,
    editor,
    executedCommands: [],
    clipboard: { text: '', readError: false, writeError: false },
    contextId: 'session-a',
    posted: [],
    receive: () => undefined,
    addController: () => harness.controller,
    press: () => false,
    selection,
    setCaret: () => undefined
  };
  const document = {
    createRange: () => new FakeRange(editor),
    createTextNode: (value: string) => text(value),
    createElement: (tag: string) => element(tag.toUpperCase()),
    createDocumentFragment: () => element('#FRAGMENT'),
    execCommand: (command: string) => {
      harness.executedCommands.push(command);
      if (command === 'undo') {
        return true;
      }
      if (command === 'copy') { harness.clipboard.text = selection.toString(); return true; }
      if (!['cut', 'delete'].includes(command) || !selection.anchorNode || !selection.focusNode || selection.isCollapsed) {
        return false;
      }
      const snapshot = {
        anchorNode: selection.anchorNode!,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode!,
        focusOffset: selection.focusOffset
      };
      harness.cutSelection = () => snapshot;
      if (command === 'cut') harness.clipboard.text = selection.toString();
      const range = selection.getRangeAt();
      range.deleteContents();
      selection.addRange(range);
      return true;
    }
  };
  const context = createContext({
    Array,
    Date,
    Math,
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    Number,
    Object,
    Promise,
    String,
    setTimeout,
    clearTimeout,
    document,
    navigator: { platform, clipboard: {
      readText: async () => { if (harness.clipboard.readError) throw new Error('Clipboard unavailable'); return harness.clipboard.text; },
      writeText: async (value: string) => { if (harness.clipboard.writeError) throw new Error('Clipboard unavailable'); harness.clipboard.text = value; }
    } },
    vscode: { postMessage: (message: Record<string, unknown>) => { harness.posted.push(message); } }
  });
  const messageListeners: Array<(event: { data: Record<string, unknown> }) => void> = [];
  Object.assign(context, {
    window: context,
    addEventListener: (type: string, listener: (event: { data: Record<string, unknown> }) => void) => { if (type === 'message') messageListeners.push(listener); },
    getSelection: () => selection
  });
  new Script(getRichTextShortcutsScript()).runInContext(context);
  const shortcuts = (context.keepseekRichTextShortcuts as {
    createController(options: Record<string, unknown>): ShortcutHarness['controller'];
  });
  harness.receive = message => { for (const listener of messageListeners) listener({ data: message }); };
  harness.addController = target => shortcuts.createController({
    getEditor: () => target,
    getContextId: () => harness.contextId,
    isRangeInside: (range: FakeRange) => target.contains(range.commonAncestorContainer),
    isNodeInside: (node: FakeNode | FakeElement) => target.contains(node),
    setSelectionRange: (_editor: FakeElement, range: FakeRange) => selection.addRange(range),
    saveSelection: () => undefined,
    restoreSelection: () => undefined,
    getInsertionRange: () => selection.getRangeAt(),
    insertText: (_editor: FakeElement, value: string) => {
      const range = selection.getRangeAt();
      range.deleteContents();
      const inserted = text(value);
      range.insertNode(inserted);
      range.setStartAfter(inserted);
      range.collapse(true);
      selection.addRange(range);
      harness.editedCount += 1;
    },
    onSelectionChanged: () => undefined,
    onEdited: () => { harness.editedCount += 1; }
  });
  harness.controller = harness.addController(editor);
  harness.setCaret = (node, offset) => {
    const range = new FakeRange(node);
    range.startOffset = offset;
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  harness.press = (key, code, overrides = {}) => {
    return harness.controller.handleKeydown({
      key,
      code,
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      ...overrides
    });
  };
  return harness;
}

const metaModifier = { ctrlKey: false, altKey: true };

async function settleClipboard(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

for (const platform of ['Win32', 'Linux x86_64', 'MacIntel']) {
  test(`${platform} uses the same Emacs kill, copy, yank and yank-pop bindings`, async () => {
    const content = text('red blue');
    const editor = element('DIV', content);
    const harness = createShortcutHarness(editor, platform);
    let prevented = 0;
    let stopped = 0;
    const handledEvent = {
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; }
    };

    harness.selection.setBaseAndExtent(content, 0, content, 3);
    assert.equal(harness.press(platform === 'MacIntel' ? '∑' : 'w', 'KeyW', { ...metaModifier, ...handledEvent }), true);
    assert.equal(editor.textContent, 'red blue');
    harness.selection.setBaseAndExtent(content, 4, content, 8);
    assert.equal(harness.press('w', 'KeyW', handledEvent), true);
    assert.equal(editor.textContent, 'red ');
    assert.equal(harness.press('y', 'KeyY', handledEvent), true);
    await settleClipboard();
    assert.equal(harness.clipboard.text, 'blue');
    assert.equal(editor.textContent, 'red blue');
    assert.equal(harness.controller.canRunCommand('yank-pop'), true);
    assert.equal(harness.press(platform === 'MacIntel' ? '¥' : 'y', 'KeyY', { ...metaModifier, ...handledEvent }), true);
    assert.equal(editor.textContent, 'red red');
    assert.equal(harness.press('y', 'KeyY', { ...metaModifier, ...handledEvent }), true);
    assert.equal(editor.textContent, 'red blue');
    assert.equal(prevented, 5);
    assert.equal(stopped, 5);
  });

  test(`${platform} restores Emacs Ctrl+V page-down and does not claim Ctrl/Cmd+X/C`, () => {
    const content = text('content');
    const editor = element('DIV', content);
    editor.scrollHeight = 400;
    const harness = createShortcutHarness(editor, platform);
    harness.setCaret(content, 2);
    const movements: string[][] = [];
    harness.selection.modifyHandler = (...args) => { movements.push(args); };
    assert.equal(harness.press('v', 'KeyV'), true);
    assert.deepEqual(movements, [['move', 'forward', 'page']]);
    assert.equal(editor.scrollTop, 120);
    for (const key of ['x', 'c']) {
      assert.equal(harness.press(key, 'Key' + key.toUpperCase()), false);
      assert.equal(harness.press(key, 'Key' + key.toUpperCase(), { ctrlKey: false, metaKey: true }), false);
    }
  });
}

function copyText(harness: ShortcutHarness, content: FakeText, value: string): void {
  content.nodeValue = value;
  harness.selection.setBaseAndExtent(content, 0, content, value.length);
  assert.equal(harness.controller.runCommand('copy'), true);
}

function seedRing(harness: ShortcutHarness, content: FakeText): void {
  copyText(harness, content, 'older');
  copyText(harness, content, 'newest');
}

test('kill-region and kill-ring-save preserve backward selection text and yank it at the removed region', async () => {
  const content = text('left selected right');
  const harness = createShortcutHarness(element('DIV', content));
  harness.selection.setBaseAndExtent(content, 13, content, 5);
  harness.controller.runCommand('copy');
  assert.equal(harness.clipboard.text, 'selected');
  assert.equal(harness.editor.textContent, 'left selected right');
  harness.controller.runCommand('cut');
  assert.equal(harness.editor.textContent, 'left  right');
  harness.controller.runCommand('yank');
  await settleClipboard();
  assert.equal(harness.editor.textContent, 'left selected right');
});

test('kill ring is shared by editor controllers and yank-pop replaces only the last yanked region', async () => {
  const source = text('');
  const harness = createShortcutHarness(element('DIV', source));
  seedRing(harness, source);
  const destinationText = text('left:right');
  const destination = element('DIV', destinationText);
  const second = harness.addController(destination);
  harness.setCaret(destinationText, 5);
  assert.equal(second.runCommand('yank'), true);
  await settleClipboard();
  assert.equal(destination.textContent, 'left:newestright');
  assert.equal(second.runCommand('yank-pop'), true);
  assert.equal(destination.textContent, 'left:olderright');
  assert.equal(second.runCommand('yank-pop'), true);
  assert.equal(destination.textContent, 'left:newestright');
  assert.equal(harness.controller.canRunCommand('yank-pop'), false);
});

test('yank imports externally copied text even when the local kill ring is populated', async () => {
  const content = text('');
  const editor = element('DIV', content);
  const harness = createShortcutHarness(editor);
  seedRing(harness, content);
  await settleClipboard();
  content.nodeValue = 'anchor ';
  harness.setCaret(content, content.nodeValue.length);
  harness.clipboard.text = 'outside';
  harness.controller.runCommand('yank');
  await settleClipboard();
  assert.equal(editor.textContent, 'anchor outside');
  harness.controller.runCommand('yank-pop');
  assert.equal(editor.textContent, 'anchor newest');
  harness.controller.runCommand('yank-pop');
  assert.equal(editor.textContent, 'anchor older');
});

test('failed system clipboard read falls back to the retained kill ring', async () => {
  const content = text('');
  const editor = element('DIV', content);
  const harness = createShortcutHarness(editor);
  seedRing(harness, content);
  content.nodeValue = 'anchor ';
  harness.setCaret(content, content.nodeValue.length);
  harness.clipboard.readError = true;
  harness.controller.runCommand('yank');
  await settleClipboard();
  const request = harness.posted.find(message => message.type === 'requestClipboardText');
  assert.ok(request);
  harness.receive({ type: 'clipboardText', requestId: request.requestId, text: '', error: 'Clipboard unavailable' });
  await settleClipboard();
  assert.equal(editor.textContent, 'anchor newest');
});

for (const ok of [true, false]) {
  test(`yank waits for the host clipboard write acknowledgement and retains cut text on ${ok ? 'success' : 'failure'}`, async () => {
    const content = text('selected');
    const harness = createShortcutHarness(element('DIV', content));
    harness.clipboard.writeError = true;
    harness.clipboard.text = 'stale system clipboard';
    harness.selection.setBaseAndExtent(content, 0, content, content.nodeValue.length);
    harness.controller.runCommand('cut');
    await settleClipboard();
    assert.equal(harness.editor.textContent, '');
    const request = harness.posted.find(message => message.type === 'writeClipboardText');
    assert.ok(request);
    assert.ok(request.requestId);
    harness.controller.runCommand('yank');
    await settleClipboard();
    assert.equal(harness.editor.textContent, '');
    if (ok) harness.clipboard.text = 'selected';
    harness.receive({ type: 'clipboardWriteResult', requestId: request.requestId, ok });
    await settleClipboard();
    assert.equal(harness.editor.textContent, 'selected');
    assert.equal(harness.controller.canRunCommand('yank-pop'), true);
  });
}

test('no-op mark cleanup in another editor preserves a completed yank', async () => {
  const content = text('');
  const harness = createShortcutHarness(element('DIV', content));
  seedRing(harness, content);
  const destinationText = text('');
  const destination = element('DIV', destinationText);
  const second = harness.addController(destination);
  harness.setCaret(destinationText, 0);
  second.runCommand('yank');
  await settleClipboard();
  harness.controller.deactivateMark();
  assert.equal(second.canRunCommand('yank-pop'), true);
  second.runCommand('yank-pop');
  assert.equal(destination.textContent, 'older');
});

test('kill ring retains its most recent 60 entries and cycles without growing the pasted region', async () => {
  const content = text('');
  const editor = element('DIV', content);
  const harness = createShortcutHarness(editor);
  for (let index = 0; index < 64; index += 1) copyText(harness, content, 'entry-' + index);
  content.nodeValue = '';
  harness.setCaret(content, 0);
  harness.controller.runCommand('yank');
  await settleClipboard();
  assert.equal(editor.textContent, 'entry-63');
  for (let index = 62; index >= 4; index -= 1) {
    assert.equal(harness.controller.runCommand('yank-pop'), true);
    assert.equal(editor.textContent, 'entry-' + index);
  }
  assert.equal(harness.controller.runCommand('yank-pop'), true);
  assert.equal(editor.textContent, 'entry-63');
});

test('yank-pop is unavailable before a yank and after edit, movement, cancellation or scope changes', async () => {
  for (const intervening of ['typed-key', 'move-key', 'cancel-mark', 'changed-text', 'changed-caret', 'context', 'invalidate']) {
    const content = text('');
    const editor = element('DIV', content);
    const harness = createShortcutHarness(editor);
    seedRing(harness, content);
    assert.equal(harness.controller.canRunCommand('yank-pop'), false);
    harness.setCaret(content, content.nodeValue.length);
    harness.controller.runCommand('yank');
    await settleClipboard();
    assert.equal(harness.controller.canRunCommand('yank-pop'), true);
    if (intervening === 'typed-key') harness.press('a', 'KeyA', { ctrlKey: false });
    if (intervening === 'move-key') harness.press('f', 'KeyF');
    if (intervening === 'cancel-mark') harness.press('g', 'KeyG');
    if (intervening === 'changed-text') content.nodeValue += '!';
    if (intervening === 'changed-caret') harness.setCaret(content, 0);
    if (intervening === 'context') harness.contextId = 'session-b';
    if (intervening === 'invalidate') harness.controller.invalidateYank();
    const before = editor.textContent;
    assert.equal(harness.controller.canRunCommand('yank-pop'), false, intervening);
    harness.controller.runCommand('yank-pop');
    assert.equal(editor.textContent, before, intervening);
  }
});

test('Emacs copy/yank does not expose kill history to a separate Webview runtime', async () => {
  const source = text('private text');
  const first = createShortcutHarness(element('DIV', source));
  first.selection.setBaseAndExtent(source, 0, source, source.nodeValue.length);
  first.controller.runCommand('copy');
  const content = text('');
  const second = createShortcutHarness(element('DIV', content));
  second.clipboard.text = 'external clipboard';
  second.setCaret(content, 0);
  second.controller.runCommand('yank');
  await settleClipboard();
  assert.equal(second.editor.textContent, 'external clipboard');
});

test('empty kill ring yanks the system clipboard, but a failed read or stale reply cannot edit', async () => {
  const content = text('prefix');
  const harness = createShortcutHarness(element('DIV', content));
  harness.setCaret(content, content.nodeValue.length);
  harness.clipboard.readError = true;
  harness.controller.runCommand('yank');
  await settleClipboard();
  const request = harness.posted.find(message => message.type === 'requestClipboardText');
  assert.ok(request);
  harness.receive({ type: 'clipboardText', requestId: request.requestId, text: '', error: 'Clipboard unavailable' });
  assert.equal(harness.editor.textContent, 'prefix');
  assert.equal(harness.controller.canRunCommand('yank-pop'), false);

  harness.clipboard.readError = false;
  harness.clipboard.text = 'outdated';
  harness.controller.runCommand('yank');
  harness.contextId = 'session-b';
  await settleClipboard();
  assert.equal(harness.editor.textContent, 'prefix');
});

test('Emacs clipboard shortcuts ignore IME composition and unrelated modifiers', () => {
  const content = text('selected');
  const harness = createShortcutHarness(element('DIV', content));
  harness.selection.setBaseAndExtent(content, 0, content, content.nodeValue.length);
  assert.equal(harness.press('w', 'KeyW', { isComposing: true }), false);
  assert.equal(harness.press('w', 'KeyW', { ...metaModifier, keyCode: 229 }), false);
  assert.equal(harness.press('y', 'KeyY', { ...metaModifier, metaKey: true }), false);
  assert.equal(harness.press('w', 'KeyW', { ...metaModifier, shiftKey: true }), false);
  assert.equal(harness.editor.textContent, 'selected');
  assert.deepEqual(harness.executedCommands, []);
});

test('Ctrl+A/E use BR, block, inline and text-node LF logical boundaries', () => {
  const first = text('soft wrapped text');
  const br1 = element('BR');
  const br2 = element('BR');
  const last = text('last');
  const editor = element('DIV', first, br1, br2, last);
  const harness = createShortcutHarness(editor);

  harness.setCaret(first, 5);
  harness.press('a', 'KeyA');
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 0);

  harness.setCaret(first, 5);
  harness.press('e', 'KeyE');
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 1);

  harness.setCaret(editor, 2);
  harness.press('a', 'KeyA');
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 2);
  harness.press('e', 'KeyE');
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 2);

  const lf = text('aa\nbb\ncc');
  const lfHarness = createShortcutHarness(element('DIV', lf));
  lfHarness.setCaret(lf, 4);
  lfHarness.press('a', 'KeyA');
  assert.equal(lfHarness.selection.focusNode, lf);
  assert.equal(lfHarness.selection.focusOffset, 3);
  lfHarness.setCaret(lf, 4);
  lfHarness.press('e', 'KeyE');
  assert.equal(lfHarness.selection.focusNode, lf);
  assert.equal(lfHarness.selection.focusOffset, 5);
});

test('Ctrl+A/E assign an adjacent block boundary to the following block', () => {
  const firstBlock = element('DIV', text('a'));
  const secondBlock = element('DIV', text('b'));
  const editor = element('DIV', firstBlock, secondBlock);
  const harness = createShortcutHarness(editor);

  harness.setCaret(editor, 1);
  harness.press('a', 'KeyA');
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 1);

  harness.setCaret(editor, 1);
  harness.press('e', 'KeyE');
  assert.equal(harness.selection.focusNode, secondBlock);
  assert.equal(harness.selection.focusOffset, 1);
});

test('Ctrl+A/E traverse noneditable inline references but place the caret outside them', () => {
  const left = element('SPAN', text('left'));
  const referenceText = text('ref');
  const reference = element('A', element('SPAN', referenceText));
  reference.setAttribute('contenteditable', 'false');
  const right = element('SPAN', text('right'));
  const editor = element('DIV', left, reference, right, element('BR'), text('next'));
  const harness = createShortcutHarness(editor);

  harness.setCaret(referenceText, 1);
  harness.press('a', 'KeyA');
  assert.equal(reference.contains(harness.selection.focusNode), false);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 0);

  harness.setCaret(referenceText, 1);
  harness.press('e', 'KeyE');
  assert.equal(reference.contains(harness.selection.focusNode), false);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 3);
});

test('Mark mode preserves anchor and backward selection direction for Ctrl+A/E', () => {
  const firstBlock = element('DIV', text('first'));
  const secondText = text('second');
  const secondBlock = element('DIV', secondText);
  const editor = element('DIV', firstBlock, secondBlock);
  const harness = createShortcutHarness(editor);

  harness.setCaret(secondText, 4);
  harness.press(' ', 'Space');
  harness.selection.setBaseAndExtent(secondText, 4, firstBlock.childNodes[0]!, 2);
  harness.press('a', 'KeyA');
  assert.equal(harness.selection.anchorNode, secondText);
  assert.equal(harness.selection.anchorOffset, 4);
  assert.equal(harness.selection.focusNode, firstBlock);
  assert.equal(harness.selection.focusOffset, 0);
  assert.equal(harness.selection.isCollapsed, false);

  harness.press('e', 'KeyE');
  assert.equal(harness.selection.anchorNode, secondText);
  assert.equal(harness.selection.anchorOffset, 4);
  assert.equal(harness.selection.focusNode, firstBlock);
  assert.equal(harness.selection.focusOffset, 1);
});

test('Ctrl+K selects only through the current logical line end', () => {
  const first = text('one');
  const editor = element('DIV', first, element('BR'), text('two'));
  const harness = createShortcutHarness(editor);
  harness.setCaret(first, 1);

  harness.press('k', 'KeyK');

  const cut = harness.cutSelection?.();
  assert.ok(cut);
  assert.equal(cut.anchorNode, first);
  assert.equal(cut.anchorOffset, 1);
  assert.equal(cut.focusNode, editor);
  assert.equal(cut.focusOffset, 1);
});

test('Ctrl+P/N scroll the editor just enough to keep the moved focus visible', () => {
  const upper = text('upper');
  upper.layoutTop = -16;
  const current = text('current');
  current.layoutTop = 40;
  const lower = text('lower');
  lower.layoutTop = 120;
  const editor = element('DIV', upper, current, lower);
  editor.clientHeight = 100;
  editor.scrollHeight = 400;
  const harness = createShortcutHarness(editor);

  harness.selection.modifyHandler = (_alter, direction, granularity) => {
    assert.equal(granularity, 'line');
    const target = direction === 'forward' ? lower : upper;
    harness.selection.setBaseAndExtent(target, 0, target, 0);
  };

  harness.setCaret(current, 0);
  harness.press('n', 'KeyN');
  assert.equal(editor.scrollTop, 38);

  editor.scrollTop = 100;
  harness.setCaret(current, 0);
  harness.press('p', 'KeyP');
  assert.equal(editor.scrollTop, 82);
});

test('Alt+Shift+< and Alt+Shift+> move to editor boundaries and preserve Mark anchor', () => {
  const content = text('first\nsecond\nlast');
  const editor = element('DIV', content);
  editor.clientHeight = 100;
  editor.scrollHeight = 400;
  editor.scrollTop = 180;
  const harness = createShortcutHarness(editor);

  harness.setCaret(content, 8);
  assert.equal(harness.press('¯', 'Comma', { ctrlKey: false, altKey: true, shiftKey: true }), true);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 0);
  assert.equal(editor.scrollTop, 0);

  harness.setCaret(content, 8);
  assert.equal(harness.press('˘', 'Period', { ctrlKey: false, altKey: true, shiftKey: true }), true);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 1);
  assert.equal(editor.scrollTop, 300);

  harness.setCaret(content, 8);
  harness.press(' ', 'Space');
  harness.press('<', 'Comma', { ctrlKey: false, altKey: true, shiftKey: true });
  assert.equal(harness.selection.anchorNode, content);
  assert.equal(harness.selection.anchorOffset, 8);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 0);
  harness.press('>', 'Period', { ctrlKey: false, altKey: true, shiftKey: true });
  assert.equal(harness.selection.anchorNode, content);
  assert.equal(harness.selection.anchorOffset, 8);
  assert.equal(harness.selection.focusNode, editor);
  assert.equal(harness.selection.focusOffset, 1);
});

test('Emacs boundary shortcuts ignore IME composition, unrelated punctuation and old modifiers', () => {
  const content = text('content');
  const editor = element('DIV', content);
  const harness = createShortcutHarness(editor);
  harness.setCaret(content, 3);

  assert.equal(harness.press('<', 'Comma', {
    ctrlKey: false,
    altKey: true,
    shiftKey: true,
    isComposing: true
  }), false);
  assert.equal(harness.press('>', 'Period', {
    ctrlKey: false,
    altKey: true,
    shiftKey: true,
    keyCode: 229
  }), false);
  assert.equal(harness.press('＜', 'IntlBackslash', { ctrlKey: false, altKey: true, shiftKey: true }), false);
  assert.equal(harness.press('<', 'Comma', { shiftKey: true }), false);
  assert.equal(harness.press('>', 'Period', { shiftKey: true }), false);
  assert.equal(harness.press('＿', 'Minus', { shiftKey: true }), false);
  assert.equal(harness.selection.focusNode, content);
  assert.equal(harness.selection.focusOffset, 3);
  assert.deepEqual(harness.executedCommands, []);
});

test('Ctrl+Shift+_ runs one undo through the contenteditable history', () => {
  const content = text('content');
  const harness = createShortcutHarness(element('DIV', content));
  harness.setCaret(content, 4);
  harness.press(' ', 'Space');
  assert.equal(harness.controller.isMarkActive(), true);

  assert.equal(harness.press('_', 'Minus', { shiftKey: true }), true);
  assert.deepEqual(harness.executedCommands, ['undo']);
  assert.equal(harness.editedCount, 1);
  assert.equal(harness.controller.isMarkActive(), false);
});
