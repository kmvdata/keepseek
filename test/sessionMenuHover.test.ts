import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getScript } from '../src/webview/script';

/** #sessionMenu hangs below the header, so hover intent has to survive a gap in
 * which neither the button nor the panel reports hover. These assertions pin
 * the observable contract: a delayed hover open, a grace period guarded by live
 * pointer and focus re-checks, and no session-store scan per hover. */
test('hovering the history button opens the session menu and hides it after a grace period', () => {
  const script = getScript();

  assert.doesNotThrow(() => new Function(script), 'the generated webview script must compile');

  assert.match(script, /historyTab\.addEventListener\('mouseenter'/u,
    'hovering the history button starts the open delay');
  assert.match(script, /historyTab\.addEventListener\('mouseleave'/u,
    'leaving the history button starts the hide grace period');
  assert.match(script, /sessionMenu\.addEventListener\('mouseenter'/u,
    'entering the panel cancels the pending hide');
  assert.match(script, /sessionMenu\.addEventListener\('mouseleave'/u,
    'leaving the panel restarts the hide timer');
  assert.match(script, /sessionMenu\.addEventListener\('focusin'/u,
    'focus inside the panel cancels the pending hide');

  const hideDelay = /var sessionMenuHoverHideDelayMs = (\d+);/u.exec(script);
  assert.ok(hideDelay, 'the hide delay must be a named constant so the grace period is testable');
  const hideDelayMs = Number(hideDelay[1]);
  assert.ok(hideDelayMs >= 300 && hideDelayMs <= 1000,
    `the grace period must be long enough to re-enter the panel (got ${hideDelayMs}ms)`);

  assert.match(script, /matches\(':hover'\)/u,
    'the hide callback re-checks the live pointer instead of trusting one event');
  assert.match(script, /sessionMenu\.contains\(/u,
    'the hide callback keeps the panel open while focus stays inside it');

  assert.match(script, /function closeSessionMenu\(\) \{\s*cancelSessionMenuHoverTimers\(\);/u,
    'every close path must drop pending hover timers before changing the panel state');

  assert.match(script,
    /if \(refreshWorkspaceList \|\| !otherWorkspacesRequested\) \{\s*otherWorkspacesRequested = true;\s*vscode\.postMessage\(\{ type: 'listOtherWorkspaces' \}\);/u,
    'a hover open must not rescan the session store');
  assert.equal((script.match(/type: 'listOtherWorkspaces'/gu) ?? []).length, 1,
    'the workspace scan is requested from exactly one guarded place');
  assert.match(script, /openSessionMenu\(false\);/u,
    'hover opening reuses the cached workspace list');
  assert.match(script, /openSessionMenu\(true\);/u,
    'explicit activation still refreshes the workspace list');

  for (const declaration of [
    'var sessionMenuHoverOpenDelayMs',
    'var sessionMenuHoverHideDelayMs',
    'function cancelSessionMenuHoverTimers(',
    'function isSessionMenuPointerInside(',
    'function sessionMenuKeepsFocus(',
    'function scheduleSessionMenuHoverOpen(',
    'function scheduleSessionMenuHoverHide('
  ]) {
    assert.equal(script.split(declaration).length - 1, 1,
      `${declaration} must be declared exactly once in the shared script scope`);
  }
});
