import * as vscode from 'vscode';
import type { ChatSession } from '../shared/types';
import { getConfiguredMaxFileBytes, getConfiguredMaxImplicitSkills } from '../shared/config';
import { getCurrentWorkspaceSessionScope } from '../sessions/chatSessionStore';
import { normalizeUri } from '../agent/projectInstructions';
import type { SharedCodexConfigSnapshot } from '../context/sharedCodexConfig';
import { SkillDiscovery, validateCodexPluginSkill } from './skillDiscovery';
import { SkillLoader } from './skillLoader';
import { assertCodexPluginSkillsEnabled, isCodexPluginSkill, isCodexPluginSkillsEnabled } from './codexPluginSupport';
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

export interface PluginSkillToolContext {
  availableTools: readonly string[];
  routingAvailable: boolean;
}

interface StoredSkillState {
  workspaceDefaultSkillRefs?: Record<string, string[]>;
}

interface SkillSourceSnapshot {
  manifests: SkillManifest[];
  diagnostics: string[];
  loaded: Map<string, ActivatedSkill>;
}

/** Shared source bytes/read coordination only. Activation decisions and errors
 * stay on each SkillStore facade and on the owning session. */
export class SkillSourceCache {
  public readonly snapshots = new Map<SharedCodexConfigSnapshot, SkillSourceSnapshot>();
  public readonly pending = new Map<SharedCodexConfigSnapshot, Promise<SkillSourceSnapshot>>();
  public readonly activeReads = new WeakMap<Map<string, ActivatedSkill>, Map<string, Promise<ActivatedSkill>>>();
}

export interface ActiveSkillLoadResult {
  skills: ActivatedSkill[];
  failures: Array<{ id: string; name: string; error: string }>;
  activation?: SkillActivationResolution;
}

export class SkillStore {
  private manifests: SkillManifest[] = [];
  private config?: SharedCodexConfigSnapshot;
  private workspaceDefaultSkillRefs = new Map<string, string[]>();
  private cachedActiveSkills = new Map<string, ActivatedSkill>();
  private get activeSkillReads() { return this.sourceCache.activeReads; }
  private activeSkillLoadErrors = new Map<string, string>();
  private discoveryDiagnostics: string[] = [];
  private get sourceSnapshots() { return this.sourceCache.snapshots; }
  private get pendingSources() { return this.sourceCache.pending; }
  private refreshSelection = 0;
  public readonly sourceDiagnostics = { hits: 0, scans: 0, merged: 0, stale: 0 };

  public constructor(
    private readonly storage: vscode.Memento,
    private readonly discovery = new SkillDiscovery(),
    private readonly loader = new SkillLoader(),
    private readonly activationResolver = new SkillActivationResolver(),
    private readonly getWorkspaceKey = () => getCurrentWorkspaceSessionScope().key,
    private readonly sourceCache = new SkillSourceCache()
  ) {
    this.loadStoredState();
  }

  public createSibling(storage: vscode.Memento = this.storage): SkillStore {
    return new SkillStore(storage, this.discovery, this.loader, new SkillActivationResolver(), this.getWorkspaceKey, this.sourceCache);
  }

  public async refresh(config?: SharedCodexConfigSnapshot, options: { isCurrent?: () => boolean } = {}): Promise<void> {
    const selection = ++this.refreshSelection;
    let snapshot = config ? this.sourceSnapshots.get(config) : undefined;
    if (snapshot) {
      this.sourceDiagnostics.hits++;
      this.sourceSnapshots.delete(config!); this.sourceSnapshots.set(config!, snapshot);
    } else {
      let pending = config ? this.pendingSources.get(config) : undefined;
      if (pending) this.sourceDiagnostics.merged++;
      else {
        this.sourceDiagnostics.scans++;
        pending = this.discoverSource(config);
        if (config) this.pendingSources.set(config, pending);
      }
      try {
        snapshot = await pending;
        if (config) {
          this.sourceSnapshots.set(config, snapshot);
          while (this.sourceSnapshots.size > 4) this.sourceSnapshots.delete(this.sourceSnapshots.keys().next().value!);
        }
      } finally { if (config && this.pendingSources.get(config) === pending) this.pendingSources.delete(config); }
    }
    if (selection !== this.refreshSelection || options.isCurrent?.() === false) { this.sourceDiagnostics.stale++; return; }
    this.config = config;
    this.manifests = snapshot.manifests;
    this.discoveryDiagnostics = snapshot.diagnostics;
    this.cachedActiveSkills = snapshot.loaded;
    this.activeSkillLoadErrors.clear();
  }

  private async discoverSource(config?: SharedCodexConfigSnapshot): Promise<SkillSourceSnapshot> {
    // Same-version consumers still merge in pendingSources. Different versions
    // own their scan and diagnostics; an obsolete read cannot hold the new one.
    const discovered = await this.discovery.discoverSnapshot(config);
    const manifests = discovered.manifests.filter(manifest => isCodexPluginSkillsEnabled() || !isCodexPluginSkill(manifest));
    for (const manifest of manifests) freezeSkillSource(manifest);
    const diagnostics = [...discovered.diagnostics];
    Object.freeze(manifests); Object.freeze(diagnostics);
    return Object.freeze({ manifests, diagnostics, loaded: new Map<string, ActivatedSkill>() });
  }

  public getStateView(session: ChatSession): SkillStateView {
    const activeSkillIds = this.getSessionActiveSkillIds(session);
    const active = new Set(activeSkillIds);
    const workspaceDefaultSkillIds = this.getWorkspaceDefaultSkillIds();
    const workspaceDefaults = new Set(workspaceDefaultSkillIds);
    return {
      workspaceTrusted: vscode.workspace.isTrusted,
      scopeUri: this.config?.scope?.cwd.toString(),
      configSummary: this.config ? { projectDocMaxBytes: this.config.projectDocMaxBytes, fallbackFilenames: [...this.config.fallbackFilenames], origins: { ...this.config.origins }, fingerprint: this.config.fingerprint } : undefined,
      diagnostics: [...(this.config?.diagnostics.map(item => `${item.uri}: ${item.message}`) ?? []), ...this.discoveryDiagnostics],
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
    if (!manifest || manifest.pluginInstallation || !this.canUseSkill(manifest)) {
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

  public async setSkillWorkspaceDefault(id: string, enabled: boolean): Promise<boolean> {
    const manifest = this.getManifest(id);
    if (!manifest || manifest.pluginInstallation) {
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
    pluginTools?: PluginSkillToolContext;
    inheritedPluginSkills?: readonly ActivatedSkill[];
  }): Promise<ActiveSkillLoadResult> {
    const sourceSelection = this.refreshSelection;
    if (input.inheritedPluginSkills?.length) assertCodexPluginSkillsEnabled();
    const hasFrozenImplicitSnapshot = Array.isArray(input.session.frozenImplicitSkillIds);
    const frozenImplicitSkillIds = hasFrozenImplicitSnapshot
      ? normalizeFrozenImplicitSkillIds(input.session.frozenImplicitSkillIds)
      : [];
    const activation = this.activationResolver.resolve({
      manifests: this.manifests,
      prompt: input.prompt,
      explicitSkillIds: input.explicitSkillIds,
      sessionSkillIds: this.getSessionActiveSkillIds(input.session),
      workspaceDefaultSkillIds: this.getWorkspaceDefaultSkillIds(),
      workspaceTrusted: vscode.workspace.isTrusted,
      maxImplicitSkills: input.maxImplicitSkills ?? getConfiguredMaxImplicitSkills(),
      implicitSkillIds: hasFrozenImplicitSnapshot ? frozenImplicitSkillIds : undefined
    });
    // 会话冻结：首个真实用户请求确定 implicit 集合后写回快照（空集也冻结），
    // 后续轮次不再随 prompt 波动。prompt 为空（预加载/刷新）时不写回。
    if (!hasFrozenImplicitSnapshot && input.prompt.trim()) {
      input.session.frozenImplicitSkillIds = activation.activated
        .filter((decision) => decision.activation.source === 'implicit')
        .map((decision) => decision.manifest.id);
    } else if (frozenImplicitSkillIds.length) {
      // 惰性清理：快照中的 id 已失效（manifest 被禁用/移除）时收缩快照
      const validIds = activation.activated.map((decision) => decision.manifest.id);
      const keptIds = frozenImplicitSkillIds.filter((id) => validIds.includes(id));
      if (keptIds.length !== frozenImplicitSkillIds.length) {
        input.session.frozenImplicitSkillIds = keptIds;
      }
    }
    const skills: ActivatedSkill[] = [...(input.inheritedPluginSkills ?? [])];
    const failures: ActiveSkillLoadResult['failures'] = activation.skipped
      .filter(skip => (input.explicitSkillIds ?? []).includes(skip.id) && (skip.reason === 'disabled' || skip.reason === 'workspace_untrusted'))
      .map(skip => ({ id: skip.id, name: skip.name, error: this.getManifest(skip.id)?.unavailableReason ?? skip.reason }));
    for (const decision of activation.activated) {
      if (decision.manifest.pluginInstallation && input.inheritedPluginSkills) continue;
      try {
        const loaded = decision.manifest.pluginInstallation
          ? await this.loadPluginEntry(decision.manifest, input.pluginTools)
          : await this.loadManifest(decision.manifest);
        if (sourceSelection !== this.refreshSelection) throw new Error('Skill sources changed during loading; refresh to retry / Skill 来源在加载期间变化，请刷新重试');
        const skill = { ...loaded, activation: { ...decision.activation } };
        this.activeSkillLoadErrors.delete(decision.manifest.id);
        skills.push(skill);
      } catch (error) {
        if (sourceSelection !== this.refreshSelection) throw error;
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

  public async loadPluginEntry(manifest: SkillManifest, tools?: PluginSkillToolContext): Promise<ActivatedSkill> {
    assertCodexPluginSkillsEnabled();
    const installation = manifest.pluginInstallation;
    const cwd = this.config?.scope?.cwd.toString();
    if (!installation) throw new Error('Plugin installation unavailable / 插件安装不可用');
    return this.loader.loadPluginSkill(manifest,
      this.manifests.filter(item => item.pluginInstallation && item.pluginInstallation.id === installation.id
        && item.pluginInstallation.installationHash === installation.installationHash),
      {
        isTrusted: vscode.workspace.isTrusted,
        maxFileBytes: getConfiguredMaxFileBytes(),
        availableTools: tools?.availableTools ?? [],
        routingAvailable: tools?.routingAvailable ?? false,
        validateInstallation: (install, skillPath, name) => validateCodexPluginSkill(install, skillPath, cwd, name)
      }, cwd);
  }

  private canUseSkill(manifest: SkillManifest): boolean {
    return manifest.enabled && !manifest.unavailableReason;
  }

  private async loadManifest(manifest: SkillManifest): Promise<ActivatedSkill> {
    const cache = this.cachedActiveSkills;
    const cached = cache.get(manifest.id);
    if (cached) {
      return cached;
    }
    let reads = this.activeSkillReads.get(cache);
    if (!reads) { reads = new Map(); this.activeSkillReads.set(cache, reads); }
    let read = reads.get(manifest.id);
    if (!read) {
      read = this.loader.loadSkill(manifest).then(skill => {
        freezeSkillSource(skill);
        cache.set(manifest.id, skill);
        return skill;
      });
      reads.set(manifest.id, read);
    }
    try { return await read; }
    finally { if (reads.get(manifest.id) === read) reads.delete(manifest.id); }
  }

  /**
   * 显式使用/移除 Skill、Skill 列表刷新后调用：清除会话内冻结的 implicit
   * 集合，下次真实请求时重新按 prompt 匹配。
   */
  public invalidateImplicitSkillSnapshot(session: ChatSession): void {
    if (Array.isArray(session.frozenImplicitSkillIds)) {
      delete session.frozenImplicitSkillIds;
    }
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
      if (!isCodexPluginSkillsEnabled() && id.startsWith('codexPlugin:')) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  public getWorkspaceDefaultSkillIds(): string[] {
    const refs = this.workspaceDefaultSkillRefs.get(this.getWorkspaceKey()) ?? [];
    const refKeys = new Set(refs.map((ref) => normalizeUri(ref)));
    return this.manifests
      .filter((manifest) => !manifest.pluginInstallation && (refs.includes(manifest.id) || refKeys.has(normalizeUri(manifest.skillUri))))
      .map((manifest) => manifest.id);
  }

  private loadStoredState(): void {
    const stored = this.storage.get<StoredSkillState>(SKILL_STATE_KEY, {});
    this.workspaceDefaultSkillRefs = new Map(Object.entries(stored.workspaceDefaultSkillRefs ?? {})
      .map(([workspaceKey, refs]) => [
        workspaceKey,
        Array.isArray(refs)
          ? Array.from(new Set(refs.filter((ref): ref is string => typeof ref === 'string' && Boolean(ref.trim()))))
          : []
      ]));
  }

  private async persistStoredState(): Promise<void> {
    await this.storage.update(SKILL_STATE_KEY, {
      workspaceDefaultSkillRefs: Object.fromEntries(this.workspaceDefaultSkillRefs)
    } satisfies StoredSkillState);
  }
}

/** Activation is copied per call; only immutable parsed source data is reused across sessions. */
function freezeSkillSource<T>(value: T): T {
  if (value && typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
    for (const item of Object.values(value)) freezeSkillSource(item);
    Object.freeze(value);
  }
  return value;
}

function normalizeFrozenImplicitSkillIds(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))));
}
