import * as path from 'node:path';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { formatBytes } from '../shared/format';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import { toActivatedSkill, type ActivatedSkill, type SkillManifest } from './skillTypes';

export class SkillLoader {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async loadSkill(manifest: SkillManifest): Promise<ActivatedSkill> {
    if (!manifest.enabled) {
      throw new Error(manifest.unavailableReason || 'Skill is disabled.');
    }
    if (!isUriInsideOrEqual(manifest.rootUri, manifest.skillUri)) {
      throw new Error('Skill file is outside the skill root.');
    }
    if (shouldSkipTextUri(manifest.skillUri)) {
      throw new Error(`${getUriBasename(manifest.skillUri)} is not a readable text file.`);
    }

    const maxBytes = getConfiguredMaxFileBytes();
    const stat = await vscode.workspace.fs.stat(manifest.skillUri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(`${getUriBasename(manifest.skillUri)} is not a file.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${getUriBasename(manifest.skillUri)} is larger than ${formatBytes(maxBytes)}.`);
    }

    const bytes = await vscode.workspace.fs.readFile(manifest.skillUri);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`${getUriBasename(manifest.skillUri)} is larger than ${formatBytes(maxBytes)}.`);
    }

    const content = this.decoder.decode(bytes).replace(/\r\n?/gu, '\n');
    if (!isReadableTextContent(content)) {
      throw new Error(`${getUriBasename(manifest.skillUri)} appears to be binary or unreadable text.`);
    }
    return toActivatedSkill(manifest, content);
  }
}

function getUriBasename(uri: vscode.Uri): string {
  const value = uri.scheme === 'file' ? uri.fsPath : uri.path;
  return path.basename(value) || 'skill instruction file';
}

export function isUriInsideOrEqual(rootUri: vscode.Uri, candidateUri: vscode.Uri): boolean {
  if (rootUri.scheme === 'file' && candidateUri.scheme === 'file') {
    const rootPath = path.resolve(rootUri.fsPath);
    const candidatePath = path.resolve(candidateUri.fsPath);
    return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${path.sep}`);
  }

  const root = rootUri.toString();
  const candidate = candidateUri.toString();
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}
