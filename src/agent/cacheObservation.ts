import { createHash } from 'node:crypto';
import type {
  CacheObservationReason,
  CacheObservationReasonCategory,
  CacheProjectionFingerprint,
  ProviderCacheObservation,
  Usage,
  UsageSource
} from '../shared/types';
import { getCanonicalModelIdentity } from '../shared/deepSeekModels';
import { estimateTokenCount } from './tokenEstimate';
import { getProviderRequestLane } from './providerRequestProjection';
import type { DeepSeekChatRequestBody } from './deepseek/types';
import type { OpenAiResponsesRequestBody } from './providers/responsesTypes';
import type { AnthropicMessagesRequestBody } from './providers/anthropicTypes';
import type { ModelSourceProvider } from '../accounts/types';

export const CACHE_OBSERVATION_SCHEMA_VERSION = 1;
export const CACHE_HEALTH_REUSABLE_PREFIX_MIN_TOKENS = 1_024;
export const CACHE_HEALTH_REUSE_TARGET_PERCENT = 95;

type ProviderRequestBody = DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody;

export interface CreateCacheObservationInput {
  requestId: string;
  attemptIndex: number;
  source: UsageSource;
  sourceId: string;
  provider: ModelSourceProvider;
  baseUrl: string;
  body: ProviderRequestBody;
  taskId?: string;
  runId?: string;
  contextEpochIndex?: number;
  requestProtocolVersion?: number;
  contextInstructions?: string;
  estimatedPromptTokens?: number;
  previous?: ProviderCacheObservation;
  historyCompacted?: boolean;
  historyRewriteReason?: string;
  protocolMigration?: boolean;
}

interface ProjectionBytes {
  system: Uint8Array;
  contextInstructions: Uint8Array;
  tools: Uint8Array;
  providerHistory: Uint8Array;
  full: Uint8Array;
}

/**
 * Creates telemetry from the request body object handed to the transport. It
 * never consults ChatSession/messages and never returns provider-visible data.
 */
export function createProviderCacheObservation(input: CreateCacheObservationInput): ProviderCacheObservation {
  const lane = getProviderRequestLane({
    provider: input.provider,
    sourceId: input.sourceId,
    baseUrl: input.baseUrl,
    modelId: input.body.model
  });
  const endpointLaneIdentity = hashText(lane.endpointLane);
  const laneKey = hashText(JSON.stringify([
    input.source,
    input.provider,
    lane.protocol,
    lane.sourceId,
    endpointLaneIdentity,
    input.body.model
  ]));
  const projection = projectNativeRequest(input.body, input.contextInstructions);
  const estimatedPromptTokens = positiveInteger(input.estimatedPromptTokens)
    ?? estimateTokenCount(decode(projection.full));
  const previous = input.previous;
  const sameLane = Boolean(previous && previous.laneKey === laneKey);
  const previousIdentity = previous ? requestIdentity(previous.requestId, previous.attemptIndex) : undefined;
  const commonPrefixBytes = previous && sameLane
    ? commonPrefixByteLengthFromHash(projection.full, previous.cacheableProjection)
    : 0;
  const strictPrefix = Boolean(previous && sameLane
    && projection.full.byteLength > previous.cacheableProjection.byteLength
    && commonPrefixBytes === previous.cacheableProjection.byteLength);
  const identicalRetry = Boolean(previous && sameLane
    && input.requestId === previous.requestId
    && projection.full.byteLength === previous.cacheableProjection.byteLength
    && hashBytes(projection.full) === previous.cacheableProjection.hash);
  const contextEpochRollover = Boolean(previous
    && Math.max(0, Math.floor(input.contextEpochIndex ?? 0)) !== previous.contextEpochIndex);
  const protocolMigration = Boolean(input.protocolMigration || (previous
    && Math.max(1, Math.floor(input.requestProtocolVersion ?? 1)) !== previous.requestProtocolVersion));
  const boundary = {
    // A summary already present in both strict-prefix requests is not a new
    // boundary. Only the first non-inheriting request after refresh is.
    historyCompacted: input.historyCompacted === true && !strictPrefix && !identicalRetry,
    historyRewritten: Boolean(input.historyRewriteReason),
    contextEpochRollover,
    protocolMigration
  };
  const changed = classifyChange({
    previous,
    sameLane,
    lane: {
      sourceId: lane.sourceId,
      provider: input.provider,
      protocol: lane.protocol,
      endpointLaneIdentity,
      modelId: input.body.model
    },
    projection,
    strictPrefix,
    identicalRetry,
    boundary
  });
  const commonPrefixTokensEstimate = projection.full.byteLength > 0
    ? Math.min(estimatedPromptTokens, Math.floor(estimatedPromptTokens * commonPrefixBytes / projection.full.byteLength))
    : 0;
  const reusablePrefixTokensEstimate = strictPrefix && previous
    ? Math.min(estimatedPromptTokens, previous.estimatedPromptTokens)
    : identicalRetry && previous ? Math.min(estimatedPromptTokens, previous.estimatedPromptTokens) : 0;
  const newTailBytes = strictPrefix && previous
    ? projection.full.slice(previous.cacheableProjection.byteLength)
    : identicalRetry ? new Uint8Array() : projection.full;
  const unavoidableNewTokensEstimate = Math.max(0, estimatedPromptTokens - reusablePrefixTokensEstimate);
  const eligibleForHealthTarget = strictPrefix
    && reusablePrefixTokensEstimate >= CACHE_HEALTH_REUSABLE_PREFIX_MIN_TOKENS
    && !Object.values(boundary).some(Boolean);

  return {
    version: CACHE_OBSERVATION_SCHEMA_VERSION,
    requestId: input.requestId,
    attemptIndex: Math.max(0, Math.floor(input.attemptIndex)),
    source: input.source,
    sourceId: lane.sourceId,
    provider: input.provider,
    protocol: lane.protocol,
    endpointLaneIdentity,
    laneKey,
    originalModelId: input.body.model,
    canonicalModelIdentity: getCanonicalModelIdentity(input.body.model),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    contextEpochIndex: Math.max(0, Math.floor(input.contextEpochIndex ?? 0)),
    requestProtocolVersion: Math.max(1, Math.floor(input.requestProtocolVersion ?? 1)),
    system: fingerprint(projection.system),
    contextInstructions: fingerprint(projection.contextInstructions),
    tools: fingerprint(projection.tools),
    providerHistory: fingerprint(projection.providerHistory),
    newTail: fingerprint(newTailBytes),
    cacheableProjection: { ...fingerprint(projection.full), tokensEstimate: estimatedPromptTokens },
    estimatedPromptTokens,
    ...(previous ? { previousPromptTokensEstimate: previous.estimatedPromptTokens } : {}),
    ...(previousIdentity ? { previousRequestIdentity: previousIdentity } : {}),
    ...(previousIdentity && sameLane ? { previousSameLaneRequestIdentity: previousIdentity } : {}),
    prefixRelation: !previous ? 'cold' : strictPrefix ? 'strict_prefix' : identicalRetry ? 'identical_retry' : 'broken',
    inheritsPreviousCacheablePrefix: strictPrefix || identicalRetry,
    ...(changed.segment ? { firstChangedSegment: changed.segment } : {}),
    commonPrefixTokensEstimate,
    reusablePrefixTokensEstimate,
    unavoidableNewTokensEstimate,
    ...(estimatedPromptTokens > 0 ? {
      expectedRawHitRateCeiling: Math.min(100, reusablePrefixTokensEstimate / estimatedPromptTokens * 100)
    } : {}),
    eligibleForHealthTarget,
    reason: changed.reason,
    reasonCategory: reasonCategory(changed.reason),
    boundary
  };
}

export function finalizeCacheObservationWithUsage(
  observation: ProviderCacheObservation,
  usage: Usage | undefined
): ProviderCacheObservation {
  if (!usage) return { ...observation };
  const promptTokens = Math.max(0, usage.promptTokens);
  const reusable = Math.min(promptTokens || observation.reusablePrefixTokensEstimate,
    observation.reusablePrefixTokensEstimate);
  const expectedRawHitRateCeiling = promptTokens > 0 ? Math.min(100, reusable / promptTokens * 100) : undefined;
  const reuseEfficiencyRaw = reusable > 0 && usage.cacheDataStatus === 'reported'
    ? usage.cacheHitTokens / reusable * 100
    : undefined;
  let reason = observation.reason;
  if (usage.cacheDataStatus !== 'reported') {
    reason = 'provider_cache_metrics_unavailable';
  } else if (observation.eligibleForHealthTarget && reuseEfficiencyRaw !== undefined
    && reuseEfficiencyRaw < CACHE_HEALTH_REUSE_TARGET_PERCENT) {
    // Provider eviction is considered only after a byte-level local prefix
    // proof. Local prefix breaks retain their first changed segment instead.
    reason = 'provider_cache_eviction_possible';
  }
  return {
    ...observation,
    reusablePrefixTokensEstimate: reusable,
    unavoidableNewTokensEstimate: Math.max(0, promptTokens - reusable),
    ...(expectedRawHitRateCeiling === undefined ? {} : { expectedRawHitRateCeiling }),
    ...(reuseEfficiencyRaw === undefined ? {} : { reuseEfficiencyRaw }),
    reason,
    reasonCategory: reasonCategory(reason)
  };
}

export function toCacheObservationReference(value: ProviderCacheObservation): ProviderCacheObservation {
  // The persisted observation is already content-free and is sufficient for a
  // future prefix proof by hashing the first N bytes of the new projection.
  return structuredClone(value);
}

function projectNativeRequest(body: ProviderRequestBody, contextInstructions?: string): ProjectionBytes {
  let systemItems: unknown[] = [];
  let historyItems: unknown[] = [];
  let tools: unknown[] = [];
  if ('input' in body) {
    systemItems = body.input.filter((item) => item.role === 'system');
    historyItems = body.input.filter((item) => item.role !== 'system');
    tools = body.tools ?? [];
  } else if ('system' in body) {
    systemItems = body.system;
    historyItems = body.messages;
    tools = body.tools ?? [];
  } else {
    systemItems = body.messages.filter((message) => message.role === 'system');
    historyItems = body.messages.filter((message) => message.role !== 'system');
    tools = body.tools ?? [];
  }
  const contextIndex = findContextInstructionsIndex(systemItems, contextInstructions);
  const baseSystem = systemItems.filter((_item, index) => index === 0);
  const context = contextIndex < 0 ? [] : [systemItems[contextIndex]];
  const additionalSystem = systemItems.filter((_item, index) => index !== 0 && index !== contextIndex);
  const system = encodeItems('system', baseSystem);
  const contextInstructionsBytes = encodeItems('context', context);
  const toolsBytes = encodeItems('tools', tools);
  const providerHistory = encodeItems('history', [...additionalSystem, ...historyItems]);
  return {
    system,
    contextInstructions: contextInstructionsBytes,
    tools: toolsBytes,
    providerHistory,
    full: concatBytes(system, contextInstructionsBytes, toolsBytes, providerHistory)
  };
}

function findContextInstructionsIndex(items: unknown[], contextInstructions: string | undefined): number {
  if (!contextInstructions) return -1;
  return items.findIndex((item, index) => index > 0 && readText(item) === contextInstructions);
}

function readText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as { content?: unknown; text?: unknown };
  return typeof item.content === 'string' ? item.content : typeof item.text === 'string' ? item.text : undefined;
}

function encodeItems(label: string, items: readonly unknown[]): Uint8Array {
  // No closing array delimiter is emitted. Appending one native item therefore
  // makes the earlier byte stream a strict prefix while preserving each actual
  // item's JSON serialization and ordering.
  return new TextEncoder().encode(`${label}\u0000${items.map((item) => `${JSON.stringify(item)}\n`).join('')}`);
}

function classifyChange(input: {
  previous?: ProviderCacheObservation;
  sameLane: boolean;
  lane: { sourceId: string; provider: string; protocol: string; endpointLaneIdentity: string; modelId: string };
  projection: ProjectionBytes;
  strictPrefix: boolean;
  identicalRetry: boolean;
  boundary: ProviderCacheObservation['boundary'];
}): { reason: CacheObservationReason; segment?: ProviderCacheObservation['firstChangedSegment'] } {
  const previous = input.previous;
  if (!previous) {
    if (input.boundary.contextEpochRollover) return { reason: 'context_epoch_rollover', segment: 'provider_history' };
    if (input.boundary.historyCompacted) return { reason: 'history_compacted', segment: 'provider_history' };
    if (input.boundary.historyRewritten) return { reason: 'history_rewritten', segment: 'provider_history' };
    if (input.boundary.protocolMigration) return { reason: 'protocol_migration', segment: 'lane' };
    return { reason: 'cold_start' };
  }
  if (previous.originalModelId !== input.lane.modelId) return { reason: 'model_lane_changed', segment: 'lane' };
  if (previous.sourceId !== input.lane.sourceId || previous.provider !== input.lane.provider) {
    return { reason: 'source_lane_changed', segment: 'lane' };
  }
  if (previous.protocol !== input.lane.protocol) return { reason: 'protocol_lane_changed', segment: 'lane' };
  if (previous.endpointLaneIdentity !== input.lane.endpointLaneIdentity) return { reason: 'endpoint_lane_changed', segment: 'lane' };
  if (input.boundary.protocolMigration) return { reason: 'protocol_migration', segment: 'lane' };
  if (input.boundary.contextEpochRollover) return { reason: 'context_epoch_rollover', segment: 'provider_history' };
  if (input.boundary.historyCompacted) return { reason: 'history_compacted', segment: 'provider_history' };
  if (input.boundary.historyRewritten) return { reason: 'history_rewritten', segment: 'provider_history' };
  if (previous.system.hash !== hashBytes(input.projection.system)) return { reason: 'system_prompt_changed', segment: 'system' };
  if (previous.contextInstructions.hash !== hashBytes(input.projection.contextInstructions)) {
    return { reason: 'context_instructions_changed', segment: 'context_instructions' };
  }
  if (previous.tools.hash !== hashBytes(input.projection.tools)) return { reason: 'tools_schema_changed', segment: 'tools' };
  if (input.strictPrefix) return { reason: 'append_only_prefix_preserved' };
  if (input.identicalRetry) return { reason: 'retry_projection_unchanged' };
  if (previous.providerHistory.hash !== hashBytes(input.projection.providerHistory)) {
    // A rewrite is only a controlled boundary when the caller has explicit
    // evidence (for example an edited resend). An unexplained native-history
    // change in the same lane is a KeepSeek-side anomaly, not normal history
    // growth and not a Provider cache eviction.
    return { reason: 'unexpected_local_prefix_break', segment: 'provider_history' };
  }
  return { reason: 'unexpected_local_prefix_break', segment: 'provider_history' };
}

export function reasonCategory(reason: CacheObservationReason): CacheObservationReasonCategory {
  if (reason === 'cold_start' || reason === 'append_only_prefix_preserved' || reason === 'retry_projection_unchanged') {
    return 'normal';
  }
  if (reason === 'history_compacted' || reason === 'context_epoch_rollover' || reason === 'protocol_migration'
    || reason === 'provider_context_too_long' || reason === 'stale_capacity_calibration' || reason === 'history_rewritten') {
    return 'controlled_boundary';
  }
  if (reason === 'provider_cache_eviction_possible' || reason === 'provider_cache_metrics_unavailable') return 'provider';
  return 'local_anomaly';
}

function commonPrefixByteLengthFromHash(current: Uint8Array, previous: CacheProjectionFingerprint): number {
  if (previous.byteLength <= current.byteLength
    && hashBytes(current.slice(0, previous.byteLength)) === previous.hash) return previous.byteLength;
  // Persisted records intentionally omit old bytes. A failed complete-prefix
  // proof cannot safely claim a shorter reusable prefix.
  return 0;
}

function fingerprint(value: Uint8Array): CacheProjectionFingerprint {
  const text = decode(value);
  return { hash: hashBytes(value), byteLength: value.byteLength, tokensEstimate: estimateTokenCount(text) };
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((sum, value) => sum + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function hashBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function requestIdentity(requestId: string, attemptIndex: number): string {
  return `${requestId}:${attemptIndex}`;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}
