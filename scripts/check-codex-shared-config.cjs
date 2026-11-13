#!/usr/bin/env node
// Offline acceptance: an isolated CODEX_HOME, no turn/start, model, MCP or user config writes.
// Run after bun run build:test. This is a diagnostic, not an extension runtime dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
require('../out-test/test/registerVscodeStub.js');
const vscode = require('../out-test/test/stubs/vscode.js');
const { SkillCreator } = require('../out-test/src/skills/skillCreator.js');
const { SkillDiscovery } = require('../out-test/src/skills/skillDiscovery.js');
const { loadSharedCodexConfig } = require('../out-test/src/context/sharedCodexConfig.js');

async function connect(cwd, home) {
  const child = spawn('codex', ['app-server', '--listen', 'stdio://'], {
    cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map(); let buffer = ''; let sequence = 0;
  const rejectAll = () => { for (const item of pending.values()) item.reject(new Error('Codex app-server exited')); pending.clear(); };
  child.on('error', rejectAll); child.on('exit', rejectAll); child.stderr.on('data', () => {});
  child.stdout.on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let response; try { response = JSON.parse(line); } catch { continue; }
      const item = pending.get(response.id); if (!item) continue;
      pending.delete(response.id); clearTimeout(item.timer);
      if (response.error) item.reject(new Error('Codex RPC rejected the fixture request'));
      else item.resolve(response.result);
    }
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex fixture RPC timed out')); child.kill(); }, 20000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  await request('initialize', { clientInfo: { name: 'keepseek_shared_config_acceptance', version: '1.0' }, capabilities: null });
  return { request, close: () => { for (const item of pending.values()) clearTimeout(item.timer); child.kill(); } };
}

(async () => {
  const version = spawnSync('codex', ['--version'], { encoding: 'utf8' }).stdout?.trim();
  assert.equal(version, 'codex-cli 0.133.0', 'This acceptance targets exactly Codex 0.133.0');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-shared-acceptance-')));
  const home = path.join(root, 'codex-home'); const repo = path.join(root, 'repo'); let connection;
  try {
    await fs.mkdir(home); await fs.mkdir(repo); await fs.mkdir(path.join(repo, '.git')); await fs.mkdir(path.join(repo, '.codex'));
    const folder = { uri: vscode.Uri.file(repo), name: 'acceptance', index: 0 };
    Object.assign(vscode.workspace, { workspaceFolders: [folder], isTrusted: true });
    const creator = new SkillCreator();
    for (const name of ['shared-alpha', 'shared-beta']) {
      const draft = creator.createDraft({ workspaceFolder: folder, rawName: name, description: 'Shared review: inspect evidence', allowImplicit: false, language: 'en' });
      for (const file of draft.files) { await fs.mkdir(path.dirname(file.targetUri.fsPath), { recursive: true }); await fs.writeFile(file.targetUri.fsPath, file.content); }
    }
    await fs.appendFile(path.join(repo, '.agents/skills/shared-beta/agents/openai.yaml'), 'interface:\n  display_name: Shared Beta Display\n');
    const userConfig = `project_doc_fallback_filenames=["GLOBAL.md"]\n[projects.${JSON.stringify(repo)}]\ntrust_level="trusted"\n[[skills.config]]\nname="shared-alpha"\nenabled=false\n`;
    await fs.writeFile(path.join(home, 'config.toml'), userConfig);
    await fs.writeFile(path.join(repo, '.codex/config.toml'), 'project_doc_fallback_filenames=["LOCAL.md"]\n');
    connection = await connect(repo, home);
    async function list() {
      const response = await connection.request('skills/list', { cwds: [repo], forceReload: true });
      const skills = response.data.flatMap(item => item.skills).filter(item => ['shared-alpha', 'shared-beta'].includes(item.name));
      return skills.sort((a, b) => a.name.localeCompare(b.name));
    }
    const codex = await list();
    assert.equal(codex.length, 2); assert.equal(codex[0].enabled, false); assert.equal(codex[1].enabled, true);
    assert.equal(codex[1].interface?.displayName, 'Shared Beta Display');
    const options = { folders: [folder], trusted: true, codexHome: vscode.Uri.file(home) };
    const discovery = new SkillDiscovery({ includeUserSkills: false, includeAdminSkills: false });
    const keepseek = await discovery.discover(await loadSharedCodexConfig(options));
    for (const skill of codex) {
      const peer = keepseek.find(item => item.name === skill.name);
      assert.equal(peer.enabled, skill.enabled); assert.equal(peer.allowImplicit, false);
      assert.equal(peer.skillUri.fsPath, skill.path);
    }
    await fs.writeFile(path.join(repo, '.codex/config.toml'), 'project_doc_fallback_filenames=["LOCAL.md"]\n[[skills.config]]\nname="shared-beta"\nenabled=false\n');
    const projectRules = await list(); assert.equal(projectRules[1].enabled, true);
    const merged = await connection.request('config/read', { cwd: repo, includeLayers: false });
    assert.deepEqual(merged.config.project_doc_fallback_filenames, ['LOCAL.md']);
    const blocked = await loadSharedCodexConfig(options); assert.ok(blocked.diagnostics.some(item => item.blocksSkills));
    assert.ok((await discovery.discover(blocked)).every(item => !item.enabled));
    console.log(JSON.stringify({ version, templateReadByBoth: true, matchingNamesAndPaths: true, yamlInterfaceReadByCodex: true,
      keepseekPolicyFalse: true, codexPolicyNotExposedByRpc: true, userDisableAppliedByBoth: true, fallbackArrayReplaces: true,
      projectSkillRule: { codex: 'ignored', keepseek: 'diagnostic and activation blocked' },
      modelTurns: 0, webviewTested: false }, null, 2));
  } finally { connection?.close(); await fs.rm(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
