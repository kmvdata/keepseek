import * as vscode from 'vscode';
import type { ChatSession } from '../shared/types';
import { SkillDiscovery } from './skillDiscovery';
import { SkillLoader } from './skillLoader';
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
}

export interface ActiveSkillLoadResult {
  skills: ActivatedSkill[];
  failures: Array<{ id: string; name: string; error: string }>;
}

export class SkillStore {
  private manifests: SkillManifest[] = [];
  private disabledSkillIds = new Set<string>();
  private allowImplicitOverrides = new Map<string, boolean>();
  private cachedActiveSkills = new Map<string, ActivatedSkill>();
  private activeSkillLoadErrors = new Map<string, string>();

  public constructor(
    private readonly storage: vscode.Memento,
    private readonly discovery = new SkillDiscovery(),
    private readonly loader = new SkillLoader()
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
    return {
      workspaceTrusted: vscode.workspace.isTrusted,
      items: this.manifests.map((manifest) => toSkillManifestView(manifest, {
        active: active.has(manifest.id),
        loadError: this.activeSkillLoadErrors.get(manifest.id)
      })),
      activeSkillIds
    };
  }

  public getManifest(id: string): SkillManifest | undefined {
    return this.manifests.find((manifest) => manifest.id === id);
  }

  public getCachedActiveSkills(session: ChatSession): ActivatedSkill[] {
    const skills: ActivatedSkill[] = [];
    const seen = new Set<string>();
    for (const id of this.getSessionActiveSkillIds(session)) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const cached = this.cachedActiveSkills.get(id);
      if (cached) {
        skills.push(cached);
      }
    }
    return skills;
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

  public async preloadActiveSkills(session: ChatSession): Promise<ActiveSkillLoadResult> {
    return await this.loadActiveSkills(session);
  }

  public async loadActiveSkills(session: ChatSession, requestedIds?: string[]): Promise<ActiveSkillLoadResult> {
    const ids = requestedIds?.length ? requestedIds : this.getSessionActiveSkillIds(session);
    const skills: ActivatedSkill[] = [];
    const failures: Array<{ id: string; name: string; error: string }> = [];
    const seen = new Set<string>();

    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const manifest = this.getManifest(id);
      if (!manifest || !this.canUseSkill(manifest)) {
        continue;
      }

      try {
        const skill = await this.loader.loadSkill(manifest);
        this.cachedActiveSkills.set(id, skill);
        this.activeSkillLoadErrors.delete(id);
        skills.push(skill);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.activeSkillLoadErrors.set(id, message);
        failures.push({ id, name: manifest.name, error: message });
        skills.push({
          id: manifest.id,
          name: manifest.name,
          source: manifest.source,
          rootUri: manifest.rootUri.toString(),
          skillUri: manifest.skillUri.toString(),
          content: `KeepSeek could not load this skill instruction file: ${message}`,
          loadedResourceUris: [manifest.skillUri.toString()]
        });
      }
    }

    return { skills, failures };
  }

  private canUseSkill(manifest: SkillManifest): boolean {
    return manifest.enabled && manifest.userInvocable && !manifest.unavailableReason;
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

  private applyStoredState(manifest: SkillManifest): SkillManifest {
    const disabledByUser = this.disabledSkillIds.has(manifest.id);
    const allowImplicitOverride = this.allowImplicitOverrides.get(manifest.id);
    return {
      ...manifest,
      enabled: manifest.enabled && !disabledByUser,
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
  }

  private async persistStoredState(): Promise<void> {
    const allowImplicitOverrides: Record<string, boolean> = {};
    for (const [id, allowImplicit] of this.allowImplicitOverrides) {
      allowImplicitOverrides[id] = allowImplicit;
    }

    await this.storage.update(SKILL_STATE_KEY, {
      disabledSkillIds: [...this.disabledSkillIds],
      allowImplicitOverrides
    } satisfies StoredSkillState);
  }
}
