import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  authorizeWrite,
  assertWriteAuthorized,
  installWriteGateAuthority,
  type WriteGateAuthority
} from '../src/sessions/queue/writeGate';

/**
 * The write gate is the enforcement point the queue design needs: a `plan` label
 * must not merely be cosmetically different, a non-head session must actually be
 * unable to modify the workspace.
 *
 * These tests pin the gate contract. The host installs a queue-backed authority;
 * here a stub authority stands in for it.
 */

function withAuthority<T>(authority: WriteGateAuthority | undefined, run: () => T): T {
  installWriteGateAuthority(authority);
  try { return run(); } finally { installWriteGateAuthority(undefined); }
}

const headOnly: WriteGateAuthority = {
  authorize(sessionId) {
    return sessionId === 'head'
      ? { allowed: true }
      : { allowed: false, code: 'not_queue_head', message: 'Only the queue head may write.' };
  }
};

test('without an installed authority the gate is permissive (headless and test hosts)', () => {
  installWriteGateAuthority(undefined);
  assert.equal(authorizeWrite('any', 'edit').allowed, true);
  assert.equal(authorizeWrite('any', 'command').allowed, true);
});

test('an installed authority refuses a non-head session for every capability', () => {
  withAuthority(headOnly, () => {
    for (const capability of ['edit', 'command', 'validation', 'git_mutation'] as const) {
      const result = authorizeWrite('behind', capability);
      assert.equal(result.allowed, false, capability);
      assert.equal(result.allowed === false && result.code, 'not_queue_head');
    }
  });
});

test('the queue head is allowed to write', () => {
  withAuthority(headOnly, () => {
    assert.equal(authorizeWrite('head', 'edit').allowed, true);
  });
});

test('an empty session id is refused even when no authority is installed', () => {
  installWriteGateAuthority(headOnly);
  try {
    const result = authorizeWrite('', 'edit');
    assert.equal(result.allowed, false);
  } finally { installWriteGateAuthority(undefined); }
});

test('assertWriteAuthorized throws with the authority message for a refused session', () => {
  withAuthority(headOnly, () => {
    assert.throws(() => assertWriteAuthorized('behind', 'edit'), /queue head/u);
    assert.doesNotThrow(() => assertWriteAuthorized('head', 'edit'));
  });
});

test('installing undefined restores the permissive gate after a restrictive one', () => {
  withAuthority(headOnly, () => {
    assert.equal(authorizeWrite('behind', 'edit').allowed, false);
  });
  assert.equal(authorizeWrite('behind', 'edit').allowed, true);
});