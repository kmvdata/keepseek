import { createContext, Script } from 'node:vm';
import { getScript } from '../src/webview/script';
import { getTemplate } from '../src/webview/template';

/** Minimal DOM for executing the complete generated script, including its input IIFE. */
class WebviewNode {
  [key: string]: any;
  nodeType: number;
  tagName: string;
  childNodes: WebviewNode[] = [];
  parentNode: WebviewNode | null = null;
  dataset: Record<string, string> = {};
  attributes: Array<{ name: string; value: string }> = [];
  listeners = new Map<string, Array<(event: any) => void>>();
  style = { setProperty() {}, removeProperty() {}, height: '' };
  scrollTop = 0;
  scrollHeight = 40;
  clientHeight = 40;
  clientWidth = 400;
  disabled = false;
  value = '';
  checked = false;
  open = false;
  isConnected = true;
  className = '';
  id = '';
  private text: string;
  classList = {
    contains: (value: string) => this.className.split(/\s+/u).includes(value),
    add: (...values: string[]) => { this.className = [...new Set([...this.className.split(/\s+/u).filter(Boolean), ...values])].join(' '); },
    remove: (...values: string[]) => { this.className = this.className.split(/\s+/u).filter(value => !values.includes(value)).join(' '); },
    toggle: (value: string, force?: boolean) => {
      const enabled = force ?? !this.classList.contains(value);
      if (enabled) this.classList.add(value); else this.classList.remove(value);
      return enabled;
    }
  };

  constructor(tag = '#text', text = '', private owner?: WebviewNode) {
    this.nodeType = tag === '#text' ? 3 : tag === '#fragment' ? 11 : 1;
    this.tagName = tag.toUpperCase();
    this.text = text;
    if (tag === 'template') this.content = new WebviewNode('#fragment', '', owner);
  }

  get children(): WebviewNode[] { return this.childNodes.filter(node => node.nodeType === 1); }
  get parentElement(): WebviewNode | null { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }
  get firstChild(): WebviewNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): WebviewNode | null { return this.childNodes.at(-1) ?? null; }
  get firstElementChild(): WebviewNode | null { return this.children[0] ?? null; }
  get nextSibling(): WebviewNode | null { return this.parentNode?.childNodes[(this.parentNode?.childNodes.indexOf(this) ?? -1) + 1] ?? null; }
  get nodeValue(): string { return this.text; }
  set nodeValue(value: string) { this.text = value; }
  get textContent(): string { return this.nodeType === 3 ? this.text : this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); if (value) this.append(new WebviewNode('#text', String(value), this.owner)); }
  get innerText(): string { return this.textContent; }
  set innerText(value: string) { this.textContent = value; }
  get innerHTML(): string { return this.textContent; }
  set innerHTML(value: string) { const target = this.content ?? this; target.replaceChildren(); parseHtml(String(value), target, this.owner); }

  setAttribute(name: string, value: string): void {
    value = String(value);
    const existing = this.attributes.find(attribute => attribute.name === name);
    if (existing) existing.value = value; else this.attributes.push({ name, value });
    if (name.startsWith('data-')) this.dataset[dataKey(name)] = value;
    else if (name === 'class') this.className = value;
    else if (name === 'disabled' || name === 'open') this[name] = true;
    else this[name] = value;
  }
  getAttribute(name: string): string | null {
    return name.startsWith('data-') ? this.dataset[dataKey(name)] ?? null : this.attributes.find(attribute => attribute.name === name)?.value ?? null;
  }
  hasAttribute(name: string): boolean { return this.getAttribute(name) !== null; }
  removeAttribute(name: string): void {
    this.attributes = this.attributes.filter(attribute => attribute.name !== name);
    if (name.startsWith('data-')) delete this.dataset[dataKey(name)];
  }
  append(...nodes: Array<WebviewNode | string>): void {
    for (let node of nodes) {
      if (typeof node === 'string') node = new WebviewNode('#text', node, this.owner);
      if (node.nodeType === 11) { this.append(...node.childNodes.slice()); continue; }
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  appendChild(node: WebviewNode): WebviewNode { this.append(node); return node; }
  replaceChildren(...nodes: WebviewNode[]): void { for (const node of this.childNodes) node.parentNode = null; this.childNodes = []; this.append(...nodes); }
  remove(): void { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
  contains(node: WebviewNode | null): boolean { while (node) { if (node === this) return true; node = node.parentNode; } return false; }
  matches(selector: string): boolean {
    return selector.split(',').some(raw => {
      const part = raw.trim();
      if (!part) return false;
      if (part.includes(' ')) {
        const segments = part.split(/\s+/u), last = segments.pop()!;
        if (!this.matches(last)) return false;
        for (let node = this.parentNode; node; node = node.parentNode) if (node.matches(segments.join(' '))) return true;
        return false;
      }
      const tag = part.match(/^[\w-]+/u);
      if (tag && tag[0].toUpperCase() !== this.tagName) return false;
      for (const [, value] of part.matchAll(/\.([\w-]+)/gu)) if (!this.classList.contains(value)) return false;
      const id = part.match(/#([\w-]+)/u);
      if (id && id[1] !== this.id) return false;
      for (const [, name, , value] of part.matchAll(/\[([\w-]+)(?:=(["']?)(.*?)\2)?\]/gu)) {
        if (!this.hasAttribute(name) || (value !== undefined && value !== '' && this.getAttribute(name) !== value)) return false;
      }
      return !part.includes(':checked') || this.checked;
    });
  }
  querySelectorAll(selector: string): WebviewNode[] { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector: string): WebviewNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): WebviewNode | null { for (let node: WebviewNode | null = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  addEventListener(type: string, listener: (event: any) => void): void { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
  removeEventListener(type: string, listener: (event: any) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)); }
  dispatchEvent(event: any): void {
    event.target ??= this; event.currentTarget = this;
    event.preventDefault ??= () => {}; event.stopPropagation ??= () => {};
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
  click(): void { if (!this.disabled && !this.closest('[inert]')) this.dispatchEvent({ type: 'click', target: this }); }
  focus(): void { if (this.owner) this.owner.activeElement = this; }
  blur(): void { if (this.owner) this.owner.activeElement = this.owner.body; this.dispatchEvent({ type: 'blur' }); }
  getBoundingClientRect(): object { return { left: 0, right: 400, top: 0, bottom: 40, width: 400, height: 40 }; }
  cloneNode(deep = false): WebviewNode {
    const node = new WebviewNode(this.tagName.toLowerCase(), this.text, this.owner);
    for (const attribute of this.attributes) node.setAttribute(attribute.name, attribute.value);
    if (deep) node.append(...this.childNodes.map(child => child.cloneNode(true)));
    return node;
  }
  normalize(): void {}
  scrollIntoView(): void {}
  setSelectionRange(): void {}
  showModal(): void { this.open = true; }
  close(): void { this.open = false; }
}

const dataKey = (name: string) => name.slice(5).replace(/-([a-z])/gu, (_match, value: string) => value.toUpperCase());
const decodeHtml = (value: string) => value.replace(/&nbsp;/gu, '\u00a0').replace(/&amp;/gu, '&').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"');
const voidTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
function parseHtml(html: string, parent: WebviewNode, owner?: WebviewNode): void {
  const stack = [parent];
  for (const [token] of html.matchAll(/<!--[\s\S]*?-->|<\/?[\w-]+(?:\s[^<>]*?)?\/?>|[^<]+/gu)) {
    if (token.startsWith('<!--')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (!token.startsWith('<')) { stack.at(-1)!.append(new WebviewNode('#text', decodeHtml(token), owner)); continue; }
    const tag = token.match(/^<([\w-]+)/u)?.[1];
    if (!tag) continue;
    const node = new WebviewNode(tag, '', owner);
    for (const [, name, , quoted, plain] of token.matchAll(/([\w:-]+)(?:\s*=\s*(?:(["'])([\s\S]*?)\2|([^\s>]+)))?/gu)) {
      if (name !== tag) node.setAttribute(name, decodeHtml(quoted ?? plain ?? ''));
    }
    stack.at(-1)!.append(node);
    if (!voidTags.has(node.tagName) && !token.endsWith('/>')) stack.push(node.content ?? node);
  }
}

export function createWebviewDomHarness(platform = 'MacIntel') {
  let now = 0;
  let timerSequence = 0;
  const timers = new Map<number, { at: number; interval: number; callback: () => void }>();
  const schedule = (callback: () => void, delay = 0, interval = 0) => {
    const id = ++timerSequence;
    timers.set(id, { callback, at: now + delay, interval });
    return id;
  };
  const document = new WebviewNode('document');
  document.body = new WebviewNode('body', '', document);
  document.documentElement = new WebviewNode('html', '', document);
  document.documentElement.append(document.body); document.append(document.documentElement);
  document.activeElement = document.body;
  document.getElementById = (id: string) => document.querySelector('#' + id);
  document.createElement = (tag: string) => new WebviewNode(tag, '', document);
  document.createTextNode = (text: string) => new WebviewNode('#text', text, document);
  document.createDocumentFragment = () => new WebviewNode('#fragment', '', document);
  document.createRange = () => ({ selectNodeContents() {}, collapse() {}, cloneRange() { return this; }, setStart() {}, setEnd() {}, startContainer: document.body, commonAncestorContainer: document.body });
  document.createTreeWalker = (node: WebviewNode) => {
    const nodes: WebviewNode[] = [];
    const collect = (parent: WebviewNode) => { for (const child of parent.childNodes) { nodes.push(child); collect(child); } };
    collect(node); let index = 0;
    return { nextNode: () => nodes[index++] ?? null };
  };
  parseHtml(getTemplate(), document.body, document);
  const posted: Array<Record<string, any>> = [];
  const window = new WebviewNode('window');
  window.keepseekVscode = { postMessage: (message: Record<string, any>) => posted.push(message) };
  window.keepseekBootstrapQueue = [];
  window.getSelection = () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {}, anchorNode: null });
  window.innerHeight = 900; window.innerWidth = 1400;
  const context = createContext({
    window, document, Element: WebviewNode, HTMLElement: WebviewNode, HTMLInputElement: WebviewNode,
    HTMLSelectElement: WebviewNode, HTMLButtonElement: WebviewNode, HTMLAnchorElement: WebviewNode,
    Node: Object.assign(WebviewNode, { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 }),
    NodeFilter: { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
    URL, TextEncoder, TextDecoder, performance, console, Intl,
    navigator: { platform, userAgent: 'test' },
    getComputedStyle: () => ({ lineHeight: '16px', fontSize: '14px' }),
    setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
    clearInterval: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {},
    CSS: { escape: (value: string) => value }
  });
  new Script(getScript(), { filename: 'keepseek-generated.js' }).runInContext(context);
  return {
    document, window, posted,
    state: new Script('state').runInContext(context) as Record<string, any>,
    receive: (data: unknown) => window.dispatchEvent({ type: 'message', data }),
    advance: (ms: number) => {
      const until = now + ms;
      for (let count = 0; count < 10000; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = until; return; }
        const [id, timer] = next;
        now = timer.at;
        if (timer.interval) timer.at += timer.interval; else timers.delete(id);
        timer.callback();
      }
      throw new Error('Unbounded Webview timer loop');
    },
    element: (id: string) => document.getElementById(id) as WebviewNode
  };
}
