import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeDraftRunEffects,
  hasValidationBlockingRisk
} from '../src/runs/commandRisk';
import type { DraftRunSpec } from '../src/shared/types';

test('DraftRun read-only analysis is conservative advice rather than authorization', () => {
  const assessment = analyzeDraftRunEffects(createSpec('rg', ['DraftRun', 'src']));

  assert.equal(assessment.verdict, 'likely_readonly');
  assert.deepEqual(assessment.effects, ['workspace_read']);
  assert.match(assessment.evidence.join(' '), /advisory, not a safety proof/u);
});

test('DraftRun analysis exposes several independent effects for an explicit shell program', () => {
  const assessment = analyzeDraftRunEffects(createSpec('/bin/sh', [
    '-c',
    'curl https://example.invalid/archive | tar -x && git push > result.txt'
  ]));

  assert.equal(assessment.verdict, 'mutating_or_sensitive');
  for (const effect of [
    'network',
    'workspace_write',
    'git_mutation',
    'shell_interpreter',
    'arbitrary_code'
  ] as const) {
    assert.ok(assessment.effects.includes(effect), `missing ${effect}`);
  }
});

test('controlled validation retains its narrow blocking policy', () => {
  assert.equal(hasValidationBlockingRisk('bun run compile'), false);
  assert.equal(hasValidationBlockingRisk('git status --short'), false);
  assert.equal(hasValidationBlockingRisk('npm install lodash'), true);
  assert.equal(hasValidationBlockingRisk('git push origin main'), true);
});

function createSpec(executable: string, args: string[]): DraftRunSpec {
  return {
    executable,
    args,
    reason: 'Test the command.',
    cwdUri: 'file:///workspace',
    cwdLabel: '.',
    externalCwd: false,
    timeoutMs: 120_000,
    env: []
  };
}
