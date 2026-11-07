import type { KeepseekLanguage } from '../shared/i18n';
import type { AgentSettings, ApprovalMode, ExecutionMode, SafeNpmScript, DraftRunBatchSnapshot } from '../shared/types';
import type { ModelSourceProvider } from '../accounts/types';

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

/** Every task action carries its emission-time target, never the later selected view. */
export interface TaskMessageTarget {
  projectId?: string;
  taskCardId?: string | null;
  sessionId?: string;
  rootTaskId?: string;
  viewGeneration?: number;
}

export interface ProjectTaskPromptInput {
  projectId: string;
  requestId: string;
  targetId: string;
  prompt: string;
  sourceId: string;
  modelId: string;
  draftRevision: number;
  settings?: Partial<AgentSettings>;
  references?: PromptReferenceInput[];
  skillIds?: string[];
}

export interface ProjectTaskDraftInput {
  projectId: string;
  targetId: string;
  revision: number;
  markup: string;
  skillIds?: string[];
  cursor?: { start: number; end: number } | null;
  scrollTop?: number;
  scrollAnchor?: { messageId: string; offset: number } | null;
  expanded?: boolean;
}

export type WebviewMessage = WebviewMessagePayload & TaskMessageTarget;

type WebviewMessagePayload =
  | ({ type: 'projectTaskCreate' | 'projectAssistantSubmit' } & ProjectTaskPromptInput)
  | ({ type: 'projectTaskSubmit'; taskCardId: string; inputKind?: 'supplement' | 'followup' } & ProjectTaskPromptInput)
  | { type: 'projectTaskView'; projectId: string; taskCardId: string | null; mode?: 'project' | 'new' | 'task'; viewGeneration: number }
  | { type: 'projectTaskLatest'; projectId: string; taskCardId: string | null; viewGeneration?: number }
  | { type: 'projectTaskReconcile'; projectId: string; targetId: string; requestId: string }
  | { type: 'projectTaskPrefetch'; projectId: string; taskCardId: string }
  | { type: 'projectTaskStop' | 'projectTaskResume' | 'projectTaskArchive' | 'projectTaskDelete'; projectId: string; taskCardId: string; archived?: boolean }
  | { type: 'projectTaskStopAll'; projectId: string }
  | { type: 'projectTaskAssociate'; projectId: string; sessionId: string }
  | ({ type: 'projectTaskDraft' } & ProjectTaskDraftInput)
  | { type: 'projectTaskPainted'; projectId: string; taskCardId: string | null; targetId?: string; viewGeneration: number; revision: number; paintedAt: number }

  | { type: 'resumeApprovalProcessing'; authorizeTargetId?: string; confirmTargetId?: string }
  | { type: 'resolveValidationApproval'; id: string; approve: boolean }
  | { type: 'setApprovalMode'; mode: ApprovalMode }
  | { type: 'setExecutionMode'; mode: ExecutionMode }
  | { type: 'resolvePlanDecision'; planId: string; action: 'start_execution' | 'revise_plan' | 'exit_plan' }
  | { type: 'ready' }
  | { type: 'retryInteraction' }
  | { type: 'startupRendered'; revision?: number }
  | { type: 'loadOlderMessages' }
  | { type: 'refreshBalance' }
  | { type: 'sendPrompt'; requestId?: string; sessionId?: string; stateRevision?: number; prompt: string; sourceId: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[]; skillIds?: string[] }
  | { type: 'editUserPrompt'; requestId?: string; sessionId?: string; stateRevision?: number; messageId: string; prompt: string; sourceId: string; modelId: string; settings?: Partial<AgentSettings>; references?: PromptReferenceInput[]; skillIds?: string[] }
  | { type: 'abortPrompt'; operationId?: string; sessionId?: string }
  | { type: 'continueAgentTask'; messageId: string }
  | { type: 'continueRepair' }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'toggleSessionFavorite'; sessionId: string }
  | { type: 'renameSession'; sessionId: string; title: string }
  | { type: 'regenerateSessionTitle'; sessionId: string; requestId: string }
  | { type: 'deleteSessions'; sessionIds: string[] }
  | { type: 'listOtherWorkspaces' }
  | { type: 'loadOtherWorkspaceSessions'; workspaceKey: string }
  | { type: 'copyOtherWorkspaceSession'; workspaceKey: string; sessionId: string }
  | { type: 'deleteOtherWorkspaceSessions'; workspaceKey: string; sessionIds: string[] }
  | { type: 'deleteOtherWorkspace'; workspaceKey: string }
  | { type: 'setSelectedModel'; requestId: string; sourceId: string; modelId: string }
  | { type: 'configureApprovalModel' }
  | { type: 'setApprovalModel'; mode: 'follow-main' | 'fixed'; sourceId?: string; modelId?: string }
  | { type: 'setSubagentModel'; mode: 'follow-main' | 'fixed'; profile?: 'research' | 'review' | 'proposal'; sourceId?: string; modelId?: string }
  | { type: 'cancelPendingModelSelection'; requestId: string }
  | { type: 'setAgentSettings'; settings: Partial<AgentSettings> }
  | { type: 'setDebugMode'; enabled: boolean }
  | { type: 'openCurrentSessionLog' }
  | { type: 'openRunTrace'; messageId: string }
  | { type: 'openSubagentDiagnostic'; subagentId: string; diagnosticId: string }
  | { type: 'startBackgroundRun'; script: SafeNpmScript; maxRounds: number }
  | { type: 'resumeBackgroundRun' }
  | { type: 'stopBackgroundRun' }
  | { type: 'openApiSettings' }
  | { type: 'openHistorySettings' }
  | { type: 'setModelRequestTimeout'; seconds: number }
  | {
      type: 'addModel';
      sourceId?: string;
      provider: ModelSourceProvider;
      name?: string;
      apiKey: string;
      baseUrl: string;
      modelId?: string;
      contextWindowTokens?: number;
      maxOutputTokens?: number;
    }
  | { type: 'deleteModel'; sourceId: string; modelId: string }
  | { type: 'setModelEnabled'; sourceId: string; modelId: string; enabled: boolean }
  | { type: 'setDefaultModel'; sourceId: string; modelId: string }
  | { type: 'setModelContextWindow'; sourceId: string; modelId: string; contextWindowTokens: number }
  | { type: 'setModelMaxOutput'; sourceId: string; modelId: string; maxOutputTokens: number }
  | { type: 'saveModelSource'; sourceId: string; name?: string; apiKey: string; baseUrl: string }
  | { type: 'deleteModelSource'; sourceId: string }
  | { type: 'refreshSourceModels'; sourceId: string }
  | { type: 'testSourceConnection'; provider: ModelSourceProvider; apiKey: string; baseUrl: string }
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
  | { type: 'selectProjectScope' }
  | { type: 'useSkill'; skillId: string }
  | { type: 'removeActiveSkill'; skillId: string }
  | { type: 'openSkill'; skillId: string }
  | { type: 'setSkillWorkspaceDefault'; skillId: string; enabled: boolean }
  | { type: 'createSkillDraft'; name: string; description: string; allowImplicit: boolean }
  | { type: 'requestClipboardText'; requestId: string }
  | { type: 'writeClipboardText'; text: string }
  | { type: 'readPath'; path: string }
  | { type: 'openFileReference'; path: string; startLine: number; endLine: number; startColumn: number; endColumn: number }
  | { type: 'openDirectoryReference'; path: string }
  | { type: 'removeContextFile'; uri: string }
  | { type: 'clearContext' }
  | { type: 'applyDraftEdit'; id: string; requestId: string }
  | { type: 'discardDraftEdit'; id: string; requestId: string }
  | { type: 'openDraftDiff'; id: string }
  | { type: 'openDraftEditFile'; id: string }
  | { type: 'applyChangeSet'; id: string; requestId: string }
  | { type: 'discardChangeSet'; id: string; requestId: string }
  | { type: 'revertDraftEdit'; id: string; requestId: string }
  | { type: 'revertChangeSet'; id: string; requestId: string }
  | { type: 'applyAllDraftEdits'; requestId?: string }
  | { type: 'discardAllDraftEdits'; requestId?: string }
  | { type: 'approveDraftRun'; id: string; specHash: string; autoContinue?: boolean }
  | { type: 'approveDraftRunBatch'; snapshot: DraftRunBatchSnapshot }
  | { type: 'cancelDraftRunBatch'; operationId: string }
  | { type: 'rejectDraftRun'; id: string }
  | { type: 'cancelDraftRun'; id: string }
  | { type: 'cloneDraftRun'; id: string }
  | { type: 'authorizeDraftRunCwd'; id: string }
  | { type: 'openDraftRunTerminal'; id: string };
