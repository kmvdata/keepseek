import type { KeepseekLanguage } from './i18n';
import type { ModelSourceConfigSnapshot } from '../accounts/types';
import type { AnthropicModelCapabilities } from '../accounts/types';

export interface KeepseekModel {
  id: string;
  label: string;
  provider: string;
  contextWindowTokens?: number;
  /** Provenance for the effective context window shown in model settings. */
  contextWindowSource?: ModelCapabilitySource;
  maxOutputTokens?: number;
  /** Provenance for the effective max output shown in model settings. */
  maxOutputSource?: ModelCapabilitySource;
  /** False for known image-generation or speech-synthesis resources that the text Agent cannot call. */
  agentCompatible?: boolean;
  nonTextModelKind?: NonTextModelKind;
  anthropicCapabilities?: AnthropicModelCapabilities;
  /** Display name returned by the selected provider's /models endpoint. */
  fetchedName?: string;
  /** Every selectable catalog model has these fields; profile-only fixtures may omit them. */
  sourceId?: string;
  sourceName?: string;
  supportsBilling?: boolean;
}

export type ModelCapabilitySource = 'manual' | 'discovered' | 'built-in' | 'guessed' | 'fallback';

export type NonTextModelKind = 'image-generation' | 'speech-synthesis';

export interface ModelSelection {
  sourceId: string;
  modelId: string;
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

export type CompressionThreshold = 'aggressive' | 'balanced' | 'cache';

export interface AgentSettings {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  compressionThreshold: CompressionThreshold;
}

export type ContextFileSource = 'workspace' | 'external';

export type SkillSource = 'workspace' | 'agentsWorkspace' | 'user' | 'agentsUser' | 'builtin';

export type SkillActivationSource = 'explicit' | 'session' | 'workspace-default' | 'implicit';

export interface SkillActivationInfo {
  source: SkillActivationSource;
  reason: string;
  score?: number;
}

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
  /** Whether cache token fields were actually returned by the provider. */
  cacheDataStatus?: UsageCacheDataStatus;
}

export type UsageCacheDataStatus = 'reported' | 'partial' | 'unavailable';
export type UsagePricingStatus = 'priced' | 'unavailable';

export interface UsageCostRates {
  // 空闲时段(或单一档)价格,兼容旧配置;旧配置缺省峰谷时段时按此档计费
  cacheHitPrice: number; // 输入·缓存命中 (¥/M tokens)
  inputPrice: number; // 输入·缓存未命中 (¥/M tokens)
  outputPrice: number; // 输出 (¥/M tokens)
  currency: string;
  // DeepSeek 峰谷定价(2026-08-17 起):高峰时段可选,缺省时回退到上面空闲档
  peakCacheHitPrice?: number;
  peakInputPrice?: number;
  peakOutputPrice?: number;
}

export interface UsageEvent {
  usage: Usage;
  cost: number;
  currency: string;
  sourceId?: string;
  modelId: string;
  provider?: string;
  protocol?: string;
  pricingStatus?: UsagePricingStatus;
  requestId?: string;
  source: UsageSource;
  /** Physical provider attempts represented by this event. Defaults to one. */
  requestCount?: number;
}

export type UsageSource =
  | 'executor'
  | 'summary'
  | 'retry'
  | 'continuation'
  | 'background'
  | 'subagent'
  | 'retrieval'
  | 'router';

export interface UsageSourceStats extends Usage {
  requestCount: number;
  cost: number;
  pricedRequestCount?: number;
  unpricedRequestCount?: number;
  /** Accounted provider cost split by currency. Different currencies are never summed. */
  costByCurrency?: Record<string, number>;
  /** Requests for which the provider returned cache token fields. */
  cacheDataRequestCount?: number;
  /** Requests for which provider cache token fields were absent. */
  cacheDataMissingRequestCount?: number;
}

export interface UsageModelGroupStats extends Usage {
  sourceId: string;
  modelId: string;
  provider?: string;
  protocol?: string;
  requestCount: number;
  pricedRequestCount: number;
  unpricedRequestCount: number;
  cacheDataRequestCount: number;
  cacheDataMissingRequestCount: number;
  costByCurrency?: Record<string, number>;
  bySource?: Partial<Record<UsageSource, UsageSourceStats>>;
}

export interface TurnUsageStats extends Usage {
  requestCount: number;
  cost: number;
  currency: string;
  sourceId?: string;
  modelId?: string;
  provider?: string;
  protocol?: string;
  pricingStatus?: 'priced' | 'unavailable' | 'partial';
  pricedRequestCount?: number;
  unpricedRequestCount?: number;
  cacheDataRequestCount?: number;
  cacheDataMissingRequestCount?: number;
  costByCurrency?: Record<string, number>;
  updatedAt?: string;
  bySource?: Partial<Record<UsageSource, UsageSourceStats>>;
}

export interface SessionUsageStats extends Usage {
  requestCount: number;
  sessionCost: number;
  currency: string;
  pricingStatus?: 'priced' | 'unavailable' | 'partial';
  pricedRequestCount?: number;
  unpricedRequestCount?: number;
  cacheDataRequestCount?: number;
  cacheDataMissingRequestCount?: number;
  costByCurrency?: Record<string, number>;
  byModelSource?: UsageModelGroupStats[];
  /** Persisted aggregate from an older version that cannot be attributed safely. */
  legacyUnattributed?: boolean;
  updatedAt?: string;
  bySource?: Partial<Record<UsageSource, UsageSourceStats>>;
}

export type SubagentTerminalStatus = 'completed' | 'failed' | 'stopped';
export type SubagentHandoffKind = 'delegate' | 'parallel' | 'read-result';

/** Numeric-only summary of one isolated child run. No task, result, reasoning, or tool content is stored here. */
export interface SubagentRunUsageSummary {
  subagentId: string;
  parentRunId: string;
  rootRunId: string;
  depth: number;
  profile: string;
  lane: string;
  status: SubagentTerminalStatus;
  sourceId: string;
  modelId: string;
  provider: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  usage?: TurnUsageStats;
  toolCallTokensEstimate: number;
  toolResultTokensEstimate: number;
  reasoningTokensEstimate: number;
  isolatedIntermediateTokensEstimate: number;
  estimatorVersion: string;
}

export interface SubagentUsageGroup {
  sourceId?: string;
  modelId?: string;
  provider?: string;
  profile?: string;
  lane?: string;
  taskCount: number;
  completedCount: number;
  failedCount: number;
  stoppedCount: number;
  usage?: TurnUsageStats;
}

export interface SubagentHandoffEstimate {
  handoffId: string;
  rootRunId: string;
  kind: SubagentHandoffKind;
  tokensEstimate: number;
  createdAt: string;
}

export interface SubagentSessionUsageStats {
  schemaVersion: 1;
  totalCount: number;
  completedCount: number;
  failedCount: number;
  stoppedCount: number;
  byModel: SubagentUsageGroup[];
  byProfileLane: SubagentUsageGroup[];
  recentRuns: SubagentRunUsageSummary[];
  /** Minimal idempotency ledger; unlike recentRuns it is not a user-facing detail list. */
  countedSubagentIds: string[];
  isolatedIntermediateTokensEstimate: number;
  rootHandoffTokensEstimate: number;
  rootHandoffCount: number;
  handoffCountByKind: Record<SubagentHandoffKind, number>;
  countedHandoffIds: string[];
  updatedAt: string;
}

export interface ModelSourceBalanceState {
  totalBalance?: number;
  cashBalance?: number;
  voucherBalance?: number;
  currency: string;
  isAvailable?: boolean;
  updatedAt?: string;
  error?: string;
}

/** Backward-compatible name retained for persisted sessions and existing callers. */
export type DeepSeekBalanceState = ModelSourceBalanceState;

export interface PromptCacheDiagnostics {
  systemPromptHash?: string;
  toolsSchemaHash?: string;
  /** 历史消息（非 system 段）序列的指纹；变化即该段之后的前缀缓存全部失效 */
  historyPrefixHash?: string;
  modelId?: string;
  protocol?: string;
  sourceId?: string;
  baseUrl?: string;
  historyCompacted?: boolean;
  historyRewriteReason?: string;
  cacheMissPossibleReasons?: string[];
  updatedAt?: string;
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessageContextMeta {
  isProtected?: boolean;
  protectedReason?: string;
  displayKind?: 'draft_run_auto_continue' | 'delegated_auto_continue';
}

export type DraftRunStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'running'
  | 'done'
  | 'cancelled'
  | 'failed';

export type DraftRunEffect =
  | 'workspace_read'
  | 'workspace_write'
  | 'external_write'
  | 'network'
  | 'package_install'
  | 'git_mutation'
  | 'publish_or_deploy'
  | 'credential_access'
  | 'privilege_escalation'
  | 'shell_interpreter'
  | 'arbitrary_code'
  | 'long_running'
  | 'unknown';

export interface DraftRunEnvironmentEntry {
  name: string;
  value: string;
}

export interface DraftRunSpec {
  executable: string;
  args: string[];
  reason: string;
  workspaceFolder?: string;
  /** Exact resolved working-directory URI used for approval and execution. */
  cwdUri: string;
  cwdLabel: string;
  externalCwd: boolean;
  timeoutMs: number;
  env: DraftRunEnvironmentEntry[];
}

export interface DraftRunEffectAssessment {
  version: number;
  verdict: 'enforced_readonly' | 'likely_readonly' | 'mutating_or_sensitive' | 'unknown';
  effects: DraftRunEffect[];
  evidence: string[];
}

export interface DraftRunProposal {
  id: string;
  spec: DraftRunSpec;
  specHash: string;
  effectAssessment: DraftRunEffectAssessment;
}

export interface ExecutionPermit {
  draftRunId: string;
  specHash: string;
  source: 'user_click' | 'readonly_policy' | 'delegated_approver';
  allowedEffects: DraftRunEffect[];
  policyVersion: number;
  expiresAt: number;
  nonce: string;
}

export interface DraftRun extends DraftRunProposal {
  agentRunId: string;
  sessionId: string;
  messageId: string;
  status: DraftRunStatus;
  authorizationSource?: ExecutionPermit['source'];
  approvedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  outputHead: string;
  outputTail: string;
  outputBytes: number;
  outputTruncated: boolean;
  omittedOutputBytes: number;
  error?: string;
  resultBoundMessageId?: string;
  /** Set only by the explicit "run and continue" user action. */
  autoContinueRequested?: boolean;
  /** Persisted before dispatch so an extension restart cannot duplicate a model request. */
  autoContinueClaimedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  runCheckpoint?: import('../agent/runCheckpoint').RunCheckpoint;
  runState?: {
    taskId: string; status: string; stopReason?: string; usedMs: number; maxExecutionMs: number; limitSource: string;
    attempt: number; modelRequests: number; retries: number; lastNetworkAt?: string; lastEventAt?: string;
    requestStartedAt?: string; lastContentAt?: string; lastStepAt?: string; steps: number; canResume: boolean; canContinueInNewTurn?: boolean; blocker?: string; error?: string;
  };
  id: string;
  role: ChatRole;
  content: string;
  expandedContent?: string;
  createdAt: string;
  modelId?: string;
  reasoningContent?: string;
  /** Exact provider-visible user content when a cache-safe tail (for example
   * archive recall) was appended without changing the text shown in the UI. */
  providerContent?: string;
  isStreaming?: boolean;
  contextMeta?: ChatMessageContextMeta;
  usedSkills?: ChatMessageSkill[];
  runDetails?: RunDetailsSummary;
  /**
   * 本 assistant 消息对应的工具轮序列（跨轮重建时逐字节还原）。
   * 每个 round = 一条带 tool_calls 的 assistant 消息 + 其后的 tool 结果消息。
   * 只对 native 工具协议收集；DSML 兑底路径不收集。
   */
  toolRounds?: AgentToolRound[];
  /** Provider-native replay, valid only inside the recorded protocol/source/endpoint lane. */
  providerReplay?: ProviderReplayState;
}

export type OpenAiResponsesReplayJsonValue =
  | string
  | number
  | boolean
  | null
  | OpenAiResponsesReplayJsonValue[]
  | { [key: string]: OpenAiResponsesReplayJsonValue };

export interface OpenAiResponsesReplayItem {
  type?: string;
  role?: string;
  [key: string]: OpenAiResponsesReplayJsonValue | undefined;
}

export interface OpenAiResponsesReplayState {
  protocol: 'openai-responses';
  sourceId: string;
  baseUrl: string;
  items: OpenAiResponsesReplayItem[];
}

export type AnthropicReplayJsonValue = OpenAiResponsesReplayJsonValue;

export type AnthropicReplayContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: { [key: string]: AnthropicReplayJsonValue } }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type AnthropicReplayAssistantContentBlock = Exclude<
  AnthropicReplayContentBlock,
  { type: 'tool_result' }
>;
export type AnthropicReplayUserContentBlock = Extract<
  AnthropicReplayContentBlock,
  { type: 'text' | 'tool_result' }
>;
export type AnthropicReplayMessage =
  | { role: 'assistant'; content: AnthropicReplayAssistantContentBlock[] }
  | { role: 'user'; content: AnthropicReplayUserContentBlock[] };

export interface AnthropicMessagesReplayState {
  protocol: 'anthropic-messages';
  sourceId: string;
  baseUrl: string;
  messages: AnthropicReplayMessage[];
}

export type ProviderReplayState = OpenAiResponsesReplayState | AnthropicMessagesReplayState;

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentToolResult {
  toolCallId: string;
  content: string;
}

/**
 * 一个工具轮的原样字节快照，用于跨轮重建与上一轮请求序列完全一致。
 */
export interface AgentToolRound {
  /** 工具轮 assistant 消息的 content 原样（null 表示原请求中为 null） */
  assistantContent: string | null;
  /** 工具轮 assistant 消息的 reasoning_content 原样 */
  reasoningContent: string | null;
  toolCalls: AgentToolCall[];
  toolResults: AgentToolResult[];
}

export interface ChatMessageSkill {
  id: string;
  name: string;
  source: SkillSource;
  activation?: SkillActivationSource;
}

export interface HistorySummary {
  id: string;
  content: string;
  coveredMessageIds: string[];
  createdAt: string;
  updatedAt: string;
  tokenEstimate: number;
  modelId?: string;
  sourceId?: string;
  provider?: string;
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

export interface ProjectInstructionContext {
  id: string;
  uri: string;
  workspaceFolder: string;
  content: string;
  characterCount: number;
  tokenEstimate: number;
  contentHash: string;
  truncated: boolean;
}

export interface LegacyProjectMemoryContext {
  content: string;
  entryIds: string[];
  tokenEstimate: number;
  sourceUris: string[];
}

export type RunContextSourceKind = 'project-instructions' | 'skill' | 'legacy-memory';

export interface RunContextSourceSummary {
  id: string;
  kind: RunContextSourceKind;
  label: string;
  uri?: string;
  source?: string;
  activation?: SkillActivationSource;
  reason?: string;
  characterCount: number;
  tokenEstimate: number;
  contentHash: string;
  truncated: boolean;
  scriptsPresent?: boolean;
}

export interface RunContextDiscardedSource {
  id: string;
  kind: RunContextSourceKind;
  uri?: string;
  reason: 'duplicate_uri' | 'duplicate_content' | 'duplicate_skill' | 'budget_exhausted' | 'workspace_untrusted' | 'disabled' | 'implicit_not_allowed' | 'not_matched' | 'implicit_limit' | 'load_failed';
  keptId?: string;
}

export interface RunContextProjectionMetadata {
  precedence: string[];
  beforeDeduplicationCount: number;
  afterDeduplicationCount: number;
  totalCharacterCount: number;
  totalTokenEstimate: number;
  truncated: boolean;
  sources: RunContextSourceSummary[];
  discarded: RunContextDiscardedSource[];
  possibleConflicts: Array<{ leftId: string; rightId: string; reason: string }>;
}

export interface CurrentRunContext {
  projectInstructions: ProjectInstructionContext[];
  skills: ActivatedSkill[];
  legacyMemory?: LegacyProjectMemoryContext;
  metadata: RunContextProjectionMetadata;
}

export type LegacyProjectMemoryMigrationStatus = 'pending' | 'draft-created' | 'completed';

export interface LegacyProjectMemoryMigrationStateView {
  detected: boolean;
  status: LegacyProjectMemoryMigrationStatus;
  sourceUris: string[];
  entryCount: number;
  canCreateDraft: boolean;
  canComplete: boolean;
  canRollback: boolean;
  exportAvailable: boolean;
  lastDraftChangeSetId?: string;
  completeDisabledReason?: string;
  rollbackDisabledReason?: string;
  error?: string;
}

export type ApprovalMode = 'ask' | 'delegate';

export interface ChatSession {
  approvalMode?: ApprovalMode;
  id: string;
  title: string;
  messages: ChatMessage[];
  activeSkillIds?: string[];
  /**
   * 会话内冻结的 implicit skill 激活结果（仅存 id 引用，不复制内容）。
   * 首个真实用户请求确定后写入；后续轮次不再随 prompt 波动重新匹配，
   * 保证 Skills 上下文块字节稳定（system 段前缀缓存可命中）。
   * 显式使用/移除 Skill、Skill 列表刷新时失效并重新计算。
   */
  frozenImplicitSkillIds?: string[];
  requestProtocol?: SessionRequestProtocol;
  historyArchive?: HistoryArchiveEntry[];
  contextCompression?: ContextCompressionState;
  /**
   * 持久化的稳定上下文块（AGENTS.md / Skills / Legacy Memory / Context Files 的
   * 格式化结果）。字节不变时跨轮复用，保证 system 段前缀稳定；变化时整体重写
   * （一次可接受的缓存代价）。
   */
  contextInstructions?: string;
  contextUsage?: ContextUsageEstimate;
  usageStats?: SessionUsageStats;
  lastTurnUsage?: TurnUsageStats;
  subagentUsageStats?: SubagentSessionUsageStats;
  balance?: ModelSourceBalanceState;
  promptCacheDiagnostics?: PromptCacheDiagnostics;
  lastTraceLogUri?: string;
  repairLoop?: RepairLoopState;
  createdAt: string;
  updatedAt: string;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  isFavorite: boolean;
  customTitle?: string;
}

export interface HistoryArchiveEntry {
  id: string;
  messageId: string;
  toolCallId?: string;
  toolName?: string;
  role: ChatRole | 'tool';
  content: string;
  contentHash: string;
  createdAt: string;
}

export interface SessionRequestProtocol {
  /** v1 replays ordinary final-answer reasoning; v2+ keeps it local-only. */
  version: number;
  serializationStrategy: 'legacy-v1' | 'provider-projection-v2';
  toolSchemaVersion: number;
  toolNames: string[];
  modelId?: string;
  sourceId?: string;
  providerId?: string;
  baseUrl?: string;
  createdAt: string;
  lastProviderRequestAt?: string;
  lastDynamicContextHash?: string;
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
  /** Internal apply precondition. Never expose this value to the Webview. */
  expectedOriginalTextHash?: string;
  /** Internal apply precondition. Never expose this value to the Webview. */
  expectedOriginalSize?: number;
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
  /** Exact external target explicitly authorized when this checkpoint was applied. */
  authorizedExternalUri?: string;
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

export type RunDetailsStatus = 'running' | 'succeeded' | 'waiting' | 'blocked' | 'failed' | 'stopped';

export interface RunDetailsTaskPlanSummary {
  status: TaskPlanStatus;
  goal: string;
  updateCount: number;
  completedSteps: number;
  totalSteps: number;
  blockers: string[];
}

export interface RunDetailsModelRequestSummary {
  requestCount: number;
  messageCount: number;
  exposedToolCount: number;
  maxOutputTokens?: number;
  thinkingEnabled: boolean;
}

export interface RunDetailsToolCallSummary {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: 'running' | 'succeeded' | 'failed' | 'denied';
  argumentsSummary?: string;
  resultSummary?: string;
  riskLevel?: ToolRiskLevel;
  scope?: AuthorizedToolScope;
  truncated?: boolean;
}

export interface RunDetailsAuthorizationRecord {
  toolName: string;
  allowed: boolean;
  riskLevel: ToolRiskLevel;
  scope: AuthorizedToolScope;
  source: ToolAuthorizationDecision['source'];
  reason?: string;
}

export interface RunDetailsChangeSetSummary {
  id: string;
  fileCount: number;
  status: ChangeSetStatus;
  operationSummary?: string;
  labels: string[];
  files?: RunDetailsChangeSetFileSummary[];
  appliedCount: number;
  failedCount: number;
}

export interface RunDetailsChangeSetFileSummary {
  id: string;
  label: string;
  action: DraftEditAction;
  status: ChangeSetFileStatus;
  error?: string;
}

export interface RunDetailsValidationSummary {
  script?: SafeNpmScript;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  errors?: number;
  warnings?: number;
  error?: string;
}

export type RunDetailsContextSourceSummary = RunContextSourceSummary;

export interface RunDetailsSummary {
  runId: string;
  sessionId?: string;
  assistantMessageId?: string;
  backgroundRunId?: string;
  modelId: string;
  sourceId?: string;
  provider?: string;
  protocol?: string;
  status: RunDetailsStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  taskPlan?: RunDetailsTaskPlanSummary;
  modelRequests: RunDetailsModelRequestSummary;
  toolCallCount: number;
  toolCalls: RunDetailsToolCallSummary[];
  authorizations: RunDetailsAuthorizationRecord[];
  changeSets: RunDetailsChangeSetSummary[];
  validations: RunDetailsValidationSummary[];
  contextSources: RunDetailsContextSourceSummary[];
  contextDiscarded: RunContextDiscardedSource[];
  contextDeduplication?: {
    before: number;
    after: number;
    discarded: number;
    truncated: boolean;
  };
  cache?: RunDetailsCacheSummary;
  historySummaries?: RunDetailsHistorySummaryProvenance[];
  budgetStopReason?: string;
  failureReason?: string;
  traceLogUri?: string;
  truncated: boolean;
}

export interface RunDetailsCacheSummary {
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  hitRate?: number;
  providerDataStatus: UsageCacheDataStatus;
  cacheLaneChanged: boolean;
  cacheMissPossibleReasons: string[];
}

export interface RunDetailsHistorySummaryProvenance {
  modelId?: string;
  sourceId?: string;
  provider?: string;
  createdAt: string;
}

export type ValidationAuthorizationPolicy = 'never' | 'ask' | 'always';

export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type AuthorizedToolScope =
  | 'workspace_read'
  | 'diagnostics_read'
  | 'semantic_read'
  | 'validation_compile_lint'
  | 'validation_test'
  | 'draft_edit_prepare'
  | 'draft_run_prepare'
  | 'draft_run_execute'
  | 'workspace_write'
  | 'git_read'
  | 'git_patch_create'
  | 'subagent_delegate'
  | 'git_commit'
  | 'git_push';

export interface RunAuthorizationPolicy {
  approvalMode?: ApprovalMode;
  runId: string;
  mediumRiskPolicy: ValidationAuthorizationPolicy;
  authorizedScopes: AuthorizedToolScope[];
  deniedScopes: AuthorizedToolScope[];
}

export interface ToolAuthorizationDecision {
  allowed: boolean;
  toolName: string;
  riskLevel: ToolRiskLevel;
  scope: AuthorizedToolScope;
  source: 'low_risk' | 'run_policy' | 'configuration' | 'explicit_confirmation' | 'delegated_approver' | 'user_denied';
  requiresExplicitConfirmation: boolean;
  reason?: string;
}

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
  errorType?: string;
  kind: 'npm_script';
  script: SafeNpmScript;
  workspaceFolder?: string;
  taskName?: string;
  authorized: boolean;
  exitCode?: number;
  durationMs: number;
  timedOut: boolean;
  authorization?: ToolAuthorizationDecision;
  diagnostics?: WorkspaceDiagnosticSummary;
  error?: string;
}

export type RepairLoopStatus =
  | 'idle'
  | 'validation_failed'
  | 'reading_problems'
  | 'generating_repair'
  | 'waiting_for_apply'
  | 'ready_for_validation'
  | 'running_validation'
  | 'completed'
  | 'blocked';

export interface RepairLoopState {
  status: RepairLoopStatus;
  iteration: number;
  maxIterations: number;
  lastValidationScript?: SafeNpmScript;
  lastFailureSummary?: string;
  pendingDraftEditIds: string[];
  stopReason?: 'waiting_for_apply' | 'repair_iteration_limit' | 'validation_passed' | 'authorization_denied' | 'repair_discarded';
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
  approvalMode?: ApprovalMode;
  checkpoint?: import('../agent/runCheckpoint').RunCheckpoint;
  taskClock?: import('../agent/executionPolicy').ExecutionClock;
  prompt: string;
  model: KeepseekModel;
  settings: AgentSettings;
  contextFiles: ContextFile[];
  currentRunContext?: CurrentRunContext;
  /** 持久化的稳定上下文块；跨轮字节不变时由调用方原样复用 */
  contextInstructions?: string;
  /**
   * 会话冻结的 slim 工具集（工具名列表）：首轮请求确定后跨轮复用，
   * 避免工具 schema 随每轮 prompt 变化导致 tools 段前缀失效。
   * 未提供时按 prompt 现算。
   */
  slimToolNames?: string[];
  requestProtocolVersion?: number;
  historyArchive?: HistoryArchiveEntry[];
  history: ChatMessage[];
  contextCompression?: ContextCompressionState;
  historyRewriteReason?: string;
  /** 用户显式引用（input 组件/右键/拖拽）已授权的外部文件/目录 URI（uri.toString()）。只读工具对这些路径放行，不弹确认。 */
  authorizedExternalReferenceUris?: string[];
  language: KeepseekLanguage;
  sessionId?: string;
  assistantMessageId?: string;
  repairLoop?: RepairLoopState;
  executionLimits?: AgentExecutionLimits;
  backgroundRunId?: string;
  /** Credentials frozen once at run start so summaries and the main request cannot diverge. */
  sourceConfig?: ModelSourceConfigSnapshot;
  /** Undefined preserves the byte-stable main-agent system prompt. */
  persona?: {
    kind: 'subagent';
    systemPrompt: string;
  };
  /** Runtime-only child lineage. It is stored by the subagent store, not in the
   * parent chat transcript or provider-visible parent context. */
  subagentContext?: {
    id: string;
    treeId: string;
    parentSessionId: string;
    parentRunId: string;
    rootRunId: string;
    depth: number;
    profile: string;
    lane: 'research-read' | 'review-read' | 'proposal' | 'nested-read';
  };
  signal?: AbortSignal;
}

export interface AgentExecutionLimits {
  maxValidationRuns?: number;
  maxToolIterations?: number;
  maxToolCalls?: number;
  maxRunMs?: number;
  timeLimitSource?: string;
  maxRepairIterations?: number;
}

export interface ActivatedSkill {
  id: string;
  name: string;
  source: SkillSource;
  rootUri: string;
  skillUri: string;
  content: string;
  loadedResourceUris?: string[];
  activation?: SkillActivationInfo;
  description?: string;
  hasScripts?: boolean;
  /** Full instructions for these skills are omitted from the parent context and
   * loaded only in an isolated child run. */
  runAs?: 'subagent';
  subagentProfile?: {
    id: string;
    tools?: string[];
    maxSteps?: number;
    timeoutMs?: number;
    canDelegate?: boolean;
    resultMaxChars?: number;
  };
}

export interface AgentResponse {
  runId: string;
  message: string;
  reasoningContent?: string;
  draftEdits: DraftEdit[];
  draftRuns?: DraftRunProposal[];
  taskPlan: TaskPlan;
  repairLoop: RepairLoopState;
  changeSet?: ChangeSet;
  usage?: TurnUsageStats;
  promptCacheDiagnostics?: PromptCacheDiagnostics;
  /** 本 run 内工具轮的原样字节快照，调用方持久化到 assistant 消息后跨轮还原 */
  toolRounds?: AgentToolRound[];
  providerReplay?: ProviderReplayState;
  traceLog?: AgentTraceLogInfo;
  runDetails: RunDetailsSummary;
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
  | 'creating_draft_run'
  | 'running_draft_run'
  | 'reading_diagnostics'
  | 'reading_semantic_context'
  | 'reading_git_state'
  | 'awaiting_authorization'
  | 'generating_repair'
  | 'waiting_for_apply'
  | 'running_validation'
  | 'reviewing_tool_result'
  | 'generating'
  | 'delegating'
  | 'waiting_for_subagent'
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
  beforeModelRequest?: () => Promise<void>;
  beforeRetry?: () => Promise<void>;
  onCheckpoint?: (checkpoint: import('../agent/runCheckpoint').RunCheckpoint) => Promise<void>;
  onActivity?: (kind: 'network' | 'event' | 'content' | 'request' | 'retry') => void;
  onDelta?: (event: AgentProgressEvent) => void;
  onStatus?: (status: AgentActivityInput) => void;
  onUsageEstimate?: (usage: ContextUsageEstimate) => void;
  onUsage?: (event: UsageEvent) => void;
  onSubagentRunSummary?: (summary: SubagentRunUsageSummary) => void;
  onSubagentHandoffEstimate?: (estimate: SubagentHandoffEstimate) => void;
  onPromptCacheDiagnostics?: (diagnostics: PromptCacheDiagnostics) => void;
  onTraceLog?: (traceLog: AgentTraceLogInfo) => void;
  onTaskPlan?: (taskPlan: TaskPlan) => void;
  onRunDetails?: (runDetails: RunDetailsSummary) => void;
}

export type BackgroundRunStatus =
  | 'running'
  | 'waiting_for_apply'
  | 'waiting_for_authorization'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface BackgroundRunGoal {
  kind: 'repair_until_validation_passes';
  script: SafeNpmScript;
  description: string;
}

export interface BackgroundRunLimits {
  maxRounds: number;
  maxDurationMs: number;
  maxToolCalls: number;
}

export interface BackgroundRunProgress {
  usedMs?: number;
  round: number;
  toolCalls: number;
  runIds: string[];
  lastRunId?: string;
}

export interface BackgroundRun {
  id: string;
  sessionId: string;
  workspaceKey: string;
  status: BackgroundRunStatus;
  goal: BackgroundRunGoal;
  limits: BackgroundRunLimits;
  progress: BackgroundRunProgress;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  waitingReason?: string;
  stopReason?: string;
}
