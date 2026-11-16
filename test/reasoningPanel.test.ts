import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { test } from 'node:test';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getScript } from '../src/webview/script';
import { getStyles } from '../src/webview/styles';

// A minimal <details> stand-in that reproduces the two behaviors the reasoning
// panel depends on: `open` is a live attribute, and setting it fires `toggle`
// exactly like a real element so the render path cannot reintroduce auto-expand.
class DetailsElement {
  public className = '';
  public open = false;
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public children: DetailsElement[] = [];
  public textContent = '';
  private listeners: Array<(event: { target: DetailsElement }) => void> = [];

  public classList = {
    toggle: (name: string, force: boolean): void => {
      const tokens = this.className.split(/\s+/).filter(Boolean).filter((item) => item !== name);
      if (force) tokens.push(name);
      this.className = tokens.join(' ');
    }
  };
  public append(...nodes: DetailsElement[]): void { this.children.push(...nodes); }
  public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
  public addEventListener(_type: string, listener: (event: { target: DetailsElement }) => void): void {
    this.listeners.push(listener);
  }
  public querySelector(selector: string): DetailsElement | null {
    return selector === 'pre' && this.children.length > 0 ? this.children[this.children.length - 1] : null;
  }
  /** Simulate the user clicking the summary (or pressing Enter on it). */
  public userToggle(): void {
    this.open = !this.open;
    for (const listener of this.listeners) listener({ target: this });
  }
  /** Simulate the browser firing `toggle` after the script assigned `open`. */
  public fireToggle(): void {
    for (const listener of this.listeners) listener({ target: this });
  }
}

function buildPanelApi() {
  const source = getScript();
  const names = ['getReasoningKey', 'createReasoningBlock', 'syncReasoningLive'];
  const extracted = names.map((name) => extractFunction(source, name)).join('\n');
  const reasoningExpandedKeys = new Set<string>();
  const state = { activeSessionId: 'session-1' };
  const context = {
    state,
    reasoningExpandedKeys,
    document: {
      createElement: (tag: string) => {
        const element = new DetailsElement();
        (element as unknown as { tagName: string }).tagName = tag;
        return element;
      }
    },
    t: (key: string, values?: Record<string, string>) => {
      const template = WEBVIEW_TRANSLATIONS.en[key as keyof typeof WEBVIEW_TRANSLATIONS.en] ?? key;
      return String(template).replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '');
    }
  };
  const api = new Script(`${extracted}\n({ createReasoningBlock, syncReasoningLive, getReasoningKey });`)
    .runInNewContext(context) as {
      createReasoningBlock(message: Record<string, unknown>, seed?: string): DetailsElement;
      syncReasoningLive(element: DetailsElement | null, message: Record<string, unknown>, hasContent: boolean): void;
      getReasoningKey(message: Record<string, unknown>): string;
    };
  return { api, reasoningExpandedKeys };
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`missing end for ${name}`);
}

test('reasoning panel starts collapsed for streaming and finished messages alike', () => {
  const { api } = buildPanelApi();
  const streaming = api.createReasoningBlock({ id: 'm1', isStreaming: true, reasoningContent: 'thinking' });
  const finished = api.createReasoningBlock({ id: 'm2', isStreaming: false, reasoningContent: 'done' });
  assert.equal(streaming.open, false, 'a live thinking stream must not open the panel by itself');
  assert.equal(finished.open, false, 'a completed message stays collapsed');
});

test('a user collapse survives later streaming deltas and full re-renders', () => {
  const { api, reasoningExpandedKeys } = buildPanelApi();
  const message = { id: 'm1', isStreaming: true, reasoningContent: 'a' };
  const first = api.createReasoningBlock(message);

  first.userToggle();
  assert.equal(first.open, true, 'clicking the summary expands it');
  assert.equal(reasoningExpandedKeys.has(api.getReasoningKey(message)), true);

  first.userToggle();
  assert.equal(first.open, false);
  assert.equal(reasoningExpandedKeys.has(api.getReasoningKey(message)), false);

  // A delta creates no panel (it only appends text) and a full re-render rebuilds
  // the block: the collapsed choice has to win over `isStreaming`.
  message.reasoningContent = 'ab';
  const rebuilt = api.createReasoningBlock(message);
  assert.equal(rebuilt.open, false, 'streaming must not auto-expand after the user collapsed');

  // An expanded choice is also remembered.
  rebuilt.userToggle();
  const rebuiltAgain = api.createReasoningBlock(message);
  assert.equal(rebuiltAgain.open, true, 'a deliberate expansion is preserved');
});

test('programmatic open does not corrupt the remembered user choice', () => {
  const { api, reasoningExpandedKeys } = buildPanelApi();
  const message = { id: 'm1', isStreaming: true, reasoningContent: 'a' };
  const panel = api.createReasoningBlock(message);
  assert.equal(panel.open, false);
  // Nothing in the render path may assign `open`; if something did, toggle would
  // still reflect the real element state rather than a stale duplicate.
  panel.open = false;
  panel.fireToggle();
  assert.equal(reasoningExpandedKeys.has(api.getReasoningKey(message)), false);
});

test('reasoning key is scoped per session so panels never bleed across sessions', () => {
  const { api } = buildPanelApi();
  assert.equal(api.getReasoningKey({ id: 'm1' }), 'session-1|m1');
});

test('collapsed dots animate only while thinking is streaming without body text', () => {
  const { api } = buildPanelApi();
  const details = api.createReasoningBlock({ id: 'm1', isStreaming: true, reasoningContent: '' });

  api.syncReasoningLive(details, { isStreaming: true, content: '' }, false);
  assert.equal(details.className.includes('is-live'), true, 'live dots while reasoning streams');
  assert.equal(details.attributes['aria-live'], 'polite');

  api.syncReasoningLive(details, { isStreaming: true, content: '' }, true);
  assert.equal(details.className.includes('is-live'), false, 'dots stop once body text starts');

  api.syncReasoningLive(details, { isStreaming: false, content: '' }, false);
  assert.equal(details.className.includes('is-live'), false, 'dots stop when the run ends');
  assert.equal(details.attributes['aria-live'], 'off');

  details.userToggle();
  api.syncReasoningLive(details, { isStreaming: true, content: '' }, false);
  assert.equal(details.attributes['aria-live'], 'off', 'an expanded panel must not announce every chunk');
});

test('reasoning dots are paused by default, run only in live state, and respect reduced motion', () => {
  const styles = getStyles();
  assert.match(styles, /\.reasoning-dots\s*\{[^}]*animation-play-state:\s*paused/s);
  assert.match(styles, /\.reasoning-block\.is-live \.reasoning-dots\s*\{[^}]*animation-play-state:\s*running/s);
  assert.match(styles, /\.reasoning-block\[open\] \.reasoning-dots\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /@keyframes reasoning-dots-pulse/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.reasoning-dots \{ animation: none;/s);
});

test('the live thinking label no longer carries its own dots', () => {
  assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].thinkingLive, '正在思考');
  assert.equal(WEBVIEW_TRANSLATIONS.en.thinkingLive, 'Thinking');
});