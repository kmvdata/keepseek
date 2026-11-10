import * as vscode from 'vscode';
import { KEEPSEEK_CONFIGURATION_NAMESPACE } from './identity';
import type { KeepseekLanguage } from './i18n';

const selectionKeys = ['selectedSourceId', 'selectedModelId'] as const;

/** A stale installed manifest cannot be repaired by writing an unregistered key. */
export function withConfigurationRegistrationHelp(error: unknown, language: KeepseekLanguage): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes(`${KEEPSEEK_CONFIGURATION_NAMESPACE}.`)
    || !message.includes('not a registered configuration')) return error;
  const help = language === 'en'
    ? 'VS Code has not registered the current KeepSeek settings. Run Developer: Reload Window. If this persists, reinstall the current KeepSeek VSIX and fully restart VS Code.'
    : 'VS Code 尚未注册当前 KeepSeek 配置。请运行“开发人员: 重新加载窗口”；如仍报错，请重新安装当前 KeepSeek VSIX，并完全退出后重新打开 VS Code。';
  return new Error(`${help}\n${message}`, { cause: error });
}

/** Report only registration identities, never configuration/account values. */
export function getConfigurationRegistrationDiagnostics(packageJson: unknown) {
  const manifest = packageJson as { contributes?: { configuration?: unknown } } | undefined;
  const contribution = manifest?.contributes?.configuration;
  const nodes = Array.isArray(contribution) ? contribution : [contribution];
  const declaredSelectionKeys = selectionKeys.filter(key => nodes.some(node => {
    const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
    return properties && Object.hasOwn(properties, `${KEEPSEEK_CONFIGURATION_NAMESPACE}.${key}`);
  }));
  try {
    const config = vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE);
    return { namespace: KEEPSEEK_CONFIGURATION_NAMESPACE, declaredSelectionKeys,
      missingSelectionDefaults: selectionKeys.filter(key => config.inspect(key)?.defaultValue === undefined),
      inspectionAvailable: true };
  } catch {
    return { namespace: KEEPSEEK_CONFIGURATION_NAMESPACE, declaredSelectionKeys,
      missingSelectionDefaults: [], inspectionAvailable: false };
  }
}
