import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRequestCoordinator } from '../src/agent/agentRequestCoordinator';
import {
  HistoryCompressor,
  type HistoryCompressionRefreshInput,
  type HistoryCompressionRefreshPlan,
  type HistoryCompressionRefreshResult
} from '../src/agent/historyCompressor';
import type {
  AgentSettings,
  ChatMessage,
  ChatSession,
  ContextCompressionState,
  ContextFile,
  KeepseekModel
} from '../src/shared/types';

test('createAgentRequest snapshots mutable request inputs', () => {
  const coordinator = new AgentRequestCoordinator(new FakeHistoryCompressor());
  const model = createModel();
  const settings: AgentSettings = {
    thinkingEnabled: true,
    reasoningEffort: 'high'
  };
  const contextFiles = [createContextFile()];
  const history = [
    {
      ...createMessage(0),
      contextMeta: {
        isProtected: true,
        protectedReason: 'first_user_request'
      }
    }
  ];
  const contextCompression = createCompressionState('original');
  const signal = new AbortController().signal;
  const repairLoop = {
    status: 'ready_for_validation' as const,
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile' as const,
    pendingDraftEditIds: [] as string[]
  };

  const request = coordinator.createAgentRequest({
    prompt: 'current request',
    model,
    settings,
    contextFiles,
    history,
    contextCompression,
    repairLoop,
    language: 'en',
    signal
  });

  model.label = 'Changed Model';
  settings.thinkingEnabled = false;
  contextFiles[0].content = 'changed context file';
  history[0].content = 'changed message';
  history[0].contextMeta = {
    isProtected: true,
    protectedReason: 'changed_reason'
  };
  contextCompression.protectedMessageIds.push('new-protected-id');
  contextCompression.summaries[0].coveredMessageIds.push('new-covered-id');
  repairLoop.pendingDraftEditIds.push('mutated-edit');

  assert.equal(request.model.label, 'Test Model');
  assert.equal(request.settings.thinkingEnabled, true);
  assert.equal(request.contextFiles[0]?.content, 'context file content');
  assert.equal(request.history[0]?.content, 'message 0');
  assert.equal(request.history[0]?.contextMeta?.protectedReason, 'first_user_request');
  assert.deepEqual(request.contextCompression?.protectedMessageIds, ['protected-original']);
  assert.deepEqual(request.contextCompression?.summaries[0]?.coveredMessageIds, ['covered-original']);
  assert.deepEqual(request.repairLoop?.pendingDraftEditIds, []);
  assert.equal(request.signal, signal);
});

test('refreshContextCompressionBeforeRun waits for background refresh before replanning', async () => {
  const compressor = new FakeHistoryCompressor();
  const coordinator = new AgentRequestCoordinator(compressor);
  const session = createSession();
  const input = createRefreshInput(session);
  const initialState = createCompressionState('initial');
  const backgroundState = createCompressionState('background');
  const releaseBackground = createDeferred();
  const backgroundUpdateStarted = createDeferred();
  const releaseBackgroundUpdate = createDeferred();

  compressor.queuePlan(createPlan('background', initialState));
  compressor.queueRefresh(async () => {
    await releaseBackground.promise;
    return createRefreshResult(backgroundState);
  });
  coordinator.scheduleBackgroundContextCompressionRefresh(input, async (update) => {
    backgroundUpdateStarted.resolve();
    await releaseBackgroundUpdate.promise;
    session.contextCompression = update.result.state;
  });

  compressor.queuePlan(createPlan('sync', initialState));
  compressor.queuePlan(createPlan('none', backgroundState));
  const resultPromise = coordinator.refreshContextCompressionBeforeRun(input);

  await Promise.resolve();
  assert.equal(compressor.refreshCalls.length, 1);

  releaseBackground.resolve();
  await backgroundUpdateStarted.promise;
  await Promise.resolve();
  assert.equal(compressor.refreshCalls.length, 1);

  releaseBackgroundUpdate.resolve();
  const result = await resultPromise;

  assert.equal(result, undefined);
  assert.equal(session.contextCompression, backgroundState);
  assert.equal(compressor.planCalls.length, 3);
  assert.equal(compressor.refreshCalls.length, 1);
});

test('refreshContextCompressionBeforeRun runs sync refresh when background result is still insufficient', async () => {
  const compressor = new FakeHistoryCompressor();
  const coordinator = new AgentRequestCoordinator(compressor);
  const session = createSession();
  const input = createRefreshInput(session);
  const initialState = createCompressionState('initial');
  const backgroundState = createCompressionState('background');
  const syncState = createCompressionState('sync');
  const releaseBackground = createDeferred();

  compressor.queuePlan(createPlan('background', initialState));
  compressor.queueRefresh(async () => {
    await releaseBackground.promise;
    return createRefreshResult(backgroundState);
  });
  coordinator.scheduleBackgroundContextCompressionRefresh(input, (update) => {
    session.contextCompression = update.result.state;
  });

  compressor.queuePlan(createPlan('sync', initialState));
  compressor.queuePlan(createPlan('sync', backgroundState));
  compressor.queueRefresh(async () => createRefreshResult(syncState));
  const resultPromise = coordinator.refreshContextCompressionBeforeRun(input);

  await Promise.resolve();
  assert.equal(compressor.refreshCalls.length, 1);

  releaseBackground.resolve();
  const result = await resultPromise;

  assert.equal(result?.state, syncState);
  assert.equal(compressor.planCalls.length, 3);
  assert.equal(compressor.refreshCalls.length, 2);
});

type RefreshHandler = (
  input: HistoryCompressionRefreshInput
) => Promise<HistoryCompressionRefreshResult> | HistoryCompressionRefreshResult;

class FakeHistoryCompressor extends HistoryCompressor {
  public readonly planCalls: HistoryCompressionRefreshInput[] = [];
  public readonly refreshCalls: HistoryCompressionRefreshInput[] = [];
  private readonly plans: HistoryCompressionRefreshPlan[] = [];
  private readonly refreshHandlers: RefreshHandler[] = [];

  public constructor() {
    super(async () => 'unused');
  }

  public queuePlan(plan: HistoryCompressionRefreshPlan): void {
    this.plans.push(plan);
  }

  public queueRefresh(handler: RefreshHandler): void {
    this.refreshHandlers.push(handler);
  }

  public override planRefresh(input: HistoryCompressionRefreshInput): HistoryCompressionRefreshPlan {
    this.planCalls.push(input);
    const plan = this.plans.shift();
    if (!plan) {
      throw new Error('No queued compression refresh plan.');
    }
    return plan;
  }

  public override async refresh(
    input: HistoryCompressionRefreshInput
  ): Promise<HistoryCompressionRefreshResult> {
    this.refreshCalls.push(input);
    const handler = this.refreshHandlers.shift();
    if (!handler) {
      throw new Error('No queued compression refresh result.');
    }
    return await handler(input);
  }
}

function createPlan(
  mode: HistoryCompressionRefreshPlan['mode'],
  state: ContextCompressionState,
  changed = false
): HistoryCompressionRefreshPlan {
  return {
    state,
    changed,
    mode,
    reason: mode === 'sync'
      ? 'missing_summary_near_context_limit'
      : mode === 'background'
        ? 'background_refresh'
        : 'fresh_enough'
  };
}

function createRefreshResult(state: ContextCompressionState): HistoryCompressionRefreshResult {
  return {
    state,
    changed: true,
    reason: 'updated'
  };
}

function createRefreshInput(session: ChatSession): HistoryCompressionRefreshInput {
  return {
    session,
    prompt: 'current request',
    model: createModel(),
    agentSettings: {
      thinkingEnabled: true,
      reasoningEffort: 'high'
    },
    contextFiles: [],
    language: 'en'
  };
}

function createSession(): ChatSession {
  const now = new Date(0).toISOString();
  return {
    id: 'session-1',
    title: 'Coordinator Session',
    messages: [createMessage(0), createMessage(1)],
    createdAt: now,
    updatedAt: now,
    workspaceKey: 'workspace:test',
    workspaceName: 'Test Workspace',
    workspaceFolders: [],
    isFavorite: false
  };
}

function createMessage(index: number): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: new Date(index * 1000).toISOString()
  };
}

function createCompressionState(id: string): ContextCompressionState {
  const now = new Date(0).toISOString();
  return {
    version: 1,
    protectedMessageIds: [`protected-${id}`],
    summaries: [
      {
        id: `summary-${id}`,
        content: `summary ${id}`,
        coveredMessageIds: [`covered-${id}`],
        createdAt: now,
        updatedAt: now,
        tokenEstimate: 10,
        version: 1
      }
    ]
  };
}

function createContextFile(): ContextFile {
  return {
    id: 'context-file-1',
    uri: 'file:///context.ts',
    label: 'context.ts',
    fsPath: '/workspace/context.ts',
    languageId: 'typescript',
    content: 'context file content',
    sizeBytes: 20,
    source: 'workspace'
  };
}

function createModel(): KeepseekModel {
  return {
    id: 'test-model',
    label: 'Test Model',
    provider: 'test',
    contextWindowTokens: 1000
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}
