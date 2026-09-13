export type ToolEvidenceContentType = 'text' | 'json' | 'diff' | 'diagnostics' | 'structured';
export type ToolEvidenceExecutionStatus = 'pending' | 'executing' | 'completed' | 'uncertain';
export type ToolEvidenceDeliveryStatus = 'pending' | 'envelope_ready' | 'sending' | 'delivered';
export const MIN_EVIDENCE_ENVELOPE_TOKENS = 320;

export interface ToolEvidenceSource {
  path?: string;
  uri?: string;
  fingerprint?: string;
  startLine?: number;
  endLine?: number;
}

/** Durable, task-scoped journal entry. Provider-visible bytes live in
 * providerEnvelope and are immutable after the first successful write. */
export interface ToolEvidence {
  version: 1;
  id: string;
  evidenceRef: string;
  sessionId: string;
  taskId: string;
  epochIndex?: number;
  toolCallId: string;
  toolName: string;
  argumentsHash: string;
  effectKind: 'read' | 'proposal' | 'validation' | 'delegation';
  executionStatus: ToolEvidenceExecutionStatus;
  deliveryStatus: ToolEvidenceDeliveryStatus;
  contentHash?: string;
  contentType?: ToolEvidenceContentType;
  totalChars?: number;
  totalBytes?: number;
  totalTokensEstimate?: number;
  source?: ToolEvidenceSource;
  storageKind?: 'blob' | 'replayable-source';
  blobName?: string;
  providerEnvelope?: string;
  completeInline?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EvidenceIntentInput {
  sessionId: string;
  taskId: string;
  epochIndex?: number;
  toolCallId: string;
  toolName: string;
  argumentsHash: string;
  effectKind: ToolEvidence['effectKind'];
}

export interface EvidenceReadInput {
  evidenceRef: string;
  sessionId: string;
  taskId: string;
  cursor?: string;
  offset?: number;
  startLine?: number;
  endLine?: number;
  itemOffset?: number;
  itemLimit?: number;
  search?: string;
  maxChars?: number;
}
