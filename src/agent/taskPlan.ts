import { randomUUID } from 'node:crypto';
import type { KeepseekLanguage } from '../shared/i18n';
import type { TaskPlan, TaskPlanStep, TaskPlanStepStatus } from '../shared/types';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME
} from './protocol';

type TaskPlanListener = (plan: TaskPlan) => void;
type TaskPlanTraceRecorder = (event: { type: string; [key: string]: unknown }) => void;

type PlanStepKind = 'inspect' | 'edit' | 'validate';

export class TaskPlanTracker {
  private readonly plan: TaskPlan;
  private readonly blockerByStep = new Map<string, string>();

  public constructor(input: {
    runId: string;
    sessionId?: string;
    prompt: string;
    language: KeepseekLanguage;
    onChange?: TaskPlanListener;
    recordTrace?: TaskPlanTraceRecorder;
  }) {
    this.language = input.language;
    this.onChange = input.onChange;
    this.recordTrace = input.recordTrace;
    const now = new Date().toISOString();
    this.plan = {
      id: randomUUID(),
      runId: input.runId,
      sessionId: input.sessionId,
      goal: createGoal(input.prompt, input.language),
      status: 'running',
      steps: [
        createStep('understand', input.language === 'en' ? 'Understand the request' : '理解任务目标', 'in_progress', now),
        createStep('respond', input.language === 'en' ? 'Summarize the result' : '整理并汇报结果', 'pending', now)
      ],
      currentStepId: 'understand',
      blockers: [],
      createdAt: now,
      updatedAt: now
    };
    this.emit('created');
  }

  private readonly language: KeepseekLanguage;
  private readonly onChange?: TaskPlanListener;
  private readonly recordTrace?: TaskPlanTraceRecorder;

  public beginExecution(): void {
    this.setStepStatus('understand', 'completed');
    this.activateStep('respond');
  }

  public startTool(toolName: string): void {
    const kind = getToolStepKind(toolName);
    if (!kind) {
      return;
    }
    const step = this.ensureToolStep(kind);
    this.activateStep(step.id, getToolDetail(toolName, this.language));
  }

  public finishTool(toolName: string, rawResult: string): void {
    const kind = getToolStepKind(toolName);
    if (!kind) {
      return;
    }
    const step = this.ensureToolStep(kind);
    const error = readToolError(rawResult);
    if (error) {
      this.setStepStatus(step.id, 'blocked', error);
      const previousBlocker = this.blockerByStep.get(step.id);
      if (previousBlocker && previousBlocker !== error) {
        this.plan.blockers = this.plan.blockers.filter((blocker) => blocker !== previousBlocker);
      }
      this.blockerByStep.set(step.id, error);
      if (!this.plan.blockers.includes(error)) {
        this.plan.blockers.push(error);
      }
      this.plan.status = 'blocked';
    } else {
      const resolvedBlocker = this.blockerByStep.get(step.id);
      if (resolvedBlocker) {
        this.plan.blockers = this.plan.blockers.filter((blocker) => blocker !== resolvedBlocker);
        this.blockerByStep.delete(step.id);
      }
      this.setStepStatus(step.id, 'completed');
      this.plan.status = 'running';
    }
    this.activateStep('respond');
  }

  public complete(summary: string, blocked = false): TaskPlan {
    this.completeInProgressSteps();
    const responseStep = this.getStep('respond');
    if (responseStep) {
      responseStep.status = blocked ? 'blocked' : 'completed';
      responseStep.detail = blocked ? this.plan.blockers[0] : undefined;
      responseStep.updatedAt = new Date().toISOString();
    }
    this.plan.currentStepId = undefined;
    this.plan.status = blocked || this.plan.blockers.length ? 'blocked' : 'completed';
    this.plan.completionSummary = compactText(summary, 320);
    this.touchAndEmit('completed');
    return this.getPlan();
  }

  public addBlocker(reason: string): void {
    const message = compactText(reason, 240);
    if (!message || this.plan.blockers.includes(message)) {
      return;
    }
    this.plan.blockers.push(message);
    this.plan.status = 'blocked';
    this.touchAndEmit('blocker_added');
  }

  public fail(error: string): TaskPlan {
    const message = compactText(error, 240);
    const current = this.plan.currentStepId ? this.getStep(this.plan.currentStepId) : undefined;
    if (current) {
      current.status = 'failed';
      current.detail = message;
      current.updatedAt = new Date().toISOString();
    }
    if (message && !this.plan.blockers.includes(message)) {
      this.plan.blockers.push(message);
    }
    this.plan.status = 'failed';
    this.plan.currentStepId = undefined;
    this.touchAndEmit('failed');
    return this.getPlan();
  }

  public stop(summary?: string): TaskPlan {
    const current = this.plan.currentStepId ? this.getStep(this.plan.currentStepId) : undefined;
    if (current?.status === 'in_progress') {
      current.status = 'skipped';
      current.updatedAt = new Date().toISOString();
    }
    this.plan.status = 'stopped';
    this.plan.currentStepId = undefined;
    this.plan.completionSummary = compactText(summary ?? '', 320) || undefined;
    this.touchAndEmit('stopped');
    return this.getPlan();
  }

  public getPlan(): TaskPlan {
    return {
      ...this.plan,
      steps: this.plan.steps.map((step) => ({ ...step })),
      blockers: [...this.plan.blockers]
    };
  }

  private ensureToolStep(kind: PlanStepKind): TaskPlanStep {
    const existing = this.getStep(kind);
    if (existing) {
      return existing;
    }
    const now = new Date().toISOString();
    const step = createStep(kind, getStepTitle(kind, this.language), 'pending', now);
    const responseIndex = this.plan.steps.findIndex((item) => item.id === 'respond');
    this.plan.steps.splice(responseIndex < 0 ? this.plan.steps.length : responseIndex, 0, step);
    this.touchAndEmit('step_added');
    return step;
  }

  private activateStep(id: string, detail?: string): void {
    for (const step of this.plan.steps) {
      if (step.id !== id && step.status === 'in_progress') {
        step.status = 'pending';
        step.updatedAt = new Date().toISOString();
      }
    }
    this.setStepStatus(id, 'in_progress', detail);
    this.plan.currentStepId = id;
    this.plan.status = 'running';
    this.touchAndEmit('step_started');
  }

  private setStepStatus(id: string, status: TaskPlanStepStatus, detail?: string): void {
    const step = this.getStep(id);
    if (!step) {
      return;
    }
    step.status = status;
    step.detail = detail;
    step.updatedAt = new Date().toISOString();
  }

  private completeInProgressSteps(): void {
    for (const step of this.plan.steps) {
      if (step.status === 'in_progress') {
        step.status = 'completed';
        step.updatedAt = new Date().toISOString();
      }
    }
  }

  private getStep(id: string): TaskPlanStep | undefined {
    return this.plan.steps.find((step) => step.id === id);
  }

  private touchAndEmit(reason: string): void {
    this.plan.updatedAt = new Date().toISOString();
    this.emit(reason);
  }

  private emit(reason: string): void {
    const snapshot = this.getPlan();
    this.onChange?.(snapshot);
    this.recordTrace?.({
      type: 'task_plan_update',
      reason,
      plan: snapshot
    });
  }
}

function createStep(id: string, title: string, status: TaskPlanStepStatus, updatedAt: string): TaskPlanStep {
  return { id, title, status, updatedAt };
}

function createGoal(prompt: string, language: KeepseekLanguage): string {
  const goal = compactText(prompt.split(/\r?\n/u).find((line) => line.trim()) ?? prompt, 180);
  return goal || (language === 'en' ? 'Complete the current request' : '完成当前请求');
}

function getToolStepKind(toolName: string): PlanStepKind | undefined {
  switch (toolName) {
    case LIST_WORKSPACE_FILES_TOOL_NAME:
    case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
    case SEARCH_WORKSPACE_TOOL_NAME:
    case READ_WORKSPACE_FILE_RANGE_TOOL_NAME:
    case READ_WORKSPACE_FILE_TOOL_NAME:
    case READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME:
      return 'inspect';
    case CREATE_DRAFT_EDIT_TOOL_NAME:
      return 'edit';
    case RUN_VALIDATION_TOOL_NAME:
      return 'validate';
    default:
      return undefined;
  }
}

function getStepTitle(kind: PlanStepKind, language: KeepseekLanguage): string {
  if (language === 'en') {
    return kind === 'inspect'
      ? 'Inspect workspace context'
      : kind === 'edit'
        ? 'Prepare safe file changes'
        : 'Run controlled validation';
  }
  return kind === 'inspect'
    ? '检查工作区上下文'
    : kind === 'edit'
      ? '准备安全文件修改'
      : '执行受控验证';
}

function getToolDetail(toolName: string, language: KeepseekLanguage): string {
  const labels: Record<string, [string, string]> = {
    [LIST_WORKSPACE_FILES_TOOL_NAME]: ['Listing workspace files', '列出工作区文件'],
    [LIST_WORKSPACE_DIRECTORY_TOOL_NAME]: ['Listing a workspace directory', '列出工作区目录'],
    [SEARCH_WORKSPACE_TOOL_NAME]: ['Searching the workspace', '搜索工作区'],
    [READ_WORKSPACE_FILE_RANGE_TOOL_NAME]: ['Reading a file range', '读取文件行段'],
    [READ_WORKSPACE_FILE_TOOL_NAME]: ['Reading a file', '读取文件'],
    [READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME]: ['Reading Problems diagnostics', '读取 Problems 诊断'],
    [CREATE_DRAFT_EDIT_TOOL_NAME]: ['Creating a pending edit', '创建待确认修改'],
    [RUN_VALIDATION_TOOL_NAME]: ['Running an approved project script', '运行已授权的项目脚本']
  };
  const label = labels[toolName];
  return label ? label[language === 'en' ? 0 : 1] : toolName;
}

function readToolError(rawResult: string): string | undefined {
  try {
    const result: unknown = JSON.parse(rawResult);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      return undefined;
    }
    const record = result as Record<string, unknown>;
    if (record.ok !== false) {
      return undefined;
    }
    return compactText(typeof record.error === 'string' ? record.error : 'Tool execution failed.', 240);
  } catch {
    return undefined;
  }
}

function compactText(value: string, maxLength: number): string {
  const compacted = String(value || '').replace(/\s+/gu, ' ').trim();
  return compacted.length <= maxLength
    ? compacted
    : `${compacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
