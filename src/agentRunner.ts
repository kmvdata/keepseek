import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRequest, AgentResponse, DraftEdit, ReasoningEffort } from './types';
import { formatBytes } from './fileContext';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const CREATE_DRAFT_EDIT_TOOL_NAME = 'keepseek_create_draft_edit';
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOOL_ITERATIONS = 4;

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

interface DeepSeekAssistantMessage {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[] | null;
}

interface DeepSeekChoice {
  finish_reason?: string | null;
  message?: DeepSeekAssistantMessage;
}

interface DeepSeekChatResponse {
  choices?: DeepSeekChoice[];
}

interface DeepSeekChatRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream: false;
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
  requestTimeoutMs: number;
}

export class AgentRunner {
  public async run(request: AgentRequest): Promise<AgentResponse> {
    const draftEdit = this.tryCreateDraftEdit(request.prompt);
    if (draftEdit) {
      return {
        message: [
          `已为 ${draftEdit.label} 准备一个待确认修改。`,
          '点击修改卡片上的 Apply 后，扩展会再次弹窗请求写入许可。'
        ].join('\n\n'),
        draftEdits: [draftEdit]
      };
    }

    const runtimeConfig = this.getRuntimeConfig();
    const messages = this.buildMessages(request);
    const tools = this.getTools();
    const draftEdits: DraftEdit[] = [];
    const reasoningParts: string[] = [];
    const maxIterations = Math.max(0, runtimeConfig.maxToolIterations);

    for (let turn = 0; turn <= maxIterations; turn += 1) {
      const response = await this.createChatCompletion(request, runtimeConfig, messages, turn < maxIterations ? tools : []);
      const choice = response.choices?.[0];
      const assistant = choice?.message;
      if (!assistant) {
        throw new Error('DeepSeek API 没有返回可用的 assistant message。');
      }

      if (assistant.reasoning_content) {
        reasoningParts.push(assistant.reasoning_content);
      }

      const toolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      if (!toolCalls.length) {
        return {
          message: this.getFinalMessage(assistant.content, draftEdits, choice?.finish_reason),
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
        const toolResult = this.handleToolCall(toolCall, draftEdits);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: toolResult
        });
      }
    }

    return {
      message: this.getFinalMessage(null, draftEdits, 'tool_iterations_exhausted'),
      reasoningContent: this.formatReasoning(reasoningParts),
      draftEdits
    };
  }

  private async createChatCompletion(
    request: AgentRequest,
    runtimeConfig: AgentRuntimeConfig,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[]
  ): Promise<DeepSeekChatResponse> {
    const body: DeepSeekChatRequestBody = {
      model: request.model.id,
      messages,
      stream: false,
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
    const timeout = setTimeout(() => controller.abort(), runtimeConfig.requestTimeoutMs);

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

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(`DeepSeek API 请求失败 (${response.status}): ${this.formatApiError(responseText)}`);
      }

      return this.parseChatResponse(responseText);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`DeepSeek API 请求超过 ${Math.round(runtimeConfig.requestTimeoutMs / 1000)} 秒未完成。`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
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
      .slice(-24);

    for (const message of recentHistory) {
      const content = message.content.trim();
      if (!content) {
        continue;
      }

      messages.push({
        role: message.role,
        content
      });
    }

    const lastMessage = recentHistory[recentHistory.length - 1];
    if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== request.prompt) {
      messages.push({
        role: 'user',
        content: request.prompt
      });
    }

    return messages;
  }

  private getSystemPrompt(request: AgentRequest): string {
    const contextBlock = this.formatContextFiles(request);
    return [
      '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
      '你需要用中文和用户沟通，除非用户明确要求其它语言。',
      '你可以根据用户的问题分析代码、解释方案、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
      '重要安全规则：工具只会创建 DraftEdit 待确认修改，不会直接写入磁盘；不要声称已经写入文件，除非用户之后手动确认。',
      '当用户要求修改或创建文件时，优先调用 keepseek_create_draft_edit，并传入目标路径、完整的新文件内容和简短原因。',
      '如果信息不足，先说明缺口；如果可以合理推进，就直接给出可执行结果。',
      contextBlock
    ].filter(Boolean).join('\n\n');
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
      return [
        `上下文文件：${sizedLabel}`,
        `路径：${file.fsPath}`,
        `${fence}${language}`,
        content.endsWith('\n') ? content : `${content}\n`,
        fence
      ].join('\n');
    });

    return ['以下是用户加入 KeepSeek 的上下文文件。回答时优先参考这些内容：', ...files].join('\n\n');
  }

  private getTools(): DeepSeekFunctionTool[] {
    return [
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

  private handleToolCall(toolCall: DeepSeekToolCall, draftEdits: DraftEdit[]): string {
    if (toolCall.function.name !== CREATE_DRAFT_EDIT_TOOL_NAME) {
      return JSON.stringify({
        ok: false,
        error: `Unsupported tool: ${toolCall.function.name}`
      });
    }

    try {
      const args = this.parseToolArguments(toolCall.function.arguments);
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
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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

  private getFinalMessage(content: string | null | undefined, draftEdits: DraftEdit[], finishReason: string | null | undefined): string {
    const text = (content ?? '').trim();
    if (text) {
      return text;
    }

    if (draftEdits.length) {
      return draftEdits.length === 1
        ? `已准备 ${draftEdits[0].label} 的待确认修改。`
        : `已准备 ${draftEdits.length} 个待确认修改。`;
    }

    if (finishReason === 'content_filter') {
      return 'DeepSeek 返回内容被安全策略过滤，未生成可展示回复。';
    }

    if (finishReason === 'length') {
      return 'DeepSeek 输出达到长度上限，未生成完整回复。可以缩小上下文或提高 maxTokens 后重试。';
    }

    if (finishReason === 'tool_iterations_exhausted') {
      return 'Agent 工具调用轮次已达上限，已停止本次执行。';
    }

    return 'DeepSeek 未返回文本内容。';
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

  private parseChatResponse(responseText: string): DeepSeekChatResponse {
    try {
      const parsed: unknown = JSON.parse(responseText);
      if (!this.isRecord(parsed)) {
        throw new Error('Response is not a JSON object.');
      }
      return parsed as DeepSeekChatResponse;
    } catch (error) {
      throw new Error(`无法解析 DeepSeek API 响应：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private formatApiError(responseText: string): string {
    if (!responseText.trim()) {
      return '响应为空。';
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

  private getRuntimeConfig(): AgentRuntimeConfig {
    const config = vscode.workspace.getConfiguration('keepseek');
    const apiKey = (config.get<string>('apiKey', '').trim() || process.env.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error('请先在 KeepSeek 命令菜单的 Api Key 中保存 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量。');
    }

    return {
      apiKey,
      baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
      maxTokens: this.clampInteger(config.get<number>('maxTokens', 8192), 0, 384_000),
      maxToolIterations: this.clampInteger(config.get<number>('maxToolIterations', DEFAULT_MAX_TOOL_ITERATIONS), 0, 12),
      requestTimeoutMs: this.clampInteger(config.get<number>('requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS), 10_000, 600_000)
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

  private tryCreateDraftEdit(prompt: string): DraftEdit | undefined {
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
      reason: 'Draft edit proposed from the KeepSeek chat panel.'
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
