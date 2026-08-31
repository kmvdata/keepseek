import type {
  AgentRequest,
  DraftEdit,
  DraftRunProposal,
  SubagentRunUsageSummary,
  UsageEvent
} from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';

export type SubagentLane = 'research-read' | 'review-read' | 'proposal' | 'nested-read';
export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

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
  subagentId: string;
  offset?: number;
  maxChars?: number;
}

export interface SubagentInvocationContext {
  parentRequest: AgentRequest;
  parentRunId: string;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  onUsage?: (event: UsageEvent) => void;
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
  profile: string;
  lane: SubagentLane;
  depth: number;
  status: SubagentStatus;
  summary: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
}

export interface StoredSubagentMetadata {
  version: 1;
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
  resultHash?: string;
  resultChars?: number;
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
  version: 1;
  metadataId: string;
  contextInstructions: string;
  messages: import('../../shared/types').ChatMessage[];
  result: string;
}
