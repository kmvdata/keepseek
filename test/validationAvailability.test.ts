import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { getAvailableSafeValidationScripts, ValidationToolService } from '../src/agent/tools/validationTools';
import { RUN_VALIDATION_TOOL_NAME } from '../src/agent/protocol';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator, runProjectExecution } from '../src/tasks/projectResources';

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

  it('records and settles an actual gated validation process independently of session history', async () => {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    await fs.writeFile(path.join(root, 'smoke.test.js'), 'require("node:test")("controlled validation",()=>{});');
    const owner = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: path.join(root, 'locks') });
    try {
      assert.equal(owner.isOwner, true, owner.reason);
      const result = JSON.parse(await runProjectExecution({ owner, resources: new ProjectResourceCoordinator(owner.projectId), scope: {
        sessionId: 'validation-session', rootTaskId: 'validation-root', segmentId: 'validation-segment', runtimeId: 'validation-runtime'
      } }, () => new ValidationToolService().runSafeNpmScript({
        script: 'test', language: 'en', authorization: {
          allowed: true, toolName: RUN_VALIDATION_TOOL_NAME, riskLevel: 'medium', scope: 'validation_test',
          source: 'explicit_confirmation', requiresExplicitConfirmation: true
        }
      }))) as { ok: boolean; error?: string };
      assert.equal(result.ok, true, result.error);
      const operations = (await owner.diagnostics()).operations;
      assert.equal(operations.length, 1);
      assert.equal(operations[0].kind, 'validation');
      assert.equal(operations[0].state, 'completed');
      assert.ok(operations[0].processId);
      assert.equal(owner.isOwner, true);
    } finally { await owner.dispose(); }
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
});
