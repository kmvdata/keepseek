import { randomUUID } from 'node:crypto';
import type { KeepseekLanguage } from '../../shared/i18n';
import { getConfiguredModelUsagePricing } from '../../shared/config';
import type { AgentRunCallbacks, ReasoningEffort } from '../../shared/types';
import { getErrorMessage } from '../../shared/errors';
import { DeepSeekClient, type DeepSeekClientConfig } from '../deepseek/client';
import type {
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekToolCall
} from '../deepseek/types';
import {
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  getAgentTools
} from '../protocol';
import { calculateUsageCost, createUsageEvent, normalizeDeepSeekUsage } from '../usageStats';
import type { WorkspaceToolAdapter } from '../tools/workspaceTools';
import type { ValidationToolAdapter } from '../tools/validationTools';
import type { SemanticToolAdapter } from '../tools/semanticTools';
import type { GitToolAdapter } from '../tools/gitTools';

export const READONLY_AGENT_TOOL_NAMES = Object.freeze([
  LIST_WORKSPACE_FILES_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  FIND_REFERENCES_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME
]);

const READONLY_AGENT_TOOLS = getAgentTools({ toolNames: READONLY_AGENT_TOOL_NAMES });

export interface ReadonlySubagentRunInput {
  modelId: string;
  messages: DeepSeekMessage[];
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxToolRounds: number;
  maxTokens: number;
  maxDurationMs: number;
  clientConfig: DeepSeekClientConfig;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: Pick<AgentRunCallbacks, 'onUsage'>;
}

export interface ReadonlySubagentRunResult {
  content: string;
  reasoningContent?: string;
  researchSteps: number;
  truncated: boolean;
  finishReason?: string | null;
}

export interface ReadonlyCompletionClient {
  createChatCompletion: DeepSeekClient['createChatCompletion'];
}

export class SubagentRunner {
  public constructor(
    private readonly workspaceTools: WorkspaceToolAdapter,
    private readonly validationTools: Pick<ValidationToolAdapter, 'readWorkspaceDiagnostics'>,
    private readonly semanticTools: SemanticToolAdapter,
    private readonly gitTools: GitToolAdapter,
    private readonly client: ReadonlyCompletionClient = new DeepSeekClient()
  ) {}

  public async run(input: ReadonlySubagentRunInput): Promise<ReadonlySubagentRunResult> {
    const messages = input.messages.map((message) => ({ ...message }));
    const maxToolRounds = Math.max(0, Math.floor(input.maxToolRounds));
    const runDeadlineAt = input.maxDurationMs > 0 ? Date.now() + input.maxDurationMs : undefined;
    const reasoningParts: string[] = [];
    let researchSteps = 0;
    let budgetInstructionAppended = false;

    while (true) {
      this.throwIfStopped(input.signal, input.language);
      const canUseTools = researchSteps < maxToolRounds;
      if (!canUseTools && researchSteps > 0 && !budgetInstructionAppended) {
        messages.push({
          role: 'user',
          content: input.language === 'en'
            ? 'The read-only research budget is exhausted. Produce the final bounded answer now without calling tools.'
            : '只读调研预算已用尽。现在请直接输出有界的最终结果，不要再调用工具。'
        });
        budgetInstructionAppended = true;
      }
      const tools = canUseTools ? READONLY_AGENT_TOOLS : [];
      const body = this.createRequestBody(input, messages, tools);
      const requestId = randomUUID();
      const response = await this.client.createChatCompletion(input.clientConfig, {
        body,
        language: input.language,
        signal: input.signal,
        runDeadlineAt,
        requestId
      });
      if (!response.ok || !response.message) {
        throw new Error(response.error ?? (input.language === 'en'
          ? 'The read-only model request failed.'
          : '只读模型请求失败。'));
      }
      this.emitUsage(input, response.usage, requestId);
      if (response.message.reasoning_content?.trim()) {
        reasoningParts.push(response.message.reasoning_content);
      }
      const toolCalls = response.message.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      if (!toolCalls.length || !canUseTools) {
        const content = response.message.content?.trim() ?? '';
        if (!content) {
          throw new Error(input.language === 'en'
            ? 'The read-only model returned no final content.'
            : '只读模型没有返回最终内容。');
        }
        return {
          content,
          reasoningContent: reasoningParts.length ? reasoningParts.join('\n\n') : undefined,
          researchSteps,
          truncated: response.finishReason === 'length' || researchSteps >= maxToolRounds,
          finishReason: response.finishReason
        };
      }

      messages.push({
        role: 'assistant',
        content: response.message.content ?? null,
        reasoning_content: response.message.reasoning_content ?? null,
        tool_calls: toolCalls
      });
      for (const toolCall of toolCalls) {
        const content = await this.executeReadonlyTool(toolCall, input.language, input.signal, runDeadlineAt);
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content });
      }
      researchSteps += 1;
    }
  }

  private createRequestBody(
    input: ReadonlySubagentRunInput,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[]
  ): DeepSeekChatRequestBody {
    return {
      model: input.modelId,
      messages,
      stream: true,
      thinking: { type: input.thinkingEnabled ? 'enabled' : 'disabled' },
      reasoning_effort: input.thinkingEnabled ? input.reasoningEffort : undefined,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      max_tokens: input.maxTokens,
      stream_options: { include_usage: true }
    };
  }

  private emitUsage(
    input: ReadonlySubagentRunInput,
    usage: Parameters<typeof normalizeDeepSeekUsage>[0],
    requestId: string
  ): void {
    const normalized = normalizeDeepSeekUsage(usage);
    if (!normalized) {
      return;
    }
    const pricing = getConfiguredModelUsagePricing(input.modelId);
    input.callbacks?.onUsage?.(createUsageEvent({
      usage: normalized,
      cost: calculateUsageCost(normalized, pricing),
      currency: pricing.currency,
      modelId: input.modelId,
      requestId
    }));
  }

  private async executeReadonlyTool(
    toolCall: DeepSeekToolCall,
    language: KeepseekLanguage,
    signal: AbortSignal | undefined,
    runDeadlineAt: number | undefined
  ): Promise<string> {
    try {
      const args = this.parseArguments(toolCall.function.arguments);
      switch (toolCall.function.name) {
        case LIST_WORKSPACE_FILES_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceFiles(language);
        case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceDirectory(
            this.requiredString(args, 'path'),
            this.optionalBoolean(args, 'recursive'),
            this.optionalNumber(args, 'maxFiles'),
            language
          );
        case SEARCH_WORKSPACE_TOOL_NAME:
          return await this.workspaceTools.searchWorkspace({
            query: this.requiredString(args, 'query'),
            path: this.optionalString(args, 'path'),
            include: this.optionalString(args, 'include'),
            isRegex: this.optionalBoolean(args, 'isRegex'),
            matchCase: this.optionalBoolean(args, 'matchCase'),
            maxResults: this.optionalNumber(args, 'maxResults')
          }, language, { signal, runDeadlineAt });
        case READ_WORKSPACE_FILE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFile(this.requiredString(args, 'path'), language);
        case READ_WORKSPACE_FILE_RANGE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFileRange({
            path: this.requiredString(args, 'path'),
            startLine: this.requiredNumber(args, 'startLine'),
            endLine: this.requiredNumber(args, 'endLine'),
            maxBytes: this.optionalNumber(args, 'maxBytes')
          }, language);
        case READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME:
          return await this.validationTools.readWorkspaceDiagnostics(language);
        case FIND_SYMBOL_TOOL_NAME:
          return await this.semanticTools.findSymbol({
            query: this.requiredString(args, 'query'),
            path: this.optionalString(args, 'path'),
            maxResults: this.optionalNumber(args, 'maxResults')
          }, language);
        case FIND_REFERENCES_TOOL_NAME:
          return await this.semanticTools.findReferences({
            path: this.requiredString(args, 'path'),
            line: this.requiredNumber(args, 'line'),
            column: this.requiredNumber(args, 'column'),
            includeDeclaration: this.optionalBoolean(args, 'includeDeclaration'),
            maxResults: this.optionalNumber(args, 'maxResults')
          }, language);
        case GET_DOCUMENT_SYMBOLS_TOOL_NAME:
          return await this.semanticTools.getDocumentSymbols({
            path: this.requiredString(args, 'path'),
            maxResults: this.optionalNumber(args, 'maxResults')
          }, language);
        case GET_WORKSPACE_SYMBOLS_TOOL_NAME:
          return await this.semanticTools.getWorkspaceSymbols({
            query: this.requiredString(args, 'query'),
            maxResults: this.optionalNumber(args, 'maxResults')
          }, language);
        case GIT_STATUS_TOOL_NAME:
          return await this.gitTools.getStatus({ workspaceFolder: this.optionalString(args, 'workspaceFolder') }, language);
        case GIT_CURRENT_BRANCH_TOOL_NAME:
          return await this.gitTools.getCurrentBranch({ workspaceFolder: this.optionalString(args, 'workspaceFolder') }, language);
        case GIT_DIFF_TOOL_NAME:
          return await this.gitTools.getDiff({
            workspaceFolder: this.optionalString(args, 'workspaceFolder'),
            staged: this.optionalBoolean(args, 'staged'),
            path: this.optionalString(args, 'path'),
            maxChars: this.optionalNumber(args, 'maxChars')
          }, language);
        case GIT_CREATE_PATCH_TOOL_NAME:
          return await this.gitTools.createPatch({
            workspaceFolder: this.optionalString(args, 'workspaceFolder'),
            staged: this.optionalBoolean(args, 'staged'),
            path: this.optionalString(args, 'path')
          }, language);
        case GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME:
          return await this.gitTools.suggestCommitMessage({
            workspaceFolder: this.optionalString(args, 'workspaceFolder')
          }, language);
        default:
          return JSON.stringify({ ok: false, error: `Unsupported read-only tool: ${toolCall.function.name}` });
      }
    } catch (error) {
      return JSON.stringify({ ok: false, error: getErrorMessage(error) });
    }
  }

  private parseArguments(value: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }
    return parsed as Record<string, unknown>;
  }

  private requiredString(args: Record<string, unknown>, key: string): string {
    const value = this.optionalString(args, key);
    if (!value) {
      throw new Error(`Missing required string argument: ${key}`);
    }
    return value;
  }

  private optionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private requiredNumber(args: Record<string, unknown>, key: string): number {
    const value = this.optionalNumber(args, key);
    if (value === undefined) {
      throw new Error(`Missing required number argument: ${key}`);
    }
    return value;
  }

  private optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private optionalBoolean(args: Record<string, unknown>, key: string): boolean {
    return args[key] === true;
  }

  private throwIfStopped(signal: AbortSignal | undefined, language: KeepseekLanguage): void {
    if (signal?.aborted) {
      throw new Error(language === 'en' ? 'The read-only model run was stopped.' : '只读模型运行已中止。');
    }
  }
}
