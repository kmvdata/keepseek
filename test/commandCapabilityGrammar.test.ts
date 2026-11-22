import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeCommand } from '../src/approvals/authorization/commandSemantics';
import { analyzeCommandCapability } from '../src/approvals/authorization/commandCapability';
import type { DraftRunSpec } from '../src/shared/types';

function gitSpec(args: string[]): DraftRunSpec {
  return {
    executable: 'git',
    args,
    reason: 'fixture',
    cwdUri: 'file:///tmp/repo',
    cwdLabel: 'repo',
    externalCwd: false,
    timeoutMs: 30_000,
    env: []
  };
}

/**
 * The read-only `git ls-files` grammar. `--eol` is a value-less display option,
 * so it is a supported read; an option outside the finite list must still be
 * refused before dispatch, and none of this may turn the query into a mutation.
 */
test('ls-files --eol is a supported read-only local query', () => {
  const spec = gitSpec(['ls-files', '--eol', '--', 'x']);
  const semantics = analyzeCommand(spec);
  const capability = analyzeCommandCapability(spec);

  assert.equal(capability.supported, true, 'the dispatch must not be blocked');
  assert.deepEqual(capability.diagnostics, [], 'no blocking capability diagnostic is produced');
  assert.equal(semantics.program, 'git');
  assert.equal(semantics.arguments.find(arg => arg.role === 'subcommand')?.value, 'ls-files');
  assert.equal(semantics.effects.includes('workspace_read'), true, 'listing stays a workspace read');
  assert.notEqual(semantics.effects.includes('git_mutation'), true, 'it is never classified as a write');
  assert.notEqual(semantics.effects.includes('workspace_write'), true);
  const eol = semantics.arguments.find(arg => arg.value === '--eol');
  assert.equal(eol?.role, 'option', 'the option is consumed as an option, not as a path');
  const path = semantics.arguments.find(arg => arg.value === 'x');
  assert.equal(path?.role, 'read_path', 'the pathspec after -- is still scoped as a read');
});

test('ls-files --eol keeps its documented grammar in the correction hint', () => {
  const capability = analyzeCommandCapability(gitSpec(['ls-files', '--eol']));
  assert.equal(capability.supportedForms.length > 0, true, 'a supported form is shown for this query');
  const form = capability.supportedForms.join('\n');
  assert.match(form, /--eol/u, 'the displayed syntax must mention the option that was just accepted');
  assert.match(form, /--error-unmatch/u, 'the displayed syntax must match the real allowlist');
});

test('an unknown ls-files option is still refused before dispatch', () => {
  const spec = gitSpec(['ls-files', '--eol', '--stage-mtime-out', '--', 'x']);
  const capability = analyzeCommandCapability(spec);
  assert.equal(capability.supported, false, 'arbitrary option passthrough must stay impossible');
  const blocking = capability.diagnostics.find(item => item.blocking);
  assert.equal(blocking?.code, 'host_unsupported_option');
  assert.equal(blocking?.phase, 'capability');
  assert.equal(blocking?.started, false);
  assert.equal(blocking?.token, '--stage-mtime-out');
});

test('ls-files rejects an option that takes a value instead of accepting it', () => {
  // `--exclude` needs an operand the grammar does not model; it must not be
  // guessed as a bare option nor silently swallow the following pathspec.
  const capability = analyzeCommandCapability(gitSpec(['ls-files', '--exclude', 'x']));
  assert.equal(capability.supported, false);
  assert.equal(capability.diagnostics.some(item => item.code === 'host_unsupported_option'), true);
});

test('the existing ls-files forms used by the host stay supported', () => {
  for (const args of [
    ['ls-files', '--stage', '-z'],
    ['ls-files', '-s', '-z'],
    ['ls-files', '--error-unmatch', '--', 'a.ts'],
    ['ls-files']
  ]) {
    const capability = analyzeCommandCapability(gitSpec(args));
    assert.equal(capability.supported, true, `${args.join(' ')} must stay supported`);
  }
});

test('unrelated git queries keep their own capability verdicts', () => {
  // Control: widening ls-files must not widen any other subcommand grammar.
  const diff = analyzeCommandCapability(gitSpec(['diff', '--eol']));
  assert.equal(diff.supported, false, '--eol is ls-files-specific');
  const push = analyzeCommandCapability(gitSpec(['push', 'origin', 'main']));
  assert.equal(push.supported, true);
  assert.notEqual(analyzeCommand(gitSpec(['push', 'origin', 'main'])).effects.includes('workspace_write'), true);
});