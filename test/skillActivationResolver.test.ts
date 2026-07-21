import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import type { ChatSession } from '../src/shared/types';
import { SkillActivationResolver } from '../src/skills/skillActivationResolver';
import type { SkillDiscovery } from '../src/skills/skillDiscovery';
import type { SkillLoader } from '../src/skills/skillLoader';
import { SkillStore } from '../src/skills/skillStore';
import { toActivatedSkill, type SkillManifest } from '../src/skills/skillTypes';

test('explicit Skill wins over an implicit Skill with the same normalized name', () => {
  const explicit = manifest('global-review', 'review-flow', 'agentsUser', true);
  const workspaceImplicit = manifest('workspace-review', 'review-flow', 'agentsWorkspace', true);
  const result = new SkillActivationResolver().resolve({
    manifests: [workspaceImplicit, explicit],
    prompt: 'Please run the review flow.',
    explicitSkillIds: [explicit.id],
    workspaceTrusted: true,
    maxImplicitSkills: 3
  });

  assert.deepEqual(result.activated.map((item) => item.manifest.id), [explicit.id]);
  assert.equal(result.activated[0]?.activation.source, 'explicit');
  assert.equal(result.skipped.find((item) => item.id === workspaceImplicit.id)?.reason, 'duplicate_skill');
});

test('allowImplicit false never auto-activates even when the request matches', () => {
  const manual = manifest('manual-review', 'review-flow', 'agentsWorkspace', false);
  const result = new SkillActivationResolver().resolve({
    manifests: [manual],
    prompt: 'Use review-flow to inspect this change.',
    workspaceTrusted: true,
    maxImplicitSkills: 3
  });

  assert.deepEqual(result.activated, []);
  assert.equal(result.skipped[0]?.reason, 'allow_implicit_false');
});

test('allowImplicit true activates by deterministic request keywords', () => {
  const implicit = manifest('auto-review', 'review-flow', 'agentsWorkspace', true);
  const result = new SkillActivationResolver().resolve({
    manifests: [implicit],
    prompt: 'Use review-flow to inspect this change.',
    workspaceTrusted: true,
    maxImplicitSkills: 3
  });

  assert.equal(result.activated[0]?.manifest.id, implicit.id);
  assert.equal(result.activated[0]?.activation.source, 'implicit');
  assert.match(result.activated[0]?.activation.reason ?? '', /Deterministic/u);
});

test('activation order is explicit, session, workspace-default, then implicit', () => {
  const explicit = manifest('explicit', 'explicit-flow', 'agentsUser', false);
  const session = manifest('session', 'session-flow', 'agentsUser', false);
  const workspaceDefault = manifest('default', 'default-flow', 'agentsWorkspace', false);
  const implicit = manifest('implicit', 'implicit-flow', 'agentsWorkspace', true);
  const result = new SkillActivationResolver().resolve({
    manifests: [implicit, workspaceDefault, session, explicit],
    prompt: 'Please use implicit-flow.',
    explicitSkillIds: [explicit.id],
    sessionSkillIds: [session.id],
    workspaceDefaultSkillIds: [workspaceDefault.id],
    workspaceTrusted: true,
    maxImplicitSkills: 3
  });

  assert.deepEqual(result.activated.map((item) => item.activation.source), [
    'explicit',
    'session',
    'workspace-default',
    'implicit'
  ]);
});

test('workspace duplicate wins over a global duplicate for equal automatic activation', () => {
  const global = manifest('global-format', 'format-flow', 'agentsUser', true);
  const workspace = manifest('workspace-format', 'format-flow', 'agentsWorkspace', true);
  const result = new SkillActivationResolver().resolve({
    manifests: [global, workspace],
    prompt: 'Use format-flow.',
    workspaceTrusted: true,
    maxImplicitSkills: 3
  });

  assert.deepEqual(result.activated.map((item) => item.manifest.id), [workspace.id]);
  assert.equal(result.skipped.find((item) => item.id === global.id)?.reason, 'duplicate_skill');
});

test('workspace-default personal Skill persists and activates in a new session', async () => {
  const personal = manifest('personal-style', 'personal-style', 'agentsUser', false);
  const memento = new MemoryMemento();
  const discovery = { discover: async () => [personal] } as SkillDiscovery;
  const loader = {
    loadSkill: async (item: SkillManifest) => toActivatedSkill(item, '# Personal style\n\nUse concise replies.')
  } as SkillLoader;
  const workspace = vscode.workspace as unknown as { isTrusted: boolean };
  workspace.isTrusted = true;

  const firstStore = new SkillStore(memento, discovery, loader, new SkillActivationResolver(), () => 'workspace-one');
  await firstStore.refresh();
  assert.equal(await firstStore.setSkillWorkspaceDefault(personal.id, true), true);

  const reloadedStore = new SkillStore(memento, discovery, loader, new SkillActivationResolver(), () => 'workspace-one');
  await reloadedStore.refresh();
  const result = await reloadedStore.resolveAndLoadSkills({
    session: session('new-session'),
    prompt: ''
  });

  assert.equal(result.skills[0]?.id, personal.id);
  assert.equal(result.skills[0]?.activation?.source, 'workspace-default');
  assert.deepEqual(reloadedStore.getWorkspaceDefaultSkillIds(), [personal.id]);

  const otherWorkspaceStore = new SkillStore(memento, discovery, loader, new SkillActivationResolver(), () => 'workspace-two');
  await otherWorkspaceStore.refresh();
  assert.deepEqual(otherWorkspaceStore.getWorkspaceDefaultSkillIds(), []);
});

test('persisted allowImplicit override participates in automatic activation', async () => {
  const auto = manifest('auto-toggle', 'auto-toggle', 'agentsUser', false);
  const memento = new MemoryMemento();
  const discovery = { discover: async () => [auto] } as SkillDiscovery;
  const loader = {
    loadSkill: async (item: SkillManifest) => toActivatedSkill(item, '# Auto toggle')
  } as SkillLoader;
  const store = new SkillStore(memento, discovery, loader, new SkillActivationResolver(), () => 'workspace-one');
  await store.refresh();

  await store.setSkillAllowImplicit(auto.id, true);
  const reloaded = new SkillStore(memento, discovery, loader, new SkillActivationResolver(), () => 'workspace-one');
  await reloaded.refresh();
  const enabled = await reloaded.resolveAndLoadSkills({ session: session('implicit-on'), prompt: 'Use auto-toggle.' });
  assert.equal(enabled.skills[0]?.activation?.source, 'implicit');

  await reloaded.setSkillAllowImplicit(auto.id, false);
  const disabled = await reloaded.resolveAndLoadSkills({ session: session('implicit-off'), prompt: 'Use auto-toggle.' });
  assert.deepEqual(disabled.skills, []);
  assert.ok(disabled.activation?.skipped.some((item) => item.reason === 'allow_implicit_false'));
});

test('untrusted workspaces never auto-enable workspace Skills', () => {
  const workspaceSkill = manifest('unsafe-workspace', 'unsafe-flow', 'agentsWorkspace', true);
  const result = new SkillActivationResolver().resolve({
    manifests: [workspaceSkill],
    prompt: 'Use unsafe-flow.',
    workspaceDefaultSkillIds: [workspaceSkill.id],
    workspaceTrusted: false,
    maxImplicitSkills: 3
  });

  assert.deepEqual(result.activated, []);
  assert.ok(result.skipped.some((item) => item.reason === 'workspace_untrusted'));
});

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function manifest(id: string, name: string, source: SkillManifest['source'], allowImplicit: boolean): SkillManifest {
  const rootUri = vscode.Uri.file(`/skills/${id}`);
  return {
    id,
    name,
    description: `${name} reusable workflow`,
    source,
    sourceLabel: source,
    rootUri,
    skillUri: vscode.Uri.joinPath(rootUri, 'SKILL.md'),
    enabled: true,
    allowImplicit,
    userInvocable: true,
    hasReferences: false,
    hasAssets: false,
    hasScripts: false
  };
}

function session(id: string): ChatSession {
  const now = new Date().toISOString();
  return {
    id,
    title: 'New session',
    messages: [],
    createdAt: now,
    updatedAt: now,
    workspaceKey: 'workspace-one',
    workspaceName: 'Workspace',
    workspaceFolders: [],
    isFavorite: false
  };
}
