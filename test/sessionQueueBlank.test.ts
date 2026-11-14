import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as vscode from './stubs/vscode';
import { ProjectQueueService } from '../src/sessions/queue/queueService';
import { effectiveMode, orderedSessionIds } from '../src/sessions/queue/projectQueue';
import { buildQueueView } from '../src/sessions/queue/queueView';

/**
 * Blank-session rules (confirmed by the user):
 *   1. A blank session never occupies a queue position.
 *   2. There is never more than one blank session.
 *   3. A blank session never becomes a history entry.
 *
 * Rules 2 and 3 are pre-existing store behaviour. These tests pin the rule that
 * blank sessions are excluded from the project queue, and re-assert 2 and 3 so a
 * later refactor cannot silently regress them.
 */

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

interface Seed {
  id: string;
  createdAt: string;
  messageCount: number;
}

/** Mirrors ChatSessionStore.queueSeeds: only sessions with content are members. */
function seedsOf(sessions: readonly Seed[]): Array<{ id: string; createdAt: string }> {
  return sessions.filter((session) => session.messageCount > 0).map(({ id, createdAt }) => ({ id, createdAt }));
}

async function withService(run: (service: ProjectQueueService) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'keepseek-blank-'));
  try {
    const service = new ProjectQueueService((workspaceKey) => {
      const safe = workspaceKey.replace(/[^a-z0-9]/giu, '_');
      return vscode.Uri.parse(pathToFileURL(join(dir, `${safe}.json`)).toString()) as never;
    });
    await run(service);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a blank session never occupies a queue position', async () => {
  await withService(async (service) => {
    const sessions: Seed[] = [
      { id: 'real', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 3 },
      { id: 'blank', createdAt: '2026-11-02T00:00:00.000Z', messageCount: 0 }
    ];
    await service.ensureLoaded(KEY, seedsOf(sessions), NOW);
    const queue = await service.sync(KEY, seedsOf(sessions), NOW);

    assert.deepEqual(orderedSessionIds(queue), ['real'], 'the blank session is not a member');
    assert.equal(effectiveMode(queue, 'blank'), 'plan', 'a blank session never becomes normal');
  });
});

test('a blank session cannot take the head from a real session', async () => {
  await withService(async (service) => {
    const sessions: Seed[] = [{ id: 'real', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 1 }];
    await service.ensureLoaded(KEY, seedsOf(sessions), NOW);
    await service.sync(KEY, seedsOf(sessions), NOW);

    // The user opens a new composer: the blank must not displace the head.
    const withBlank: Seed[] = [...sessions, { id: 'blank', createdAt: '2026-11-03T00:00:00.000Z', messageCount: 0 }];
    const queue = await service.sync(KEY, seedsOf(withBlank), NOW);
    assert.deepEqual(orderedSessionIds(queue), ['real']);
    assert.equal(effectiveMode(queue, 'real'), 'normal', 'the real session keeps normal');
  });
});

test('a blank session joins the queue at the tail once it gets its first message', async () => {
  await withService(async (service) => {
    const before: Seed[] = [{ id: 'real', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 2 }];
    await service.ensureLoaded(KEY, seedsOf(before), NOW);
    await service.sync(KEY, seedsOf(before), NOW);

    // Same session id, now with content: it becomes a member, and because it
    // joins at the tail it derives plan rather than taking the head.
    const after: Seed[] = [...before, { id: 'was-blank', createdAt: '2026-11-02T00:00:00.000Z', messageCount: 1 }];
    const queue = await service.sync(KEY, seedsOf(after), NOW);
    assert.deepEqual(orderedSessionIds(queue), ['real', 'was-blank']);
    assert.equal(effectiveMode(queue, 'real'), 'normal');
    assert.equal(effectiveMode(queue, 'was-blank'), 'plan');
  });
});

test('a session that becomes blank again leaves the queue', async () => {
  await withService(async (service) => {
    const both: Seed[] = [
      { id: 'a', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 1 },
      { id: 'b', createdAt: '2026-11-02T00:00:00.000Z', messageCount: 1 }
    ];
    await service.ensureLoaded(KEY, seedsOf(both), NOW);
    await service.sync(KEY, seedsOf(both), NOW);
    assert.deepEqual(orderedSessionIds(service.peek(KEY)!), ['a', 'b']);

    const aBlank: Seed[] = [both[0], { ...both[1], messageCount: 0 }];
    const queue = await service.sync(KEY, seedsOf(aBlank), NOW);
    assert.deepEqual(orderedSessionIds(queue), ['a'], 'a blank session is not a member');
    assert.equal(effectiveMode(queue, 'a'), 'normal');
  });
});

test('an entirely blank project has an empty queue and no head', async () => {
  await withService(async (service) => {
    const blankOnly: Seed[] = [{ id: 'blank', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 0 }];
    await service.ensureLoaded(KEY, seedsOf(blankOnly), NOW);
    const queue = await service.sync(KEY, seedsOf(blankOnly), NOW);
    assert.deepEqual(orderedSessionIds(queue), []);
    assert.equal(queue.entries.length, 0);
    assert.equal(effectiveMode(queue, 'blank'), 'plan');
  });
});

test('blank sessions never reach the queue view shown as history', async () => {
  await withService(async (service) => {
    const sessions: Seed[] = [
      { id: 'real', createdAt: '2026-11-01T00:00:00.000Z', messageCount: 4 },
      { id: 'blank', createdAt: '2026-11-02T00:00:00.000Z', messageCount: 0 }
    ];
    await service.ensureLoaded(KEY, seedsOf(sessions), NOW);
    const queue = await service.sync(KEY, seedsOf(sessions), NOW);
    const view = buildQueueView({ queue, titles: new Map([['real', 'Real'], ['blank', 'Blank']]) });
    assert.deepEqual(view.entries.map((entry) => entry.sessionId), ['real']);
  });
});