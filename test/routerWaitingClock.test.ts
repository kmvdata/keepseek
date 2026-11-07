import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRunner } from '../src/agent/runner';
import { ExecutionClock } from '../src/agent/executionPolicy';
import { PROJECT_ROUTER_ROLE, type ProjectTaskRouterHost } from '../src/agent/taskRouter';
import type { AgentRequest } from '../src/shared/types';

for (const granted of [true, false]) test(`Router human stop confirmation ${granted ? 'grant' : 'rejection'} suspends and resumes the shared root clock`, async () => {
  let now = 0, physicalRequests = 0, stops = 0;
  const clock = new ExecutionClock(0, 0, () => now);
  const waitStates: boolean[] = [], phases: string[] = [];
  const host: ProjectTaskRouterHost = {
    projectId: 'project', list: async () => ({ tasks: [] }),
    read: async () => ({ task: { taskCardId: 'target', sessionId: 'worker', status: 'running', title: 'Target' } }),
    create: async () => { throw new Error('Unexpected create'); }, deliver: async () => { throw new Error('Unexpected deliver'); },
    setDependencies: async () => { throw new Error('Unexpected dependency'); },
    requestStopAuthorization: async () => {
      assert.equal(clock.usedMs, 10);
      now += 60_000; // A minute waiting for a real Host decision is not work.
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(clock.usedMs, 10);
      return granted;
    },
    stop: async input => { stops++; return { taskCardId: input.taskCardId, sessionId: 'worker', status: 'stopping' }; }
  };
  const request: AgentRequest = {
    agentRole: { ...PROJECT_ROUTER_ROLE }, taskRouter: host,
    taskRouterContext: { projectId: 'project', sessionId: 'router', inputId: 'real-input', onWaiting: waiting => waitStates.push(waiting) },
    taskClock: clock, sessionId: 'router', prompt: 'Stop the exact target task.',
    history: [{ id: 'real-input', role: 'user', content: 'Stop the exact target task.', createdAt: '' }], contextFiles: [],
    language: 'en', requestProtocolVersion: 15,
    model: { id: 'clock-model', label: 'Clock', sourceId: 'fixture', provider: 'openai-compatible',
      contextWindowTokens: 64000, maxOutputTokens: 2000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId: 'fixture', provider: 'openai-compatible', apiKey: 'test-key',
      baseUrl: 'https://fixture.invalid/v1', supportsBilling: false }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    physicalRequests++;
    now += physicalRequests === 1 ? 10 : 20;
    const delta = physicalRequests === 1 ? { tool_calls: [{ index: 0, id: 'stop-call', type: 'function', function: {
      name: 'keepseek_tasks_stop', arguments: JSON.stringify({ taskCardId: 'target' }) } }] } : { content: 'Decision recorded.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: physicalRequests === 1 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`);
  };
  try {
    await new AgentRunner().run(request, { onStatus: activity => { phases.push(activity.phase); } });
    assert.equal(physicalRequests, 2);
    assert.equal(stops, granted ? 1 : 0);
    assert.deepEqual(waitStates, [true, false]);
    assert.ok(phases.includes('awaiting_manual_approval'));
    assert.ok(phases.lastIndexOf('planning_tool') > phases.indexOf('awaiting_manual_approval'));
    assert.equal(clock.usedMs, 30);
  } finally { globalThis.fetch = originalFetch; clock.dispose(); }
});
