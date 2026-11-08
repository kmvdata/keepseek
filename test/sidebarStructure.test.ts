import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getInputStyles } from '../src/webview/input/styles';
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

// The rail is now a blank drawer handle. Removing these ids is the contract:
// a reintroduced per-button id would silently re-couple the host script.
const REMOVED_RAIL_IDS = ['projectAssistantView', 'projectNewTask', 'projectTaskRailList', 'projectTaskHistory'] as const;

test('the rail stays a blank 32px drawer handle with a single expand button', () => {
  const rail = getProjectTasksTemplate();
  for (const id of REMOVED_RAIL_IDS) {
    assert.doesNotMatch(rail, new RegExp(`id="${id}"`, 'u'), `${id} must stay removed from the rail`);
  }
  assert.doesNotMatch(rail, /class="project-rail-control"[^>]*>✦/u, 'the rail carries no view-switch buttons');
  assert.doesNotMatch(rail, /class="project-task-rail-list"/u, 'the rail carries no task lamp list');

  const styles = getProjectTasksStyles();
  assert.match(styles, /\.project-tasks \{ flex: 0 0 32px; width: 32px;/u, 'the rail is exactly 32px wide');
  assert.doesNotMatch(styles, /\.project-task-lamp/u, 'lamp styles are gone with the lamp list');
  assert.match(styles, /\.project-task-sidebar \{[^}]*width: min\(180px, 100%\);/u,
    'the drawer expands to 180px and never past the panel width');
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

test('the composer leaves the project workspace so the rail and drawer stop above it', () => {
  const markup = getTemplate();
  const workspace = markup.indexOf('<div class="project-workspace">');
  const stage = markup.indexOf('class="project-transcript-stage"');
  const drawer = markup.indexOf('id="projectTaskSidebar"');
  const inputRegion = markup.indexOf('<div class="project-input-region">');
  const target = markup.indexOf('id="projectInputTarget"');
  const composer = markup.indexOf('id="composer"');

  assert.ok(workspace >= 0 && stage > workspace, 'the transcript stage stays inside the project workspace');
  assert.ok(drawer > stage && drawer < inputRegion,
    'the drawer is anchored to the stage and can never reach past the input region');
  assert.ok(inputRegion > stage, 'the input region is a sibling after the whole project workspace');
  assert.ok(markup.includes('</div>\n    <div class="project-input-region">'),
    'the project workspace closes before the input region opens');
  assert.ok(target > inputRegion && composer > target,
    'the target label still precedes the composer inside the input region');
  assert.ok(composer < markup.indexOf('</main>'), 'the composer renders before the shell closes');
});

test('the full-width input region lives in the sidebar cascade instead of the input fragments', () => {
  const sidebar = getProjectTasksStyles();
  const input = getInputStyles();
  const full = getStyles();

  assert.match(sidebar, /\.project-input-region \{ flex: 0 0 auto; width: 100%; min-width: 0;/u);
  assert.match(sidebar, /\.project-input-region > \.composer \{ width: 100%; min-width: 0; \}/u);
  assert.doesNotMatch(input, /\.project-input-region/u,
    'the input fragments stay unaware of the project shell');
  assert.doesNotMatch(input, /\.composer \{[^}]*width:/u,
    'the composer width is owned by the sidebar cascade');
  assert.ok(full.indexOf('.project-input-region {') > full.indexOf('.composer {'),
    'the width override stays after the composer base rule');
});
