import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { canonicalUri, isMissingFile, readSharedText, type SharedConfigScope, uriInside } from '../context/sharedConfigPaths';

export interface CodexPluginInstallation {
  /** Stable across version changes, including reinstallations of the same remote identity. */
  id: string;
  name: string;
  version: string;
  marketplace: string;
  source: 'local' | 'remote';
  rootPath: string;
  realRootPath: string;
  skillsPath: string;
  codexHomePath: string;
  manifestHash: string;
  installationHash: string;
  integrityHash?: string;
}

type ObjectFields = Record<string, unknown>;
const REMOTE_INSTALL = '.codex-remote-plugin-install.json';
const PLUGIN_MANIFEST = '.codex-plugin/plugin.json';
const MARKETPLACE_MANIFEST = '.agents/plugins/marketplace.json';
const MAX_METADATA_BYTES = 1_048_576;
const MAX_ENTRIES = 256;
const MAX_PACKAGES = 512;
const MAX_VERSION_ENTRIES = 64;

class DiscoveryError extends Error {}

function fields(value: unknown): ObjectFields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a metadata object');
  return value as ObjectFields;
}

function segment(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._+-]{0,127}$/iu.test(value) && !value.endsWith('.');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function relativeSegments(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 1024 || /[\\:%]/u.test(value)
    || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error('Unsafe metadata path');
  const pieces = value.replace(/^\.\//u, '').replace(/\/$/u, '').split('/');
  if (pieces.length > 16 || pieces.some(piece => !piece || piece === '.' || piece === '..' || piece.trim() !== piece)) throw new Error('Unsafe metadata path');
  return pieces;
}

/** Cache descendants must match the canonical host path, even for links within the cache. */
async function exactDirectory(root: string, ...segments: string[]): Promise<string> {
  const directory = path.join(root, ...segments);
  if (!(await fs.lstat(directory)).isDirectory() || await fs.realpath(directory) !== directory) {
    throw new DiscoveryError('Unsafe plugin directory / 插件目录不安全');
  }
  return directory;
}

async function metadataText(root: string, relative: string): Promise<string | undefined> {
  const filename = path.join(root, ...relative.split('/'));
  try {
    if (!(await fs.lstat(filename)).isFile() || await fs.realpath(filename) !== filename) {
      throw new DiscoveryError('Unsafe plugin metadata path / 插件元数据路径不安全');
    }
    return await readSharedText(vscode.Uri.file(filename), [vscode.Uri.file(root)], MAX_METADATA_BYTES);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function directoryEntries(directory: string, limit = MAX_ENTRIES): Promise<import('node:fs').Dirent[]> {
  const entries: import('node:fs').Dirent[] = [];
  for await (const entry of await fs.opendir(directory)) {
    if (entries.length === limit) throw new DiscoveryError('Plugin scan limit reached / 插件扫描达到上限');
    entries.push(entry);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

interface PluginPolicy {
  enabled: Set<string>;
  disabled: Set<string>;
  localMarkets: Map<string, string>;
}

async function readPolicy(canonicalHome: string, scope?: SharedConfigScope): Promise<PluginPolicy> {
  const { parseTOML } = await import('confbox/toml');
  const policy: PluginPolicy = { enabled: new Set(), disabled: new Set(), localMarkets: new Map() };
  const userText = await metadataText(canonicalHome, 'config.toml');
  const user = userText === undefined ? {} : fields(parseTOML(userText));
  const projectText = scope?.trusted ? await Promise.all(scope.chain.map(async directory => {
    if (!uriInside(scope.root, directory) || (await canonicalUri(directory)).fsPath !== directory.fsPath) {
      throw new Error('Project configuration scope changed');
    }
    return metadataText(directory.fsPath, '.codex/config.toml');
  })) : [];
  const layers = [user, ...projectText.filter((value): value is string => value !== undefined).map(value => fields(parseTOML(value)))];
  for (const [index, layer] of layers.entries()) {
    if (layer.plugins === undefined) continue;
    const plugins = Object.entries(fields(layer.plugins));
    if (plugins.length > MAX_PACKAGES) throw new Error('Plugin policy exceeds limit');
    for (const [key, value] of plugins) {
      const [name, market, extra] = key.split('@');
      if (!segment(name) || !segment(market) || extra !== undefined) continue;
      const enabled = fields(value).enabled;
      if (enabled === false) policy.disabled.add(key);
      else if (index === 0 && enabled === true) policy.enabled.add(key);
      else if (enabled !== undefined && enabled !== true) throw new Error('Invalid plugin enablement');
    }
  }
  if (user.marketplaces !== undefined) {
    for (const [name, value] of Object.entries(fields(user.marketplaces))) {
      if (!segment(name)) continue;
      const market = fields(value);
      if (market.source_type === 'local' && typeof market.source === 'string' && path.isAbsolute(market.source)) {
        policy.localMarkets.set(name, market.source);
      }
    }
  }
  return policy;
}

interface CachedPackage {
  marketplace: string;
  name: string;
  root: string;
}

async function localMarketVersion(source: string, candidate: CachedPackage): Promise<string> {
  const root = await fs.realpath(source);
  const indexText = await metadataText(root, MARKETPLACE_MANIFEST);
  if (!indexText) throw new Error('Missing local marketplace index');
  const index = fields(JSON.parse(indexText));
  if (index.name !== candidate.marketplace || !Array.isArray(index.plugins) || index.plugins.length > MAX_PACKAGES) {
    throw new Error('Invalid local marketplace index');
  }
  const matches = index.plugins.map(fields).filter(plugin => plugin.name === candidate.name);
  if (matches.length !== 1) throw new Error('Missing or ambiguous local marketplace entry');
  const entry = fields(matches[0].source);
  if (entry.source !== 'local') throw new Error('Unsupported local marketplace source');
  const sourceRoot = await exactDirectory(root, ...relativeSegments(entry.path));
  const manifestText = await metadataText(sourceRoot, PLUGIN_MANIFEST);
  if (!manifestText) throw new Error('Missing source manifest');
  const manifest = fields(JSON.parse(manifestText));
  if (manifest.name !== candidate.name || !segment(manifest.version)) throw new Error('Invalid source manifest');
  return manifest.version;
}

async function remoteIntegrity(root: string, manifestHash: string): Promise<string> {
  const integrity = await metadataText(root, 'integrity.json');
  if (!integrity) throw new DiscoveryError('Remote bundle integrity record unavailable / 缺少远程安装包完整性记录');
  const record = fields(JSON.parse(integrity));
  if (record.schema_version !== 1 || record.hash_algorithm !== 'sha256' || !Array.isArray(record.files) || record.files.length > 20_000) {
    throw new DiscoveryError('Unsupported remote bundle integrity record / 不支持远程安装包完整性记录');
  }
  const manifests = record.files.map(fields).filter(file => file.path === PLUGIN_MANIFEST);
  if (manifests.length !== 1 || manifests[0].sha256 !== manifestHash) {
    throw new DiscoveryError('Remote plugin manifest integrity mismatch / 远程插件清单完整性校验失败');
  }
  return digest(integrity);
}

async function resolvePackage(candidate: CachedPackage, policy: PluginPolicy, codexHomePath: string): Promise<{
  plugin?: CodexPluginInstallation;
  diagnostic?: string;
}> {
  const { marketplace, name, root } = candidate;
  const key = `${name}@${marketplace}`;
  if (policy.disabled.has(key)) throw new DiscoveryError('Disabled by Codex configuration / Codex 配置已禁用');
  const markerText = await metadataText(root, REMOTE_INSTALL);
  let remoteId: string | undefined;
  if (markerText !== undefined) {
    const marker = fields(JSON.parse(markerText));
    if (marker.schema_version !== 1 || typeof marker.remote_plugin_id !== 'string' || !/^[a-z0-9_-]{1,200}$/iu.test(marker.remote_plugin_id)) {
      throw new DiscoveryError('Invalid remote installation record / 远程安装记录无效');
    }
    remoteId = marker.remote_plugin_id;
  }
  if (!remoteId && !policy.enabled.has(key)) {
    throw new DiscoveryError('No supported installation and enablement evidence / 缺少受支持的安装及启用证据');
  }
  const versions = (await directoryEntries(root, MAX_VERSION_ENTRIES))
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && segment(entry.name));
  let slot: string;
  if (remoteId) {
    // An ID-only record is valid only beside one installed bundle; never rank cached versions.
    if (versions.length !== 1) throw new DiscoveryError('Remote installation version is missing or ambiguous / 远程安装版本缺失或存在歧义');
    slot = versions[0].name;
  } else {
    const marketSource = policy.localMarkets.get(marketplace);
    if (versions.some(entry => entry.name === 'local')) {
      // Documented local slot, independently authorized by an explicit user configuration entry.
      slot = 'local';
      if (marketSource && versions.length > 1) {
        const sourceVersion = await localMarketVersion(marketSource, candidate);
        if (sourceVersion !== slot && versions.some(entry => entry.name === sourceVersion)) {
          throw new DiscoveryError('Local installation version is ambiguous / 本地安装版本存在歧义');
        }
      }
    } else if (marketSource) {
      try { slot = await localMarketVersion(marketSource, candidate); }
      catch { throw new DiscoveryError('Local marketplace does not identify an exact installed version / 本地市场未给出准确的安装版本'); }
    } else {
      throw new DiscoveryError('No supported version selector for the local installation / 本地安装缺少受支持的版本依据');
    }
  }
  const realRootPath = await exactDirectory(root, slot);
  const packageBefore = await fs.stat(realRootPath);
  const manifestText = await metadataText(realRootPath, PLUGIN_MANIFEST);
  if (manifestText === undefined) throw new DiscoveryError('Plugin manifest unavailable / 缺少插件清单');
  const manifest = fields(JSON.parse(manifestText));
  if (manifest.name !== name || (slot !== 'local' && manifest.version !== slot)
      || (manifest.version !== undefined && !segment(manifest.version))) {
    throw new DiscoveryError('Plugin manifest identity or version mismatch / 插件清单身份或版本不匹配');
  }
  if (manifest.skills === undefined) return {};
  const manifestHash = digest(manifestText);
  const integrityHash = remoteId ? await remoteIntegrity(realRootPath, manifestHash) : undefined;
  const relativeSkills = relativeSegments(manifest.skills);
  const skillsPath = await exactDirectory(realRootPath, ...relativeSkills);
  const source = remoteId ? 'remote' : 'local';
  const id = remoteId ? `${key}#${remoteId}` : key;
  const rootPath = path.join(codexHomePath, 'plugins', 'cache', marketplace, name, slot);
  const packageAfter = await fs.stat(await exactDirectory(root, slot));
  if (packageBefore.dev !== packageAfter.dev || packageBefore.ino !== packageAfter.ino
    || packageBefore.birthtimeMs !== packageAfter.birthtimeMs) {
    throw new DiscoveryError('Plugin installation changed during discovery / 插件安装在扫描期间发生变化');
  }
  const installationHash = digest(JSON.stringify([id, source, slot, rootPath, realRootPath, manifestHash, integrityHash,
    packageAfter.dev, packageAfter.ino, packageAfter.birthtimeMs]));
  return {
    plugin: { id, name, version: (manifest.version as string | undefined) ?? slot, marketplace, source,
      rootPath, realRootPath, skillsPath, codexHomePath, manifestHash, installationHash, integrityHash },
    diagnostic: versions.length > 1 ? 'Ignored other cached versions / 已忽略其他缓存版本' : undefined
  };
}

/** Revalidate one installation on demand without enumerating other marketplaces or plugin packages. */
export async function refreshCodexPluginInstallation(
  codexHome: vscode.Uri,
  installation: CodexPluginInstallation,
  scope?: SharedConfigScope
): Promise<CodexPluginInstallation | undefined> {
  if (!vscode.workspace.isTrusted || scope?.trusted === false || codexHome.fsPath !== installation.codexHomePath
    || !segment(installation.marketplace) || !segment(installation.name)) return undefined;
  try {
    const canonicalHome = (await canonicalUri(codexHome)).fsPath;
    const { marketplace, name } = installation;
    const root = await exactDirectory(canonicalHome, 'plugins', 'cache', marketplace, name);
    const policy = await readPolicy(canonicalHome, scope);
    const { plugin } = await resolvePackage({ marketplace, name, root }, policy, codexHome.fsPath);
    return plugin?.id === installation.id ? plugin : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverCodexPlugins(codexHome: vscode.Uri, scope?: SharedConfigScope): Promise<{
  plugins: CodexPluginInstallation[];
  diagnostics: string[];
}> {
  const plugins: CodexPluginInstallation[] = [];
  const diagnostics: string[] = [];
  if (vscode.env?.remoteName) {
    diagnostics.push('Searching this extension host only. Desktop installations require access from the same host / 仅搜索当前扩展宿主。桌面安装须对同一宿主可见');
  }
  if (!vscode.workspace.isTrusted || scope?.trusted === false) {
    diagnostics.push('Codex plugin Skills require a trusted workspace / Codex 插件 Skill 需要可信工作区');
    return { plugins, diagnostics };
  }
  try {
    const canonicalHome = (await canonicalUri(codexHome)).fsPath;
    const cache = await exactDirectory(canonicalHome, 'plugins', 'cache');
    let policy: PluginPolicy;
    try { policy = await readPolicy(canonicalHome, scope); }
    catch {
      diagnostics.push('Codex plugin enablement could not be safely read / 无法安全读取 Codex 插件启用状态');
      return { plugins, diagnostics };
    }
    const seenKeys = new Set<string>();
    for (const market of await directoryEntries(cache)) {
      if (!segment(market.name) || (!market.isDirectory() && !market.isSymbolicLink())) continue;
      try {
        const marketRoot = await exactDirectory(cache, market.name);
        for (const entry of await directoryEntries(marketRoot)) {
          if (!segment(entry.name) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
          const key = `${entry.name}@${market.name}`;
          if (seenKeys.size >= MAX_PACKAGES) throw new DiscoveryError('Plugin package scan limit reached / 插件包扫描达到上限');
          seenKeys.add(key);
          try {
            const root = await exactDirectory(marketRoot, entry.name);
            const result = await resolvePackage({ marketplace: market.name, name: entry.name, root }, policy, codexHome.fsPath);
            if (result.plugin) plugins.push(result.plugin);
            if (result.diagnostic) diagnostics.push(`${key}: ${result.diagnostic}`);
          } catch (error) {
            diagnostics.push(`${key}: ${error instanceof DiscoveryError ? error.message : 'Invalid, missing, or unreadable installation metadata / 安装元数据无效、缺失或不可读'}`);
          }
        }
      } catch (error) {
        diagnostics.push(`${market.name}: ${error instanceof DiscoveryError ? error.message : 'Marketplace cache unreadable / 市场缓存不可读'}`);
      }
    }
    for (const key of policy.enabled) {
      if (!seenKeys.has(key) && !policy.disabled.has(key)) diagnostics.push(`${key}: Enabled plugin cache missing / 已启用插件缺少缓存`);
    }
  } catch (error) {
    diagnostics.push(error instanceof DiscoveryError ? error.message : isMissingFile(error)
      ? 'Codex plugin cache is absent on this extension host / 当前扩展宿主没有 Codex 插件缓存'
      : 'Codex plugin cache could not be safely read / 无法安全读取 Codex 插件缓存');
  }
  return { plugins, diagnostics };
}
