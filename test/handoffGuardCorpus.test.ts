import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { renderGeneratedHandoffPrompt } from '../src/agent/handoffPrompt';
import { hasPrivateKeyBlock, redactSensitiveMaterial } from '../src/approvals/sensitiveText';

const root = 'file:///Users/kermit/Projects/keepseek';
const roots = [root];

function rounds(toolName: string, result: unknown): NonNullable<Parameters<typeof renderGeneratedHandoffPrompt>[4]> {
  return [{
    assistantContent: null, reasoningContent: null,
    toolCalls: [{ id: 'call', type: 'function', function: { name: toolName, arguments: '{}' } }],
    toolResults: [{ toolCallId: 'call', content: JSON.stringify(result) }]
  }];
}

function verdict(text: string, folders: readonly string[] = roots): string {
  const preview = renderGeneratedHandoffPrompt('Goal', text, 'en', folders);
  return preview.ok ? 'PASS' : preview.reason;
}

test('external absolute paths stay verbatim in the delivered body', () => {
  const samples = [
    '测试夹具放在 /tmp/keepseek-fixture',
    '把结果写入/etc/hosts',
    '核对 /Users/kermit/Projects/keepseek-other/private.ts',
    'open file:///Users/kermit/x.ts',
    'update C:\\work\\x.ts',
    'open \\\\server\\share\\x.ts',
    '检查 /home/user/notes.md',
    'see /var/log/system.log'
  ];
  for (const text of samples) {
    const preview = renderGeneratedHandoffPrompt('Goal', text, 'en', roots);
    assert.ok(preview.ok, text);
    assert.ok(preview.body.includes(text), text);
    assert.equal(preview.bodyHash, createHash('sha256').update(preview.body).digest('hex'), text);
  }
  const traversal = renderGeneratedHandoffPrompt('Goal',
    '核对 /Users/kermit/Projects/keepseek/../private.ts', 'en', roots);
  assert.ok(traversal.ok);
  assert.ok(traversal.body.includes('/Users/kermit/Projects/keepseek/../private.ts'));
  assert.ok(!traversal.body.includes('核对 ./'), 'a traversing path must not collapse into the root');
});

test('project absolute paths are rewritten to project-relative paths', () => {
  const rooted = renderGeneratedHandoffPrompt('Goal', '修改 /Users/kermit/Projects/keepseek/src/agent/runner.ts', 'en', roots);
  assert.ok(rooted.ok);
  assert.ok(rooted.body.includes('修改 ./src/agent/runner.ts'));
  assert.ok(!rooted.body.includes('/Users/kermit'));
  const bare = renderGeneratedHandoffPrompt('Goal', '修改 /Users/kermit/Projects/keepseek/src/a.ts', 'en',
    ['/Users/kermit/Projects/keepseek']);
  assert.ok(bare.ok);
  assert.ok(bare.body.includes('./src/a.ts'));
});

test('external reads and structured evidence no longer refuse the body', () => {
  const externalRead = rounds('keepseek_read_workspace_file', {
    ok: true, uri: 'file:///Users/kermit/elsewhere/secret.ts', fileSha256: 'a'.repeat(64)
  });
  const silent = renderGeneratedHandoffPrompt('Goal', 'Implement the counter in src/a.ts.', 'en', roots, externalRead);
  assert.ok(silent.ok);
  assert.equal(silent.body, 'Implement the counter in src/a.ts.');
  const quotedRead = renderGeneratedHandoffPrompt('Goal', 'Reuse /Users/kermit/elsewhere/secret.ts as input.', 'en',
    roots, externalRead);
  assert.ok(quotedRead.ok);
  assert.ok(quotedRead.body.includes('/Users/kermit/elsewhere/secret.ts'));
  const evidence = rounds('keepseek_read_evidence', { ok: true, path: '/Users/kermit/elsewhere/dump.json',
    nested: { cwd: '/tmp/keepseek-fixture' } });
  const quotedEvidence = renderGeneratedHandoffPrompt('Goal',
    'Reuse /Users/kermit/elsewhere/dump.json and /tmp/keepseek-fixture as input.', 'en', roots, evidence);
  assert.ok(quotedEvidence.ok);
  assert.ok(quotedEvidence.body.includes('/Users/kermit/elsewhere/dump.json'));
  const inside = renderGeneratedHandoffPrompt('Goal', 'Update src/a.ts.', 'en', roots,
    rounds('keepseek_read_workspace_file', {
      ok: true, uri: 'file:///Users/kermit/Projects/keepseek/src/a.ts', fileSha256: 'b'.repeat(64)
    }));
  assert.ok(inside.ok);
  assert.ok(inside.body.endsWith('## File-content SHA-256 at inspection\n\n- `./src/a.ts` — `'
    + 'b'.repeat(64) + '`'), inside.body);
  assert.ok(!silent.body.includes('SHA-256'), 'an external read never enters the checksum appendix');
});

test('missing context and oversize remain guards', () => {
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'See the above message.', 'en', roots),
    { ok: false, reason: 'missing_context' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'Use ' + 'a'.repeat(64), 'en', roots),
    { ok: false, reason: 'missing_context' });
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', 'x'.repeat(32_001), 'en', roots),
    { ok: false, reason: 'oversize' });
});
test('a private key header is still a hard refusal, while credentials are only rewritten', () => {
  assert.equal(hasPrivateKeyBlock('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(hasPrivateKeyBlock('-----BEGIN OPENSSH PRIVATE KEY-----'), true);
  assert.equal(hasPrivateKeyBlock('-----BEGIN PUBLIC KEY-----'), false);
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', '-----BEGIN RSA PRIVATE KEY-----', 'en', roots),
    { ok: false, reason: 'disclosure' });
  // Every other credential shape is rewritten in place and delivered.
  const rewritten = [
    ['密码至少 12 位：password=123456789012', '密码至少 12 位：password=[REDACTED]'],
    ['token sk-aB3dE9fG2hJ5kL8mN1pQ4rS7', 'token sk-[REDACTED]'],
    ['AWS ' + 'AKIA' + 'ABCDEFGHIJKLMNOP', 'AWS [REDACTED]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'jwt [REDACTED]'],
    ['Authorization: Bearer ' + 'aB3dE9fG2hJ5kL8mN1pQ4rS7T0uV', 'Authorization: [REDACTED]'],
    // The pattern covers the scheme and the userinfo; the host stays readable on purpose.
    ['https://alice:hunter2@db.internal/app', '[REDACTED]db.internal/app']
  ];
  for (const [text, expected] of rewritten) {
    assert.equal(redactSensitiveMaterial(text), expected, text);
    const preview = renderGeneratedHandoffPrompt('Goal', text, 'en', roots);
    assert.ok(preview.ok, text);
    assert.ok(preview.body.includes(expected), text);
  }
});

test('documentation placeholders survive untouched', () => {
  const kept = [
    '配置 apiKey=YOUR_API_KEY_HERE 后重试',
    '设置 ANTHROPIC_KEY=sk-ant-YOUR-KEY-HERE-PLACEHOLDER',
    '示例 AKIAIOSFODNN7EXAMPLE',
    'token ghp_' + 'x'.repeat(24),
    'client_secret=000000000000',
    'client_secret=************',
    'api_key=${API_TOKEN}',
    'api_key=<your-token-here>',
    'api_key={{token}}',
    'api_key=abc123def456...'
  ];
  for (const text of kept) {
    assert.equal(redactSensitiveMaterial(text), text, text);
    assert.equal(verdict(text), 'PASS', text);
  }
});

test('every pattern in the credential list is disposed of as documented', () => {
  // The table mirrors the comment block in src/approvals/sensitiveText.ts: #1 refuses the
  // body, #2-#10 are rewritten, and only the marked ones honour a placeholder.
  const table: ReadonlyArray<readonly [string, string, string, boolean]> = [
    ['1 PEM header', '-----BEGIN RSA PRIVATE KEY-----', 'disclosure', false],
    ['2 AKIA', 'AKIA' + 'ABCDEFGHIJKLMNOP', 'redacted', true],
    ['3 AIza', 'AIza' + 'bC3dE9fG2hJ5kL8mN1pQ4rS7tU0vW2xY5zA', 'redacted', false],
    ['4 sk-', 'sk-aB3dE9fG2hJ5kL8mN1pQ4rS7', 'redacted', true],
    ['5 glpat-', 'glpat-abcdefghijklmnop1234', 'redacted', false],
    ['6 gh*_', 'ghp_abcdefghijklmnopqrstuvwx', 'redacted', true],
    ['7 JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'redacted', false],
    ['8 Bearer', 'Bearer aB3dE9fG2hJ5kL8mN1pQ4rS7T0uV', 'redacted', false],
    ['9 URL userinfo', 'https://user:pass@example.com/db', 'redacted', false],
    ['10 key=value', 'password=123456789012', 'redacted', true]
  ];
  for (const [label, sample, disposition, placeholderExempt] of table) {
    const preview = renderGeneratedHandoffPrompt('Goal', sample, 'en', roots);
    if (disposition === 'disclosure') {
      assert.deepEqual(preview, { ok: false, reason: 'disclosure' }, label);
      assert.equal(redactSensitiveMaterial(sample), sample, label + ' is never rewritten by the redactor');
      continue;
    }
    assert.ok(preview.ok, label);
    assert.ok(preview.body.includes('[REDACTED]'), label);
    assert.ok(!preview.body.includes(sample), label + ' leaves no raw credential material');
    if (placeholderExempt) {
      const placeholder = sample.replace(/[A-Za-z0-9]{6,}$/u, 'YOUR_PLACEHOLDER');
      assert.equal(redactSensitiveMaterial(placeholder), placeholder, label + ' honours a documented placeholder');
    }
  }
});

test('redaction is idempotent and never truncates', () => {
  const mixed = ['password=123456789012', 'token sk-aB3dE9fG2hJ5kL8mN1pQ4rS7',
    'Authorization: Bearer aB3dE9fG2hJ5kL8mN1pQ4rS7T0uV', 'https://u:hunter2@host/db',
    'AKIA' + 'ABCDEFGHIJKLMNOP'].join('\n');
  const once = redactSensitiveMaterial(mixed);
  assert.equal(redactSensitiveMaterial(once), once);
  assert.ok(!/123456789012|sk-aB3|Bearer aB3|hunter2@/.test(once));

  const filler = 'x'.repeat(29_900);
  const long = renderGeneratedHandoffPrompt('Goal', filler + ' token sk-aB3dE9fG2hJ5kL8mN1pQ4rS7', 'en', roots);
  assert.ok(long.ok);
  assert.ok(long.body.length > 1_200, 'the delivered body must not reuse the 1200-char review cap');
  assert.ok(long.body.includes('[REDACTED]'));
  assert.ok(!long.body.includes('sk-aB3dE9fG2hJ5kL8mN1pQ4rS7'));
  // The preview hash always describes the delivered bytes.
  assert.equal(long.bodyHash, createHash('sha256').update(long.body, 'utf8').digest('hex'));
});