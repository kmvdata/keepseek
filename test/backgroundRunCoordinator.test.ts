import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { BackgroundRunCoordinator } from '../src/agent/backgroundRunCoordinator';
import type { RunDetailsSummary } from '../src/shared/types';

describe('BackgroundRunCoordinator', () => {
  it('enforces one active task and bounded rounds', () => {
    const coordinator = new BackgroundRunCoordinator();
    coordinator.start({
      sessionId: 'session-1',
      workspaceKey: 'workspace-1',
      goal: { kind: 'repair_until_validation_passes', script: 'test', description: 'Repair until test passes.' },
      limits: { maxRounds: 1, maxDurationMs: 60_000, maxToolCalls: 3 }
    });
    assert.throws(() => coordinator.start({
      sessionId: 'session-1',
      workspaceKey: 'workspace-1',
      goal: { kind: 'repair_until_validation_passes', script: 'test', description: 'Second task.' },
      limits: { maxRounds: 1, maxDurationMs: 60_000, maxToolCalls: 3 }
    }), /Only one/iu);

    coordinator.beginRound();
    coordinator.recordRun(createRunDetails(2));
    coordinator.waitForApply('Apply changes.');
    assert.equal(coordinator.getActiveRun()?.status, 'waiting_for_apply');
    assert.equal(coordinator.beginRound().status, 'failed');
    assert.match(coordinator.getActiveRun()?.stopReason ?? '', /rounds/iu);
  });

  it('tracks cumulative tool calls and can be stopped', () => {
    const coordinator = new BackgroundRunCoordinator();
    coordinator.start({
      sessionId: 'session-1',
      workspaceKey: 'workspace-1',
      goal: { kind: 'repair_until_validation_passes', script: 'compile', description: 'Repair compile.' },
      limits: { maxRounds: 5, maxDurationMs: 60_000, maxToolCalls: 2 }
    });
    coordinator.beginRound();
    coordinator.recordRun(createRunDetails(2));
    assert.match(coordinator.getLimitStopReason() ?? '', /tool calls/iu);
    assert.equal(coordinator.stop('User stopped.').status, 'stopped');
  });
});

function createRunDetails(toolCount: number): RunDetailsSummary {
  const now = new Date().toISOString();
  return {
    runId: 'run-1',
    modelId: 'deepseek-v4-flash',
    status: 'waiting',
    startedAt: now,
    endedAt: now,
    durationMs: 1,
    modelRequests: { requestCount: 1, messageCount: 2, exposedToolCount: toolCount, thinkingEnabled: true },
    toolCallCount: toolCount,
    toolCalls: Array.from({ length: toolCount }, (_, index) => ({
      id: `tool-${index}`,
      name: 'keepseek_read_workspace_file',
      startedAt: now,
      endedAt: now,
      status: 'succeeded'
    })),
    authorizations: [],
    changeSets: [],
    validations: [],
    memoryEntryIds: [],
    truncated: false
  };
}
