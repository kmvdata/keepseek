import type { DraftRunEffectAssessment, DraftRunSpec } from '../../shared/types';
import { analyzeCommand } from './commandSemantics';

/** Display advice only. Authority comes from preflight + exact-operation grants. */
export function analyzeDraftRunEffects(spec: DraftRunSpec): DraftRunEffectAssessment {
  const parsed = analyzeCommand(spec);
  const effects = [...parsed.effects];
  if (parsed.reasons.length) effects.push('unknown');
  const sensitive = effects.some(effect => !['workspace_read', 'unknown', 'long_running'].includes(effect));
  return {
    version: 1,
    verdict: sensitive ? 'mutating_or_sensitive' : parsed.reasons.length ? 'unknown' : 'likely_readonly',
    effects,
    evidence: [
      'Effects describe recognized argv roles; unknown scope does not mean detected writes. This is advisory, not a safety proof. / 效果来自已识别的参数用途；范围未知不表示检测到写入。',
      ...parsed.reasons.map(reason => reason.message)
    ]
  };
}
