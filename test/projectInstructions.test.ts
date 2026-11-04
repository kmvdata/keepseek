import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { hashContent, ProjectInstructionsResolver, truncateUtf8 } from '../src/agent/projectInstructions';
import { loadSharedCodexConfig, parseSharedCodexConfig } from '../src/context/sharedCodexConfig';
import { codexHomeUri, projectSkillsUri, resolveSharedScope, userSkillsUri } from '../src/context/sharedConfigPaths';
import { SkillDiscovery } from '../src/skills/skillDiscovery';
import { SkillActivationResolver } from '../src/skills/skillActivationResolver';
import { SharedProjectSources } from '../src/context/sharedProjectSources';
import { buildCurrentRunContext } from '../src/agent/currentRunContext';
import { formatCurrentRunContextForAgent } from '../src/agent/protocol';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { createContextUsageEstimate, createContextUsageEstimateFromMessages, createContextUsageEstimateFromResponses, createContextUsageEstimateFromAnthropic } from '../src/agent/contextUsage';
import { normalizeStoredSessions, createEmptySession } from '../src/sessions/chatSessionStore';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(git = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-shared-config-'))); roots.push(root);
  const repo = path.join(root, 'repo'); const cwd = path.join(repo, 'src/子目录'); const home = path.join(root, 'codex');
  await mkdir(cwd, { recursive: true }); await mkdir(home); if (git) await writeFile(path.join(repo, '.git'), 'gitdir: /unused/worktree');
  const folders = [{ uri: vscode.Uri.file(repo), name: 'project', index: 0 }];
  return { root, repo, cwd, home, folders, options: { cwd: vscode.Uri.file(cwd), folders, codexHome: vscode.Uri.file(home), trusted: true } };
}
test('global override and root-to-cwd instructions preserve order, empty override falls back; unrelated descendants never load', async () => {
  const f = await fixture();
  await writeFile(path.join(f.home, 'AGENTS.md'), 'GLOBAL_BASE'); await writeFile(path.join(f.home, 'AGENTS.override.md'), 'GLOBAL_OVERRIDE');
  await writeFile(path.join(f.repo, 'AGENTS.md'), 'ROOT'); await writeFile(path.join(f.repo, 'src/AGENTS.override.md'), '   \n');
  await writeFile(path.join(f.repo, 'src/AGENTS.md'), 'MIDDLE'); await writeFile(path.join(f.cwd, 'AGENTS.override.md'), 'LOCAL');
  await writeFile(path.join(f.cwd, 'AGENTS.md'), 'IGNORED'); await mkdir(path.join(f.cwd, 'nested')); await writeFile(path.join(f.cwd, 'nested/AGENTS.md'), 'IGNORED');
  const resolver = new ProjectInstructionsResolver(); const result = await resolver.resolve(f.options);
  assert.deepEqual(result.instructions.map(item => item.content), ['GLOBAL_OVERRIDE', 'ROOT', 'MIDDLE', 'LOCAL']);
  assert.deepEqual(await resolver.resolve(f.options), result);
  assert.equal(result.instructions[1].contentHash, hashContent('ROOT'));
});
test('config layer arrays replace, fallback selects one file per directory; secrets and unsupported fields never leave parser', async () => {
  const f = await fixture(); await mkdir(path.join(f.repo, '.codex')); await mkdir(path.join(f.cwd, '.codex'));
  await writeFile(path.join(f.home, 'config.toml'), 'project_doc_fallback_filenames=["GLOBAL.md"]\nproject_doc_max_bytes=500\napi_key="SECRET_CANARY"\n[unknown]\nvalid=true');
  await writeFile(path.join(f.repo, '.codex/config.toml'), 'project_doc_fallback_filenames=["ROOT.md"]');
  await writeFile(path.join(f.cwd, '.codex/config.toml'), 'project_doc_fallback_filenames=["TEAM.md", "EXTRA.md"]\napproval_policy="never"');
  await writeFile(path.join(f.cwd, 'TEAM.md'), 'TEAM'); await writeFile(path.join(f.cwd, 'EXTRA.md'), 'EXTRA');
  const config = await loadSharedCodexConfig(f.options);
  assert.deepEqual(config.fallbackFilenames, ['TEAM.md', 'EXTRA.md']); assert.equal(config.projectDocMaxBytes, 500);
  assert.doesNotMatch(JSON.stringify(config), /SECRET_CANARY|api_key|approval_policy/u);
  assert.equal(config.origins.project_doc_fallback_filenames, vscode.Uri.file(path.join(f.cwd, '.codex/config.toml')).toString());
  const result = await new ProjectInstructionsResolver().resolve({ snapshot: config });
  assert.deepEqual(result.instructions.map(item => item.content), ['TEAM']);
});
test('project document byte budget is shared, UTF-8 safe, deterministic and separately bounded from total context', async () => {
  const f = await fixture(); await writeFile(path.join(f.home, 'config.toml'), 'project_doc_max_bytes=8');
  await writeFile(path.join(f.repo, 'AGENTS.md'), '中文😀tail'); await writeFile(path.join(f.cwd, 'AGENTS.md'), 'LOCAL');
  const result = await new ProjectInstructionsResolver().resolve(f.options);
  assert.equal(result.instructions[0].content, '中文'); assert.equal(result.instructions[0].truncated, true);
  assert.ok(result.instructions.reduce((n, item) => n + Buffer.byteLength(item.content), 0) <= 8);
  assert.equal(truncateUtf8('😀abc', 3), ''); assert.equal(truncateUtf8('😀abc', 4), '😀');
});
test('subdirectory-opened worktree locates repository; no Git uses cwd only; multi-root requires a choice', async () => {
  const f = await fixture(); const subFolder = { uri: vscode.Uri.file(f.cwd), name: 'sub', index: 0 };
  const scope = await resolveSharedScope({ folders: [subFolder], trusted: true });
  assert.equal(scope?.root.fsPath, f.repo); assert.equal(scope?.chain.length, 3);
  const noGit = await fixture(false); const local = await resolveSharedScope(noGit.options);
  assert.deepEqual(local?.chain.map(uri => uri.fsPath), [noGit.cwd]);
  assert.equal(await resolveSharedScope({ folders: [...f.folders, ...noGit.folders] }), undefined);
  await assert.rejects(resolveSharedScope({ folders: f.folders, cwd: vscode.Uri.file(noGit.cwd), trusted: true }));
});
test('untrusted workspace reads no project config, instructions or skills even if Codex trust says trusted', async () => {
  const f = await fixture(); await mkdir(path.join(f.repo, '.codex'));
  await writeFile(path.join(f.repo, '.codex/config.toml'), 'invalid [[ TOML'); await writeFile(path.join(f.repo, 'AGENTS.md'), 'PROJECT');
  await writeFile(path.join(f.home, 'AGENTS.md'), 'GLOBAL');
  await writeFile(path.join(f.home, 'config.toml'), `[projects.${JSON.stringify(f.repo)}]\ntrust_level="trusted"`);
  const result = await new ProjectInstructionsResolver().resolve({ ...f.options, trusted: false });
  assert.deepEqual(result.instructions.map(item => item.content), ['GLOBAL']); assert.ok(result.discarded.some(item => item.reason === 'workspace_untrusted'));
});
test('user Skill rules apply in order by exact name or physical path and cannot be bypassed by explicit/session/default selection', async () => {
  const f = await fixture(); const skill = path.join(f.repo, '.agents/skills/demo'); await mkdir(skill, { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: demo\ndescription: demo\n---\nBody');
  await writeFile(path.join(f.home, 'config.toml'), `[[skills.config]]\nname="demo"\nenabled=true\n[[skills.config]]\npath=${JSON.stringify(path.join(skill, 'SKILL.md'))}\nenabled=false\n`);
  const config = await loadSharedCodexConfig(f.options);
  const manifests = await new SkillDiscovery({ includeUserSkills: false, includeAdminSkills: false }).discover(config);
  assert.equal(manifests.length, 1); assert.equal(manifests[0].enabled, false);
  const id = manifests[0].id;
  const result = new SkillActivationResolver().resolve({ manifests, prompt: 'demo', explicitSkillIds: [id], sessionSkillIds: [id], workspaceDefaultSkillIds: [id], workspaceTrusted: true, maxImplicitSkills: 3 });
  assert.equal(result.activated.length, 0); assert.match(manifests[0].unavailableReason ?? '', /config.toml/u);
});
test('malformed supported policies fail closed with redacted diagnostics; ineffective project skill rules are explicitly blocked', async () => {
  const f = await fixture();
  await writeFile(path.join(f.home, 'config.toml'), 'api_key = "SECRET_CANARY"\n[[skills.config]]\nname="x"\nenabled="false"');
  let config = await loadSharedCodexConfig(f.options);
  assert.equal(config.diagnostics[0].blocksSkills, true); assert.doesNotMatch(JSON.stringify(config), /SECRET_CANARY/u);
  await writeFile(path.join(f.home, 'config.toml'), ''); await mkdir(path.join(f.repo, '.codex'));
  await writeFile(path.join(f.repo, '.codex/config.toml'), '[[skills.config]]\nname="x"\nenabled=false');
  config = await loadSharedCodexConfig(f.options); assert.match(config.diagnostics[0].message, /0.133.0 ignores project/u);
  for (const text of ['project_doc_max_bytes="x"', 'project_doc_max_bytes=-1', 'project_doc_fallback_filenames=["../secret"]', 'project_doc_max_bytes=1\nproject_doc_max_bytes=2', 'skills.config="bad"', '[[skills.config]]\nname="x"\npath="/x/SKILL.md"\nenabled=false', '[[skills.config]]\npath="relative/SKILL.md"\nenabled=false']) {
    await assert.rejects(parseSharedCodexConfig(text, 'file:///config.toml'));
  }
  await assert.rejects(parseSharedCodexConfig('x'.repeat(1_048_577), 'file:///config.toml'));
  const parsed = await parseSharedCodexConfig('project_doc_fallback_filenames = [\n "TEAM.md", # comment\n]\n[unknown]\ntext="""a\nb"""', 'file:///config.toml');
  assert.deepEqual(parsed.fallbackFilenames, ['TEAM.md']);
});
test('CODEX_HOME changes config/instructions only and never relocates ~/.agents/skills', () => {
  assert.equal(codexHomeUri('/home/example', '/custom/codex').fsPath, '/custom/codex');
  assert.equal(userSkillsUri('/home/example').fsPath, '/home/example/.agents/skills');
  assert.equal(projectSkillsUri(vscode.Uri.file('/work')).fsPath, '/work/.agents/skills');
  assert.throws(() => codexHomeUri('/home/example', 'relative'));
});

test('source snapshots freeze until host refresh; refreshed contexts are byte-stable in all three projections without rewriting history', async () => {
  const f = await fixture(); const previousHome = process.env.CODEX_HOME;
  const previousFolders = vscode.workspace.workspaceFolders; const previousTrust = vscode.workspace.isTrusted;
  process.env.CODEX_HOME = f.home; Object.assign(vscode.workspace, { workspaceFolders: f.folders, isTrusted: true });
  const sources = new SharedProjectSources();
  try {
    await writeFile(path.join(f.repo, 'AGENTS.md'), 'ORIGINAL');
    const snapshot = await sources.refresh('session', vscode.Uri.file(f.cwd).toString());
    await writeFile(path.join(f.repo, 'AGENTS.md'), 'REFRESHED');
    sources.dirty = true;
    assert.equal(sources.instructions.instructions[0].content, 'ORIGINAL');
    assert.equal(sources.snapshot, snapshot);
    await sources.refresh('session', vscode.Uri.file(f.cwd).toString());
    const context = buildCurrentRunContext({ projectInstructions: sources.instructions, skills: [], skillCharacterBudget: 10000 });
    const text = formatCurrentRunContextForAgent({ currentRunContext: context, contextFiles: [], language: 'en' });
    const repeated = await sources.refresh('session', vscode.Uri.file(f.cwd).toString());
    assert.equal(repeated.fingerprint, snapshot.fingerprint, 'document body is separate from config policy identity');
    assert.equal(formatCurrentRunContextForAgent({ currentRunContext: buildCurrentRunContext({ projectInstructions: sources.instructions, skills: [], skillCharacterBudget: 10000 }), contextFiles: [], language: 'en' }), text);
    assert.match(text, /REFRESHED/u);
    for (const name of ['SKILL.md', 'agents/openai.yaml', '.codex/config.toml', 'AGENTS.override.md']) assert.equal(sources.matches(vscode.Uri.file(path.join(f.cwd, name)).toString()), true);
    const history = [{ id: 'old', role: 'user' as const, content: 'original user bytes', expandedContent: 'expanded original bytes', createdAt: '2026-11-04' }];
    const originalHistory = JSON.stringify(history);
    for (const provider of ['deepseek', 'openai-responses', 'anthropic-compatible'] as const) {
      const input = { model: { id: 'test', label: 'Test', provider, contextWindowTokens: 128000, maxOutputTokens: 1000 },
        agentSettings: { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const },
        contextFiles: [], currentRunContext: context, contextInstructions: text, history, prompt: 'next', language: 'en' as const,
        provider, requestProtocolVersion: 11, sourceId: 'fixture', baseUrl: 'https://fixture.invalid/v1' };
      const projection = buildProviderRequestProjection(input);
      assert.deepEqual(buildProviderRequestProjection(input), projection);
      assert.match(JSON.stringify(projection), /REFRESHED/u);
      const usage = createContextUsageEstimate({ ...input, messages: history, outputReserveTokens: 1000 });
      const common = { model: input.model, outputReserveTokens: 1000 };
      const projectedUsage = projection.responses ? createContextUsageEstimateFromResponses({ ...common, ...projection.responses })
        : projection.anthropic ? createContextUsageEstimateFromAnthropic({ ...common, ...projection.anthropic })
        : createContextUsageEstimateFromMessages({ ...common, messages: projection.messages, tools: projection.tools });
      assert.equal(usage.usedTokensEstimate, projectedUsage.usedTokensEstimate);
      assert.equal(JSON.stringify(history), originalHistory);
    }
  } finally {
    sources.dispose(); if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
    Object.assign(vscode.workspace, { workspaceFolders: previousFolders, isTrusted: previousTrust });
  }
});

test('session normalization preserves chosen scope, immutable old context bytes and historical memory audit only', () => {
  const session = createEmptySession('en'); session.projectScopeUri = 'file:///workspace/sub'; session.contextInstructions = 'OLD STORED PREFIX';
  session.messages = [{ id: 'old', role: 'user', content: 'old user', createdAt: '2026-11-04' }];
  const scope = { key: session.workspaceKey, name: session.workspaceName, folderUris: session.workspaceFolders };
  const [normalized] = normalizeStoredSessions({ sessions: [session] }, scope);
  assert.equal(normalized.projectScopeUri, session.projectScopeUri); assert.equal(normalized.contextInstructions, session.contextInstructions);
  assert.equal(normalized.messages[0].content, 'old user');
  assert.equal(normalizeStoredSessions({ sessions: [{ ...session, projectScopeUri: 'https://outside.invalid' }] }, scope)[0].projectScopeUri, undefined);
  const [audit] = normalizeStoredSessions({ sessions: [{ ...session, messages: [{ ...session.messages[0],
    runDetails: { runId: 'historic', modelId: 'old-model', contextSources: [
      { id: 'old-memory', kind: 'legacy-memory', contentHash: 'old-hash' },
      { id: 'new-scope', kind: 'project-instructions', scopeUri: 'file:///workspace/sub', order: 2 }
    ], contextDiscarded: [{ id: 'same-name', kind: 'skill', reason: 'ambiguous_name' }] }
  }] }] }, scope);
  assert.equal(audit.messages[0].runDetails?.contextSources[0].kind, 'legacy-memory');
  assert.equal(audit.messages[0].runDetails?.contextSources[1].scopeUri, 'file:///workspace/sub');
  assert.equal(audit.messages[0].runDetails?.contextSources[1].order, 2);
  assert.equal(audit.messages[0].runDetails?.contextDiscarded[0].reason, 'ambiguous_name');
});
