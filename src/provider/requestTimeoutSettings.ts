import * as vscode from 'vscode';
import { isModelRequestTimeoutPreset } from '../shared/config';

/** The header entry edits one user-level policy, independent of model selection. */
export async function saveModelRequestTimeout(seconds: unknown): Promise<boolean> {
  if (!isModelRequestTimeoutPreset(seconds)) return false;
  await vscode.workspace.getConfiguration('keepseek').update(
    'modelRequestTimeoutSeconds', seconds, vscode.ConfigurationTarget.Global
  );
  return true;
}
