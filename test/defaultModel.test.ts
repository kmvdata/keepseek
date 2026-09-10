import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as Vscode from 'vscode';
import * as vscode from './stubs/vscode';
import { DefaultModelStore, GLOBAL_DEFAULT_MODEL_KEY } from '../src/accounts/defaultModelStore';
import { createModelCatalog, resolveDefaultModel, resolveProjectModel } from '../src/accounts/modelCatalog';
import { getConfiguredModelSelection } from '../src/shared/config';
import type { ModelSource } from '../src/accounts/types';
import type { KeepseekModel, ModelSelection } from '../src/shared/types';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';

const a = { sourceId: 'a', modelId: 'shared' };
const b = { sourceId: 'b', modelId: 'shared' };

function source(id: string, overrides: Partial<ModelSource> = {}): ModelSource {
  return {
    id, name: id, provider: 'openai-compatible', baseUrl: 'https://example.com', apiKey: '',
    enabled: true, models: [{ id: 'shared' }], createdAt: 1, updatedAt: 1, ...overrides
  };
}

function memory(initial?: ModelSelection) {
  let value = initial;
  const writes: unknown[] = [];
  const state = {
    fail: false,
    beforeWrite: async () => {},
    get<T>(key: string) { assert.equal(key, GLOBAL_DEFAULT_MODEL_KEY); return value as T | undefined; },
    async update(key: string, next: ModelSelection | undefined) {
      assert.equal(key, GLOBAL_DEFAULT_MODEL_KEY);
      await state.beforeWrite();
      if (state.fail) { throw new Error('disk full'); }
      value = next ? { ...next } : undefined;
      writes.push(value);
    },
    writes
  };
  return state;
}

function identity(model: KeepseekModel | undefined) {
  return model ? { sourceId: model.sourceId, modelId: model.id } : undefined;
}

test('inferred default follows catalog order, skips unavailable resources, and is never saved as explicit', async () => {
  const sources = [
    source('disabled', { enabled: false }),
    source('empty', { models: [] }),
    source('a', {
      modelCache: { fetchedAt: 1, models: [{ id: 'wan2.7-image' }, { id: 'off' }, { id: 'z-first' }, { id: 'a-next' }] },
      disabledModelIds: ['off']
    }), source('b')
  ];
  const state = memory();
  const store = new DefaultModelStore(state, async () => sources);
  assert.deepEqual(identity((await store.refresh()).defaultModel), { sourceId: 'a', modelId: 'z-first' });
  assert.deepEqual(state.writes, []);
  assert.equal(resolveDefaultModel([]), undefined);
  assert.equal(resolveDefaultModel(createModelCatalog([source('a', { disabledModelIds: ['shared'] })])), undefined);
});

test('explicit default distinguishes namesakes, survives restart and reorder, and does not supersede a project', async () => {
  let sources = [source('a'), source('b')];
  const state = memory();
  const store = new DefaultModelStore(state, async () => sources);
  await store.set(b);
  sources = [source('b'), source('a')];
  const restarted = new DefaultModelStore(state, async () => sources);
  const snapshot = await restarted.refresh();
  assert.deepEqual(identity(snapshot.defaultModel), b);
  assert.deepEqual(identity(resolveProjectModel(snapshot.availableModels, undefined, b)), b);
  assert.deepEqual(identity(resolveProjectModel(snapshot.availableModels, a, b)), a);
  await restarted.set(a);
  assert.deepEqual(identity(resolveProjectModel(snapshot.availableModels, b, a)), b);
  assert.deepEqual(state.writes, [b, a]);
});

test('invalid defaults are cleared for disabled models/accounts, deletion and empty discovery; restoring B does not reclaim default', async () => {
  for (const unavailable of [
    [source('a'), source('b', { disabledModelIds: ['shared'] })],
    [source('a'), source('b', { enabled: false })],
    [source('a'), source('b', { models: [] })],
    [source('a')],
    [source('a'), source('b', { models: [], modelCache: { fetchedAt: 2, models: [] } })],
    []
  ]) {
    let sources = [source('a'), source('b')];
    const state = memory(b);
    const store = new DefaultModelStore(state, async () => sources);
    sources = unavailable;
    assert.deepEqual(identity((await store.refresh()).defaultModel), sources.length ? a : undefined);
    assert.equal(state.get(GLOBAL_DEFAULT_MODEL_KEY), undefined);
    sources = [source('a'), source('b')];
    assert.deepEqual(identity((await store.refresh()).defaultModel), a);
  }
});

test('default write validates the complete enabled text model identity and keeps the previous preference on failure', async () => {
  const state = memory(a);
  const sources = [source('a'), source('b'), source('disabled', { enabled: false }),
    source('off', { disabledModelIds: ['shared'] }), source('image', { models: [{ id: 'wan2.7-image' }] })];
  const store = new DefaultModelStore(state, async () => sources);
  for (const invalid of [
    { sourceId: '', modelId: 'shared' }, { sourceId: 'deleted', modelId: 'shared' },
    { sourceId: 'disabled', modelId: 'shared' }, { sourceId: 'off', modelId: 'shared' },
    { sourceId: 'image', modelId: 'wan2.7-image' }
  ]) {
    await assert.rejects(store.set(invalid), /unavailable/u);
  }
  state.fail = true;
  await assert.rejects(store.set(b), /disk full/u);
  assert.deepEqual(identity((await store.refresh()).defaultModel), a);
  assert.deepEqual(state.writes, []);
  state.fail = false;
  await store.set(b);
  assert.deepEqual(identity((await store.refresh()).defaultModel), b);
});

test('queued writes and refreshes cannot publish an old default after a later write', async () => {
  const state = memory();
  let unblock!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  state.beforeWrite = async () => {
    started();
    await new Promise<void>((resolve) => { unblock = resolve; });
  };
  const store = new DefaultModelStore(state, async () => [source('a'), source('b')]);
  const first = store.set(b);
  await entered;
  const refresh = store.refresh();
  const latest = store.set(a);
  const final = store.refresh();
  state.beforeWrite = async () => {};
  unblock();
  await first;
  assert.deepEqual(identity((await refresh).defaultModel), b);
  await latest;
  assert.deepEqual(identity((await final).defaultModel), a);
  assert.deepEqual(state.writes, [b, a]);
});

test('an existing store observes another window default and rolls back an optimistic Memento cache on failure', async () => {
  let persisted: ModelSelection | undefined = a;
  let cached: ModelSelection | undefined = persisted;
  let fail = false;
  const state = {
    get<T>() { return cached as T | undefined; },
    async update(_key: string, value: ModelSelection | undefined) {
      cached = value;
      if (fail) { throw new Error('storage unavailable'); }
      persisted = value;
    }
  };
  const store = new DefaultModelStore(state, async () => [source('a'), source('b')]);
  await state.update(GLOBAL_DEFAULT_MODEL_KEY, b);
  assert.deepEqual(identity((await store.refresh()).defaultModel), b);
  fail = true;
  await assert.rejects(store.set(a), /storage unavailable/u);
  assert.deepEqual(cached, b);
  assert.deepEqual(persisted, b);
  assert.deepEqual(identity((await store.refresh()).defaultModel), b);
});

test('configuration ignores an inherited legacy model ID in a new project and preserves explicit project choices', () => {
  const original = vscode.workspace.getConfiguration;
  let workspaceValues: Record<string, string> = {};
  const inheritedValues: Record<string, string> = {
    selectedModelId: 'shared'
  };
  vscode.workspace.getConfiguration = () => ({
    ...original(),
    get: <T>(key: string, fallback: T): T => (workspaceValues[key] ?? inheritedValues[key] ?? fallback) as T,
    inspect: <T>(key: string) => ({
      key: `keepseek.${key}`,
      globalValue: inheritedValues[key] as T | undefined,
      workspaceValue: workspaceValues[key] as T | undefined
    })
  });
  try {
    const models = createModelCatalog([source('a'), source('b')]);
    assert.deepEqual(getConfiguredModelSelection(models, b), b);
    workspaceValues = { selectedModelId: 'shared' };
    assert.deepEqual(getConfiguredModelSelection(models, b), a);
    workspaceValues.selectedSourceId = 'deleted';
    assert.deepEqual(getConfiguredModelSelection(models, b), b);
    workspaceValues.selectedSourceId = 'a';
    assert.deepEqual(getConfiguredModelSelection(models, b), a);
    assert.deepEqual(getConfiguredModelSelection([], b), { sourceId: '', modelId: '' });
  } finally { vscode.workspace.getConfiguration = original; }
});

test('Provider persists adoption once, retains it on default changes/restart, and supports ordinary project switching', async () => {
  const originalConfig = vscode.workspace.getConfiguration;
  const originalFolders = vscode.workspace.workspaceFolders;
  const workspaceValues: Record<string, string> = {};
  const inheritedValues: Record<string, string> = {
    selectedModelId: 'shared'
  };
  const writes: string[] = [];
  const state = memory(b);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file('/workspace') }];
  vscode.workspace.getConfiguration = () => ({
    get: <T>(key: string, fallback: T): T => (workspaceValues[key] ?? inheritedValues[key] ?? fallback) as T,
    inspect: <T>(key: string) => ({
      key: `keepseek.${key}`,
      globalValue: inheritedValues[key] as T | undefined,
      workspaceValue: workspaceValues[key] as T | undefined
    }),
    async update(key: string, value: string, target: unknown) {
      assert.equal(target, vscode.ConfigurationTarget.Workspace);
      workspaceValues[key] = value; writes.push(key);
    }
  } as unknown as ReturnType<typeof originalConfig>);
  try {
    const host = providerHost(state);
    await host.refreshModelSourceState();
    assert.equal(host.selectedSourceId, 'b');
    assert.deepEqual(workspaceValues, { selectedSourceId: 'b', selectedModelId: 'shared' });
    await host.setDefaultModel(a);
    assert.equal(host.selectedSourceId, 'b');
    assert.deepEqual(host.defaultModelSelection, a);
    await host.refreshModelSourceState();
    assert.equal(writes.length, 2, 'refresh/default changes must not re-persist an adopted project');
    const restarted = providerHost(state);
    await restarted.refreshModelSourceState();
    assert.equal(restarted.selectedSourceId, 'b');
    await Promise.all([restarted.setDefaultModel(b), restarted.setDefaultModel(a), restarted.refreshModelSourceState()]);
    assert.deepEqual(restarted.defaultModelSelection, a, 'older refresh continuations must not enqueue an older preference last');
    await restarted.persistModelSelection('a', 'shared');
    await restarted.refreshModelSourceState();
    assert.equal(restarted.selectedSourceId, 'a');
    state.fail = true;
    await restarted.setDefaultModel(b);
    assert.deepEqual(restarted.defaultModelSelection, a);
    assert.equal(restarted.selectedSourceId, 'a');
  } finally {
    vscode.workspace.getConfiguration = originalConfig;
    vscode.workspace.workspaceFolders = originalFolders;
  }
});

function providerHost(state: Pick<Vscode.Memento, 'get' | 'update'>) {
  return Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    language: 'en', selectedSourceId: '', selectedModelId: '', modelSources: [], availableModels: [],
    defaultModelRequestGeneration: 0, defaultModelPending: false,
    modelSourceStateRefreshGeneration: 0, modelSelectionPersistenceDepth: 0,
    defaultModelStore: new DefaultModelStore(state, async () => [source('a'), source('b')]),
    balanceStore: { selectSource: () => {} },
    rejectModelSourceMutationWhileBusy: () => false,
    postState: () => {}, postModelSettingsDialog: () => {}
  }) as {
    selectedSourceId: string; defaultModelSelection?: ModelSelection;
    refreshModelSourceState(): Promise<void>;
    setDefaultModel(selection: ModelSelection): Promise<void>;
    persistModelSelection(sourceId: string, modelId: string): Promise<void>;
  };
}
