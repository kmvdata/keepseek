import { AGENT_HISTORY_MESSAGE_LIMIT } from './config';
import { DeepSeekFunctionTool, DeepSeekMessage } from './deepSeekTypes';
import { formatBytes } from './format';
import type { KeepseekLanguage } from './i18n';
import { getMarkdownFence, getMarkdownLanguage } from './markdown';
import { estimateTokenCount } from './tokenEstimate';
import { ChatMessage, ContextFile } from './types';

export const CREATE_DRAFT_EDIT_TOOL_NAME = 'keepseek_create_draft_edit';
export const LIST_WORKSPACE_FILES_TOOL_NAME = 'keepseek_list_workspace_files';
export const LIST_WORKSPACE_DIRECTORY_TOOL_NAME = 'keepseek_list_workspace_directory';
export const READ_WORKSPACE_FILE_TOOL_NAME = 'keepseek_read_workspace_file';

export interface BuildAgentMessagesInput {
  prompt: string;
  contextFiles: ContextFile[];
  history: ChatMessage[];
  language: KeepseekLanguage;
}

export function buildInitialAgentMessages(input: BuildAgentMessagesInput): DeepSeekMessage[] {
  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: getAgentSystemPrompt(input)
    }
  ];

  const recentHistory = input.history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-AGENT_HISTORY_MESSAGE_LIMIT);

  for (const message of recentHistory) {
    const content = getMessageContentForAgent(message);
    if (!content) {
      continue;
    }

    messages.push({
      role: message.role,
      content
    });
  }

  const lastMessage = recentHistory[recentHistory.length - 1];
  if (input.prompt.trim() && (!lastMessage || lastMessage.role !== 'user' || getMessageContentForAgent(lastMessage) !== input.prompt)) {
    messages.push({
      role: 'user',
      content: input.prompt
    });
  }

  return messages;
}

export function getMessageContentForAgent(message: ChatMessage): string {
  return (message.expandedContent ?? message.content).trim();
}

export function getAgentSystemPrompt(input: {
  contextFiles: ContextFile[];
  language: KeepseekLanguage;
}): string {
  const contextBlock = formatAgentContextFiles(input);
  const instructions = input.language === 'en'
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

export function formatAgentContextFiles(input: {
  contextFiles: ContextFile[];
  language: KeepseekLanguage;
}): string {
  if (!input.contextFiles.length) {
    return '';
  }

  const files = input.contextFiles.map((file) => {
    const content = file.content.replace(/\r\n?/gu, '\n');
    const fence = getMarkdownFence(content);
    const language = getMarkdownLanguage(file.languageId);
    const sizedLabel = `${file.label} (${file.languageId}, ${formatBytes(file.sizeBytes)})`;
    return input.language === 'en'
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
    input.language === 'en'
      ? 'These are the context files the user added to KeepSeek. Prefer using them when answering:'
      : '以下是用户加入 KeepSeek 的上下文文件。回答时优先参考这些内容：',
    ...files
  ].join('\n\n');
}

export function getAgentTools(): DeepSeekFunctionTool[] {
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

export function estimateDeepSeekMessageTokens(message: DeepSeekMessage): number {
  const parts = [
    message.role,
    message.content ?? '',
    message.reasoning_content ?? '',
    message.tool_call_id ?? '',
    message.tool_calls ? JSON.stringify(message.tool_calls) : ''
  ];
  return estimateChatMessageTokens(message.role, parts.join('\n'));
}

export function estimateChatMessageTokens(role: string, content: string): number {
  return estimateTokenCount(`${role}\n${content}`) + 4;
}

export function estimateDeepSeekToolsTokens(tools: DeepSeekFunctionTool[] | undefined): number {
  if (!tools?.length) {
    return 0;
  }
  return estimateTokenCount(`tools\n${JSON.stringify(tools)}`) + tools.length * 8;
}
