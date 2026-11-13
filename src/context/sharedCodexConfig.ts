import { createHash } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { codexHomeUri, readSharedText, resolveSharedScope, type SharedConfigScope } from './sharedConfigPaths';

export interface SkillConfigRule { name?: string; path?: string; enabled: boolean; sourceUri: string }
export interface SharedConfigDiagnostic { uri: string; message: string; blocksSkills: boolean }
export interface SharedCodexConfigSnapshot {
  scope?: SharedConfigScope;
  codexHome: vscode.Uri;
  projectDocMaxBytes: number;
  fallbackFilenames: string[];
  skillRules: SkillConfigRule[];
  origins: Record<string, string>;
  diagnostics: SharedConfigDiagnostic[];
  watchedUris: string[];
  fingerprint: string;
}

export interface SharedCodexConfigOptions {
  cwd?: vscode.Uri;
  folders?: readonly vscode.WorkspaceFolder[];
  trusted?: boolean;
  codexHome?: vscode.Uri;
}

type Table = Record<string, unknown>;
function table(value: unknown, field: string): Table {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: expected a table / 应为表`);
  return value as Table;
}

/** Only this whitelist escapes the parser. In particular never report TOML parser excerpts (secrets). */
export async function parseSharedCodexConfig(text: string, sourceUri: string): Promise<{
  projectDocMaxBytes?: number; fallbackFilenames?: string[]; skillRules?: SkillConfigRule[];
}> {
  if (Buffer.byteLength(text) > 1_048_576) throw new Error('Configuration exceeds 1 MiB / 配置超过 1 MiB');
  let raw: Table;
  try { raw = table((await import('confbox/toml')).parseTOML(text), 'config'); }
  catch { throw new Error('Invalid TOML syntax / TOML 语法错误（未输出文件内容）'); }
  const result: Awaited<ReturnType<typeof parseSharedCodexConfig>> = {};
  if (raw.project_doc_max_bytes !== undefined) {
    if (!Number.isSafeInteger(raw.project_doc_max_bytes) || (raw.project_doc_max_bytes as number) < 0) {
      throw new Error('project_doc_max_bytes: expected a non-negative integer / 应为非负整数');
    }
    result.projectDocMaxBytes = raw.project_doc_max_bytes as number;
  }
  if (raw.project_doc_fallback_filenames !== undefined) {
    const names = raw.project_doc_fallback_filenames;
    if (!Array.isArray(names) || names.length > 64 || names.some(name => typeof name !== 'string' || !name.trim()
      || name === '.' || name === '..' || /[\\/]/u.test(name) || [...name].some(char => char.charCodeAt(0) < 32))) {
      throw new Error('project_doc_fallback_filenames: expected simple filenames / 应为文件名数组');
    }
    result.fallbackFilenames = [...new Set(names as string[])];
  }
  if (raw.skills !== undefined) {
    const skills = table(raw.skills, 'skills');
    if (skills.config !== undefined) {
      if (!Array.isArray(skills.config) || skills.config.length > 4096) throw new Error('skills.config: expected a bounded array / 应为有界数组');
      result.skillRules = skills.config.map(value => {
        const rule = table(value, 'skills.config');
        if (typeof rule.enabled !== 'boolean' || (rule.name !== undefined) === (rule.path !== undefined)
          || (rule.name !== undefined && (typeof rule.name !== 'string' || !rule.name.trim()))
          || (rule.path !== undefined && (typeof rule.path !== 'string' || !path.isAbsolute(rule.path) || path.basename(rule.path) !== 'SKILL.md'))) {
          throw new Error('skills.config: requires enabled boolean and exactly one name or absolute SKILL.md path / 需布尔 enabled 及唯一 name 或绝对 SKILL.md 路径');
        }
        return { name: (rule.name as string | undefined)?.trim(), path: rule.path as string | undefined, enabled: rule.enabled, sourceUri };
      });
    }
  }
  return result;
}

export async function loadSharedCodexConfig(options: SharedCodexConfigOptions = {}): Promise<SharedCodexConfigSnapshot> {
  const home = options.codexHome ?? codexHomeUri();
  const diagnostics: SharedConfigDiagnostic[] = [];
  let scope: SharedConfigScope | undefined;
  try { scope = await resolveSharedScope(options); }
  catch { diagnostics.push({ uri: options.cwd?.toString() ?? '', message: 'Task scope unavailable / 任务作用域不可用', blocksSkills: true }); }
  if (!scope && (options.folders ?? vscode.workspace.workspaceFolders ?? []).length > 1) {
    diagnostics.push({ uri: '', message: 'Select one task directory for this session / 请为此会话选择一个任务目录', blocksSkills: true });
  }
  const snapshot: SharedCodexConfigSnapshot = { scope, codexHome: home, projectDocMaxBytes: 32768,
    fallbackFilenames: [], skillRules: [], origins: {}, diagnostics, watchedUris: [], fingerprint: '' };
  const layers = [{ uri: vscode.Uri.joinPath(home, 'config.toml'), boundary: home, project: false },
    ...(scope?.trusted ? scope.chain.map(dir => ({ uri: vscode.Uri.joinPath(dir, '.codex', 'config.toml'), boundary: scope!.root, project: true })) : [])];
  for (const layer of layers) {
    const uri = layer.uri.toString();
    snapshot.watchedUris.push(uri);
    try {
      const text = await readSharedText(layer.uri, [layer.boundary]);
      if (text === undefined) continue;
      const parsed = await parseSharedCodexConfig(text, uri);
      if (parsed.projectDocMaxBytes !== undefined) {
        snapshot.projectDocMaxBytes = parsed.projectDocMaxBytes;
        snapshot.origins.project_doc_max_bytes = uri;
      }
      if (parsed.fallbackFilenames !== undefined) {
        // TOML arrays replace; they are not concatenated across project layers.
        snapshot.fallbackFilenames = parsed.fallbackFilenames;
        snapshot.origins.project_doc_fallback_filenames = uri;
      }
      if (parsed.skillRules !== undefined) {
        if (layer.project && parsed.skillRules.length) {
          // Verified with codex-cli 0.133.0 skills/list: project skill rules are NOT applied.
          // Fail closed rather than making an ineffective disable look like a shared policy.
          diagnostics.push({ uri, message: 'Codex 0.133.0 ignores project skills.config; move these rules to user config.toml. Skill activation is blocked / 项目 skills.config 不生效，请移到用户配置；已阻止 Skill 激活', blocksSkills: true });
        } else if (!layer.project) {
          snapshot.skillRules = parsed.skillRules;
          snapshot.origins['skills.config'] = uri;
        }
      }
    } catch (error) {
      // Parser messages above contain only fixed field names. Filesystem errors are never serialized.
      diagnostics.push({ uri, message: error instanceof Error && /^(Invalid TOML|Configuration exceeds|project_doc_|skills[.:])/u.test(error.message)
        ? error.message : 'Shared configuration could not be safely read / 无法安全读取共享配置', blocksSkills: true });
    }
  }
  snapshot.fingerprint = createHash('sha256').update(JSON.stringify({ cwd: scope?.cwd.toString(), trusted: scope?.trusted,
    max: snapshot.projectDocMaxBytes, fallback: snapshot.fallbackFilenames, rules: snapshot.skillRules, origins: snapshot.origins, diagnostics })).digest('hex');
  return snapshot;
}
