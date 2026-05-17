export interface KeepseekModel {
  id: string;
  label: string;
  provider: string;
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
  contextFiles: ContextFile[];
  history: ChatMessage[];
}

export interface AgentResponse {
  message: string;
  draftEdits: DraftEdit[];
}
