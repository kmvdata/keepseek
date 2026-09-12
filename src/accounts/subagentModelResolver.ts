import * as vscode from 'vscode';
import type { KeepseekLanguage } from '../shared/i18n';
import type { AgentRequest, KeepseekModel } from '../shared/types';
import { resolveModelSourceConfig } from './accountResolver';
import { ModelSourceStore } from './accountStore';
import { createModelCatalog, findModelBySelection } from './modelCatalog';
import { SubagentSettingsStore } from './subagentSettingsStore';
import type { ModelSourceConfigSnapshot } from './types';

export interface ResolvedSubagentModel {
  model: KeepseekModel;
  sourceConfig: ModelSourceConfigSnapshot;
}

/**
 * Shared, read-only model selection boundary for isolated child/reviewer calls.
 * Credentials are still resolved exclusively by accountResolver.
 */
export async function resolveConfiguredSubagentModel(input: {
  globalStorageUri: vscode.Uri;
  workspaceKey: string;
  sourceStore: ModelSourceStore;
  parentRequest: Pick<AgentRequest, 'model' | 'sourceConfig'>;
  language: KeepseekLanguage;
  settingsStore?: SubagentSettingsStore;
  profileId?: string;
}): Promise<ResolvedSubagentModel> {
  const settingsStore = input.settingsStore
    ?? new SubagentSettingsStore(input.globalStorageUri, input.workspaceKey);
  const setting = await settingsStore.load(input.profileId);
  if (setting.mode === 'follow-main') {
    const sourceConfig = input.parentRequest.sourceConfig ?? await resolveModelSourceConfig(
      input.parentRequest.model.sourceId,
      input.globalStorageUri,
      { sourceStore: input.sourceStore, language: input.language }
    );
    return { model: { ...input.parentRequest.model }, sourceConfig: { ...sourceConfig } };
  }
  if (!setting.sourceId || !setting.modelId) {
    throw new Error(input.language === 'en'
      ? 'The fixed subagent model setting is incomplete. Choose it again in the command menu; KeepSeek will not silently fall back.'
      : '固定的子代理模型设置不完整。请在命令菜单中重新选择；KeepSeek 不会静默回退。');
  }
  const sources = await input.sourceStore.listSources();
  const model = findModelBySelection(createModelCatalog(sources), {
    sourceId: setting.sourceId,
    modelId: setting.modelId
  });
  if (!model || model.agentCompatible === false) {
    throw new Error(input.language === 'en'
      ? 'The selected subagent model is missing, disabled, or unavailable. Choose it again in the command menu; KeepSeek will not silently fall back.'
      : '子代理模型已缺失、被禁用或不可用。请在命令菜单中重新选择；KeepSeek 不会静默回退。');
  }
  const resolved = await resolveModelSourceConfig(model.sourceId, input.globalStorageUri, {
    sourceStore: input.sourceStore,
    language: input.language
  });
  return {
    model: { ...model },
    sourceConfig: {
      sourceId: resolved.sourceId,
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      supportsBilling: resolved.supportsBilling
    }
  };
}
