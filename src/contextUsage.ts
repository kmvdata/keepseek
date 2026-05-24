import { AGENT_HISTORY_MESSAGE_LIMIT, getConfiguredContextWindowTokens } from './config';
import { formatBytes } from './format';
import type { KeepseekLanguage } from './i18n';
import { estimateTokenCount } from './tokenEstimate';
import { ChatMessage, ContextFile, ContextUsageEstimate, KeepseekModel } from './types';

export function createContextUsageEstimate(input: {
  model: KeepseekModel;
  contextFiles: ContextFile[];
  messages: ChatMessage[];
  language: KeepseekLanguage;
}): ContextUsageEstimate {
  const maxTokensEstimate = getConfiguredContextWindowTokens(input.model);
  const systemTokensEstimate = estimateChatMessageTokens('system', getSystemPromptEstimateText(input.language));
  const contextFileTokensEstimate = estimateContextFileTokens(input.contextFiles, input.language);
  const historyTokensEstimate = input.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-AGENT_HISTORY_MESSAGE_LIMIT)
    .reduce((total, message) => {
      const content = getMessageContentForUsage(message);
      return content ? total + estimateChatMessageTokens(message.role, content) : total;
    }, 0);
  return normalizeContextUsageEstimate({
    maxTokensEstimate,
    systemTokensEstimate,
    contextFileTokensEstimate,
    historyTokensEstimate,
    inputTokensEstimate: 0
  });
}

function normalizeContextUsageEstimate(input: {
  maxTokensEstimate: number;
  systemTokensEstimate: number;
  contextFileTokensEstimate: number;
  historyTokensEstimate: number;
  inputTokensEstimate: number;
}): ContextUsageEstimate {
  const maxTokensEstimate = Math.max(1, Math.floor(input.maxTokensEstimate));
  const systemTokensEstimate = Math.max(0, Math.floor(input.systemTokensEstimate));
  const contextFileTokensEstimate = Math.max(0, Math.floor(input.contextFileTokensEstimate));
  const historyTokensEstimate = Math.max(0, Math.floor(input.historyTokensEstimate));
  const inputTokensEstimate = Math.max(0, Math.floor(input.inputTokensEstimate));
  const usedTokensEstimate = systemTokensEstimate + contextFileTokensEstimate + historyTokensEstimate + inputTokensEstimate;
  const remainingTokensEstimate = Math.max(0, maxTokensEstimate - usedTokensEstimate);
  const usedPercent = Math.min(100, (usedTokensEstimate / maxTokensEstimate) * 100);

  return {
    usedTokensEstimate,
    maxTokensEstimate,
    remainingTokensEstimate,
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    breakdown: {
      systemTokensEstimate,
      contextFileTokensEstimate,
      historyTokensEstimate,
      inputTokensEstimate
    }
  };
}

function estimateContextFileTokens(contextFiles: ContextFile[], language: KeepseekLanguage): number {
  if (!contextFiles.length) {
    return 0;
  }

  const intro = language === 'en'
    ? 'These are the context files the user added to KeepSeek. Prefer using them when answering:'
    : '以下是用户加入 KeepSeek 的上下文文件。回答时优先参考这些内容：';
  let total = estimateTokenCount(intro);

  for (const file of contextFiles) {
    total += estimateTokenCount([
      language === 'en' ? 'Context file:' : '上下文文件：',
      file.label,
      file.languageId,
      formatBytes(file.sizeBytes),
      'Path:',
      file.fsPath,
      file.content
    ].join('\n')) + 8;
  }

  return total;
}

function estimateChatMessageTokens(role: ChatMessage['role'], content: string): number {
  return estimateTokenCount(`${role}\n${content}`) + 4;
}

function getMessageContentForUsage(message: ChatMessage): string {
  const content = (message.expandedContent ?? message.content).trim();
  if (message.role !== 'assistant' || !message.isStreaming) {
    return content;
  }

  const reasoningContent = (message.reasoningContent ?? '').trim();
  return [reasoningContent, content].filter(Boolean).join('\n');
}

function getSystemPromptEstimateText(language: KeepseekLanguage): string {
  return language === 'en'
    ? [
        'You are KeepSeek, a coding agent running in the VS Code sidebar.',
        'Communicate with the user in English unless the user explicitly asks for another language.',
        'You can analyze code, explain approaches, suggest changes, and call tools to create pending edits when files need to change.',
        'Important safety rule: tools only create DraftEdit pending changes and never write to disk directly. Do not claim files were written unless the user later applies the change.',
        'When the user asks to modify or create files, prefer calling keepseek_create_draft_edit with the target path, complete new file content, and a short reason.',
        'If information is missing, state the gap. If you can reasonably proceed, provide an actionable result.'
      ].join('\n')
    : [
        '你是 KeepSeek，一个运行在 VS Code 侧边栏里的代码 Agent。',
        '你需要用中文和用户沟通，除非用户明确要求其它语言。',
        '你可以根据用户的问题分析代码、解释方案、给出修改建议，并在需要改文件时调用工具创建待确认修改。',
        '重要安全规则：工具只会创建 DraftEdit 待确认修改，不会直接写入磁盘；不要声称已经写入文件，除非用户之后手动确认。',
        '当用户要求修改或创建文件时，优先调用 keepseek_create_draft_edit，并传入目标路径、完整的新文件内容和简短原因。',
        '如果信息不足，先说明缺口；如果可以合理推进，就直接给出可执行结果。'
      ].join('\n');
}
