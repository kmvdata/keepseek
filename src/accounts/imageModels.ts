import type * as vscode from 'vscode';
import type { ModelSelection } from '../shared/types';
import type { ModelSource, ResolvedModelSourceConfig } from './types';
import { resolveModelSourceConfig, type ResolveModelSourceOptions } from './accountResolver';
import {
  getImageModelCapabilities,
  normalizeOpenAIImagesEndpoint,
  type ImageModelCapabilities
} from './imageCapabilities';

export interface ImageModelCatalogEntry {
  sourceId: string;
  modelId: string;
  sourceName: string;
  label: string;
  endpointId?: string;
  available: boolean;
  reason?: 'source_disabled' | 'model_disabled' | 'unsupported_endpoint' | 'missing_api_key';
  capabilities: ImageModelCapabilities;
}

/** Image availability is separate from text-Agent compatibility and selection. No fallback accounts. */
export function createImageModelCatalog(sources: readonly ModelSource[]): ImageModelCatalogEntry[] {
  const result: ImageModelCatalogEntry[] = [];
  for (const source of sources) {
    const ids = new Set([...source.models, ...(source.modelCache?.models ?? [])].map((model) => model.id));
    for (const modelId of ids) {
      const capabilities = getImageModelCapabilities(modelId);
      if (!capabilities) continue;
      const endpointId = source.provider === 'openai-compatible' || source.provider === 'openai-responses'
        ? normalizeOpenAIImagesEndpoint(source.baseUrl) : undefined;
      const reason = !source.enabled ? 'source_disabled'
        : source.disabledModelIds?.includes(modelId) ? 'model_disabled'
          : !endpointId ? 'unsupported_endpoint'
            : !source.apiKey.trim() ? 'missing_api_key' : undefined;
      result.push({
        sourceId: source.id,
        modelId,
        sourceName: source.name,
        label: `${source.name} · ${modelId}`,
        ...(endpointId ? { endpointId } : {}),
        available: !reason,
        ...(reason ? { reason } : {}),
        capabilities
      });
    }
  }
  return result;
}

export interface ResolvedImageModelSource {
  source: ResolvedModelSourceConfig;
  model: ImageModelCatalogEntry & { endpointId: string };
}

/** Credentials are obtained exclusively by the shared resolver immediately before execution. */
export async function resolveImageModelSourceConfig(
  selection: ModelSelection,
  globalStorageUri?: vscode.Uri,
  options: ResolveModelSourceOptions = {}
): Promise<ResolvedImageModelSource> {
  if (!selection.sourceId || !selection.modelId) throw new Error('image_model_not_configured');
  const source = await resolveModelSourceConfig(selection.sourceId, globalStorageUri, options);
  if (!source.modelSource) throw new Error('image_source_unavailable');
  const model = createImageModelCatalog([source.modelSource]).find((entry) => (
    entry.sourceId === selection.sourceId && entry.modelId === selection.modelId
  ));
  if (!model) throw new Error('image_model_unsupported');
  if (!model.available || !model.endpointId) throw new Error(model.reason ?? 'image_model_unavailable');
  return { source, model: { ...model, endpointId: model.endpointId } };
}
