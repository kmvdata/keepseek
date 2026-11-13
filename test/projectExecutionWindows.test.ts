import './registerVscodeStub';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectProjectExecution, prepareProjectExecution } from '../src/runs/projectExecutionIsolation';
import { workspace } from './stubs/vscode';

test('Windows Docker Desktop runs the pinned project toolchain with a confined filesystem and network', async t => {
  if (process.platform !== 'win32') return t.skip('Requires native Windows and the Docker Desktop Linux engine.');
  const image = process.env.KEEPSEEK_TEST_DOCKER_IMAGE;
  if (!image) return t.skip('Set KEEPSEEK_TEST_DOCKER_IMAGE to an installed Linux Node image ID to enable the native test.');
  assert.match(image, /^sha256:[a-f0-9]{64}$/u);

  let configuredImage = 'mutable:latest';
  t.mock.method(workspace, 'getConfiguration', () => ({
    inspect: (key: string) => ({ globalValue: key === 'projectExecutionContainerImage' ? configuredImage : 'isolated' })
  }));
  const fixture = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-docker-test-')));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const project = path.join(fixture, 'project');
  const cwd = path.join(project, 'folder 空格');
  const outside = path.join(fixture, 'outside');
  const outsideFile = path.join(outside, 'protected.txt');
  await Promise.all([mkdir(cwd, { recursive: true }), mkdir(outside)]);
  await writeFile(outsideFile, 'untouched');
  await symlink(outside, path.join(project, 'outside-link'), 'junction');

  await assert.rejects(inspectProjectExecution(project, cwd, process.execPath), /immutable sha256 ID/u);
  configuredImage = image;
  const boundary = await inspectProjectExecution(project, cwd, process.execPath);
  assert.equal(boundary.kind, 'container');
  assert.equal(boundary.image, image);
  assert.equal(boundary.containerCommand, 'node');

  const literal = '词 ; $(unchanged) " and space';
  const probe = `
    const fs = require('node:fs');
    const net = require('node:net');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const outside = '../outside-link/protected.txt';
    const attempt = work => { try { work(); return true; } catch { return false; } };
    fs.writeFileSync('inside.txt', process.argv[1]);
    const child = spawnSync(process.execPath, ['-e', [
      "const fs = require('node:fs');",
      "fs.writeFileSync('child.txt', 'started');",
      "try { fs.writeFileSync(process.argv[1], 'child escaped'); process.stdout.write('escaped'); } catch {}"
    ].join(' '), outside]);
    const facts = {
      argv: process.argv.slice(1), cwd: process.cwd(),
      junctionRead: attempt(() => fs.readFileSync(outside)),
      junctionWrite: attempt(() => fs.writeFileSync(outside, 'escaped')),
      childStarted: child.status === 0,
      childEscaped: child.stdout?.toString() === 'escaped',
      secret: process.env.KEEPSEEK_FIXTURE_SECRET ?? null,
      externalInterfaces: Object.values(os.networkInterfaces()).flat().filter(item => !item.internal).length
    };
    const socket = net.createConnection({ host: '192.0.2.1', port: 9, timeout: 1000 });
    socket.once('error', error => process.stdout.write(JSON.stringify({ ...facts, network: error.code })));
    socket.once('timeout', () => {
      socket.destroy();
      process.stdout.write(JSON.stringify({ ...facts, network: 'timeout' }));
    });
    socket.once('connect', () => {
      socket.destroy();
      process.stdout.write(JSON.stringify({ ...facts, network: 'connected' }));
    });
  `;
  const launch = await prepareProjectExecution(boundary, process.execPath, ['-e', probe, literal, ''], {
    KEEPSEEK_FIXTURE_SECRET: 'fixture value', NODE_OPTIONS: '--fixture-option-must-not-be-inherited'
  });
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, { cwd: launch.cwd, env: launch.env, shell: false,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(45_000) });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    const { network, ...facts } = JSON.parse(result.stdout);
    assert.match(network, /^(?:ENETUNREACH|EHOSTUNREACH|EACCES|EPERM)$/u);
    assert.deepEqual(facts, {
      argv: [literal, ''], cwd: '/keepseek/project/folder 空格', junctionRead: false, junctionWrite: false,
      childStarted: true, childEscaped: false, secret: null, externalInterfaces: 0
    });
  } finally {
    await launch.cleanup?.();
  }
  assert.equal(await readFile(outsideFile, 'utf8'), 'untouched');
  assert.equal(await readFile(path.join(cwd, 'inside.txt'), 'utf8'), literal);
  assert.equal(await readFile(path.join(cwd, 'child.txt'), 'utf8'), 'started');
});
