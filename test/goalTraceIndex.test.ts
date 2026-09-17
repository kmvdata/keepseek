import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { GoalTraceIndexStore } from '../src/agent/goals/goalTraceIndex';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

test('Goal trace index persists ordered multi-attempt discovery without exposing URIs in view summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-goal-trace-'));
  roots.push(root);
  const store = new GoalTraceIndexStore(vscode.Uri.file(root));
  await store.register({
    goalId: 'goal-1', runId: 'run-2', traceUri: vscode.Uri.file(join(root, 'second.jsonl')).toString(),
    kind: 'attempt', attempt: 2, level: 'full', createdAt: '2099-01-01T00:00:02.000Z'
  });
  await store.register({
    goalId: 'goal-1', runId: 'run-2', traceUri: vscode.Uri.file(join(root, 'second.jsonl')).toString(),
    kind: 'completion_review', attempt: 2, level: 'full', createdAt: '2099-01-01T00:00:03.000Z'
  });
  await store.register({
    goalId: 'goal-1', runId: 'run-1', traceUri: vscode.Uri.file(join(root, 'first.jsonl')).toString(),
    kind: 'start', attempt: 1, level: 'metadata', createdAt: '2099-01-01T00:00:01.000Z'
  });
  const restored = new GoalTraceIndexStore(vscode.Uri.file(root));
  await restored.initialize();
  const summaries = restored.list('goal-1');
  assert.deepEqual(summaries.map((item) => [item.kind, item.attempt]), [
    ['start', 1], ['attempt', 2], ['completion_review', 2]
  ]);
  assert.doesNotMatch(JSON.stringify(summaries), /file:|jsonl|run-1|run-2/u);
  assert.match(restored.resolve('goal-1', summaries[0]!.id)?.traceUri ?? '', /first\.jsonl/u);
});
