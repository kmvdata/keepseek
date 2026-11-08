import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getStyles } from '../src/webview/styles';
import { getTemplate } from '../src/webview/template';
import {
  getProjectTasksOverlayTemplate,
  getProjectTasksStyles,
  getProjectTasksTemplate
} from '../src/webview/sidebar';
import { SIDEBAR_STYLE_FRAGMENTS } from '../src/webview/sidebar/styles';
import { drawerTemplateFragment } from '../src/webview/sidebar/templates/drawer';
import { railTemplateFragment } from '../src/webview/sidebar/templates/rail';
import { tooltipTemplateFragment } from '../src/webview/sidebar/templates/tooltip';

// Contract ids the host script, the input fragments and the Webview tests all
// address directly. The sidebar split must never rename or drop one.
const SIDEBAR_DOM_IDS = [
  'projectTasks',
  'projectSidebarToggle',
  'projectAssistantView',
  'projectNewTask',
  'projectTaskRailList',
  'projectTaskHistory',
  'projectTaskAnnouncements',
  'projectTaskSidebar',
  'projectSidebarClose',
  'projectTaskScope',
  'projectShowArchived',
  'projectTaskMore',
  'projectAssociateSession',
  'projectStopAll',
  'projectTiming',
  'projectRouterUsage',
  'projectTaskList',
  'projectTaskDetail',
  'projectTaskTooltip'
] as const;

test('sidebar templates keep their exact byte boundaries', () => {
  const rail = getProjectTasksTemplate();
  assert.ok(rail.startsWith('\n    <nav id="projectTasks"'), 'rail opens on the nav line with its original indent');
  assert.ok(rail.endsWith('</nav>'), 'rail ends at the closing nav tag, with no trailing whitespace');

  const overlay = getProjectTasksOverlayTemplate();
  assert.equal(overlay, drawerTemplateFragment.source + '\n' + tooltipTemplateFragment.source);
  assert.ok(overlay.startsWith('\n    <aside id="projectTaskSidebar"'), 'drawer opens on its original indent');
  assert.ok(overlay.endsWith('role="tooltip"></div>'), 'tooltip closes the overlay');
});

test('every sidebar DOM id survives the split and keeps its legacy position', () => {
  const markup = getTemplate();
  for (const id of SIDEBAR_DOM_IDS) {
    assert.match(markup, new RegExp(`id="${id}"`, 'u'), `${id} must stay in the rendered template`);
  }
  const rail = markup.indexOf('id="projectTasks"');
  const drawer = markup.indexOf('id="projectTaskSidebar"');
  const stage = markup.indexOf('class="project-transcript-stage"');
  const inputTarget = markup.indexOf('id="projectInputTarget"');
  assert.ok(rail >= 0 && rail < drawer, 'the rail renders before the drawer');
  assert.ok(stage >= 0 && stage < drawer, 'the drawer stays anchored inside the transcript stage');
  assert.ok(drawer < inputTarget, 'the drawer still renders before the composer target label');
});

test('sidebar style fragments compose in cascade order after the input fragments', () => {
  const styles = getProjectTasksStyles();
  assert.ok(styles.startsWith('\n    .project-workspace {'), 'workspace layout opens the block with its original indent');
  assert.ok(styles.endsWith('\n  '), 'the block keeps its closing indentation');
  assert.equal(styles, SIDEBAR_STYLE_FRAGMENTS.map((fragment) => fragment.source).join(''),
    'composition is a plain order-preserving join');
  assert.doesNotMatch(styles, /\n\n/u,
    'fragments must not introduce blank lines between or after rules');
  for (const fragment of SIDEBAR_STYLE_FRAGMENTS) {
    assert.ok(fragment.source.endsWith('\n'), `${fragment.id} must end with its own newline`);
  }

  const full = getStyles();
  const composerAt = full.indexOf('.composer {');
  const sidebarAt = full.indexOf('.project-workspace {');
  assert.ok(composerAt >= 0, 'composer styles are present');
  assert.ok(sidebarAt > composerAt, 'sidebar styles stay after the composer styles');
});

test('sidebar fragments carry unique ids so composition cannot silently drop one', () => {
  const ids = [
    ...SIDEBAR_STYLE_FRAGMENTS.map((fragment) => fragment.id),
    railTemplateFragment.id,
    drawerTemplateFragment.id,
    tooltipTemplateFragment.id
  ];
  assert.ok(ids.every((id) => id.length > 0), 'no empty fragment id');
  assert.equal(new Set(ids).size, ids.length, 'fragment ids are unique');
});
