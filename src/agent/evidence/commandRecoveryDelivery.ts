import { createHash } from 'node:crypto';
import type { CommandRecoveryObservation } from '../../runs/commandRecovery';
import { READ_EVIDENCE_TOOL_NAME, RUN_DRAFT_TOOL_NAME } from '../protocol';
import type { ProviderClientRequest } from '../providers/types';
import type { ToolEvidence } from './types';

type RequestBody = ProviderClientRequest['body'];

/** Inspect the final wire projection. A reference, tool intent, summary or a
 * user quoting a prior diagnostic is insufficient to record delivery. */
export async function getCommandRecoveryDeliveries(input: {
  body: RequestBody;
  observations: readonly CommandRecoveryObservation[];
  rootTaskId: string;
  continuation?: { prompt: string; targetIds: readonly string[] };
  findEvidence: (evidenceRef: string) => Promise<ToolEvidence | undefined>;
  emulatedResultHashes?: readonly string[];
  findEmulatedEvidence: () => Promise<readonly ToolEvidence[]>;
}): Promise<string[]> {
  const observations = new Map(input.observations.filter(item => item.rootTaskId === input.rootTaskId)
    .map(item => [item.draftRunId, item]));
  if (!observations.size) return [];
  const delivered = new Set<string>();
  const pages = new Map<string, Map<number, Record<string, unknown>>>();
  const emulatedBlocks: string[] = [];
  const emulatedResultHashes = new Set(input.emulatedResultHashes);
  const inspectDraftResult = (result: Record<string, unknown> | undefined): void => {
    const diagnostic = result?.diagnostic;
    if (result?.status === 'needs_replan' && result.ok === false && result.executed === false && result.started === false
      && typeof result.draftRunId === 'string' && typeof result.specHash === 'string'
      && observations.get(result.draftRunId)?.specHash === result.specHash
      && isRecord(diagnostic) && diagnostic.started === false && diagnostic.blocking === true
      && diagnostic.phase === 'capability' && typeof diagnostic.code === 'string'
      && typeof diagnostic.reason === 'string' && diagnostic.reason.trim()) {
      delivered.add(result.draftRunId);
    }
  };
  const inspectToolResult = (toolName: string | undefined, content: string | null | undefined): void => {
    if (toolName !== RUN_DRAFT_TOOL_NAME && toolName !== READ_EVIDENCE_TOOL_NAME || !content) return;
    const result = parseRecord(content);
    if (toolName === RUN_DRAFT_TOOL_NAME) {
      inspectDraftResult(result);
    } else if (result?.ok === true && result.mode === 'bytes' && result.bodyDelivered === true
      && typeof result.evidenceRef === 'string' && typeof result.content === 'string'
      && typeof result.startByte === 'number' && Number.isSafeInteger(result.startByte)) {
      const existing = pages.get(result.evidenceRef) ?? new Map();
      existing.set(result.startByte, result);
      pages.set(result.evidenceRef, existing);
    }
  };
  const continuationTargets = new Set(input.continuation?.targetIds);
  const inspectUserText = (content: string | null | undefined): void => {
    if (!content) return;
    const prompt = input.continuation?.prompt;
    if (prompt && (content === prompt || content.startsWith(`${prompt}\n\n`))) {
      const raw = /(?:^|\n\n)<keepseek-operation-results>([^\n]*)<\/keepseek-operation-results>(?=\n\n|$)/u.exec(prompt)?.[1];
      const targets = raw && parseJson(raw);
      if (Array.isArray(targets)) for (const target of targets) {
        if (!isRecord(target) || typeof target.id !== 'string' || !continuationTargets.has(target.id)
          || target.status !== 'needs_replan' || !isRecord(target.replan)) continue;
        const replan = target.replan;
        if (replan.draftRunId === target.id && replan.rootTaskId === input.rootTaskId && typeof replan.specHash === 'string'
          && observations.get(target.id)?.specHash === replan.specHash && replan.executed === false
          && (replan.phase === 'capability' || replan.phase === 'preflight')
          && typeof replan.code === 'string' && typeof replan.reason === 'string' && replan.reason.trim()) {
          delivered.add(target.id);
        }
      }
    }
    if (emulatedResultHashes.size && emulatedResultHashes.has(createHash('sha256').update(content).digest('hex'))) emulatedBlocks.push(content);
  };

  const toolNames = new Map<string, string>();
  const { body } = input;
  if ('input' in body) {
    for (const item of body.input) {
      if (item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string') toolNames.set(item.call_id, item.name);
      if (item.type === 'function_call_output' && typeof item.call_id === 'string' && typeof item.output === 'string') {
        inspectToolResult(toolNames.get(item.call_id), item.output);
      }
      if (item.role === 'user' && typeof item.content === 'string') inspectUserText(item.content);
    }
  } else if ('system' in body) {
    for (const message of body.messages) for (const block of message.content) {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name);
      if (block.type === 'tool_result') inspectToolResult(toolNames.get(block.tool_use_id), block.content);
      if (message.role === 'user' && block.type === 'text') inspectUserText(block.text);
    }
  } else {
    for (const message of body.messages) {
      for (const call of message.tool_calls ?? []) toolNames.set(call.id, call.function.name);
      if (message.role === 'tool' && message.tool_call_id) inspectToolResult(toolNames.get(message.tool_call_id), message.content);
      if (message.role === 'user') inspectUserText(message.content);
    }
  }

  if (emulatedBlocks.length) {
    // Emulated calls have no native call ID on the wire. Match the exact
    // immutable envelope from this execution's journal within the host block.
    for (const record of await input.findEmulatedEvidence()) {
      const envelope = record.providerEnvelope;
      if (envelope && emulatedBlocks.some(block => block.includes(`\nResult:\n${envelope}`))) inspectToolResult(record.toolName, envelope);
    }
  }
  for (const [reference, chunks] of pages) {
    const evidence = await input.findEvidence(reference);
    if (evidence?.toolName !== RUN_DRAFT_TOOL_NAME || evidence.executionStatus !== 'completed' || !evidence.contentHash) continue;
    let cursor = 0;
    const content: string[] = [];
    while (true) {
      const chunk = chunks.get(cursor);
      if (!chunk || chunk.contentHash !== evidence.contentHash || typeof chunk.content !== 'string' || !chunk.content) break;
      content.push(chunk.content);
      cursor += Buffer.byteLength(chunk.content);
      if (cursor >= (evidence.totalBytes ?? 0)) break;
    }
    if (cursor !== evidence.totalBytes) continue;
    const raw = content.join('');
    if (createHash('sha256').update(raw).digest('hex') === evidence.contentHash) inspectDraftResult(parseRecord(raw));
  }
  return [...delivered];
}

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return undefined; }
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  const parsed = parseJson(content);
  return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
