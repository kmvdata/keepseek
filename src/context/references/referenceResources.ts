import * as vscode from 'vscode';
import { getUriFileName } from './fileReference';
import { ReferenceResource } from '../../shared/types';
import { isDirectoryFileType, SKIPPED_WORKSPACE_DIRECTORY_NAMES, WORKSPACE_DIRECTORY_GLOB_EXCLUDE } from '../../workspace/workspaceDirectory';

const REFERENCE_DIRECTORY_MAX_DEPTH = 16;

export async function getWorkspaceReferenceResources(): Promise<ReferenceResource[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return [];
  }

  const includeWorkspaceFolder = folders.length > 1;
  const resources: ReferenceResource[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    await addWorkspaceDirectoryResources(folder, includeWorkspaceFolder, resources, seen);

    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(folder, '**/*'),
      WORKSPACE_DIRECTORY_GLOB_EXCLUDE
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
    if (left.kind !== right.kind) {
      return left.kind === 'directory' ? -1 : 1;
    }
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
    if (labelOrder !== 0) {
      return labelOrder;
    }
    return left.description.localeCompare(right.description, undefined, { sensitivity: 'base' });
  });

  return resources;
}

async function addWorkspaceDirectoryResources(
  folder: vscode.WorkspaceFolder,
  includeWorkspaceFolder: boolean,
  resources: ReferenceResource[],
  seen: Set<string>
): Promise<void> {
  const visit = async (directoryUri: vscode.Uri, depth: number): Promise<void> => {
    if (depth > REFERENCE_DIRECTORY_MAX_DEPTH) {
      return;
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directoryUri);
    } catch {
      return;
    }

    entries.sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
    for (const [name, fileType] of entries) {
      if (!isDirectoryFileType(fileType) || SKIPPED_WORKSPACE_DIRECTORY_NAMES.has(name)) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(directoryUri, name);
      const key = childUri.toString();
      if (!seen.has(key)) {
        seen.add(key);
        const relativePath = vscode.workspace.asRelativePath(childUri, includeWorkspaceFolder);
        resources.push({
          uri: key,
          path: childUri.scheme === 'file' ? childUri.fsPath : key,
          label: getUriFileName(childUri),
          description: `${relativePath}/`,
          workspaceFolder: folder.name,
          kind: 'directory'
        });
      }

      await visit(childUri, depth + 1);
    }
  };

  await visit(folder.uri, 0);
}
