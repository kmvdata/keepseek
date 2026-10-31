import type { ChatMessage, ContextCompressionState, HistoryWorkFact } from '../shared/types';

const TRANSIENT = new Set(['draft_run_proposal', 'draft_run_result', 'draft_edit_result',
  'delegated_approval_result', 'background_run_result', 'plan_execution_continuation']);
const SETTLED = new Set(['applied', 'reverted', 'superseded', 'discarded', 'rejected', 'done', 'cancelled', 'failed']);

export function normalizeHistoryWorkFacts(value: unknown): HistoryWorkFact[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is HistoryWorkFact => Boolean(item && typeof item === 'object'
    && typeof item.messageId === 'string' && typeof item.status === 'string' && SETTLED.has(item.status)))
    .map(item => {
      const fact: HistoryWorkFact = { messageId: item.messageId, status: item.status };
      for (const key of ['artifactId', 'target', 'approval', 'baseHash', 'resultHash', 'specHash'] as const) {
        const v = item[key];
        if (typeof v === 'string' && v.length <= 8192 && (!key.endsWith('Hash') || /^[a-f0-9]{64}$/u.test(v))) fact[key] = v;
      }
      return fact;
    });
}

/** Inputs are host store records, never model text. Missing proposal state is
 * unresolved; a tool execution that might have side effects remains protected. */
export function deriveHistoryProtection(history: readonly ChatMessage[], artifacts: readonly HistoryWorkFact[]): NonNullable<ContextCompressionState['protectionState']> {
  const byMessage = new Map<string, string[]>();
  for (const artifact of artifacts) byMessage.set(artifact.messageId, [...(byMessage.get(artifact.messageId) ?? []), artifact.status]);
  const pendingMessageIds: string[] = [], settledMessageIds: string[] = [];
  for (const message of history) {
    const cp = message.runCheckpoint;
    const archive = message.runCheckpointArchive;
    const reason = message.contextMeta?.protectedReason ?? '';
    const states = byMessage.get(message.id);
    if (cp?.state?.pending || cp?.stopReason === 'uncertain_tool_result'
      || archive?.pendingTool || (archive && archive.pendingTool === undefined && archive.summary.status !== 'completed')
      || message.runCheckpointArchive?.summary.stopReason === 'uncertain_tool_result'
      || states?.some(status => !SETTLED.has(status))) {
      pendingMessageIds.push(message.id);
    } else if (states?.length && states.every(status => SETTLED.has(status))) {
      settledMessageIds.push(message.id);
    } else if (TRANSIENT.has(reason)) {
      const isProposal = reason === 'draft_run_proposal' || (reason === 'draft_edit_result'
        && (cp || message.runCheckpointArchive || message.toolRounds?.length));
      (isProposal ? pendingMessageIds : settledMessageIds).push(message.id);
    }
  }
  return { version: 1, pendingMessageIds, settledMessageIds,
    settledFacts: artifacts.filter(artifact => settledMessageIds.includes(artifact.messageId)).map(artifact => ({ ...artifact })) };
}
