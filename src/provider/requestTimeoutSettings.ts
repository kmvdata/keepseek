import { KEEPSEEK_CONFIGURATION_NAMESPACE } from '../shared/identity';
import * as vscode from 'vscode';
import { isModelRequestTimeoutPreset } from '../shared/config';

/** The header entry edits one user-level policy, independent of model selection. */
export async function saveModelRequestTimeout(seconds: unknown): Promise<boolean> {
  if (!isModelRequestTimeoutPreset(seconds)) return false;
  await vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE).update(
    'modelRequestTimeoutSeconds', seconds, vscode.ConfigurationTarget.Global
  );
  return true;
}
