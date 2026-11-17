import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';

// draftRunBatch.test.ts builds its sandbox by slicing getScript() with
//   source.indexOf('    function ' + name + '(')  ->  next '\n    function '
// so a named function must keep that exact 4-space declaration form, and the
// slice must contain that one declaration plus nothing but content the harness
// is known to tolerate. Anything else spliced between two functions (a helper
// `const`, a comment, a stray statement) is swallowed silently: it just runs in
// the sandbox, so only a structural check like this one notices a fragment
// boundary that dragged extra lines along.

const NAMES_SOURCE = path.resolve(process.cwd(), 'test/draftRunBatch.test.ts');

// Top-level statements the harness slice is allowed to carry after the named
// function's closing brace. `handleDraftRunActionClick` is registered by a
// top-level `transcript.addEventListener(...)` before the next declaration, and
// that line has always been inside its slice; `transcript` is injected by the
// sandbox, so it executes harmlessly. Listing it explicitly keeps the rule
// exact instead of loosening it to "any statement goes".
const ALLOWED_TRAILING_STATEMENTS: Readonly<Record<string, readonly string[]>> = {
  handleDraftRunActionClick: ["transcript.addEventListener('click', handleDraftRunActionClick);"]
};

/** Read the function-name list the sandbox harness slices, from its own source. */
function readHarnessNames(): string[] {
  const source = readFileSync(NAMES_SOURCE, 'utf8');
  const block = /const names = \[([\s\S]*?)\];/u.exec(source);
  assert.ok(block, 'draftRunBatch.test.ts no longer declares `const names = [...]`');
  const names = [...block[1].matchAll(/'([A-Za-z_$][\w$]*)'/gu)].map((match) => match[1]);
  assert.ok(names.length > 0, 'no function names found in the draftRunBatch harness');
  return names;
}

/** Return the slice the harness would build, after proving it wraps exactly one declaration. */
function sliceAsHarness(script: string, name: string): string {
  const start = script.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, `missing '    function ${name}(' in getScript()`);
  const next = script.indexOf('\n    function ', start + 1);
  const end = next === -1 ? script.length : next;
  const slice = script.slice(start, end);

  // Brace balance proves the slice closes the declaration it opened; the text
  // after that closing brace must then be empty or explicitly allowed.
  let depth = 0;
  let closedAt = -1;
  for (let index = start; index < end; index += 1) {
    const char = script[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth < 0) break;
      if (depth === 0) {
        closedAt = index;
        break;
      }
    }
  }
  assert.ok(closedAt >= 0, `${name}: unbalanced braces in slice`);

  const trailing = script.slice(closedAt + 1, end).split('\n').map((line) => line.trim()).filter(Boolean);
  const allowed = ALLOWED_TRAILING_STATEMENTS[name] ?? [];
  const unexpected = trailing.filter((line) => !allowed.includes(line));
  assert.deepEqual(
    unexpected,
    [],
    `${name} slice carries non-declaration content after its closing brace: ${JSON.stringify(unexpected)}`
  );
  return slice;
}

test('draftRunBatch sandbox slices still capture exactly one whole declaration', () => {
  const script = getScript();
  const names = readHarnessNames();
  const failures: string[] = [];
  for (const name of names) {
    try {
      sliceAsHarness(script, name);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  assert.deepEqual(failures, [], `draftRunBatch slices degraded:\n${failures.join('\n')}`);
  // Guard the guard: the harness list is the contract this test protects.
  assert.ok(names.length >= 44, `harness lost function names (found ${names.length})`);
});

test('every allowed trailing statement is still present in its slice', () => {
  // An allowance that no longer matches anything would silently widen later, so
  // keep it tied to what the generated script actually contains.
  const script = getScript();
  for (const [name, statements] of Object.entries(ALLOWED_TRAILING_STATEMENTS)) {
    const slice = sliceAsHarness(script, name);
    for (const statement of statements) {
      assert.ok(slice.includes(statement), `${name} slice no longer contains ${statement}`);
    }
  }
});