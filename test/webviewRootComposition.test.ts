import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';
import { getStyles } from '../src/webview/styles';
import { getTemplate } from '../src/webview/template';

// Root-composition guards for the Webview shell. The per-feature fragments
// under src/webview/input/ are already covered by inputComposition.test.ts
// (frozen input hashes, input DOM id uniqueness, and `new Function` on the
// input script); this file guards the root shell that composes them together
// with the transcript/ChangeSet/DraftRun fragments, where a fragment move can
// silently break ordering or collide identifiers inside the shared IIFE.

const ROOT_TEMPLATE_MARKERS = [
  '<section id="transcript"',
  'id="unlinkedChangeSetRegion"',
  'id="planRegion"',
  'id="settingsMenu"',
  'id="sessionMenu"',
  'id="composer"'
] as const;

const ROOT_STYLE_SELECTORS = ['.transcript', '.composer-input-inner', '.draft-bar', '.change-set-actions'] as const;

test('root shell template keeps its region landmarks and one id per element', () => {
  const template = getTemplate();
  assert.ok(template.length > 0);
  for (const marker of ROOT_TEMPLATE_MARKERS) {
    assert.ok(template.includes(marker), `missing ${marker}`);
  }

  // getTemplate() is pure markup: every id in it belongs to a real element, so
  // duplicates are a genuine DOM bug. The input subtree is checked separately.
  assert.doesNotMatch(template, /<script\b/iu);
  const ids = [...template.matchAll(/\sid="([^"]+)"/gu)].map((match) => match[1]);
  assert.ok(ids.length > 0);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual([...new Set(duplicates)], [], `duplicate root template ids: ${[...new Set(duplicates)].join(', ')}`);
});

test('root stylesheet keeps the shell selectors the transcript depends on', () => {
  const styles = getStyles();
  assert.ok(styles.length > 0);
  for (const selector of ROOT_STYLE_SELECTORS) {
    assert.ok(styles.includes(selector), `missing ${selector}`);
  }
});

test('root script compiles as one inline script', () => {
  // inputComposition.test.ts already compiles the input script; re-checking the
  // composed root script catches braces left open across a fragment boundary,
  // which only shows up once the fragments are concatenated.
  const script = getScript();
  assert.ok(script.length > 0);
  assert.doesNotThrow(() => new Function(script));
});

test('root script declares no top-level name twice under different kinds', () => {
  // Every fragment is spliced into one IIFE. composeWebviewFragments() only
  // checks fragment ids, so a relocation that reintroduces a helper under a
  // name already used elsewhere would silently shadow (function/var) or throw
  // at run time (const/let). Top-level declarations are exactly the lines at
  // 4 spaces: bodies are nested deeper, so ` {4}` (not `\s{4}`) is required —
  // `\s` would span newlines and also match 5/6-space continuation lines.
  const script = getScript();
  const functions = [...script.matchAll(/^ {4}function ([A-Za-z_$][\w$]*)\s*\(/gmu)].map((match) => match[1]);
  const variables = [...script.matchAll(/^ {4}(?:var|let|const) ([A-Za-z_$][\w$]*)/gmu)].map((match) => match[1]);
  assert.ok(functions.length > 0 && variables.length > 0);

  // A repeated `function` declaration is legal in sloppy mode (the later one
  // wins) and is not what this guard is about; a name that is both a function
  // and a binding is the relocation hazard.
  const variableNames = new Set(variables);
  const declaredTwice = [...new Set(functions.filter((name) => variableNames.has(name)))];
  assert.deepEqual(declaredTwice, [], `declared as both function and var/let/const: ${declaredTwice.join(', ')}`);

  const duplicateVariables = [...new Set(variables.filter((name, index) => variables.indexOf(name) !== index))];
  assert.deepEqual(duplicateVariables, [], `var/let/const declared twice: ${duplicateVariables.join(', ')}`);
});

test('root stylesheet keeps transcript, header and draft regions in cascade order', () => {
  // Cascade order, not the full selector list: freezing every selector would
  // force a re-record on each style tweak, while these three relations are what
  // later-region overrides actually depend on.
  const order = [...getStyles().matchAll(/^ {4}(\.[a-zA-Z][\w-]*)/gmu)].map((match) => match[1]);
  const position = (selector: string): number => order.indexOf(selector);
  const relations: ReadonlyArray<readonly [string, string]> = [
    ['.transcript', '.message-code-block'],
    ['.session-menu', '.context-bar'],
    ['.draft-bar', '.change-set-actions']
  ];
  for (const [earlier, later] of relations) {
    const earlierAt = position(earlier);
    const laterAt = position(later);
    assert.ok(earlierAt >= 0, `missing ${earlier}`);
    assert.ok(laterAt >= 0, `missing ${later}`);
    assert.ok(earlierAt < laterAt, `${earlier} must be declared before ${later} (${earlierAt} vs ${laterAt})`);
  }
});