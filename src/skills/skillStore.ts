import * as vscode from 'vscode';
import type { ChatSession } from '../shared/types';
import { getConfiguredMaxImplicitSkills } from '../shared/config';
import { getCurrentWorkspaceSessionScope } from '../sessions/chatSessionStore';
import { normalizeUri } from '../agent/projectInstructions';
import { SkillDiscovery } from './skillDiscovery';
import { SkillLoader } from './skillLoader';
import {
  SkillActivationResolver,
  type SkillActivationResolution
} from './skillActivationResolver';
import {
  toSkillManifestView,
  type ActivatedSkill,
  type SkillManifest,
  type SkillStateView
} from './skillTypes';

const SKILL_STATE_KEY = 'keepseek.skillState.v1';

interface StoredSkillState {
  disabledSkillIds?: string[];
  allowImplicitOverrides?: Record<string, boolean>;
  workspaceDefaultSkillRefs?: Record<string, string[]>;
}

export interface ActiveSkillLoadResult {
  skills: ActivatedSkill[];
  failures: Array<{ id: string; name: string; error: string }>;
  activation?: SkillActivationResolution;
}

export class SkillStore {
  private manifests: SkillManifest[] = [];
  private disabledSkillIds = new Set<string>();
  private allowImplicitOverrides = new Map<string, boolean>();
  private workspaceDefaultSkillRefs = new Map<string, string[]>();
  private cachedActiveSkills = new Map<string, ActivatedSkill>();
  private activeSkillLoadErrors = new Map<string, string>();

  public constructor(
    private readonly storage: vscode.Memento,
    private readonly discovery = new SkillDiscovery(),
    private readonly loader = new SkillLoader(),
    private readonly activationResolver = new SkillActivationResolver(),
    private readonly getWorkspaceKey = () => getCurrentWorkspaceSessionScope().key
  ) {
    this.loadStoredState();
  }

  public async refresh(): Promise<void> {
    const discovered = await this.discovery.discover();
    this.manifests = discovered.map((manifest) => this.applyStoredState(manifest));
    this.cachedActiveSkills.clear();
    this.activeSkillLoadErrors.clear();
  }

  public getStateView(session: ChatSession): SkillStateView {
    const activeSkillIds = this.getSessionActiveSkillIds(session);
    const active = new Set(activeSkillIds);
    const workspaceDefaultSkillIds = this.getWorkspaceDefaultSkillIds();
    const workspaceDefaults = new Set(workspaceDefaultSkillIds);
    return {
      workspaceTrusted: vscode.workspace.isTrusted,
      items: this.manifests.map((manifest) => toSkillManifestView(manifest, {
        active: active.has(manifest.id),
        loadError: this.activeSkillLoadErrors.get(manifest.id),
        workspaceDefault: workspaceDefaults.has(manifest.id)
      })),
      activeSkillIds,
      workspaceDefaultSkillIds
    };
  }

  public getManifest(id: string): SkillManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === id);
  }

  public getManifests(): readonly SkillManifest[] {
    return this.manifests;
  }

  public async useSkill(session: ChatSession, id: string): Promise<boolean> {
    const manifest = this.getManifest(id);
    if (!manifest || !this.canUseSkill(manifest)) {
      return false;
    }

    const activeSkillIds = this.getSessionActiveSkillIds(session);
    if (!activeSkillIds.includes(id)) {
      session.activeSkillIds = [...activeSkillIds, id];
    }
    await this.preloadActiveSkills(session);
    return true;
  }

  public removeActiveSkill(session: ChatSession, id: string): boolean {
    const next = this.getSessionActiveSkillIds(session).filter((skillId) => skillId !== id);
    if (next.length === this.getSessionActiveSkillIds(session).length) {
      return false;
    }
    session.activeSkillIds = next;
    this.activeSkillLoadErrors.delete(id);
    return true;
  }

  public async setSkillEnabled(session: ChatSession, id: string, enabled: boolean): Promise<boolean> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) {
      return false;
    }

    if (enabled) {
      this.disabledSkillIds.delete(id);
    } else {
      this.disabledSkillIds.add(id);
      this.removeActiveSkill(session, id);
      this.cachedActiveSkills.delete(id);
      this.activeSkillLoadErrors.delete(id);
    }
    this.manifests = this.manifests.map((item) => item.id === id ? this.applyStoredState(item) : item);
    await this.persistStoredState();
    return true;
  }

  public async setSkillAllowImplicit(id: string, allowImplicit: boolean): Promise<boolean> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) {
      return false;
    }
    this.allowImplicitOverrides.set(id, allowImplicit);
    this.manifests = this.manifests.map((item) => item.id === id ? this.applyStoredState(item) : item);
    await this.persistStoredState();
    return true;
  }

  public async setSkillWorkspaceDefault(id: string, enabled: boolean): Promise<boolean> {
    const manifest = this.getManifest(id);
    if (!manifest) {
      return false;
    }
    const workspaceKey = this.getWorkspaceKey();
    const refs = new Set(this.workspaceDefaultSkillRefs.get(workspaceKey) ?? []);
    const ref = manifest.skillUri.toString();
    if (enabled) {
      refs.add(ref);
    } else {
      for (const item of refs) {
        if (item === id || normalizeUri(item) === normalizeUri(ref)) {
          refs.delete(item);
        }
      }
    }
    this.workspaceDefaultSkillRefs.set(workspaceKey, [...refs]);
    await this.persistStoredState();
    return true;
  }

  public async preloadActiveSkills(session: ChatSession): Promise<ActiveSkillLoadResult> {
    return await this.resolveAndLoadSkills({ session, prompt: '' });
  }

  public async resolveAndLoadSkills(input: {
    session: ChatSession;
    prompt: string;
    explicitSkillIds?: readonly string[];
    maxImplicitSkills?: number;
  }): Promise<ActiveSkillLoadResult> {
    const activation = this.activationResolver.resolve({
      manifests: this.manifests,
      prompt: input.prompt,
      explicitSkillIds: input.explicitSkillIds,
      sessionSkillIds: this.getSessionActiveSkillIds(input.session),
      workspaceDefaultSkillIds: this.getWorkspaceDefaultSkillIds(),
      workspaceTrusted: vscode.workspace.isTrusted,
      maxImplicitSkills: input.maxImplicitSkills ?? getConfiguredMaxImplicitSkills()
    });
    const skills: ActivatedSkill[] = [];
    const failures: ActiveSkillLoadResult['failures'] = [];
    for (const decision of activation.activated) {
      try {
        const loaded = await this.loadManifest(decision.manifest);
        const skill = { ...loaded, activation: { ...decision.activation } };
        this.cachedActiveSkills.set(decision.manifest.id, skill);
        skills.push(skill);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.activeSkillLoadErrors.set(decision.manifest.id, message);
        failures.push({ id: decision.manifest.id, name: decision.manifest.name, error: message });
        activation.skipped.push({
          id: decision.manifest.id,
          name: decision.manifest.name,
          skillUri: decision.manifest.skillUri.toString(),
          reason: 'load_failed'
        });
      }
    }
    return { skills, failures, activation };
  }

  private canUseSkill(manifest: SkillManifest): boolean {
    return manifest.enabled && manifest.userInvocable && !manifest.unavailableReason;
  }

  private async loadManifest(manifest: SkillManifest): Promise<ActivatedSkill> {
    const cached = this.cachedActiveSkills.get(manifest.id);
    if (cached) {
      return cached;
    }
    const skill = await this.loader.loadSkill(manifest);
    this.cachedActiveSkills.set(manifest.id, skill);
    this.activeSkillLoadErrors.delete(manifest.id);
    return skill;
  }

  private getSessionActiveSkillIds(session: ChatSession): string[] {
    if (!Array.isArray(session.activeSkillIds)) {
      return [];
    }
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const id of session.activeSkillIds) {
      if (typeof id !== 'string' || !id.trim() || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  public getWorkspaceDefaultSkillIds(): string[] {
    const refs = this.workspaceDefaultSkillRefs.get(this.getWorkspaceKey()) ?? [];
    const refKeys = new Set(refs.map((ref) => normalizeUri(ref)));
    return this.manifests
      .filter((manifest) => refs.includes(manifest.id) || refKeys.has(normalizeUri(manifest.skillUri)))
      .map((manifest) => manifest.id);
  }

  private applyStoredState(manifest: SkillManifest): SkillManifest {
    const disabledByUser = this.disabledSkillIds.has(manifest.id);
    const allowImplicitOverride = this.allowImplicitOverrides.get(manifest.id);
    return {
      ...manifest,
      enabled: !disabledByUser && !manifest.unavailableReason,
      allowImplicit: allowImplicitOverride ?? manifest.allowImplicit,
      unavailableReason: disabledByUser ? undefined : manifest.unavailableReason
    };
  }

  private loadStoredState(): void {
    const stored = this.storage.get<StoredSkillState>(SKILL_STATE_KEY, {});
    this.disabledSkillIds = new Set(Array.isArray(stored.disabledSkillIds)
      ? stored.disabledSkillIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
      : []);
    this.allowImplicitOverrides = new Map(Object.entries(stored.allowImplicitOverrides ?? {})
      .filter((entry): entry is [string, boolean] => typeof entry[0] === 'string' && typeof entry[1] === 'boolean'));
    this.workspaceDefaultSkillRefs = new Map(Object.entries(stored.workspaceDefaultSkillRefs ?? {})
      .map(([workspaceKey, refs]) => [
        workspaceKey,
        Array.isArray(refs)
          ? Array.from(new Set(refs.filter((ref): ref is string => typeof ref === 'string' && Boolean(ref.trim()))))
          : []
      ]));
  }

  private async persistStoredState(): Promise<void> {
    const allowImplicitOverrides: Record<string, boolean> = {};
    for (const [id, allowImplicit] of this.allowImplicitOverrides) {
      allowImplicitOverrides[id] = allowImplicit;
    }

    await this.storage.update(SKILL_STATE_KEY, {
      disabledSkillIds: [...this.disabledSkillIds],
      allowImplicitOverrides,
      workspaceDefaultSkillRefs: Object.fromEntries(this.workspaceDefaultSkillRefs)
    } satisfies StoredSkillState);
  }
}
