import type { DeepSeekClientConfig } from '../deepseek/client';
import type { DeepSeekMessage } from '../deepseek/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type {
  AgentRunCallbacks,
  DraftEdit,
  ReasoningEffort,
  SubagentReviewResult
} from '../../shared/types';
import type { WorkspaceToolAdapter } from '../tools/workspaceTools';
import { SubagentRunner } from './subagentRunner';

const MAX_PROMPT_SUMMARY_CHARS = 2_000;
const MAX_DIFF_PREVIEW_CHARS = 24_000;
const MAX_DIFF_PREVIEW_CHARS_PER_FILE = 6_000;
const MAX_REVIEW_FILES = 20;
const REVIEW_MAX_TOOL_ROUNDS = 4;
const REVIEW_MAX_TOKENS = 2_048;
const REVIEW_MAX_DURATION_MS = 90_000;

export const REVIEW_SUBAGENT_SYSTEM_PROMPT = [
  'You are KeepSeek Review, a read-only code review subagent.',
  'Review the proposed pending DraftEdits without modifying, creating, deleting, validating, or otherwise writing any file.',
  'Check requirement alignment, obvious defects and regression risks, omissions, and security boundaries.',
  'Use the provided read-only tools only when current workspace evidence is necessary.',
  'Return bounded Markdown review findings. Prioritize actionable issues and say explicitly when no material issue is found.'
].join('\n\n');

export interface ReviewSubagentInput {
  prompt: string;
  draftEdits: readonly DraftEdit[];
  contextInstructions?: string;
  modelId: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  clientConfig: DeepSeekClientConfig;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: Pick<AgentRunCallbacks, 'onUsage'>;
}

export class ReviewSubagent {
  public constructor(
    private readonly subagentRunner: SubagentRunner,
    private readonly workspaceTools: WorkspaceToolAdapter
  ) {}

  public async run(input: ReviewSubagentInput): Promise<SubagentReviewResult> {
    const reviewPrompt = await this.buildReviewPrompt(input.prompt, input.draftEdits, input.language);
    const messages: DeepSeekMessage[] = [
      { role: 'system', content: REVIEW_SUBAGENT_SYSTEM_PROMPT }
    ];
    if (input.contextInstructions?.trim()) {
      messages.push({ role: 'system', content: input.contextInstructions });
    }
    messages.push({ role: 'user', content: reviewPrompt });

    const result = await this.subagentRunner.run({
      modelId: input.modelId,
      messages,
      thinkingEnabled: input.thinkingEnabled,
      reasoningEffort: input.reasoningEffort,
      maxToolRounds: REVIEW_MAX_TOOL_ROUNDS,
      maxTokens: REVIEW_MAX_TOKENS,
      maxDurationMs: REVIEW_MAX_DURATION_MS,
      clientConfig: input.clientConfig,
      language: input.language,
      signal: input.signal,
      callbacks: input.callbacks
    });
    return {
      taskType: 'review',
      modelId: input.modelId,
      review: result.content,
      researchSteps: result.researchSteps,
      truncated: result.truncated
    };
  }

  private async buildReviewPrompt(
    prompt: string,
    draftEdits: readonly DraftEdit[],
    language: KeepseekLanguage
  ): Promise<string> {
    const fileBlocks: string[] = [];
    let remainingChars = MAX_DIFF_PREVIEW_CHARS;
    for (const edit of draftEdits.slice(0, MAX_REVIEW_FILES)) {
      if (remainingChars <= 0) {
        break;
      }
      const originalText = edit.action === 'create' ? '' : await this.readOriginalText(edit, language);
      const proposedText = edit.action === 'delete' ? '' : edit.newText;
      const preview = createBoundedDiffPreview(originalText, proposedText, Math.min(
        remainingChars,
        MAX_DIFF_PREVIEW_CHARS_PER_FILE
      ));
      const block = [
        `## ${truncateText(edit.label, 300)}`,
        `Action: ${edit.action}`,
        `Reason: ${truncateText(edit.reason, 500)}`,
        '```diff',
        preview,
        '```'
      ].join('\n');
      const boundedBlock = truncateText(block, remainingChars);
      fileBlocks.push(boundedBlock);
      remainingChars -= boundedBlock.length;
    }
    const requestLabel = language === 'en' ? 'Original request summary' : '原始用户请求摘要';
    const changesLabel = language === 'en' ? 'Pending ChangeSet preview' : '待确认 ChangeSet 预览';
    return [
      `# ${requestLabel}`,
      truncateText(prompt.trim(), MAX_PROMPT_SUMMARY_CHARS),
      `# ${changesLabel}`,
      `Files: ${truncateText(draftEdits.map((edit) => `${edit.action}:${edit.label}`).join(', '), 4_000)}`,
      ...fileBlocks
    ].join('\n\n');
  }

  private async readOriginalText(edit: DraftEdit, language: KeepseekLanguage): Promise<string> {
    try {
      const rawResult = await this.workspaceTools.readWorkspaceFile(edit.uri, language);
      const parsed: unknown = JSON.parse(rawResult);
      if (isRecord(parsed) && parsed.ok === true && typeof parsed.content === 'string') {
        return parsed.content;
      }
    } catch {
      // A missing or unreadable original is represented as an empty bounded preview.
    }
    return '';
  }
}

export async function runReviewBestEffort(
  task: () => Promise<SubagentReviewResult>
): Promise<SubagentReviewResult | undefined> {
  try {
    return await task();
  } catch {
    return undefined;
  }
}

export function createBoundedDiffPreview(before: string, after: string, maxChars: number): string {
  const sideLimit = Math.max(1, Math.floor(maxChars / 2));
  const beforeLines = before.slice(0, sideLimit).replace(/\r\n?/gu, '\n').split('\n');
  const afterLines = after.slice(0, sideLimit).replace(/\r\n?/gu, '\n').split('\n');
  const diff = [
    '--- before',
    '+++ after',
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`)
  ].join('\n');
  return truncateText(diff, maxChars);
}

function truncateText(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = '\n... preview truncated';
  if (maxChars <= suffix.length) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
