import type { KeepseekLanguage } from '../shared/i18n';
import type { AgentSettings } from '../shared/types';

export interface PromptReferenceInput {
  path: string;
  kind?: 'file' | 'directory';
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
}

export interface DroppedFileReferenceInput {
  name: string;
  type?: string;
  size?: number;
  lastModified?: number;
  dataBase64: string;
}

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'sendPrompt'; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[]; skillIds?: string[] }
  | { type: 'editUserPrompt'; messageId: string; prompt: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[]; skillIds?: string[] }
  | { type: 'abortPrompt' }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'toggleSessionFavorite'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'deleteSessions'; sessionIds: string[] }
  | { type: 'listOtherWorkspaces' }
  | { type: 'loadOtherWorkspaceSessions'; workspaceKey: string }
  | { type: 'copyOtherWorkspaceSession'; workspaceKey: string; sessionId: string }
  | { type: 'deleteOtherWorkspaceSessions'; workspaceKey: string; sessionIds: string[] }
  | { type: 'deleteOtherWorkspace'; workspaceKey: string }
  | { type: 'setSelectedModel'; modelId: string }
  | { type: 'setAgentSettings'; settings: Partial<AgentSettings> }
  | { type: 'setDebugMode'; enabled: boolean }
  | { type: 'openCurrentSessionLog' }
  | { type: 'openApiSettings' }
  | { type: 'openHistorySettings' }
  | {
      type: 'saveApiSettings';
      apiKey: string;
      baseUrl: string;
    }
  | {
      type: 'saveHistorySettings';
      historyRetentionDays?: number;
    }
  | { type: 'setLanguage'; language: KeepseekLanguage }
  | { type: 'addCurrentFile' }
  | { type: 'pickWorkspaceFiles' }
  | { type: 'pickExternalFiles' }
  | { type: 'pickExternalFileReferences' }
  | { type: 'insertDroppedFileReferences'; files: DroppedFileReferenceInput[] }
  | { type: 'requestReferenceResources'; requestId: string }
  | { type: 'requestSkills' }
  | { type: 'useSkill'; skillId: string }
  | { type: 'removeActiveSkill'; skillId: string }
  | { type: 'openSkill'; skillId: string }
  | { type: 'setSkillEnabled'; skillId: string; enabled: boolean }
  | { type: 'setSkillAllowImplicit'; skillId: string; allowImplicit: boolean }
  | { type: 'createSkillDraft'; name: string; description: string; allowImplicit: boolean; userInvocable: boolean }
  | { type: 'requestClipboardText'; requestId: string }
  | { type: 'writeClipboardText'; text: string }
  | { type: 'readPath'; path: string }
  | { type: 'openFileReference'; path: string; startLine: number; endLine: number; startColumn: number; endColumn: number }
  | { type: 'openDirectoryReference'; path: string }
  | { type: 'removeContextFile'; uri: string }
  | { type: 'clearContext' }
  | { type: 'applyDraftEdit'; id: string }
  | { type: 'discardDraftEdit'; id: string }
  | { type: 'openDraftDiff'; id: string }
  | { type: 'applyChangeSet'; id: string }
  | { type: 'discardChangeSet'; id: string }
  | { type: 'revertDraftEdit'; id: string }
  | { type: 'revertChangeSet'; id: string }
  | { type: 'applyAllDraftEdits' }
  | { type: 'discardAllDraftEdits' };
