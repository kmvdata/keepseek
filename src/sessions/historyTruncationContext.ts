import { createHash, randomUUID } from 'node:crypto';
import { getAutoProtectedMessageIds } from '../agent/historyProjection';
import type { ChatMessage, ChatSession, HistorySummary } from '../shared/types';

export type SummaryTruncationInvalidationReason = 'source_unverified' | 'source_removed_or_changed' | 'summary_dependency_invalid';

/** Hash every input that can inform a summary, excluding host task/approval/UI state. */
export function historySummaryMessageHash(message: ChatMessage): string {
  return hash(JSON.stringify([
    message.id, message.role, message.createdAt, message.modelId, message.content,
    message.expandedContent, message.providerContent, message.toolRounds, message.providerReplay
  ]));
}

export function historySummaryHash(summary: HistorySummary): string {
  return hash(JSON.stringify([summary.id, summary.content, summary.coveredMessageIds, summary.version, summary.provenance]));
}

export function createHistorySummaryProvenance(messages: readonly ChatMessage[]): NonNullable<HistorySummary['provenance']> {
  return { version: 1, messageHashes: Object.fromEntries(messages.map(message => [message.id, historySummaryMessageHash(message)])),
    // Current summaries consume raw messages only. Explicitly record no summary dependencies.
    summaryHashes: {} };
}

/** Reconcile derived context only. The caller commits history and Store invalidation durably. */
export function reconcileTruncatedContext(session: ChatSession, retainedMessages: readonly ChatMessage[]): {
  summaryInvalidations: Array<{ id: string; reason: SummaryTruncationInvalidationReason }>;
  dynamicContextRefreshRequired: boolean;
} {
  const retained = new Map(retainedMessages.map(message => [message.id, message]));
  const state = session.contextCompression;
  const summaryInvalidations: Array<{ id: string; reason: SummaryTruncationInvalidationReason }> = [];
  if (state) {
    const summaries = new Map(state.summaries.map(summary => [summary.id, summary]));
    const validity = new Map<string, boolean>();
    const visiting = new Set<string>();
    const validate = (summary: HistorySummary): boolean => {
      if (validity.has(summary.id)) return validity.get(summary.id)!;
      if (visiting.has(summary.id)) return false;
      visiting.add(summary.id);
      let reason: SummaryTruncationInvalidationReason | undefined;
      const proof = summary.provenance;
      if (!proof || proof.version !== 1) reason = 'source_unverified';
      else if (!summary.coveredMessageIds.length
        || summary.coveredMessageIds.some(id => !retained.has(id) || !proof.messageHashes[id])
        || Object.entries(proof.messageHashes).some(([id, expected]) => {
          const message = retained.get(id);
          return !message || historySummaryMessageHash(message) !== expected;
        })) reason = 'source_removed_or_changed';
      else if (Object.entries(proof.summaryHashes).some(([id, expected]) => {
        const dependency = summaries.get(id);
        return !dependency || historySummaryHash(dependency) !== expected || !validate(dependency);
      })) reason = 'summary_dependency_invalid';
      visiting.delete(summary.id);
      validity.set(summary.id, !reason);
      if (reason) summaryInvalidations.push({ id: summary.id, reason });
      return !reason;
    };
    const validSummaries = state.summaries.filter(validate);
    session.contextCompression = {
      ...state,
      summaries: validSummaries,
      protectedMessageIds: state.protectedMessageIds.filter(id => retained.has(id)),
      protectionState: state.protectionState ? {
        ...state.protectionState,
        pendingMessageIds: state.protectionState.pendingMessageIds.filter(id => retained.has(id)),
        settledMessageIds: state.protectionState.settledMessageIds.filter(id => retained.has(id)),
        settledFacts: state.protectionState.settledFacts?.filter(fact => retained.has(fact.messageId))
      } : undefined,
      // Measurements and failure fingerprints describe the old projection, not the retained one.
      lastCompression: undefined,
      lastFailureReason: undefined,
      lastCompressedAt: validSummaries.at(-1)?.updatedAt
    };
  }

  let dynamicHash = hash(session.contextInstructions ?? '');
  let dynamicContextRefreshRequired = false;
  const coveredIds = new Set(session.contextCompression?.summaries.flatMap(summary => summary.coveredMessageIds));
  // The replacement will be the latest user. Do not preserve a summarized
  // predecessor merely because it is temporarily last during this transaction.
  const protectedIds = getAutoProtectedMessageIds([...retainedMessages,
    { id: randomUUID(), role: 'user', content: '', createdAt: '' }], session.contextCompression);
  for (const message of retainedMessages) {
    if (message.role !== 'user') continue;
    if (coveredIds.has(message.id) && !protectedIds.has(message.id)) continue;
    if (message.dynamicContextHash) {
      dynamicHash = message.dynamicContextHash;
      dynamicContextRefreshRequired = false;
    } else if (message.providerContent?.includes('<keepseek-dynamic-context>')) {
      // A tail without host provenance cannot prove the effective context hash. Do not parse user text as authority.
      dynamicContextRefreshRequired = true;
    }
  }
  if (session.requestProtocol) session.requestProtocol.lastDynamicContextHash = dynamicHash;
  return { summaryInvalidations, dynamicContextRefreshRequired };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
