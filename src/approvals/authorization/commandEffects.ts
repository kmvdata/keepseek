import type { DraftRunEffectAssessment, DraftRunSpec } from '../../shared/types';
import { analyzeCommandCapability } from './commandCapability';
import type { CommandScope } from './commandScope';

/** Display advice only. Authority comes from preflight + exact-operation grants. */
export function analyzeDraftRunEffects(spec: DraftRunSpec, scope?: Pick<CommandScope, 'semantics' | 'diagnostics'>): DraftRunEffectAssessment {
  const parsed = scope?.semantics ?? analyzeCommandCapability(spec).semantics;
  const reasons = scope?.diagnostics ?? parsed.reasons;
  const effects = [...parsed.effects];
  if (reasons.length) effects.push('unknown');
  const sensitive = effects.some(effect => !['workspace_read', 'unknown', 'long_running'].includes(effect));
  return {
    version: 1,
    verdict: sensitive ? 'mutating_or_sensitive' : reasons.length ? 'unknown' : 'likely_readonly',
    effects,
    evidence: [
      'Effects describe recognized argv roles; unknown scope does not mean detected writes. This is advisory, not a safety proof. / 效果来自已识别的参数用途；范围未知不表示检测到写入。',
      ...reasons.map(reason => reason.message)
    ]
  };
}
