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
  compressionEnabled: boolean;
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
  language: KeepseekLanguage;
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
  message: string;
  reasoningContent?: string;
  draftEdits: DraftEdit[];
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
  onTraceLog?: (traceLog: AgentTraceLogInfo) => void;
}
