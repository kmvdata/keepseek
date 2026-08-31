import type { RepairLoopState, SafeNpmScript } from '../shared/types';
import type { KeepseekLanguage } from '../shared/i18n';

export type ValidationWorkspaceScope = 'workspace_baseline' | 'post_apply';
export type ValidationOutcome = 'passed' | 'failed';

export interface RunValidationState {
  pendingDraftEditIds: string[];
  validations: Array<{
    scope: ValidationWorkspaceScope;
    outcome: ValidationOutcome;
  }>;
}

/**
 * Run-local hard guard for the on-disk validation boundary. RepairLoopTracker
 * owns automatic repair iterations; this tracker covers every successful
 * DraftEdit, including ordinary changes that are not part of a repair loop.
 */
export class RunValidationStateTracker {
  private readonly pendingDraftEditIds = new Set<string>();
  private readonly validations: RunValidationState['validations'] = [];

  public constructor(
    private readonly scope: ValidationWorkspaceScope,
    initialPendingDraftEditIds: readonly string[] = [],
    initialValidations: RunValidationState['validations'] = []
  ) {
    this.validations.push(...structuredClone(initialValidations));
    for (const id of initialPendingDraftEditIds) {
      if (id) {
        this.pendingDraftEditIds.add(id);
      }
    }
  }

  public recordDraftEdit(editId: string): void {
    if (editId) {
      this.pendingDraftEditIds.add(editId);
    }
  }

  public hasPendingDraftEdit(): boolean {
    return this.pendingDraftEditIds.size > 0;
  }

  public createBlockedValidationResult(language: KeepseekLanguage): string {
    return JSON.stringify({
      ok: false,
      errorType: 'pending_changes_require_apply',
      summary: language === 'en'
        ? 'Validation is blocked until pending changes are applied.'
        : '待确认修改应用前，验证已被阻止。',
      pendingDraftEditIds: [...this.pendingDraftEditIds],
      suggestedAction: 'apply_pending_changes',
      error: language === 'en'
        ? 'Validation checks only the current on-disk workspace. Apply the pending ChangeSet before validating the updated files.'
        : '验证只能检查当前已落盘的工作区。请先应用待确认 ChangeSet，再验证更新后的文件。'
    });
  }

  public recordValidationResult(rawResult: string): void {
    const result = parseRecord(rawResult);
    if (!result) {
      return;
    }
    this.validations.push({
      scope: this.scope,
      outcome: result.ok === true ? 'passed' : 'failed'
    });
  }

  public decorateFinalMessage(message: string, language: KeepseekLanguage): string {
    const text = this.pendingDraftEditIds.size > 0
      ? removeUnsupportedValidationClaims(message, language)
      : message.trim();
    const notice = this.getFinalStatusNotice(language);
    if (!notice || text.includes(notice)) {
      return text;
    }
    return [text, notice].filter(Boolean).join('\n\n');
  }

  public getState(): RunValidationState {
    return {
      pendingDraftEditIds: [...this.pendingDraftEditIds],
      validations: this.validations.map((validation) => ({ ...validation }))
    };
  }

  private getFinalStatusNotice(language: KeepseekLanguage): string | undefined {
    const lastValidation = this.validations.at(-1);
    if (this.pendingDraftEditIds.size > 0) {
      if (!lastValidation) {
        return language === 'en'
          ? 'Change status: pending DraftEdits were prepared; they are not written or validated. Apply the ChangeSet before validating the updated workspace.'
          : '修改状态：已准备待确认 DraftEdit，但尚未写盘或验证。请先应用 ChangeSet，再验证更新后的工作区。';
      }
      if (lastValidation.scope === 'post_apply') {
        return language === 'en'
          ? `Validation status: post-Apply validation ${lastValidation.outcome}, and the newly prepared repair DraftEdits remain unapplied and unvalidated.`
          : `验证状态：Apply 后验证${lastValidation.outcome === 'passed' ? '通过' : '失败'}；新准备的修复 DraftEdit 仍未应用、未验证。`;
      }
      return language === 'en'
        ? `Validation status: the ${lastValidation.outcome} validation covered only the pre-change workspace baseline; the pending DraftEdits are unapplied and unvalidated.`
        : `验证状态：${lastValidation.outcome === 'passed' ? '通过' : '失败'}的验证只覆盖修改前的工作区基线；待确认 DraftEdit 尚未应用、也未验证。`;
    }
    if (!lastValidation) {
      return undefined;
    }
    if (lastValidation.scope === 'post_apply') {
      return language === 'en'
        ? `Validation status: post-Apply validation ${lastValidation.outcome} on the updated on-disk workspace.`
        : `验证状态：对更新后已落盘工作区的 Apply 后验证${lastValidation.outcome === 'passed' ? '通过' : '失败'}。`;
    }
    return language === 'en'
      ? `Validation status: validation ${lastValidation.outcome} on the current on-disk workspace.`
      : `验证状态：对当前已落盘工作区的验证${lastValidation.outcome === 'passed' ? '通过' : '失败'}。`;
  }
}

function removeUnsupportedValidationClaims(message: string, language: KeepseekLanguage): string {
  const qualificationPattern = language === 'en'
    ? /(?:baseline|pre-change|before (?:the )?(?:draft|change)|pending.{0,40}(?:not|un)validated|not.{0,20}validated)/iu
    : /(?:基线|修改前|创建 DraftEdit 前|待确认.{0,20}(?:未验证|尚未验证)|没有验证|未验证)/u;
  const validationClaimPattern = language === 'en'
    ? /(?:(?:validation|tests?|compile|lint|build|checks?).{0,80}(?:pass(?:ed|es)?|fail(?:ed|s)?|succeed(?:ed)?|successful|green|clean)|(?:pass(?:ed|es)?|fail(?:ed|s)?|succeed(?:ed)?|successful|green|clean).{0,80}(?:validation|tests?|compile|lint|build|checks?))/iu
    : /(?:(?:验证|测试|编译|lint|构建|检查).{0,40}(?:通过|失败|成功|无误|正常)|(?:通过|失败|成功|无误|正常).{0,40}(?:验证|测试|编译|lint|构建|检查))/iu;
  return message
    .trim()
    .split(/\n{2,}/u)
    .filter((paragraph) => !validationClaimPattern.test(paragraph) || qualificationPattern.test(paragraph))
    .join('\n\n');
}

export class RepairLoopTracker {
  private readonly state: RepairLoopState;

  public constructor(
    maxIterations: number,
    private readonly recordTrace?: (event: { type: string; [key: string]: unknown }) => void,
    initialState?: RepairLoopState
  ) {
    this.state = initialState
      ? {
          ...initialState,
          maxIterations: Math.max(0, Math.floor(maxIterations)),
          pendingDraftEditIds: [...initialState.pendingDraftEditIds]
        }
      : {
          status: 'idle',
          iteration: 0,
          maxIterations: Math.max(0, Math.floor(maxIterations)),
          pendingDraftEditIds: []
        };
  }

  public startValidation(script: SafeNpmScript): void {
    this.state.status = 'running_validation';
    this.state.lastValidationScript = script;
    this.state.stopReason = undefined;
    this.trace('repair_validation_started', { script });
  }

  public recordValidationResult(rawResult: string): { failed: boolean; limitReached: boolean; summary?: string } {
    const result = parseRecord(rawResult);
    if (result?.ok === true) {
      this.state.status = 'completed';
      this.state.lastFailureSummary = undefined;
      this.state.stopReason = 'validation_passed';
      this.trace('repair_validation_passed', { script: this.state.lastValidationScript, iteration: this.state.iteration });
      return { failed: false, limitReached: false };
    }

    // Authorization and precondition denials do not consume a repair attempt.
    const authorizedFailure = result?.authorized === true
      || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
    if (!authorizedFailure) {
      if (result?.errorType === 'authorization_denied') {
        this.state.status = 'blocked';
        this.state.stopReason = 'authorization_denied';
      }
      return { failed: false, limitReached: false };
    }

    this.state.iteration += 1;
    const summary = summarizeValidationFailure(result);
    this.state.lastFailureSummary = summary;
    const limitReached = this.state.iteration > this.state.maxIterations || this.state.maxIterations === 0;
    this.state.status = limitReached ? 'blocked' : 'validation_failed';
    this.state.stopReason = limitReached ? 'repair_iteration_limit' : undefined;
    this.trace('repair_validation_failed', {
      script: this.state.lastValidationScript,
      iteration: this.state.iteration,
      maxIterations: this.state.maxIterations,
      failureSummary: summary,
      limitReached
    });
    return { failed: true, limitReached, summary };
  }

  public recordProblemsRead(): void {
    if (this.state.status !== 'validation_failed' && this.state.status !== 'reading_problems') {
      return;
    }
    this.state.status = 'reading_problems';
    this.trace('repair_problems_read', { iteration: this.state.iteration });
  }

  public beginRepair(): boolean {
    const isRepairGeneration = this.state.status === 'validation_failed'
      || this.state.status === 'reading_problems'
      || this.state.status === 'generating_repair'
      || this.state.status === 'waiting_for_apply'
      || this.state.stopReason === 'repair_iteration_limit';
    if (!isRepairGeneration) {
      return true;
    }
    if (this.state.stopReason === 'repair_iteration_limit'
      || this.state.iteration > this.state.maxIterations
      || this.state.maxIterations === 0) {
      this.state.status = 'blocked';
      this.state.stopReason = 'repair_iteration_limit';
      this.trace('repair_loop_stopped', {
        reason: 'repair_iteration_limit',
        iteration: this.state.iteration,
        maxIterations: this.state.maxIterations
      });
      return false;
    }
    if (this.state.status === 'validation_failed'
      || this.state.status === 'reading_problems'
      || this.state.status === 'generating_repair'
      || this.state.status === 'waiting_for_apply') {
      this.state.status = 'generating_repair';
      this.trace('repair_generation_started', { iteration: this.state.iteration });
    }
    return true;
  }

  public recordDraftEdit(editId: string): void {
    if (this.state.status !== 'generating_repair') {
      return;
    }
    if (!this.state.pendingDraftEditIds.includes(editId)) {
      this.state.pendingDraftEditIds.push(editId);
    }
    this.state.status = 'waiting_for_apply';
    this.state.stopReason = 'waiting_for_apply';
    this.trace('repair_loop_waiting_for_apply', {
      iteration: this.state.iteration,
      pendingDraftEditIds: [...this.state.pendingDraftEditIds]
    });
  }

  public hasPendingRepair(): boolean {
    return this.state.status === 'waiting_for_apply' && this.state.pendingDraftEditIds.length > 0;
  }

  public getState(): RepairLoopState {
    return { ...this.state, pendingDraftEditIds: [...this.state.pendingDraftEditIds] };
  }

  private trace(type: string, details: Record<string, unknown>): void {
    this.recordTrace?.({ type, ...details });
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function summarizeValidationFailure(result: Record<string, unknown>): string {
  const diagnostics = result.diagnostics && typeof result.diagnostics === 'object' && !Array.isArray(result.diagnostics)
    ? result.diagnostics as Record<string, unknown>
    : undefined;
  const parts = [
    typeof result.error === 'string' ? result.error : undefined,
    typeof result.exitCode === 'number' ? `exitCode=${result.exitCode}` : undefined,
    diagnostics ? `diagnostics: errors=${Number(diagnostics.errors ?? 0)}, warnings=${Number(diagnostics.warnings ?? 0)}` : undefined
  ].filter(Boolean);
  return parts.join('; ').slice(0, 500) || 'Validation failed.';
}
