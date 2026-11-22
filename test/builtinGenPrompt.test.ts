import './registerVscodeStub';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { loadSharedCodexConfig } from '../src/context/sharedCodexConfig';
import { SkillDiscovery } from '../src/skills/skillDiscovery';
import { SkillLoader } from '../src/skills/skillLoader';
import { SkillStore } from '../src/skills/skillStore';
import { BUILTIN_GEN_PROMPT_ID, isBuiltinGenPrompt } from '../src/skills/skillTypes';
import { getScript } from '../src/webview/script';
import { commandSkillsBindingsFragment, commandSkillsDeclarationFragment, commandSkillsImplementationFragment } from '../src/webview/input/commandMenu/skills';
import { composerSubmitBindingsFragment } from '../src/webview/input/composer/script';
import { skillsImplementationFragment } from '../src/webview/input/skills/script';
import { createSession } from './sessionFixtures';

const resourcePath = 'resources/builtin-skills/gen-prompt';

test('gen-prompt resolves by stable package ID across installation paths and explicit selection alone', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-builtin-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const localDir = path.join(root, 'local');
  const oldInstall = path.join(root, '0.5.3');
  const nextInstall = path.join(root, '0.5.4');
  await cp(resourcePath, path.join(oldInstall, resourcePath), { recursive: true });
  await cp(resourcePath, path.join(localDir, 'gen-prompt'), { recursive: true });
  const config = await loadSharedCodexConfig({ folders: [], codexHome: vscode.Uri.file(root) });
  const makeDiscovery = (installation: string) => new SkillDiscovery({
    extensionUri: vscode.Uri.file(installation), userSkillsUri: vscode.Uri.file(localDir), includeAdminSkills: false
  });
  const memento: vscode.Memento = {
    keys: () => [],
    get: <T>(key: string, fallback?: T): T => key === 'keepseek.skillState.v1'
      ? { workspaceDefaultSkillRefs: { project: [BUILTIN_GEN_PROMPT_ID] } } as T : fallback as T,
    update: async () => { throw new Error('Must not write user configuration'); }
  };
  const session = createSession({ id: 'builtin-test' });
  for (const location of [oldInstall, nextInstall]) {
    if (location === nextInstall) await rename(oldInstall, nextInstall);
    const store = new SkillStore(memento, makeDiscovery(location), undefined, undefined, () => 'project');
    await store.refresh(config);
    const builtin = store.getManifest(BUILTIN_GEN_PROMPT_ID)!;
    assert.ok(isBuiltinGenPrompt(builtin));
    assert.equal(builtin.enabled, true);
    assert.equal(builtin.allowImplicit, false);
    assert.equal(path.relative(location, builtin.skillUri.fsPath).split(path.sep).join('/'), resourcePath + '/SKILL.md');
    const local = store.getManifests().find(manifest => manifest.source === 'agentsUser')!;
    assert.equal(local.name, builtin.name);
    assert.equal(isBuiltinGenPrompt(local), false);
    assert.equal(await store.setSkillWorkspaceDefault(builtin.id, true), false);
    assert.equal(await store.useSkill(session, builtin.id), false);
    session.activeSkillIds = [builtin.id];
    session.frozenImplicitSkillIds = [builtin.id];
    assert.deepEqual(store.getStateView(session).activeSkillIds, []);
    assert.deepEqual(store.getWorkspaceDefaultSkillIds(), []);
    const resolve = (ids: string[]) => store.resolveAndLoadSkills({
      session, prompt: 'gen-prompt 帮我改 bug，生成提示词', explicitSkillIds: ids
    });
    assert.deepEqual((await resolve([])).skills, []);
    const explicit = await resolve([builtin.id, builtin.id]);
    assert.equal(explicit.skills.length, 1);
    assert.equal(explicit.skills[0].activation?.source, 'explicit');
    assert.equal(explicit.skills[0].id, builtin.id);
    assert.match(explicit.skills[0].content, /fresh AI session/u);
    assert.deepEqual((await resolve([local.id])).skills.map(skill => skill.id), [local.id]);
    assert.deepEqual((await resolve([])).skills, []);
  }
});

test('gen-prompt refuses out-of-package resources, changed files and missing explicit policy', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-builtin-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const install = path.join(root, 'install');
  const packaged = path.join(install, resourcePath);
  const external = path.join(root, 'elsewhere');
  const config = await loadSharedCodexConfig({ folders: [], codexHome: vscode.Uri.file(root) });
  await cp(resourcePath, external, { recursive: true });
  await mkdir(path.dirname(packaged), { recursive: true });
  await symlink(external, packaged, 'dir');
  const discovery = new SkillDiscovery({ extensionUri: vscode.Uri.file(install), includeAdminSkills: false, includeUserSkills: false });
  assert.deepEqual(await discovery.discover(config), []);
  await rm(packaged);
  await cp(resourcePath, packaged, { recursive: true });
  const [manifest] = await discovery.discover(config);
  assert.equal(manifest.enabled, true);
  const policy = path.join(packaged, 'agents/openai.yaml');
  await rm(policy);
  await assert.rejects(new SkillLoader().loadSkill(manifest), /policy changed/u);
  assert.equal((await discovery.discover(config))[0].enabled, false);
  await writeFile(policy, 'policy:\n  allow_implicit_invocation: true\n');
  assert.equal((await discovery.discover(config))[0].enabled, false);
  await rm(policy);
  await symlink(path.join(external, 'agents/openai.yaml'), policy);
  assert.equal((await discovery.discover(config))[0].enabled, false);
});

test('the Skills checkbox toggles a single-turn composer selection and submit sends its exact ID', () => {
  // Use the shipped bindings and serializers. Only DOM/host APIs and unrelated controls are stubbed.
  const hooks = new Map<string, (event: object) => void>();
  const links: Array<{ dataset: Record<string, string>; setAttribute(): void; remove(): void }> = [];
  const messages: Array<{ type: string; skillIds: string[]; prompt: string }> = [];
  class Input {
    type = 'checkbox';
    dataset = { skillAction: 'toggle-use', skillId: BUILTIN_GEN_PROMPT_ID };
    checked = false;
  }
  const input = new Input();
  const listener = { addEventListener: (name: string, handler: (event: object) => void) => hooks.set(name, handler) };
  const noop = () => undefined;
  const catalog = [
    { id: BUILTIN_GEN_PROMPT_ID, name: 'gen-prompt', source: 'builtin', enabled: true, skillPath: '/private/install/SKILL.md' },
    { id: 'agentsUser:other', name: 'gen-prompt', source: 'agentsUser', enabled: true }
  ];
  const context = {
    state: { skills: { items: catalog }, activeSessionId: 'session' },
    canChangeContext: () => true, canSubmitPrompt: () => true, t: (key: string) => key,
    setComposerStatus: noop, renderSkillReferenceContent: noop, getPluginSkillMentionName: () => '',
    appendReferenceBoundarySpace: noop, getPromptInsertionRange: noop, updatePromptVisualState: noop,
    insertFragmentAtRange: (_range: unknown, fragment: { elements: typeof links }) => links.push(...fragment.elements),
    document: {
      getElementById: (id: string) => id === 'commandSkillList' ? listener : null,
      createDocumentFragment: () => ({ elements: [] as typeof links, append(item: typeof links[number]) { this.elements.push(item); } }),
      createElement: () => {
        const link = { dataset: {}, setAttribute: noop, remove: () => links.splice(links.indexOf(link), 1) };
        return link;
      }
    },
    HTMLInputElement: Input, promptInput: { querySelectorAll: () => links },
    composer: listener, sendButton: null, sanitizePromptContent: noop, beginPromptSubmission: () => 'submit-1',
    closeCommandMenu: noop, closeExecutionModeMenu: noop, closeReferenceMenu: noop, currentInteraction: () => ({ revision: 1 }),
    readAgentSettingsFromControls: () => ({}), collectPromptFileReferences: () => [], renderInputControls: noop,
    syncSendButtonAvailability: noop, vscode: { postMessage: (message: typeof messages[number]) => messages.push(message) }
  };
  const script = getScript();
  const identityStart = script.indexOf('function isGenPromptSkill(');
  const identityEnd = script.indexOf('function getSkillByMentionNameForView(', identityStart);
  assert.ok(identityStart >= 0 && identityEnd > identityStart);
  runInNewContext([script.slice(identityStart, identityEnd),
    commandSkillsDeclarationFragment.source, commandSkillsBindingsFragment.source, commandSkillsImplementationFragment.source,
    skillsImplementationFragment.source, composerSubmitBindingsFragment.source,
    "function serializePrompt(){return Array.from(promptInput.querySelectorAll('a.rich-skill-link')).map(link => getSkillMarkdownText(getSkillById(link.dataset.skillId))).join(' ') + ' investigate sample';}"
  ].join('\n'), context);
  const change = () => hooks.get('change')!({ target: input, stopPropagation: noop });
  input.checked = true; change(); change();
  assert.equal(links.length, 1);
  catalog[0].enabled = false; // A refresh can disable a selected Skill; the user can still remove it.
  input.checked = false; change();
  assert.equal(links.length, 0);
  catalog[0].enabled = true;
  hooks.get('submit')!({ preventDefault: noop });
  input.checked = true; change();
  hooks.get('submit')!({ preventDefault: noop });
  assert.deepEqual(messages.map(m => [m.type, Array.from(m.skillIds), m.prompt.trim()]), [
    ['sendPrompt', [], 'investigate sample'],
    ['sendPrompt', [BUILTIN_GEN_PROMPT_ID], '[$gen-prompt](builtin:gen-prompt) investigate sample']
  ]);
});

test('editing an old message restores gen-prompt only with a stored selection receipt', () => {
  const script = getScript();
  const start = script.indexOf('function renderInlineEditorContent(');
  const end = script.indexOf('function appendInlineEditorText(', start);
  assert.ok(start >= 0 && end > start);
  const skill = { id: BUILTIN_GEN_PROMPT_ID, name: 'gen-prompt', source: 'builtin' as const };
  const marker = '[$gen-prompt](builtin:gen-prompt) fix bug';
  const chips: string[] = [];
  const render = runInNewContext(script.slice(start, end) + '\nrenderInlineEditorContent', {
    getSkillByMarkdownReferenceForView: () => skill, isGenPromptSkill: isBuiltinGenPrompt,
    isOffsetInsideMarkdownFence: () => false, appendInlineEditorText: () => undefined,
    sanitizeInlineEditorContent: () => undefined, createInlineSkillLink: () => skill.id
  }) as (editor: object, value: string, usedSkills: unknown) => void;
  const editor = { append: (link: string) => chips.push(link) };
  render(editor, marker, []);
  render(editor, marker, [{ ...skill, id: 'agentsUser:local', source: 'agentsUser' }]);
  assert.deepEqual(chips, []);
  render(editor, marker, [skill]);
  assert.deepEqual(chips, [skill.id]);
});
