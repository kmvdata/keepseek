import * as vscode from 'vscode';
import { getUriFileName } from './fileReference';
import { ReferenceResource } from '../../shared/types';
import { WorkspaceGitIgnoreRules } from '../../workspace/gitIgnore';
import {
  isDirectoryFileType,
  isFileFileType,
  SKIPPED_WORKSPACE_DIRECTORY_NAMES
} from '../../workspace/workspaceDirectory';

const REFERENCE_DIRECTORY_MAX_DEPTH = 16;
const GITIGNORE_FILE_NAME = '.gitignore';
const textDecoder = new TextDecoder('utf-8', { fatal: false });

export async function getWorkspaceReferenceResources(): Promise<ReferenceResource[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) {
    return [];
  }

  const includeWorkspaceFolder = folders.length > 1;
  const resources: ReferenceResource[] = [];
  const seen = new Set<string>();

  for (const folder of folders) {
    await addWorkspaceResources(folder, includeWorkspaceFolder, resources, seen);
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

async function addWorkspaceResources(
  folder: vscode.WorkspaceFolder,
  includeWorkspaceFolder: boolean,
  resources: ReferenceResource[],
  seen: Set<string>
): Promise<void> {
  const visit = async (
    directoryUri: vscode.Uri,
    relativeDirectory: string,
    depth: number,
    inheritedIgnoreRules: WorkspaceGitIgnoreRules
  ): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directoryUri);
    } catch {
      return;
    }

    const ignoreRules = await addLocalGitIgnoreRules(
      directoryUri,
      relativeDirectory,
      entries,
      inheritedIgnoreRules
    );
    entries.sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
    for (const [name, fileType] of entries) {
      const directory = isDirectoryFileType(fileType);
      const file = isFileFileType(fileType);
      const symbolicLink = isSymbolicLinkFileType(fileType);
      if (!directory && !file) {
        continue;
      }

      const childUri = vscode.Uri.joinPath(directoryUri, name);
      const childRelativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (ignoreRules.isIgnored(childRelativePath, directory)) {
        continue;
      }

      if (directory) {
        if (SKIPPED_WORKSPACE_DIRECTORY_NAMES.has(name)) {
          continue;
        }

        if (depth <= REFERENCE_DIRECTORY_MAX_DEPTH) {
          addReferenceResource(childUri, folder, includeWorkspaceFolder, resources, seen, 'directory');
        }
        // Do not follow directory symlinks while recursively building the menu; they can form cycles.
        if (symbolicLink) {
          continue;
        }
        await visit(childUri, childRelativePath, depth + 1, ignoreRules);
        continue;
      }

      addReferenceResource(childUri, folder, includeWorkspaceFolder, resources, seen, 'file');
    }
  };

  await visit(folder.uri, '', 0, WorkspaceGitIgnoreRules.empty());
}

async function addLocalGitIgnoreRules(
  directoryUri: vscode.Uri,
  relativeDirectory: string,
  entries: readonly [string, vscode.FileType][],
  inheritedIgnoreRules: WorkspaceGitIgnoreRules
): Promise<WorkspaceGitIgnoreRules> {
  const gitIgnoreEntry = entries.find(
    ([name, fileType]) => name === GITIGNORE_FILE_NAME && isFileFileType(fileType)
  );
  if (!gitIgnoreEntry) {
    return inheritedIgnoreRules;
  }

  try {
    const content = textDecoder.decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directoryUri, GITIGNORE_FILE_NAME))
    );
    return inheritedIgnoreRules.add(relativeDirectory, content);
  } catch {
    return inheritedIgnoreRules;
  }
}

function addReferenceResource(
  uri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  includeWorkspaceFolder: boolean,
  resources: ReferenceResource[],
  seen: Set<string>,
  kind: ReferenceResource['kind']
): void {
  const key = uri.toString();
  if (seen.has(key)) {
    return;
  }
  seen.add(key);

  const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
  resources.push({
    uri: key,
    path: uri.scheme === 'file' ? uri.fsPath : key,
    label: getUriFileName(uri),
    description: kind === 'directory' ? `${relativePath}/` : relativePath,
    workspaceFolder: folder.name,
    kind
  });
}

function isSymbolicLinkFileType(fileType: vscode.FileType): boolean {
  return (fileType & vscode.FileType.SymbolicLink) === vscode.FileType.SymbolicLink;
}
