/**
 * Parser-only compatibility boundary for retired Project Memory JSON files.
 * This module intentionally has no persistence API.
 */

export type LegacyProjectMemoryCategory =
  | 'architecture'
  | 'preference'
  | 'command'
  | 'testing'
  | 'restriction'
  | 'project_note'
  | 'workflow';

export type LegacyProjectMemorySource = 'user' | 'agent_suggestion' | 'manual';

export interface LegacyProjectMemoryEntry {
  id: string;
  category: LegacyProjectMemoryCategory;
  content: string;
  source: LegacyProjectMemorySource;
  confidence: number;
  tags: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LegacyProjectMemoryFile {
  schemaVersion: 1;
  updatedAt: string;
  entries: LegacyProjectMemoryEntry[];
}

export function normalizeLegacyProjectMemory(value: unknown): LegacyProjectMemoryFile {
  const fallbackTimestamp = new Date().toISOString();
  if (!isRecord(value)) {
    return { schemaVersion: 1, updatedAt: fallbackTimestamp, entries: [] };
  }
  const entries = Array.isArray(value.entries)
    ? value.entries.map(normalizeEntry).filter((entry): entry is LegacyProjectMemoryEntry => Boolean(entry))
    : [];
  return {
    schemaVersion: 1,
    updatedAt: normalizeTimestamp(value.updatedAt, fallbackTimestamp),
    entries
  };
}

function normalizeEntry(value: unknown): LegacyProjectMemoryEntry | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }
  const id = value.id.trim();
  const content = value.content.replace(/\s+/gu, ' ').trim();
  if (!id || !content) {
    return undefined;
  }
  const createdAt = normalizeTimestamp(value.createdAt, new Date().toISOString());
  const confidence = Number(value.confidence);
  return {
    id,
    category: normalizeCategory(value.category),
    content,
    source: normalizeSource(value.source),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 1,
    tags: Array.isArray(value.tags)
      ? Array.from(new Set(value.tags
        .filter((tag): tag is string => typeof tag === 'string')
        .map((tag) => tag.trim().slice(0, 64))
        .filter(Boolean)))
        .slice(0, 20)
      : [],
    enabled: value.enabled !== false,
    createdAt,
    updatedAt: normalizeTimestamp(value.updatedAt, createdAt)
  };
}

function normalizeCategory(value: unknown): LegacyProjectMemoryCategory {
  const categories: LegacyProjectMemoryCategory[] = [
    'architecture',
    'preference',
    'command',
    'testing',
    'restriction',
    'project_note',
    'workflow'
  ];
  return categories.includes(value as LegacyProjectMemoryCategory)
    ? value as LegacyProjectMemoryCategory
    : 'project_note';
}

function normalizeSource(value: unknown): LegacyProjectMemorySource {
  return value === 'user' || value === 'agent_suggestion' || value === 'manual'
    ? value
    : 'manual';
}

function normalizeTimestamp(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
