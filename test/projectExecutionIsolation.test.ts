import './registerVscodeStub';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { getProjectExecutionMode, inspectProjectExecution, isProjectExecutionEnvNameSupported, prepareProjectExecution,
  ProjectExecutionUnavailableError, type PreparedProjectExecution } from '../src/runs/projectExecutionIsolation';
import { workspace } from './stubs/vscode';

function configure(t: TestContext, globalValue: 'host' | 'isolated' | undefined): void {
  t.mock.method(workspace, 'getConfiguration', () => ({
    get: <T>(_name: string, fallback: T) => fallback,
    inspect: () => ({ globalValue, workspaceValue: 'host' }),
    update: async () => undefined
  }));
}

async function fixture(t: TestContext): Promise<{ sandboxRoot: string; project: string }> {
  const sandboxRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-execution-test-')));
  t.after(() => rm(sandboxRoot, { recursive: true, force: true }));
  const project = path.join(sandboxRoot, 'project');
  await mkdir(project);
  return { sandboxRoot, project };
}

test('execution is isolated by default and workspace settings cannot select host execution', t => {
  configure(t, undefined);
  assert.equal(getProjectExecutionMode(), 'isolated');
  assert.equal(isProjectExecutionEnvNameSupported('NODE_ENV'), true);
  assert.equal(isProjectExecutionEnvNameSupported('LD_PRELOAD'), false);
  assert.equal(isProjectExecutionEnvNameSupported('SSH_AUTH_SOCK'), false);
});

test('the explicit host profile binds exact paths, argv and runtime and rejects a changed directory identity', async t => {
  configure(t, 'host');
  const { sandboxRoot, project } = await fixture(t);
  await assert.rejects(inspectProjectExecution(project, sandboxRoot, process.execPath), /verified project directory/u);
  await assert.rejects(inspectProjectExecution(path.parse(project).root, project, process.execPath), /verified project directory/u);
  await assert.rejects(inspectProjectExecution(tmpdir(), project, process.execPath), /verified project directory/u);
  const boundary = await inspectProjectExecution(project, project, process.execPath);
  assert.equal(boundary.kind, 'host');
  const args = ['-e', 'do not interpret me; $&', ''];
  const env = { NODE_ENV: 'test' };
  assert.deepEqual(await prepareProjectExecution(boundary, process.execPath, args, env),
    { executable: process.execPath, args, cwd: project, env });

  await rename(project, path.join(sandboxRoot, 'prior'));
  await mkdir(project);
  await assert.rejects(prepareProjectExecution(boundary, process.execPath, args, env), /environment changed/u);
});

test('a reviewed host launch cannot proceed after its setting is withdrawn', async t => {
  const global = { value: 'host' as 'host' | undefined };
  t.mock.method(workspace, 'getConfiguration', () => ({ inspect: () => ({ globalValue: global.value }) }));
  const { project } = await fixture(t);
  const boundary = await inspectProjectExecution(project, project, process.execPath);
  global.value = undefined;
  await assert.rejects(prepareProjectExecution(boundary, process.execPath, [], {}), /execution mode changed/u);
});

test('a native isolated command preserves literal argv and confines child processes, files, environment and sockets', async t => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return t.skip('Native POSIX backend only.');
  configure(t, 'isolated');
  const { sandboxRoot, project } = await fixture(t);
  let boundary;
  try { boundary = await inspectProjectExecution(project, project, process.execPath); }
  catch (error) {
    if (error instanceof ProjectExecutionUnavailableError && process.env.KEEPSEEK_REQUIRE_NATIVE_ISOLATION !== '1') {
      return t.skip(error.message);
    }
    throw error;
  }

  const external = path.join(sandboxRoot, 'external.txt');
  await writeFile(external, 'outside');
  await symlink(external, path.join(project, 'escape'));
  const literal = '词 ; $(unchanged) " and blank arg';
  const code = `
    const fs = require('node:fs');
    const net = require('node:net');
    const {spawnSync} = require('node:child_process');
    const attempt = work => { try { work(); return true; } catch { return false; } };
    fs.writeFileSync('inside.txt', process.argv[2]);
    const descendant = spawnSync(process.execPath, ['-e', [
      "const fs = require('node:fs');",
      "fs.writeFileSync('inside-descendant.txt', 'child');",
      "try { fs.writeFileSync(process.argv[1], 'bad'); process.stdout.write('outside'); } catch {}"
    ].join(' '), process.argv[1]]);
    const facts = {
      arg: process.argv[2],
      directRead: attempt(() => fs.readFileSync(process.argv[1])),
      symlinkRead: attempt(() => fs.readFileSync('escape')),
      directWrite: attempt(() => fs.writeFileSync(process.argv[1], 'bad')),
      descendantStarted: descendant.status === 0,
      descendantWrite: descendant.stdout?.toString() === 'outside',
      inheritedSecret: process.env.KEEPSEEK_FIXTURE_SECRET ?? null
    };
    const server = net.createServer();
    server.once('error', () => process.stdout.write(JSON.stringify({ ...facts, socket: false })));
    server.listen(0, '127.0.0.1', () => server.close(() => process.stdout.write(JSON.stringify({ ...facts, socket: true }))));
  `;
  const launch = await prepareProjectExecution(boundary, process.execPath, ['-e', code, external, literal],
    { LANG: 'C', KEEPSEEK_FIXTURE_SECRET: 'fake secret', LD_PRELOAD: '/invalid', DYLD_INSERT_LIBRARIES: '/invalid' });
  t.after(() => launch.cleanup?.());
  const result = await launchProcess(launch);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { arg: literal, directRead: false, symlinkRead: false, directWrite: false,
    descendantStarted: true, descendantWrite: false, inheritedSecret: null, socket: false });
  assert.equal(await readFile(external, 'utf8'), 'outside');
  assert.equal(await readFile(path.join(project, 'inside.txt'), 'utf8'), literal);
  assert.equal(await readFile(path.join(project, 'inside-descendant.txt'), 'utf8'), 'child');
});

async function launchProcess(launch: PreparedProjectExecution): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, shell: false,
      stdio: ['ignore', 'pipe', 'pipe', ...(launch.extraFds ?? [])], signal: AbortSignal.timeout(10_000) });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
