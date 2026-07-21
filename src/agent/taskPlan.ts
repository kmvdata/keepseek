import { randomUUID } from 'node:crypto';
import type { KeepseekLanguage } from '../shared/i18n';
import type { TaskPlan, TaskPlanStep, TaskPlanStepStatus } from '../shared/types';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
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

  public beginRepair(iteration: number, maxIterations: number, detail?: string): void {
    this.ensureRepairSteps();
    const validation = this.getStep('repair_validate');
    if (validation) {
      validation.status = 'failed';
      validation.detail = detail;
      validation.updatedAt = new Date().toISOString();
    }
    this.activateStep('repair_read_problems', this.language === 'en'
      ? `Repair ${iteration}/${maxIterations}: read current Problems`
      : `修复 ${iteration}/${maxIterations}：读取当前 Problems`);
  }

  public markProblemsRead(): void {
    if (!this.getStep('repair_read_problems')) {
      return;
    }
    this.setStepStatus('repair_read_problems', 'completed');
    this.activateStep('repair_generate');
  }

  public markGeneratingRepair(): void {
    this.ensureRepairSteps();
    this.activateStep('repair_generate');
  }

  public markWaitingForApply(detail: string): void {
    this.ensureRepairSteps();
    this.setStepStatus('repair_generate', 'completed');
    this.setStepStatus('repair_wait_apply', 'blocked', detail);
    this.setStepStatus('repair_validate', 'pending');
    this.plan.currentStepId = 'repair_wait_apply';
    this.plan.status = 'blocked';
    const previous = this.blockerByStep.get('repair_wait_apply');
    if (previous) {
      this.plan.blockers = this.plan.blockers.filter((blocker) => blocker !== previous);
    }
    this.blockerByStep.set('repair_wait_apply', detail);
    if (!this.plan.blockers.includes(detail)) {
      this.plan.blockers.push(detail);
    }
    this.touchAndEmit('repair_waiting_for_apply');
  }

  public markRepairLimitReached(detail: string): void {
    this.ensureRepairSteps();
    this.setStepStatus('repair_generate', 'blocked', detail);
    this.addBlocker(detail);
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

  private ensureRepairSteps(): void {
    const now = new Date().toISOString();
    const definitions: Array<[string, string, string]> = this.language === 'en'
      ? [
          ['repair_read_problems', 'Read Problems', 'Inspect diagnostics after validation failure'],
          ['repair_generate', 'Generate repair', 'Prepare a safe ChangeSet repair'],
          ['repair_wait_apply', 'Wait for ChangeSet apply', 'Validation must pause until the user applies the repair'],
          ['repair_validate', 'Run validation again', 'Validate the applied repair in a later run']
        ]
      : [
          ['repair_read_problems', '读取 Problems', '验证失败后检查诊断信息'],
          ['repair_generate', '生成修复', '通过安全 ChangeSet 准备修复'],
          ['repair_wait_apply', '等待用户应用 ChangeSet', '用户应用修复前必须暂停验证'],
          ['repair_validate', '再次运行验证', '在后续运行中验证已应用的修复']
        ];
    const responseIndex = this.plan.steps.findIndex((item) => item.id === 'respond');
    let insertAt = responseIndex < 0 ? this.plan.steps.length : responseIndex;
    for (const [id, title, detail] of definitions) {
      if (this.getStep(id)) {
        continue;
      }
      const step = createStep(id, title, 'pending', now);
      step.detail = detail;
      this.plan.steps.splice(insertAt, 0, step);
      insertAt += 1;
    }
    this.touchAndEmit('repair_steps_added');
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

export function markTaskPlanReadyForValidation(plan: TaskPlan, language: KeepseekLanguage): TaskPlan {
  const snapshot: TaskPlan = {
    ...plan,
    steps: plan.steps.map((step) => ({ ...step })),
    blockers: [...plan.blockers]
  };
  const waiting = snapshot.steps.find((step) => step.id === 'repair_wait_apply');
  const validation = snapshot.steps.find((step) => step.id === 'repair_validate');
  const now = new Date().toISOString();
  if (waiting) {
    const previousDetail = waiting.detail;
    waiting.status = 'completed';
    waiting.detail = language === 'en' ? 'Repair ChangeSet applied by the user' : '用户已应用修复 ChangeSet';
    waiting.updatedAt = now;
    if (previousDetail) {
      snapshot.blockers = snapshot.blockers.filter((blocker) => blocker !== previousDetail);
    }
  }
  if (validation) {
    validation.status = 'in_progress';
    validation.detail = language === 'en'
      ? 'Ready to continue controlled validation'
      : '已可继续执行受控验证';
    validation.updatedAt = now;
    snapshot.currentStepId = validation.id;
  }
  snapshot.status = 'running';
  snapshot.updatedAt = now;
  return snapshot;
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
    case FIND_SYMBOL_TOOL_NAME:
    case FIND_REFERENCES_TOOL_NAME:
    case GET_DOCUMENT_SYMBOLS_TOOL_NAME:
    case GET_WORKSPACE_SYMBOLS_TOOL_NAME:
    case GIT_STATUS_TOOL_NAME:
    case GIT_DIFF_TOOL_NAME:
    case GIT_CURRENT_BRANCH_TOOL_NAME:
    case GIT_CREATE_PATCH_TOOL_NAME:
    case GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME:
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
    [FIND_SYMBOL_TOOL_NAME]: ['Finding semantic symbols', '查找语义 symbol'],
    [FIND_REFERENCES_TOOL_NAME]: ['Finding semantic references', '查找语义引用'],
    [GET_DOCUMENT_SYMBOLS_TOOL_NAME]: ['Reading document symbols', '读取文档 symbols'],
    [GET_WORKSPACE_SYMBOLS_TOOL_NAME]: ['Reading workspace symbols', '读取工作区 symbols'],
    [GIT_STATUS_TOOL_NAME]: ['Reading Git status', '读取 Git 状态'],
    [GIT_DIFF_TOOL_NAME]: ['Reading Git diff', '读取 Git diff'],
    [GIT_CURRENT_BRANCH_TOOL_NAME]: ['Reading current Git branch', '读取当前 Git 分支'],
    [GIT_CREATE_PATCH_TOOL_NAME]: ['Generating patch content', '生成补丁内容'],
    [GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME]: ['Preparing commit message suggestions', '准备提交信息建议'],
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
