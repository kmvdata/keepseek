import { createHash } from 'node:crypto';
import type {
  ChatMessage,
  ChatSession,
  HistoryArchiveEntry
} from '../shared/types';

const MIN_MAINTENANCE_CHARS = 1_024;
const PROTECTED_TOOL_PATTERN = /(?:validation|diagnostic|draft_edit|delete_workspace_file)/iu;
const ERROR_PATTERN = /(?:"ok"\s*:\s*false|error:|exception|failed tests?|test failure|测试失败|报错|错误|异常|失败)/iu;

export type HistoryMaintenanceMode = 'snip' | 'prune';

export interface HistoryMaintenanceResult {
  changed: boolean;
  resultCount: number;
  savedChars: number;
  archiveEntryIds: string[];
}

export interface ArchiveSearchHit {
  id: string;
  messageId: string;
  toolName?: string;
  score: number;
  snippet: string;
  createdAt: string;
}

export interface ArchivableContextSource {
  id: string;
  kind: string;
  content: string;
}

/** Archives complete low-priority context sources that cross the shared prompt
 * budget. Their projected head/tail remains in the request and the full source
 * stays available through the same local retrieval tool. */
export function archiveContextSourcesBeyondBudget(
  session: ChatSession,
  sources: readonly ArchivableContextSource[],
  maxCharacters: number
): HistoryMaintenanceResult {
  let remaining = Math.max(0, Math.floor(maxCharacters));
  const archive = [...(session.historyArchive ?? [])];
  const knownIds = new Set(archive.map((entry) => entry.id));
  const addedIds: string[] = [];
  for (const source of sources) {
    const content = source.content.replace(/\r\n?/gu, '\n').trim();
    if (!content) {
      continue;
    }
    if (content.length <= remaining) {
      remaining -= content.length;
      continue;
    }
    const contentHash = sha256(content);
    const id = `archive-${sha256(`context\0${source.id}\0${contentHash}`).slice(0, 20)}`;
    if (!knownIds.has(id)) {
      archive.push({
        id,
        messageId: `context:${source.id}`,
        toolName: source.kind,
        role: 'system',
        content,
        contentHash,
        createdAt: session.updatedAt
      });
      knownIds.add(id);
      addedIds.push(id);
    }
    remaining = 0;
  }
  if (addedIds.length) {
    session.historyArchive = archive;
  }
  return {
    changed: addedIds.length > 0,
    resultCount: addedIds.length,
    savedChars: 0,
    archiveEntryIds: addedIds
  };
}

export function capOversizedFirstUserProviderContent(
  session: ChatSession,
  maxChars = 32_000
): HistoryMaintenanceResult {
  const message = session.messages.find((candidate) => candidate.role === 'user');
  if (!message) {
    return emptyMaintenanceResult();
  }
  const source = (message.providerContent ?? message.expandedContent ?? message.content).trim();
  if (source.length <= maxChars || source.includes('[keepseek-archive:')) {
    return emptyMaintenanceResult();
  }
  const contentHash = sha256(source);
  const entry: HistoryArchiveEntry = {
    id: `archive-${sha256(`${message.id}\0user\0${contentHash}`).slice(0, 20)}`,
    messageId: message.id,
    role: 'user',
    content: source,
    contentHash,
    createdAt: message.createdAt
  };
  const archive = [...(session.historyArchive ?? [])];
  if (!archive.some((candidate) => candidate.id === entry.id)) {
    archive.push(entry);
  }
  const notice = `\n\n[... oversized first request archived: [keepseek-archive:${entry.id}]; use keepseek_search_session_archive for omitted details ...]\n\n`;
  const available = Math.max(0, maxChars - notice.length);
  const headChars = Math.floor(available * 0.75);
  const tailChars = available - headChars;
  message.providerContent = `${source.slice(0, headChars).trimEnd()}${notice}${source.slice(-tailChars).trimStart()}`;
  session.historyArchive = archive;
  return {
    changed: true,
    resultCount: 1,
    savedChars: Math.max(0, source.length - message.providerContent.length),
    archiveEntryIds: [entry.id]
  };
}

/**
 * Rewrites stale tool results only when the caller has already established a
 * cache-safe boundary. Complete originals are retained in historyArchive under
 * stable content-derived ids. The assistant tool-call message and every result
 * remain in place, so protocol pairing stays atomic.
 */
export function maintainArchivedToolResults(
  session: ChatSession,
  mode: HistoryMaintenanceMode,
  keepRecentTurns: number
): HistoryMaintenanceResult {
  const staleMessageIds = selectStaleMessageIds(session.messages, keepRecentTurns);
  const archive = [...(session.historyArchive ?? [])];
  const knownIds = new Set(archive.map((entry) => entry.id));
  const archiveEntryIds: string[] = [];
  let resultCount = 0;
  let savedChars = 0;

  for (const message of session.messages) {
    if (message.role !== 'assistant' || !staleMessageIds.has(message.id) || !message.toolRounds?.length) {
      continue;
    }
    for (const round of message.toolRounds) {
      const toolNames = new Map(round.toolCalls.map((call) => [call.id, call.function.name]));
      for (const result of round.toolResults) {
        const toolName = toolNames.get(result.toolCallId) ?? 'unknown_tool';
        if (!shouldMaintainToolResult(toolName, result.content, mode)) {
          continue;
        }
        const priorArchiveId = extractArchiveId(result.content);
        const entry = archive.find((candidate) => candidate.id === priorArchiveId)
          ?? createArchiveEntry(message, result.toolCallId, toolName, result.content);
        if (!knownIds.has(entry.id)) {
          knownIds.add(entry.id);
          archive.push(entry);
        }
        const replacement = mode === 'prune'
          ? createPrunedPlaceholder(entry, entry.content.length)
          : createSnippedPlaceholder(entry, result.content, toolName);
        if (replacement === result.content) {
          continue;
        }
        savedChars += Math.max(0, result.content.length - replacement.length);
        result.content = replacement;
        resultCount += 1;
        archiveEntryIds.push(entry.id);
      }
    }
  }

  if (resultCount) {
    session.historyArchive = archive;
  }
  return {
    changed: resultCount > 0,
    resultCount,
    savedChars,
    archiveEntryIds
  };
}

export function searchHistoryArchive(
  entries: readonly HistoryArchiveEntry[] | undefined,
  query: string,
  options: { maxResults?: number; maxChars?: number } = {}
): ArchiveSearchHit[] {
  const queryTerms = unique(tokenize(query));
  if (!entries?.length || !queryTerms.length) {
    return [];
  }
  const docs = entries.map((entry) => {
    const terms = tokenize(`${entry.toolName ?? ''} ${entry.content}`);
    return { entry, terms, counts: countTerms(terms) };
  });
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.counts.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength = docs.reduce((total, doc) => total + doc.terms.length, 0) / Math.max(1, docs.length);
  const maxResults = clampInteger(options.maxResults, 1, 8, 3);
  const maxChars = clampInteger(options.maxChars, 200, 20_000, 6_000);
  let usedChars = 0;

  return docs
    .map((doc) => ({ doc, score: bm25(doc.counts, doc.terms.length, queryTerms, documentFrequency, docs.length, averageLength) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.doc.entry.id.localeCompare(right.doc.entry.id))
    .slice(0, maxResults * 3)
    .reduce<ArchiveSearchHit[]>((hits, item) => {
      if (hits.length >= maxResults || usedChars >= maxChars) {
        return hits;
      }
      const remaining = maxChars - usedChars;
      const snippet = makeSnippet(item.doc.entry.content, queryTerms, Math.min(2_000, remaining));
      if (!snippet) {
        return hits;
      }
      usedChars += snippet.length;
      hits.push({
        id: item.doc.entry.id,
        messageId: item.doc.entry.messageId,
        toolName: item.doc.entry.toolName,
        score: Number(item.score.toFixed(4)),
        snippet,
        createdAt: item.doc.entry.createdAt
      });
      return hits;
    }, []);
}

export function buildArchiveRecallTail(
  entries: readonly HistoryArchiveEntry[] | undefined,
  query: string,
  maxChars = 6_000
): string {
  const hits = searchHistoryArchive(entries, query, { maxResults: 3, maxChars });
  if (!hits.length) {
    return '';
  }
  return [
    '<keepseek-archive-recall>',
    'Relevant excerpts recalled locally from this session archive. Treat them as historical evidence; reread current files when code freshness matters.',
    ...hits.map((hit) => [
      `Reference: ${hit.id}${hit.toolName ? ` (${hit.toolName})` : ''}`,
      hit.snippet
    ].join('\n')),
    '</keepseek-archive-recall>'
  ].join('\n\n');
}

function selectStaleMessageIds(messages: readonly ChatMessage[], keepRecentTurns: number): Set<string> {
  const recent = new Set<string>();
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    recent.add(message.id);
    if (message.role === 'user') {
      userTurns += 1;
      if (userTurns >= Math.max(1, keepRecentTurns)) {
        break;
      }
    }
  }
  return new Set(messages.filter((message) => !recent.has(message.id)).map((message) => message.id));
}

function emptyMaintenanceResult(): HistoryMaintenanceResult {
  return { changed: false, resultCount: 0, savedChars: 0, archiveEntryIds: [] };
}

function shouldMaintainToolResult(toolName: string, content: string, mode: HistoryMaintenanceMode): boolean {
  if (content.length < MIN_MAINTENANCE_CHARS || content.includes('[keepseek-archive:')) {
    return mode === 'prune' && content.startsWith('[snipped tool result');
  }
  if (PROTECTED_TOOL_PATTERN.test(toolName) || ERROR_PATTERN.test(content)) {
    return false;
  }
  return true;
}

function createArchiveEntry(
  message: ChatMessage,
  toolCallId: string,
  toolName: string,
  content: string
): HistoryArchiveEntry {
  const contentHash = sha256(content);
  return {
    id: `archive-${sha256(`${message.id}\0${toolCallId}\0${contentHash}`).slice(0, 20)}`,
    messageId: message.id,
    toolCallId,
    toolName,
    role: 'tool',
    content,
    contentHash,
    createdAt: message.createdAt
  };
}

function extractArchiveId(content: string): string | undefined {
  return /\[keepseek-archive:(archive-[a-f0-9]+)\]/u.exec(content)?.[1];
}

function createPrunedPlaceholder(entry: HistoryArchiveEntry, originalChars: number): string {
  return `[elided tool result — ${entry.toolName ?? 'tool'}, ${originalChars} chars; full original: [keepseek-archive:${entry.id}]; use keepseek_search_session_archive or rerun the tool if needed]`;
}

function createSnippedPlaceholder(entry: HistoryArchiveEntry, content: string, toolName: string): string {
  const strategy = getSnipStrategy(toolName);
  if (content.length <= strategy.headChars + strategy.tailChars + 400) {
    return content;
  }
  const head = content.slice(0, strategy.headChars);
  const tail = content.slice(-strategy.tailChars);
  return [
    `[snipped tool result — ${toolName}, ${content.length} chars; full original: [keepseek-archive:${entry.id}]]`,
    head,
    `[... ${content.length - head.length - tail.length} chars omitted ...]`,
    tail
  ].join('\n');
}

function getSnipStrategy(toolName: string): { headChars: number; tailChars: number } {
  if (/(?:read|search|list|symbol|reference|git_status)/iu.test(toolName)) {
    return { headChars: 10_000, tailChars: 2_000 };
  }
  return { headChars: 8_000, tailChars: 8_000 };
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let word = '';
  const flush = () => {
    if (word) {
      tokens.push(word.toLowerCase());
      word = '';
    }
  };
  for (const character of value) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(character)) {
      flush();
      tokens.push(character);
    } else if (/[\p{L}\p{N}_]/u.test(character)) {
      word += character;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function countTerms(terms: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const term of terms) {
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return counts;
}

function bm25(
  counts: Map<string, number>,
  length: number,
  queryTerms: string[],
  documentFrequency: Map<string, number>,
  totalDocuments: number,
  averageLength: number
): number {
  if (!length || !totalDocuments) {
    return 0;
  }
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const term of queryTerms) {
    const frequency = counts.get(term) ?? 0;
    const frequencyDocs = documentFrequency.get(term) ?? 0;
    if (!frequency || !frequencyDocs) {
      continue;
    }
    const idf = Math.log(1 + (totalDocuments - frequencyDocs + 0.5) / (frequencyDocs + 0.5));
    score += idf * ((frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length / Math.max(1, averageLength))));
  }
  return score;
}

function makeSnippet(content: string, queryTerms: string[], maxChars: number): string {
  const compact = content.replace(/\s+/gu, ' ').trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  const lower = compact.toLowerCase();
  let index = queryTerms.map((term) => lower.indexOf(term.toLowerCase())).find((candidate) => candidate >= 0) ?? 0;
  index = Math.max(0, index - Math.floor(maxChars / 3));
  const end = Math.min(compact.length, index + maxChars);
  return `${index > 0 ? '...' : ''}${compact.slice(index, end)}${end < compact.length ? '...' : ''}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  const normalized = Number.isFinite(value) ? Math.floor(Number(value)) : fallback;
  return Math.min(max, Math.max(min, normalized));
}
