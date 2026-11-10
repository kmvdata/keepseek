import type {
  AgentRequest,
  DraftEdit,
  DraftRunProposal,
  ProviderUsageLedgerRecord,
  SubagentRunUsageSummary,
  UsageEvent
} from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';

export type SubagentLane = 'research-read' | 'review-read' | 'proposal' | 'nested-read';
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
export type SubagentProgressPhase = 'queued' | 'searching' | 'reading' | 'analyzing' | 'preparing_proposal' | 'finalizing' | 'completed' | 'failed' | 'stopped';
export type SubagentToolCategory = 'search' | 'read' | 'analysis' | 'proposal' | 'delegation';
export type SubagentFailureKind = 'provider_failure' | 'timeout' | 'cancelled' | 'budget_exhausted' | 'protocol_error' | 'unauthorized_tool' | 'result_rejected' | 'interrupted';

export interface SubagentDiagnosticReference {
  id: string;
  kind: SubagentFailureKind;
  sizeBytes: number;
  expiresAt: string;
}

export interface SubagentModelSetting {
  version: 1;
  mode: 'follow-main' | 'fixed';
  sourceId?: string;
  modelId?: string;
  updatedAt: string;
}

export interface SubagentProfile {
  id: string;
  label: string;
  description: string;
  lane: SubagentLane;
  instructions: string;
  toolNames: string[];
  maxSteps?: number;
  timeoutMs?: number;
  canDelegate: boolean;
  resultMaxChars: number;
  sourceSkillId?: string;
}

export interface DelegateTaskInput {
  task: string;
  /** V11 parent assessment identity; does not grant child capabilities. */
  candidateId?: string;
  /** Host-only assessed capability declaration. Never parsed from model arguments. */
  assessedCapabilities?: Array<'read' | 'review' | 'proposal'>;
  profile?: string;
  lane?: SubagentLane;
  paths?: string[];
  continueSubagentId?: string;
  maxSteps?: number;
  timeoutMs?: number;
}

export interface DelegateParallelInput {
  tasks: DelegateTaskInput[];
  failFast?: boolean;
}

export interface ReadSubagentResultInput {
  /** Canonical child-result reference. */
  ref: string;
  offsetBytes?: number;
  limitBytes?: number;
}

export type SubagentManifestStatus = 'completed' | 'failed' | 'cancelled' | 'budget_exhausted' | 'stopped';

/** Provider-visible handoff. Full result text never appears in this object. */
export interface SubagentResultManifest {
  version: 3;
  ok: boolean;
  kind: 'subagent_result_manifest';
  subagentId: string;
  treeId: string;
  profile: string;
  lane: SubagentLane;
  depth: number;
  status: SubagentManifestStatus;
  /** V3: ok accepts non-failed material (including partial), never parent approval. */
  resultStatus?: 'complete' | 'partial' | 'failed';
  formatAccepted?: boolean;
  parentAcceptance?: 'pending' | 'accepted' | 'needs_details' | 'needs_followup' | 'rejected';
  missing?: string[];
  uncertainties?: string[];
  keyEvidence?: Array<{ claim: string; path?: string; startLine?: number; verification: 'unverified' }>;
  summary: string;
  preview: string;
  resultRef: string;
  resultHash: string;
  resultChars: number;
  resultBytes: number;
  hasMore: boolean;
  resultTruncated?: boolean;
  originalResultChars?: number;
  originalResultHash?: string;
  model: { sourceId: string; modelId: string };
  usageSummary: { requests: number; totalTokens: number };
  draftEditCount: number;
  draftRunCount: number;
  errorType?: string;
  error?: string;
  diagnosticRef?: string;
  reusedFromSubagentId?: string;
}

export interface SubagentInvocationContext {
  parentRequest: AgentRequest;
  parentRunId: string;
  parentToolCallId?: string;
  parentDraftEditUris?: string[];
  language: KeepseekLanguage;
  signal?: AbortSignal;
  onUsage?: (event: UsageEvent) => void;
  onUsageLedgerRecord?: (record: ProviderUsageLedgerRecord) => Promise<void> | void;
  getCacheObservationCandidates?: import('../../shared/types').AgentRunCallbacks['getCacheObservationCandidates'];
  onRunSummary?: (summary: SubagentRunUsageSummary) => void;
}

export interface SubagentToolExecution {
  content: string;
  draftEdits?: DraftEdit[];
  draftRuns?: DraftRunProposal[];
}

export interface SubagentTreeBudget {
  count: number;
  parents: Array<[string, number]>;
  paths: Array<[string, string]>;
}

export interface SubagentToolAdapter {
  inspectResult?(subagentId: string, context: SubagentInvocationContext): Promise<{
    subagentId: string;
    resultHash: string;
    resultStatus: 'complete' | 'partial' | 'failed';
    formatAccepted: boolean;
  } | undefined>;
  snapshotTree?(treeId: string): SubagentTreeBudget | undefined;
  restoreTree?(treeId: string, budget: SubagentTreeBudget): void;
  releaseTree?(treeId: string): void;
  delegateTask(input: DelegateTaskInput, context: SubagentInvocationContext): Promise<SubagentToolExecution>;
  delegateParallel(input: DelegateParallelInput, context: SubagentInvocationContext): Promise<SubagentToolExecution>;
  readResult(input: ReadSubagentResultInput, context: SubagentInvocationContext): Promise<SubagentToolExecution>;
}

export interface SubagentProgressState {
  id: string;
  parentSessionId: string;
  parentRunId: string;
  parentToolCallId?: string;
  profile: string;
  lane: SubagentLane;
  depth: number;
  status: SubagentStatus;
  phase?: SubagentProgressPhase;
  toolCategory?: SubagentToolCategory;
  summary: string;
  queuedAt?: string;
  startedAt?: string;
  durationMs?: number;
  diagnosticRef?: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StoredSubagentMetadata {
  version: 2;
  id: string;
  treeId: string;
  parentSessionId: string;
  parentRunId: string;
  rootRunId: string;
  parentSubagentId?: string;
  depth: number;
  profile: string;
  lane: SubagentLane;
  task: string;
  status: SubagentStatus;
  sourceId: string;
  modelId: string;
  provider: string;
  sourceConfigHash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  profileHash: string;
  projectInstructionsHash: string;
  /** Frozen project/profile context proof for controlled child continuation. */
  hostContextHash?: string;
  authorizationContextHash?: string;
  workspaceContextHash?: string;
  normalizedTaskHash?: string;
  resultStatus?: 'complete' | 'partial' | 'failed';
  resultContractVersion?: 2;
  resultFormatAccepted?: boolean;
  failureKind?: SubagentFailureKind;
  resultEnvelope?: import('./resultEnvelope').SubagentResultEnvelope;
  readSet?: Array<{ uri: string; contentHash: string; sizeBytes: number }>;
  readSetComplete?: boolean;
  reusedFromSubagentId?: string;
  reusedFromParentRunId?: string;
  freshness?: 'fresh' | 'stale' | 'unverified';
  diagnostic?: SubagentDiagnosticReference;
  resultHash?: string;
  resultChars?: number;
  resultBytes?: number;
  originalResultHash?: string;
  originalResultChars?: number;
  resultTruncated?: boolean;
  usage?: import('../../shared/types').TurnUsageStats;
  stats?: SubagentRunUsageSummary;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StoredSubagentTranscript {
  checkpoint?: import('../runCheckpoint').RunCheckpoint;
  version: 2;
  metadataId: string;
  contextInstructions: string;
  messages: import('../../shared/types').ChatMessage[];
  /** V2 messages may keep an empty final assistant content; restore from result. */
  resultMessageId?: string;
  /** V2 reuse records point at the canonical stored result instead of copying it. */
  resultRef?: string;
  result: string;
}
