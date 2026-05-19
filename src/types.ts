export interface KeepseekModel {
  id: string;
  label: string;
  provider: string;
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

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  modelId?: string;
  reasoningContent?: string;
}

export interface DraftEdit {
  id: string;
  uri: string;
  label: string;
  newText: string;
  reason: string;
}

export interface AgentRequest {
  prompt: string;
  model: KeepseekModel;
  settings: AgentSettings;
  contextFiles: ContextFile[];
  history: ChatMessage[];
}

export interface AgentResponse {
  message: string;
  reasoningContent?: string;
  draftEdits: DraftEdit[];
}
