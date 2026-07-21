import type {
  RunContextDiscardedSource,
  RunContextSourceKind
} from '../shared/types';
import { hashContent, normalizeUri } from './projectInstructions';

export interface ContextSourceCandidate<T> {
  id: string;
  kind: RunContextSourceKind;
  label: string;
  uri?: string;
  content: string;
  contentHash?: string;
  priority: number;
  value: T;
}

export interface ContextDeduplicationResult<T> {
  kept: ContextSourceCandidate<T>[];
  discarded: RunContextDiscardedSource[];
  possibleConflicts: Array<{ leftId: string; rightId: string; reason: string }>;
  beforeCount: number;
  afterCount: number;
}

export function deduplicateContextSources<T>(
  candidates: readonly ContextSourceCandidate<T>[]
): ContextDeduplicationResult<T> {
  const ordered = candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => left.candidate.priority - right.candidate.priority || left.index - right.index)
    .map((item) => item.candidate);
  const kept: ContextSourceCandidate<T>[] = [];
  const discarded: RunContextDiscardedSource[] = [];
  const possibleConflicts: Array<{ leftId: string; rightId: string; reason: string }> = [];
  const seenUris = new Map<string, ContextSourceCandidate<T>>();
  const seenHashes = new Map<string, ContextSourceCandidate<T>>();
  const seenLabels = new Map<string, ContextSourceCandidate<T>>();

  for (const candidate of ordered) {
    const uriKey = candidate.uri ? normalizeUri(candidate.uri) : '';
    const contentHash = candidate.contentHash || hashContent(candidate.content);
    const duplicateUri = uriKey ? seenUris.get(uriKey) : undefined;
    if (duplicateUri) {
      discarded.push(createDiscarded(candidate, 'duplicate_uri', duplicateUri.id));
      continue;
    }
    const duplicateContent = contentHash ? seenHashes.get(contentHash) : undefined;
    if (duplicateContent) {
      discarded.push(createDiscarded(candidate, 'duplicate_content', duplicateContent.id));
      continue;
    }

    const labelKey = normalizeLabel(candidate.label);
    const similarLabel = labelKey ? seenLabels.get(labelKey) : undefined;
    if (similarLabel && similarLabel.contentHash !== contentHash) {
      possibleConflicts.push({
        leftId: similarLabel.id,
        rightId: candidate.id,
        reason: 'Same normalized source label with different content; both were retained.'
      });
    }

    const normalizedCandidate = { ...candidate, contentHash };
    kept.push(normalizedCandidate);
    if (uriKey) {
      seenUris.set(uriKey, normalizedCandidate);
    }
    if (contentHash) {
      seenHashes.set(contentHash, normalizedCandidate);
    }
    if (labelKey) {
      seenLabels.set(labelKey, normalizedCandidate);
    }
  }

  return {
    kept,
    discarded,
    possibleConflicts,
    beforeCount: candidates.length,
    afterCount: kept.length
  };
}

function createDiscarded<T>(
  candidate: ContextSourceCandidate<T>,
  reason: 'duplicate_uri' | 'duplicate_content',
  keptId: string
): RunContextDiscardedSource {
  return {
    id: candidate.id,
    kind: candidate.kind,
    uri: candidate.uri,
    reason,
    keptId
  };
}

function normalizeLabel(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/gu, ' ');
}
