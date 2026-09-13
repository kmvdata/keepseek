import { MIN_EVIDENCE_ENVELOPE_TOKENS } from './evidence/types';

export interface ContextWindowCalibrationState {
  declaredWindowTokens: number;
  learnedEffectiveWindowTokens: number;
  estimatorScale: number;
  observations: number;
  contextTooLongCount: number;
  lastEstimatedInputTokens?: number;
  lastActualInputTokens?: number;
}

export interface ToolResultAdmissionDecision {
  inlineTokenAllowance: number;
  outputReserveTokens: number;
  safetyTokens: number;
  minimumBatchEnvelopeTokens: number;
  shouldRollover: boolean;
  estimatedRequestTokens: number;
  learnedEffectiveWindowTokens: number;
}

export { MIN_EVIDENCE_ENVELOPE_TOKENS } from './evidence/types';

/** Dynamic admission is request-relative. It deliberately has no cumulative
 * tool-result ceiling; cumulative counts are telemetry only. */
export class ToolResultAdmissionController {
  public readonly state: ContextWindowCalibrationState;

  public constructor(declaredWindowTokens: number, restored?: ContextWindowCalibrationState) {
    const declared = Math.max(1_024, Math.floor(declaredWindowTokens));
    this.state = restored
      ? { ...restored, declaredWindowTokens: declared, learnedEffectiveWindowTokens: clamp(restored.learnedEffectiveWindowTokens, 1_024, declared) }
      : { declaredWindowTokens: declared, learnedEffectiveWindowTokens: declared, estimatorScale: 1.08, observations: 0, contextTooLongCount: 0 };
  }

  public decide(input: {
    estimatedInputTokens: number;
    configuredMaxOutputTokens: number;
    phase: 'tool' | 'final' | 'summary';
    remainingBatchResults: number;
  }): ToolResultAdmissionDecision {
    const scaledInput = Math.ceil(Math.max(0, input.estimatedInputTokens) * this.state.estimatorScale);
    const outputReserveTokens = this.outputReserve(input.configuredMaxOutputTokens, input.phase);
    const minimumBatchEnvelopeTokens = Math.max(1, input.remainingBatchResults) * MIN_EVIDENCE_ENVELOPE_TOKENS;
    const uncertainty = Math.abs((this.state.lastActualInputTokens ?? scaledInput) - (this.state.lastEstimatedInputTokens ?? scaledInput));
    const safetyTokens = Math.max(384, Math.min(8_192, Math.ceil(uncertainty * 1.25 + scaledInput * 0.015)));
    const available = this.state.learnedEffectiveWindowTokens - scaledInput - outputReserveTokens - safetyTokens;
    return {
      inlineTokenAllowance: Math.max(0, available - minimumBatchEnvelopeTokens),
      outputReserveTokens,
      safetyTokens,
      minimumBatchEnvelopeTokens,
      shouldRollover: available < minimumBatchEnvelopeTokens,
      estimatedRequestTokens: scaledInput + outputReserveTokens + safetyTokens,
      learnedEffectiveWindowTokens: this.state.learnedEffectiveWindowTokens
    };
  }

  public observe(estimatedInputTokens: number, actualInputTokens: number): void {
    if (!(estimatedInputTokens > 0) || !(actualInputTokens > 0)) return;
    const ratio = clamp(actualInputTokens / estimatedInputTokens, 0.5, 3);
    this.state.estimatorScale = clamp(Math.max(ratio * 1.03, this.state.estimatorScale * 0.96), 0.8, 3);
    this.state.observations += 1;
    this.state.lastEstimatedInputTokens = Math.floor(estimatedInputTokens);
    this.state.lastActualInputTokens = Math.floor(actualInputTokens);
    // Upward movement is intentionally slow and bounded by declared metadata.
    if (this.state.observations % 8 === 0 && actualInputTokens < this.state.learnedEffectiveWindowTokens * 0.55) {
      this.state.learnedEffectiveWindowTokens = Math.min(
        this.state.declaredWindowTokens,
        Math.ceil(this.state.learnedEffectiveWindowTokens * 1.03)
      );
    }
  }

  public recordContextTooLong(attemptedInputTokens?: number): void {
    const attempted = attemptedInputTokens && attemptedInputTokens > 0 ? attemptedInputTokens : this.state.learnedEffectiveWindowTokens;
    this.state.contextTooLongCount += 1;
    this.state.learnedEffectiveWindowTokens = Math.max(1_024, Math.min(
      Math.floor(this.state.learnedEffectiveWindowTokens * 0.8),
      Math.floor(attempted * 0.88)
    ));
    this.state.estimatorScale = Math.min(3, Math.max(1.15, this.state.estimatorScale * 1.08));
  }

  public recordSuccessfulRequest(): void {
    // Fatal-capacity detection is about consecutive failed rebuilds, not the
    // lifetime number of transient gateway rejections in a long session.
    this.state.contextTooLongCount = 0;
  }

  private outputReserve(configured: number, phase: 'tool' | 'final' | 'summary'): number {
    const window = this.state.learnedEffectiveWindowTokens;
    const ratio = phase === 'tool' ? 0.08 : phase === 'summary' ? 0.04 : 0.22;
    const floor = phase === 'summary' ? 512 : 1_024;
    return Math.max(floor, Math.min(Math.max(floor, configured), Math.floor(window * ratio)));
  }
}

export function isContextTooLongError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return /(?:context(?:_| |-)?(?:length|window).*(?:exceed|too (?:large|long)|maximum|full)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|model_context_window_exceeded|context_length_exceeded)/iu.test(text);
}

function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
