import type { KeepseekLanguage } from '../shared/i18n';
import type {
  AgentRequest,
  AgentSettings,
  ChatMessage,
  ChatSession,
  ContextCompressionState,
  ContextFile,
  KeepseekModel
} from '../shared/types';
import {
  HistoryCompressor,
  type HistoryCompressionRefreshInput,
  type HistoryCompressionRefreshResult
} from './historyCompressor';

export interface AgentRequestCoordinatorInput {
  prompt: string;
  model: KeepseekModel;
  settings: AgentSettings;
  contextFiles: ContextFile[];
  skills?: AgentRequest['skills'];
  history: AgentRequest['history'];
  contextCompression: AgentRequest['contextCompression'];
  historyRewriteReason?: string;
  language: KeepseekLanguage;
  sessionId?: string;
  assistantMessageId?: string;
  repairLoop?: AgentRequest['repairLoop'];
  projectMemory?: AgentRequest['projectMemory'];
  executionLimits?: AgentRequest['executionLimits'];
  backgroundRunId?: string;
  signal?: AbortSignal;
}

export interface BackgroundContextCompressionRefreshUpdate {
  sessionId: string;
  expectedMessageCount: number;
  expectedLastMessageId?: string;
  result: HistoryCompressionRefreshResult;
}

export type BackgroundContextCompressionRefreshUpdateHandler = (
  update: BackgroundContextCompressionRefreshUpdate
) => void | Promise<void>;

export class AgentRequestCoordinator {
  private readonly backgroundRefreshes = new Map<string, Promise<void>>();

  public constructor(private readonly historyCompressor = new HistoryCompressor()) {}

  public createAgentRequest(input: AgentRequestCoordinatorInput): AgentRequest {
    return {
      prompt: input.prompt,
      model: { ...input.model },
      settings: { ...input.settings },
      contextFiles: input.contextFiles.map((file) => ({ ...file })),
      skills: input.skills?.map((skill) => ({
        ...skill,
        loadedResourceUris: skill.loadedResourceUris ? [...skill.loadedResourceUris] : undefined
      })),
      history: input.history.map(cloneChatMessage),
      contextCompression: cloneContextCompressionState(input.contextCompression),
      historyRewriteReason: input.historyRewriteReason,
      language: input.language,
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      repairLoop: input.repairLoop
        ? { ...input.repairLoop, pendingDraftEditIds: [...input.repairLoop.pendingDraftEditIds] }
        : undefined,
      projectMemory: input.projectMemory
        ? { ...input.projectMemory, entryIds: [...input.projectMemory.entryIds] }
        : undefined,
      executionLimits: input.executionLimits ? { ...input.executionLimits } : undefined,
      backgroundRunId: input.backgroundRunId,
      signal: input.signal
    };
  }

  public async refreshContextCompressionBeforeRun(
    input: HistoryCompressionRefreshInput
  ): Promise<HistoryCompressionRefreshResult | undefined> {
    const plan = this.historyCompressor.planRefresh(input);
    if (plan.mode !== 'sync') {
      return plan.changed
        ? {
            state: plan.state,
            changed: true,
            reason: 'skipped'
          }
        : undefined;
    }

    const backgroundRefresh = this.backgroundRefreshes.get(input.session.id);
    if (!backgroundRefresh) {
      return await this.historyCompressor.refresh(input);
    }

    await backgroundRefresh;
    const nextPlan = this.historyCompressor.planRefresh(input);
    if (nextPlan.mode !== 'sync') {
      return nextPlan.changed
        ? {
            state: nextPlan.state,
            changed: true,
            reason: 'skipped'
          }
        : undefined;
    }

    return await this.historyCompressor.refresh(input);
  }

  public scheduleBackgroundContextCompressionRefresh(
    input: HistoryCompressionRefreshInput,
    onUpdate: BackgroundContextCompressionRefreshUpdateHandler
  ): void {
    const sessionId = input.session.id;
    const plan = this.historyCompressor.planRefresh(input);
    if (plan.changed) {
      notifyBackgroundRefreshUpdate(onUpdate, {
        ...createBackgroundRefreshExpectation(input.session),
        sessionId,
        result: {
          state: plan.state,
          changed: true,
          reason: 'skipped'
        }
      });
    }

    if (plan.mode === 'none' || this.backgroundRefreshes.has(sessionId)) {
      return;
    }

    const expectation = createBackgroundRefreshExpectation(input.session);
    const refreshPromise = this.historyCompressor.refresh({
      ...input,
      signal: undefined
    })
      .then(async (result) => {
        if (!result.changed) {
          return;
        }
        await onUpdate({
          ...expectation,
          sessionId,
          result
        });
      })
      .catch(() => {
        // Context compression is best-effort; background failures are kept off the UI path.
      })
      .finally(() => {
        if (this.backgroundRefreshes.get(sessionId) === refreshPromise) {
          this.backgroundRefreshes.delete(sessionId);
        }
      });

    this.backgroundRefreshes.set(sessionId, refreshPromise);
  }
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    contextMeta: message.contextMeta ? { ...message.contextMeta } : undefined,
    usedSkills: message.usedSkills?.map((skill) => ({ ...skill }))
  };
}

function cloneContextCompressionState(
  state: ContextCompressionState | undefined
): ContextCompressionState | undefined {
  return state
    ? {
        ...state,
        protectedMessageIds: [...state.protectedMessageIds],
        summaries: state.summaries.map((summary) => ({
          ...summary,
          coveredMessageIds: [...summary.coveredMessageIds]
        }))
      }
    : undefined;
}

function notifyBackgroundRefreshUpdate(
  onUpdate: BackgroundContextCompressionRefreshUpdateHandler,
  update: BackgroundContextCompressionRefreshUpdate
): void {
  try {
    void Promise.resolve(onUpdate(update)).catch(() => undefined);
  } catch {
    // Context compression updates are best-effort and must not disrupt the chat path.
  }
}

function createBackgroundRefreshExpectation(session: ChatSession): {
  expectedMessageCount: number;
  expectedLastMessageId?: string;
} {
  return {
    expectedMessageCount: session.messages.length,
    expectedLastMessageId: session.messages[session.messages.length - 1]?.id
  };
}
