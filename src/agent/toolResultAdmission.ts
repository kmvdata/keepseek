import { MIN_EVIDENCE_ENVELOPE_TOKENS } from './evidence/types';

export const CONTEXT_WINDOW_CALIBRATION_VERSION = 2;
export const CONTEXT_WINDOW_DECLARATION_VERSION = 'context-capability-v2';

export interface ContextWindowDeclaration {
  identity: string;
  version: string;
}

export interface ContextWindowCalibrationState {
  version: 2;
  declaredWindowTokens: number;
  declaredIdentity: string;
  declaredVersion: string;
  learnedEffectiveWindowTokens: number;
  estimatorScale: number;
  observations: number;
  contextTooLongCount: number;
  successfulInputFloorTokens: number;
  providerContextTooLongCeilingTokens?: number;
  legacyConservativeCeilingTokens?: number;
  lastAdjustmentSource: 'declared' | 'successful_request' | 'provider_context_too_long' | 'legacy_rebaseline';
  lastEstimatedInputTokens?: number;
  lastActualInputTokens?: number;
}

export interface LegacyContextWindowCalibrationStateV1 {
  version?: 1;
  declaredWindowTokens: number;
  learnedEffectiveWindowTokens: number;
  estimatorScale: number;
  observations: number;
  contextTooLongCount: number;
  lastEstimatedInputTokens?: number;
  lastActualInputTokens?: number;
}

export type RestoredContextWindowCalibrationState = ContextWindowCalibrationState | LegacyContextWindowCalibrationStateV1;

export interface ContextWindowCalibrationMigration {
  reason: 'stale_capacity_calibration';
  beforeWindowTokens: number;
  afterWindowTokens: number;
  evidence: 'legacy_fallback' | 'successful_input_floor' | 'declaration_changed';
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

/** Dynamic admission is request-relative and has no cumulative tool-result ceiling. */
export class ToolResultAdmissionController {
  public readonly state: ContextWindowCalibrationState;
  public readonly migration?: ContextWindowCalibrationMigration;

  public constructor(
    declaredWindowTokens: number,
    restored?: RestoredContextWindowCalibrationState,
    declaration: ContextWindowDeclaration = { identity: 'unknown-model', version: CONTEXT_WINDOW_DECLARATION_VERSION }
  ) {
    const result = migrateContextWindowCalibrationState(restored, declaredWindowTokens, declaration);
    this.state = result.state;
    this.migration = result.migration;
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

  /** Estimator accuracy is learned independently from Provider capacity bounds. */
  public observe(estimatedInputTokens: number, actualInputTokens: number): void {
    if (!(estimatedInputTokens > 0) || !(actualInputTokens > 0)) return;
    const ratio = clamp(actualInputTokens / estimatedInputTokens, 0.5, 3);
    this.state.estimatorScale = clamp(Math.max(ratio * 1.03, this.state.estimatorScale * 0.96), 0.8, 3);
    this.state.observations += 1;
    this.state.lastEstimatedInputTokens = Math.floor(estimatedInputTokens);
    this.state.lastActualInputTokens = Math.floor(actualInputTokens);
  }

  public recordContextTooLong(attemptedInputTokens?: number): void {
    const attempted = normalizePositiveInteger(attemptedInputTokens) ?? this.state.learnedEffectiveWindowTokens;
    const next = Math.max(1_024, Math.min(
      Math.floor(this.state.learnedEffectiveWindowTokens * 0.8),
      Math.floor(attempted * 0.88),
      this.state.declaredWindowTokens
    ));
    this.state.contextTooLongCount += 1;
    this.state.providerContextTooLongCeilingTokens = this.state.providerContextTooLongCeilingTokens === undefined
      ? next
      : Math.min(this.state.providerContextTooLongCeilingTokens, next);
    // A new explicit rejection can supersede an older success observation
    // (Provider routing/capacity may have changed). Keep the evidence fields
    // consistent instead of letting the historical floor block real downshift.
    this.state.successfulInputFloorTokens = Math.min(this.state.successfulInputFloorTokens, next);
    this.state.learnedEffectiveWindowTokens = next;
    this.state.estimatorScale = Math.min(3, Math.max(1.15, this.state.estimatorScale * 1.08));
    this.state.lastAdjustmentSource = 'provider_context_too_long';
  }

  public recordSuccessfulRequest(actualInputTokens?: number): ContextWindowCalibrationMigration | undefined {
    this.state.contextTooLongCount = 0;
    const actual = normalizePositiveInteger(actualInputTokens);
    if (!actual) return undefined;
    const floor = Math.min(actual, this.state.declaredWindowTokens);
    this.state.successfulInputFloorTokens = Math.max(this.state.successfulInputFloorTokens, floor);
    if ((this.state.providerContextTooLongCeilingTokens ?? Number.POSITIVE_INFINITY) < floor) {
      this.state.providerContextTooLongCeilingTokens = undefined;
    }
    // A successful request above the learned ceiling proves that ceiling was
    // stale. With no surviving Provider rejection, rebase to the current
    // declaration instead of inching upward and causing another tool-round
    // rollover on the very next admission calculation.
    const targetWindow = floor > this.state.learnedEffectiveWindowTokens
      && this.state.providerContextTooLongCeilingTokens === undefined
      ? this.state.declaredWindowTokens
      : successfulCapacityBaseline(floor, this.state.declaredWindowTokens);
    if (this.state.learnedEffectiveWindowTokens >= targetWindow) return undefined;
    const beforeWindowTokens = this.state.learnedEffectiveWindowTokens;
    this.state.learnedEffectiveWindowTokens = targetWindow;
    this.state.lastAdjustmentSource = 'successful_request';
    return {
      reason: 'stale_capacity_calibration', beforeWindowTokens,
      afterWindowTokens: this.state.learnedEffectiveWindowTokens,
      evidence: 'successful_input_floor'
    };
  }

  public reconcileSuccessfulFloor(): ContextWindowCalibrationMigration | undefined {
    const floor = Math.min(this.state.successfulInputFloorTokens, this.state.declaredWindowTokens);
    const targetWindow = floor > this.state.learnedEffectiveWindowTokens
      && this.state.providerContextTooLongCeilingTokens === undefined
      ? this.state.declaredWindowTokens
      : successfulCapacityBaseline(floor, this.state.declaredWindowTokens);
    if (targetWindow <= this.state.learnedEffectiveWindowTokens) return undefined;
    const beforeWindowTokens = this.state.learnedEffectiveWindowTokens;
    this.state.learnedEffectiveWindowTokens = targetWindow;
    this.state.lastAdjustmentSource = 'successful_request';
    return {
      reason: 'stale_capacity_calibration', beforeWindowTokens,
      afterWindowTokens: this.state.learnedEffectiveWindowTokens,
      evidence: 'successful_input_floor'
    };
  }

  private outputReserve(configured: number, phase: 'tool' | 'final' | 'summary'): number {
    const window = this.state.learnedEffectiveWindowTokens;
    const ratio = phase === 'tool' ? 0.08 : phase === 'summary' ? 0.04 : 0.22;
    const floor = phase === 'summary' ? 512 : 1_024;
    return Math.max(floor, Math.min(Math.max(floor, configured), Math.floor(window * ratio)));
  }
}

export function migrateContextWindowCalibrationState(
  value: RestoredContextWindowCalibrationState | undefined,
  declaredWindowTokens: number,
  declaration: ContextWindowDeclaration
): { state: ContextWindowCalibrationState; migration?: ContextWindowCalibrationMigration } {
  const declared = Number.isFinite(declaredWindowTokens) && declaredWindowTokens > 0
    ? Math.max(1_024, Math.floor(declaredWindowTokens))
    : 1_024;
  if (!isCalibrationLike(value)) return { state: createDefaultState(declared, declaration) };

  const estimatorScale = clampFinite(value.estimatorScale, 0.8, 3, 1.08);
  const observations = nonNegativeInteger(value.observations);
  const restoredContextTooLongCount = nonNegativeInteger(value.contextTooLongCount);
  const before = clampFinite(value.learnedEffectiveWindowTokens, 1_024, Number.MAX_SAFE_INTEGER, declared);
  const isV2 = value.version === CONTEXT_WINDOW_CALIBRATION_VERSION
    && typeof (value as ContextWindowCalibrationState).declaredIdentity === 'string';
  // In v1 this counter was incremented only by an explicit Provider
  // context-too-long response and reset after the next success. A positive
  // value is therefore the one legacy signal strong enough to preserve the
  // learned ceiling; a plain 32K record with count=0 is only old metadata.
  const legacyHasProviderContextTooLongEvidence = !isV2 && restoredContextTooLongCount > 0;
  const successfulFloor = isV2
    ? Math.min(declared, nonNegativeInteger((value as ContextWindowCalibrationState).successfulInputFloorTokens))
    : Math.min(declared, nonNegativeInteger(value.lastActualInputTokens));
  const explicitProviderCeiling = isV2
    ? normalizePositiveInteger((value as ContextWindowCalibrationState).providerContextTooLongCeilingTokens)
    : legacyHasProviderContextTooLongEvidence ? before : undefined;
  const legacyConservativeCeiling = isV2
    ? normalizePositiveInteger((value as ContextWindowCalibrationState).legacyConservativeCeilingTokens)
    : !legacyHasProviderContextTooLongEvidence && before < declared ? before : undefined;
  const declarationChanged = !isV2
    || (value as ContextWindowCalibrationState).declaredIdentity !== declaration.identity
    || (value as ContextWindowCalibrationState).declaredVersion !== declaration.version
    || value.declaredWindowTokens !== declared;

  let learned = declared;
  let migration: ContextWindowCalibrationMigration | undefined;
  if (explicitProviderCeiling !== undefined) learned = Math.min(declared, explicitProviderCeiling);
  else if (isV2 && !declarationChanged) learned = Math.min(declared, before);
  else if (before !== declared) {
    migration = {
      reason: 'stale_capacity_calibration', beforeWindowTokens: before,
      afterWindowTokens: declared, evidence: isV2 ? 'declaration_changed' : 'legacy_fallback'
    };
  }
  learned = explicitProviderCeiling === undefined && successfulFloor > before
    ? declared
    : Math.max(
      explicitProviderCeiling === undefined
        ? successfulCapacityBaseline(successfulFloor, declared)
        : Math.min(successfulFloor, explicitProviderCeiling),
      learned
    );
  if (learned !== before && !migration) {
    migration = {
      reason: 'stale_capacity_calibration', beforeWindowTokens: before,
      afterWindowTokens: learned,
      evidence: successfulFloor > before ? 'successful_input_floor' : 'declaration_changed'
    };
  }

  return {
    state: {
      version: CONTEXT_WINDOW_CALIBRATION_VERSION,
      declaredWindowTokens: declared,
      declaredIdentity: declaration.identity,
      declaredVersion: declaration.version,
      learnedEffectiveWindowTokens: clamp(learned, 1_024, declared),
      estimatorScale,
      observations,
      contextTooLongCount: isV2 || legacyHasProviderContextTooLongEvidence
        ? restoredContextTooLongCount
        : 0,
      successfulInputFloorTokens: successfulFloor,
      ...(explicitProviderCeiling === undefined ? {} : {
        providerContextTooLongCeilingTokens: Math.min(declared, explicitProviderCeiling)
      }),
      ...(legacyConservativeCeiling === undefined ? {} : {
        legacyConservativeCeilingTokens: legacyConservativeCeiling
      }),
      lastAdjustmentSource: migration ? 'legacy_rebaseline'
        : isV2
          ? (value as ContextWindowCalibrationState).lastAdjustmentSource ?? 'declared'
          : legacyHasProviderContextTooLongEvidence ? 'provider_context_too_long' : 'declared',
      ...(normalizePositiveInteger(value.lastEstimatedInputTokens) === undefined ? {} : {
        lastEstimatedInputTokens: normalizePositiveInteger(value.lastEstimatedInputTokens)
      }),
      ...(normalizePositiveInteger(value.lastActualInputTokens) === undefined ? {} : {
        lastActualInputTokens: normalizePositiveInteger(value.lastActualInputTokens)
      })
    },
    migration
  };
}

export function isContextTooLongError(value: unknown): boolean {
  const text = value instanceof Error ? value.message : String(value ?? '');
  return /(?:context(?:_| |-)?(?:length|window).*(?:exceed|too (?:large|long)|maximum|full)|maximum context|too many (?:input )?tokens|prompt (?:is )?too long|model_context_window_exceeded|context_length_exceeded)/iu.test(text);
}

function createDefaultState(declared: number, declaration: ContextWindowDeclaration): ContextWindowCalibrationState {
  return {
    version: CONTEXT_WINDOW_CALIBRATION_VERSION,
    declaredWindowTokens: declared,
    declaredIdentity: declaration.identity,
    declaredVersion: declaration.version,
    learnedEffectiveWindowTokens: declared,
    estimatorScale: 1.08,
    observations: 0,
    contextTooLongCount: 0,
    successfulInputFloorTokens: 0,
    lastAdjustmentSource: 'declared'
  };
}

function isCalibrationLike(value: unknown): value is RestoredContextWindowCalibrationState {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LegacyContextWindowCalibrationStateV1>;
  return typeof item.declaredWindowTokens === 'number' && Number.isFinite(item.declaredWindowTokens)
    && typeof item.learnedEffectiveWindowTokens === 'number' && Number.isFinite(item.learnedEffectiveWindowTokens)
    && typeof item.estimatorScale === 'number' && Number.isFinite(item.estimatorScale)
    && typeof item.observations === 'number' && Number.isFinite(item.observations)
    && typeof item.contextTooLongCount === 'number' && Number.isFinite(item.contextTooLongCount);
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function successfulCapacityBaseline(floor: number, declared: number): number {
  if (floor <= 0) return 0;
  // Admission also reserves output and uncertainty. A modest bounded headroom
  // prevents an already accepted prompt from immediately failing the minimum
  // envelope calculation while the actual token count remains the evidence.
  return Math.min(declared, Math.max(floor, Math.ceil(floor * 1.25)));
}

function nonNegativeInteger(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function clampFinite(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? clamp(number, min, max) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
