import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { KEEPSEEK_STORAGE_NAMESPACE } from './identity';

/** This is the extension-host machine's native data root, independent of VS Code
 * URI providers and profiles. All stores share it so file locks have one domain. */
export function getNativeStoragePath(input: {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const home = input.home ?? homedir();
  const env = input.env ?? process.env;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
      ? env.LOCALAPPDATA : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, KEEPSEEK_STORAGE_NAMESPACE);
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', KEEPSEEK_STORAGE_NAMESPACE);
  const base = env.XDG_DATA_HOME && path.posix.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.posix.join(home, '.local', 'share');
  return path.posix.join(base, KEEPSEEK_STORAGE_NAMESPACE);
}

export function getNativeStorageUri(): vscode.Uri {
  return vscode.Uri.file(getNativeStoragePath());
}
