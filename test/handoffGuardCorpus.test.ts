import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  findPathLikeTokens,
  isOutsideRoot,
  normalizeRoots,
  renderGeneratedHandoffPrompt
} from '../src/agent/handoffPrompt';
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

test('the guard allows prose, routes, slash commands and project paths', () => {
  const allowed = [
    '补 POST /v1/chat/completions 分支',
    '新增 /api/users 这个路由',
    '然后执行 /test 并贴出结果',
    '/draft src/webview/script.ts',
    'The `/home` page needs a card',
    '修改 /Users/kermit/Projects/keepseek/src/agent/runner.ts',
    '修改 /Users/kermit/Projects/keepseek',
    '整理 src/agent/runner.ts 的注释'
  ];
  for (const text of allowed) assert.equal(verdict(text), 'PASS', text);
  // The project root itself normalizes to `.`, so it never reads as a host path.
  const rooted = renderGeneratedHandoffPrompt('Goal', '修改 /Users/kermit/Projects/keepseek/src/agent/runner.ts', 'en', roots);
  assert.ok(rooted.ok);
  assert.ok(rooted.body.includes('修改 ./src/agent/runner.ts'));
  assert.ok(!rooted.body.includes('/Users/kermit'));
});

test('the guard blocks host paths that no root covers, including CJK-adjacent prose', () => {
  const blocked = [
    '测试夹具放在 /tmp/keepseek-fixture',
    // The old leading character class omitted ideographs, so this path was never seen at all.
    '把结果写入/etc/hosts',
    '核对 /Users/kermit/Projects/keepseek-other/private.ts',
    'open file:///Users/kermit/x.ts',
    'update C:\\work\\x.ts',
    'open \\\\server\\share\\x.ts',
    '检查 /home/user/notes.md',
    'see /var/log/system.log'
  ];
  for (const text of blocked) assert.equal(verdict(text), 'disclosure', text);
});

test('a sibling directory is caught by root comparison instead of by prefix guessing', () => {
  // `keepseek-other` shares a prefix with the root but is not beneath it.
  assert.equal(isOutsideRoot('/Users/kermit/Projects/keepseek-other/private.ts', normalizeRoots(roots)), true);
  assert.equal(isOutsideRoot('/Users/kermit/Projects/keepseek/src/a.ts', normalizeRoots(roots)), false);
  assert.equal(isOutsideRoot('/Users/kermit/Projects/keepseek', normalizeRoots(roots)), false);
  // Routes, slash commands and a single-segment page name are not host paths.
  for (const route of ['/v1/chat/completions', '/api/users', '/test', '/home']) {
    assert.equal(isOutsideRoot(route, normalizeRoots(roots)), false, route);
  }
  assert.equal(isOutsideRoot('/home/user/x', normalizeRoots(roots)), true);
});

test('parent traversal is a structural property, not a disclosure, and stays as written', () => {
  // Deliberate decision: `../` reveals nothing about the host. It stays in the delivered text
  // and is only refused through the evidence guard. Do not restore a standalone refusal here.
  const preview = renderGeneratedHandoffPrompt('Goal', '核对 /Users/kermit/Projects/keepseek/../private.ts', 'en', roots);
  assert.ok(preview.ok);
  assert.ok(preview.body.includes('/Users/kermit/Projects/keepseek/../private.ts'));
  assert.ok(!preview.body.includes('核对 ./'), 'a traversing path must not collapse into the root');
});

test('root normalization accepts both URI and bare fsPath forms', () => {
  assert.deepEqual(normalizeRoots([root]), ['/Users/kermit/Projects/keepseek']);
  assert.deepEqual(normalizeRoots(['/Users/kermit/Projects/keepseek/']), ['/Users/kermit/Projects/keepseek']);
  assert.deepEqual(normalizeRoots([root, '/Users/kermit/Projects/keepseek']), ['/Users/kermit/Projects/keepseek']);
  // A bare fsPath previously threw inside `new URL()` and was skipped without any signal.
  const bare = renderGeneratedHandoffPrompt('Goal', '修改 /Users/kermit/Projects/keepseek/src/a.ts', 'en',
    ['/Users/kermit/Projects/keepseek']);
  assert.ok(bare.ok);
  assert.ok(bare.body.includes('./src/a.ts'));
});

test('candidates are extracted from CJK prose, tables, backticks and escapes', () => {
  assert.deepEqual(findPathLikeTokens('把结果写入/etc/hosts'), ['/etc/hosts']);
  assert.deepEqual(findPathLikeTokens('| /tmp/x | notes |'), ['/tmp/x']);
  assert.deepEqual(findPathLikeTokens('`/opt/homebrew/bin/brew`'), ['/opt/homebrew/bin/brew']);
  assert.deepEqual(findPathLikeTokens('（/Users/kermit/a.ts）。'), ['/Users/kermit/a.ts']);
  // Percent escapes are decoded before extraction.
  assert.deepEqual(findPathLikeTokens('路径%2Ftmp%2Fx'), ['/tmp/x']);
  assert.deepEqual(findPathLikeTokens('https://example.com/a/b'), []);
  assert.deepEqual(findPathLikeTokens('no paths here'), []);
});

test('tool evidence refuses an outside read even when the body never names the path', () => {
  const silent = renderGeneratedHandoffPrompt('Goal', 'Implement the counter in src/a.ts.', 'en', roots,
    rounds('keepseek_read_workspace_file', {
      ok: true, uri: 'file:///Users/kermit/elsewhere/secret.ts', fileSha256: 'a'.repeat(64)
    }));
  assert.deepEqual(silent, { ok: false, reason: 'disclosure' });
  const inside = renderGeneratedHandoffPrompt('Goal', 'Implement the counter in src/a.ts.', 'en', roots,
    rounds('keepseek_read_workspace_file', {
      ok: true, uri: 'file:///Users/kermit/Projects/keepseek/src/a.ts', fileSha256: 'a'.repeat(64)
    }));
  assert.ok(inside.ok);
});

test('a structured field naming an outside path refuses the body that quotes it', () => {
  const evidence = rounds('keepseek_read_evidence', { ok: true, path: '/Users/kermit/elsewhere/dump.json' });
  const quoted = renderGeneratedHandoffPrompt('Goal', 'Reuse /Users/kermit/elsewhere/dump.json as input.', 'en', roots, evidence);
  assert.deepEqual(quoted, { ok: false, reason: 'disclosure' });
  // The same evidence with a body that never references it is not a disclosure on its own.
  const unrelated = renderGeneratedHandoffPrompt('Goal', 'Reuse ./src/dump.json as input.', 'en', roots, evidence);
  assert.ok(unrelated.ok);
  // A `cwd` field is scanned like any other location field: quoted inside the root it passes,
  // quoted outside it the body is refused.
  const insideCwd = renderGeneratedHandoffPrompt('Goal', 'Reuse /Users/kermit/Projects/keepseek/src/a.ts.', 'en', roots,
    rounds('keepseek_read_evidence', { ok: true, cwd: '/Users/kermit/Projects/keepseek' }));
  assert.ok(insideCwd.ok);
  const outsideCwd = renderGeneratedHandoffPrompt('Goal', 'Reuse /Users/kermit/Projects/keepseek-research/b.ts.', 'en', roots,
    rounds('keepseek_read_evidence', { ok: true, cwd: '/Users/kermit/Projects/keepseek-research' }));
  assert.deepEqual(outsideCwd, { ok: false, reason: 'disclosure' });
});

test('a value that is nothing but a path counts even under an unrecognised key', () => {
  const body = 'Reuse /Users/kermit/elsewhere/dump.json as input.';
  for (const key of ['origin', 'folderUris', 'source']) {
    const quoted = renderGeneratedHandoffPrompt('Goal', body, 'en', roots,
      rounds('keepseek_read_evidence', { ok: true, [key]: '/Users/kermit/elsewhere/dump.json' }));
    assert.deepEqual(quoted, { ok: false, reason: 'disclosure' }, key);
  }
  // A sentence that merely mentions the path is prose, not a location field.
  const prose = renderGeneratedHandoffPrompt('Goal', 'Reuse ./src/dump.json as input.', 'en', roots,
    rounds('keepseek_read_evidence', { ok: true, note: 'the user mentioned /Users/kermit/elsewhere/dump.json' }));
  assert.ok(prose.ok);
});

test('the structured scan is bounded in depth, string length and node count', () => {
  const envelope = (depth: number) => {
    let node: Record<string, unknown> = { path: '/Users/kermit/elsewhere/deep.ts' };
    for (let i = 0; i < depth; i++) node = { nested: node };
    return node;
  };
  const body = 'Reuse /Users/kermit/elsewhere/deep.ts as input.';
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', body, 'en', roots,
    rounds('keepseek_read_evidence', envelope(1))), { ok: false, reason: 'disclosure' });
  // Beyond the depth budget the field is not inspected; the body's own root comparison still
  // decides, and it also refuses this path.
  assert.deepEqual(renderGeneratedHandoffPrompt('Goal', body, 'en', roots,
    rounds('keepseek_read_evidence', envelope(8))), { ok: false, reason: 'disclosure' });
  const oversized = 'Reuse it.';
  const huge = renderGeneratedHandoffPrompt('Goal', oversized, 'en', roots, rounds('keepseek_read_evidence', {
    ok: true, path: '/Users/kermit/elsewhere/' + 'a'.repeat(5_000) + '.ts'
  }));
  assert.ok(huge.ok, 'a value beyond the per-string limit is skipped rather than scanned');
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