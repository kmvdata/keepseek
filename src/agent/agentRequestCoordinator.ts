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
import { capOversizedFirstUserProviderContent, maintainArchivedToolResults } from './historyArchive';
import { getConfiguredPromptCacheTtlMs } from '../shared/config';
import { getDeepSeekV4ContextCompressionSettings } from '../shared/modelProfiles';

export interface AgentRequestCoordinatorInput {
  prompt: string;
  model: KeepseekModel;
  settings: AgentSettings;
  contextFiles: ContextFile[];
  currentRunContext?: AgentRequest['currentRunContext'];
  contextInstructions?: AgentRequest['contextInstructions'];
  slimToolNames?: AgentRequest['slimToolNames'];
  requestProtocolVersion?: AgentRequest['requestProtocolVersion'];
  historyArchive?: AgentRequest['historyArchive'];
  history: AgentRequest['history'];
  contextCompression: AgentRequest['contextCompression'];
  historyRewriteReason?: string;
  /** 用户显式引用（input 组件/右键/拖拽）已授权的外部文件/目录 URI（uri.toString()）。只读工具对这些路径放行，不弹确认。 */
  authorizedExternalReferenceUris?: AgentRequest['authorizedExternalReferenceUris'];
  language: KeepseekLanguage;
  sessionId?: string;
  assistantMessageId?: string;
  repairLoop?: AgentRequest['repairLoop'];
  executionLimits?: AgentRequest['executionLimits'];
  backgroundRunId?: string;
  sourceConfig?: AgentRequest['sourceConfig'];
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
      currentRunContext: input.currentRunContext
        ? {
            projectInstructions: input.currentRunContext.projectInstructions.map((instruction) => ({ ...instruction })),
            skills: input.currentRunContext.skills.map((skill) => ({
              ...skill,
              activation: skill.activation ? { ...skill.activation } : undefined,
              loadedResourceUris: skill.loadedResourceUris ? [...skill.loadedResourceUris] : undefined
            })),
            legacyMemory: input.currentRunContext.legacyMemory
              ? {
                  ...input.currentRunContext.legacyMemory,
                  entryIds: [...input.currentRunContext.legacyMemory.entryIds],
                  sourceUris: [...input.currentRunContext.legacyMemory.sourceUris]
                }
              : undefined,
            metadata: {
              ...input.currentRunContext.metadata,
              precedence: [...input.currentRunContext.metadata.precedence],
              sources: input.currentRunContext.metadata.sources.map((source) => ({ ...source })),
              discarded: input.currentRunContext.metadata.discarded.map((source) => ({ ...source })),
              possibleConflicts: input.currentRunContext.metadata.possibleConflicts.map((conflict) => ({ ...conflict }))
            }
          }
        : undefined,
      contextInstructions: input.contextInstructions,
      slimToolNames: input.slimToolNames,
      requestProtocolVersion: input.requestProtocolVersion,
      historyArchive: input.historyArchive?.map((entry) => ({ ...entry })),
      history: input.history.map(cloneChatMessage),
      contextCompression: cloneContextCompressionState(input.contextCompression),
      historyRewriteReason: input.historyRewriteReason,
      authorizedExternalReferenceUris: input.authorizedExternalReferenceUris
        ? [...input.authorizedExternalReferenceUris]
        : undefined,
      language: input.language,
      sessionId: input.sessionId,
      assistantMessageId: input.assistantMessageId,
      repairLoop: input.repairLoop
        ? { ...input.repairLoop, pendingDraftEditIds: [...input.repairLoop.pendingDraftEditIds] }
        : undefined,
      executionLimits: input.executionLimits ? { ...input.executionLimits } : undefined,
      backgroundRunId: input.backgroundRunId,
      sourceConfig: input.sourceConfig ? { ...input.sourceConfig } : undefined,
      signal: input.signal
    };
  }

  public async refreshContextCompressionBeforeRun(
    input: HistoryCompressionRefreshInput
  ): Promise<HistoryCompressionRefreshResult | undefined> {
    let plan = this.historyCompressor.planRefresh(input);
    if (plan.mode !== 'sync') {
      return plan.changed
        ? {
            state: plan.state,
            changed: true,
            reason: 'skipped'
          }
        : undefined;
    }

    const keepRecentTurns = (input.settings
      ?? getDeepSeekV4ContextCompressionSettings(input.model, input.agentSettings)).keepRecentTurns;
    capOversizedFirstUserProviderContent(input.session);
    const snipResult = maintainArchivedToolResults(input.session, 'snip', keepRecentTurns);
    if (snipResult.changed) {
      plan = this.historyCompressor.planRefresh(input);
      if (plan.mode !== 'sync') {
        return {
          state: plan.state,
          changed: true,
          reason: 'skipped'
        };
      }
    }
    const pruneResult = maintainArchivedToolResults(input.session, 'prune', keepRecentTurns);
    if (pruneResult.changed) {
      plan = this.historyCompressor.planRefresh(input);
      if (plan.mode !== 'sync') {
        return {
          state: plan.state,
          changed: true,
          reason: 'skipped'
        };
      }
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
    if (plan.mode === 'background' && !isPromptCacheCold(input.session)) {
      // A background summary would rewrite a still-hot prefix and add a paid model
      // call. Defer it until the provider cache is cold or sync compaction becomes
      // unavoidable.
      return;
    }

    const expectation = createBackgroundRefreshExpectation(input.session);
    const refreshPromise = this.historyCompressor.refresh({
      ...input,
      signal: undefined,
      usageSource: 'background'
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

function isPromptCacheCold(session: ChatSession): boolean {
  const lastRequestAt = Date.parse(session.requestProtocol?.lastProviderRequestAt ?? session.updatedAt);
  return Number.isFinite(lastRequestAt) && Date.now() - lastRequestAt >= getConfiguredPromptCacheTtlMs();
}

function cloneChatMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    contextMeta: message.contextMeta ? { ...message.contextMeta } : undefined,
    usedSkills: message.usedSkills?.map((skill) => ({ ...skill })),
    toolRounds: message.toolRounds?.map((round) => ({
      ...round,
      toolCalls: round.toolCalls.map((call) => ({ ...call, function: { ...call.function } })),
      toolResults: round.toolResults.map((result) => ({ ...result }))
    })),
    providerReplay: message.providerReplay ? structuredClone(message.providerReplay) : undefined
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
