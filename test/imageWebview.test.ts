import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createContext, Script } from 'node:vm';
import { test } from 'node:test';
import { imageScriptFragment } from '../src/webview/input/images/script';
import { IMAGE_TRANSLATIONS } from '../src/shared/imageI18n';

class Element {
  readonly children: Element[] = [];
  readonly handlers = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  readonly classes = new Set<string>();
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly classList = {
    add: (name: string) => this.classes.add(name),
    remove: (name: string) => this.classes.delete(name),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => { if (force ?? !this.classes.has(name)) this.classes.add(name); else this.classes.delete(name); }
  };
  parentElement: Element | null = null;
  textContent = '';
  className = '';
  disabled = false;
  hidden = false;
  loading = '';
  decoding = '';
  isConnected = true;
  offsetParent: object | null = {};
  private _value = '';
  constructor(readonly tagName = 'div', readonly onFocus: (element: Element) => void = () => {}) {}
  get options() { return this.tagName === 'select' ? this.children : []; }
  get value() { return this._value; }
  set value(value: string) { this._value = this.tagName === 'select' && this.children.length && !this.children.some((child) => child.value === value) ? '' : value; }
  set innerHTML(_value: string) { this.children.length = 0; if (this.tagName === 'select') this._value = ''; }
  append(...children: Element[]) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1);
      child.parentElement = this;
      this.children.push(child);
      if (this.tagName === 'select' && !this.value) this.value = child.value;
    }
  }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  addEventListener(name: string, callback: (event: Record<string, unknown>) => void) { this.handlers.set(name, [...(this.handlers.get(name) || []), callback]); }
  dispatch(name: string, event: Record<string, unknown> = {}) {
    for (const callback of this.handlers.get(name) || []) callback({ target: this, preventDefault() {}, stopPropagation() {}, ...event });
  }
  querySelectorAll() { return this.children; }
  focus() { this.onFocus(this); }
}

function harness() {
  const elements = new Map<string, Element>();
  let saved: unknown = {};
  const messages: Record<string, unknown>[] = [];
  const state = { activeSessionId: 'session-a', language: 'en', changeSets: [] };
  const document = {
    activeElement: null as Element | null,
    getElementById(id: string) {
      let element = elements.get(id);
      if (!element) {
        element = new Element(id === 'imageModelSelect' ? 'select' : id === 'imagePromptInput' ? 'textarea' : 'div', (item) => { document.activeElement = item; });
        elements.set(id, element);
      }
      return element;
    },
    createElement(tagName: string) { return new Element(tagName); }
  };
  document.getElementById('imageDialogOverlay').classes.add('hidden');
  const transcript = new Element();
  let sequence = 0;
  const context = createContext({
    document, state, transcript,
    commandMenuButton: document.getElementById('commandMenuButton'),
    pendingChangeActions: new Map(),
    window: { crypto: { randomUUID: () => 'action-' + ++sequence } },
    vscode: { getState: () => saved, setState: (value: unknown) => { saved = value; }, postMessage: (value: Record<string, unknown>) => messages.push(value) },
    t: (key: string) => IMAGE_TRANSLATIONS.en[key as keyof typeof IMAGE_TRANSLATIONS.en] || key,
    closeCommandMenu() {}, closeReferenceMenu() {},
    setComposerStatus() {}, serializePrompt: () => 'Original chat draft',
    createChangeSetCard: () => new Element(),
    clearPrompt() { throw new Error('Image actions must preserve the chat draft'); }
  });
  new Script(imageScriptFragment.source).runInContext(context);
  const run = (code: string) => new Script(code).runInContext(context);
  const host = (value: Record<string, unknown>) => {
    context.hostMessage = value;
    run('handleImageHostMessage(hostMessage)');
  };
  run('renderImageActivities()');
  host({ type: 'imageState', sessionId: 'session-a', selectedSourceId: 'source-a', selectedModelId: 'image-model', models: [{ sourceId: 'source-a', modelId: 'image-model', available: true, sourceName: 'Explicit source' }], jobs: [] });
  return { elements, messages, state, document, run, host, saved: () => saved, transcript };
}

test('image panel preserves chat drafts, binds one submit action, and saves its own draft on close', () => {
  const h = harness();
  h.run('openImagePanel()');
  assert.equal(h.elements.get('imagePromptInput')!.value, 'Original chat draft');
  h.elements.get('imagePromptInput')!.value = 'Create a project illustration';
  h.elements.get('imageForm')!.dispatch('input');
  h.elements.get('imageForm')!.dispatch('submit');
  h.elements.get('imageForm')!.dispatch('submit');
  const submits = h.messages.filter((message) => message.type === 'imageSubmit');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].prompt, 'Create a project illustration');
  assert.equal(submits[0].sourceId, 'source-a');
  assert.equal(submits[0].inputAssetId, undefined);
  assert.equal(h.state.activeSessionId, 'session-a');
  h.run('closeImagePanel()');
  const saved = h.saved() as { imageDrafts: Record<string, { prompt: string; actionId: string }> };
  assert.equal(saved.imageDrafts['session-a'].prompt, 'Create a project illustration');
  assert.equal(saved.imageDrafts['session-a'].actionId, submits[0].actionId);
});

test('image submission rejects overlong prompts and positive unknown-cost limits without truncating', () => {
  const h = harness();
  h.run('openImagePanel()');
  const original = 'x'.repeat(32001);
  h.elements.get('imagePromptInput')!.value = original;
  h.elements.get('imageForm')!.dispatch('submit');
  assert.equal(h.messages.filter((message) => message.type === 'imageSubmit').length, 0);
  assert.equal(h.elements.get('imagePromptInput')!.value, original);
  h.host({ type: 'imageState', sessionId: 'session-a', models: [{ sourceId: 'source-a', modelId: 'image-model', available: true }], jobs: [], costLimit: 1 });
  assert.equal(h.elements.get('imageSubmitButton')!.disabled, true);
});

test('an unconfirmed action can be checked again with the exact original identity and parameters', () => {
  const h = harness();
  h.run('openImagePanel()');
  h.elements.get('imageForm')!.dispatch('submit');
  const first = h.messages.find((message) => message.type === 'imageSubmit')!;
  h.host({ type: 'imageState', sessionId: 'session-a', jobs: [] });
  assert.equal(h.elements.get('imageSubmitButton')!.disabled, false);
  assert.equal(h.elements.get('imagePromptInput')!.disabled, true);
  h.elements.get('imageForm')!.dispatch('submit');
  const submits = h.messages.filter((message) => message.type === 'imageSubmit');
  assert.equal(submits.length, 2);
  assert.deepEqual(submits[1], first);
  assert.equal(h.run('imageView.models.length'), 1, 'partial image-state feedback preserves the catalog');
  h.host({ type: 'imageSubmitFeedback', sessionId: 'session-a', actionId: first.actionId, jobId: 'j1' });
  h.run('openImagePanel()');
  h.elements.get('imageForm')!.dispatch('submit');
  const next = h.messages.filter((message) => message.type === 'imageSubmit').at(-1)!;
  assert.notEqual(next.actionId, first.actionId, 'an explicit new job may use identical parameters');
});

test('image edit sends only the selected original asset and session changes ignore late results', () => {
  const h = harness();
  h.run('openImagePanel()');
  h.host({ type: 'imageImported', sessionId: 'session-a', asset: { assetId: 'original-input', uri: 'controlled:input', fileName: 'input.png', byteLength: 40, width: 2, height: 2 } });
  assert.equal(h.elements.get('imageInputPreview')!.children[0].decoding, 'async');
  h.elements.get('imagePromptInput')!.value = 'Make the background blue';
  h.elements.get('imageForm')!.dispatch('input');
  h.elements.get('imageForm')!.dispatch('submit');
  const submit = h.messages.find((message) => message.type === 'imageSubmit')!;
  assert.equal(submit.inputAssetId, 'original-input');
  assert.equal(submit.sessionId, 'session-a');
  assert.equal(Object.keys(submit).some((key) => /base64|bytes|history/iu.test(key)), false);
  h.state.activeSessionId = 'session-b'; h.run('renderImageActivities()');
  h.host({ type: 'imageState', sessionId: 'session-a', models: [], jobs: [{ jobId: 'wrong-session', status: 'saved' }] });
  assert.equal(h.run('imageView.jobs.length'), 0);
  assert.equal(h.messages.at(-1)!.sessionId, 'session-b');
});

test('continuing an image preselects its original result while regeneration keeps the original parameters', () => {
  const h = harness();
  h.host({ type: 'imageState', sessionId: 'session-a', models: [], jobs: [{ jobId: 'j1', status: 'saved', spec: { sourceId: 's', model: 'm', prompt: 'Original', size: '1024x1024', quality: 'medium', background: 'opaque', outputFormat: 'png', inputAssets: [] }, resultAsset: { assetId: 'full-result', uri: 'controlled:original', width: 1024, height: 1024, byteLength: 999 } }] });
  assert.equal(h.run('draftFromImageJob(imageView.jobs[0], true).inputAsset.assetId'), 'full-result');
  assert.equal(h.run('draftFromImageJob(imageView.jobs[0], true).prompt'), '');
  assert.equal(h.run('draftFromImageJob(imageView.jobs[0], false).prompt'), 'Original');
  assert.equal(h.run('draftFromImageJob(imageView.jobs[0], false).parentJobId'), 'j1');
  assert.equal(h.transcript.children.length, 1);
  const region = h.elements.get('imageActivityRegion')!;
  const card = region.children.find((child) => child.tagName === 'article')!;
  const previewButton = card.children.find((child) => child.className === 'image-preview-button')!;
  assert.equal(previewButton.children[0].loading, 'lazy');
  assert.equal(previewButton.children[0].decoding, 'async');
});

test('image history replaces bounded pages, ignores stale page responses and resets on session change', () => {
  const h = harness();
  const job = (id: string) => ({ jobId: id, status: 'failed', spec: { prompt: id } });
  h.host({ type: 'imageState', sessionId: 'session-a', page: 0, totalJobs: 72, hasOlder: true, jobs: Array.from({ length: 50 }, (_, i) => job('new-' + i)) });
  const region = h.elements.get('imageActivityRegion')!;
  const nav = region.children.find((child) => child.tagName === 'nav')!;
  assert.equal(nav.children[0].disabled, true);
  assert.equal(nav.children[2].disabled, false);
  nav.children[2].dispatch('click');
  const request = h.messages.at(-1)!;
  assert.equal(request.type, 'imageStateRequest');
  assert.equal(request.page, 1);
  h.host({ type: 'imageState', sessionId: 'session-a', page: 0, totalJobs: 72, hasOlder: true, jobs: [job('late-new')] });
  assert.equal(h.run('imageView.jobs.length'), 50, 'a stale page does not replace the selected page');
  h.host({ type: 'imageState', sessionId: 'session-a', page: 1, totalJobs: 72, hasOlder: false, jobs: Array.from({ length: 22 }, (_, i) => job('older-' + i)) });
  assert.equal(h.run('imageView.jobs.length'), 22, 'pages replace rather than accumulate history');
  assert.equal(h.run('imageView.jobs[0].jobId'), 'older-0');
  const nextNav = region.children.find((child) => child.tagName === 'nav')!;
  assert.equal(nextNav.children[0].disabled, false);
  assert.equal(nextNav.children[2].disabled, true);
  h.run('requestImagePage(10)');
  assert.equal(h.messages.at(-1), request, 'unsupported pages do not send a request');
  h.state.activeSessionId = 'session-b'; h.run('renderImageActivities()');
  assert.equal(h.messages.at(-1)!.page, 0);
  assert.equal(h.messages.at(-1)!.sessionId, 'session-b');
});

test('opening an imported image draft refreshes its scoped preview on the selected history page', () => {
  const h = harness();
  h.run('openImagePanel()');
  h.host({ type: 'imageImported', sessionId: 'session-a', asset: { assetId: 'draft-only-input', uri: 'controlled:old', fileName: 'draft.png' } });
  h.run('requestImagePage(1)');
  h.host({ type: 'imageState', sessionId: 'session-a', page: 1, totalJobs: 51, hasOlder: false, jobs: [] });
  h.run('closeImagePanel(); openImagePanel()');
  assert.equal(h.messages.at(-1)!.page, 1);
  assert.equal(h.messages.at(-1)!.inputAssetId, 'draft-only-input');
  h.host({ type: 'imageState', sessionId: 'session-a', page: 1, assets: [{ assetId: 'draft-only-input', uri: 'controlled:refreshed', fileName: 'draft.png' }], jobs: [] });
  assert.equal(h.run('imageDraft.inputAsset.uri'), 'controlled:refreshed');
});

test('image translations have matching Chinese and English keys and explicit unknown-cost semantics', () => {
  assert.deepEqual(Object.keys(IMAGE_TRANSLATIONS['zh-CN']).sort(), Object.keys(IMAGE_TRANSLATIONS.en).sort());
  assert.match(IMAGE_TRANSLATIONS.en.imageCostUnknown, /unknown.*not zero/iu);
  assert.match(IMAGE_TRANSLATIONS.en.imageUnknownNotice, /may charge again/iu);
});
