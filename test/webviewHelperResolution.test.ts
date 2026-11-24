import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';

/**
 * A dangling helper call is not a local defect: the webview script is a single
 * IIFE, so the ReferenceError aborts everything declared after it — including
 * the host-message listener, the state reducer and every composer binding. The
 * window then renders its static HTML but never becomes interactive: the
 * composer answers every send with "the conversation is not ready" and menu
 * rows fire a postMessage nobody handles.
 *
 * Deleted features leave calls behind (the execution-mode control is the
 * confirmed case), and neither `tsc` nor `new Function()` can see it because
 * the script is assembled from string fragments. This test is the missing
 * check: every helper-shaped call must resolve to something the script declares.
 */

/** Calls that are legitimately host-provided globals, not local helpers. */
const HOST_GLOBALS = new Set([
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI',
  'decodeURI', 'btoa', 'atob', 'structuredClone', 'queueMicrotask'
]);

/** Only these names are treated as project helpers: the script's own naming
 * convention for functions it declares. Bare words, model ids and status
 * strings never match, so the scan stays free of false positives. */
const HELPER_CALL = /(?:^|[^.\w$])((?:render|apply|sync|refresh|close|open|update|reset|clear|build|create|collect|ensure|resolve|normalize|read|write|stop|start|toggle|can|is|has|get|set)[A-Z][\w$]*)\s*\(/gmu;

/** Every name the assembled script can call without qualification: hoisted
 * function declarations, `var`/`let`/`const` bindings and parameter names. */
function declaredNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/gu)) names.add(match[1]);
  for (const match of source.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*[=;,]/gu)) names.add(match[1]);
  for (const match of source.matchAll(/(?:function\s*[A-Za-z_$\w]*\s*)?\(([^)]*)\)\s*(?:=>|\{)/gu)) {
    for (const parameter of match[1].split(',')) {
      const name = parameter.trim().split(/[\s=:.](?=[^=]*$)/u)[0]?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
    }
  }
  return names;
}

test('every helper the webview script calls is declared by the script', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  const declared = declaredNames(script);
  const dangling = new Set<string>();
  for (const match of script.matchAll(HELPER_CALL)) {
    const name = match[1];
    if (declared.has(name) || HOST_GLOBALS.has(name)) continue;
    dangling.add(name);
  }

  assert.deepEqual([...dangling].sort(), [],
    `the webview script calls helpers it never declares: ${[...dangling].join(', ')}. `
    + 'One missing helper throws during setup and the whole window stays inert, '
    + 'so the composer can never submit and every menu row silently does nothing.');
});

/** The composer setup must survive to its public API: `keepseekInputControls`
 * is what the host-facing reducer and the settings dialogs call into. If setup
 * throws after the first render, this object never appears. */
test('the composer setup reaches its public API without a helper fault', () => {
  const script = getScript();
  const setupStart = script.indexOf('function setupRichPromptInput');
  const publicApi = script.indexOf('window.keepseekInputControls = {');
  assert.ok(setupStart > 0, 'the composer setup must exist');
  assert.ok(publicApi > setupStart,
    'the public input API must be declared inside the composer setup, after its first render');
});