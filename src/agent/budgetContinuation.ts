import { createHash } from 'node:crypto';
import type { AgentResponse, ApprovalMode, RepairLoopState } from '../shared/types';
import type { KeepseekLanguage } from '../shared/i18n';
import { canContinueBudgetInNewTurn, type RunCheckpoint } from './runCheckpoint';

export interface BudgetContinuationProgress {
  turns: number;
  workHash: string;
}

/** A host-scheduled new turn, never recovery or a reset of checkpoint budgets.
 * Only completed foreground work qualifies; approval processing has its own queue. */
export function nextBudgetContinuation(
  checkpoint: RunCheckpoint | undefined,
  response: AgentResponse,
  maxTurns: number,
  previous?: BudgetContinuationProgress
): BudgetContinuationProgress | undefined {
  if (!checkpoint || !canContinueBudgetInNewTurn(checkpoint)
    || !['tool_iterations_exhausted', 'tool_call_limit_exhausted'].includes(response.runDetails.budgetStopReason ?? '')
    || (previous?.turns ?? 0) >= maxTurns
    || response.draftEdits.length || response.draftRuns?.length || response.changeSet
    || response.approvalContinuationRequired || response.approvalContinuationStopReason
    || !canContinueRepairLoop(response.repairLoop)
    || !response.runDetails.toolCalls.some((call) => call.status === 'succeeded')
    || response.runDetails.toolCalls.some((call) => call.status === 'denied')) return undefined;

  // Ignore request IDs and display text: a new ID is not evidence of new work.
  const work = response.toolRounds?.flatMap((round) => round.toolCalls.map((call) => ({
    name: call.function.name, arguments: call.function.arguments,
    result: round.toolResults.find((result) => result.toolCallId === call.id)?.content
  })));
  if (!work?.length) return undefined;
  const workHash = createHash('sha256').update(JSON.stringify(work)).digest('hex');
  if (previous?.workHash === workHash) return undefined;
  return { turns: (previous?.turns ?? 0) + 1, workHash };
}

export function canContinueRepairLoop(repairLoop?: RepairLoopState): boolean {
  return !repairLoop || repairLoop.status === 'idle' || repairLoop.status === 'completed';
}

/** Persist the literal prompt as a new user message; no historical prefix edits. */
export function getBudgetContinuationPrompt(language: KeepseekLanguage, mode: ApprovalMode, automatic = false): string {
  const prompt = language === 'en'
    ? `${automatic ? 'The host is automatically starting a new turn after the previous tool budget was reached. ' : ''}Continue only the unfinished work from the previous turn. If the original task is already complete, report the result and stop. Reuse recorded progress, read only the specific files or directories still needed, and avoid listing the entire workspace again or repeating completed operations. `
    : `${automatic ? '上一轮工具预算已用尽，宿主正在自动开启新一轮。' : ''}请只继续上一轮尚未完成的工作；如果原任务已经完成，直接报告结果并结束。沿用已有进度，只读取仍需核实的具体文件或目录，避免重复列出整个工作区或重复已完成的操作。`;
  return prompt + (mode === 'ask'
    ? language === 'en' ? 'Pending edits and commands still require my separate approval.' : '待确认修改和命令仍需我另行批准。'
    : language === 'en' ? 'Keep the current approval mode. Propose edits and commands through the existing approval pipeline; claim effects only after their actual results arrive.'
      : '保持当前审批模式，修改和命令仍须通过现有审批管线；仅在收到真实结果后声明已完成。');
}
