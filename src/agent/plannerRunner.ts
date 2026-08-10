import type { KeepseekLanguage } from '../shared/i18n';
import type { AgentRunCallbacks, PlannerResult, ReasoningEffort } from '../shared/types';
import type { DeepSeekClientConfig } from './deepseek/client';
import type { DeepSeekMessage } from './deepseek/types';
import { buildPlannerTaskPrompt, PLANNER_SYSTEM_PROMPT } from './plannerPrompt';
import { SubagentRunner } from './subagent/subagentRunner';

export interface PlannerRunInput {
  prompt: string;
  contextInstructions?: string;
  modelId: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  maxResearchSteps: number;
  maxTokens: number;
  maxDurationMs: number;
  clientConfig: DeepSeekClientConfig;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: Pick<AgentRunCallbacks, 'onUsage'>;
}

export class PlannerRunner {
  public constructor(private readonly subagentRunner: SubagentRunner) {}

  public async run(input: PlannerRunInput): Promise<PlannerResult> {
    const messages: DeepSeekMessage[] = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT }
    ];
    if (input.contextInstructions?.trim()) {
      messages.push({ role: 'system', content: input.contextInstructions });
    }
    messages.push({
      role: 'user',
      content: buildPlannerTaskPrompt(input.prompt, input.language)
    });

    const result = await this.subagentRunner.run({
      modelId: input.modelId,
      messages,
      thinkingEnabled: input.thinkingEnabled,
      reasoningEffort: input.reasoningEffort,
      maxToolRounds: input.maxResearchSteps,
      maxTokens: input.maxTokens,
      maxDurationMs: input.maxDurationMs,
      clientConfig: input.clientConfig,
      language: input.language,
      signal: input.signal,
      callbacks: input.callbacks
    });
    return {
      plan: result.content,
      modelId: input.modelId,
      researchSteps: result.researchSteps,
      truncated: result.truncated,
      finishReason: result.finishReason
    };
  }
}
