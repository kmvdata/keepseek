import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { getConfiguredMaxFileBytes } from '../shared/config';
import { isReadableTextContent } from '../shared/textFileGuards';
import { assertRealPathInside, canonicalUri, isMissingFile, projectSkillsUri, readSharedText, userSkillsUri, uriInside } from '../context/sharedConfigPaths';
import { loadSharedCodexConfig, type SharedCodexConfigSnapshot } from '../context/sharedCodexConfig';
import { createSkillId, type SkillManifest, type SkillSource } from './skillTypes';
import { parseSkillFrontmatter, parseSkillMetadata } from './skillMetadata';
export { parseSkillFrontmatter } from './skillMetadata';
export type { ParsedSkillFrontmatter } from './skillMetadata';

export interface SkillDiscoveryOptions {
  userSkillsUri?: vscode.Uri;
  includeUserSkills?: boolean;
  adminSkillsUri?: vscode.Uri;
  includeAdminSkills?: boolean;
}
interface SkillBase { source: SkillSource; uri: vscode.Uri; boundary: vscode.Uri }
const MAX_DEPTH = 6;
const MAX_DIRECTORIES = 2000;
const MAX_ENTRIES = 20000;

export class SkillDiscovery {
  public diagnostics: string[] = [];
  public constructor(private readonly options: SkillDiscoveryOptions = {}) {}

  public async discover(config?: SharedCodexConfigSnapshot): Promise<SkillManifest[]> {
    config ??= await loadSharedCodexConfig();
    this.diagnostics = [];
    const bases: SkillBase[] = config.scope?.trusted
      ? [...config.scope.chain].reverse().map(dir => ({ source: 'agentsWorkspace', uri: projectSkillsUri(dir), boundary: config!.scope!.root })) : [];
    if (this.options.includeUserSkills !== false) {
      const uri = this.options.userSkillsUri ?? userSkillsUri();
      bases.push({ source: 'agentsUser', uri, boundary: uri });
    }
    if (this.options.includeAdminSkills !== false && (process.platform !== 'win32' || this.options.adminSkillsUri)) {
      const uri = this.options.adminSkillsUri ?? vscode.Uri.file('/etc/codex/skills');
      bases.push({ source: 'admin', uri, boundary: uri });
    }
    const manifests: SkillManifest[] = [];
    const seenFiles = new Set<string>();
    for (const base of bases) {
      try {
        const boundary = await canonicalUri(base.boundary);
        // User/admin roots may contain links, but replacing the configured root with an
        // external link must not silently authorize its target. Canonical parent permits
        // host aliases such as /tmp -> /private/tmp.
        if (base.source !== 'agentsWorkspace') {
          const anchor = await canonicalUri(vscode.Uri.joinPath(base.uri, '..', '..'));
          const expected = vscode.Uri.joinPath(anchor, path.basename(path.dirname(base.uri.fsPath)), path.basename(base.uri.fsPath));
          if (!uriInside(expected, boundary)) throw new Error('External skill root');
        }
        base.boundary = boundary;
      } catch (error) {
        if (!isMissingFile(error)) this.diagnostics.push(`${base.uri.toString()}: unsafe source root / 来源根目录不安全`);
        continue;
      }
      const visited = new Set<string>();
      let entriesSeen = 0;
      const walk = async (directory: vscode.Uri, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH || visited.size >= MAX_DIRECTORIES || entriesSeen >= MAX_ENTRIES) {
          this.diagnostics.push(`${base.uri.toString()}: discovery limit / 扫描达到上限`); return;
        }
        try {
          const real = await assertRealPathInside(directory, [base.boundary]);
          if (visited.has(real.toString())) return;
          visited.add(real.toString());
          // Root itself is a container; only children may be skills.
          const skillUri = vscode.Uri.joinPath(directory, 'SKILL.md');
          if (depth > 0) {
            try {
              await fs.lstat(skillUri.fsPath);
              const manifest = await this.createManifest(base, directory, skillUri, config!);
              const identity = manifest.physicalUri ?? skillUri.toString();
              if (!seenFiles.has(identity)) { seenFiles.add(identity); manifests.push(manifest); }
              return;
            } catch (error) { if (!isMissingFile(error)) throw error; }
          }
          const entries = [];
          for await (const entry of await fs.opendir(real.fsPath)) {
            entries.push(entry);
            if (entries.length >= MAX_ENTRIES - entriesSeen) break;
          }
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (++entriesSeen > MAX_ENTRIES) { this.diagnostics.push(`${base.uri.toString()}: entry limit / 条目达到上限`); break; }
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            if (entry.isDirectory() || entry.isSymbolicLink()) {
              await walk(vscode.Uri.joinPath(directory, entry.name), depth + 1);
            }
          }
        } catch (error) {
          if (!isMissingFile(error)) this.diagnostics.push(`${directory.toString()}: source unavailable, link outside boundary or unreadable / 来源不可用、链接越界或不可读`);
        }
      };
      await walk(base.uri, 0);
    }
    return manifests;
  }

  private async createManifest(base: SkillBase, rootUri: vscode.Uri, skillUri: vscode.Uri, config: SharedCodexConfigSnapshot): Promise<SkillManifest> {
    const manifest: SkillManifest = { id: createSkillId(base.source, rootUri), name: path.basename(rootUri.fsPath),
      description: '', source: base.source, sourceLabel: rootUri.fsPath, rootUri, skillUri, enabled: false,
      allowImplicit: false, hasReferences: false, hasAssets: false, hasScripts: false, readBoundaryUri: base.boundary.toString() };
    try {
      const physical = await assertRealPathInside(skillUri, [base.boundary]);
      manifest.physicalUri = physical.toString();
      const content = await readSharedText(skillUri, [base.boundary], getConfiguredMaxFileBytes());
      if (content === undefined || !isReadableTextContent(content)) throw new Error('Unreadable SKILL.md / SKILL.md 不可读');
      const parsed = parseSkillFrontmatter(content);
      const metadataText = await readSharedText(vscode.Uri.joinPath(rootUri, 'agents', 'openai.yaml'), [base.boundary], 65536);
      const metadata = parseSkillMetadata(metadataText);
      Object.assign(manifest, { name: parsed.name, description: parsed.description, enabled: true, allowImplicit: metadata.allowImplicit,
        interface: metadata.interface, dependencies: metadata.dependencies,
        documentHash: createHash('sha256').update(content).digest('hex'),
        metadataHash: createHash('sha256').update(metadataText ?? '').digest('hex'),
        contentFingerprint: createHash('sha256').update(content).update('\0').update(metadataText ?? '').update(config.fingerprint).digest('hex') });
      if (parsed.runAs === 'subagent') {
        manifest.runAs = parsed.runAs;
        manifest.subagentProfile = { id: parsed.profile ?? parsed.name, tools: parsed.tools, maxSteps: parsed.maxSteps,
          timeoutMs: parsed.timeoutMs, canDelegate: parsed.canDelegate, resultMaxChars: parsed.resultMaxChars };
      }
      for (const [key, directory] of [['hasReferences', 'references'], ['hasAssets', 'assets'], ['hasScripts', 'scripts']] as const) {
        try { manifest[key] = (await fs.stat(vscode.Uri.joinPath(rootUri, directory).fsPath)).isDirectory(); } catch { /* optional */ }
      }
      for (const rule of config.skillRules) {
        let matches = rule.name === parsed.name;
        if (rule.path) {
          try { matches = (await canonicalUri(vscode.Uri.file(rule.path))).toString() === physical.toString(); }
          catch { matches = path.resolve(rule.path) === path.resolve(skillUri.fsPath); }
        }
        if (matches) { manifest.enabled = rule.enabled; manifest.policySource = rule.sourceUri; }
      }
      if (!manifest.enabled) manifest.unavailableReason = `Disabled by shared config / 共享配置已禁用: ${manifest.policySource}`;
      if (metadata.dependencies.length) {
        manifest.enabled = false;
        manifest.unavailableReason = `Tool dependencies unavailable in KeepSeek / KeepSeek 未接入工具依赖: ${metadata.dependencies.map(item => `${item.type}:${item.value}`).join(', ')}`;
      }
      const blocked = config.diagnostics.filter(item => item.blocksSkills);
      if (blocked.length) {
        manifest.enabled = false;
        manifest.unavailableReason = blocked.map(item => `${item.uri}: ${item.message}`).join('\n');
      }
    } catch (error) {
      manifest.enabled = false;
      manifest.unavailableReason = error instanceof Error ? error.message : 'Invalid Skill / Skill 无效';
    }
    return manifest;
  }
}
