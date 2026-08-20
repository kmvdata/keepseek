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
}

class FakeElement {
  readonly nodeType = 1;
  readonly childNodes: FakeNode[] = [];
  parentNode: FakeElement | null = null;
  clientHeight = 100;
  clientTop = 0;
  layoutTop = 0;
  scrollHeight = 100;
  scrollTop = 0;
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

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
}

interface ShortcutHarness {
  controller: {
    handleKeydown(event: Record<string, unknown>): boolean;
    deactivateMark(): void;
    isMarkActive(): boolean;
  };
  cutSelection: (() => { anchorNode: FakeNode | FakeElement; anchorOffset: number; focusNode: FakeNode | FakeElement; focusOffset: number }) | null;
  editedCount: number;
  editor: FakeElement;
  executedCommands: string[];
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

function createShortcutHarness(editor: FakeElement): ShortcutHarness {
  const selection = new FakeSelection();
  const harness: ShortcutHarness = {
    controller: undefined as unknown as ShortcutHarness['controller'],
    cutSelection: null,
    editedCount: 0,
    editor,
    executedCommands: [],
    press: () => false,
    selection,
    setCaret: () => undefined
  };
  const document = {
    createRange: () => new FakeRange(editor),
    execCommand: (command: string) => {
      harness.executedCommands.push(command);
      if (command === 'undo') {
        return true;
      }
      if (command !== 'cut' || !selection.anchorNode || !selection.focusNode || selection.isCollapsed) {
        return false;
      }
      harness.cutSelection = () => ({
        anchorNode: selection.anchorNode!,
        anchorOffset: selection.anchorOffset,
        focusNode: selection.focusNode!,
        focusOffset: selection.focusOffset
      });
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
    document,
    navigator: {},
    vscode: { postMessage: () => undefined }
  });
  Object.assign(context, {
    window: context,
    addEventListener: () => undefined,
    getSelection: () => selection
  });
  new Script(getRichTextShortcutsScript()).runInContext(context);
  const shortcuts = (context.keepseekRichTextShortcuts as {
    createController(options: Record<string, unknown>): ShortcutHarness['controller'];
  });
  harness.controller = shortcuts.createController({
    getEditor: () => editor,
    isRangeInside: (range: FakeRange) => editor.contains(range.commonAncestorContainer),
    isNodeInside: (node: FakeNode | FakeElement) => editor.contains(node),
    setSelectionRange: (_editor: FakeElement, range: FakeRange) => selection.addRange(range),
    saveSelection: () => undefined,
    restoreSelection: () => undefined,
    onSelectionChanged: () => undefined,
    onEdited: () => { harness.editedCount += 1; }
  });
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
