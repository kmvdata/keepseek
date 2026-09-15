import { createHash } from 'node:crypto';
import type { DeepSeekMessage } from '../deepseek/types';
import type { OpenAiResponsesItem } from '../providers/responsesTypes';
import type { AnthropicMessage, AnthropicSystemTextBlock } from '../providers/anthropicTypes';
import { checkpointCopy, type RunCheckpoint } from '../runCheckpoint';
import type { ProviderNativeRunState } from '../runner';
import { stableStringify } from '../evidence/shaping';
import type { GoalContractV1, GoalReplayCursorV1 } from './goalTypes';

export interface GoalControlItemV1 {
  kind: 'keepseek_goal_control';
  version: 1;
  contractHash: string;
  revision: number;
  evidenceManifestHash: string;
  workspaceMutationRevision: number;
  unmetCriterionIds: string[];
  incompleteValidations: string[];
  taskPlan: { status: string; currentStepId: string; blockers: string[] };
  nextStep: string;
}

export type GoalProviderReplayStateV1 =
  | {
      version: 1;
      protocol: 'chat-completions';
      sourceId: string;
      endpointHash: string;
      contractHash: string;
      revision: number;
      messages: DeepSeekMessage[];
      bytesHash: string;
    }
  | {
      version: 1;
      protocol: 'openai-responses';
      sourceId: string;
      endpointHash: string;
      contractHash: string;
      revision: number;
      input: OpenAiResponsesItem[];
      bytesHash: string;
    }
  | {
      version: 1;
      protocol: 'anthropic-messages';
      sourceId: string;
      endpointHash: string;
      contractHash: string;
      revision: number;
      system: AnthropicSystemTextBlock[];
      messages: AnthropicMessage[];
      bytesHash: string;
    };

export function createGoalControlItem(input: {
  contractHash: string;
  revision: number;
  evidenceManifestHash: string;
  workspaceMutationRevision: number;
  unmetCriterionIds: string[];
  incompleteValidations: string[];
  taskPlan?: { status?: string; currentStepId?: string; blockers?: string[] };
  nextStep: string;
}): { item: GoalControlItemV1; content: string; contentHash: string } {
  const item: GoalControlItemV1 = {
    kind: 'keepseek_goal_control',
    version: 1,
    contractHash: input.contractHash,
    revision: input.revision,
    evidenceManifestHash: input.evidenceManifestHash,
    workspaceMutationRevision: Math.max(0, Math.floor(input.workspaceMutationRevision)),
    unmetCriterionIds: [...input.unmetCriterionIds].sort(),
    incompleteValidations: [...input.incompleteValidations].sort(),
    taskPlan: {
      status: input.taskPlan?.status ?? 'in_progress',
      currentStepId: input.taskPlan?.currentStepId ?? '',
      blockers: [...(input.taskPlan?.blockers ?? [])].map((value) => value.slice(0, 500)).sort()
    },
    nextStep: input.nextStep.trim().slice(0, 1_000)
  };
  const content = stableStringify(item);
  return { item, content, contentHash: sha256(content) };
}

/** Adds an unaccepted candidate and deterministic host control to the exact
 * checkpoint continuation without creating a ChatSession user message. */
export function appendGoalContinuation(input: {
  checkpoint: RunCheckpoint;
  candidateContent: string;
  candidateReasoning?: string;
  controlContent: string;
}): RunCheckpoint {
  const checkpoint = checkpointCopy(input.checkpoint);
  if (!checkpoint.state) throw new Error('Goal continuation requires a complete RunCheckpoint state.');
  const assistant: DeepSeekMessage = {
    role: 'assistant',
    content: input.candidateContent,
    ...(input.candidateReasoning ? { reasoning_content: input.candidateReasoning } : {})
  };
  const control: DeepSeekMessage = { role: 'user', content: input.controlContent };
  checkpoint.state.messages.push(assistant, control);
  appendNativeControl(checkpoint.state.provider, input.controlContent);
  checkpoint.state.pending = undefined;
  checkpoint.state.completedReplay = undefined;
  checkpoint.status = 'interrupted';
  checkpoint.stopReason = 'waiting_for_user';
  checkpoint.error = undefined;
  return checkpoint;
}

export function appendGoalHostControl(checkpointInput: RunCheckpoint, content: string): RunCheckpoint {
  const checkpoint = checkpointCopy(checkpointInput);
  if (!checkpoint.state) throw new Error('Goal host continuation requires a complete RunCheckpoint state.');
  checkpoint.state.messages.push({ role: 'user', content });
  appendNativeControl(checkpoint.state.provider, content);
  checkpoint.state.pending = undefined;
  checkpoint.state.completedReplay = undefined;
  checkpoint.status = 'interrupted';
  checkpoint.stopReason = 'waiting_for_user';
  checkpoint.error = undefined;
  return checkpoint;
}

export function createTerminalGoalReplay(input: {
  checkpoint: RunCheckpoint;
  contract: GoalContractV1;
  candidateContent: string;
}): GoalProviderReplayStateV1 {
  if (!input.checkpoint.state) throw new Error('Goal completion requires a complete RunCheckpoint state.');
  const sourceId = input.contract.main.sourceId;
  const endpointHash = input.contract.main.endpointHash;
  const provider = input.checkpoint.state.provider;
  if (provider?.protocol === 'openai-responses') {
    return withReplayHash({
      version: 1, protocol: 'openai-responses', sourceId, endpointHash,
      contractHash: input.contract.canonicalHash, revision: input.checkpoint.goal?.revision ?? 1,
      input: structuredClone(provider.input)
    });
  }
  if (provider?.protocol === 'anthropic-messages') {
    return withReplayHash({
      version: 1, protocol: 'anthropic-messages', sourceId, endpointHash,
      contractHash: input.contract.canonicalHash, revision: input.checkpoint.goal?.revision ?? 1,
      system: structuredClone(provider.system), messages: structuredClone(provider.messages)
    });
  }
  const messages = structuredClone(input.checkpoint.state.messages);
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.content !== input.candidateContent) {
    messages.push({ role: 'assistant', content: input.candidateContent });
  }
  return withReplayHash({
    version: 1, protocol: 'chat-completions', sourceId, endpointHash,
    contractHash: input.contract.canonicalHash, revision: input.checkpoint.goal?.revision ?? 1,
    messages
  });
}

export function toGoalReplayCursor(replay: GoalProviderReplayStateV1, storageRef: string): GoalReplayCursorV1 {
  const itemCount = replay.protocol === 'openai-responses' ? replay.input.length : replay.messages.length;
  return { version: 1, protocol: replay.protocol, itemCount, bytesHash: replay.bytesHash, storageRef };
}

export function createGoalCheckpointReplayCursor(checkpoint: RunCheckpoint): GoalReplayCursorV1 | undefined {
  if (!checkpoint.state) return undefined;
  const provider = checkpoint.state.provider;
  if (provider?.protocol === 'openai-responses') {
    return { version: 1, protocol: 'openai-responses', itemCount: provider.input.length,
      bytesHash: sha256(stableStringify(provider.input)), storageRef: 'run-checkpoint' };
  }
  if (provider?.protocol === 'anthropic-messages') {
    return { version: 1, protocol: 'anthropic-messages', itemCount: provider.messages.length,
      bytesHash: sha256(stableStringify({ system: provider.system, messages: provider.messages })), storageRef: 'run-checkpoint' };
  }
  return { version: 1, protocol: 'chat-completions', itemCount: checkpoint.state.messages.length,
    bytesHash: sha256(stableStringify(checkpoint.state.messages)), storageRef: 'run-checkpoint' };
}

export function normalizeGoalReplay(value: unknown): GoalProviderReplayStateV1 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const replay = value as GoalProviderReplayStateV1;
  if (replay.version !== 1 || !replay.sourceId || !replay.endpointHash || !replay.contractHash
    || !Number.isSafeInteger(replay.revision) || replay.revision < 1 || !replay.bytesHash) return undefined;
  if (replay.protocol === 'chat-completions' && Array.isArray(replay.messages) && replay.messages.length <= 100_000
    || replay.protocol === 'openai-responses' && Array.isArray(replay.input) && replay.input.length <= 100_000
    || replay.protocol === 'anthropic-messages' && Array.isArray(replay.system) && Array.isArray(replay.messages)
      && replay.messages.length <= 100_000) {
    const { bytesHash, ...payload } = replay;
    return bytesHash === sha256(stableStringify(payload)) ? structuredClone(replay) : undefined;
  }
  return undefined;
}

function appendNativeControl(provider: ProviderNativeRunState | undefined, content: string): void {
  if (provider?.protocol === 'openai-responses') {
    const item: OpenAiResponsesItem = { role: 'user', content };
    provider.input.push(item);
    provider.replayItems.push(item);
  } else if (provider?.protocol === 'anthropic-messages') {
    const message: AnthropicMessage = { role: 'user', content: [{ type: 'text', text: content }] };
    provider.messages.push(message);
    provider.replayMessages.push(message);
  }
}

function withReplayHash<T extends Omit<GoalProviderReplayStateV1, 'bytesHash'>>(value: T): T & { bytesHash: string } {
  return { ...value, bytesHash: sha256(stableStringify(value)) };
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
