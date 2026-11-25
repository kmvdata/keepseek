import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ChatMessage } from '../src/shared/types';

const SCOPE = {
  key: 'folders:file:///w/message-attachments',
  name: 'message-attachments',
  folderUris: ['folders:file:///w/message-attachments']
};
const SHA256 = 'a'.repeat(64);
const CREATED_AT = '2026-01-01T00:00:00.000Z';

function storedSession(attachments: unknown[]): unknown {
  return {
    sessions: [{
      id: 'session-1',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      workspaceKey: SCOPE.key,
      messages: [{
        id: 'message-1',
        role: 'user',
        content: 'hello',
        createdAt: CREATED_AT,
        attachments
      }]
    }]
  };
}

function attachmentsOf(attachments: unknown[]): NonNullable<ChatMessage['attachments']> {
  const [session] = normalizeStoredSessions(storedSession(attachments), SCOPE);
  assert.ok(session, 'the message container must survive normalization');
  return session.messages[0].attachments ?? [];
}

function image(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'attachment-1',
    kind: 'image',
    scope: 'user',
    sha256: SHA256,
    mimeType: 'image/png',
    bytes: 2048,
    width: 512,
    height: 512,
    createdAt: CREATED_AT,
    ...overrides
  };
}

test('a valid image attachment survives with its optional fields', () => {
  const [attachment] = attachmentsOf([image({
    originalBytes: 8192,
    originalWidth: 1024,
    originalHeight: 1024,
    sourceName: 'paste.png'
  })]);
  assert.deepEqual(attachment, {
    id: 'attachment-1',
    kind: 'image',
    scope: 'user',
    sha256: SHA256,
    mimeType: 'image/png',
    bytes: 2048,
    width: 512,
    height: 512,
    originalBytes: 8192,
    originalWidth: 1024,
    originalHeight: 1024,
    sourceName: 'paste.png',
    createdAt: CREATED_AT
  });
});

test('invalid attachment entries are dropped while the message is kept', () => {
  const attachments = attachmentsOf([
    image({ id: 'uppercase-sha', sha256: 'A'.repeat(64) }),
    image({ id: 'short-sha', sha256: 'a'.repeat(63) }),
    image({ id: 'unsupported-mime', mimeType: 'image/svg+xml' }),
    image({ id: 'wrong-kind', kind: 'file' }),
    image({ id: 'wrong-scope', scope: 'assistant' }),
    image({ id: 'zero-bytes', bytes: 0 }),
    image({ id: 'fractional-width', width: 512.5 }),
    image({ id: 'missing-created-at', createdAt: undefined }),
    image({ id: 'kept-1' })
  ]);
  assert.deepEqual(attachments.map((attachment) => attachment.id), ['kept-1']);
});

test('duplicate attachment ids are dropped after the first entry', () => {
  const attachments = attachmentsOf([
    image({ id: 'same-id', bytes: 2048 }),
    image({ id: 'same-id', bytes: 4096 })
  ]);
  assert.deepEqual(
    attachments.map((attachment) => [attachment.id, attachment.bytes]),
    [['same-id', 2048]]
  );
});

test('more than eight attachments keep only the first eight valid entries', () => {
  const attachments = attachmentsOf(
    Array.from({ length: 10 }, (_, index) => image({ id: `attachment-${index}` }))
  );
  assert.deepEqual(attachments.map((attachment) => attachment.id), [
    'attachment-0',
    'attachment-1',
    'attachment-2',
    'attachment-3',
    'attachment-4',
    'attachment-5',
    'attachment-6',
    'attachment-7'
  ]);
});