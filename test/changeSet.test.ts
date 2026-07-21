import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChangeSet } from '../src/edits/changeSet';

test('creates one structured ChangeSet for multiple draft edits', () => {
  const changeSet = createChangeSet({
    runId: 'run-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    edits: [
      {
        id: 'edit-1',
        uri: 'file:///workspace/a.ts',
        label: 'a.ts',
        action: 'modify',
        newText: 'export const a = 1;\n',
        reason: 'Update A'
      },
      {
        id: 'edit-2',
        uri: 'file:///workspace/b.ts',
        label: 'b.ts',
        action: 'create',
        newText: 'export const b = 2;\n',
        reason: 'Add B'
      }
    ]
  });

  assert.ok(changeSet);
  assert.equal(changeSet.fileCount, 2);
  assert.equal(changeSet.sessionId, 'session-1');
  assert.equal(changeSet.messageId, 'message-1');
  assert.deepEqual(changeSet.files.map((file) => file.status), ['pending', 'pending']);
  assert.match(changeSet.operationSummary, /Update A/u);
});
