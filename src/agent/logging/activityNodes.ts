import type { AgentToolRound } from '../../shared/types';
import { localize, type KeepseekLanguage } from '../../shared/i18n';
import { describeToolTarget } from '../toolTarget';

export type ActivityToolStatus = 'running' | 'succeeded' | 'failed' | 'denied';

/**
 * One visible step of an assistant turn: either a short piece of model
 * narration or one tool the model actually invoked.
 *
 * This is a *derived view*. It is never persisted, never sent to the Provider
 * and never replaces `message.content`; the Webview is the only consumer.
 */
export type ActivityNode =
  | { kind: 'say'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      target?: string;
      status: ActivityToolStatus;
      durationMs?: number;
    };

export interface BuildActivityNodesInput {
  /** `message.content` — for a finished message it is the final answer only. */
  content: string;
  /** The visible toolRounds projection; absent for DSML fallback lanes. */
  toolRounds?: readonly AgentToolRound[];
  /** A tool that is executing right now, from `state.pending.executing`. */
  liveTool?: { id: string; name: string; target?: string };
  /** `runDetails.toolCalls` durations by tool call id; never recomputed here. */
  toolDurations?: Readonly<Record<string, number>>;
  /** Only used to pick the wording of `describeToolTarget()`. */
  language?: KeepseekLanguage;
}

/** A single transcript must stay renderable; beyond this the tail is dropped. */
const MAX_ACTIVITY_NODES = 200;
/** Tool results above this size are not fully parsed on every render pass. */
const MAX_PARSED_RESULT_CHARS = 64 * 1024;
const RESULT_PROBE_CHARS = 16 * 1024;
const DENIED_ERROR_TYPE = 'authorization_denied';

/**
 * Build the step list for one assistant message.
 *
 * Returns `undefined` when there is nothing derived to show, which is the
 * signal for the caller to keep its original whole-message rendering. That is
 * the compatibility guarantee for the DSML fallback path and for historical
 * messages that never recorded `toolRounds`.
 *
 * Adjacent steps that read identically are merged into the later one before the
 * list is capped; see `collapseAdjacentDuplicates` for what "identically" means.
 */
export function buildActivityNodes(input: BuildActivityNodesInput): ActivityNode[] | undefined {
  const rounds = Array.isArray(input.toolRounds) ? input.toolRounds : [];
  const liveTool = input.liveTool;
  if (!rounds.length && !liveTool) return undefined;

  const language = input.language ?? 'zh-CN';
  const durations = input.toolDurations ?? {};
  const nodes: ActivityNode[] = [];

  for (const round of rounds) {
    const text = typeof round.assistantContent === 'string' ? round.assistantContent.trim() : '';
    if (text) nodes.push({ kind: 'say', text });
    for (const call of round.toolCalls ?? []) {
      const target = describeToolTarget(call.function.name, parseArguments(call.function.arguments), language);
      const durationMs = durations[call.id];
      nodes.push({
        kind: 'tool',
        id: call.id,
        name: call.function.name,
        status: resolveToolStatus(call.id, round.toolResults),
        ...(target ? { target } : {}),
        // Durations come from the recorded run details only; a missing value is
        // omitted rather than guessed from wall-clock time around this call.
        ...(typeof durationMs === 'number' ? { durationMs } : {})
      });
    }
  }

  const finalSay = resolveFinalSay(input.content, rounds);
  if (finalSay) nodes.push({ kind: 'say', text: finalSay });

  if (liveTool) {
    nodes.push({
      kind: 'tool',
      id: liveTool.id,
      name: liveTool.name,
      status: 'running',
      ...(liveTool.target ? { target: liveTool.target } : {})
    });
  }

  // Collapsing runs before the cap, so the marker counts the steps a reader can
  // actually see and the returned list never exceeds MAX_ACTIVITY_NODES.
  const visible = collapseAdjacentDuplicates(nodes);
  if (!visible.length) return undefined;

  if (visible.length > MAX_ACTIVITY_NODES) {
    // Truncation is stated in the transcript itself rather than silently
    // dropping steps, so a long run never looks shorter than it was.
    const kept = visible.slice(0, MAX_ACTIVITY_NODES - 1);
    kept.push({ kind: 'say', text: localize(language, 'activityNodesTruncated', { count: visible.length - kept.length }) });
    return kept;
  }
  return visible;
}

/**
 * Two steps are duplicates only when everything the reader can see matches:
 * a `say` by its text, a `tool` by its name and target. `id`, `status` and
 * `durationMs` never take part — they are different observations of the same
 * step, and only the later one is still true.
 */
function activityNodeSignature(node: ActivityNode): string {
  return node.kind === 'say'
    ? `say\u0000${node.text}`
    : `tool\u0000${node.name}\u0000${node.target ?? ''}`;
}

/**
 * Collapse only *adjacent* duplicates: the same call twice in a row is one
 * visible step, while a repeat after any other node keeps its own line. The
 * later observation replaces the earlier one in place, so a retried call shows
 * its final status and a finished row can never shadow a running one.
 */
function collapseAdjacentDuplicates(nodes: readonly ActivityNode[]): ActivityNode[] {
  const collapsed: ActivityNode[] = [];
  for (const node of nodes) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && activityNodeSignature(previous) === activityNodeSignature(node)) {
      collapsed[collapsed.length - 1] = node;
      continue;
    }
    collapsed.push(node);
  }
  return collapsed;
}

/**
 * The recovery path rebuilds `message.content` as
 * `rounds.map(assistantContent).join('') + tail` (KeepseekChatViewProvider).
 * In that shape the narration is already present as `say` nodes, so only the
 * tail after the joined prefix may become the final `say`. For a normal
 * completion `content` is the final answer alone and is used unchanged.
 */
function resolveFinalSay(content: string, rounds: readonly AgentToolRound[]): string | undefined {
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) return undefined;
  if (!rounds.length) return raw.trim();
  const prefix = rounds.map((round) => round.assistantContent ?? '').join('');
  if (!prefix) return raw.trim();
  if (!raw.startsWith(prefix)) return raw.trim();
  const tail = raw.slice(prefix.length).trim();
  return tail || undefined;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function resolveToolStatus(
  toolCallId: string,
  results: readonly { toolCallId: string; content: string }[] | undefined
): ActivityToolStatus {
  const result = (results ?? []).find((item) => item.toolCallId === toolCallId);
  if (!result) return 'running';
  return classifyToolResult(result.content);
}

function classifyToolResult(content: string): ActivityToolStatus {
  const parsed = parseResultRecord(content);
  if (!parsed) return 'succeeded';
  if (parsed.errorType === DENIED_ERROR_TYPE) return 'denied';
  return parsed.ok === false ? 'failed' : 'succeeded';
}

/**
 * Parse only what is needed to classify a result. Result bodies can be huge and
 * this runs on every visible-message projection, so oversized bodies are probed
 * at the head instead of fully deserialized.
 */
function parseResultRecord(content: string): Record<string, unknown> | undefined {
  if (typeof content !== 'string' || !content) return undefined;
  if (content.length <= MAX_PARSED_RESULT_CHARS) {
    try {
      const parsed: unknown = JSON.parse(content);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined;
    } catch {
      return undefined;
    }
  }
  const head = content.slice(0, RESULT_PROBE_CHARS);
  if (/"errorType"\s*:\s*"authorization_denied"/u.test(head)) return { errorType: DENIED_ERROR_TYPE };
  if (/"ok"\s*:\s*false/u.test(head)) return { ok: false };
  return undefined;
}