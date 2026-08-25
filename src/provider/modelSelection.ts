import { MODEL_SOURCE_PROVIDERS, type ModelSourceProvider } from '../accounts/types';
import type {
  AgentSettings,
  BackgroundRunStatus,
  ChatMessage,
  ChatSession,
  ContextUsageEstimate,
  KeepseekModel,
  ModelSelection
} from '../shared/types';
import { getAgentRuntimeProfile } from '../shared/modelProfiles';
import {
  getProviderRequestLane,
  hasProviderNativeReplayFidelityRisk,
  type ProviderRequestLane
} from '../agent/providerRequestProjection';

export interface PendingModelSelection extends ModelSelection {
  requestedAt: string;
  requestGeneration: number;
  confirmedRiskKeys: string[];
}

export interface ModelSelectionTransactionSnapshot {
  generation: number;
  currentRun?: ModelSelection;
  pending?: PendingModelSelection;
}

export function isBackgroundModelSelectionLocked(status: BackgroundRunStatus | undefined): boolean {
  return status === 'running' || status === 'waiting_for_apply' || status === 'waiting_for_authorization';
}

/**
 * Runtime-only coordination for model selection. It deliberately owns no chat
 * messages or persisted session state, so selection feedback can never enter a
 * provider request.
 */
export class ModelSelectionTransactionCoordinator {
  private generation = 0;
  private currentRun: ModelSelection | undefined;
  private pending: PendingModelSelection | undefined;

  public beginRequest(): number {
    this.generation += 1;
    return this.generation;
  }

  public isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  public beginRun(selection: ModelSelection): void {
    this.currentRun = { ...selection };
  }

  public finishRun(): PendingModelSelection | undefined {
    this.currentRun = undefined;
    return this.pending ? { ...this.pending, confirmedRiskKeys: [...this.pending.confirmedRiskKeys] } : undefined;
  }

  public queuePending(input: Omit<PendingModelSelection, 'requestGeneration'>, generation: number): boolean {
    if (!this.isCurrent(generation)) {
      return false;
    }
    this.pending = {
      ...input,
      confirmedRiskKeys: [...input.confirmedRiskKeys],
      requestGeneration: generation
    };
    return true;
  }

  public commit(generation: number): boolean {
    if (!this.isCurrent(generation)) {
      return false;
    }
    this.pending = undefined;
    return true;
  }

  public clearPending(generation = this.beginRequest()): boolean {
    if (!this.isCurrent(generation)) {
      return false;
    }
    this.pending = undefined;
    return true;
  }

  public getSnapshot(): ModelSelectionTransactionSnapshot {
    return {
      generation: this.generation,
      currentRun: this.currentRun ? { ...this.currentRun } : undefined,
      pending: this.pending
        ? { ...this.pending, confirmedRiskKeys: [...this.pending.confirmedRiskKeys] }
        : undefined
    };
  }
}

export interface ModelSwitchImpact {
  targetContextUsage: ContextUsageEstimate;
  contextWindowTokens: number;
  usedPercent: number;
  compressionTriggerRatio: number;
  forceRatio: number;
  maxOutputTokens: number;
  maxToolIterations: number;
  currentLane?: ProviderRequestLane;
  targetLane: ProviderRequestLane;
  hasPreviousProviderRequest: boolean;
  cacheLaneChanged: boolean;
  cacheLaneChangeReasons: string[];
  providerReplayFidelityRisk: boolean;
  confirmationRiskKeys: string[];
}

export function analyzeModelSwitchImpact(input: {
  session: Pick<ChatSession, 'messages' | 'requestProtocol' | 'contextCompression'>;
  targetModel: KeepseekModel;
  targetProvider: ModelSourceProvider;
  targetSourceId: string;
  targetBaseUrl: string;
  settings: AgentSettings;
  targetContextUsage: ContextUsageEstimate;
  /** Exact target history projection, when already computed by the caller. */
  targetProjectedHistory?: ChatMessage[];
}): ModelSwitchImpact {
  const profile = getAgentRuntimeProfile(input.targetModel, input.settings);
  const targetLane = getProviderRequestLane({
    provider: input.targetProvider,
    sourceId: input.targetSourceId,
    baseUrl: input.targetBaseUrl,
    modelId: input.targetModel.id
  });
  const previousProtocol = input.session.requestProtocol;
  const currentProvider = normalizeModelSourceProvider(previousProtocol?.providerId);
  const currentLane = currentProvider
    ? getProviderRequestLane({
        provider: currentProvider,
        sourceId: previousProtocol?.sourceId ?? '',
        baseUrl: previousProtocol?.baseUrl ?? '',
        modelId: previousProtocol?.modelId ?? ''
      })
    : undefined;
  const hasPreviousProviderRequest = hasSessionProviderRequest(input.session);
  const cacheLaneChangeReasons = hasPreviousProviderRequest && currentLane
    ? getCacheLaneChangeReasons(currentLane, targetLane)
    : [];
  const providerReplayFidelityRisk = hasProviderNativeReplayFidelityRisk(
    input.targetProjectedHistory ?? filterSummaryCoveredMessages(input.session),
    targetLane
  );
  const ratio = input.targetContextUsage.usedPercent / 100;
  const confirmationRiskKeys: string[] = [];
  if (ratio >= profile.contextCompression.forceRatio) {
    confirmationRiskKeys.push('context_force_range');
  } else if (ratio >= profile.contextCompression.triggerRatio) {
    confirmationRiskKeys.push('context_compression_range');
  }
  if (input.targetContextUsage.usedTokensEstimate >= profile.contextWindowTokens) {
    confirmationRiskKeys.push('context_window_exceeded');
  }
  if (providerReplayFidelityRisk) {
    confirmationRiskKeys.push('provider_replay_fidelity');
  }

  return {
    targetContextUsage: input.targetContextUsage,
    contextWindowTokens: profile.contextWindowTokens,
    usedPercent: input.targetContextUsage.usedPercent,
    compressionTriggerRatio: profile.contextCompression.triggerRatio,
    forceRatio: profile.contextCompression.forceRatio,
    maxOutputTokens: profile.maxTokens,
    maxToolIterations: profile.maxToolIterations,
    currentLane,
    targetLane,
    hasPreviousProviderRequest,
    cacheLaneChanged: cacheLaneChangeReasons.length > 0,
    cacheLaneChangeReasons,
    providerReplayFidelityRisk,
    confirmationRiskKeys
  };
}

function filterSummaryCoveredMessages(
  session: Pick<ChatSession, 'messages' | 'contextCompression'>
): ChatMessage[] {
  const coveredMessageIds = new Set(
    (session.contextCompression?.summaries ?? []).flatMap((summary) => summary.coveredMessageIds)
  );
  return session.messages.filter((message) => !coveredMessageIds.has(message.id));
}

function normalizeModelSourceProvider(value: string | undefined): ModelSourceProvider | undefined {
  return MODEL_SOURCE_PROVIDERS.includes(value as ModelSourceProvider)
    ? value as ModelSourceProvider
    : undefined;
}

export function getCacheLaneChangeReasons(
  current: ProviderRequestLane,
  target: ProviderRequestLane
): string[] {
  const reasons: string[] = [];
  if (current.modelId && target.modelId && current.modelId !== target.modelId) {
    reasons.push('model_changed');
  }
  if (current.sourceId && target.sourceId && current.sourceId !== target.sourceId) {
    reasons.push('source_changed');
  }
  if (current.protocol !== target.protocol) {
    reasons.push('protocol_changed');
  }
  if (current.endpointLane !== target.endpointLane) {
    reasons.push('endpoint_lane_changed');
  }
  return reasons;
}

function hasSessionProviderRequest(
  session: Pick<ChatSession, 'messages' | 'requestProtocol'>
): boolean {
  if (session.requestProtocol?.lastProviderRequestAt) {
    return true;
  }
  return session.messages.some((message: ChatMessage) => (
    message.role === 'assistant' && Boolean(message.modelId || message.runDetails)
  ));
}
