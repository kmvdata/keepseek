export {};

import type { ChatSession } from '../src/shared/types';

/** Minimal ChatSession fixture for provider-level tests. */
export function createSession(input: { id: string; approvalMode?: 'ask' | 'approve-all' }): ChatSession & {
  approvalMode?: 'ask' | 'approve-all';
} {
  return {
    id: input.id,
    title: 'Approve all',
    messages: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    approvalMode: input.approvalMode
  } as unknown as ChatSession;
}