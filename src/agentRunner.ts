import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRequest, AgentResponse, AgentRunCallbacks, ChatMessage, DraftEdit, ReasoningEffort } from './types';
import { formatBytes } from './fileContext';
import { isReadableTextContent, shouldSkipReferenceUri } from './fileReference';
import type { KeepseekLanguage } from './i18n';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const CREATE_DRAFT_EDIT_TOOL_NAME = 'keepseek_create_draft_edit';
const LIST_WORKSPACE_FILES_TOOL_NAME = 'keepseek_list_workspace_files';
const READ_WORKSPACE_FILE_TOOL_NAME = 'keepseek_read_workspace_file';
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 180_000;
export const DEFAULT_MAX_TOKENS = 64_000;
export const MAX_GENERATION_TOKENS = 384_000;
const DEFAULT_MAX_TOOL_ITERATIONS = 4;
const DEFAULT_WORKSPACE_TOOL_FILE_LIMIT = 2_000;
const WORKSPACE_TOOL_GLOB_EXCLUDE = '**/{.git,.vscode-test,build,coverage,dist,node_modules,out}/**';
export const AGENT_HISTORY_MESSAGE_LIMIT = 24;

type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';
type DeepSeekThinkingType = 'enabled' | 'disabled';

interface DeepSeekMessage {
  role: DeepSeekRole;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

interface DeepSeekFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    strict?: boolean;
  };
}

interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface DeepSeekToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface DeepSeekAssistantMessage {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[] | null;
}

interface DeepSeekStreamDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCallDelta[] | null;
}

interface DeepSeekStreamChoice {
  delta?: DeepSeekStreamDelta;
  finish_reason?: string | null;
}

interface DeepSeekStreamChunk {
  choices?: DeepSeekStreamChoice[];
}

interface DeepSeekStreamResult {
  message: DeepSeekAssistantMessage;
  finishReason?: string | null;
}

interface DeepSeekChatRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream: true;
  thinking?: {
    type: DeepSeekThinkingType;
  };
  reasoning_effort?: ReasoningEffort;
  tools?: DeepSeekFunctionTool[];
  tool_choice?: 'auto' | 'none';
  max_tokens?: number;
}

interface AgentRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  maxToolIterations: number;
  streamIdleTimeoutMs: number;
}

interface StreamingToolCallAccumulator {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export class AgentRunner {
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  public async run(request: AgentRequest, callbacks: AgentRunCallbacks = {}): Promise<AgentResponse> {
    const draftEdit = this.tryCreateDraftEdit(request.prompt, request.language);
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

    for (let turn = 0; turn <= maxIterations; turn += 1) {
      const response = await this.createChatCompletion(request, runtimeConfig, messages, turn < maxIterations ? tools : [], callbacks);
      const assistant = response.message;
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
          message: this.getFinalMessage(assistant.content, draftEdits, response.finishReason, request.language),
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
        const toolResult = await this.handleToolCall(toolCall, draftEdits, request.language);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
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
    callbacks: AgentRunCallbacks
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
    let abortedByStreamIdleTimeout = false;
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
    resetStreamIdleTimeout();

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
      return await this.parseChatCompletionStream(response.body, request.language, callbacks, resetStreamIdleTimeout);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError' && abortedByStreamIdleTimeout) {
        throw new Error(request.language === 'en'
          ? `DeepSeek API streaming response was idle for ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} seconds.`
          : `DeepSeek API 流式响应连续 ${Math.round(runtimeConfig.streamIdleTimeoutMs / 1000)} 秒没有返回数据，已停止本次请求。`);
      }
      throw error;
    } finally {
      clearStreamIdleTimeout();
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
          'Use keepseek_list_workspace_files and keepseek_read_workspace_file when you need the current project structure or file contents. Do not ask the user to run directory listing commands or paste file contents when these tools can provide the information.',
          'The read-only workspace tools only access files inside the open workspace, and they may skip large, binary, image, media, archive, or otherwise unreadable files.',
          'Important safety rule: tools only create DraftEdit pending changes and never write to disk directly. Do not claim files were written unless the user later applies the change.',
          'When the user asks to modify or create files, prefer calling keepseek_create_draft_edit with the target path, complete new file content, and a short reason.',
          'If information is missing, state the gap. If you can reasonably proceed, provide an actionable result.'
        ]
      : [
          '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
          '你需要用中文和用户沟通，除非用户明确要求其它语言。',
          '你可以根据用户的问题分析代码、解释方案、使用只读工具查看当前打开的工作区、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
          '当你需要了解当前工程结构或文件内容时，使用 keepseek_list_workspace_files 和 keepseek_read_workspace_file。只要这些工具能提供信息，就不要要求用户自行运行目录扫描命令或粘贴文件内容。',
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
      const fence = this.getMarkdownFence(content);
      const language = this.getMarkdownLanguage(file.languageId);
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
          return await this.listWorkspaceFiles(language);
        case READ_WORKSPACE_FILE_TOOL_NAME:
          return await this.readWorkspaceFile(args, language);
        case CREATE_DRAFT_EDIT_TOOL_NAME:
          return this.createDraftEdit(args, draftEdits);
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

  private createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[]): string {
    const rawPath = this.readRequiredString(args, 'path');
    const content = this.readRequiredString(args, 'content');
    const reason = this.readRequiredString(args, 'reason');
    const uri = this.resolveTargetUri(rawPath);
    const draftEdit: DraftEdit = {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.getLabel(uri),
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

  private async listWorkspaceFiles(language: KeepseekLanguage): Promise<string> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      return JSON.stringify({
        ok: false,
        error: language === 'en'
          ? 'Open a workspace before listing project files.'
          : '请先打开一个工作区，再列出工程文件。'
      });
    }

    const includeWorkspaceFolder = folders.length > 1;
    const maxFiles = this.getWorkspaceToolFileLimit();
    const files: Array<{
      path: string;
      label: string;
      workspaceFolder: string;
      sizeBytes: number;
      size: string;
      extension: string;
    }> = [];
    let truncated = false;

    for (const folder of folders) {
      const remaining = maxFiles - files.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      const uris = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, '**/*'),
        WORKSPACE_TOOL_GLOB_EXCLUDE,
        remaining
      );
      if (uris.length >= remaining) {
        truncated = true;
      }

      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type !== vscode.FileType.File) {
            continue;
          }

          const relativePath = vscode.workspace.asRelativePath(uri, includeWorkspaceFolder);
          files.push({
            path: relativePath,
            label: path.basename(uri.fsPath || uri.path) || relativePath,
            workspaceFolder: folder.name,
            sizeBytes: stat.size,
            size: formatBytes(stat.size),
            extension: path.extname(uri.fsPath || uri.path).toLowerCase()
          });
        } catch {
          // Skip files that disappeared or cannot be statted while listing.
        }
      }
    }

    files.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));

    return JSON.stringify({
      ok: true,
      files,
      count: files.length,
      limit: maxFiles,
      truncated,
      excluded: ['.git', '.vscode-test', 'build', 'coverage', 'dist', 'node_modules', 'out'],
      workspaceFolders: folders.map((folder) => ({
        name: folder.name,
        uri: folder.uri.toString()
      }))
    });
  }

  private async readWorkspaceFile(args: Record<string, unknown>, language: KeepseekLanguage): Promise<string> {
    const rawPath = this.readRequiredString(args, 'path');
    const uri = this.resolveWorkspaceFileUri(rawPath);

    if (shouldSkipReferenceUri(uri)) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en'
          ? 'This file type is not read as text by KeepSeek.'
          : 'KeepSeek 不会把这种文件类型作为文本读取。'
      });
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        error: language === 'en' ? 'The requested path is not a regular file.' : '请求的路径不是普通文件。'
      });
    }

    const maxBytes = this.getWorkspaceReadMaxBytes();
    if (stat.size > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: stat.size,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `File is larger than the read limit (${formatBytes(maxBytes)}).`
          : `文件超过读取上限（${formatBytes(maxBytes)}）。`
      });
    }

    const bytes = await vscode.workspace.fs.readFile(uri);
    const content = this.decodeWorkspaceText(bytes, uri, language);
    const encodedSize = new TextEncoder().encode(content).byteLength;
    if (encodedSize > maxBytes) {
      return JSON.stringify({
        ok: false,
        path: this.getLabel(uri),
        sizeBytes: encodedSize,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `Decoded text is larger than the read limit (${formatBytes(maxBytes)}).`
          : `解码后的文本超过读取上限（${formatBytes(maxBytes)}）。`
      });
    }

    const languageId = await this.detectLanguageId(uri);
    return JSON.stringify({
      ok: true,
      path: this.getLabel(uri),
      uri: uri.toString(),
      languageId,
      sizeBytes: encodedSize,
      size: formatBytes(encodedSize),
      content
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
        ? 'The agent reached the tool iteration limit and stopped this run.'
        : 'Agent 工具调用轮次已达上限，已停止本次执行。';
    }

    return language === 'en' ? 'DeepSeek did not return text content.' : 'DeepSeek 未返回文本内容。';
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

  private async parseChatCompletionStream(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    onStreamActivity?: () => void
  ): Promise<DeepSeekStreamResult> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallParts = new Map<number, StreamingToolCallAccumulator>();
    let buffer = '';
    let finishReason: string | null | undefined;
    let streamDone = false;
    let sawChunk = false;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      onStreamActivity?.();
      buffer = buffer.replace(/\r\n?/gu, '\n');

      let separatorIndex = buffer.indexOf('\n\n');
      while (separatorIndex >= 0) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const eventResult = this.consumeSseEvent(rawEvent, language, contentParts, reasoningParts, toolCallParts, callbacks);
        sawChunk = sawChunk || eventResult.sawChunk;
        finishReason = eventResult.finishReason ?? finishReason;
        streamDone = eventResult.done;
        if (streamDone) {
          break;
        }
        separatorIndex = buffer.indexOf('\n\n');
      }
    }

    const remaining = buffer.trim();
    if (remaining && !streamDone) {
      const eventResult = this.consumeSseEvent(remaining, language, contentParts, reasoningParts, toolCallParts, callbacks);
      sawChunk = sawChunk || eventResult.sawChunk;
      finishReason = eventResult.finishReason ?? finishReason;
    }

    if (!sawChunk) {
      throw new Error(language === 'en'
        ? 'DeepSeek API did not return any streaming chunks.'
        : 'DeepSeek API 未返回任何流式数据块。');
    }

    return {
      message: {
        role: 'assistant',
        content: contentParts.join(''),
        reasoning_content: reasoningParts.join(''),
        tool_calls: this.buildStreamingToolCalls(toolCallParts)
      },
      finishReason
    };
  }

  private consumeSseEvent(
    rawEvent: string,
    language: KeepseekLanguage,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): { done: boolean; sawChunk: boolean; finishReason?: string | null } {
    const dataLines = rawEvent
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart());

    let finishReason: string | null | undefined;
    let sawChunk = false;

    for (const data of dataLines) {
      if (data.trim() === '[DONE]') {
        return { done: true, sawChunk, finishReason };
      }

      if (!data.trim()) {
        continue;
      }

      const chunk = this.parseStreamChunk(data, language);
      sawChunk = true;
      finishReason = this.applyStreamChunk(chunk, contentParts, reasoningParts, toolCallParts, callbacks) ?? finishReason;
    }

    return { done: false, sawChunk, finishReason };
  }

  private parseStreamChunk(data: string, language: KeepseekLanguage): DeepSeekStreamChunk {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!this.isRecord(parsed)) {
        throw new Error(language === 'en' ? 'Chunk is not a JSON object.' : '数据块不是 JSON 对象。');
      }
      return parsed as DeepSeekStreamChunk;
    } catch (error) {
      throw new Error(language === 'en'
        ? `Cannot parse DeepSeek streaming response: ${error instanceof Error ? error.message : String(error)}`
        : `无法解析 DeepSeek 流式响应：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyStreamChunk(
    chunk: DeepSeekStreamChunk,
    contentParts: string[],
    reasoningParts: string[],
    toolCallParts: Map<number, StreamingToolCallAccumulator>,
    callbacks: AgentRunCallbacks
  ): string | null | undefined {
    let finishReason: string | null | undefined;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];

    for (const choice of choices) {
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;
      if (!delta) {
        continue;
      }

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        reasoningParts.push(delta.reasoning_content);
        callbacks.onDelta?.({ type: 'reasoning', delta: delta.reasoning_content });
      }

      if (typeof delta.content === 'string' && delta.content) {
        contentParts.push(delta.content);
        callbacks.onDelta?.({ type: 'content', delta: delta.content });
      }

      const toolCallDeltas = delta.tool_calls ?? [];
      for (let deltaIndex = 0; deltaIndex < toolCallDeltas.length; deltaIndex += 1) {
        const toolCallDelta = toolCallDeltas[deltaIndex];
        const index = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : deltaIndex;
        const current = toolCallParts.get(index) ?? {
          id: '',
          type: 'function' as const,
          function: {
            name: '',
            arguments: ''
          }
        };

        if (typeof toolCallDelta.id === 'string' && toolCallDelta.id) {
          current.id = toolCallDelta.id;
        }
        if (toolCallDelta.type === 'function') {
          current.type = 'function';
        }
        if (typeof toolCallDelta.function?.name === 'string') {
          current.function.name += toolCallDelta.function.name;
        }
        if (typeof toolCallDelta.function?.arguments === 'string') {
          current.function.arguments += toolCallDelta.function.arguments;
        }

        toolCallParts.set(index, current);
      }
    }

    return finishReason;
  }

  private buildStreamingToolCalls(toolCallParts: Map<number, StreamingToolCallAccumulator>): DeepSeekToolCall[] | null {
    const toolCalls = Array.from(toolCallParts.entries())
      .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
      .map(([index, toolCall]) => ({
        id: toolCall.id || `tool-call-${index}`,
        type: 'function' as const,
        function: {
          name: toolCall.function.name,
          arguments: toolCall.function.arguments
        }
      }))
      .filter((toolCall) => Boolean(toolCall.function.name));

    return toolCalls.length ? toolCalls : null;
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
      maxTokens: this.clampInteger(config.get<number>('maxTokens', DEFAULT_MAX_TOKENS), 0, MAX_GENERATION_TOKENS),
      maxToolIterations: this.clampInteger(config.get<number>('maxToolIterations', DEFAULT_MAX_TOOL_ITERATIONS), 0, 12),
      streamIdleTimeoutMs: this.clampInteger(config.get<number>('streamIdleTimeoutMs', DEFAULT_STREAM_IDLE_TIMEOUT_MS), 10_000, 3_600_000)
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

  private getMarkdownFence(content: string): string {
    const runs = content.match(/`+/gu) ?? [];
    const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return '`'.repeat(Math.max(3, longestRun + 1));
  }

  private getMarkdownLanguage(languageId: string): string {
    const languageById: Record<string, string> = {
      bat: 'batch',
      javascriptreact: 'jsx',
      plaintext: 'text',
      shellscript: 'bash',
      typescriptreact: 'tsx'
    };
    return (languageById[languageId] ?? languageId).replace(/[^\w+.-]/gu, '') || 'text';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private clampInteger(value: number | undefined, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }
    return Math.min(Math.max(Math.floor(value as number), min), max);
  }

  private getWorkspaceToolFileLimit(): number {
    const configuredLimit = vscode.workspace
      .getConfiguration('keepseek')
      .get<number>('maxWorkspaceToolFiles', DEFAULT_WORKSPACE_TOOL_FILE_LIMIT);
    return this.clampInteger(configuredLimit, 1, 50_000);
  }

  private getWorkspaceReadMaxBytes(): number {
    const configuredLimit = vscode.workspace
      .getConfiguration('keepseek')
      .get<number>('maxFileBytes', 200_000);
    return this.clampInteger(configuredLimit, 1, 20_000_000);
  }

  private resolveWorkspaceFileUri(rawPath: string): vscode.Uri {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!folders.length) {
      throw new Error('Open a workspace before reading project files.');
    }

    const uri = this.resolveWorkspaceFileUriCandidate(rawPath, folders);
    if (!this.isUriInsideWorkspace(uri)) {
      throw new Error('The requested file must be inside the currently open workspace.');
    }
    return uri;
  }

  private resolveWorkspaceFileUriCandidate(rawPath: string, folders: readonly vscode.WorkspaceFolder[]): vscode.Uri {
    if (/^file:/iu.test(rawPath) || /^[a-z][a-z\d+.-]*:\/\//iu.test(rawPath)) {
      return vscode.Uri.parse(rawPath);
    }

    if (path.isAbsolute(rawPath)) {
      return vscode.Uri.file(rawPath);
    }

    const normalizedPath = rawPath.replace(/\\/gu, '/').replace(/^\/+/u, '');
    if (!normalizedPath || normalizedPath.includes('\0')) {
      throw new Error('Workspace file path cannot be empty.');
    }

    if (folders.length > 1) {
      for (const folder of folders) {
        const folderPrefix = `${folder.name}/`;
        if (normalizedPath === folder.name || normalizedPath.startsWith(folderPrefix)) {
          const pathWithinFolder = normalizedPath === folder.name
            ? ''
            : normalizedPath.slice(folderPrefix.length);
          return vscode.Uri.joinPath(folder.uri, ...pathWithinFolder.split('/').filter(Boolean));
        }
      }
    }

    return vscode.Uri.joinPath(folders[0].uri, ...normalizedPath.split('/').filter(Boolean));
  }

  private isUriInsideWorkspace(uri: vscode.Uri): boolean {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      return false;
    }

    if (uri.scheme === 'file' && folder.uri.scheme === 'file') {
      const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
      return relativePath === '' || (Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    }

    return true;
  }

  private decodeWorkspaceText(bytes: Uint8Array, uri: vscode.Uri, language: KeepseekLanguage): string {
    const prefix = bytes.subarray(0, Math.min(bytes.length, 4096));
    if (prefix.includes(0)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} appears to be binary and was not read.`
        : `${this.getLabel(uri)} 看起来是二进制文件，已跳过读取。`);
    }

    const content = this.decoder.decode(bytes);
    if (!isReadableTextContent(content)) {
      throw new Error(language === 'en'
        ? `${this.getLabel(uri)} does not look like readable text.`
        : `${this.getLabel(uri)} 看起来不是可读文本。`);
    }
    return content;
  }

  private async detectLanguageId(uri: vscode.Uri): Promise<string> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      return document.languageId;
    } catch {
      return 'plaintext';
    }
  }

  private tryCreateDraftEdit(prompt: string, language: KeepseekLanguage): DraftEdit | undefined {
    const match = /^\/draft\s+([^\n]+)\n([\s\S]+)$/u.exec(prompt.trimEnd());
    if (!match) {
      return undefined;
    }

    const targetPath = match[1]?.trim();
    const newText = match[2] ?? '';
    if (!targetPath || !newText) {
      return undefined;
    }

    const uri = this.resolveTargetUri(targetPath);
    return {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.getLabel(uri),
      newText,
      reason: language === 'en'
        ? 'Draft edit proposed from the KeepSeek chat panel.'
        : '来自 KeepSeek 对话面板的待确认修改。'
    };
  }

  private resolveTargetUri(targetPath: string): vscode.Uri {
    if (/^file:/iu.test(targetPath)) {
      return vscode.Uri.parse(targetPath);
    }

    if (path.isAbsolute(targetPath)) {
      return vscode.Uri.file(targetPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return vscode.Uri.file(path.resolve(targetPath));
    }

    return vscode.Uri.joinPath(workspaceRoot, ...targetPath.split(/[\\/]+/).filter(Boolean));
  }

  private getLabel(uri: vscode.Uri): string {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }
}
