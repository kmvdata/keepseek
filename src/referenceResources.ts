import * as vscode from 'vscode';
import { getUriFileName } from './fileReference';
import { ReferenceResource } from './types';

const REFERENCE_RESOURCE_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';

export async function getWorkspaceReferenceResources(): Promise<ReferenceResource[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return [];
  }

  const includeWorkspaceFolder = folders.length > 1;
  const resources: ReferenceResource[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      REFERENCE_RESOURCE_GLOB_EXCLUDE
    );

    for (const uri of uris) {
      const key = uri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
      resources.push({
        uri: key,
        path: uri.scheme === 'file' ? uri.fsPath : key,
        label: getUriFileName(uri),
        description: relativePath,
        workspaceFolder: folder.name,
        kind: 'file'
      });
    }
  }

  resources.sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    if (labelOrder !== 0) {
      return labelOrder;
    }
    return left.description.localeCompare(right.description, undefined, { sensitivity: 'base' });
  });

  return resources;
}
