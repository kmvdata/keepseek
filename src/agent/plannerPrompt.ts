import type { KeepseekLanguage } from '../shared/i18n';
import type { ChatMessage } from '../shared/types';

export const PLANNER_SYSTEM_PROMPT = [
  'You are KeepSeek Planner, an independent planning model for a coding agent.',
  'You may investigate the open workspace with the provided read-only tools, but you must never modify, create, delete, validate, or otherwise write any file.',
  'Produce a bounded Markdown implementation plan with these sections: Goal, Ordered steps, Verification, Risks and rollback, and Explicit non-goals.',
  'Ground the plan in inspected workspace evidence when tools are useful. Clearly mark unknowns instead of inventing facts.',
  'End the final response with exactly [plan] when implementation work is proposed, or [no_changes] when no file changes are needed.'
].join('\n\n');

export function buildPlannerTaskPrompt(prompt: string, language: KeepseekLanguage): string {
  const instruction = language === 'en'
    ? 'Plan this request only. Use read-only research when needed, follow the required Markdown structure, and include the exact final marker.'
    : '仅为以下请求制定计划。必要时使用只读工具调研，按规定的 Markdown 结构输出，并包含准确的末行标记。';
  return `${prompt.trim()}\n\n${instruction}`;
}

export function buildExecutorPlannerTail(plan: string, language: KeepseekLanguage): string {
  const title = language === 'en'
    ? '# Implementation plan from the planning model (reference before execution)'
    : '# 规划模型给出的实施计划（执行前参考）';
  return `${title}\n\n${plan.trim()}`;
}

export function appendPlannerPlanToExecutorTurn(input: {
  prompt: string;
  history: ChatMessage[];
  plan: string;
  language: KeepseekLanguage;
}): { prompt: string; history: ChatMessage[] } {
  const prompt = `${input.prompt.trim()}\n\n${buildExecutorPlannerTail(input.plan, input.language)}`;
  const normalizedPrompt = input.prompt.trim();
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const message = input.history[index];
    if (
      message.role !== 'user'
      || (message.expandedContent ?? message.content).trim() !== normalizedPrompt
    ) {
      continue;
    }
    const projectedMessage = message.expandedContent === undefined
      ? { ...message, content: prompt }
      : { ...message, expandedContent: prompt };
    return {
      prompt,
      history: [
        ...input.history.slice(0, index),
        projectedMessage,
        ...input.history.slice(index + 1)
      ]
    };
  }
  return { prompt, history: input.history };
}
