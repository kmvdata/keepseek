import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { getAvailableSafeValidationScripts } from '../src/agent/tools/validationTools';

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
});
