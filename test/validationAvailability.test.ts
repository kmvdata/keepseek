import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { RUN_VALIDATION_TOOL_NAME } from '../src/agent/protocol';
import { getAvailableSafeValidationScripts, preflightSafeValidation, ValidationToolService } from '../src/agent/tools/validationTools';
import projectExecution = require('../src/runs/projectExecutionIsolation');

describe('background validation availability', () => {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: vscode.Uri; name?: string }>;
    isTrusted: boolean;
  };
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-validation-availability-'));
    workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'validation-test' }];
    workspace.isTrusted = true;
  });

  afterEach(async () => {
    workspace.workspaceFolders = [];
    workspace.isTrusted = true;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('only exposes defined allowlisted scripts that pass the safety check', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        compile: 'tsc -p tsconfig.json',
        test: 'npm install && node --test',
        deploy: 'example-deploy-command'
      }
    }));

    assert.deepEqual(await getAvailableSafeValidationScripts(), ['compile']);
    workspace.isTrusted = false;
    assert.deepEqual(await getAvailableSafeValidationScripts(), []);
  });

  it('does not run delegated validation with only local tool authorization', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node record.cjs' } }));
    await fs.writeFile(path.join(root, 'record.cjs'), "require('node:fs').writeFileSync('ran', 'unexpected');");
    const result = JSON.parse(await new ValidationToolService().runSafeNpmScript({
      script: 'test', language: 'en', approvalMode: 'delegate', expectedSnapshot: 'host-claimed-snapshot',
      authorization: { allowed: true, toolName: RUN_VALIDATION_TOOL_NAME, riskLevel: 'medium', scope: 'validation_test',
        source: 'configuration', requiresExplicitConfirmation: false }
    }));
    assert.equal(result.errorType, 'authorization_denied');
    await assert.rejects(fs.stat(path.join(root, 'ran')), { code: 'ENOENT' });
  });

  it('binds isolated npm configuration without sharing its contents', async t => {
    t.mock.method(projectExecution, 'getProjectExecutionMode', () => 'isolated');
    t.mock.method(projectExecution, 'inspectProjectExecution', async (root: string, cwd: string, executable: string) => ({
      root, cwd, executable, kind: 'seatbelt', executableRealPath: executable, fingerprint: 'isolated-fixture',
      wrapper: '/fixture/sandbox', toolRoots: []
    }));
    const config = path.join(root, '.npmrc');
    const secret = 'FIXTURE_TOKEN_EXCLUDED_FROM_REVIEW';
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc' } }));
    await fs.writeFile(config, `//registry.example.invalid/:_authToken=${secret}\n`);
    const inspect = () => preflightSafeValidation({ script: 'compile', language: 'en', approvalMode: 'delegate' });
    const first = await inspect();
    assert.equal(first.status, 'ready');
    assert.doesNotMatch(JSON.stringify(first.snapshot), new RegExp(secret, 'u'));
    await fs.appendFile(config, 'ignore-scripts=true\n');
    const second = await inspect();
    assert.equal(second.status, 'ready');
    assert.notEqual(first.snapshot.fingerprint, second.snapshot.fingerprint);
  });
});
