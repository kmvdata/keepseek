import type { KeepseekLanguage } from './i18n';

export interface KeepseekModel {
  id: string;
  label: string;
  provider: string;
  contextWindowTokens?: number;
}

export interface KeepseekExtensionInfo {
  displayName: string;
  version: string;
  publisher: string;
  author: string;
  repositoryUrl: string;
  license: string;
}

export type ReasoningEffort = 'high' | 'max';

export interface AgentSettings {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
}

export type ContextFileSource = 'workspace' | 'external';

export type SkillSource = 'workspace' | 'agentsWorkspace' | 'user' | 'agentsUser' | 'builtin';

export interface ContextFile {
  id: string;
  uri: string;
  label: string;
  fsPath: string;
  languageId: string;
  content: string;
  sizeBytes: number;
  source: ContextFileSource;
}

export interface ContextUsageEstimate {
  usedTokensEstimate: number;
  maxTokensEstimate: number;
  remainingTokensEstimate: number;
  usedPercent: number;
  remainingPercent: number;
  breakdown: {
    systemTokensEstimate: number;
    contextFileTokensEstimate: number;
    historyTokensEstimate: number;
    inputTokensEstimate: number;
    toolSchemaTokensEstimate: number;
    toolCallTokensEstimate: number;
    toolResultTokensEstimate: number;
    reasoningTokensEstimate: number;
    outputReserveTokensEstimate: number;
    safetyReserveTokensEstimate: number;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

export interface UsageCostRates {
  cacheHitPrice: number;
  inputPrice: number;
  outputPrice: number;
  currency: string;
}

export interface UsageEvent {
  usage: Usage;
  cost: number;
  currency: string;
  modelId: string;
  requestId?: string;
}

export interface TurnUsageStats extends Usage {
  requestCount: number;
  cost: number;
  currency: string;
  modelId?: string;
  updatedAt?: string;
}

export interface SessionUsageStats extends Usage {
  requestCount: number;
  sessionCost: number;
  currency: string;
  updatedAt?: string;
}

export interface DeepSeekBalanceState {
  totalBalance?: number;
  currency: string;
  isAvailable?: boolean;
  updatedAt?: string;
  error?: string;
}

export interface PromptCacheDiagnostics {
  systemPromptHash?: string;
  toolsSchemaHash?: string;
  modelId?: string;
  historyCompacted?: boolean;
  historyRewriteReason?: string;
  cacheMissPossibleReasons?: string[];
  updatedAt?: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessageContextMeta {
  isProtected?: boolean;
  protectedReason?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  expandedContent?: string;
  createdAt: string;
  modelId?: string;
  reasoningContent?: string;
  isStreaming?: boolean;
  contextMeta?: ChatMessageContextMeta;
  usedSkills?: ChatMessageSkill[];
}

export interface ChatMessageSkill {
  id: string;
  name: string;
  source: SkillSource;
}

export interface HistorySummary {
  id: string;
  content: string;
  coveredMessageIds: string[];
  createdAt: string;
  updatedAt: string;
  tokenEstimate: number;
  modelId?: string;
  version: number;
}

export interface ContextCompressionState {
  version: number;
  summaries: HistorySummary[];
  protectedMessageIds: string[];
  lastCompressedAt?: string;
  lastFailureReason?: string;
}

export interface ContextProjectionMetadata {
  usedSummary: boolean;
  summaryCount: number;
  protectedMessageCount: number;
  recentMessageCount: number;
  fallbackReason?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  activeSkillIds?: string[];
  contextCompression?: ContextCompressionState;
  contextUsage?: ContextUsageEstimate;
  usageStats?: SessionUsageStats;
  lastTurnUsage?: TurnUsageStats;
  balance?: DeepSeekBalanceState;
  promptCacheDiagnostics?: PromptCacheDiagnostics;
  lastTraceLogUri?: string;
  createdAt: string;
  updatedAt: string;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  isFavorite: boolean;
  customTitle?: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  workspaceKey: string;
  workspaceName: string;
  isFavorite: boolean;
  customTitle?: string;
}

export interface WorkspaceSummary {
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  sessionCount: number;
  updatedAt: string;
}

export type DraftEditAction = 'create' | 'modify' | 'delete' | 'move';

export interface DraftEdit {
  id: string;
  uri: string;
  label: string;
  action: DraftEditAction;
  newText: string;
  reason: string;
}

export type TaskPlanStatus = 'running' | 'blocked' | 'completed' | 'failed' | 'stopped';

export type TaskPlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed' | 'skipped';

export interface TaskPlanStep {
  id: string;
  title: string;
  status: TaskPlanStepStatus;
  detail?: string;
  updatedAt: string;
}

export interface TaskPlan {
  id: string;
  runId: string;
  sessionId?: string;
  goal: string;
  status: TaskPlanStatus;
  steps: TaskPlanStep[];
  currentStepId?: string;
  blockers: string[];
  completionSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export type ChangeSetStatus =
  | 'pending'
  | 'partially_applied'
  | 'applied'
  | 'partially_failed'
  | 'reverted'
  | 'discarded';

export type ChangeSetFileStatus =
  | 'pending'
  | 'applied'
  | 'discarded'
  | 'apply_failed'
  | 'reverted'
  | 'revert_failed';

export interface ChangeSetFile extends DraftEdit {
  status: ChangeSetFileStatus;
  error?: string;
  checkpointId?: string;
}

export interface ChangeSetApplyFailure {
  editId: string;
  label: string;
  error: string;
}

export interface ChangeSetApplyResult {
  changeSetId: string;
  attempted: number;
  appliedEditIds: string[];
  failed: ChangeSetApplyFailure[];
  completedAt: string;
}

export interface ChangeSetRevertResult {
  changeSetId: string;
  attempted: number;
  revertedEditIds: string[];
  failed: ChangeSetApplyFailure[];
  completedAt: string;
}

export interface ChangeCheckpoint {
  id: string;
  changeSetId: string;
  editId: string;
  uri: string;
  label: string;
  action: DraftEditAction;
  originalExists: boolean;
  originalText?: string;
  originalTextHash?: string;
  appliedExists: boolean;
  appliedTextHash?: string;
  createdAt: string;
  appliedAt: string;
  revertedAt?: string;
}

export interface ChangeSet {
  id: string;
  runId: string;
  sessionId: string;
  messageId: string;
  traceLogUri?: string;
  fileCount: number;
  operationSummary: string;
  files: ChangeSetFile[];
  status: ChangeSetStatus;
  lastApplyResult?: ChangeSetApplyResult;
  createdAt: string;
  updatedAt: string;
}

export type ValidationAuthorizationPolicy = 'never' | 'ask' | 'always';

export type SafeNpmScript = 'compile' | 'lint' | 'test';

export interface WorkspaceDiagnosticItem {
  uri: string;
  path: string;
  severity: 'error' | 'warning' | 'information' | 'hint';
  message: string;
  source?: string;
  code?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface WorkspaceDiagnosticSummary {
  ok: boolean;
  total: number;
  errors: number;
  warnings: number;
  information: number;
  hints: number;
  truncated: boolean;
  items: WorkspaceDiagnosticItem[];
}

export interface ValidationToolResult {
  ok: boolean;
  kind: 'npm_script';
  script: SafeNpmScript;
  workspaceFolder?: string;
  taskName?: string;
  authorized: boolean;
  exitCode?: number;
  durationMs: number;
  timedOut: boolean;
  diagnostics?: WorkspaceDiagnosticSummary;
  error?: string;
}

export interface ReferenceResource {
  uri: string;
  path: string;
  label: string;
  description: string;
  workspaceFolder: string;
  kind: 'file' | 'directory';
}

export interface AgentRequest {
  prompt: string;
  model: KeepseekModel;
  settings: AgentSettings;
  contextFiles: ContextFile[];
  skills?: ActivatedSkill[];
  history: ChatMessage[];
  contextCompression?: ContextCompressionState;
  historyRewriteReason?: string;
  language: KeepseekLanguage;
  sessionId?: string;
  assistantMessageId?: string;
  signal?: AbortSignal;
}

export interface ActivatedSkill {
  id: string;
  name: string;
  source: SkillSource;
  rootUri: string;
  skillUri: string;
  content: string;
  loadedResourceUris?: string[];
}

export interface AgentResponse {
  runId: string;
  message: string;
  reasoningContent?: string;
  draftEdits: DraftEdit[];
  taskPlan: TaskPlan;
  changeSet?: ChangeSet;
  usage?: TurnUsageStats;
  promptCacheDiagnostics?: PromptCacheDiagnostics;
  traceLog?: AgentTraceLogInfo;
}

export type AgentActivityBase = 'idle' | 'thinking' | 'executing' | 'waiting' | 'complete' | 'error' | 'stopped';

export type AgentActivityPhase =
  | 'idle'
  | 'preparing'
  | 'expanding_references'
  | 'requesting_model'
  | 'reasoning'
  | 'planning_tool'
  | 'executing_tool'
  | 'reading_file'
  | 'reading_file_range'
  | 'searching_workspace'
  | 'listing_files'
  | 'listing_directory'
  | 'creating_draft_edit'
  | 'reading_diagnostics'
  | 'running_validation'
  | 'reviewing_tool_result'
  | 'generating'
  | 'finalizing'
  | 'failed';

export interface AgentActivityInput {
  base: AgentActivityBase;
  phase: AgentActivityPhase;
  toolName?: string;
  detail?: string;
}

export interface AgentActivityState extends AgentActivityInput {
  updatedAt: string;
  sequence: number;
}

export type AgentProgressEvent =
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string };

export interface AgentTraceLogInfo {
  runId: string;
  uri: string;
}

export interface AgentRunCallbacks {
  onDelta?: (event: AgentProgressEvent) => void;
  onStatus?: (status: AgentActivityInput) => void;
  onUsageEstimate?: (usage: ContextUsageEstimate) => void;
  onUsage?: (event: UsageEvent) => void;
  onTraceLog?: (traceLog: AgentTraceLogInfo) => void;
  onTaskPlan?: (taskPlan: TaskPlan) => void;
}
