import type { KeepseekLanguage } from '../shared/i18n';
import type { PlannerDecision, PlannerMode } from '../shared/types';

const CHINESE_PLAN_ONLY_MARKERS = /(?:只|仅)(?:做)?规划|不要(?:执行|动手|实施)|不(?:要)?实施/iu;
const ENGLISH_PLAN_ONLY_MARKERS = /\b(?:just\s+plan|plan\s+only|do\s+not\s+(?:execute|implement)|don['’]t\s+(?:execute|implement))\b/iu;
const CHINESE_EXPLICIT_PLAN_MARKERS = /先规划|先分析(?:一下)?怎么做|规划(?:完成)?后(?:再)?执行/iu;
const ENGLISH_EXPLICIT_PLAN_MARKERS = /\b(?:plan\s+first|plan\s+(?:and|then)\s+execute)\b/iu;
const AUTO_COMPLEXITY_MARKERS = /(?:跨文件|多文件|重构|迁移|架构|兼容性|安全|回滚|测试|验证|multiple\s+files?|cross-file|refactor|migration|architecture|compatibility|security|rollback|tests?|validation)/giu;
const AUTO_LENGTH_THRESHOLD = 600;
const AUTO_COMPLEXITY_MARKER_THRESHOLD = 3;
const AUTO_LIST_ITEM_THRESHOLD = 4;

export function decidePlannerRoute(input: {
  prompt: string;
  language: KeepseekLanguage;
  mode: PlannerMode;
}): PlannerDecision {
  const prompt = stripQuotedExamples(input.prompt);
  const planOnlyPatterns = input.language === 'zh-CN'
    ? [CHINESE_PLAN_ONLY_MARKERS, ENGLISH_PLAN_ONLY_MARKERS]
    : [ENGLISH_PLAN_ONLY_MARKERS, CHINESE_PLAN_ONLY_MARKERS];
  if (planOnlyPatterns.some((pattern) => pattern.test(prompt))) {
    return { route: 'plan_only', reason: 'plan_only_marker' };
  }

  const explicitPatterns = input.language === 'zh-CN'
    ? [CHINESE_EXPLICIT_PLAN_MARKERS, ENGLISH_EXPLICIT_PLAN_MARKERS]
    : [ENGLISH_EXPLICIT_PLAN_MARKERS, CHINESE_EXPLICIT_PLAN_MARKERS];
  if (explicitPatterns.some((pattern) => pattern.test(prompt))) {
    return { route: 'plan_and_execute', reason: 'explicit_plan' };
  }

  if (input.mode === 'auto' && isDeterministicallyComplex(prompt)) {
    return { route: 'plan_and_execute', reason: 'auto_complexity' };
  }

  return { route: 'executor_only', reason: 'default' };
}

export function stripQuotedExamples(input: string): string {
  let output = '';
  let closingQuote = '';
  let escaped = false;
  const quotePairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    '`': '`',
    '“': '”',
    '‘': '’'
  };

  const characters = Array.from(input);
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (closingQuote) {
      if (escaped) {
        escaped = false;
        output += ' ';
        continue;
      }
      if (character === '\\' && (closingQuote === '"' || closingQuote === "'" || closingQuote === '`')) {
        escaped = true;
        output += ' ';
        continue;
      }
      if (character === closingQuote) {
        closingQuote = '';
      }
      output += character === '\n' ? '\n' : ' ';
      continue;
    }
    const isWordApostrophe = character === "'"
      && /[\p{L}\p{N}]/u.test(characters[index - 1] ?? '')
      && /[\p{L}\p{N}]/u.test(characters[index + 1] ?? '');
    const nextClosingQuote = isWordApostrophe ? undefined : quotePairs[character];
    if (nextClosingQuote) {
      closingQuote = nextClosingQuote;
      output += ' ';
      continue;
    }
    output += character;
  }

  return output;
}

function isDeterministicallyComplex(prompt: string): boolean {
  if (prompt.trim().length >= AUTO_LENGTH_THRESHOLD) {
    return true;
  }
  const markerCount = Array.from(prompt.matchAll(AUTO_COMPLEXITY_MARKERS)).length;
  if (markerCount >= AUTO_COMPLEXITY_MARKER_THRESHOLD) {
    return true;
  }
  const listItemCount = prompt
    .split(/\r?\n/gu)
    .filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/u.test(line)).length;
  return listItemCount >= AUTO_LIST_ITEM_THRESHOLD;
}
