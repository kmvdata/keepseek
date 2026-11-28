import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import { getMessageContentForAgent } from '../src/agent/protocol';
import {
  REFERENCE_INLINE_CEIL_CHARS,
  REFERENCE_INLINE_FLOOR_CHARS,
  resolveReferenceInlineBudget
} from '../src/context/references/referenceInlineBudget';
import { expandFileReferencesInPrompt } from '../src/context/references/fileReference';
import type { ChatMessage } from '../src/shared/types';

const POINTER_MARKER = '[引用未内联]';
const FIRST_MESSAGE_GUARD_CHARS = 32_000;

async function createWorkspace(t: TestContext, files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-inline-')));
  const previousFolders = vscode.workspace.workspaceFolders;
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = [
    { uri: vscode.Uri.file(root), name: 'fixture' }
  ];
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  t.after(async () => {
    (vscode.workspace as unknown as { workspaceFolders: unknown }).workspaceFolders = previousFolders;
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

/** The composer serializes a chip as a bracketed label line plus a standalone path line. */
function referenceBlock(labelContents: string, target: string): string {
  return `\n[${labelContents}]\n<${target}>\n`;
}

function countPointers(text: string): number {
  return (text.match(/\[引用未内联\]/gu) ?? []).length;
}

test('reference inline budget follows the declared window and keeps a conservative floor', () => {
  // No model at all, and both low-trust provenances, fall back to the floor
  // instead of scaling the budget from a placeholder window.
  assert.deepEqual(resolveReferenceInlineBudget(), { chars: REFERENCE_INLINE_FLOOR_CHARS, source: 'conservative' });
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 32_768, contextWindowSource: 'guessed' } }),
    { chars: REFERENCE_INLINE_FLOOR_CHARS, source: 'conservative' }
  );
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 32_768, contextWindowSource: 'fallback' } }),
    { chars: REFERENCE_INLINE_FLOOR_CHARS, source: 'conservative' }
  );

  // A declared but small window clamps up to the floor.
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 8_192, contextWindowSource: 'discovered' } }),
    { chars: REFERENCE_INLINE_FLOOR_CHARS, source: 'window' }
  );
  // A large declared window clamps down to the ceiling that stays under the
  // 32,000-character first-message guard.
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 131_072, contextWindowSource: 'manual' } }),
    { chars: REFERENCE_INLINE_CEIL_CHARS, source: 'window' }
  );
  // 15% of 32,768 tokens at four characters per token, clamped by neither bound.
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 32_768, contextWindowSource: 'built-in' } }),
    { chars: 19_660, source: 'window' }
  );
  // A declared window without recorded provenance is still a declaration.
  assert.deepEqual(
    resolveReferenceInlineBudget({ model: { contextWindowTokens: 100_000 } }),
    { chars: REFERENCE_INLINE_CEIL_CHARS, source: 'window' }
  );
});

test('three large references on a guessed window degrade to pointers instead of an oversized message', async t => {
  await createWorkspace(t, {
    'logs/test_discord_bot_message.log': 'a'.repeat(12_000),
    'logs/test_discord_bot_voice.log': 'b'.repeat(12_000),
    'logs/test_discord_bot_dm.log': 'c'.repeat(12_000)
  });
  const prompt = ['请分析这三个日志', ...[
    referenceBlock('test_discord_bot_message.log (全文)', './logs/test_discord_bot_message.log'),
    referenceBlock('test_discord_bot_voice.log (全文)', './logs/test_discord_bot_voice.log'),
    referenceBlock('test_discord_bot_dm.log (全文)', './logs/test_discord_bot_dm.log')
  ]].join('');

  const budget = resolveReferenceInlineBudget({ model: { contextWindowTokens: 32_768, contextWindowSource: 'guessed' } });
  const output = await expandFileReferencesInPrompt(prompt, {
    language: 'zh-CN',
    referenceInlineBudgetChars: budget.chars
  });

  assert.equal(countPointers(output), 3);
  assert.ok(output.length < FIRST_MESSAGE_GUARD_CHARS);
  assert.ok(output.includes('./logs/test_discord_bot_message.log'));
  assert.ok(output.includes('keepseek_read_workspace_file_range'));
  // The degraded lines must not keep claiming that the full file arrived.
  assert.ok(!output.includes('全文'));
});

test('a reference inside the budget still inlines byte for byte', async t => {
  await createWorkspace(t, { 'src/app.ts': 'const answer = 42;\n' });
  const prompt = `请解释这个文件${referenceBlock('app.ts (全文)', './src/app.ts')}`;

  const output = await expandFileReferencesInPrompt(prompt, {
    language: 'zh-CN',
    referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS
  });

  const expectedInlineBlock = [
    '请解释这个文件',
    '[app.ts (全文)]',
    '<./src/app.ts>',
    '```ts',
    'const answer = 42;',
    '```',
    ''
  ].join('\n');
  assert.equal(output, expectedInlineBlock);
  assert.ok(!output.includes(POINTER_MARKER));
});

test('line-range references keep their label and degrade only when the range is too large', async t => {
  const lines = Array.from({ length: 400 }, (_value, index) => `line ${index + 1} ${'x'.repeat(20)}`);
  await createWorkspace(t, { 'src/big.ts': `${lines.join('\n')}\n` });

  const small = await expandFileReferencesInPrompt(
    `看这里${referenceBlock('big.ts (L2-L3)', './src/big.ts#L2-L3')}`,
    { language: 'zh-CN', referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS }
  );
  assert.ok(!small.includes(POINTER_MARKER));
  assert.ok(small.includes('[big.ts (L2-L3)]'));
  assert.ok(small.includes('line 2 '));
  assert.ok(small.includes('line 3 '));
  assert.ok(!small.includes('line 4 '));

  const wide = await expandFileReferencesInPrompt(
    `看这里${referenceBlock('big.ts (L1-L400)', './src/big.ts#L1-L400')}`,
    { language: 'zh-CN', referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS }
  );
  assert.equal(countPointers(wide), 1);
  assert.ok(wide.includes('(L1-L400)'));
  assert.ok(wide.includes('./src/big.ts'));
  assert.ok(!wide.includes('line 1 '));
});

test('the inline budget is cumulative in reference order and is repeatable', async t => {
  const bodies = ['a', 'b', 'c'].map(character => character.repeat(400));
  await createWorkspace(t, { 'logs/a.log': bodies[0], 'logs/b.log': bodies[1], 'logs/c.log': bodies[2] });
  const prompt = ['a', 'b', 'c']
    .map(name => referenceBlock(`${name}.log (全文)`, `./logs/${name}.log`))
    .join('');

  const partialOptions = { language: 'zh-CN' as const, referenceInlineBudgetChars: 1_000 };
  const partial = await expandFileReferencesInPrompt(prompt, partialOptions);
  assert.equal(countPointers(partial), 1);
  assert.ok(partial.includes(bodies[0]));
  assert.ok(partial.includes(bodies[1]));
  assert.ok(!partial.includes(bodies[2]));
  // Same input, same budget, same bytes: the decision is not time dependent.
  assert.equal(await expandFileReferencesInPrompt(prompt, partialOptions), partial);

  const none = await expandFileReferencesInPrompt(prompt, { language: 'zh-CN', referenceInlineBudgetChars: 300 });
  assert.equal(countPointers(none), 3);
  assert.ok(!none.includes(bodies[0]));
});

test('a file above the per-file limit degrades instead of keeping its full-file label', async t => {
  await createWorkspace(t, { 'logs/huge.log': 'y'.repeat(210_000) });
  const output = await expandFileReferencesInPrompt(referenceBlock('huge.log (全文)', './logs/huge.log'), {
    language: 'zh-CN',
    referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS
  });

  assert.equal(countPointers(output), 1);
  assert.ok(output.includes('超过单文件内联上限 200,000 字节'));
  assert.ok(output.includes('；本轮内联预算 8,000 字符'));
  assert.ok(!output.includes('全文'));
});

test('pointer text leaks no host path and follows the message language', async t => {
  const root = await createWorkspace(t, { 'logs/test_discord_bot_message.log': 'z'.repeat(9_000) });
  const prompt = referenceBlock('test_discord_bot_message.log (全文)', './logs/test_discord_bot_message.log');

  const chinese = await expandFileReferencesInPrompt(prompt, {
    language: 'zh-CN',
    referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS
  });
  assert.ok(chinese.includes(
    '[引用未内联] test_discord_bot_message.log — ./logs/test_discord_bot_message.log（原因：超过单次内联预算 8,000 字符）。'
    + '需要内容时调用 keepseek_read_workspace_file_range（优先）或 keepseek_search_workspace 读取。'
  ));
  assert.ok(!chinese.includes(root));
  assert.ok(!chinese.includes(os.homedir()));
  assert.ok(!/file:\/\//u.test(chinese));

  const english = await expandFileReferencesInPrompt(prompt, {
    language: 'en',
    referenceInlineBudgetChars: REFERENCE_INLINE_FLOOR_CHARS
  });
  assert.ok(english.includes(
    '[reference not inlined] test_discord_bot_message.log — ./logs/test_discord_bot_message.log'
    + ' (reason: the file exceeds the single-reference inline budget of 8,000 characters).'
    + ' Call keepseek_read_workspace_file_range (preferred) or keepseek_search_workspace to read it.'
  ));
  assert.ok(!english.includes(root));
});

test('a deliberately oversized reference set stays below the first-message guard', async t => {
  const files: Record<string, string> = {};
  const references: string[] = [];
  for (let index = 0; index < 20; index += 1) {
    files[`logs/part-${index}.log`] = String(index % 10).repeat(4_000);
    references.push(referenceBlock(`part-${index}.log (全文)`, `./logs/part-${index}.log`));
  }
  await createWorkspace(t, files);

  const budget = resolveReferenceInlineBudget({ model: { contextWindowTokens: 131_072, contextWindowSource: 'manual' } });
  assert.equal(budget.chars, REFERENCE_INLINE_CEIL_CHARS);

  const output = await expandFileReferencesInPrompt(`整理这些日志${references.join('')}`, {
    language: 'zh-CN',
    referenceInlineBudgetChars: budget.chars
  });

  // 24,000 characters of inline budget at 4,000 per file: six files inline in
  // order, the remaining fourteen become pointers.
  assert.equal(countPointers(output), 14);
  assert.ok(
    output.length < FIRST_MESSAGE_GUARD_CHARS,
    `expected the expanded message to stay below the guard, got ${output.length} characters`
  );
});

test('stored expandedContent is replayed verbatim when the model window changes', async t => {
  const prompt = referenceBlock('big.log (全文)', './logs/big.log');
  await createWorkspace(t, { 'logs/big.log': 'q'.repeat(9_000) });

  const conservative = resolveReferenceInlineBudget({
    model: { contextWindowTokens: 32_768, contextWindowSource: 'fallback' }
  });
  const generous = resolveReferenceInlineBudget({
    model: { contextWindowTokens: 131_072, contextWindowSource: 'manual' }
  });
  assert.notEqual(conservative.chars, generous.chars);

  const stored = await expandFileReferencesInPrompt(prompt, {
    language: 'zh-CN',
    referenceInlineBudgetChars: conservative.chars
  });
  assert.equal(countPointers(stored), 1);
  const message = {
    id: 'user-1',
    role: 'user',
    content: prompt.trim(),
    expandedContent: stored,
    createdAt: '2026-01-01T00:00:00.000Z'
  } as unknown as ChatMessage;

  // The wider window inlines the same reference for a *new* message, while the
  // persisted message keeps the bytes it was committed with.
  const later = await expandFileReferencesInPrompt(prompt, {
    language: 'zh-CN',
    referenceInlineBudgetChars: generous.chars
  });
  assert.equal(countPointers(later), 0);
  assert.equal(getMessageContentForAgent(message), stored.trim());
  assert.equal(message.content, prompt.trim());
});