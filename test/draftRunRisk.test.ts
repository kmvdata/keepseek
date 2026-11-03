import assert from 'node:assert/strict';
import { test } from 'node:test';
import './registerVscodeStub';
import { analyzeCommand, analyzeDraftRunEffects } from '../src/approvals/authorization';
import { hasValidationBlockingRisk } from '../src/agent/tools/validationRisk';
import type { DraftRunSpec } from '../src/shared/types';

test('DraftRun read-only analysis is conservative advice rather than authorization', () => {
  const assessment = analyzeDraftRunEffects(createSpec('cat', ['src/script.ts']));

  assert.equal(assessment.verdict, 'likely_readonly');
  assert.deepEqual(assessment.effects, ['workspace_read']);
  assert.match(assessment.evidence.join(' '), /advisory, not a safety proof/u);
});

test('inline shell programs expose execution and unknown scope without pretending to parse shell text', () => {
  const assessment = analyzeDraftRunEffects(createSpec('/bin/sh', [
    '-c',
    'curl https://example.invalid/archive | tar -x && git push > result.txt'
  ]));

  assert.equal(assessment.verdict, 'mutating_or_sensitive');
  for (const effect of [
    'shell_interpreter',
    'arbitrary_code',
    'unknown'
  ] as const) {
    assert.ok(assessment.effects.includes(effect), `missing ${effect}`);
  }
});

test('Git show regression: format and source suffixes are data, while Git runtime remains explicitly unbounded', () => {
  for (const file of ['src/webview/script.ts', 'script.js', 'script.sh', 'README.md']) {
    for (const format of [[], ['--format=%s']] as string[][]) {
      const spec = createSpec('git', ['show', '9a95c781576170b4f819e939ada012473f67d592', ...format, '--', file]);
      const parsed = analyzeCommand(spec);
      assert.deepEqual(parsed.effects, ['workspace_read']);
      assert.deepEqual(parsed.reasons.map(reason => reason.code), ['git_runtime']);
      assert.equal(parsed.arguments.at(-1)?.role, 'read_path');
      const assessment = analyzeDraftRunEffects(spec);
      assert.equal(assessment.verdict, 'unknown');
      assert.deepEqual(assessment.effects, ['workspace_read', 'unknown']);
      assert.doesNotMatch(assessment.evidence.join(' '), /Script contents|脚本内容/u);
    }
  }
});

test('keywords in text, formats, revisions and filenames never become executed commands', () => {
  for (const spec of [
    createSpec('cat', ['--', 'rm format publish.ts', '--output=delete.js', 'script.sh']),
    createSpec('echo', ['curl https://example.invalid', 'git push', '> result', 'sudo', 'token']),
    createSpec('printf', ['format %s', 'rm -rf']),
    createSpec('grep', ['-e', 'curl git push format', '--', 'file name.sh']),
    createSpec('git', ['show', '--format=curl git push format', 'refs/heads/format', '--', 'rm.js'])
  ]) {
    const assessment = analyzeDraftRunEffects(spec);
    for (const effect of ['workspace_write', 'network', 'arbitrary_code', 'git_mutation', 'publish_or_deploy', 'privilege_escalation']) {
      assert.ok(!assessment.effects.includes(effect as never), `${spec.executable}: ${effect}`);
    }
  }
});

test('argv roles preserve boundaries, option values, cwd changes and literal paths', () => {
  const parsed = analyzeCommand(createSpec('git', ['-C', '../repo with spaces', 'show', '-n', '1', '--format=%s',
    '--output', '../output file', '--', 'source name.ts', '--textconv']));
  assert.equal(parsed.arguments.find(a => a.value === '1')?.role, 'option_value');
  assert.equal(parsed.arguments.find(a => a.value === '%s')?.role, 'text');
  assert.equal(parsed.arguments.find(a => a.value === '../output file')?.role, 'write_path');
  assert.deepEqual(parsed.arguments.at(-1), { index: 10, value: '--textconv', role: 'read_path', cwdChanges: ['../repo with spaces'] });
  assert.ok(!parsed.effects.includes('arbitrary_code'));
  const head = analyzeCommand(createSpec('head', ['-n', '10', '--', 'a b.sh']));
  assert.deepEqual(head.arguments.map(a => a.role), ['option', 'option_value', 'option', 'read_path']);
  assert.equal(head.reasons.length, 0);
  const foreign = analyzeCommand(createSpec('cat.exe', ['--', 'C:\\space dir\\format.ts']));
  assert.deepEqual(foreign.effects, ['workspace_read']);
});

test('writes, helpers, configuration overrides and unsupported Git syntax cannot be classified as bounded reads', () => {
  for (const args of [
    ['show', '--output=result.txt'], ['show', '--output', '../outside file'],
    ['show', '--ext-diff'], ['diff', '--textconv'], ['show', '--show-signature'], ['show', '--remerge-diff'],
    ['-c', 'diff.external=helper', 'show'], ['--config-env=core.pager=PAGER', 'show'],
    ['--exec-path=/tmp/helpers', 'show'], ['--paginate', 'show'], ['--git-dir', '../other', 'show'],
    ['show', '--submodule=diff'], ['show', '--unknown-option'], ['show', '--', ':(top)**/*.ts']
  ]) {
    const spec = createSpec('git', args);
    assert.ok(analyzeCommand(spec).reasons.length > 0, JSON.stringify(args));
    assert.notEqual(analyzeDraftRunEffects(spec).verdict, 'likely_readonly');
  }
  assert.ok(analyzeDraftRunEffects(createSpec('git', ['show', '--output=result.txt'])).effects.includes('workspace_write'));
  assert.ok(analyzeDraftRunEffects(createSpec('git', ['show', '--ext-diff'])).effects.includes('arbitrary_code'));
});

test('scripts and unknown programs stay conservative regardless of their reason or filename', () => {
  for (const [executable, args] of [
    ['bun', ['run', 'script.ts']], ['node', ['script.js']], ['sh', ['script.sh']],
    ['sh', ['-c', 'cat "a b.ts"']], ['node', ['-e', 'console.log("hello")']], ['custom-reader', ['README.md']]
  ] as Array<[string, string[]]>) {
    const spec = { ...createSpec(executable, args), reason: 'Absolutely safe, approved by the model' };
    assert.ok(analyzeCommand(spec).reasons.length > 0);
    assert.ok(analyzeDraftRunEffects(spec).effects.includes('unknown'));
    if (executable !== 'custom-reader') assert.ok(analyzeDraftRunEffects(spec).effects.includes('arbitrary_code'));
  }
  const externalRead = { ...createSpec('cat', ['file.ts']), externalCwd: true };
  assert.deepEqual(analyzeDraftRunEffects(externalRead).effects, ['workspace_read'], 'external cwd is not itself a write');
  assert.ok(analyzeCommand({ ...externalRead, env: [{ name: 'LD_PRELOAD', value: '/tmp/code.so' }] })
    .reasons.some(reason => reason.code === 'environment_override'));
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
