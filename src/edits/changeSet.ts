import { randomUUID } from 'node:crypto';
import type { ChangeSet, DraftEdit } from '../shared/types';

export function createChangeSet(input: {
  runId: string;
  sessionId?: string;
  messageId?: string;
  traceLogUri?: string;
  edits: readonly DraftEdit[];
  operationSummary?: string;
}): ChangeSet | undefined {
  if (!input.edits.length) {
    return undefined;
  }
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    runId: input.runId,
    sessionId: input.sessionId ?? '',
    messageId: input.messageId ?? '',
    traceLogUri: input.traceLogUri,
    fileCount: input.edits.length,
    operationSummary: input.operationSummary?.trim() || summarizeEditReasons(input.edits),
    files: input.edits.map((edit) => ({
      ...edit,
      status: 'pending'
    })),
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
}

function summarizeEditReasons(edits: readonly DraftEdit[]): string {
  const reasons = Array.from(new Set(edits.map((edit) => edit.reason.trim()).filter(Boolean)));
  const summary = reasons.slice(0, 3).join('; ');
  if (summary.length <= 320) {
    return summary || `${edits.length} pending file change${edits.length === 1 ? '' : 's'}`;
  }
  return `${summary.slice(0, 319).trimEnd()}…`;
}
