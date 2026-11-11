import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import './registerVscodeStub';
import * as vscode from './stubs/vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { ApprovalReviewerService } from '../src/approvals/approvalReviewer';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { createDraftRunReviewRequest } from '../src/approvals/approvalReviewSurface';
import { analyzeCommand, analyzeDraftRunEffects, assertAutomaticRunAuthorization, draftRunIdentity,
  ExactOperationGrants, inspectAutomaticRunAuthorization, inspectGitCommandReplan } from '../src/approvals/authorization';
import { analyzeCommandCapability, normalizeCommandCapabilityDiagnostic } from '../src/approvals/authorization/commandCapability';
import { inspectLocalGitScope } from '../src/approvals/authorization/localGitScope';
import { hasValidationBlockingRisk } from '../src/agent/tools/validationRisk';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { createDraftRunProposal, type DraftRunProposalInput } from '../src/runs/draftRunProposal';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { createControlledEnvironment } from '../src/runs/executionEnvironment';
import type { DraftRun, DraftRunSpec } from '../src/shared/types';

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

test('Git tag list consumes option values and literal patterns without granting ref writes', () => {
  for (const args of [
    ['tag'], ['tag', '--list'], ['tag', '-l', 'release-2'], ['tag', '--list', 'v0.5*'],
    ['tag', '--sort=version:refname', '-l', 'release-[12]*', '发布?'],
    ['tag', '-l', '--sort', '-v:refname', '--', 'v0.5*', 'release?']
  ]) {
    const parsed = analyzeCommand(createSpec('git', args));
    assert.equal(parsed.gitTagQuery, true, JSON.stringify(args));
    assert.deepEqual(parsed.effects, ['workspace_read']);
    assert.equal(parsed.arguments.some(argument => argument.role === 'read_path'), false);
  }
  for (const args of [
    ['tag', '-l', '--delete', 'release-2'], ['tag', '--force', '-l'], ['tag', '-l', '--sign', 'release'],
    ['tag', '--sort', '--list'], ['tag', '--list', '--sort'], ['tag', '--sort=-v:refname', 'release'],
    ['tag', '--list', '--sort=unknown'], ['tag', '--contains', 'HEAD']
  ]) assert.equal(analyzeCommand(createSpec('git', args)).gitTagQuery, undefined, JSON.stringify(args));
  const redirected = analyzeCommand(createSpec('git', ['--git-dir', '/tmp/untrusted', 'tag', '-l', 'release*']));
  assert.ok(redirected.reasons.some(reason => reason.code === 'git_configuration'));
});

test('finite Git queries distinguish revisions, ranges, peeling and explicit paths', () => {
  for (const [args, kind, revisions] of [
    [['log', '--oneline', '--no-decorate', '0.5.0..HEAD'], 'log', ['0.5.0..HEAD']],
    [['tag', '--list', '0.5.0'], 'tag_list', []],
    [['merge-base', '--is-ancestor', '0.5.0', 'HEAD'], 'ancestor', ['0.5.0', 'HEAD']],
    [['rev-parse', 'HEAD^{tree}', 'HEAD', '0.5.0^{commit}'], 'revision_parse', ['HEAD^{tree}', 'HEAD', '0.5.0^{commit}']],
    [['rev-list', '--count', '0.5.0..HEAD'], 'revision_count', ['0.5.0..HEAD']]
  ] as Array<[string[], string, string[]]>) {
    const analysis = analyzeCommandCapability(createSpec('git', args));
    assert.equal(analysis.supported, true, JSON.stringify(args));
    assert.deepEqual(analysis.semantics.gitLocalQuery, { kind, revisions });
    assert.deepEqual(analysis.semantics.effects, ['workspace_read']);
    assert.deepEqual(analysis.semantics.reasons.map(item => item.code), ['git_runtime']);
    assert.equal(analysis.semantics.arguments.some(item => item.role === 'read_path'), false);
  }
  const paths = analyzeCommand(createSpec('git', ['log', '--oneline', '0.5.0..HEAD', '--', '../external/file.ts']));
  assert.equal(paths.arguments.at(-1)?.role, 'read_path');
  assert.equal(paths.arguments.find(item => item.value === '0.5.0..HEAD')?.role, 'revision');
  assert.equal(analyzeCommand(createSpec('git', ['show', '0.5.0^{commit}'])).arguments.at(-1)?.role, 'revision');
});

test('Git log pickaxe keeps bounded patterns out of path and revision scope', () => {
  for (const patternArgs of [
    ['-S', 'trace.enabled'], ['-Strace.enabled'], ['-G', 'trace[.]enabled'], ['-Gtrace[.]enabled'],
    ['-S', 'trace[.]enabled', '--pickaxe-regex'], ['-Strace[.]enabled', '--pickaxe-regex'],
    ['-S', 'HEAD'], ['-G', '../external/file.ts'], ['-S', 'x'.repeat(4_096)]
  ]) {
    const args = ['log', '--oneline', ...patternArgs, '--', 'package.json'];
    const spec = createSpec('git', args);
    const before = JSON.stringify(spec);
    const analysis = analyzeCommandCapability(spec);
    assert.equal(analysis.supported, true, JSON.stringify(patternArgs));
    assert.deepEqual(analysis.semantics.gitLocalQuery, { kind: 'log', revisions: [] });
    assert.deepEqual(analysis.semantics.effects, ['workspace_read']);
    assert.deepEqual(analysis.semantics.reasons.map(item => item.code), ['git_runtime']);
    assert.equal(analysis.diagnostics.some(item => item.blocking), false);
    assert.deepEqual(analysis.semantics.arguments.filter(item => item.role === 'read_path').map(item => item.value), ['package.json']);
    const value = patternArgs[0].length > 2 ? patternArgs[0].slice(2) : patternArgs[1];
    assert.ok(analysis.semantics.arguments.some(item => item.role === 'option_value' && item.value === value));
    assert.equal(JSON.stringify(spec), before);
  }
  const revisions = analyzeCommandCapability(createSpec('git', ['log', '-S', 'HEAD', '0.5.0..HEAD', '--', 'package.json']));
  assert.deepEqual(revisions.semantics.gitLocalQuery, { kind: 'log', revisions: ['0.5.0..HEAD'] });
});

test('Git log pickaxe rejects missing or invalid values without admitting other options', () => {
  for (const option of ['-S', '-G']) {
    for (const args of [['log', option], ['log', option, '--', 'package.json']]) {
      const missing = analyzeCommandCapability(createSpec('git', args));
      assert.equal(missing.supported, false);
      assert.equal(missing.semantics.gitLocalQuery, undefined);
      assert.deepEqual(missing.diagnostics.filter(item => item.blocking).map(item => ({
        code: item.code, category: item.category, index: item.argumentIndex, token: item.token
      })), [{ code: 'host_missing_option_value', category: 'invalid_argv', index: 1, token: option }]);
    }
    for (const value of ['', '  ', 'bad\0pattern', 'x'.repeat(4_097), '中'.repeat(1_366), 'x'.repeat(10_000)]) {
      for (const attached of value ? [false, true] : [false]) {
        const args = ['log', '--oneline', ...(attached ? [option + value] : [option, value]), '--', 'package.json'];
        const invalid = analyzeCommandCapability(createSpec('git', args));
        assert.equal(invalid.supported, false);
        assert.equal(invalid.semantics.gitLocalQuery, undefined);
        const diagnostic = invalid.diagnostics.find(item => item.blocking)!;
        assert.equal(diagnostic.code, 'host_invalid_argv');
        assert.equal(diagnostic.category, 'invalid_argv');
        assert.equal(diagnostic.argumentIndex, attached ? 2 : 3);
        assert.equal(diagnostic.token, attached ? option + value : value);
        assert.deepEqual(normalizeCommandCapabilityDiagnostic(diagnostic), diagnostic);
      }
    }
  }
  for (const option of ['--follow', '--since', '--until', '--author']) {
    const analysis = analyzeCommandCapability(createSpec('git', ['log', '--oneline', option, '--', 'x']));
    assert.equal(analysis.supported, false, option);
    assert.ok(analysis.diagnostics.some(item => item.blocking && item.code === 'host_unsupported_option' && item.argumentIndex === 2));
  }
  assert.equal(analyzeCommandCapability(createSpec('git', ['diff', '-S', 'pattern'])).supported, false);
  assert.equal(analyzeCommandCapability(createSpec('git', ['show', '--pickaxe-regex'])).supported, false);
});

test('Git log diagnostics offer a validated patch query while preserving old v1 pickaxe diagnostics', () => {
  const analysis = analyzeCommandCapability(createSpec('git', ['log', '--future-option']));
  assert.ok(analysis.supportedForms.some(form => form.includes('-S <value>') && form.includes('-G<value>')));
  assert.ok(analysis.supportedForms.includes('git --no-pager log -p --oneline -- <path>'));
  const alternative = analyzeCommandCapability(createSpec('git', ['--no-pager', 'log', '-p', '--oneline', '--', 'package.json']));
  assert.equal(alternative.supported, true);
  assert.deepEqual(alternative.semantics.gitLocalQuery, { kind: 'log', revisions: [] });
  assert.deepEqual(alternative.semantics.effects, ['workspace_read']);
  assert.deepEqual(alternative.semantics.reasons.map(item => item.code), ['git_runtime']);
  // A stored pre-extension diagnostic remains historical evidence even though
  // a newly proposed -S query is now syntactically supported.
  const persisted = { code: 'host_unsupported_option', phase: 'capability', started: false,
    category: 'capability', argumentIndex: 2, token: '-S',
    reason: 'This argument or behavior is outside the host command grammar. / 该参数或行为不在宿主命令语法内。',
    capabilityVersion: 1, blocking: true };
  const restored = normalizeCommandCapabilityDiagnostic(JSON.parse(JSON.stringify(persisted)));
  assert.ok(restored);
  assert.deepEqual({ ...restored, candidateArgs: undefined }, { ...persisted, candidateArgs: undefined });
});

test('capability diagnostics preserve exact argv and never invent generic flag deletion', () => {
  const spec = createSpec('git', ['log', '--oneline', '--future-option', '0.5.0..HEAD']);
  const before = JSON.stringify(spec);
  const analysis = analyzeCommandCapability(spec);
  assert.equal(analysis.supported, false);
  assert.equal(analysis.semantics.gitLocalQuery, undefined);
  const diagnostic = analysis.diagnostics.find(item => item.blocking)!;
  assert.equal(diagnostic.code, 'host_unsupported_option');
  assert.equal(diagnostic.phase, 'capability');
  assert.equal(diagnostic.started, false);
  assert.equal(diagnostic.argumentIndex, 2);
  assert.equal(diagnostic.token, '--future-option');
  assert.equal(diagnostic.candidateArgs, undefined);
  assert.equal(JSON.stringify(spec), before);
  for (const args of [
    ['merge-base', '--is-ancestor', 'HEAD'], ['merge-base', '--is-ancestor', 'HEAD', 'HEAD', 'HEAD'],
    ['rev-list', '--count'], ['rev-list', '--count', 'A...B'], ['rev-list', '--count', 'HEAD', 'other'],
    ['rev-parse', '../outside'], ['rev-parse', 'HEAD:../outside'], ['rev-parse', 'HEAD@{1}'],
    ['rev-parse', 'HEAD^{blob}'], ['log', '-n']
  ]) {
    const invalid = analyzeCommandCapability(createSpec('git', args));
    assert.equal(invalid.supported, false, JSON.stringify(args));
    assert.equal(invalid.semantics.gitLocalQuery, undefined);
    assert.ok(invalid.diagnostics.some(item => item.blocking && item.category === 'invalid_argv'));
  }
  const unsupported = analyzeCommandCapability(createSpec('git', ['rev-parse', '--output=/tmp/out']));
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.diagnostics[0].category, 'capability');
  assert.equal(unsupported.diagnostics[0].argumentIndex, 1);
  assert.equal(analyzeCommandCapability(createSpec('custom-command', ['--version'])).diagnostics[0].blocking, false);
});

test('capability recovery keeps missing launch facts unknown and accepts only bounded explicit static diagnostics', () => {
  const diagnostic = analyzeCommandCapability(createSpec('cat', ['--unknown'])).diagnostics[0];
  assert.deepEqual(normalizeCommandCapabilityDiagnostic(diagnostic), diagnostic);
  const legacy = { ...diagnostic } as Record<string, unknown>;
  delete legacy.started;
  assert.equal(normalizeCommandCapabilityDiagnostic(legacy), undefined);
  assert.equal(normalizeCommandCapabilityDiagnostic({ ...diagnostic, started: true }), undefined);
  assert.equal(normalizeCommandCapabilityDiagnostic({ ...diagnostic, capabilityVersion: 2 }), undefined);
  assert.equal(normalizeCommandCapabilityDiagnostic({ ...diagnostic, argumentIndex: -1 }), undefined);
  assert.equal(normalizeCommandCapabilityDiagnostic({ ...diagnostic, candidateArgs: ['bad\0arg'] }), undefined);
});

test('Git decoration synonyms have verified identical output without changing the original argv', async t => {
  if (process.platform === 'win32') return t.skip('POSIX Git fixture');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-decoration-')));
  try {
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: root, env: createControlledEnvironment([]), encoding: 'utf8', stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=Query Fixture', '-c', 'user.email=query@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'query fixture');
    git('tag', '0.5.0');
    git('-c', 'user.name=Query Fixture', '-c', 'user.email=query@example.invalid', '-c', 'commit.gpgsign=false',
      'commit', '--allow-empty', '-m', 'later fixture');
    const args = ['log', '--oneline', '--no-decorate', '0.5.0..HEAD'];
    const capability = analyzeCommandCapability(createSpec('git', args));
    assert.deepEqual(capability.equivalents, [{ argumentIndex: 2, token: '--no-decorate', replacement: '--decorate=no' }]);
    assert.equal(git(...args), git('log', '--oneline', '--decorate=no', '0.5.0..HEAD'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('bare Git log refs retain protected path checks for real worktree/index matches without inventing files for tags or ranges', async t => {
  if (process.platform === 'win32') return t.skip('POSIX Git fixture');
  const { workspace, createRun } = await projectScriptFixture(t);
  const env = createControlledEnvironment([]);
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: workspace, env, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  for (const file of ['credentials', 'cookies', 'README.md']) await writeFile(path.join(workspace, file), 'public fixture marker\n');
  git('add', '--', 'credentials', 'cookies', 'README.md');
  git('-c', 'user.name=Scope Fixture', '-c', 'user.email=scope@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'public fixture');
  git('tag', '0.5.0');
  await rm(path.join(workspace, 'cookies')); // Still indexed: absence on disk is not absence of a path operand.
  const grants = new ExactOperationGrants();
  for (const operand of ['credentials', 'cookies']) {
    // No log or file content is executed/read; the fixed index/config probes
    // establish the ambiguity and the host rejects it before dispatch.
    assert.throws(() => git('rev-parse', '--verify', '--end-of-options', `${operand}^{object}`));
    await assert.rejects(inspectAutomaticRunAuthorization(await createRun('/usr/bin/git', ['log', '--oneline', operand]), grants, 'delegate'), /Protected credential/u);
  }
  for (const operand of ['0.5.0', '0.5.0..HEAD', '0.5.0^{commit}']) {
    const authorization = await inspectAutomaticRunAuthorization(await createRun('/usr/bin/git', ['log', '--oneline', operand]), grants, 'delegate');
    assert.equal(authorization.allowed, true, operand);
    assert.equal(authorization.route, 'host_policy', operand);
    assert.equal(authorization.scope.paths.some(target => target.role === 'read_path'), false, 'a genuine revision is not a virtual filesystem target');
  }
  const ordinaryPath = await inspectAutomaticRunAuthorization(await createRun('/usr/bin/git', ['log', '--oneline', 'README.md']), grants, 'delegate');
  assert.equal(ordinaryPath.allowed, true);
  assert.ok(ordinaryPath.scope.paths.some(target => target.role === 'read_path' && target.uri === vscode.Uri.file(path.join(workspace, 'README.md')).toString()));
});

test('missing Git repository evidence is recoverable diagnosis while the original command remains unauthorized', async t => {
  if (process.platform === 'win32') return t.skip('POSIX Git fixture');
  const { createRun } = await projectScriptFixture(t);
  const run = await createRun('/usr/bin/git', ['log', '--oneline', '--no-decorate', 'HEAD']);
  const grants = new ExactOperationGrants();
  const decision = await inspectAutomaticRunAuthorization(run, grants, 'delegate');
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusal?.code, 'insufficient_launch_evidence');
  assert.match(decision.refusal.reason, /No Git repository/u);
  assert.equal(decision.scope.gitCwd, undefined);
  assert.equal(decision.scope.uncertain, true);
  await assert.rejects(assertAutomaticRunAuthorization(run, grants, decision.scope.fingerprint, 'delegate'), /Nothing executed/u);
  // Scope consent cannot manufacture missing executable/repository evidence.
  grants.grant(draftRunIdentity(run), decision.scope);
  const granted = await inspectAutomaticRunAuthorization(run, grants, 'delegate');
  assert.equal(granted.allowed, false);
  assert.equal(granted.refusal?.code, 'insufficient_launch_evidence');
});

test('missing Git evidence never downgrades explicit configuration or helper restrictions', async t => {
  if (process.platform === 'win32') return t.skip('POSIX Git fixture');
  const { createRun } = await projectScriptFixture(t);
  for (const args of [
    ['-c', 'core.pager=cat', 'log', '--oneline', 'HEAD'],
    ['log', '--show-signature', 'HEAD'],
    ['diff', '--ext-diff', 'HEAD']
  ]) {
    const run = await createRun('/usr/bin/git', args);
    const decision = await inspectAutomaticRunAuthorization(run, new ExactOperationGrants(), 'delegate');
    assert.equal(decision.allowed, false, JSON.stringify(args));
    assert.equal(decision.refusal?.code, 'hard_blocked', JSON.stringify(args));
    assert.equal(decision.scope.gitCwd, undefined);
    assert.ok(decision.scope.diagnostics.some(item => ['git_configuration', 'external_helper'].includes(item.code)));
  }
});

test('Git remote argv only recognizes bounded reads and non-forced explicit push refs', () => {
  const spec = (args: string[]) => analyzeCommand(createSpec('git', args)).gitRemote;
  assert.deepEqual(spec(['ls-remote', '--tags', 'upstream']), { kind: 'query', remote: 'upstream', namespace: 'tags', refs: [] });
  assert.deepEqual(spec(['push', '--atomic', 'upstream', 'refs/heads/trunk', 'refs/tags/release-1:refs/tags/release-1']),
    { kind: 'push', remote: 'upstream', refs: ['refs/heads/trunk', 'refs/tags/release-1'] });
  for (const args of [
    ['push', 'upstream'], ['push', '--tags', 'upstream'], ['push', '--force', 'upstream', 'refs/tags/release-1'],
    ['push', 'upstream', '+refs/tags/release-1'], ['push', 'upstream', ':refs/tags/release-1'],
    ['push', 'upstream', 'refs/tags/release-1:refs/tags/release-2'], ['push', 'upstream', 'refs/tags/release-*'],
    ['push', 'upstream', 'refs/heads/trunk', 'refs/tags/release-1'], ['ls-remote', 'upstream'],
    ['ls-remote', '--upload-pack', 'evil', 'upstream'], ['push', 'ext::evil', 'refs/tags/release-1']
  ]) assert.equal(spec(args), undefined, JSON.stringify(args));
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

test('Git replanning recognizes the exact pager query and keeps its original configuration override unapproved', () => {
  const spec = createSpec('git', ['-c', 'core.pager=cat', 'status', '--porcelain=v1']);
  const diagnosis = inspectGitCommandReplan(spec);
  assert.equal(diagnosis?.code, 'git_status_pager_override');
  assert.deepEqual(diagnosis?.candidateArgs, ['--no-pager', '--no-optional-locks', 'status', '--porcelain=v1']);
  assert.ok(analyzeCommand(spec).reasons.some(reason => reason.code === 'git_configuration'));
  assert.deepEqual(analyzeCommand({ ...spec, args: diagnosis!.candidateArgs! }).reasons.map(reason => reason.code), ['git_runtime']);

  for (const args of [
    ['-c', 'core.pager=cat', '-c', 'core.hooksPath=/tmp/hooks', 'status', '--porcelain=v1'],
    ['-c', 'core.pager=custom', 'status', '--porcelain=v1'],
    ['-c', 'core.worktree=/tmp/other', 'status', '--porcelain=v1'],
    ['--config-env=core.pager=PAGER', 'status', '--porcelain=v1'],
    ['status', '-c', 'core.pager=cat', '--porcelain=v1']
  ]) {
    assert.equal(inspectGitCommandReplan({ ...spec, args }), undefined);
  }
  assert.equal(inspectGitCommandReplan({ ...spec, env: [{ name: 'TERM', value: 'xterm' }] }), undefined);
});

test('Git commit preflight distinguishes exact messages, conflicting pathspecs and unsupported inputs', () => {
  const malformed = createSpec('git', ['commit', '-a', '-m', '中文标题', '-m', '正文第一段', '游离片段1', '游离片段2']);
  const diagnosis = inspectGitCommandReplan(malformed);
  assert.equal(diagnosis?.code, 'git_commit_all_with_pathspec');
  assert.match(diagnosis!.message, /7, 8/u);
  assert.deepEqual(analyzeCommand(malformed).arguments.slice(-2).map(operand => operand.role), ['read_path', 'read_path']);
  assert.throws(() => new DraftRunAuthorizationService().createUserClickPermit({
    spec: malformed
  } as Parameters<DraftRunAuthorizationService['createUserClickPermit']>[0]), /positional arguments 7, 8/u);
  for (const flag of ['-m', '-am', '--message']) {
    assert.equal(inspectGitCommandReplan(createSpec('git', ['commit', flag]))?.code, 'git_commit_missing_message_value');
  }
  assert.equal(inspectGitCommandReplan(createSpec('git', ['commit', '-a']))?.code, 'git_commit_missing_message');

  const messages = ['中文标题含 空格', '正文 $HOME \n 包含 ; & | 和 `'];
  for (const args of [
    ['commit', '-a', '-m', messages[0], '-m', messages[1]],
    ['commit', '-am', messages[0], `--message=${messages[1]}`],
    ['commit', `-am${messages[0]}`, '-m', messages[1]]
  ]) {
    const parsed = analyzeCommand(createSpec('git', args));
    assert.deepEqual(parsed.gitCommit, { all: true, messages });
    assert.equal(parsed.gitReplan, undefined);
    assert.deepEqual(parsed.reasons.map(reason => reason.code), ['git_runtime']);
  }
  for (const args of [
    ['commit', '--amend', '-m', 'rewrite'],
    ['commit', '--no-gpg-sign', '-m', 'bypass'],
    ['commit', '--allow-empty', '-m', 'force empty'],
    ['commit', '--file', '../message.txt'],
    ['commit', '-m', 'path-only', '--', 'file name']
  ]) {
    const parsed = analyzeCommand(createSpec('git', args));
    assert.equal(parsed.gitCommit, undefined);
    assert.equal(parsed.gitReplan, undefined);
    assert.ok(parsed.reasons.some(reason => reason.code === 'unsupported_option'));
  }
});

test('local Git scope binds commit -a worktree bytes and detects hook, operation and repository scope changes', async t => {
  if (process.platform === 'win32') return t.skip('POSIX Git and hook mode required');
  const executable = '/usr/bin/git';
  try {
    execFileSync(executable, ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('system Git is unavailable');
  }
  const repository = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-git-scope-')));
  try {
    const env = createControlledEnvironment([]);
    const git = (...args: string[]) => execFileSync(executable, args, { cwd: repository, env, stdio: 'pipe', encoding: 'utf8' });
    const scope = (subcommand: string, options?: { cwdChanges?: string[]; commitAll?: boolean; noIndexRefresh?: boolean }) =>
      inspectLocalGitScope({ executable, cwd: repository, roots: [repository], env, subcommand, noOptionalLocks: true,
        cwdChanges: options?.cwdChanges ?? [], commitAll: options?.commitAll, noIndexRefresh: options?.noIndexRefresh });
    git('init', '-q');
    git('config', 'user.name', 'Scope Fixture');
    git('config', 'user.email', 'scope-fixture@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.hooksPath', '.git/hooks');
    await mkdir(path.join(repository, 'subdir'));
    const tracked = path.join(repository, '有 空格.txt');
    await writeFile(tracked, 'start\n');
    git('add', '--all', '.');
    assert.ok('fingerprint' in await scope('commit'), 'unborn HEAD with staged contents is valid');
    git('commit', '-m', 'Fixture baseline');
    await writeFile(tracked, 'first\n');
    const first = await scope('commit', { commitAll: true });
    assert.ok('fingerprint' in first);
    const beforeStatus = git('--no-optional-locks', 'status', '--porcelain=v1', '-z');
    await writeFile(tracked, 'other\n');
    assert.equal(git('--no-optional-locks', 'status', '--porcelain=v1', '-z'), beforeStatus);
    const second = await scope('commit', { commitAll: true });
    assert.ok('fingerprint' in second);
    assert.notEqual(second.fingerprint, first.fingerprint);
    const nestedCwd = await scope('commit', { cwdChanges: ['subdir'], commitAll: true });
    assert.ok('reason' in nestedCwd && nestedCwd.hardBlocked);
    assert.match(nestedCwd.reason, /outside its working directory/u);

    const hook = path.join(repository, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const inactiveHook = await scope('commit', { commitAll: true });
    assert.ok('fingerprint' in inactiveHook);
    assert.notEqual(inactiveHook.fingerprint, second.fingerprint);
    await chmod(hook, 0o755);
    const activeHook = await scope('commit', { commitAll: true });
    assert.ok('reason' in activeHook);
    assert.match(activeHook.reason, /pre-commit/u);
    assert.ok(activeHook.binding);
    assert.ok('fingerprint' in await scope('status'));
    await rm(hook);

    const indexHook = path.join(repository, '.git', 'hooks', 'post-index-change');
    await writeFile(indexHook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const diffWithRefresh = await scope('diff');
    assert.ok('reason' in diffWithRefresh);
    assert.match(diffWithRefresh.reason, /post-index-change/u);
    assert.ok('fingerprint' in await scope('diff', { noIndexRefresh: true }));
    await rm(indexHook);

    await writeFile(path.join(repository, '.git', 'MERGE_HEAD'), git('rev-parse', 'HEAD'));
    const merging = await scope('commit', { commitAll: true });
    assert.ok('reason' in merging && merging.hardBlocked);
    assert.match(merging.reason, /merge, rebase/u);
    await rm(path.join(repository, '.git', 'MERGE_HEAD'));

    const nested = path.join(repository, 'nested-repo');
    git('init', '-q', nested);
    await writeFile(path.join(nested, 'file.txt'), 'nested');
    const embedded = await scope('add');
    assert.ok('reason' in embedded);
    assert.match(embedded.reason, /nested repository/u);
    await rm(nested, { recursive: true });

    await writeFile(path.join(repository, '.env'), 'fixture');
    const protectedFile = await scope('add');
    assert.ok('reason' in protectedFile && protectedFile.hardBlocked);
  } finally {
    await rm(repository, { recursive: true, force: true });
  }
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

test('auto approval binds a verified project script to its current identity and exact external operands', async t => {
  if (process.platform === 'win32') return t.skip('POSIX system shell verification required');
  const { root, workspace, shell, script, relativeScript, createRun } = await projectScriptFixture(t);
  const grants = new ExactOperationGrants();
  const run = await createRun(shell, [relativeScript]);
  const approval = await inspectAutomaticRunAuthorization(run, grants);
  assert.equal(approval.allowed, true);
  assert.equal(approval.route, 'host_policy', approval.reason);
  assert.equal(approval.scope.trustedProjectScript, true);
  assert.equal(approval.scope.executable, await realpath(shell));
  assert.ok(run.effectAssessment.effects.includes('arbitrary_code'), 'project code can still have runtime effects');

  const configPath = path.join(root, 'outside config.txt');
  await writeFile(configPath, 'outside data\n');
  const configUri = vscode.Uri.file(configPath).toString();
  const withConfig = await createRun(shell, [relativeScript, `--config=${configPath}`]);
  const outside = await inspectAutomaticRunAuthorization(withConfig, grants);
  assert.equal(outside.allowed, false);
  assert.deepEqual(outside.scope.externalUris, [configUri]);
  grants.grant(draftRunIdentity(withConfig), outside.scope);
  const granted = await inspectAutomaticRunAuthorization(withConfig, grants);
  assert.equal(granted.allowed, true);
  assert.notEqual(granted.route, 'host_policy');
  assert.deepEqual([...granted.authorizedUris], [configUri]);

  assert.equal(approval.scope.cwd, vscode.Uri.file(workspace).toString());
  await assertAutomaticRunAuthorization(run, grants, approval.scope.fingerprint);
  await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "new version"\n');
  const changed = await inspectAutomaticRunAuthorization(run, grants);
  assert.equal(changed.route, 'host_policy');
  assert.notEqual(changed.scope.fingerprint, approval.scope.fingerprint);
  await assert.rejects(assertAutomaticRunAuthorization(run, grants, approval.scope.fingerprint), /scope or launch identity changed/u);
  assert.equal((await inspectAutomaticRunAuthorization(withConfig, grants)).allowed, false, 'the grant is bound to the inspected script');
});

test('host policy approval executes a project script once and preserves its literal argv', async t => {
  if (process.platform === 'win32') return t.skip('POSIX system shell verification required');
  const { root, shell, script, relativeScript, createRun } = await projectScriptFixture(t);
  await writeFile(script, '#!/bin/sh\nprintf "%s\\n" "$1"\n');
  const value = '参数 ; $(printf unexpected)';
  const proposal = await createRun(shell, [relativeScript, value]);
  const globalStorageUri = vscode.Uri.file(root) as never;
  const reviews = new ApprovalReviewStore(globalStorageUri);
  const reviewer = new ApprovalReviewerService({ globalStorageUri, workspaceKey: 'project',
    sourceStore: new ModelSourceStore(globalStorageUri), store: reviews,
    requestText: async () => assert.fail('host policy must not request a model review') });
  const runs = new DraftRunStore(globalStorageUri, new SpawnDraftRunExecutor(), new DraftRunAuthorizationService(reviews));
  try {
    const [run] = runs.addProposals({ proposals: [proposal], sessionId: proposal.sessionId, agentRunId: proposal.agentRunId });
    const grants = new ExactOperationGrants();
    const { route, scope, authorizedUris } = await inspectAutomaticRunAuthorization(run, grants);
    assert.equal(route, 'host_policy');
    const { record } = await reviewer.createHostPolicyApproval({
      ...createDraftRunReviewRequest({ draftRun: run, scope, history: [], language: 'en' }),
      approvalMode: 'delegate', scopeFingerprint: scope.fingerprint
    });
    assert.equal(record.approvalSource, 'host_policy');
    assert.equal(record.decision, 'approve', record.rationale);
    assert.equal(record.risk, 'medium');
    assert.ok(record.policyRules.includes('trusted_project_script'));
    const result = await runs.approveAndRun(run.id, authorizedUris, {
      delegatedApproval: () => true,
      verifyScope: () => assertAutomaticRunAuthorization(run, grants, scope.fingerprint),
      approvalRecord: { ...record, expectedSource: route, workspaceTrusted: vscode.workspace.isTrusted }
    });
    assert.equal(result?.status, 'done', result?.error);
    assert.equal(result.exitCode, 0);
    assert.equal(runs.toWebviewState(run.sessionId)[0].output, `${value}\n`);
    assert.ok(reviews.get(record.reviewId)?.consumedAt);
    assert.equal(await runs.approveAndRun(run.id, authorizedUris), undefined);
  } finally {
    await runs.flush();
    runs.dispose();
  }
});

test('inline shell, PATH shims and external scripts do not inherit project script approval', async t => {
  if (process.platform === 'win32') return t.skip('POSIX system shell and symlinks required');
  const { root, workspace, shell, relativeScript, createRun } = await projectScriptFixture(t);
  const grants = new ExactOperationGrants();
  const outsideScript = path.join(root, 'outside.sh');
  await writeFile(outsideScript, '#!/bin/sh\nexit 0\n');
  const escapedScript = './linked.sh';
  await symlink(outsideScript, path.join(workspace, escapedScript));
  const interpreter = path.basename(shell);
  const shim = path.join(workspace, interpreter);
  await writeFile(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  for (const run of [
    await createRun(shell, ['-c', 'printf hello']),
    await createRun(shim, [relativeScript]),
    await createRun(interpreter, [relativeScript], [{ name: 'PATH', value: workspace }]),
    await createRun(shell, ['./missing.sh'])
  ]) {
    const approval = await inspectAutomaticRunAuthorization(run, grants);
    assert.equal(approval.route, 'user_click', JSON.stringify(run.spec));
    assert.notEqual(approval.scope.trustedProjectScript, true);
  }

  for (const operand of [outsideScript, escapedScript]) {
    const approval = await inspectAutomaticRunAuthorization(await createRun(shell, [operand]), grants);
    assert.equal(approval.allowed, false);
    assert.notEqual(approval.scope.trustedProjectScript, true);
    assert.deepEqual(approval.scope.externalUris, [vscode.Uri.file(outsideScript).toString()]);
  }
});

test('controlled validation retains its narrow blocking policy', () => {
  assert.equal(hasValidationBlockingRisk('bun run compile'), false);
  assert.equal(hasValidationBlockingRisk('git status --short'), false);
  assert.equal(hasValidationBlockingRisk('npm install lodash'), true);
  assert.equal(hasValidationBlockingRisk('git push origin main'), true);
});

async function projectScriptFixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-script-scope-')));
  const { workspaceFolders, isTrusted } = vscode.workspace;
  t.after(async () => {
    vscode.workspace.workspaceFolders = workspaceFolders;
    vscode.workspace.isTrusted = isTrusted;
    await rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'workspace' }];
  vscode.workspace.isTrusted = true;
  // Some Linux distributions make /bin/sh a differently named interpreter.
  const shell = path.basename(await realpath('/bin/sh')) === 'sh' ? '/bin/sh' : '/bin/bash';
  const relativeScript = './项目 script.sh';
  const script = path.join(workspace, relativeScript);
  await writeFile(script, '#!/bin/sh\nexit 0\n');
  const createRun = async (executable: string, args: string[], env?: DraftRunProposalInput['env']): Promise<DraftRun> => {
    const proposal = await createDraftRunProposal({ executable, args, env, reason: 'Run the project script' });
    const now = new Date().toISOString();
    return {
      ...proposal, sessionId: 'session', agentRunId: 'run', messageId: 'message', status: 'pending',
      outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0,
      createdAt: now, updatedAt: now
    };
  };
  return { root, workspace, shell, script, relativeScript, createRun };
}

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
