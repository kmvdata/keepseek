import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';

/** The history button is the only control that opens the session menu. Pointer
 * movement must never open or hide it, and a click elsewhere -- inside the panel
 * or anywhere else in the view -- must leave it open until the user presses the
 * button again or dismisses it with Escape. */
test('the history button toggles the session menu on click only', () => {
  const script = getScript();

  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.match(script,
    /historyTab\.addEventListener\('click', function\(event\) \{[\s\S]*?toggleSessionMenu\(\);/u,
    'pressing the history button toggles the panel');
  assert.match(script,
    /function toggleSessionMenu\(\) \{\s*if \(sessionMenuOpen\) \{\s*closeSessionMenu\(\);\s*\} else \{\s*openSessionMenu\(\);/u,
    'the toggle closes an open panel and opens a closed one');

  assert.doesNotMatch(script,
    /historyTab\.addEventListener\('(?:mouseenter|mouseleave|mouseover|mouseout)'/u,
    'hovering the history button must not open the panel');
  assert.doesNotMatch(script,
    /sessionMenu\.addEventListener\('(?:mouseenter|mouseleave|mouseover|mouseout)'/u,
    'moving the pointer over the panel must not hide it');
  assert.doesNotMatch(script, /matches\(':hover'\)/u,
    'no live pointer re-check survives the hover removal');
  assert.doesNotMatch(script, /sessionMenuHover/u,
    'the hover timers are gone from the shared script scope');

  assert.doesNotMatch(script,
    /document\.addEventListener\('mousedown', function\(event\) \{\s*if \(!sessionMenuOpen\) return;/u,
    'a click outside the panel must not close the session menu');
  assert.doesNotMatch(script, /if \(!sessionId\) \{\s*closeSessionMenu\(\);/u,
    'a blank click inside the panel must not close it');
  assert.match(script, /if \(!sessionId\) return;/u,
    'a blank click inside the panel keeps the dashboard open');
  assert.match(script, /if \(!settingsMenuOpen\) return;/u,
    'the settings menu keeps its own outside-click dismissal');
  assert.match(script, /event\.key !== 'Escape'/u,
    'Escape still closes the open menu');

  assert.equal((script.match(/type: 'listOtherWorkspaces'/gu) ?? []).length, 1,
    'the workspace scan is requested from exactly one place');
});
