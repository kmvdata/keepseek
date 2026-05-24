import type { KeepseekLanguage } from './i18n';

export interface KeepseekModel {
  id: string;
  label: string;
  provider: string;
  contextWindowTokens?: number;
}

export type ReasoningEffort = 'high' | 'max';

export interface AgentSettings {
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
}

export type ContextFileSource = 'workspace' | 'external';

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
  };
}

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  expandedContent?: string;
  createdAt: string;
  modelId?: string;
  reasoningContent?: string;
  isStreaming?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface DraftEdit {
  id: string;
  uri: string;
  label: string;
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
  history: ChatMessage[];
  language: KeepseekLanguage;
}

export interface AgentResponse {
  message: string;
  reasoningContent?: string;
  draftEdits: DraftEdit[];
}

export type AgentProgressEvent =
  | { type: 'content'; delta: string }
  | { type: 'reasoning'; delta: string };

export interface AgentRunCallbacks {
  onDelta?: (event: AgentProgressEvent) => void;
}
