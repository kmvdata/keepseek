import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentRequest, AgentResponse, AgentRunCallbacks, ChatMessage, DraftEdit } from './types';
import { formatBytes } from './format';
import { getMarkdownFence, getMarkdownLanguage } from './markdown';
import {
  AGENT_HISTORY_MESSAGE_LIMIT,
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_MAX_TOKENS,
  getConfiguredContextWindowTokens,
  getConfiguredMaxRunMs,
  getConfiguredMaxToolCalls,
  getConfiguredMaxToolIterations,
  getConfiguredMaxTokens,
  getConfiguredStreamIdleTimeoutMs,
  getConfiguredToolResultTokenBudget,
  MAX_GENERATION_TOKENS
} from './config';
import { WorkspaceToolAdapter, WorkspaceToolService } from './workspaceTools';
import type { KeepseekLanguage } from './i18n';
import { DeepSeekStreamParser } from './deepSeekStreamParser';
import { DsmlToolParser } from './dsmlToolParser';
import {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekStreamResult,
  DeepSeekToolCall
} from './deepSeekTypes';

const CREATE_DRAFT_EDIT_TOOL_NAME = 'keepseek_create_draft_edit';
const LIST_WORKSPACE_FILES_TOOL_NAME = 'keepseek_list_workspace_files';
const LIST_WORKSPACE_DIRECTORY_TOOL_NAME = 'keepseek_list_workspace_directory';
const READ_WORKSPACE_FILE_TOOL_NAME = 'keepseek_read_workspace_file';
export { AGENT_HISTORY_MESSAGE_LIMIT, DEFAULT_MAX_TOKENS, MAX_GENERATION_TOKENS };

interface AgentRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  maxToolIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  toolResultTokenBudget: number;
  streamIdleTimeoutMs: number;
}

type AgentBudgetFinishReason =
  | 'tool_iterations_exhausted'
  | 'tool_call_limit_exhausted'
  | 'tool_result_budget_exhausted'
  | 'run_time_limit_exhausted';

export class AgentRunner {
  private readonly streamParser = new DeepSeekStreamParser();
  private readonly dsmlToolParser = new DsmlToolParser();

  public constructor(private readonly workspaceTools: WorkspaceToolAdapter = new WorkspaceToolService()) {}

  public async run(request: AgentRequest, callbacks: AgentRunCallbacks = {}): Promise<AgentResponse> {
    const draftEdit = await this.tryCreateDraftEdit(request.prompt, request.language);
    if (draftEdit) {
      return {
        message: request.language === 'en'
          ? [
              `Prepared a pending change for ${draftEdit.label}.`,
              'Click Apply on the change card; VS Code will ask for write permission before anything is written.'
            ].join('\n\n')
          : [
              `已为 ${draftEdit.label} 准备一个待确认修改。`,
              '点击修改卡片上的应用后，扩展会再次弹窗请求写入许可。'
            ].join('\n\n'),
        draftEdits: [draftEdit]
      };
    }

    const runtimeConfig = this.getRuntimeConfig(request.language);
    const messages = this.buildMessages(request);
    const tools = this.getTools();
    const draftEdits: DraftEdit[] = [];
    const reasoningParts: string[] = [];
    const maxIterations = Math.max(0, runtimeConfig.maxToolIterations);
    const runStartedAt = Date.now();
    const runDeadlineAt = runtimeConfig.maxRunMs > 0 ? runStartedAt + runtimeConfig.maxRunMs : undefined;
    const maxToolResultTokens = this.resolveToolResultTokenBudget(request, runtimeConfig, messages);
    let toolCallCount = 0;
    let toolResultTokens = 0;
    let budgetStopReason: AgentBudgetFinishReason | undefined;
    let budgetStopInstructionQueued = false;

    for (let turn = 0; turn <= maxIterations; turn += 1) {
      const runTimeStopReason = this.getRunTimeStopReason(runDeadlineAt);
      if (runTimeStopReason) {
        return {
          message: this.getFinalMessage(null, draftEdits, runTimeStopReason, request.language),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits
        };
      }

      const toolsForTurn = !budgetStopReason && turn < maxIterations ? tools : [];
      const response = await this.createChatCompletion(request, runtimeConfig, messages, toolsForTurn, callbacks, runDeadlineAt);
      const assistant = this.normalizeAssistantToolCalls(response.message, toolsForTurn.length > 0);
      if (!assistant) {
        throw new Error(request.language === 'en'
          ? 'DeepSeek API did not return a usable assistant message.'
          : 'DeepSeek API 没有返回可用的 assistant message。');
      }

      if (assistant.reasoning_content) {
        reasoningParts.push(assistant.reasoning_content);
      }

      const toolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      if (!toolCalls.length) {
        return {
          message: this.getFinalMessage(assistant.content, draftEdits, budgetStopReason ?? response.finishReason, request.language),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits
        };
      }

      messages.push({
        role: 'assistant',
        content: assistant.content ?? null,
        reasoning_content: assistant.reasoning_content ?? null,
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        let toolResult: string;
        if (budgetStopReason) {
          toolResult = this.createBudgetToolResult(budgetStopReason, request.language);
        } else if (runtimeConfig.maxToolCalls > 0 && toolCallCount >= runtimeConfig.maxToolCalls) {
          budgetStopReason = 'tool_call_limit_exhausted';
          toolResult = this.createBudgetToolResult(budgetStopReason, request.language, {
            toolCallCount,
            maxToolCalls: runtimeConfig.maxToolCalls
          });
        } else {
          toolCallCount += 1;
          const rawToolResult = await this.handleToolCall(toolCall, draftEdits, request.language);
          const nextToolResultTokens = this.estimateChatMessageTokens('tool', rawToolResult);
          if (toolResultTokens + nextToolResultTokens > maxToolResultTokens) {
            budgetStopReason = 'tool_result_budget_exhausted';
            toolResult = this.createBudgetToolResult(budgetStopReason, request.language, {
              usedTokens: toolResultTokens,
              nextTokens: nextToolResultTokens,
              maxTokens: maxToolResultTokens
            });
          } else {
            toolResultTokens += nextToolResultTokens;
            toolResult = rawToolResult;
          }

          budgetStopReason = budgetStopReason ?? this.getRunTimeStopReason(runDeadlineAt);
        }

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }

      if (budgetStopReason && !budgetStopInstructionQueued) {
        messages.push({
          role: 'user',
          content: this.getBudgetStopInstruction(budgetStopReason, request.language)
        });
        budgetStopInstructionQueued = true;
      }
    }

    return {
      message: this.getFinalMessage(null, draftEdits, 'tool_iterations_exhausted', request.language),
      reasoningContent: this.formatReasoning(reasoningParts),
      draftEdits
    };
  }

  private async createChatCompletion(
    request: AgentRequest,
    runtimeConfig: AgentRuntimeConfig,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    callbacks: AgentRunCallbacks,
    runDeadlineAt?: number
  ): Promise<DeepSeekStreamResult> {
    const body: DeepSeekChatRequestBody = {
      model: request.model.id,
      messages,
      stream: true,
      thinking: {
        type: request.settings.thinkingEnabled ? 'enabled' : 'disabled'
      },
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined
    };

    if (request.settings.thinkingEnabled) {
      body.reasoning_effort = request.settings.reasoningEffort;
    }

    if (runtimeConfig.maxTokens > 0) {
      body.max_tokens = runtimeConfig.maxTokens;
    }

    const controller = new AbortController();
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    let runTimeout: ReturnType<typeof setTimeout> | undefined;
    let abortedByStreamIdleTimeout = false;
    let abortedByRunTimeLimit = false;
    const resetStreamIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
      }
      idleTimeout = setTimeout(() => {
        abortedByStreamIdleTimeout = true;
        controller.abort();
      }, runtimeConfig.streamIdleTimeoutMs);
    };
    const clearStreamIdleTimeout = () => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = undefined;
      }
    };
    const setRunTimeout = () => {
      if (typeof runDeadlineAt !== 'number') {
        return;
      }
      const remainingMs = runDeadlineAt - Date.now();
      if (remainingMs <= 0) {
        abortedByRunTimeLimit = true;
        controller.abort();
        return;
      }
      runTimeout = setTimeout(() => {
        abortedByRunTimeLimit = true;
        controller.abort();
      }, remainingMs);
    };
    const clearRunTimeout = () => {
      if (runTimeout) {
        clearTimeout(runTimeout);
        runTimeout = undefined;
      }
    };
    resetStreamIdleTimeout();
    setRunTimeout();

    try {
      const response = await fetch(this.getChatCompletionsUrl(runtimeConfig.baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${runtimeConfig.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(request.language === 'en'
          ? `DeepSeek API request failed (${response.status}): ${this.formatApiError(responseText, request.language)}`
          : `DeepSeek API 请求失败 (${response.status}): ${this.formatApiError(responseText, request.language)}`);
      }

      if (!response.body) {
        throw new Error(request.language === 'en'
          ? 'DeepSeek API did not return a streaming response body.'
          : 'DeepSeek API 未返回流式响应体。');
      }

      resetStreamIdleTimeout();
      return await this.streamParser.parse(response.body, request.language, callbacks, resetStreamIdleTimeout);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && abortedByRunTimeLimit) {
        throw new Error(this.getRunTimeLimitError(runtimeConfig.maxRunMs, request.language));
      }
      if (error instanceof Error && error.name === 'AbortError' && abortedByStreamIdleTimeout) {
        throw new Error(request.language === 'en'
          ? `DeepSeek API streaming response was idle for ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} seconds.`
          : `DeepSeek API 流式响应连续 ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} 秒没有返回数据，已停止本次请求。`);
      }
      throw error;
    } finally {
      clearStreamIdleTimeout();
      clearRunTimeout();
    }
  }

  private buildMessages(request: AgentRequest): DeepSeekMessage[] {
    const messages: DeepSeekMessage[] = [
      {
        role: 'system',
        content: this.getSystemPrompt(request)
      }
    ];

    const recentHistory = request.history
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .slice(-AGENT_HISTORY_MESSAGE_LIMIT);

    for (const message of recentHistory) {
      const content = this.getMessageContentForAgent(message);
      if (!content) {
        continue;
      }

      messages.push({
        role: message.role,
        content
      });
    }

    const lastMessage = recentHistory[recentHistory.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || this.getMessageContentForAgent(lastMessage) !== request.prompt) {
      messages.push({
        role: 'user',
        content: request.prompt
      });
    }

    return messages;
  }

  private getMessageContentForAgent(message: ChatMessage): string {
    return (message.expandedContent ?? message.content).trim();
  }

  private getSystemPrompt(request: AgentRequest): string {
    const contextBlock = this.formatContextFiles(request);
    const instructions = request.language === 'en'
      ? [
          'You are KeepSeek, a coding agent running in the VS Code sidebar.',
          'Communicate with the user in English unless the user explicitly asks for another language.',
          'You can analyze code, explain approaches, inspect the open workspace with read-only tools, suggest changes, and call tools to create pending edits when files need to change.',
          'Use keepseek_list_workspace_files, keepseek_list_workspace_directory, and keepseek_read_workspace_file when you need the current project structure or file contents. Do not ask the user to run directory listing commands or paste file contents when these tools can provide the information.',
          'When the user references a directory, treat it as a target or reference scope. Prefer that directory for related new files, and list/read files under it when you need examples.',
          'The read-only workspace tools only access files inside the open workspace, and they may skip large, binary, image, media, archive, or otherwise unreadable files.',
          'Important safety rule: tools only create DraftEdit pending changes and never write to disk directly. Do not claim files were written unless the user later applies the change.',
          'When the user asks to modify or create files, prefer calling keepseek_create_draft_edit with the target path, complete new file content, and a short reason.',
          'If information is missing, state the gap. If you can reasonably proceed, provide an actionable result.'
        ]
      : [
          '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
          '你需要用中文和用户沟通，除非用户明确要求其它语言。',
          '你可以根据用户的问题分析代码、解释方案、使用只读工具查看当前打开的工作区、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
          '当你需要了解当前工程结构或文件内容时，使用 keepseek_list_workspace_files、keepseek_list_workspace_directory 和 keepseek_read_workspace_file。只要这些工具能提供信息，就不要要求用户自行运行目录扫描命令或粘贴文件内容。',
          '当用户引用目录时，把它视为目标位置或参考范围。创建相关新文件时优先放在该目录下；需要参考示例时，先列出并读取该目录下的文件。',
          '只读工作区工具只会访问当前打开工作区内的文件，并可能跳过过大、二进制、图片、媒体、归档或其它不可读文件。',
          '重要安全规则：工具只会创建 DraftEdit 待确认修改，不会直接写入磁盘；不要声称已经写入文件，除非用户之后手动确认。',
          '当用户要求修改或创建文件时，优先调用 keepseek_create_draft_edit，并传入目标路径、完整的新文件内容和简短原因。',
          '如果信息不足，先说明缺口；如果可以合理推进，就直接给出可执行结果。'
        ];

    return [...instructions, contextBlock].filter(Boolean).join('\n\n');
  }

  private formatContextFiles(request: AgentRequest): string {
    if (!request.contextFiles.length) {
      return '';
    }

    const files = request.contextFiles.map((file) => {
      const content = file.content.replace(/\r\n?/gu, '\n');
      const fence = getMarkdownFence(content);
      const language = getMarkdownLanguage(file.languageId);
      const sizedLabel = `${file.label} (${file.languageId}, ${formatBytes(file.sizeBytes)})`;
      return request.language === 'en'
        ? [
            `Context file: ${sizedLabel}`,
            `Path: ${file.fsPath}`,
            `${fence}${language}`,
            content.endsWith('\n') ? content : `${content}\n`,
            fence
          ].join('\n')
        : [
            `上下文文件：${sizedLabel}`,
            `路径：${file.fsPath}`,
            `${fence}${language}`,
            content.endsWith('\n') ? content : `${content}\n`,
            fence
          ].join('\n');
    });

    return [
      request.language === 'en'
        ? 'These are the context files the user added to KeepSeek. Prefer using them when answering:'
        : '以下是用户加入 KeepSeek 的上下文文件。回答时优先参考这些内容：',
      ...files
    ].join('\n\n');
  }

  private getTools(): DeepSeekFunctionTool[] {
    return [
      {
        type: 'function',
        function: {
          name: LIST_WORKSPACE_FILES_TOOL_NAME,
          description: 'List files in the currently open VS Code workspace. This is read-only and skips common dependency, build, coverage, and VCS directories.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: READ_WORKSPACE_FILE_TOOL_NAME,
          description: 'Read the complete text content of a file inside the currently open VS Code workspace. This is read-only and refuses files outside the workspace, oversized files, binary files, images, media, and archives.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path from keepseek_list_workspace_files, or an absolute/file URI path that still points inside the current workspace.'
              }
            },
            required: ['path'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
          description: 'List files and subdirectories under a directory inside the currently open VS Code workspace. This is read-only and skips common dependency, build, coverage, and VCS directories.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path from a directory reference or keepseek_list_workspace_files, or an absolute/file URI path that still points inside the current workspace.'
              },
              recursive: {
                type: 'boolean',
                description: 'Whether to include nested files and subdirectories. Use false first unless the user needs a broader scan.'
              },
              maxFiles: {
                type: 'number',
                description: 'Maximum number of directory entries to return. Defaults to 100 and is capped by KeepSeek settings.'
              }
            },
            required: ['path', 'recursive', 'maxFiles'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: CREATE_DRAFT_EDIT_TOOL_NAME,
          description: 'Create a safe draft file edit for the user to review and apply in VS Code. This never writes to disk directly.',
          strict: true,
          parameters: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Workspace-relative path, absolute filesystem path, or file URI for the file to create or replace.'
              },
              content: {
                type: 'string',
                description: 'The complete new file content. Use the full desired file content, not a diff.'
              },
              reason: {
                type: 'string',
                description: 'A short human-readable reason shown in the confirmation dialog.'
              }
            },
            required: ['path', 'content', 'reason'],
            additionalProperties: false
          }
        }
      }
    ];
  }

  private async handleToolCall(toolCall: DeepSeekToolCall, draftEdits: DraftEdit[], language: KeepseekLanguage): Promise<string> {
    try {
      const args = this.parseToolArguments(toolCall.function.arguments);
      switch (toolCall.function.name) {
        case LIST_WORKSPACE_FILES_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceFiles(language);
        case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceDirectory(
            this.readRequiredString(args, 'path'),
            this.readOptionalBoolean(args, 'recursive', false),
            this.readOptionalNumber(args, 'maxFiles'),
            language
          );
        case READ_WORKSPACE_FILE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFile(this.readRequiredString(args, 'path'), language);
        case CREATE_DRAFT_EDIT_TOOL_NAME:
          return await this.createDraftEdit(args, draftEdits);
        default:
          return JSON.stringify({
            ok: false,
            error: `Unsupported tool: ${toolCall.function.name}`
          });
      }
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[]): Promise<string> {
    const rawPath = this.readRequiredString(args, 'path');
    const content = this.readRequiredString(args, 'content');
    const reason = this.readRequiredString(args, 'reason');
    const uri = this.workspaceTools.resolveTargetUri(rawPath);
    const draftEdit: DraftEdit = {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      action: await this.getDraftEditAction(uri),
      newText: content,
      reason
    };

    draftEdits.push(draftEdit);
    return JSON.stringify({
      ok: true,
      draftEdit: {
        id: draftEdit.id,
        label: draftEdit.label
      },
      message: 'Draft edit created. Tell the user they can review and apply it from the KeepSeek panel.'
    });
  }

  private parseToolArguments(rawArguments: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArguments || '{}');
    } catch {
      throw new Error('Tool arguments are not valid JSON.');
    }

    if (!this.isRecord(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }

    return parsed;
  }

  private readRequiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
      throw new Error(`Tool argument "${key}" must be a string.`);
    }

    if (key !== 'content' && !value.trim()) {
      throw new Error(`Tool argument "${key}" cannot be empty.`);
    }

    return key === 'content' ? value : value.trim();
  }

  private readOptionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = args[key];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`Tool argument "${key}" must be a boolean.`);
    }
    return value;
  }

  private readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Tool argument "${key}" must be a number.`);
    }
    return value;
  }

  private resolveToolResultTokenBudget(
    request: AgentRequest,
    runtimeConfig: AgentRuntimeConfig,
    messages: DeepSeekMessage[]
  ): number {
    if (runtimeConfig.toolResultTokenBudget > 0) {
      return runtimeConfig.toolResultTokenBudget;
    }

    const contextWindowTokens = getConfiguredContextWindowTokens(request.model);
    const initialInputTokens = messages.reduce((total, message) => total + this.estimateDeepSeekMessageTokens(message), 0);
    const outputReserveTokens = runtimeConfig.maxTokens > 0 ? runtimeConfig.maxTokens : DEFAULT_MAX_TOKENS;
    const safetyReserveTokens = 16_000;
    return Math.max(0, contextWindowTokens - initialInputTokens - outputReserveTokens - safetyReserveTokens);
  }

  private estimateDeepSeekMessageTokens(message: DeepSeekMessage): number {
    const parts = [
      message.role,
      message.content ?? '',
      message.reasoning_content ?? '',
      message.tool_call_id ?? '',
      message.tool_calls ? JSON.stringify(message.tool_calls) : ''
    ];
    return this.estimateChatMessageTokens(message.role, parts.join('\n'));
  }

  private estimateChatMessageTokens(role: string, content: string): number {
    return this.estimateTokenCount(`${role}\n${content}`) + 4;
  }

  private estimateTokenCount(value: string): number {
    let estimate = 0;
    for (const character of String(value || '')) {
      const codePoint = character.codePointAt(0) ?? 0;
      estimate += codePoint <= 0x7f ? 0.3 : 0.6;
    }
    return Math.ceil(estimate);
  }

  private getRunTimeStopReason(runDeadlineAt: number | undefined): AgentBudgetFinishReason | undefined {
    return typeof runDeadlineAt === 'number' && Date.now() >= runDeadlineAt
      ? 'run_time_limit_exhausted'
      : undefined;
  }

  private createBudgetToolResult(
    reason: AgentBudgetFinishReason,
    language: KeepseekLanguage,
    details: Record<string, number> = {}
  ): string {
    return JSON.stringify({
      ok: false,
      error: this.getBudgetToolError(reason, language),
      budgetReason: reason,
      ...details
    });
  }

  private getBudgetToolError(reason: AgentBudgetFinishReason, language: KeepseekLanguage): string {
    switch (reason) {
      case 'tool_call_limit_exhausted':
        return language === 'en'
          ? 'The KeepSeek tool-call budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具调用总数预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'tool_result_budget_exhausted':
        return language === 'en'
          ? 'The KeepSeek tool-result token budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具结果 token 预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'run_time_limit_exhausted':
        return language === 'en'
          ? 'The KeepSeek total run-time budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 本次执行总时长预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'tool_iterations_exhausted':
      default:
        return language === 'en'
          ? 'The KeepSeek tool-iteration budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具调用轮次预算已达上限。请停止调用工具，并基于已有上下文回答。';
    }
  }

  private getBudgetStopInstruction(reason: AgentBudgetFinishReason, language: KeepseekLanguage): string {
    const error = this.getBudgetToolError(reason, language);
    return language === 'en'
      ? `${error} Do not emit function calls or DSML tool calls in the next response. Provide the best concise result using the information already gathered, and mention any remaining gap.`
      : `${error} 下一次回复不要输出 function call 或 DSML 工具调用。请使用已经收集到的信息给出尽量完整、简洁的结果，并说明仍缺少的信息。`;
  }

  private getFinalMessage(
    content: string | null | undefined,
    draftEdits: DraftEdit[],
    finishReason: string | null | undefined,
    language: KeepseekLanguage
  ): string {
    const text = (content ?? '').trim();
    if (text) {
      return finishReason === 'length'
        ? `${text}\n\n${this.getLengthLimitMessage(language)}`
        : text;
    }

    if (draftEdits.length) {
      if (language === 'en') {
        return draftEdits.length === 1
          ? `Prepared a pending change for ${draftEdits[0].label}.`
          : `Prepared ${draftEdits.length} pending changes.`;
      }
      return draftEdits.length === 1
        ? `已准备 ${draftEdits[0].label} 的待确认修改。`
        : `已准备 ${draftEdits.length} 个待确认修改。`;
    }

    if (finishReason === 'content_filter') {
      return language === 'en'
        ? 'DeepSeek filtered the response because of a safety policy, so no displayable reply was generated.'
        : 'DeepSeek 返回内容被安全策略过滤，未生成可展示回复。';
    }

    if (finishReason === 'length') {
      return this.getLengthLimitMessage(language);
    }

    if (finishReason === 'tool_iterations_exhausted') {
      return language === 'en'
        ? 'The agent reached the tool iteration limit and stopped this run. Increase keepseek.maxToolIterations if this task needs more workspace exploration.'
        : 'Agent 工具调用轮次已达上限，已停止本次执行。若本次任务需要更多工程探索，可以提高 keepseek.maxToolIterations。';
    }

    if (finishReason === 'tool_call_limit_exhausted') {
      return language === 'en'
        ? 'The agent reached the total tool-call limit and stopped this run. Increase keepseek.maxToolCalls if this task needs broader workspace exploration.'
        : 'Agent 工具调用总数已达上限，已停止本次执行。若本次任务需要更大范围的工程探索，可以提高 keepseek.maxToolCalls。';
    }

    if (finishReason === 'tool_result_budget_exhausted') {
      return language === 'en'
        ? 'The agent reached the tool-result token budget and stopped this run. Increase keepseek.toolResultTokenBudget, or leave it at 0 to use the automatic context-window budget.'
        : 'Agent 工具结果 token 预算已达上限，已停止本次执行。可以提高 keepseek.toolResultTokenBudget，或设为 0 使用基于上下文窗口的自动预算。';
    }

    if (finishReason === 'run_time_limit_exhausted') {
      return this.getRunTimeLimitError(0, language);
    }

    return language === 'en' ? 'DeepSeek did not return text content.' : 'DeepSeek 未返回文本内容。';
  }

  private getRunTimeLimitError(maxRunMs: number, language: KeepseekLanguage): string {
    const seconds = maxRunMs > 0 ? Math.round(maxRunMs / 1000) : 0;
    if (language === 'en') {
      return seconds > 0
        ? `The agent reached the total run-time limit (${seconds} seconds) and stopped this run.`
        : 'The agent reached the total run-time limit and stopped this run.';
    }
    return seconds > 0
      ? `Agent 本次执行达到总时长上限（${seconds} 秒），已停止本次执行。`
      : 'Agent 本次执行达到总时长上限，已停止本次执行。';
  }

  private getLengthLimitMessage(language: KeepseekLanguage): string {
    return language === 'en'
      ? 'DeepSeek reached the generated-token budget before completing the reply. Increase keepseek.maxTokens, reduce reasoning effort, disable Thinking, or shrink context and try again.'
      : 'DeepSeek 本次生成耗尽了输出 token 预算，未生成完整回复。可以提高 keepseek.maxTokens、降低推理强度、关闭 Thinking，或缩小上下文后重试。';
  }

  private formatReasoning(parts: string[]): string | undefined {
    const cleaned = parts.map((part) => part.trim()).filter(Boolean);
    if (!cleaned.length) {
      return undefined;
    }

    if (cleaned.length === 1) {
      return cleaned[0];
    }

    return cleaned.map((part, index) => `Step ${index + 1}\n${part}`).join('\n\n');
  }

  private normalizeAssistantToolCalls(assistant: DeepSeekAssistantMessage, allowToolCalls: boolean): DeepSeekAssistantMessage {
    if (!allowToolCalls) {
      return {
        ...assistant,
        tool_calls: null
      };
    }

    const structuredToolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
    if (structuredToolCalls.length) {
      return assistant;
    }

    const parsedDsml = this.dsmlToolParser.parse(assistant.content ?? '');
    if (!parsedDsml?.toolCalls.length) {
      return assistant;
    }

    return {
      ...assistant,
      content: parsedDsml.content,
      tool_calls: parsedDsml.toolCalls
    };
  }

  private formatApiError(responseText: string, language: KeepseekLanguage): string {
    if (!responseText.trim()) {
      return language === 'en' ? 'Response is empty.' : '响应为空。';
    }

    try {
      const parsed: unknown = JSON.parse(responseText);
      if (this.isRecord(parsed)) {
        const error = parsed.error;
        if (this.isRecord(error) && typeof error.message === 'string') {
          return error.message;
        }
        if (typeof parsed.message === 'string') {
          return parsed.message;
        }
      }
    } catch {
      // Fall through to a clipped raw response.
    }

    return responseText.length > 800 ? `${responseText.slice(0, 800)}...` : responseText;
  }

  private getRuntimeConfig(language: KeepseekLanguage): AgentRuntimeConfig {
    const config = vscode.workspace.getConfiguration('keepseek');
    const apiKey = (config.get<string>('apiKey', '').trim() || process.env.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error(language === 'en'
        ? 'Save a DeepSeek API Key in KeepSeek Settings > Api Key, or set the DEEPSEEK_API_KEY environment variable.'
        : '请先在 KeepSeek 设置 > Api Key 中保存 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量。');
    }

    return {
      apiKey,
      baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
      maxTokens: getConfiguredMaxTokens(),
      maxToolIterations: getConfiguredMaxToolIterations(),
      maxToolCalls: getConfiguredMaxToolCalls(),
      maxRunMs: getConfiguredMaxRunMs(),
      toolResultTokenBudget: getConfiguredToolResultTokenBudget(),
      streamIdleTimeoutMs: getConfiguredStreamIdleTimeoutMs()
    };
  }

  private getChatCompletionsUrl(rawBaseUrl: string): string {
    const url = new URL(rawBaseUrl || DEFAULT_DEEPSEEK_BASE_URL);
    const cleanPath = url.pathname.replace(/\/+$/u, '');

    if (cleanPath.endsWith('/chat/completions')) {
      url.pathname = cleanPath;
      return url.toString();
    }

    const basePath = cleanPath.endsWith('/anthropic')
      ? cleanPath.slice(0, -'/anthropic'.length)
      : cleanPath;
    url.pathname = `${basePath || ''}/chat/completions`;
    return url.toString();
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async tryCreateDraftEdit(prompt: string, language: KeepseekLanguage): Promise<DraftEdit | undefined> {
    const match = /^\/draft\s+([^\n]+)\n([\s\S]+)$/u.exec(prompt.trimEnd());
    if (!match) {
      return undefined;
    }

    const targetPath = match[1]?.trim();
    const newText = match[2] ?? '';
    if (!targetPath || !newText) {
      return undefined;
    }

    const uri = this.workspaceTools.resolveTargetUri(targetPath);
    return {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      action: await this.getDraftEditAction(uri),
      newText,
      reason: language === 'en'
        ? 'Draft edit proposed from the KeepSeek chat panel.'
        : '来自 KeepSeek 对话面板的待确认修改。'
    };
  }

  private async getDraftEditAction(uri: vscode.Uri): Promise<DraftEdit['action']> {
    try {
      await vscode.workspace.fs.stat(uri);
      return 'modify';
    } catch {
      return 'create';
    }
  }

}
