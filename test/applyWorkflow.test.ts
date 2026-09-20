import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getScript } from '../src/webview/script';

class ActionElement {
  public dataset: Record<string, string> = {};
  public attributes: Record<string, string> = {};
  public disabled = false;
  public type = '';
  public textContent = '';
  public className = '';

  public closest(): ActionElement { return this; }
  public setAttribute(name: string, value: string): void { this.attributes[name] = value; }
}

test('Apply click immediately shows checking/writing and terminal feedback always clears pending state', () => {
  const source = getScript();
  const functions = ['handleChangeSetActionClick', 'handleChangeActionFeedback', 'createEditActionButton']
    .map((name) => extractFunction(source, name))
    .join('\n');
  const pendingChangeActions = new Map<string, { requestId: string; phase: string }>();
  const posted: Array<Record<string, string>> = [];
  const statuses: string[] = [];
  let renders = 0;
  const context = {
    Element: ActionElement,
    document: { createElement: () => new ActionElement() },
    pendingChangeActions,
    changeActionRequestSequence: 0,
    state: { startup: { sideEffectsReady: true }, isBusy: false },
    vscode: { postMessage: (message: Record<string, string>) => posted.push(message) },
    render: () => { renders += 1; },
    setTransientStatus: (value: string) => statuses.push(value),
    t: (key: string) => WEBVIEW_TRANSLATIONS.en[key] ?? key
  };
  const api = new Script(`${functions}\n({ handleChangeSetActionClick, handleChangeActionFeedback, createEditActionButton });`)
    .runInNewContext(context) as {
      handleChangeSetActionClick(event: { target: ActionElement }): void;
      handleChangeActionFeedback(message: Record<string, string>): boolean;
      createEditActionButton(label: string, action: string, id: string, secondary: boolean): ActionElement;
    };
  const clicked = new ActionElement();
  clicked.dataset.editId = 'edit-1';
  clicked.dataset.editAction = 'applyDraftEdit';
  api.handleChangeSetActionClick({ target: clicked });
  assert.equal(renders, 1);
  assert.equal(posted[0]?.type, 'applyDraftEdit');
  assert.equal(posted[0]?.requestId, 'change-action-1');
  assert.equal(pendingChangeActions.get('applyDraftEdit:edit-1')?.requestId, 'change-action-1');
  assert.equal(pendingChangeActions.get('applyDraftEdit:edit-1')?.phase, 'checking');
  const checking = api.createEditActionButton('Accept', 'applyDraftEdit', 'edit-1', false);
  assert.equal(checking.textContent, 'Checking…');
  assert.equal(checking.disabled, true);
  assert.equal(checking.attributes['aria-busy'], 'true');

  assert.equal(api.handleChangeActionFeedback({
    type: 'changeActionFeedback', requestId: 'change-action-1', action: 'applyDraftEdit', id: 'edit-1', phase: 'writing'
  }), true);
  assert.equal(api.createEditActionButton('Accept', 'applyDraftEdit', 'edit-1', false).textContent, 'Writing…');
  assert.equal(api.handleChangeActionFeedback({
    type: 'changeActionFeedback', requestId: 'change-action-1', action: 'applyDraftEdit', id: 'edit-1', phase: 'failed', detail: 'write failed'
  }), true);
  assert.equal(pendingChangeActions.size, 0);
  assert.deepEqual(statuses, ['write failed']);
});

test('Provider returns terminal feedback for busy, missing, and exceptional Apply paths', async () => {
  const messages: Array<Record<string, unknown>> = [];
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    approvalDataReady: true,
    requestContextReady: true,
    isBusy: true,
    isStartingRun: false,
    runContextRefreshInFlight: false,
    activeChangeActions: new Set<string>(),
    postToWebview: (message: Record<string, unknown>) => messages.push(message),
    postState: () => undefined,
    t: (key: string) => key
  }) as unknown as {
    handleMessage(message: { type: 'applyDraftEdit'; id: string; requestId: string }): Promise<void>;
    isBusy: boolean;
    changeSets: unknown;
  };

  await host.handleMessage({ type: 'applyDraftEdit', id: 'edit-busy', requestId: 'request-busy' });
  assert.equal(messages.at(-1)?.phase, 'busy');

  host.isBusy = false;
  host.changeSets = {
    getEditUris: () => [],
    getPendingDeleteTargetsForEdit: () => [],
    applyEdit: async () => undefined
  };
  await host.handleMessage({ type: 'applyDraftEdit', id: 'edit-missing', requestId: 'request-missing' });
  assert.deepEqual(messages.slice(-2).map((message) => message.phase), ['checking', 'not_found']);

  host.changeSets = {
    getEditUris: () => [],
    getPendingDeleteTargetsForEdit: () => [],
    applyEdit: async () => { throw new Error('simulated Apply failure'); }
  };
  await host.handleMessage({ type: 'applyDraftEdit', id: 'edit-failure', requestId: 'request-failure' });
  assert.deepEqual(messages.slice(-2).map((message) => message.phase), ['checking', 'failed']);
  assert.match(String(messages.at(-1)?.detail), /simulated Apply failure/u);
});

test('ordinary source Apply skips Skill discovery while context-source refresh blocks until current', async () => {
  let skillRefreshes = 0;
  let contextRefreshes = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const session = { id: 'session-1', contextUsage: {} };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    runContextRefreshPromise: undefined,
    runContextRefreshInFlight: false,
    runContextRefreshError: undefined,
    fileContext: { getAll: () => [], refreshUris: async () => false },
    skillStore: {
      refresh: async () => { skillRefreshes += 1; },
      invalidateImplicitSkillSnapshot: () => undefined
    },
    legacyMemoryMigration: { refresh: async () => undefined },
    sessionStore: { getActiveSession: () => session },
    refreshCurrentRunContext: async () => { contextRefreshes += 1; await gate; },
    postState: () => undefined,
    t: (key: string) => key
  }) as unknown as {
    scheduleRunContextRefresh(uris: string[]): void;
    awaitRunContextRefresh(): Promise<boolean>;
    runContextRefreshPromise?: Promise<void>;
  };

  host.scheduleRunContextRefresh(['file:///workspace/src/ordinary.ts']);
  assert.equal(host.runContextRefreshPromise, undefined);
  assert.equal(skillRefreshes, 0);
  assert.equal(contextRefreshes, 0);

  host.scheduleRunContextRefresh(['file:///workspace/.agents/skills/review/SKILL.md']);
  assert.ok(host.runContextRefreshPromise);
  let settled = false;
  const waiting = host.awaitRunContextRefresh().then((value) => { settled = true; return value; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(skillRefreshes, 1);
  assert.equal(contextRefreshes, 1);
  assert.equal(settled, false);
  release();
  assert.equal(await waiting, true);
});

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
