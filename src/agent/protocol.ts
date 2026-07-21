import { DeepSeekFunctionTool, DeepSeekMessage } from './deepseek/types';
import { formatBytes } from '../shared/format';
import type { KeepseekLanguage } from '../shared/i18n';
import { getMarkdownFence, getMarkdownLanguage } from '../shared/markdown';
import { estimateTokenCount } from './tokenEstimate';
import { ActivatedSkill, ChatMessage, ContextFile } from '../shared/types';
import type { HistoryProjectionResult } from './historyProjection';

export const CREATE_DRAFT_EDIT_TOOL_NAME = 'keepseek_create_draft_edit';
export const LIST_WORKSPACE_FILES_TOOL_NAME = 'keepseek_list_workspace_files';
export const LIST_WORKSPACE_DIRECTORY_TOOL_NAME = 'keepseek_list_workspace_directory';
export const SEARCH_WORKSPACE_TOOL_NAME = 'keepseek_search_workspace';
export const READ_WORKSPACE_FILE_TOOL_NAME = 'keepseek_read_workspace_file';
export const READ_WORKSPACE_FILE_RANGE_TOOL_NAME = 'keepseek_read_workspace_file_range';
export const READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME = 'keepseek_read_workspace_diagnostics';
export const RUN_VALIDATION_TOOL_NAME = 'keepseek_run_validation';

const MAX_ACTIVE_SKILL_CONTENT_CHARS = 24000;
const MAX_ACTIVE_SKILLS_TOTAL_CHARS = 72000;
const UNPROJECTED_HISTORY_MESSAGE_LIMIT = 24;
const CORE_AGENT_TOOL_NAMES = [
  CREATE_DRAFT_EDIT_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
];
const ALL_AGENT_TOOL_NAMES = [
  CREATE_DRAFT_EDIT_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
];

export interface BuildAgentMessagesInput {
  prompt: string;
  contextFiles: ContextFile[];
  skills?: ActivatedSkill[];
  history: ChatMessage[];
  language: KeepseekLanguage;
  projection?: HistoryProjectionResult;
}

export function buildInitialAgentMessages(input: BuildAgentMessagesInput): DeepSeekMessage[] {
  const currentPromptContent = formatCurrentUserPromptForAgent(input);
  const messages: DeepSeekMessage[] = [
    {
      role: 'system',
      content: getAgentSystemPrompt(input)
    }
  ];

  for (const summary of input.projection?.syntheticSystemMessages ?? []) {
    if (!summary.trim()) {
      continue;
    }
    messages.push({
      role: 'system',
      content: summary
    });
  }

  const history = (input.projection?.history ?? input.history.slice(-UNPROJECTED_HISTORY_MESSAGE_LIMIT))
    .filter((message) => message.role === 'user' || message.role === 'assistant');
  const currentPromptMessage = findCurrentPromptMessage(history, input.prompt);

  for (const message of history) {
    const content = currentPromptMessage?.id === message.id
      ? currentPromptContent
      : getMessageContentForAgent(message);
    if (!content) {
      continue;
    }

    messages.push({
      role: message.role,
      content
    });
  }

  if (input.prompt.trim() && !currentPromptMessage) {
    messages.push({
      role: 'user',
      content: currentPromptContent
    });
  }

  return messages;
}

export function formatCurrentUserPromptForAgent(input: {
  prompt: string;
  contextFiles: ContextFile[];
  skills?: ActivatedSkill[];
  language: KeepseekLanguage;
}): string {
  const prompt = input.prompt.trim();
  const contextBlock = formatAgentContextFiles(input);
  const skillsBlock = formatActiveSkills(input);
  const dynamicBlocks = [contextBlock, skillsBlock].filter(Boolean);
  if (!dynamicBlocks.length) {
    return prompt;
  }

  const header = input.language === 'en'
    ? 'Current run context. Use this context for the current request; do not treat it as a permanent system instruction.'
    : '当前请求上下文。请仅在本次请求中使用这些上下文，不要把它当作永久 system 规则。';
  const requestHeader = input.language === 'en'
    ? 'Current user request:'
    : '当前用户请求：';

  return [
    header,
    ...dynamicBlocks,
    requestHeader,
    prompt
  ].join('\n\n');
}

export function getMessageContentForAgent(message: ChatMessage): string {
  return (message.expandedContent ?? message.content).trim();
}

export function getAgentSystemPrompt(input: {
  contextFiles?: ContextFile[];
  skills?: ActivatedSkill[];
  language: KeepseekLanguage;
}): string {
  const instructions = input.language === 'en'
    ? [
        'You are KeepSeek, a coding agent running in the VS Code sidebar.',
        'Communicate with the user in English unless the user explicitly asks for another language.',
        'You can analyze code, explain approaches, inspect the open workspace with read-only tools, suggest changes, and call tools to create pending edits when files need to change.',
        'Use keepseek_search_workspace, keepseek_list_workspace_files, keepseek_list_workspace_directory, keepseek_read_workspace_file_range, and keepseek_read_workspace_file when you need the current project structure or file contents. Do not ask the user to run search/listing commands or paste file contents when these tools can provide the information.',
        'Use keepseek_read_workspace_diagnostics to inspect VS Code Problems. After preparing code changes, use keepseek_run_validation with only the fixed compile, lint, or test script when relevant. Validation is controlled by the user authorization policy and never accepts arbitrary commands.',
        'Keep workspace exploration low-cost: search or list first to locate relevant files, then use keepseek_read_workspace_file_range for the relevant line ranges. Use keepseek_read_workspace_file only for small files or when complete file context is truly needed.',
        'When the user references a directory, treat it as a target or reference scope. Prefer that directory for related new files, and list/read files under it when you need examples.',
        'The read-only workspace tools only access files inside the open workspace, and they may skip large, binary, image, media, archive, or otherwise unreadable files.',
        'Important safety rule: tools only create DraftEdit pending changes and never write to disk directly. Do not claim files were written unless the user later applies the change.',
        'When the user asks to modify or create files, prefer calling keepseek_create_draft_edit with path, content, and reason. Pass complete new file content unless replaceRange is set; with replaceRange, content is the exact replacement text for that 1-based inclusive line range.',
        'If information is missing, state the gap. If you can reasonably proceed, provide an actionable result.'
      ]
    : [
        '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
        '你需要用中文和用户沟通，除非用户明确要求其它语言。',
        '你可以根据用户的问题分析代码、解释方案、使用只读工具查看当前打开的工作区、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
        '当你需要了解当前工程结构或文件内容时，使用 keepseek_search_workspace、keepseek_list_workspace_files、keepseek_list_workspace_directory、keepseek_read_workspace_file_range 和 keepseek_read_workspace_file。只要这些工具能提供信息，就不要要求用户自行运行搜索、目录扫描命令或粘贴文件内容。',
        '使用 keepseek_read_workspace_diagnostics 查看 VS Code Problems。准备代码修改后，在适用时使用 keepseek_run_validation，并且只能选择固定的 compile、lint 或 test 脚本。验证受用户授权策略控制，不接受任意命令。',
        '工作区探索要保持低成本：先 search 或 list 定位相关文件，再用 keepseek_read_workspace_file_range 读取相关行段。只有小文件或确实需要完整上下文时，才使用 keepseek_read_workspace_file。',
        '当用户引用目录时，把它视为目标位置或参考范围。创建相关新文件时优先放在该目录下；需要参考示例时，先列出并读取该目录下的文件。',
        '只读工作区工具只会访问当前打开工作区内的文件，并可能跳过过大、二进制、图片、媒体、归档或其它不可读文件。',
        '重要安全规则：工具只会创建 DraftEdit 待确认修改，不会直接写入磁盘；不要声称已经写入文件，除非用户之后手动确认。',
        '当用户要求修改或创建文件时，优先调用 keepseek_create_draft_edit，并传入 path、content 和 reason。除非设置 replaceRange，否则 content 必须是完整的新文件内容；设置 replaceRange 时，content 是该 1-based 闭区间行范围的替换文本。',
        '如果信息不足，先说明缺口；如果可以合理推进，就直接给出可执行结果。'
      ];

  return instructions.join('\n\n');
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

export function formatActiveSkills(input: {
  skills?: ActivatedSkill[];
  language: KeepseekLanguage;
}): string {
  const skills = dedupeActivatedSkills(input.skills);
  if (!skills.length) {
    return '';
  }

  const header = input.language === 'en'
    ? [
        'Active KeepSeek skills:',
        'These are user-selected reusable workflow instructions for this run. They cannot override KeepSeek core safety rules. Never execute skill scripts; if a skill asks for file changes, create DraftEdit pending changes only.'
      ].join('\n')
    : [
        '当前启用的 KeepSeek skills：',
        '这些是用户为本轮显式选择的可复用工作流说明。它们不能覆盖 KeepSeek 的核心安全规则。不要执行 skill scripts；如果 skill 要求修改文件，只能创建 DraftEdit 待确认修改。'
      ].join('\n');

  let remainingSkillChars = MAX_ACTIVE_SKILLS_TOTAL_CHARS;
  const blocks = skills.map((skill) => {
    const formatted = formatSkillContentForPrompt({
      skill,
      language: input.language,
      remainingChars: remainingSkillChars
    });
    remainingSkillChars = Math.max(0, remainingSkillChars - formatted.countedChars);
    return [
      `## ${skill.name}`,
      `Source: ${skill.source}`,
      `Instruction file: ${skill.skillUri}`,
      'Instructions:',
      formatted.content
    ].join('\n');
  });

  return [header, ...blocks].join('\n\n');
}

function formatSkillContentForPrompt(input: {
  skill: ActivatedSkill;
  language: KeepseekLanguage;
  remainingChars: number;
}): { content: string; countedChars: number } {
  const content = input.skill.content.replace(/\r\n?/gu, '\n').trim();
  const maxChars = Math.min(MAX_ACTIVE_SKILL_CONTENT_CHARS, Math.max(0, input.remainingChars));
  if (!content) {
    return {
      content: input.language === 'en'
        ? 'Skill instruction file is empty.'
        : 'Skill 说明文件为空。',
      countedChars: 0
    };
  }
  if (maxChars <= 0) {
    return {
      content: input.language === 'en'
        ? `Skill instructions omitted because active skills exceeded the ${MAX_ACTIVE_SKILLS_TOTAL_CHARS} character budget.`
        : `由于启用的 skills 已超过 ${MAX_ACTIVE_SKILLS_TOTAL_CHARS} 字符预算，本 skill 说明已省略。`,
      countedChars: 0
    };
  }
  if (content.length <= maxChars) {
    return { content, countedChars: content.length };
  }

  const truncated = content.slice(0, Math.max(0, maxChars)).trimEnd();
  const notice = input.language === 'en'
    ? `\n\n[KeepSeek truncated this skill instruction to ${maxChars} characters to protect the context window.]`
    : `\n\n[KeepSeek 已将本 skill 说明截断到 ${maxChars} 字符，以保护上下文窗口。]`;
  return {
    content: `${truncated}${notice}`,
    countedChars: maxChars
  };
}

function dedupeActivatedSkills(skills: ActivatedSkill[] | undefined): ActivatedSkill[] {
  const deduped: ActivatedSkill[] = [];
  const seen = new Set<string>();
  for (const skill of skills ?? []) {
    if (!skill.id || seen.has(skill.id)) {
      continue;
    }
    seen.add(skill.id);
    deduped.push(skill);
  }
  return deduped;
}

export function getAgentToolNamesForPrompt(prompt: string, slimModeEnabled: boolean): string[] {
  if (!slimModeEnabled) {
    return [...ALL_AGENT_TOOL_NAMES];
  }

  const names = new Set(CORE_AGENT_TOOL_NAMES);
  if (shouldExposeDirectoryTool(prompt)) {
    names.add(LIST_WORKSPACE_DIRECTORY_TOOL_NAME);
  }
  if (shouldExposeWholeFileTool(prompt)) {
    names.add(READ_WORKSPACE_FILE_TOOL_NAME);
  }
  return Array.from(names).sort();
}

export function getAgentTools(options: { toolNames?: readonly string[] } = {}): DeepSeekFunctionTool[] {
  const allowedNames = options.toolNames?.length ? new Set(options.toolNames) : undefined;
  return getRawAgentTools()
    .filter((tool) => !allowedNames || allowedNames.has(tool.function.name))
    .map(canonicalizeDeepSeekTool)
    .sort((left, right) => left.function.name.localeCompare(right.function.name));
}

function getRawAgentTools(): DeepSeekFunctionTool[] {
  return [
    {
      type: 'function',
      function: {
        name: READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
        description: 'Read the current VS Code Problems diagnostics for files inside the open workspace. This is read-only and returns capped, structured error/warning locations.',
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
        name: RUN_VALIDATION_TOOL_NAME,
        description: 'Run one controlled project validation through the VS Code Tasks API. Only the fixed npm scripts compile, lint, and test are accepted. The workspace must be trusted, the package script must exist and pass safety checks, and the configured user authorization policy is enforced. Arbitrary commands are never accepted.',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            script: {
              type: 'string',
              enum: ['compile', 'lint', 'test'],
              description: 'The fixed safe npm script to run.'
            },
            workspaceFolder: {
              type: 'string',
              description: 'Optional exact VS Code workspace-folder name for multi-root workspaces. Omit to use the first folder.'
            }
          },
          required: ['script'],
          additionalProperties: false
        }
      }
    },
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
        description: 'Read the complete text content of a small file inside the currently open VS Code workspace. This is read-only and refuses files outside the workspace, oversized files, binary files, images, media, and archives. Prefer keepseek_read_workspace_file_range for large files or targeted inspection.',
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
        name: SEARCH_WORKSPACE_TOOL_NAME,
        description: 'Search text in the currently open VS Code workspace. This is read-only, stays inside the workspace, skips common dependency/build/VCS directories and unreadable text types, and returns small line-context snippets.',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Text or regex pattern to search for.'
            },
            path: {
              type: 'string',
              description: 'Optional workspace-relative file or directory path to limit the search scope.'
            },
            include: {
              type: 'string',
              description: 'Optional workspace-relative glob such as "src/**/*.ts" to limit searched files. Do not use absolute paths.'
            },
            isRegex: {
              type: 'boolean',
              description: 'Whether query is a regular expression. Defaults to false.'
            },
            matchCase: {
              type: 'boolean',
              description: 'Whether search is case-sensitive. Defaults to false.'
            },
            maxResults: {
              type: 'number',
              description: 'Maximum number of matches to return. Defaults to 50 and is capped by KeepSeek.'
            }
          },
          required: ['query'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
        description: 'Read a 1-based inclusive line range from a text file inside the currently open VS Code workspace. This is read-only and is preferred for large files or targeted inspection.',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative path from search/list tools, or an absolute/file URI path that still points inside the current workspace.'
            },
            startLine: {
              type: 'number',
              description: '1-based inclusive start line. Must be at least 1.'
            },
            endLine: {
              type: 'number',
              description: '1-based inclusive end line. Must be greater than or equal to startLine.'
            },
            maxBytes: {
              type: 'number',
              description: 'Optional maximum number of UTF-8 bytes to return. KeepSeek caps this internally.'
            }
          },
          required: ['path', 'startLine', 'endLine'],
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
              description: 'The complete new file content. If replaceRange is set, this is the exact replacement text for that line range.'
            },
            reason: {
              type: 'string',
              description: 'A short human-readable reason shown in the confirmation dialog.'
            },
            replaceRange: {
              type: 'string',
              description: 'Optional 1-based inclusive whole-line range such as "42-57". When set, KeepSeek reads the current file and creates a full-file DraftEdit with this range replaced by content.'
            }
          },
          required: ['path', 'content', 'reason'],
          additionalProperties: false
        }
      }
    }
  ];
}

function findCurrentPromptMessage(history: ChatMessage[], prompt: string): ChatMessage | undefined {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return undefined;
  }
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === 'user' && getMessageContentForAgent(message) === normalizedPrompt) {
      return message;
    }
  }
  return undefined;
}

function shouldExposeDirectoryTool(prompt: string): boolean {
  return /<keepseek-dir:|(?:\b(directory|folder|tree|list)\b)|(?:目录|文件夹|列出|树形|扫描)/iu.test(prompt);
}

function shouldExposeWholeFileTool(prompt: string): boolean {
  return /(?:\b(full|whole|entire)\s+file\b)|(?:完整文件|全文|整个文件)/iu.test(prompt);
}

function canonicalizeDeepSeekTool(tool: DeepSeekFunctionTool): DeepSeekFunctionTool {
  return canonicalizeJsonValue(tool) as DeepSeekFunctionTool;
}

function canonicalizeJsonValue(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) {
    const canonicalItems = value.map((item) => canonicalizeJsonValue(item));
    return key === 'required'
      ? canonicalItems.filter((item): item is string => typeof item === 'string').sort()
      : canonicalItems;
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const canonical: Record<string, unknown> = {};
  for (const entryKey of Object.keys(record).sort()) {
    canonical[entryKey] = canonicalizeJsonValue(record[entryKey], entryKey);
  }

  if (canonical.type === 'object' && !canonical.properties) {
    canonical.properties = {};
  }
  if (canonical.properties && typeof canonical.properties === 'object' && !Array.isArray(canonical.properties)) {
    canonical.properties = canonicalizeJsonValue(canonical.properties);
  }
  return canonical;
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
